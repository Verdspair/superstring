import { createHash, randomUUID } from "node:crypto";
import type {
  AgentStepSnapshot,
  ModelMessage,
  OutputSummary,
  RunEvent,
  RunEventPayload,
  RunOwner,
  RunStatus,
} from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import { AgentRunRepository } from "../db/agent-run-repository";
import { openBusinessDb } from "../db/schema-gate";
import type { ChatMessage } from "../llm/model-gateway";
import type { VisionClient, VisionImage } from "../llm/vision-client";
import { unicodeStrip } from "../services/text";
import {
  AGENT_DECISION_JSON_SCHEMA,
  AgentDecisionSchema,
  type AgentGenerationConfig,
  type AgentSpec,
  type LeafAgentSpec,
  type OutputDraft,
  parseAgentDecision,
} from "./agent-specs";
import type { BuiltInAction } from "./built-in-actions";
import {
  type ActionObservation,
  ContextEngine,
  type ConversationContextSource,
  inputUnits,
  type RenderedContext,
  textMessage,
  uniqueSources,
} from "./context-engine";
import { createModelPort, type ModelPort, type TextModelGateway, textMessages } from "./model-port";

export interface LeafInput {
  messages: ChatMessage[];
  owner: RunOwner;
  signal?: AbortSignal;
  sources?: readonly SourceRef[];
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /** Existing domain parser executes inside the persisted step's success boundary. */
  validate?: (text: string) => unknown;
}
export interface VisionLeafInput extends Omit<LeafInput, "messages"> {
  model: string;
  prompt: string;
  images: readonly VisionImage[];
}
export interface PreparedOutput extends OutputSummary {
  text?: string;
  /** undefined/null asks the channel to select; [] explicitly declines; IDs select attachments. */
  stickerIds?: readonly string[] | null;
  /** Channel-resolved attachment provenance, retained with a pending plan and delivery. */
  sources?: readonly SourceRef[];
}
export interface PreparedGeneration extends AgentGenerationConfig {
  /** Explicit host-provided phase projection from the same authorized context source. */
  context?: RenderedContext;
}
export interface ConversationInput {
  owner: RunOwner;
  context: ConversationContextSource;
  authorizedTargets: readonly string[];
  outputMode: "stream" | "buffered";
  signal?: AbortSignal;
  conversationId?: string;
  requestId?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /** Host-bound scope/budget handlers, never derived from model arguments. */
  actions?: readonly BuiltInAction[];
  onContext?: (
    context: RenderedContext,
    input: { runId: string; phase: "next" | "generate" },
  ) => void | Promise<void>;
  /** Called before the first output delta, e.g. reserve the Web assistant message ID. */
  prepareOutput?: (
    draft: OutputDraft,
    ordinal: number,
  ) => Promise<{ outputId: string } | { blocked: true; code: string }>;
  /** Trusted host configuration and explicit phase view for this authorized output. */
  prepareGeneration?: (
    draft: Extract<OutputDraft, { kind: "generate" }>,
    input: { context: RenderedContext; outputId: string; signal: AbortSignal },
  ) => Promise<PreparedGeneration | undefined>;
  /** Last observation checkpoint before a final/none decision becomes externally visible. */
  beforeFinal?: (drafts: readonly OutputDraft[], signal: AbortSignal) => Promise<boolean>;
  /** True re-observes; no_output suppresses a buffered plan that has no deliverable parts. */
  reconsider?: (
    outputs: readonly PreparedOutput[],
    signal: AbortSignal,
  ) => Promise<boolean | "no_output">;
  /** Host transaction for partial text/error state and the same run terminal. */
  commitFailure?: (
    error: unknown,
    runId: string,
    terminal: {
      status: "failed" | "cancelled";
      event: RunEventPayload;
      errorCode: string;
      at: string;
    },
  ) => Promise<RunEvent | undefined>;
  /** Persists completed messages/intentions. Network delivery belongs to the host. */
  commitOutputs?: (
    outputs: readonly PreparedOutput[],
    runId: string,
    terminal: {
      status: "completed" | "no_output";
      event: RunEventPayload;
      at: string;
    },
  ) => Promise<RunEvent | undefined>;
}
export interface ConversationRunResult {
  runId: string;
  status: "completed" | "no_output";
  outputs: readonly PreparedOutput[];
}
interface Running {
  runId: string;
  spec: LeafAgentSpec;
  signal: AbortSignal;
  callerSignal?: AbortSignal;
  stepNo: number;
  conversationId?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  dispose(): void;
}

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

/** One inference owner for leaf tasks and iterative conversations. No channel sends here. */
export class AgentRuntime {
  private readonly contextEngine: ContextEngine;
  private readonly actions: Map<string, BuiltInAction>;
  constructor(
    private readonly options: {
      model: ModelPort;
      repository: AgentRunRepository;
      actions?: readonly BuiltInAction[];
      contextEngine?: ContextEngine;
      now?: () => string;
    },
  ) {
    this.contextEngine = options.contextEngine ?? new ContextEngine();
    this.actions = new Map(
      (options.actions ?? []).map((action) => [action.description.name, action]),
    );
  }

  get repository(): AgentRunRepository {
    return this.options.repository;
  }
  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  async completeLeaf(spec: LeafAgentSpec, input: LeafInput): Promise<string> {
    const active = this.start(spec, input);
    try {
      await this.emit(active, { type: "started" });
      this.repository.setStatus(active.runId, "generating", this.now());
      const messages = [
        ...(spec.instructions === undefined ? [] : [textMessage("system", spec.instructions)]),
        ...textMessages(input.messages),
      ];
      const value = await this.step(active, "leaf", messages, input.sources ?? [], async () => {
        const raw = await this.options.model.complete({
          messages,
          model: spec.model,
          temperature: spec.temperature,
          maxTokens: spec.maxTokens,
          responseSchema: spec.responseSchema,
          signal: active.signal,
        });
        await input.validate?.(raw);
        return raw;
      });
      await this.finish(active, "completed", { type: "completed", outputs: [] });
      return value;
    } catch (error) {
      await this.fail(active, error);
      throw error;
    } finally {
      active.dispose();
    }
  }

  async completeVisionLeaf(spec: LeafAgentSpec, input: VisionLeafInput): Promise<string> {
    const active = this.start({ ...spec, model: input.model }, input);
    try {
      await this.emit(active, { type: "started" });
      this.repository.setStatus(active.runId, "generating", this.now());
      const source = input.sources?.[0];
      const messages: ModelMessage[] = [
        ...(spec.instructions === undefined ? [] : [textMessage("system", spec.instructions)]),
        {
          role: "user",
          content: [
            { kind: "text", text: input.prompt },
            ...input.images.map((image, index) => ({
              kind: "image" as const,
              sourceId: source?.id ?? `${active.runId}:image:${index}`,
              revision: source?.revision ?? "1",
              mimeType: image.mimeType,
              sha256: createHash("sha256").update(image.bytes).digest("hex"),
            })),
          ],
        },
      ];
      const value = await this.step(active, "vision", messages, input.sources ?? [], async () => {
        const raw = await this.options.model.completeMultimodal({
          systemPrompt: spec.instructions,
          temperature: spec.temperature,
          maxTokens: spec.maxTokens,
          model: input.model,
          prompt: input.prompt,
          images: input.images,
          responseSchema: spec.responseSchema,
          signal: active.signal,
        });
        await input.validate?.(raw);
        return raw;
      });
      await this.finish(active, "completed", { type: "completed", outputs: [] });
      return value;
    } catch (error) {
      await this.fail(active, error);
      throw error;
    } finally {
      active.dispose();
    }
  }

  async run(spec: AgentSpec, input: ConversationInput): Promise<ConversationRunResult> {
    const active = this.start(spec, input);
    const observations: ActionObservation[] = [];
    const actions = input.actions
      ? new Map(input.actions.map((action) => [action.description.name, action]))
      : this.actions;
    try {
      await this.emit(active, {
        type: "started",
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
      for (;;) {
        this.checkStepBudget(active, spec);
        this.repository.setStatus(active.runId, "deciding", this.now());
        const material = await input.context.read({ signal: active.signal, observations });
        active.signal.throwIfAborted();
        const context = this.contextEngine.render(
          spec,
          material,
          observations,
          input.authorizedTargets,
          input.outputMode,
        );
        await input.onContext?.(context, { runId: active.runId, phase: "next" });
        const decision = await this.step(
          active,
          "next",
          context.messages,
          context.sources,
          async () => {
            const raw = await this.options.model.complete({
              messages: context.messages,
              model: spec.model,
              temperature: spec.temperature,
              maxTokens: spec.maxTokens ?? spec.limits.outputTokens,
              responseSchema: AGENT_DECISION_JSON_SCHEMA,
              signal: active.signal,
            });
            try {
              return parseAgentDecision(raw);
            } catch {
              throw new AgentRuntimeError(
                "AGENT_DECISION_INVALID",
                "Decision must be a complete JSON object matching the Agent schema",
              );
            }
          },
        );
        if (decision.kind === "none") {
          if (await input.beforeFinal?.([], active.signal)) continue;
          active.signal.throwIfAborted();
          await this.commitAndFinish(active, input, [], "no_output", { type: "no_output" });
          return { runId: active.runId, status: "no_output", outputs: [] };
        }
        if (decision.kind === "invoke") {
          const descriptor = spec.availableActions.find((action) => action.name === decision.name);
          const action = actions.get(decision.name);
          if (!descriptor || !action || descriptor.capability !== action.description.capability) {
            throw new AgentRuntimeError(
              "AGENT_ACTION_UNAVAILABLE",
              "Action is not available to this Agent",
            );
          }
          this.repository.setStatus(active.runId, "observing", this.now());
          const result = await action.execute(decision.arguments, {
            owner: input.owner,
            signal: active.signal,
          });
          active.signal.throwIfAborted();
          const observation = {
            ...result,
            id: randomUUID(),
            name: decision.name,
            arguments: decision.arguments,
            sources: uniqueSources([...context.sources, ...result.sources]),
          };
          observations.push(observation);
          await this.emit(active, {
            type: "action_result",
            name: decision.name,
            observationId: observation.id,
          });
          continue;
        }
        if (
          input.outputMode === "stream" &&
          (decision.outputs.length !== 1 || decision.outputs[0].kind !== "generate")
        ) {
          throw new AgentRuntimeError(
            "AGENT_OUTPUT_INVALID",
            "A streamed conversation requires one generated output",
          );
        }
        if (await input.beforeFinal?.(decision.outputs, active.signal)) continue;
        active.signal.throwIfAborted();
        this.repository.setStatus(active.runId, "generating", this.now());
        const outputs: PreparedOutput[] = [];
        for (const [ordinal, draft] of decision.outputs.entries()) {
          active.signal.throwIfAborted();
          if (!input.authorizedTargets.includes(draft.targetId)) {
            outputs.push({
              outputId: randomUUID(),
              targetId: draft.targetId,
              status: "blocked",
              code: "AGENT_TARGET_UNAUTHORIZED",
            });
            continue;
          }
          let outputId: string = randomUUID();
          try {
            const reservation = await input.prepareOutput?.(draft, ordinal);
            if (reservation && "blocked" in reservation) {
              outputs.push({
                outputId,
                targetId: draft.targetId,
                status: "blocked",
                code: reservation.code,
              });
              continue;
            }
            if (reservation) outputId = reservation.outputId;
            if (draft.kind === "inline") {
              outputs.push({
                outputId,
                targetId: draft.targetId,
                status: "prepared",
                text: draft.text,
                stickerIds: draft.stickerIds,
              });
              continue;
            }
            this.checkStepBudget(active, spec);
            const prepared = await input.prepareGeneration?.(draft, {
              context,
              outputId,
              signal: active.signal,
            });
            const generation = { ...spec.generation, ...prepared };
            const generationContext = prepared?.context ?? context;
            const messages = this.contextEngine.renderOutput(
              { ...spec, generation },
              generationContext,
              draft,
            );
            await input.onContext?.(
              { ...generationContext, messages, units: inputUnits(messages) },
              { runId: active.runId, phase: "generate" },
            );
            const generationSpec: LeafAgentSpec = {
              ...spec,
              model: generation.model ?? spec.model,
              temperature: generation.temperature ?? spec.temperature,
              maxTokens: generation.maxTokens ?? spec.maxTokens ?? spec.limits.outputTokens,
              limits: { inputUnits: generation.inputUnits ?? spec.limits.inputUnits },
            };
            let text = "";
            await this.step(
              active,
              "generate",
              messages,
              generationContext.sources,
              async () => {
                for await (const delta of this.options.model.streamText({
                  messages,
                  model: generationSpec.model,
                  temperature: generationSpec.temperature,
                  maxTokens: generationSpec.maxTokens,
                  signal: active.signal,
                })) {
                  active.signal.throwIfAborted();
                  if (!delta) continue;
                  text += delta;
                  if (input.outputMode === "stream")
                    await this.emit(active, { type: "output_delta", outputId, text: delta });
                }
                if (!unicodeStrip(text) && !generation.allowEmpty)
                  throw new AgentRuntimeError(
                    "MODEL_EMPTY_RESPONSE",
                    "Model returned an empty response",
                  );
              },
              generationSpec,
            );
            outputs.push({
              outputId,
              targetId: draft.targetId,
              status: "prepared",
              text,
              stickerIds: draft.stickerIds,
            });
          } catch (error) {
            if (
              active.signal.aborted ||
              input.outputMode === "stream" ||
              (error instanceof AgentRuntimeError && error.code === "AGENT_STEP_LIMIT")
            )
              throw error;
            outputs.push({
              outputId,
              targetId: draft.targetId,
              status: "failed",
              code: errorCode(error),
            });
          }
        }
        active.signal.throwIfAborted();
        const reconsidered = await input.reconsider?.(outputs, active.signal);
        if (reconsidered) {
          if (input.outputMode === "stream")
            throw new AgentRuntimeError(
              "AGENT_STREAM_RECONSIDERED",
              "Already streamed output cannot be replaced",
            );
          if (reconsidered === "no_output") {
            await this.commitAndFinish(active, input, [], "no_output", { type: "no_output" });
            return { runId: active.runId, status: "no_output", outputs: [] };
          }
          continue;
        }
        if (!outputs.some((output) => output.status === "prepared")) {
          throw new AgentRuntimeError("AGENT_OUTPUT_FAILED", "No output could be prepared");
        }
        const summaries = outputs.map(({ outputId, targetId, status, code }) => ({
          outputId,
          targetId,
          status,
          ...(code ? { code } : {}),
        }));
        await this.commitAndFinish(active, input, outputs, "completed", {
          type: "completed",
          outputs: summaries,
        });
        return { runId: active.runId, status: "completed", outputs };
      }
    } catch (error) {
      await this.fail(active, error, input.commitFailure);
      throw error;
    } finally {
      active.dispose();
    }
  }

  private start(
    spec: LeafAgentSpec,
    input: {
      owner: RunOwner;
      signal?: AbortSignal;
      onEvent?: Running["onEvent"];
      conversationId?: string;
    },
  ): Running {
    const deadline = new AbortController();
    const timer =
      spec.limits?.deadlineMs === undefined
        ? undefined
        : setTimeout(
            () =>
              deadline.abort(
                new AgentRuntimeError("AGENT_DEADLINE", "Agent run deadline exceeded"),
              ),
            spec.limits.deadlineMs,
          );
    const signal = input.signal
      ? AbortSignal.any([input.signal, deadline.signal])
      : deadline.signal;
    const runId = randomUUID();
    this.repository.createRun({
      runId,
      specId: spec.id,
      specVersion: spec.version ?? "1",
      owner: input.owner,
      at: this.now(),
    });
    return {
      runId,
      spec,
      signal,
      callerSignal: input.signal,
      stepNo: 0,
      conversationId: input.conversationId,
      onEvent: input.onEvent,
      dispose: () => clearTimeout(timer),
    };
  }

  private async step<T>(
    active: Running,
    phase: AgentStepSnapshot["phase"],
    messages: ModelMessage[],
    sources: readonly SourceRef[],
    execute: () => Promise<T>,
    stepSpec: LeafAgentSpec = active.spec,
  ): Promise<T> {
    active.signal.throwIfAborted();
    const limit = stepSpec.limits?.inputUnits;
    if (limit !== undefined && inputUnits(messages) > limit)
      throw new AgentRuntimeError(
        "AGENT_CONTEXT_LIMIT",
        "Context exceeds the configured input budget",
      );
    const stepId = randomUUID();
    const now = this.now();
    this.repository.startStep({
      runId: active.runId,
      stepId,
      stepNo: ++active.stepNo,
      model: stepSpec.model ?? this.options.model.defaultModel ?? "",
      phase,
      at: now,
      messages,
      sources,
    });
    try {
      await this.emit(active, { type: "step", stepId, context: { runId: active.runId, stepId } });
      const result = await execute();
      active.signal.throwIfAborted();
      this.repository.finishStep(stepId, "completed", this.now(), {
        decision: phase === "next" ? decisionMetadata(result) : undefined,
      });
      return result;
    } catch (error) {
      this.repository.finishStep(
        stepId,
        active.callerSignal?.aborted ? "cancelled" : "failed",
        this.now(),
        { errorCode: errorCode(active.signal.aborted ? active.signal.reason : error) },
      );
      throw error;
    }
  }

  private checkStepBudget(active: Running, spec: AgentSpec): void {
    active.signal.throwIfAborted();
    if (active.stepNo >= spec.limits.steps)
      throw new AgentRuntimeError("AGENT_STEP_LIMIT", "Agent exhausted its configured model steps");
  }
  private async emit(active: Running, payload: RunEventPayload): Promise<void> {
    const event = this.repository.appendEvent(
      active.runId,
      payload,
      this.now(),
      active.conversationId,
    );
    await active.onEvent?.(event);
  }
  private async finish(
    active: Running,
    status: RunStatus,
    payload: RunEventPayload,
  ): Promise<void> {
    const event = this.repository.finishRun(active.runId, status, payload, this.now(), {
      conversationId: active.conversationId,
    });
    await active.onEvent?.(event);
  }
  private async commitAndFinish(
    active: Running,
    input: ConversationInput,
    outputs: readonly PreparedOutput[],
    status: "completed" | "no_output",
    payload: RunEventPayload,
  ): Promise<void> {
    const committed = await input.commitOutputs?.(outputs, active.runId, {
      status,
      event: payload,
      at: this.now(),
    });
    // A durable host can atomically finishRun with intentions/wake acknowledgement and return
    // its committed terminal event. Publication is after the host transaction in either case.
    if (committed) await active.onEvent?.(committed);
    else await this.finish(active, status, payload);
  }
  private async fail(
    active: Running,
    error: unknown,
    commit?: ConversationInput["commitFailure"],
  ): Promise<void> {
    // Event consumers may disconnect after the terminal write. Do not mutate a completed run.
    if (this.repository.getRun(active.runId)?.endedAt) return;
    const cancelled = active.callerSignal?.aborted === true;
    const code = errorCode(active.signal.aborted ? active.signal.reason : error);
    const terminal = {
      status: cancelled ? ("cancelled" as const) : ("failed" as const),
      event: cancelled ? { type: "cancelled" as const } : { type: "failed" as const, code },
      at: this.now(),
      errorCode: code,
    };
    const committed = await commit?.(error, active.runId, terminal);
    const event =
      committed ??
      this.repository.finishRun(active.runId, terminal.status, terminal.event, terminal.at, {
        errorCode: code,
        conversationId: active.conversationId,
      });
    try {
      await active.onEvent?.(event);
    } catch {
      /* Original inference/stream failure remains the cause. */
    }
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : error instanceof SyntaxError
      ? "AGENT_DECISION_INVALID"
      : "AGENT_FAILED";
}

function decisionMetadata(value: unknown): unknown {
  const decision = AgentDecisionSchema.parse(value);
  if (decision.kind === "invoke") return { kind: decision.kind, name: decision.name };
  if (decision.kind === "final")
    return {
      kind: decision.kind,
      outputs: decision.outputs.map(({ kind, targetId }) => ({ kind, targetId })),
    };
  return { kind: decision.kind };
}

export type LeafAgentRuntime = Pick<AgentRuntime, "completeLeaf" | "completeVisionLeaf">;
export function createAgentRuntime(options: {
  gateway?: TextModelGateway;
  vision?: VisionClient;
  repository: AgentRunRepository;
  actions?: readonly BuiltInAction[];
  contextEngine?: ContextEngine;
}): AgentRuntime {
  return new AgentRuntime({ ...options, model: createModelPort(options) });
}

/** Explicit isolated test runtime; production assembly always supplies the business repository. */
export function createEphemeralAgentRuntime(options: {
  gateway?: TextModelGateway;
  vision?: VisionClient;
}): AgentRuntime & { close(): void } {
  const handle = openBusinessDb();
  return Object.assign(
    createAgentRuntime({ ...options, repository: new AgentRunRepository(handle.db) }),
    { close: () => handle.close() },
  );
}
