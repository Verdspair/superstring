import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentStepSnapshot,
  ModelMessage,
  OutputSummary,
  ProtectedModelOutput,
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
import {
  resolveAgentTraceScope,
  startAgentTrace,
  traceErrorCode,
  withinAgentTrace,
} from "../observability/agent-tracing";
import type {
  RuntimeTelemetry,
  TraceMetadata,
  TraceScope,
} from "../observability/runtime-telemetry";
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
  trace?: TraceScope;
  channel: TraceMetadata["channel"];
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
      telemetry?: RuntimeTelemetry;
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
  get telemetry(): RuntimeTelemetry | undefined {
    return this.options.telemetry;
  }
  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  async completeLeaf(spec: LeafAgentSpec, input: LeafInput): Promise<string> {
    const active = this.start(spec, input);
    return this.withRun(active, () => this.completeLeafRun(active, spec, input));
  }

  private async completeLeafRun(
    active: Running,
    spec: LeafAgentSpec,
    input: LeafInput,
  ): Promise<string> {
    try {
      await this.emit(active, { type: "started" });
      this.repository.setStatus(active.runId, "generating", this.now());
      const messages = [
        ...(spec.instructions === undefined ? [] : [textMessage("system", spec.instructions)]),
        ...textMessages(input.messages),
      ];
      const value = await this.step(
        active,
        "leaf",
        messages,
        input.sources ?? [],
        async (capture, onModelResolved) => {
          const raw = await this.options.model.complete({
            messages,
            model: spec.model,
            temperature: spec.temperature,
            maxTokens: spec.maxTokens,
            responseSchema: spec.responseSchema,
            signal: active.signal,
            onModelResolved,
            onResponseText: capture,
          });
          capture(raw, true);
          await input.validate?.(raw);
          return raw;
        },
      );
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
    return this.withRun(active, () => this.completeVisionRun(active, spec, input));
  }

  private async completeVisionRun(
    active: Running,
    spec: LeafAgentSpec,
    input: VisionLeafInput,
  ): Promise<string> {
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
      const value = await this.step(
        active,
        "vision",
        messages,
        input.sources ?? [],
        async (capture) => {
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
          capture(raw, true);
          await input.validate?.(raw);
          return raw;
        },
      );
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
    return this.withRun(active, () => this.runConversation(active, spec, input));
  }

  private async runConversation(
    active: Running,
    spec: AgentSpec,
    input: ConversationInput,
  ): Promise<ConversationRunResult> {
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
        const context = await this.trace(
          active,
          "agent.context",
          {
            stage: "context",
            details: { phase: "next", observationCount: observations.length },
          },
          async (scope) => {
            const material = await input.context.read({ signal: active.signal, observations });
            active.signal.throwIfAborted();
            const rendered = this.contextEngine.render(
              spec,
              material,
              observations,
              input.authorizedTargets,
              input.outputMode,
            );
            scope?.update({
              sources: rendered.sources,
              details: {
                inputUnits: rendered.units,
                messageCount: rendered.messages.length,
                sourceCount: rendered.sources.length,
                evidenceCount: material.evidence?.length ?? 0,
                summaryCount: material.summaries?.length ?? 0,
                historyCount: material.history?.length ?? 0,
              },
            });
            await input.onContext?.(rendered, { runId: active.runId, phase: "next" });
            return rendered;
          },
        );
        const decision = await this.step(
          active,
          "next",
          context.messages,
          context.sources,
          async (capture, onModelResolved) => {
            let resolved = spec.model ?? this.options.model.defaultModel ?? "?";
            const raw = await this.options.model.complete({
              messages: context.messages,
              model: spec.model,
              temperature: spec.temperature,
              maxTokens: spec.maxTokens ?? spec.limits.outputTokens,
              responseSchema: AGENT_DECISION_JSON_SCHEMA,
              // 已广告的动作同时以原生 tools 声明（issue #10）：模型用它表达 invoke，正文只剩
              // final/none。是否真的发送由网关决定——外部路由发，本地服务保持冻结的 JSON 决策。
              tools: spec.availableActions.map((action) => ({
                name: action.name,
                description: action.description,
                parameters: action.parameters,
              })),
              signal: active.signal,
              onModelResolved: (model) => {
                resolved = model;
                onModelResolved(model);
              },
              onResponseText: capture,
            });
            capture(raw, true);
            try {
              return parseAgentDecision(raw);
            } catch {
              // 「读不出决策」必须能一眼看出模型回了什么。原文也会随步骤落库
              // （受保护输出，运行检查器可看），这里只是让它出现在控制台/日志里。
              console.warn(
                `[agent] 决策解析失败 model=${resolved} phase=next：${summariseModelText(raw)}`,
              );
              throw new AgentRuntimeError(
                "AGENT_DECISION_INVALID",
                "Decision must be a complete JSON object matching the Agent schema",
              );
            }
          },
        );
        if (decision.kind === "none") {
          if (
            await this.trace(
              active,
              "agent.checkpoint",
              { stage: "context", details: { phase: "before_final", decision: "none" } },
              async (scope) => {
                const result = await input.beforeFinal?.([], active.signal);
                scope?.update({ details: { reobserved: result ?? false } });
                return result;
              },
            )
          )
            continue;
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
          const result = await this.trace(
            active,
            "agent.action",
            {
              stage: "action",
              sources: context.sources,
              details: { action: decision.name },
            },
            async (scope) => {
              const result = await action.execute(decision.arguments, {
                owner: input.owner,
                signal: active.signal,
              });
              scope?.update({
                sources: uniqueSources([...context.sources, ...result.sources]),
                details: { sourceCount: result.sources.length },
              });
              return result;
            },
          );
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
        if (
          await this.trace(
            active,
            "agent.checkpoint",
            { stage: "context", details: { phase: "before_final", decision: "final" } },
            async (scope) => {
              const result = await input.beforeFinal?.(decision.outputs, active.signal);
              scope?.update({ details: { reobserved: result ?? false } });
              return result;
            },
          )
        )
          continue;
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
            const { generation, generationContext, messages, generationSpec } = await this.trace(
              active,
              "agent.context",
              {
                stage: "context",
                outputId,
                details: { phase: "generate" },
              },
              async (scope) => {
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
                scope?.update({
                  sources: generationContext.sources,
                  details: {
                    inputUnits: inputUnits(messages),
                    messageCount: messages.length,
                    sourceCount: generationContext.sources.length,
                  },
                });
                const generationSpec: LeafAgentSpec = {
                  ...spec,
                  model: generation.model ?? spec.model,
                  temperature: generation.temperature ?? spec.temperature,
                  maxTokens: generation.maxTokens ?? spec.maxTokens ?? spec.limits.outputTokens,
                  limits: { inputUnits: generation.inputUnits ?? spec.limits.inputUnits },
                };
                return { generation, generationContext, messages, generationSpec };
              },
            );
            let text = "";
            await this.step(
              active,
              "generate",
              messages,
              generationContext.sources,
              async (capture, onModelResolved) => {
                for await (const delta of this.options.model.streamText({
                  messages,
                  model: generationSpec.model,
                  temperature: generationSpec.temperature,
                  maxTokens: generationSpec.maxTokens,
                  signal: active.signal,
                  onModelResolved,
                })) {
                  active.signal.throwIfAborted();
                  if (!delta) continue;
                  text += delta;
                  capture(text);
                  if (input.outputMode === "stream")
                    await this.emit(active, { type: "output_delta", outputId, text: delta });
                }
                capture(text, true);
                if (!unicodeStrip(text) && !generation.allowEmpty)
                  throw new AgentRuntimeError(
                    "MODEL_EMPTY_RESPONSE",
                    "Model returned an empty response",
                  );
                return text;
              },
              generationSpec,
              outputId,
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
        const reconsidered = await this.trace(
          active,
          "agent.checkpoint",
          { stage: "context", details: { phase: "reconsider", outputCount: outputs.length } },
          async (scope) => {
            const result = await input.reconsider?.(outputs, active.signal);
            scope?.update({ details: { reconsidered: result ?? false } });
            return result;
          },
        );
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
      sources?: readonly SourceRef[];
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
    let channel: TraceMetadata["channel"] = "system";
    const trace = startAgentTrace(this.telemetry, "agent.run", (telemetry) => {
      const scope = resolveAgentTraceScope(telemetry, input.owner, input.conversationId);
      channel = scope.channel;
      return {
        ...scope,
        runId,
        sources: input.sources,
        details: {
          specId: spec.id,
          ownerKind: input.owner.kind,
          ownerId: input.owner.id,
        },
      };
    });
    return {
      runId,
      spec,
      signal,
      trace,
      channel,
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
    execute: (
      capture: (text: string, complete?: boolean) => void,
      onModelResolved: (model: string) => void,
    ) => Promise<T>,
    stepSpec: LeafAgentSpec = active.spec,
    outputId?: string,
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
    let output: ProtectedModelOutput | undefined;
    const capture = (text: string, complete = false) => {
      output = { text, complete, format: phase === "next" ? "json" : "text" };
    };
    return this.trace(
      active,
      "agent.model",
      {
        stage: "model",
        outputId,
        model: stepSpec.model ?? this.options.model.defaultModel,
        sources,
        details: {
          stepId,
          modelResolved: phase === "vision",
          requestedModel: stepSpec.model ?? this.options.model.defaultModel ?? "",
          stepNo: active.stepNo,
          phase,
          inputUnits: inputUnits(messages),
          messageCount: messages.length,
          sourceCount: sources.length,
          imageCount: messages.reduce(
            (n, m) => n + m.content.filter((part) => part.kind === "image").length,
            0,
          ),
          maxTokens:
            stepSpec.maxTokens ??
            (phase === "next" ? (stepSpec as AgentSpec).limits?.outputTokens : undefined) ??
            null,
        },
      },
      async (scope) => {
        try {
          await this.emit(active, {
            type: "step",
            stepId,
            context: { runId: active.runId, stepId },
          });
          const result = await execute(capture, (model) => {
            this.repository.resolveStepModel(stepId, model);
            scope?.update({ model, details: { modelResolved: true } });
          });
          active.signal.throwIfAborted();
          if (phase === "next") {
            const decision = AgentDecisionSchema.parse(result);
            scope?.update({
              details: {
                decision: decision.kind,
                ...(decision.kind === "invoke" ? { action: decision.name } : {}),
                ...(decision.kind === "final" ? { outputCount: decision.outputs.length } : {}),
              },
            });
          } else
            scope?.update({
              details: { outputCharacters: typeof result === "string" ? result.length : null },
            });
          this.repository.finishStep(stepId, "completed", this.now(), {
            decision: phase === "next" ? decisionMetadata(result) : undefined,
            output,
          });
          return result;
        } catch (error) {
          const failed = active.signal.aborted ? active.signal.reason : error;
          const code = errorCode(failed);
          this.repository.finishStep(
            stepId,
            active.callerSignal?.aborted ? "cancelled" : "failed",
            this.now(),
            { errorCode: code, output },
          );
          // 无码失败是一条死胡同（记录里只有 AGENT_FAILED）。留一行：阶段、模型、错误名与消息，
          // 以及模型这次实际回了什么（截断，不含正文以外的内容）——要求可定位。
          if (code === "AGENT_FAILED" && !active.callerSignal?.aborted)
            console.warn(
              `[agent] 步骤失败（无错误码）phase=${phase} model=${stepSpec.model ?? "?"}：${describeFailure(failed)}｜模型输出：${summariseModelText(output?.text)}`,
            );
          scope?.end(active.callerSignal?.aborted ? "cancelled" : "failed", traceErrorCode(failed));
          throw error;
        }
      },
    );
  }

  private async withRun<T>(active: Running, work: () => Promise<T>): Promise<T> {
    const execute = async () => {
      try {
        return await work();
      } finally {
        // Durable terminal is authoritative even when a downstream stream consumer disconnects.
        if (active.trace) {
          try {
            const snapshot = this.repository.getRun(active.runId);
            const status = snapshot?.endedAt ? snapshot.status : "failed";
            active.trace.update({ details: { stepCount: active.stepNo } });
            active.trace.end(
              status === "completed" || status === "no_output" || status === "cancelled"
                ? status
                : "failed",
              snapshot?.errorCode
                ? traceErrorCode({ code: snapshot.errorCode })
                : status === "failed"
                  ? "AGENT_FAILED"
                  : undefined,
            );
          } catch {
            active.trace.end("unknown", "RUN_STATE_UNAVAILABLE");
          }
        }
      }
    };
    return active.trace ? active.trace.within(execute) : execute();
  }

  private trace<T>(
    active: Running,
    name: string,
    metadata: Omit<TraceMetadata, "channel">,
    work: (scope: TraceScope | undefined) => Promise<T>,
  ): Promise<T> {
    return withinAgentTrace(
      startAgentTrace(this.telemetry, name, () => ({ channel: active.channel, ...metadata })),
      async (scope) => {
        try {
          return await work(scope);
        } catch (error) {
          scope?.end(
            active.callerSignal?.aborted ? "cancelled" : "failed",
            traceErrorCode(active.signal.aborted ? active.signal.reason : error),
          );
          throw error;
        }
      },
    );
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
    const committed = await this.trace(
      active,
      "agent.commit",
      { stage: "run", details: { outputCount: outputs.length, terminal: status } },
      async (scope) => {
        const event = await input.commitOutputs?.(outputs, active.runId, {
          status,
          event: payload,
          at: this.now(),
        });
        scope?.update({ status });
        return event;
      },
    );
    for (const output of outputs) {
      const scope = startAgentTrace(this.telemetry, "agent.output", () => ({
        channel: active.channel,
        stage: "delivery",
        outputId: output.outputId,
        sources: output.sources,
        details: {
          targetId: output.targetId,
          outputStatus: output.status,
          textCharacters: output.text?.length ?? 0,
          attachmentCount: output.stickerIds?.length ?? 0,
        },
      }));
      scope?.end(
        output.status === "failed"
          ? "failed"
          : output.status === "blocked"
            ? "skipped"
            : "completed",
        output.code ? traceErrorCode({ code: output.code }) : undefined,
      );
    }
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
    // 运行级失败也留一行：状态、错误名与消息。无码失败（AGENT_FAILED）从此不再是死胡同——
    // 记录里仍然只有码，但控制台能直接看到原因。
    if (!cancelled && code === "AGENT_FAILED")
      console.warn(`[agent] 运行失败（无错误码）：${describeFailure(error)}`);
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

/** 一行、截断的诊断摘要：模型输出与错误消息都可能很长，日志里只留一行。 */
function summariseModelText(text: string | null | undefined): string {
  if (text === null || text === undefined || text === "") return "(空)";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

function describeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${summariseModelText(message)}`;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  // 不猜消息里的码：记录与 span 里只许出现抛出点自己设的 `.code`，否则失败文本会顺着
  // "看着像码"的消息漏进诊断面（`runtime-peripheral-observability` 钉着这条边界）。
  // 严格解析读不出模型输出：这是"输出不符合要求"，不是"决策不合法"——决策那条路会把失败
  // 包成带码的 AgentRuntimeError，走到这里的其实是叶子任务自己的解析器（判断、整理等）。
  // JSON 读不出来是 SyntaxError、形状不对是 ZodError，两者是同一件事。
  return error instanceof SyntaxError || error instanceof z.ZodError
    ? "AGENT_OUTPUT_INVALID"
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
  telemetry?: RuntimeTelemetry;
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
