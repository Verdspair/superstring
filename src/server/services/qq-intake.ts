// The intake runtime: connection events in, durable observations out.
//
// This is the assembly point the plan lists as P2's remaining item. It connects three
// pieces that each already exist and are tested — the transport (`OneBotConnection`),
// the storage boundary (`recordObservation`) and the trigger (`scheduleQqMemory`) — and
// it owns nothing else. In particular it decides nothing about when to *speak*; that is
// the reply state machine's job (P3).
//
// Two rules are worth stating because they are easy to get backwards:
//
//   1. A PAUSED conversation still observes. Pausing means "stop speaking in this
//      chat", not "forget it": the user's decision was that a paused conversation keeps
//      observing and simply stops talking. Only the *trigger* respects `paused`, and it
//      already does. Recording here must therefore NOT check `paused`.
//   2. An unbound conversation is not ours. `qq_events.agent_id` is NOT NULL, so a
//      message we cannot attribute to an assistant cannot be stored at all. Ignoring it
//      is the correct answer, not a failure.
//
// A handler that throws would abort the transport consumer (the connection reports
// `consumer_error` and stops), so every message is handled defensively and the outcome
// is reported through a callback instead of an exception.

import { readBindingByConversation } from "../db/qq-binding-repository";
import { purgeExpiredQqMembers } from "../db/qq-member-repository";
import {
  type RecordedObservation,
  recordObservation,
  sweepObservations,
} from "../db/qq-observation-intake";
import { platformMessageWasSentByAssistant } from "../db/qq-send-repository";
import { readQqConnectionConfig, readQqSettings } from "../db/qq-settings-repository";
import type { Orm } from "../db/repositories";
import type { VisionClient } from "../llm/vision-client";
import type { OneBotMediaSourceResult } from "./onebot-connection";
import {
  OneBotConnection,
  type OneBotConnectionState,
  type OneBotSocketFactory,
} from "./onebot-connection";
import type { QqMessageResult } from "./onebot-protocol";
import { handleQqRecordedMessage, type QqEventMediaDeps } from "./qq-event-path";
import { createQqMediaAdapter } from "./qq-media-adapter";
import { createQqMediaSourceFetcher } from "./qq-media-source";
import { type QqMemoryScheduleResult, scheduleQqMemory } from "./qq-memory-scheduler";

/** A fixed, content-free description of what intake did. Never carries message text. */
export type QqIntakeEvent =
  | { kind: "recorded"; recorded: boolean; hasText: boolean }
  | {
      kind: "ignored";
      reason: "not_a_message" | "unbound_conversation" | "switch_off" | "not_configured";
    }
  | { kind: "discarded"; reason: "duplicate_key_conflict" | "invalid_observation" }
  | { kind: "cycle"; purged: number; due: number; enqueued: number }
  | { kind: "connection"; state: OneBotConnectionState["phase"] }
  /** The per-message follow-up (P5m). Counts and verdicts only; never text, ids or prompts. */
  | {
      kind: "follow_up";
      hasMedia: boolean;
      dispatch: "scheduled" | "not_scheduled";
      own: "read" | "idle" | "none";
      supplement: "read" | "idle" | "none";
    }
  | { kind: "follow_up_failed" };

export type RecordOutcome =
  | { kind: "recorded"; recorded: boolean; hasText: boolean }
  | {
      kind: "ignored";
      reason: "not_a_message" | "unbound_conversation" | "switch_off" | "not_configured";
    }
  | { kind: "discarded"; reason: "duplicate_key_conflict" | "invalid_observation" };

export interface RecordInboundOptions {
  /**
   * The account this connection is attached to. A message claiming another account is
   * refused: the observation's account is part of its identity, and accepting a
   * mismatch would let one account's traffic be recorded as another's.
   */
  accountId: string;
  /** Called with a content-free outcome; a diagnostic sink, never a content log. */
  onEvent?: (event: QqIntakeEvent) => void;
}

/**
 * Handle one normalised result from the transport.
 *
 * Returns the outcome rather than throwing, so the transport's consumer can never be
 * taken down by a single bad message.
 */
/**
 * 把"回复了我们的消息"折进 `mentionsSelf`（2026-09-25 后续）。
 *
 * The reply target is looked up in the send ledger instead of guessed: only a message THIS assistant
 * delivered in THIS conversation turns a reply into a call. Everything downstream (the stored
 * `addressed` flag, the direct-reply path, the media retry) reads the one field, so the decision is
 * made once, here.
 */
function withReplyAsAddressed(
  orm: Orm,
  result: QqMessageResult,
  accountId: string,
): QqMessageResult {
  if (result.kind !== "message") return result;
  const observation = result.observation;
  const target = observation.replyToMessageId ?? null;
  if (target === null || observation.mentionsSelf) return result;
  const ours = platformMessageWasSentByAssistant(orm, {
    accountId,
    conversationKind: observation.conversation.kind,
    peerId: observation.conversation.peerId,
    platformMessageId: target,
  });
  if (!ours) return result;
  return { kind: "message", observation: { ...observation, mentionsSelf: true } };
}

export function recordInbound(
  orm: Orm,
  result: QqMessageResult,
  options: RecordInboundOptions,
): RecordOutcome {
  const emit = (event: QqIntakeEvent): void => options.onEvent?.(event);
  if (result.kind !== "message") {
    emit({ kind: "ignored", reason: "not_a_message" });
    return { kind: "ignored", reason: "not_a_message" };
  }
  const observation = result.observation;
  if (observation.accountId !== options.accountId) {
    emit({ kind: "discarded", reason: "invalid_observation" });
    return { kind: "discarded", reason: "invalid_observation" };
  }
  // The switch can be turned off while a connection is live, so it is re-checked here
  // and not only when the connection is opened.
  if (readQqSettings(orm).enabled !== 1) {
    emit({ kind: "ignored", reason: "switch_off" });
    return { kind: "ignored", reason: "switch_off" };
  }
  const binding = readBindingByConversation(orm, {
    accountId: observation.accountId,
    kind: observation.conversation.kind,
    peerId: observation.conversation.peerId,
  });
  if (binding === null) {
    emit({ kind: "ignored", reason: "unbound_conversation" });
    return { kind: "ignored", reason: "unbound_conversation" };
  }
  let recorded: RecordedObservation;
  try {
    // Note the deliberate absence of a `paused` check: a paused conversation keeps
    // observing and only stops being *triggered*.
    recorded = recordObservation(orm, observation, binding.agentId);
  } catch {
    // A reused event key describing a different message is a refusal by design; it is
    // reported as a discard so the transport stays healthy.
    emit({ kind: "discarded", reason: "duplicate_key_conflict" });
    return { kind: "discarded", reason: "duplicate_key_conflict" };
  }
  const event: QqIntakeEvent = {
    kind: "recorded",
    recorded: recorded.recorded,
    hasText: recorded.hasText,
  };
  emit(event);
  return event;
}

/**
 * One housekeeping pass: expire text, then queue whatever has reached its count.
 *
 * Order matters: sweeping first means a batch that has already expired is not counted
 * towards a conversation's threshold, so a trigger cannot fire on unreadable messages.
 */
export function qqIntakeCycle(orm: Orm, now?: string): QqMemoryScheduleResult & { purged: number } {
  const purged = sweepObservations(orm, now);
  purgeExpiredQqMembers(orm, now);
  const scheduled = scheduleQqMemory(orm, now);
  return { purged, due: scheduled.due, enqueued: scheduled.enqueued };
}

export interface QqIntakeRuntimeOptions {
  orm: Orm;
  /**
   * Where the token ciphertext's key file lives. The runtime never takes the endpoint
   * or token from its caller: it reads the saved configuration, so the running
   * connection always matches what the user saved (and cannot be started with a
   * credential that was never persisted).
   */
  transportKeyPath?: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  /** How often the housekeeping pass runs. */
  cycleIntervalMs?: number;
  /**
   * How long the supervisor waits before its next look at the switch and the saved configuration
   * (P5r). Short on purpose: this is what notices a dropped socket and a user who switched the
   * transport off, so the delay is user-visible in both directions.
   */
  superviseIntervalMs?: number;
  socketFactory?: OneBotSocketFactory;
  /** Timer seams for the supervisor; tests drive it without waiting. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /**
   * The media reading seam (P5m). Omitted, media is still recorded and never read — the same
   * shape P4b left behind, because a caller without a vision client must not silently read.
   */
  media?: { vision: VisionClient };
  /** Seconds since epoch, the unit the dispatch rows use. Injectable so tests own the clock. */
  nowSeconds?: () => number;
  onEvent?: (event: QqIntakeEvent) => void;
  /**
   * 「有消息找她」的信号（2026-09-25）：记下一条**冲着她来的**消息（被 @、群内回复她、私聊）之后
   * 调一次，让运行宿主不必等下一次轮询才开始跑链。这是用户能感觉到的那段延迟的主要来源。
   *
   * 只对"冲着她来的"发信号：那正是立即路径要处理的；其余消息走合并窗口，天然有等待，轮询足够。
   */
  onAddressedMessage?: () => void;
}

/**
 * The assembled runtime. `start()` refuses to open a connection while the third-party
 * switch is off or while the saved configuration is incomplete, so a disabled or
 * half-configured setup produces no traffic and no logins.
 *
 * `tick()` is exposed separately from the timer so tests drive it deterministically,
 * the same way the memory worker exposes `runCycle()`.
 */
/** How often the supervisor looks at the switch, the configuration and the socket (P5r). */
export const QQ_SUPERVISE_INTERVAL_MS = 5_000;

export class QqIntakeRuntime {
  readonly #options: QqIntakeRuntimeOptions;
  #connection: OneBotConnection | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #supervise: unknown = null;
  #stopped = true;

  constructor(options: QqIntakeRuntimeOptions) {
    this.#options = options;
  }

  get connection(): OneBotConnection | null {
    return this.#connection;
  }

  get state(): OneBotConnectionState {
    return this.#connection?.state ?? { phase: "idle" };
  }

  /** The saved configuration this runtime would dial, or `null` while incomplete. */
  connectionConfig(): { endpoint: string; token: string; accountId: string } | null {
    return this.#options.transportKeyPath === undefined
      ? readQqConnectionConfig(this.#options.orm)
      : readQqConnectionConfig(this.#options.orm, this.#options.transportKeyPath);
  }

  /**
   * Start the transport, then keep looking after it (P5r).
   *
   * The first attempt still happens here so a caller can await a connection; what changed is that
   * this is no longer the only attempt. A supervisor looks at the switch and the saved
   * configuration on its own interval and does three things it could not do before: reconnect
   * after a dropped socket, give up on a connection the user has switched off, and keep trying
   * while the pieces are incomplete instead of idling until someone restarts the app.
   */
  async start(): Promise<OneBotConnectionState> {
    this.#stopped = false;
    const attempted = await this.#connectOnce();
    this.#scheduleSupervise();
    return attempted;
  }

  /** One connect attempt, reporting why it did or did not happen. */
  async #connectOnce(): Promise<OneBotConnectionState> {
    const { orm, onEvent } = this.#options;
    if (readQqSettings(orm).enabled !== 1) {
      this.#disconnect();
      onEvent?.({ kind: "ignored", reason: "switch_off" });
      return this.state;
    }
    if (this.#connection !== null) return this.state;
    const saved = this.connectionConfig();
    if (saved === null) {
      // Half-configured is a distinct outcome from "switched off": the user asked for it
      // but the pieces are not there yet, so say so instead of silently idling.
      this.#disconnect();
      onEvent?.({ kind: "ignored", reason: "not_configured" });
      return this.state;
    }
    const connection = new OneBotConnection(
      {
        url: saved.endpoint,
        accessToken: saved.token,
        accountId: saved.accountId,
        connectTimeoutMs: this.#options.connectTimeoutMs,
        requestTimeoutMs: this.#options.requestTimeoutMs,
      },
      {
        // The consumer is total: it reports and never throws, because a throwing
        // consumer aborts the transport.
        onMessage: (raw) => {
          try {
            // One decision, both halves: a QQ *reply* to a message this assistant sent in this
            // conversation is the same act of calling as an @, so the observation is marked before
            // the storage boundary and the follow-up path see it. A reply to anybody else's
            // message, or to a target we never sent, is left exactly as it was.
            const message = withReplyAsAddressed(orm, raw, saved.accountId);
            const outcome = recordInbound(orm, message, { accountId: saved.accountId, onEvent });
            // 一条落库的、冲着她来的消息：叫醒运行宿主，别让"被 @ 了"干等下一次轮询（2026-09-25）。
            if (
              outcome.kind === "recorded" &&
              message.kind === "message" &&
              (message.observation.mentionsSelf ||
                message.observation.conversation.kind === "private")
            ) {
              this.#options.onAddressedMessage?.();
            }
            this.#followUp(message, outcome);
          } catch {
            onEvent?.({ kind: "discarded", reason: "invalid_observation" });
          }
        },
        ...(this.#options.socketFactory ? { socketFactory: this.#options.socketFactory } : {}),
      },
    );
    this.#connection = connection;
    const result = await connection.connect();
    onEvent?.({ kind: "connection", state: connection.state.phase });
    // The attempt took time, and the world may have moved: a `stop()` during the handshake must
    // win, or this runtime would arm its housekeeping timer on a process that was told to stop.
    if (this.#stopped || this.#connection !== connection) {
      connection.disconnect();
      if (this.#connection === connection) this.#connection = null;
      return this.state;
    }
    if (result.kind === "failed") {
      // A failed attempt leaves nothing to keep. The supervisor is what retries it now; the
      // reason travels with the state so the settings page can say why it is not connected.
      this.#connection = null;
      return this.state;
    }
    const interval = this.#options.cycleIntervalMs ?? 60_000;
    this.#timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        // A housekeeping fault must not kill the process; the next pass retries.
        onEvent?.({ kind: "connection", state: this.state.phase });
      }
    }, interval);
    return this.state;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#supervise !== null) {
      this.#clearTimeout(this.#supervise);
      this.#supervise = null;
    }
    this.#disconnect();
  }

  /** Tear the connection and the housekeeping timer down, without touching the supervisor. */
  #disconnect(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#connection?.disconnect();
    this.#connection = null;
  }

  #clearTimeout(handle: unknown): void {
    const clear = this.#options.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as number));
    clear(handle);
  }

  #scheduleSupervise(): void {
    if (this.#stopped || this.#supervise !== null) return;
    const delay = this.#options.superviseIntervalMs ?? QQ_SUPERVISE_INTERVAL_MS;
    this.#supervise = (this.#options.setTimeoutFn ?? setTimeout)(() => {
      this.#supervise = null;
      if (this.#stopped) return;
      void this.superviseOnce();
    }, delay);
  }

  /**
   * One supervisor pass, exposed so tests drive it instead of racing its timer.
   *
   * Deliberately sequential: while an attempt is in flight the supervisor is not rescheduled, so
   * a slow DNS or a hanging socket cannot pile up parallel attempts.
   */
  async superviseOnce(): Promise<OneBotConnectionState> {
    if (this.#stopped) return this.state;
    try {
      // A dead handle must go before anything else: `#connectOnce` keeps an existing connection
      // on purpose, so leaving the corpse in place would make every pass a no-op.
      if (this.state.phase === "closed") this.#disconnect();
      // Then the same decision point as the first attempt: it re-reads the switch and the saved
      // configuration, so switching the transport off closes a live link and an unconfigured one
      // is never dialled — no restart required in either direction.
      await this.#connectOnce();
    } catch {
      // A supervisor fault must not stop the supervision; the next pass retries.
      this.#options.onEvent?.({ kind: "connection", state: this.state.phase });
    }
    this.#scheduleSupervise();
    return this.state;
  }

  #now(): number {
    return this.#options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  }

  /**
   * The per-message follow-up (P5m): classify, queue, understand the media.
   *
   * Deliberately NOT awaited by the transport consumer. A read is a model call, and holding the
   * socket's message handler for it would stall every later message behind one picture; the
   * work is idempotent per segment (the reader's attempt CAS and in-process single-flight), so a
   * slow read overlapping the next message is safe. A duplicate delivery (`recorded: false`) is
   * skipped: it is the same message, and a second turn would classify it twice.
   */
  #followUp(message: QqMessageResult, outcome: RecordOutcome): void {
    if (outcome.kind !== "recorded" || !outcome.recorded) return;
    if (message.kind !== "message") return;
    const observation = message.observation;
    const media: QqEventMediaDeps | undefined = (() => {
      const vision = this.#options.media?.vision;
      if (!vision) return undefined;
      return {
        adapterFor: ({ mediaPrompt, frames, maxDimension }) =>
          createQqMediaAdapter({
            prompt: mediaPrompt,
            frames,
            maxDimension,
            vision,
            fetchSource: createQqMediaSourceFetcher({
              resolveSource: (request): Promise<OneBotMediaSourceResult> =>
                this.#connection?.resolveMediaSource(request) ??
                Promise.resolve({ kind: "unavailable", reason: "not_ready" }),
            }),
          }),
      };
    })();
    void handleQqRecordedMessage(
      this.#options.orm,
      { observation, nowSeconds: this.#now() },
      media ? { media } : {},
    )
      .then((result) =>
        this.#options.onEvent?.({
          kind: "follow_up",
          hasMedia: result.media.hasMedia,
          dispatch: result.dispatch.kind,
          own: result.media.own?.kind ?? "none",
          supplement: result.media.supplement?.kind ?? "none",
        }),
      )
      .catch(() => this.#options.onEvent?.({ kind: "follow_up_failed" }));
  }

  /** One housekeeping pass, reporting a fixed summary through `onEvent`. */
  tick(now?: string): QqMemoryScheduleResult & { purged: number } {
    const result = qqIntakeCycle(this.#options.orm, now);
    this.#options.onEvent?.({
      kind: "cycle",
      purged: result.purged,
      due: result.due,
      enqueued: result.enqueued,
    });
    return result;
  }
}
