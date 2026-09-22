// Streaming chat orchestration
// Model streaming races a heartbeat monitor, as in the contract.
// AbortController and an interval preserve these observable guarantees:
// 1. `start` is emitted before anything else (the route does this).
// 2. Deltas stream through unchanged; empty deltas are skipped.
// 3. The final answer is the concatenation of every delta, `.strip()`-ed.
// An empty answer is MODEL_EMPTY_RESPONSE (502) — never saved as "".
// 4. The answer is saved with `save_completed_assistant_message`, which
// re-verifies the token AND the lease. A stale writer therefore CANNOT
// overwrite a fresher answer; it raises instead.
// 5. Losing ownership (`lost`) or being cancelled (`cancelled`) aborts the
// model stream and re-raises WITHOUT writing a failed message — the
// winning writer owns the row.
// 6. Any other failure records a failed message carrying the partial text
// then re-raises so the route can emit an `error` event.
// 7. If the CLIENT disconnects, the partial text is recorded as
// CLIENT_DISCONNECTED and the generator unwinds.
// Ordering matters: ownership is checked BEFORE classifying an error, because
// a cancellation surfaces as a generic abort error from the model client and
// must not be misreported as MODEL_ERROR.

import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../../shared/contracts";
import type { ContextUsage } from "../../shared/contracts/context-usage";
import {
  getChatContext,
  getMessage,
  getTurnByRequest,
  heartbeatGeneration,
  type Orm,
  prepareTurn,
  saveCompletedAssistantMessage,
  saveFailedAssistantMessage,
} from "../db/repositories";
import {
  DatabaseUnavailableError,
  EmptyModelResponseError,
  GenerationCancelledError,
  GenerationOwnershipLostError,
  isAppError,
  ModelUnavailableError,
} from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import { ContextBuilder } from "./context-builder";
import { unicodeStrip } from "./text";

export type StreamEvent =
  | { kind: "delta"; text: string }
  | {
      kind: "done";
      messageId: string;
      createdAt: string;
      completedAt: string | null;
    };

export interface DirectServiceOptions {
  orm: Orm;
  gateway: ModelGateway;
  /** Production injects the business SQLite handle so ContextBuilder is active. */
  db?: Database;
  /** Explicit low-level tests may provide a custom builder or omit both fields. */
  contextBuilder?: ContextBuilder | null;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  onContextUsage?: (usage: ContextUsage) => void;
}

const DEFAULT_LEASE_SECONDS = 30;
const DEFAULT_HEARTBEAT_MS = 5_000;

export class DirectService {
  private readonly orm: Orm;
  private readonly gateway: ModelGateway;
  private readonly contextBuilder: ContextBuilder | null;
  private readonly leaseSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly onContextUsage?: (usage: ContextUsage) => void;

  constructor(options: DirectServiceOptions) {
    this.orm = options.orm;
    this.onContextUsage = options.onContextUsage;
    this.gateway = options.gateway;
    this.contextBuilder =
      options.contextBuilder ??
      (options.db
        ? new ContextBuilder({
            orm: options.orm,
            db: options.db,
            gateway: options.gateway,
          })
        : null);
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  }

  /**
   * 101.
   * IMPORTANT: this is an `async` function returning a generator, NOT an
   * `async function*`. The reply producer AWAITS
   * `prepare_turn` eagerly and then returns the iterator, and
   * awaits it BEFORE constructing the StreamingResponse. That ordering is
   * observable: a rejection such as SESSION_NOT_FOUND or
   * IDEMPOTENCY_CONFLICT comes back as a normal JSON HTTP error, not as an SSE
   * `error` event inside an already-opened 200 stream.
   */
  async openReply(args: {
    sessionId: string;
    message: string;
    clientRequestId: string;
    /** HTTP request/response cancellation; distinct from persisted ownership cancellation. */
    signal?: AbortSignal;
  }): Promise<AsyncGenerator<StreamEvent, void, unknown>> {
    const preparation = prepareTurn(this.orm, args.sessionId, args.message, args.clientRequestId, {
      leaseSeconds: this.leaseSeconds,
    });

    if (preparation.replay) {
      return this.replay(args.sessionId, preparation.messageId);
    }
    const generationToken = preparation.generationToken;
    if (generationToken === null) throw new GenerationOwnershipLostError();

    const turn = getTurnByRequest(this.orm, args.sessionId, args.clientRequestId);
    if (!turn) throw new GenerationOwnershipLostError();

    return this.streamOwnedReply({
      sessionId: args.sessionId,
      clientRequestId: args.clientRequestId,
      generationToken,
      currentTurnId: turn.id,
      runtime: preparation.runtime,
      signal: args.signal,
    });
  }

  private async *replay(
    sessionId: string,
    messageId: string,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const assistant = getMessage(this.orm, sessionId, messageId);
    if (assistant.content) yield { kind: "delta", text: assistant.content };
    yield {
      kind: "done",
      messageId: assistant.id,
      createdAt: assistant.createdAt,
      completedAt: assistant.completedAt,
    };
  }

  private async *streamOwnedReply(args: {
    sessionId: string;
    clientRequestId: string;
    generationToken: string;
    currentTurnId: string;
    runtime: RuntimeConfig;
    signal?: AbortSignal;
  }): AsyncGenerator<StreamEvent, void, unknown> {
    const { sessionId, clientRequestId, generationToken, currentTurnId, runtime } = args;
    const chunks: string[] = [];

    let ownership: "active" | "lost" | "cancelled" = "active";
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    args.signal?.addEventListener("abort", disconnect, { once: true });
    if (args.signal?.aborted) disconnect();

    const monitor = setInterval(() => {
      try {
        const status = heartbeatGeneration(this.orm, sessionId, clientRequestId, generationToken, {
          leaseSeconds: this.leaseSeconds,
        });
        if (status !== "active") {
          ownership = status;
          abort.abort();
        }
      } catch {
        // A failed heartbeat is indistinguishable from a lost lease
        ownership = "lost";
        abort.abort();
      }
    }, this.heartbeatIntervalMs);

    let finishedNormally = false;
    let recorded = false;

    try {
      args.signal?.throwIfAborted();
      // Context preparation runs under the same lease monitor as production
      // Production always injects ContextBuilder;
      // the legacy getChatContext path remains only for explicit low-level
      // fixtures.
      const context = this.contextBuilder
        ? await this.contextBuilder.build({
            sessionId,
            currentTurnId,
            runtime,
            generationToken,
            signal: abort.signal,
            onUsage: this.onContextUsage,
          })
        : getChatContext(this.orm, sessionId, { currentTurnId, runtime });

      args.signal?.throwIfAborted();
      this.contextBuilder?.assertKnowledgeAccess(currentTurnId, runtime.agent_id);
      const stream = this.gateway.streamChat({
        messages: context,
        model: runtime.model_name,
        temperature: runtime.temperature,
        maxTokens: runtime.p5_config.max_output_tokens,
        signal: abort.signal,
      });

      for await (const delta of stream) {
        args.signal?.throwIfAborted();
        if (ownership !== "active") break;
        if (delta) {
          chunks.push(delta);
          yield { kind: "delta", text: delta };
        }
      }

      // Ownership wins over any transport error: never reclassify a
      // cancellation as MODEL_ERROR.
      if (ownership !== "active") this.raiseOwnership(ownership);

      args.signal?.throwIfAborted();
      const answer = unicodeStrip(chunks.join(""));
      if (!answer) throw new EmptyModelResponseError();

      const assistant = saveCompletedAssistantMessage(
        this.orm,
        sessionId,
        answer,
        clientRequestId,
        generationToken,
      );
      finishedNormally = true;
      yield {
        kind: "done",
        messageId: assistant.id,
        createdAt: assistant.createdAt,
        completedAt: assistant.completedAt,
      };
    } catch (error) {
      // Ownership loss / cancellation must not write a failed row.
      if (
        error instanceof GenerationCancelledError ||
        error instanceof GenerationOwnershipLostError
      ) {
        recorded = true;
        throw error;
      }
      if (ownership !== "active") {
        recorded = true;
        this.raiseOwnership(ownership);
      }

      const partial = chunks.join("");
      if (args.signal?.aborted) {
        await this.recordFailed(
          sessionId,
          clientRequestId,
          generationToken,
          "CLIENT_DISCONNECTED",
          partial,
        );
        recorded = true;
        throw error;
      }
      if (isAppError(error)) {
        await this.recordFailed(sessionId, clientRequestId, generationToken, error.code, partial);
        recorded = true;
        throw error;
      }
      if (error instanceof Error && error.name === "DatabaseError") {
        const dbError = new DatabaseUnavailableError();
        await this.recordFailed(sessionId, clientRequestId, generationToken, dbError.code, partial);
        recorded = true;
        throw dbError;
      }
      const modelError = new ModelUnavailableError("MODEL_ERROR", "本地模型调用失败");
      await this.recordFailed(
        sessionId,
        clientRequestId,
        generationToken,
        modelError.code,
        partial,
      );
      recorded = true;
      throw modelError;
    } finally {
      args.signal?.removeEventListener("abort", disconnect);
      clearInterval(monitor);
      // Cancelling the producer is unconditional in the contract: the `finally`
      // at cancels every task it owns, which is what
      // stops an in-flight ContextBuilder / model fetch when the consumer stops
      // pulling (`stream.return()`, client disconnect) or an error unwinds the
      // generator. Without this the abort signal above would be a no-op on the
      // early-return path and the upstream fetch would keep running to its own
      // timeout, still occupying LM Studio.
      abort.abort();
      if (!finishedNormally && !recorded) {
        // The consumer stopped pulling (client disconnected): persist what we
        // streamed so far as CLIENT_DISCONNECTED.
        await this.recordFailed(
          sessionId,
          clientRequestId,
          generationToken,
          "CLIENT_DISCONNECTED",
          chunks.join(""),
        );
      }
    }
  }

  private raiseOwnership(status: "lost" | "cancelled"): never {
    if (status === "cancelled") throw new GenerationCancelledError();
    throw new GenerationOwnershipLostError();
  }

  /** best-effort; never masks the underlying error. */
  private async recordFailed(
    sessionId: string,
    clientRequestId: string,
    generationToken: string,
    errorCode: string,
    partialContent: string,
  ): Promise<void> {
    try {
      saveFailedAssistantMessage(this.orm, sessionId, clientRequestId, errorCode, generationToken, {
        partialContent,
      });
    } catch {
      return;
    }
  }
}
