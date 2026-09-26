import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  classifyOneBotSendReceipt,
  isOneBotAuthenticationFailure,
  normalizeOneBotAccountId,
  normalizeOneBotMessage,
  type OneBotSendReceipt,
  type QqMessageResult,
} from "./onebot-protocol";

export interface OneBotSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  terminate(): void;
}

export type OneBotSocketFactory = (
  url: string,
  options: { headers: { Authorization: string } },
) => OneBotSocket;

// DOM declarations omit Bun's headers overload and immediate termination method.
const nativeSocket: OneBotSocketFactory = (url, options) =>
  new (WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => OneBotSocket)(
    url,
    options,
  );

export interface OneBotConnectionConfig {
  url: string;
  accessToken: string;
  accountId: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
}

export type OneBotConnectionFailure =
  | "connect_error"
  | "connect_timeout"
  | "authentication_failed"
  | "identity_invalid"
  | "account_mismatch"
  | "account_offline"
  | "status_invalid"
  | "handshake_failed"
  | "disconnected"
  | "stopped"
  | "protocol_error"
  | "consumer_error";

export type OneBotConnectionState =
  | { phase: "idle" }
  | { phase: "connecting" | "verifying" }
  | { phase: "ready"; accountId: string }
  | { phase: "closed"; reason: OneBotConnectionFailure };

export type OneBotConnectResult =
  | { kind: "ready"; accountId: string }
  | { kind: "failed"; reason: OneBotConnectionFailure };

export type OneBotSendResult =
  | Exclude<OneBotSendReceipt, { kind: "unrelated" }>
  | { kind: "not_sent"; reason: "not_ready" | "invalid_request" }
  | { kind: "unknown"; reason: "timeout" | "disconnected" | "transport_error" };

const SendSegment = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("text"), data: z.object({ text: z.string().min(1) }).strict() })
    .strict(),
  z
    .object({ type: z.literal("image"), data: z.object({ file: z.string().min(1) }).strict() })
    .strict(),
  z
    .object({ type: z.literal("face"), data: z.object({ id: z.string().regex(/^\d+$/) }).strict() })
    .strict(),
  // 0035 后续：分开回话时 @ 到对方。只认纯数字 QQ 号——@全体成员是场景
  // 提示词明令禁止的，形状上也不给它机会。
  z
    .object({ type: z.literal("at"), data: z.object({ qq: z.string().regex(/^\d+$/) }).strict() })
    .strict(),
]);
const SendRequest = z
  .object({
    kind: z.enum(["group", "private"]),
    peerId: z.string().regex(/^\d+$/),
    message: z.array(SendSegment).min(1),
  })
  .strict();
export type OneBotSendRequest = z.infer<typeof SendRequest>;

const GoodStatus = z.object({ online: z.boolean().nullable(), good: z.boolean() });

const MediaSourceRequest = z.strictObject({
  kind: z.enum(["image", "record", "video"]),
  sourceRef: z.string().min(1),
});

/** The reference the bot side handed back, or why it could not (diagnostics only). */
export type OneBotMediaSourceResult =
  | { readonly kind: "source"; readonly reference: string }
  | { readonly kind: "unavailable"; readonly reason: string };
type RequestResult =
  | { kind: "response"; value: Record<string, unknown>; echo: string }
  | { kind: "not_sent"; reason: "not_ready" | "invalid_request" }
  | { kind: "unknown"; reason: "timeout" | "disconnected" | "transport_error" };
interface Pending {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: RequestResult) => void;
}
interface ConnectionAttempt {
  socket: OneBotSocket;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<OneBotConnectResult>;
  resolve: (result: OneBotConnectResult) => void;
  detach: () => void;
}

function record(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function configValue(config: OneBotConnectionConfig): OneBotConnectionConfig {
  try {
    const url = new URL(config.url);
    const accountId = normalizeOneBotAccountId(config.accountId);
    const validTime = (n: number) => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647;
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !accountId ||
      typeof config.accessToken !== "string" ||
      !config.accessToken.trim() ||
      /[\r\n]/.test(config.accessToken) ||
      !validTime(config.connectTimeoutMs) ||
      !validTime(config.requestTimeoutMs)
    )
      throw new Error();
    return { ...config, url: url.href, accountId };
  } catch {
    // Never include the URL, token or upstream error in a diagnostic.
    throw new TypeError("Invalid OneBot connection configuration");
  }
}

/** Explicit, non-retrying transport. Business authorization belongs to its caller. */
export class OneBotConnection {
  #config: OneBotConnectionConfig;
  #factory: OneBotSocketFactory;
  #onMessage: (message: QqMessageResult) => void | Promise<void>;
  #state: OneBotConnectionState = { phase: "idle" };
  #active: ConnectionAttempt | null = null;
  #pending = new Map<string, Pending>();
  #prefix = randomUUID();
  #sequence = 0;

  constructor(
    config: OneBotConnectionConfig,
    options: {
      onMessage: (message: QqMessageResult) => void | Promise<void>;
      socketFactory?: OneBotSocketFactory;
    },
  ) {
    this.#config = configValue(config);
    this.#factory = options.socketFactory ?? nativeSocket;
    this.#onMessage = options.onMessage;
  }

  get state(): OneBotConnectionState {
    return { ...this.#state };
  }
  get pendingCount(): number {
    return this.#pending.size;
  }

  connect(): Promise<OneBotConnectResult> {
    if (this.#active) return this.#active.promise;
    this.#state = { phase: "connecting" };
    let socket: OneBotSocket;
    try {
      socket = this.#factory(this.#config.url, {
        headers: { Authorization: `Bearer ${this.#config.accessToken}` },
      });
    } catch {
      this.#state = { phase: "closed", reason: "connect_error" };
      return Promise.resolve({ kind: "failed", reason: "connect_error" });
    }
    const deferred = Promise.withResolvers<OneBotConnectResult>();
    const attempt: ConnectionAttempt = {
      socket,
      promise: deferred.promise,
      resolve: deferred.resolve,
      timer: setTimeout(
        () => this.#finish(attempt, "connect_timeout"),
        this.#config.connectTimeoutMs,
      ),
      detach: () => {},
    };
    this.#active = attempt;
    const open = () => {
      if (this.#active !== attempt || this.#state.phase !== "connecting") return;
      this.#state = { phase: "verifying" };
      void this.#verify(attempt);
    };
    const message = (event: Event) => this.#receive(attempt, (event as MessageEvent<unknown>).data);
    const error = () => this.#finish(attempt, "connect_error");
    const close = () => this.#finish(attempt, "disconnected");
    const handlers = { open, message, error, close };
    for (const [type, handler] of Object.entries(handlers)) socket.addEventListener(type, handler);
    attempt.detach = () => {
      for (const [type, handler] of Object.entries(handlers))
        socket.removeEventListener(type, handler);
    };
    return attempt.promise;
  }

  disconnect(): void {
    if (this.#active) this.#finish(this.#active, "stopped");
    else this.#state = { phase: "closed", reason: "stopped" };
  }

  async send(request: OneBotSendRequest): Promise<OneBotSendResult> {
    const attempt = this.#active;
    if (!attempt || this.#state.phase !== "ready") return { kind: "not_sent", reason: "not_ready" };
    const parsed = SendRequest.safeParse(request);
    if (!parsed.success) return { kind: "not_sent", reason: "invalid_request" };
    const peerId = Number(parsed.data.peerId);
    if (!Number.isSafeInteger(peerId) || peerId <= 0)
      return { kind: "not_sent", reason: "invalid_request" };
    const group = parsed.data.kind === "group";
    const result = await this.#request(attempt, group ? "send_group_msg" : "send_private_msg", {
      [group ? "group_id" : "user_id"]: peerId,
      message: parsed.data.message,
    });
    if (result.kind !== "response") return result;
    const receipt = classifyOneBotSendReceipt(result.value, result.echo);
    return receipt.kind === "unrelated"
      ? { kind: "unknown", reason: "malformed_receipt" }
      : receipt;
  }

  /**
   * Ask the bot side for a media source (§7.1's 取流, ADR0018 P5j).
   *
   * One action per kind — the OneBot 11 spellings — and the answer is whichever reference the
   * implementation hands back: NapCat returns a local path for a file it already has and a
   * data URL when it converts one. Both travel back verbatim, because resolving them is not this
   * method's business (see `qq-media-source.ts`); its whole job is the action name, the parameter
   * shape and the receipt. The reference shapes are the standard's, verified in P4b's upstream
   * check but not yet against a running NapCat.
   */
  async resolveMediaSource(request: unknown): Promise<OneBotMediaSourceResult> {
    const attempt = this.#active;
    if (!attempt || this.#state.phase !== "ready") {
      return { kind: "unavailable", reason: "not_ready" };
    }
    const parsed = MediaSourceRequest.safeParse(request);
    if (!parsed.success) return { kind: "unavailable", reason: "invalid_request" };
    const action =
      parsed.data.kind === "image"
        ? "get_image"
        : parsed.data.kind === "record"
          ? "get_record"
          : "get_file";
    const result = await this.#request(attempt, action, { file: parsed.data.sourceRef });
    if (result.kind !== "response") return { kind: "unavailable", reason: result.reason };
    if (!this.#successful(result)) return { kind: "unavailable", reason: "rejected" };
    const file = record(result.value.data)?.file;
    if (typeof file !== "string" || file.trim() === "") {
      return { kind: "unavailable", reason: "malformed_response" };
    }
    return Object.freeze({ kind: "source", reference: file.trim() });
  }

  async #verify(attempt: ConnectionAttempt): Promise<void> {
    const login = await this.#request(attempt, "get_login_info", {});
    if (this.#active !== attempt) return;
    if (!this.#successful(login)) {
      this.#finish(
        attempt,
        this.#authentication(login) ? "authentication_failed" : "handshake_failed",
      );
      return;
    }
    const id = normalizeOneBotAccountId(record(login.value.data)?.user_id);
    if (!id || id !== this.#config.accountId) {
      this.#finish(attempt, id ? "account_mismatch" : "identity_invalid");
      return;
    }
    const status = await this.#request(attempt, "get_status", {});
    if (this.#active !== attempt) return;
    if (!this.#successful(status)) {
      this.#finish(
        attempt,
        this.#authentication(status) ? "authentication_failed" : "handshake_failed",
      );
      return;
    }
    const parsed = GoodStatus.safeParse(status.value.data);
    if (!parsed.success || !parsed.data.good || parsed.data.online === false) {
      this.#finish(attempt, parsed.success ? "account_offline" : "status_invalid");
      return;
    }
    clearTimeout(attempt.timer);
    this.#state = { phase: "ready", accountId: id };
    attempt.resolve({ kind: "ready", accountId: id });
  }

  #successful(result: RequestResult): result is Extract<RequestResult, { kind: "response" }> {
    return result.kind === "response" && result.value.status === "ok" && result.value.retcode === 0;
  }

  #authentication(result: RequestResult): boolean {
    return (
      result.kind === "response" &&
      result.value.status === "failed" &&
      (result.value.retcode === 1401 || result.value.retcode === 1403)
    );
  }

  #request(attempt: ConnectionAttempt, action: string, params: object): Promise<RequestResult> {
    if (this.#active !== attempt || attempt.socket.readyState !== 1) {
      return Promise.resolve({ kind: "not_sent", reason: "not_ready" });
    }
    const echo = `${this.#prefix}:${++this.#sequence}`;
    let payload: string;
    try {
      payload = JSON.stringify({ action, params, echo });
    } catch {
      return Promise.resolve({ kind: "not_sent", reason: "invalid_request" });
    }
    const deferred = Promise.withResolvers<RequestResult>();
    const timer = setTimeout(() => {
      this.#settle(echo, { kind: "unknown", reason: "timeout" });
    }, this.#config.requestTimeoutMs);
    this.#pending.set(echo, { timer, resolve: deferred.resolve });
    try {
      attempt.socket.send(payload);
    } catch {
      this.#settle(echo, { kind: "unknown", reason: "transport_error" });
      this.#finish(attempt, "connect_error");
    }
    return deferred.promise;
  }

  #settle(echo: string, result: RequestResult): void {
    const pending = this.#pending.get(echo);
    if (!pending) return;
    this.#pending.delete(echo);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  #receive(attempt: ConnectionAttempt, data: unknown): void {
    if (this.#active !== attempt) return;
    let raw: Record<string, unknown> | null;
    try {
      raw = typeof data === "string" ? record(JSON.parse(data)) : null;
    } catch {
      raw = null;
    }
    if (!raw) {
      this.#finish(attempt, "protocol_error");
      return;
    }
    if (isOneBotAuthenticationFailure(raw)) {
      this.#finish(attempt, "authentication_failed");
      return;
    }
    if (raw.post_type === undefined) {
      if (typeof raw.echo === "string")
        this.#settle(raw.echo, { kind: "response", value: raw, echo: raw.echo });
      return;
    }
    // Identity/offline signals must also invalidate an in-flight handshake.
    const id = normalizeOneBotAccountId(raw.self_id);
    if (id && id !== this.#config.accountId) {
      this.#finish(attempt, "account_mismatch");
      return;
    }
    if (raw.post_type === "meta_event" && raw.meta_event_type === "heartbeat" && id) {
      const status = GoodStatus.safeParse(raw.status);
      if (status.success && (!status.data.good || status.data.online === false))
        this.#finish(attempt, "account_offline");
      return;
    }
    if (this.#state.phase !== "ready") return;
    const result = normalizeOneBotMessage(raw, this.#config.accountId);
    if (result.kind === "ignored") return;
    try {
      Promise.resolve(this.#onMessage(result)).catch(() => this.#finish(attempt, "consumer_error"));
    } catch {
      this.#finish(attempt, "consumer_error");
    }
  }

  #finish(attempt: ConnectionAttempt, reason: OneBotConnectionFailure): void {
    if (this.#active !== attempt) return;
    this.#active = null;
    this.#state = { phase: "closed", reason };
    clearTimeout(attempt.timer);
    attempt.detach();
    for (const echo of this.#pending.keys())
      this.#settle(echo, { kind: "unknown", reason: "disconnected" });
    attempt.resolve({ kind: "failed", reason });
    // Terminate only the socket owned by this attempt; never stop the upstream process.
    attempt.socket.terminate();
  }
}
