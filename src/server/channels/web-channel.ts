import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../../shared/contracts";
import type { RunEvent } from "../../shared/contracts/agent-run";
import type { ChatV2Event } from "../../shared/contracts/chat-v2";
import { type AgentRuntime, AgentRuntimeError, createAgentRuntime } from "../agent/agent-runtime";
import { ContextBuilder } from "../agent/conversation-context";
import { ConversationHost } from "../agent/conversation-host";
import { AgentRunRepository } from "../db/agent-run-repository";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import {
  DEFAULT_USER_ID,
  getMessage,
  getMessageByRequest,
  getTurnByRequest,
  heartbeatGeneration,
  immediate,
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
import type { ModuleQueryFactory, ModuleSourceResolver } from "../modules/composition";
import type { MemoryModule } from "../modules/contracts";
import { turnSources } from "../modules/provenance";
import { unicodeStrip } from "../services/text";
import { WebContextSource } from "./web-context-source";

export interface WebChannelOptions {
  orm: Orm;
  db?: Database;
  gateway: ModelGateway;
  agentRuntime?: AgentRuntime;
  host?: ConversationHost;
  journal?: ConversationEventRepository;
  contextBuilder?: ContextBuilder | null;
  modules?: ModuleQueryFactory;
  memory?: Pick<MemoryModule, "observe">;
  resolveSource?: ModuleSourceResolver;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  /** Configurable Agent iteration budget; model/token/time policies retain existing settings. */
  maxSteps?: number;
}
export interface WebRequest {
  sessionId: string;
  message: string;
  clientRequestId: string;
  signal?: AbortSignal;
}

/** One pending event, acknowledged only when the consumer resumes after its yield. */
class EventBridge {
  private item?: { event: ChatV2Event; resolve: () => void; reject: (reason: unknown) => void };
  private wake?: () => void;
  private closed = false;
  private failure?: unknown;
  async send(event: ChatV2Event): Promise<void> {
    if (this.closed) throw new DOMException("Stream closed", "AbortError");
    await new Promise<void>((resolve, reject) => {
      this.item = { event, resolve, reject };
      this.wake?.();
      this.wake = undefined;
    });
  }
  end(error?: unknown): void {
    this.closed = true;
    this.failure = error;
    this.wake?.();
    this.wake = undefined;
  }
  cancel(): void {
    this.closed = true;
    this.item?.reject(new DOMException("Stream closed", "AbortError"));
    this.item = undefined;
    this.wake?.();
    this.wake = undefined;
  }
  async next(): Promise<{ event: ChatV2Event; ack: () => void } | null> {
    while (!this.item && !this.closed)
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    if (this.item) {
      const item = this.item;
      return {
        event: item.event,
        ack: () => {
          if (this.item === item) this.item = undefined;
          item.resolve();
        },
      };
    }
    if (this.failure !== undefined) throw this.failure;
    return null;
  }
}

/** Web owns request leases and message commits; ConversationHost owns Agent activation. */
export class WebChannel {
  private readonly db: Database;
  private readonly runtime: AgentRuntime;
  private readonly host: ConversationHost;
  private readonly journal: ConversationEventRepository;
  private readonly builder: ContextBuilder | null;
  constructor(private readonly options: WebChannelOptions) {
    this.db = options.db ?? (options.orm as unknown as { $client: Database }).$client;
    this.runtime =
      options.agentRuntime ??
      createAgentRuntime({ gateway: options.gateway, repository: new AgentRunRepository(this.db) });
    this.host = options.host ?? new ConversationHost({ runtime: this.runtime });
    this.journal = options.journal ?? new ConversationEventRepository(this.db);
    this.builder =
      options.contextBuilder === null
        ? null
        : (options.contextBuilder ??
          (options.db
            ? new ContextBuilder({
                orm: options.orm,
                db: this.db,
                gateway: options.gateway,
                agentRuntime: this.runtime,
                modules: options.modules,
                resolveSource: options.resolveSource,
              })
            : null));
  }
  /** Eager preparation preserves ordinary HTTP errors before SSE has started. */
  async openReply(args: WebRequest): Promise<AsyncGenerator<ChatV2Event, void, unknown>> {
    const prepared = immediate(this.db, () => {
      const turn = prepareTurn(
        this.options.orm,
        args.sessionId,
        args.message,
        args.clientRequestId,
        { leaseSeconds: this.options.leaseSeconds ?? 30 },
      );
      const conversation = this.journal.ensureWeb(args.sessionId, DEFAULT_USER_ID);
      if (!conversation) throw new GenerationOwnershipLostError();
      const user = getMessageByRequest(
        this.options.orm,
        args.sessionId,
        args.clientRequestId,
        "user",
      );
      const event = user ? this.journal.ingestWebMessage(user.id) : null;
      if (!event) throw new GenerationOwnershipLostError();
      return { turn, conversation, throughSeq: event.seq };
    });
    if (prepared.turn.replay) {
      const assistant = getMessage(this.options.orm, args.sessionId, prepared.turn.messageId);
      return (async function* () {
        yield {
          type: "replay" as const,
          conversationId: prepared.conversation.id,
          sessionId: args.sessionId,
          requestId: args.clientRequestId,
          message: {
            id: assistant.id,
            text: assistant.content,
            createdAt: assistant.createdAt,
            completedAt: assistant.completedAt,
          },
        };
      })();
    }
    const turn = getTurnByRequest(this.options.orm, args.sessionId, args.clientRequestId);
    if (!turn || !prepared.turn.generationToken) throw new GenerationOwnershipLostError();
    return this.stream({
      ...args,
      conversation: prepared.conversation,
      throughSeq: prepared.throughSeq,
      turnId: turn.id,
      messageId: prepared.turn.messageId,
      generationToken: prepared.turn.generationToken,
      runtime: prepared.turn.runtime,
    });
  }
  private async *stream(
    args: WebRequest & {
      conversation: {
        id: string;
        agentId: string;
        channel: "web" | "onebot11";
        topology: "direct" | "shared";
      };
      throughSeq: number;
      turnId: string;
      messageId: string;
      generationToken: string;
      runtime: RuntimeConfig;
    },
  ): AsyncGenerator<ChatV2Event, void, unknown> {
    const o = this.options;
    const abort = new AbortController();
    const chunks: string[] = [];
    let ownership: "active" | "lost" | "cancelled" = "active";
    let committed = false,
      recorded = false;
    let failedEvent: RunEvent | undefined;
    let mappedFailure: unknown;
    const bridge = new EventBridge();
    const disconnect = () => abort.abort(new DOMException("Client disconnected", "AbortError"));
    args.signal?.addEventListener("abort", disconnect, { once: true });
    if (args.signal?.aborted) disconnect();
    const assertOwnership = () => {
      if (ownership === "cancelled") throw new GenerationCancelledError();
      if (ownership === "lost") throw new GenerationOwnershipLostError();
    };
    const monitor = setInterval(() => {
      try {
        ownership = heartbeatGeneration(
          o.orm,
          args.sessionId,
          args.clientRequestId,
          args.generationToken,
          { leaseSeconds: o.leaseSeconds ?? 30 },
        );
      } catch {
        ownership = "lost";
      }
      if (ownership !== "active") abort.abort();
    }, o.heartbeatIntervalMs ?? 5000);
    const source = new WebContextSource({
      db: this.db,
      orm: o.orm,
      gateway: o.gateway,
      agentRuntime: this.runtime,
      builder: this.builder,
      modules: o.modules,
      resolveSource: o.resolveSource,
      runtime: args.runtime,
      sessionId: args.sessionId,
      turnId: args.turnId,
      generationToken: args.generationToken,
      maxSteps: o.maxSteps ?? 16,
    });
    const classify = (
      error: unknown,
    ): { error: unknown; code: string; persistPartial: boolean } => {
      if (
        error instanceof GenerationCancelledError ||
        error instanceof GenerationOwnershipLostError
      )
        return { error, code: error.code, persistPartial: false };
      if (ownership !== "active") {
        const failure =
          ownership === "cancelled"
            ? new GenerationCancelledError()
            : new GenerationOwnershipLostError();
        return { error: failure, code: failure.code, persistPartial: false };
      }
      if (abort.signal.aborted) return { error, code: "CLIENT_DISCONNECTED", persistPartial: true };
      if (error instanceof AgentRuntimeError && error.code === "MODEL_EMPTY_RESPONSE") {
        const failure = new EmptyModelResponseError();
        return { error: failure, code: failure.code, persistPartial: true };
      }
      if (isAppError(error)) return { error, code: error.code, persistPartial: true };
      const failure =
        error instanceof Error && error.name === "DatabaseError"
          ? new DatabaseUnavailableError()
          : new ModelUnavailableError("MODEL_ERROR", "本地模型调用失败");
      return { error: failure, code: failure.code, persistPartial: true };
    };
    const record = (code: string) => {
      if (recorded || committed) return;
      recorded = true;
      try {
        saveFailedAssistantMessage(
          o.orm,
          args.sessionId,
          args.clientRequestId,
          code,
          args.generationToken,
          { partialContent: chunks.join("") },
        );
        this.journal.ingestWebMessage(args.messageId);
      } catch {
        /* The lease winner retains its own result. */
      }
    };
    const publish = async (event: RunEvent) => {
      if (event.type === "failed" || event.type === "cancelled") {
        failedEvent = event;
        return;
      }
      if (event.type === "started")
        this.journal.linkRun(event.runId, args.conversation.id, args.throughSeq);
      await bridge.send(event);
    };
    const producer = (async () => {
      try {
        args.signal?.throwIfAborted();
        await this.host.activate({
          conversation: args.conversation,
          spec: source.spec,
          owner: {
            kind: "web_turn",
            id: args.turnId,
            userId: DEFAULT_USER_ID,
            agentId: args.runtime.agent_id,
          },
          requestId: args.clientRequestId,
          context: source,
          actions: source.actions,
          authorizedTargets: ["reply"],
          outputMode: "stream",
          signal: abort.signal,
          onEvent: publish,
          onContext: async (context, info) => {
            const usage = source.contextUsage(context);
            if (usage)
              await publish(
                this.runtime.repository.appendEvent(
                  info.runId,
                  { type: "context_usage", usage },
                  new Date().toISOString(),
                  args.conversation.id,
                ),
              );
          },
          beforeFinal: async () => {
            assertOwnership();
            source.assertCurrent();
            return false;
          },
          prepareOutput: async () => ({ outputId: args.messageId }),
          commitFailure: async (error, runId, terminal) => {
            const disposition = classify(error);
            let hostFailure = disposition.error;
            // An unsuccessful transaction remains visibly incomplete; never follow it with
            // an independent message write that could split the two durable authorities.
            recorded = true;
            const committedFailure = immediate(this.db, () => {
              let code = terminal.status === "cancelled" ? disposition.code : terminal.errorCode;
              if (disposition.persistPartial) {
                try {
                  saveFailedAssistantMessage(
                    o.orm,
                    args.sessionId,
                    args.clientRequestId,
                    disposition.code,
                    args.generationToken,
                    { partialContent: chunks.join("") },
                  );
                  this.journal.ingestWebMessage(args.messageId);
                } catch (failure) {
                  if (
                    !(failure instanceof GenerationCancelledError) &&
                    !(failure instanceof GenerationOwnershipLostError)
                  )
                    throw failure;
                  hostFailure = failure;
                  code = failure.code;
                }
              }
              return this.runtime.repository.finishRun(
                runId,
                terminal.status,
                terminal.event.type === "failed" ? { ...terminal.event, code } : terminal.event,
                terminal.at,
                { errorCode: code, conversationId: args.conversation.id },
              );
            });
            mappedFailure = hostFailure;
            return committedFailure;
          },
          commitOutputs: async (outputs, runId, terminal) => {
            assertOwnership();
            args.signal?.throwIfAborted();
            source.assertCurrent();
            const answer = unicodeStrip(outputs[0]?.text ?? "");
            if (!answer) throw new EmptyModelResponseError();
            const event = immediate(this.db, () => {
              const assistant = saveCompletedAssistantMessage(
                o.orm,
                args.sessionId,
                answer,
                args.clientRequestId,
                args.generationToken,
              );
              this.journal.ingestWebMessage(assistant.id);
              this.journal.acknowledge(args.conversation.id, args.throughSeq);
              return this.runtime.repository.finishRun(
                runId,
                terminal.status,
                {
                  ...terminal.event,
                  type: "completed",
                  outputs: outputs.map(({ outputId, targetId, status, code }) => ({
                    outputId,
                    targetId,
                    status,
                    ...(code ? { code } : {}),
                  })),
                  messageId: assistant.id,
                  createdAt: assistant.createdAt,
                  completedAt: assistant.completedAt,
                },
                terminal.at,
                { conversationId: args.conversation.id },
              );
            });
            committed = true;
            // The turn is durable before a backend consumes it. SQLite maintenance also scans
            // its durable source cursor, so a failed notification does not erase the input.
            const ref = turnSources(o.orm, [args.turnId])[0];
            if (ref && o.memory?.observe) {
              try {
                await o.memory.observe({
                  source: ref,
                  payload: {
                    kind: "web_turn",
                    turnId: args.turnId,
                    agentId: args.conversation.agentId,
                  },
                });
              } catch {
                console.warn(
                  "memory observation notification failed; completed turn remains available to maintenance",
                );
              }
            }
            return event;
          },
        });
        bridge.end();
      } catch (error) {
        const disposition = classify(mappedFailure ?? error);
        if (disposition.persistPartial) record(disposition.code);
        else recorded = true;
        const failure = disposition.error;
        if (failedEvent) {
          try {
            await bridge.send(failedEvent);
          } catch {
            /* Consumer has gone away. */
          }
        }
        bridge.end(failure);
      }
    })();
    try {
      while (true) {
        const item = await bridge.next();
        if (!item) break;
        if (item.event.type === "output_delta") chunks.push(item.event.text);
        yield item.event;
        item.ack();
      }
      await producer;
    } finally {
      args.signal?.removeEventListener("abort", disconnect);
      clearInterval(monitor);
      abort.abort();
      bridge.cancel();
      await producer;
      if (!committed && !recorded && ownership === "active") record("CLIENT_DISCONNECTED");
    }
  }
}
