import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { RuntimeConfig } from "../../../shared/contracts";
import type { RunOwner } from "../../../shared/contracts/agent-run";
import type { Evidence, SourceRef } from "../../../shared/contracts/evidence";
import { qqReplyTaskPrompt } from "../../../shared/contracts/qq";
import type { AgentRuntime, PreparedGeneration } from "../../agent/agent-runtime";
import type { AgentSpec, OutputDraft } from "../../agent/agent-specs";
import { type BuiltInAction, createBuiltInActions } from "../../agent/built-in-actions";
import { sourceAccess } from "../../agent/context-access";
import {
  type ActionObservation,
  ContextEngine,
  type ContextMaterial,
  inputUnits,
  type RenderedContext,
  textMessage,
  uniqueSources,
} from "../../agent/context-engine";
import {
  type CompressionRecord,
  ConversationCompressor,
  conversationSummaryEvidence,
} from "../../agent/conversation-compression";
import { memoryBodiesByScopeKeys } from "../../db/context-repository";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import type { OutboundIntentRepository } from "../../db/outbound-intent-repository";
import { qqMemberLabels } from "../../db/qq-member-repository";
import { conversationMessagesSince } from "../../db/qq-observation-repository";
import {
  type QqSchemeRow,
  schemeContext,
  schemeOutputReserve,
  schemePrompts,
  schemeReply,
} from "../../db/qq-scheme-repository";
import { ownSpeechSince } from "../../db/qq-speech-repository";
import { DEFAULT_USER_ID, type Orm } from "../../db/repositories";
import { AppError, fail } from "../../errors";
import type { ChatMessage, ModelGateway } from "../../llm/model-gateway";
import {
  createSqliteQueryFactory,
  type ModuleQueryFactory,
  type ModuleSourceResolver,
} from "../../modules/composition";
import type { KnowledgeModule, MemoryModule } from "../../modules/contracts";
import type { BotInitialMemoryQuery } from "../../modules/initial-evidence";
import { contextDumps, estimateMessages } from "../../modules/memory-query";
import { qqMemoryScopeKeyset } from "../../services/memory-scope";
import type { QqBinding, QqTaskSnapshot } from "../../services/qq-binding-contract";
import {
  type QqContextMessage,
  type QqContextSelection,
  type QqContextTier,
  qqBuildTimeline,
  qqContextLimits,
  qqSelectContext,
} from "../../services/qq-context-contract";
import { qqJudgementQuestion } from "../../services/qq-judgement-material";
import {
  buildQqPrompt,
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
  type QqPromptInput,
  type QqPromptMaterial,
  qqPromptMessages,
  qqSpeakerLabel,
} from "../../services/qq-prompt-contract";
import type { QqSpeechKind } from "../../services/qq-speaking-contract";
import { compileSystemPrompt } from "../../services/runtime-config";
import { estimateTokens } from "../../services/token-estimate";

export interface BotContextTarget {
  id: string;
  speakerId: string | null;
}
export interface BotContextSourceOptions {
  db: Database;
  orm: Orm;
  gateway: Pick<ModelGateway, "loadedContextCapacity">;
  agentRuntime: AgentRuntime;
  modules?: ModuleQueryFactory;
  resolveSource?: ModuleSourceResolver;
  journal: ConversationEventRepository;
  outbox: OutboundIntentRepository;
  conversationId: string;
  binding: QqBinding;
  snapshot: QqTaskSnapshot;
  scheme: QqSchemeRow;
  runtime: RuntimeConfig;
  spec: AgentSpec;
  path: QqSpeechKind;
  /** Private direct uses reply; shared judgement keeps its separately configured window. */
  decisionTier: QqContextTier;
  targets: () => readonly BotContextTarget[];
  /** Lease, binding/owner/config snapshots remain host responsibilities. */
  assertCurrent: () => void;
  now?: () => string;
  onRead?: (observedSeq: number) => void;
  onDiagnostic?: (event: {
    kind: "supplemental_summary_failed" | "supplemental_retrieval_failed";
    code: string;
    name?: string;
  }) => void;
}
interface View {
  material: ContextMaterial;
  selection: QqContextSelection;
  memoryCheck?: () => void;
  limit: number;
}

/** One authorized context owner with explicit decision/reply projections for every Bot topology. */
export class BotContextSource {
  readonly actions: BuiltInAction[];
  private readonly views = new Map<QqContextTier, View>();
  private readonly capacities = new Map<string, number>();
  private readonly engine = new ContextEngine();
  private readonly owner: RunOwner;
  private readonly memory: MemoryModule;
  private readonly knowledge: KnowledgeModule;
  private readonly initialMemory: BotInitialMemoryQuery;
  private readonly compressor: ConversationCompressor;
  private observations: readonly ActionObservation[] = [];
  private sequence = 0;
  private pendingPlan?: { value: unknown; sources: SourceRef[] };
  private readSources?: SourceRef[];
  private retrievalFailures: { name: string; code: string; observedSeq: number }[] = [];
  constructor(private readonly options: BotContextSourceOptions) {
    const o = options;
    this.owner = {
      kind: "qq_binding",
      id: o.binding.id,
      userId: DEFAULT_USER_ID,
      agentId: o.binding.agentId,
    };
    const modules = (o.modules ?? createSqliteQueryFactory(o))({
      runtime: o.runtime,
      assertSources: (sources) => {
        this.readSources?.push(...sources);
        this.assertSources(sources);
      },
    });
    this.memory = modules.memory;
    this.knowledge = modules.knowledge;
    this.initialMemory =
      modules.botMemory ??
      (async (input) => {
        const evidence = input.mode === "off" ? [] : await this.memory.query(input);
        const sources = evidence.flatMap((entry) => entry.sources);
        this.assertSources(sources);
        return {
          body: evidence.length
            ? `人工纠正优先于旧来源；不把角色剧情当现实事实。\n${contextDumps(evidence)}`
            : null,
          sources,
          assertCurrent: () => this.assertSources(sources),
        };
      });
    this.compressor = new ConversationCompressor({
      runtime: o.runtime,
      gateway: o.gateway,
      agentRuntime: o.agentRuntime,
      owner: this.owner,
      assertSources: (refs) => this.assertSources(refs),
    });
    this.actions = createBuiltInActions({
      ...(o.runtime.p5_config.retrieval_mode !== "off"
        ? {
            memory: {
              query: (input: { query: string; limit?: number }, action: { signal: AbortSignal }) =>
                this.query("memory.query", input, action.signal),
            },
          }
        : {}),
      ...(o.runtime.knowledge_read?.config.enabled !== false
        ? {
            knowledge: {
              query: (input: { query: string; limit?: number }, action: { signal: AbortSignal }) =>
                this.query("knowledge.query", input, action.signal),
            },
          }
        : {}),
    });
  }
  get observedSeq(): number {
    return this.sequence;
  }
  get selection(): QqContextSelection | undefined {
    return (
      this.views.get("reply")?.selection ?? this.views.get(this.options.decisionTier)?.selection
    );
  }
  get sources(): SourceRef[] {
    return uniqueSources(
      [...this.views.values()]
        .flatMap((view) => view.material.sources ?? [])
        .concat(
          this.observations.flatMap((observation) => observation.sources),
          this.pendingPlan?.sources ?? [],
        ),
    );
  }
  /** Host-owned, source-bound prior work, never a system instruction or permission to send. */
  setPendingPlan(value: unknown, sources: readonly SourceRef[]): void {
    this.assertSources(sources);
    this.pendingPlan = { value: structuredClone(value), sources: uniqueSources(sources) };
    this.views.clear();
  }
  private withPendingPlan(material: ContextMaterial): ContextMaterial {
    if (!this.pendingPlan && !this.retrievalFailures.length) return material;
    const pending = [...(material.pending ?? [])];
    if (this.pendingPlan)
      pending.push(
        textMessage(
          "user",
          contextDumps({ kind: "pending_plan", trust: "data_only", value: this.pendingPlan.value }),
        ),
      );
    if (this.retrievalFailures.length)
      pending.push(
        textMessage(
          "user",
          contextDumps({
            kind: "retrieval_status",
            trust: "data_only",
            failures: this.retrievalFailures,
          }),
        ),
      );
    return {
      ...material,
      pending,
      sources: uniqueSources([...(material.sources ?? []), ...(this.pendingPlan?.sources ?? [])]),
    };
  }
  /** Only a newly observed event changes the cached initial material; unchanged model steps reuse it. */
  invalidate(): void {
    this.assertCurrent();
    this.views.clear();
  }
  async read(input: {
    signal: AbortSignal;
    observations: readonly ActionObservation[];
  }): Promise<ContextMaterial> {
    this.observations = input.observations;
    this.assertCurrent();
    input.signal.throwIfAborted();
    if (!this.views.size) {
      const conversation = this.options.journal.get(this.options.conversationId);
      if (!conversation) fail("CONTEXT_SOURCE_INVALID", "会话已失效");
      this.sequence = (
        this.options.db
          .query(
            "SELECT COALESCE(MAX(seq),0) AS seq FROM conversation_events WHERE conversation_id=? AND kind IN ('inbound','media_revision','outbound')",
          )
          .get(conversation.id) as { seq: number }
      ).seq;
    }
    const view = await this.view(this.options.decisionTier, input.signal);
    this.options.spec.limits.inputUnits = view.limit;
    this.options.onRead?.(this.sequence);
    this.assertCurrent();
    return this.withPendingPlan(view.material);
  }
  async prepareGeneration(
    draft: Extract<OutputDraft, { kind: "generate" }>,
    input: { context: RenderedContext; outputId: string; signal: AbortSignal },
  ): Promise<PreparedGeneration> {
    this.assertCurrent();
    const target = this.options.targets().find((target) => target.id === draft.targetId);
    if (!target) fail("CONTEXT_SOURCE_INVALID", "回复目标不再受权");
    const view = await this.view("reply", input.signal);
    const context = this.engine.render(
      this.options.spec,
      this.withPendingPlan(view.material),
      this.observations,
      this.targetIds(),
    );
    // Draft instructions were inferred from the decision view; retain their provenance too.
    context.sources = uniqueSources([...context.sources, ...input.context.sources]);
    return {
      model: this.options.runtime.model_name,
      allowEmpty: true,
      inputUnits: view.limit,
      instructions: this.replyInstructions(view.selection.messages, target),
      context,
    };
  }
  /** A score leaf uses the same phase material/observations; only its trusted output protocol differs. */
  async prepareEvaluation(input: {
    signal: AbortSignal;
    target: BotContextTarget | null;
  }): Promise<{
    model: string;
    messages: ChatMessage[];
    sources: SourceRef[];
    inputUnits: number;
  }> {
    input.signal.throwIfAborted();
    this.assertCurrent();
    if (
      input.target &&
      !this.options
        .targets()
        .some(
          (target) => target.id === input.target?.id && target.speakerId === input.target.speakerId,
        )
    )
      fail("CONTEXT_SOURCE_INVALID", "评分目标不再受权");
    const view = await this.view("judgement", input.signal);
    const rendered = this.engine.render(
      this.options.spec,
      this.withPendingPlan(view.material),
      this.observations,
      this.targetIds(),
    );
    const messages = this.evaluationMessages(
      view.material,
      this.observations,
      input.target ?? undefined,
      view.selection.messages,
    );
    const units =
      estimateMessages(messages as Parameters<typeof estimateMessages>[0]) +
      estimateTokens(contextDumps(QQ_JUDGEMENT_RESPONSE_SCHEMA));
    if (units > view.limit)
      fail("CONTEXT_BUDGET_EXCEEDED", "评分上下文及结构化输出协议超过模型容量");
    this.assertSources(rendered.sources);
    input.signal.throwIfAborted();
    return {
      model: this.options.spec.model ?? this.options.runtime.model_name,
      messages,
      sources: rendered.sources,
      inputUnits: view.limit,
    };
  }
  private evaluationMessages(
    material: ContextMaterial,
    observations: readonly ActionObservation[],
    target?: BotContextTarget,
    timeline: readonly QqContextMessage[] = [],
  ): ChatMessage[] {
    const prompt = this.prompt(timeline, target);
    const systems = qqPromptMessages(
      buildQqPrompt({ ...prompt, tier: "judgement", prompts: schemePrompts(this.options.scheme) }),
    ).filter((message) => message.role === "system");
    const rendered = this.engine.render(
      this.options.spec,
      this.withPendingPlan(material),
      observations,
      this.targetIds(),
    );
    return [
      ...systems,
      ...rendered.messages.slice(1).map((message) => ({
        role: message.role,
        content: message.content
          .map((part) => {
            if (part.kind !== "text")
              throw new Error("Bot scoring expects source descriptions, not image bytes");
            return part.text;
          })
          .join(""),
      })),
    ];
  }
  assertCurrent(): void {
    const o = this.options;
    o.assertCurrent();
    for (const view of this.views.values()) view.memoryCheck?.();
    this.assertSources(this.sources, false);
  }
  private assertSources(sources: readonly SourceRef[], hostCheck = true): void {
    const o = this.options;
    if (hostCheck) o.assertCurrent();
    const resolved = new Map(
      sources.map((source) => [source, o.resolveSource?.(source, this.owner, this.now())]),
    );
    const refs = sources.filter(
      (source) => source.kind === "memory" && resolved.get(source) === undefined,
    );
    const memory = new Map(
      (refs.length
        ? memoryBodiesByScopeKeys(
            o.orm,
            o.binding.agentId,
            refs.map((ref) => ref.id),
            qqMemoryScopeKeyset(o.snapshot.access).read,
          )
        : []
      ).map((item) => [item.id, item.revision]),
    );
    for (const source of sources) {
      if (
        source.kind === "memory" &&
        resolved.get(source) === undefined &&
        memory.get(source.id) !== source.revision
      )
        fail("CONTEXT_SOURCE_INVALID", "已选记忆正文或作用域发生变化");
      if (
        (resolved.get(source) ??
          sourceAccess(o.db, source, this.owner, { userId: DEFAULT_USER_ID }, this.now())) !==
        "available"
      )
        fail("CONTEXT_SOURCE_INVALID", "上下文来源已变更、过期或撤权");
    }
  }
  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private targetIds(): string[] {
    return this.options.targets().map((target) => target.id);
  }
  /** Knowledge uses one context allowance across the initial read and subsequent actions.
   * Render the real envelopes so identifiers, arguments and source metadata count too.
   * Empty action results remain loop facts; their protocol cost is in the overall model limit.
   */
  private knowledgeUnits(material: ContextMaterial, observations = this.observations): number {
    const evidence = material.evidence ?? [];
    const knowledge = observations.filter(
      (observation) =>
        observation.name === "knowledge.query" &&
        Array.isArray(observation.value) &&
        observation.value.length > 0,
    );
    const render = (material: ContextMaterial, observations: readonly ActionObservation[]) =>
      this.engine.render(this.options.spec, material, observations, this.targetIds()).units;
    return render({ evidence }, knowledge) - render({}, []);
  }
  private async available(tier: QqContextTier, signal: AbortSignal): Promise<number> {
    const o = this.options;
    const model = tier === "reply" ? o.runtime.model_name : (o.spec.model ?? o.runtime.model_name);
    let capacity = this.capacities.get(model);
    if (capacity === undefined) {
      const actual = await o.gateway.loadedContextCapacity(model, { signal });
      if (actual === null || !Number.isSafeInteger(actual) || actual < 1)
        fail("CONTEXT_CAPACITY_UNKNOWN", "无法确认会话模型容量");
      capacity = actual;
      this.capacities.set(model, capacity);
    }
    return (
      capacity -
      (tier === "reply"
        ? schemeOutputReserve(o.scheme).reply_output_reserved
        : schemeOutputReserve(o.scheme).judgement_output_reserved)
    );
  }
  private prompt(
    messages: readonly QqContextMessage[],
    target?: BotContextTarget,
    material?: QqPromptMaterial[],
  ): QqPromptInput {
    const o = this.options;
    const labels = qqMemberLabels(
      o.orm,
      {
        accountId: o.binding.accountId,
        conversationKind: o.binding.kind,
        peerId: o.binding.peerId,
      },
      this.now(),
    );
    return {
      tier: "reply",
      path: o.path,
      persona: compileSystemPrompt(o.runtime),
      prompts: {
        ...schemePrompts(o.scheme),
        reply: qqReplyTaskPrompt(schemeReply(o.scheme).split_by_speaker),
      },
      timeline: messages,
      nowSeconds: Math.floor(Date.parse(this.now()) / 1000),
      labels,
      attentionMembers: o.binding.attention.members,
      ...(target !== undefined
        ? {
            replyingTo: {
              speakerId: target.speakerId,
              label: qqSpeakerLabel(target.speakerId, labels),
            },
          }
        : {}),
      ...(material ? { material } : {}),
    };
  }
  private replyInstructions(
    messages: readonly QqContextMessage[],
    target?: BotContextTarget,
  ): string {
    return qqPromptMessages(buildQqPrompt(this.prompt(messages, target)))
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
  }
  private cost(
    tier: QqContextTier,
    material: ContextMaterial,
    observations = this.observations,
    timeline = this.views.get(tier)?.selection.messages ?? [],
  ): number {
    const o = this.options;
    const rendered = this.engine.render(
      o.spec,
      this.withPendingPlan(material),
      observations,
      this.targetIds(),
    );
    const targets = o.targets();
    if (tier === "judgement") {
      const schemaUnits = estimateTokens(contextDumps(QQ_JUDGEMENT_RESPONSE_SCHEMA));
      const evaluations = [undefined, ...targets].map(
        (target) =>
          estimateMessages(
            this.evaluationMessages(material, observations, target, timeline) as Parameters<
              typeof estimateMessages
            >[0],
          ) + schemaUnits,
      );
      return Math.max(tier === o.decisionTier ? rendered.units : 0, ...evaluations);
    }
    const generation = targets.map((target) =>
      inputUnits(
        this.engine.renderOutput(
          {
            ...o.spec,
            generation: {
              ...o.spec.generation,
              instructions: this.replyInstructions(timeline, target),
            },
          },
          rendered,
          { kind: "generate", targetId: target.id, instructions: "" },
        ),
      ),
    );
    return Math.max(tier === o.decisionTier ? rendered.units : 0, ...generation, 0);
  }
  private async view(tier: QqContextTier, signal: AbortSignal): Promise<View> {
    const saved = this.views.get(tier);
    if (saved) {
      this.assertCurrent();
      return saved;
    }
    const o = this.options;
    signal.throwIfAborted();
    const limits = qqContextLimits(schemeContext(o.scheme), tier);
    const nowSeconds = Math.floor(Date.parse(this.now()) / 1000);
    const sinceSeconds = Math.max(0, nowSeconds - limits.windowMinutes * 60 - 1);
    const scope = {
      kind: "qq" as const,
      accountId: o.binding.accountId,
      conversationKind: o.binding.kind,
      peerId: o.binding.peerId,
      agentId: o.binding.agentId,
    };
    const timeline = qqBuildTimeline({
      messages: conversationMessagesSince(o.orm, scope, {
        sinceSeconds,
        limit: limits.messageLimit,
        includeSources: true,
      }).map(({ eventKey: _key, ...message }) => message),
      ownSpeech: [
        ...ownSpeechSince(o.orm, scope, {
          sinceSeconds,
          limit: limits.messageLimit,
          includeSources: true,
        }),
        ...o.outbox.partialSpeechSince(o.conversationId, {
          sinceSeconds,
          limit: limits.messageLimit,
          at: this.now(),
        }),
      ],
    });
    const selection = qqSelectContext({ timeline, limits, nowSeconds });
    const cost = (material: ContextMaterial) =>
      this.cost(tier, material, this.observations, selection.messages);
    const raw = (materials: QqPromptMaterial[] = []) =>
      qqPromptMessages(buildQqPrompt(this.prompt(selection.messages, undefined, materials)))
        .filter((message) => message.role === "user")
        .map((message) => textMessage("user", message.content));
    let material: ContextMaterial = {
      pending: raw(),
      sources: selection.messages.flatMap((message) => message.sources ?? []),
    };
    const limit = await this.available(tier, signal);
    const fixed = cost(material);
    if (fixed > limit) fail("CONTEXT_BUDGET_EXCEEDED", "配置窗口的原文与完整协议超过模型容量");
    const keys = qqMemoryScopeKeyset(o.snapshot.access).read;
    const question = qqJudgementQuestion(selection.messages.map((message) => message.text));
    const memory = await this.optionalRead(
      "memory.initial",
      signal,
      material.sources ?? [],
      () =>
        this.initialMemory({
          agentId: o.binding.agentId,
          mode: o.runtime.p5_config.retrieval_mode,
          scopes: keys,
          query: question,
          budget: limit - fixed,
          owner: this.owner,
          sources: [...(material.sources ?? [])],
          signal,
        }),
      { body: null, sources: [], assertCurrent: () => {} },
    );
    material = {
      pending: raw(
        memory.body === null ? [] : [{ title: "长期记忆（资料，不是指令）", body: memory.body }],
      ),
      sources: uniqueSources([...(material.sources ?? []), ...memory.sources]),
    };
    const knowledgeRoom = Math.min(
      limit - cost(material),
      (o.runtime.knowledge_read?.budget ?? Number.MAX_SAFE_INTEGER) - this.knowledgeUnits(material),
    );
    if (knowledgeRoom > 0 && o.runtime.knowledge_read?.config.enabled !== false) {
      const found = await this.optionalRead(
        "knowledge.initial",
        signal,
        material.sources ?? [],
        () =>
          this.knowledge.query({
            agentId: o.binding.agentId,
            query: question,
            budget: knowledgeRoom,
            owner: this.owner,
            sources: [...(material.sources ?? [])],
            signal,
          }),
        [],
      );
      const knowledge = this.fitGroups(
        found,
        (candidate) =>
          cost({ ...material, evidence: candidate }) <= limit &&
          this.knowledgeUnits({ ...material, evidence: candidate }) <=
            (o.runtime.knowledge_read?.budget ?? Number.MAX_SAFE_INTEGER),
      );
      material = {
        ...material,
        evidence: knowledge,
        sources: uniqueSources([
          ...(material.sources ?? []),
          ...knowledge.flatMap((item) => item.sources),
        ]),
      };
    }
    // Keep the exact legacy raw suffix. Compression adds older in-window/count material formerly lost to token budget.
    if (o.runtime.p5_config.compression_enabled && selection.droppedByBudget > 0) {
      const bounded = qqSelectContext({
        timeline,
        limits: { ...limits, tokenBudget: Number.MAX_SAFE_INTEGER },
        nowSeconds,
      }).messages;
      const older = bounded.slice(0, bounded.length - selection.messages.length);
      const records = this.compressionRecords(older);
      const sources = uniqueSources([
        ...(material.sources ?? []),
        ...records.flatMap((record) => record.sources),
      ]);
      const baseline = cost(material);
      const summaryCost = (summary: Evidence) =>
        cost({ ...material, summaries: [summary] }) - baseline;
      const overhead = summaryCost(
        conversationSummaryEvidence({
          id: `summary:${"0".repeat(64)}`,
          records,
          sources,
          facts: [],
        }),
      );
      const room = limit - baseline;
      const readBudget =
        o.runtime.p5_config.summary_read_max_tokens ?? o.runtime.p5_config.summary_max_tokens;
      const target = Math.min(
        o.runtime.p5_config.summary_target_tokens,
        readBudget - overhead,
        room - overhead,
      );
      if (target > 0 && older.length) {
        try {
          const summary = await this.compressor.summarize({
            records,
            target,
            question,
            sources: material.sources,
            signal,
            fits: (summary) => summaryCost(summary) <= Math.min(room, readBudget),
          });
          if (summary && cost({ ...material, summaries: [summary] }) <= limit)
            material = {
              ...material,
              summaries: [summary],
              sources: uniqueSources([...(material.sources ?? []), ...summary.sources]),
            };
        } catch (error) {
          signal.throwIfAborted();
          this.assertCurrent();
          this.assertSources(records.flatMap((record) => record.sources));
          const code =
            error instanceof AppError
              ? error.code
              : error instanceof DOMException && error.name === "TimeoutError"
                ? "MODEL_TIMEOUT"
                : error instanceof SyntaxError || error instanceof z.ZodError
                  ? "MODEL_STRUCTURE_INVALID"
                  : "UNEXPECTED_FAILURE";
          const optionalFailure =
            code.startsWith("MODEL_") ||
            [
              "CONTEXT_CAPACITY_UNKNOWN",
              "CONTEXT_CAPACITY_ERROR",
              "CONTEXT_AUX_BUDGET",
              "CONTEXT_SUMMARY_BUDGET",
              "CONTEXT_INVALID_SELECTION",
            ].includes(code);
          if (!optionalFailure) throw error;
          const event = { kind: "supplemental_summary_failed" as const, code };
          if (o.onDiagnostic) o.onDiagnostic(event);
          else console.warn("bot_context", event);
          // This optional addition never removes the valid legacy raw suffix or initial evidence.
        }
      }
    }
    if (cost(material) > limit) fail("CONTEXT_BUDGET_EXCEEDED", "初始资料及协议超过可用容量");
    this.assertSources(material.sources ?? []);
    const view: View = { material, selection, limit, memoryCheck: memory.assertCurrent };
    this.views.set(tier, view);
    this.assertCurrent();
    return view;
  }
  private async optionalRead<T>(
    name: string,
    signal: AbortSignal,
    parents: readonly SourceRef[],
    run: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const outer = this.readSources;
    const sources: SourceRef[] = [];
    this.readSources = sources;
    try {
      const result = await run();
      this.retrievalFailures = this.retrievalFailures.filter((failure) => failure.name !== name);
      return result;
    } catch (error) {
      signal.throwIfAborted();
      this.assertCurrent();
      // Even a failed selector may have observed private candidates: never mask their revocation.
      this.assertSources([...parents, ...sources]);
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof DOMException && error.name === "TimeoutError"
            ? "MODEL_TIMEOUT"
            : error instanceof SyntaxError || error instanceof z.ZodError
              ? "MODEL_STRUCTURE_INVALID"
              : error instanceof Error && /^MODEL_[A-Z_]+$/.test(error.message)
                ? error.message
                : "UNEXPECTED_FAILURE";
      if (
        !code.startsWith("MODEL_") &&
        ![
          "CONTEXT_CAPACITY_UNKNOWN",
          "CONTEXT_CAPACITY_ERROR",
          "CONTEXT_AUX_BUDGET",
          "CONTEXT_INVALID_SELECTION",
        ].includes(code)
      )
        throw error;
      this.retrievalFailures = [
        ...this.retrievalFailures.filter((failure) => failure.name !== name),
        { name, code, observedSeq: this.sequence },
      ];
      const event = { kind: "supplemental_retrieval_failed" as const, name, code };
      if (this.options.onDiagnostic) this.options.onDiagnostic(event);
      else console.warn("bot_context", event);
      return fallback;
    } finally {
      outer?.push(...sources);
      this.readSources = outer;
    }
  }
  private compressionRecords(messages: readonly QqContextMessage[]): CompressionRecord[] {
    return messages.map((message, index) => {
      const sources = message.sources ?? [];
      const rows = sources.flatMap(
        (source) =>
          this.options.db
            .query(
              "SELECT e.seq FROM conversation_events e,json_each(e.sources) s WHERE e.conversation_id=? AND json_extract(s.value,'$.kind')=? AND json_extract(s.value,'$.id')=? AND json_extract(s.value,'$.revision')=?",
            )
            .all(this.options.conversationId, source.kind, source.id, source.revision) as {
            seq: number;
          }[],
      );
      return {
        id: sources.length
          ? contextDumps(sources.map((source) => [source.kind, source.id, source.revision]))
          : `anonymous:${message.occurredAtSeconds}:${index}`,
        seq: rows.length ? Math.min(...rows.map((row) => row.seq)) : null,
        speaker: message.speakerId ?? message.speaker,
        text: contextDumps({
          text: message.text,
          mediaNotes: message.mediaNotes,
          mediaUnread: message.mediaUnread,
        }),
        sources,
      };
    });
  }
  private fitGroups(
    found: readonly Evidence[],
    fits: (candidate: Evidence[]) => boolean,
    limit?: number,
  ): Evidence[] {
    const groups = new Map<string, Evidence[]>();
    for (const item of found) {
      // The current SQLite knowledge backend emits original/derived pairs for the same offset.
      // Keep that pair intact without requiring every selected chunk of a document to fit together.
      const key = item.sources.some((source) => source.kind === "knowledge_document")
        ? item.id.replace(/:(?:original|derived):/, ":")
        : item.id;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    let kept: Evidence[] = [];
    for (const group of groups.values()) {
      if (limit !== undefined && kept.length + group.length > limit) continue;
      if (fits([...kept, ...group])) kept = [...kept, ...group];
    }
    return kept;
  }
  private async query(
    name: "memory.query" | "knowledge.query",
    input: { query: string; limit?: number },
    signal: AbortSignal,
  ): Promise<readonly Evidence[]> {
    this.assertCurrent();
    const deciding = await this.view(this.options.decisionTier, signal);
    await this.view("reply", signal);
    const empty: ActionObservation = {
      id: "00000000-0000-0000-0000-000000000000",
      name,
      arguments: input,
      value: [],
      sources: [],
    };
    // Runtime adds the deciding context's sources to every action result. Reserve that
    // exact union here rather than fitting the smaller backend-only source list.
    const parentSources = this.engine.render(
      this.options.spec,
      this.withPendingPlan(deciding.material),
      this.observations,
      this.targetIds(),
    ).sources;
    const observation = (items: readonly Evidence[]): ActionObservation => ({
      ...empty,
      value: items,
      sources: uniqueSources([...parentSources, ...items.flatMap((item) => item.sources)]),
    });
    const cost = (view: View, tier: QqContextTier, items: readonly Evidence[]) =>
      this.cost(tier, view.material, [...this.observations, observation(items)]);
    const budget = Math.min(
      ...[...this.views].map(([tier, view]) => view.limit - cost(view, tier, [])),
    );
    if (budget < 1) fail("CONTEXT_BUDGET_EXCEEDED", "没有可用空间读取补充资料");
    const o = this.options;
    const common = {
      agentId: o.binding.agentId,
      query: input.query,
      budget:
        name === "knowledge.query"
          ? Math.min(
              budget,
              ...[...this.views.values()].map(
                (view) =>
                  (o.runtime.knowledge_read?.budget ?? Number.MAX_SAFE_INTEGER) -
                  this.knowledgeUnits(view.material),
              ),
            )
          : budget,
      owner: this.owner,
      sources: this.sources,
      signal,
    };
    if (common.budget < 1) return [];
    const result = await this.optionalRead(
      name,
      signal,
      this.sources,
      async () =>
        name === "memory.query"
          ? await this.memory.query({
              ...common,
              mode: o.runtime.p5_config.retrieval_mode,
              scopes: qqMemoryScopeKeyset(o.snapshot.access).read,
            })
          : await this.knowledge.query(common),
      [],
    );
    this.assertCurrent();
    this.assertSources(result.flatMap((item) => item.sources));
    const fits = (items: Evidence[]) =>
      [...this.views].every(
        ([tier, view]) =>
          cost(view, tier, items) <= view.limit &&
          (name !== "knowledge.query" ||
            this.knowledgeUnits(view.material, [...this.observations, observation(items)]) <=
              (o.runtime.knowledge_read?.budget ?? Number.MAX_SAFE_INTEGER)),
      );
    if (
      name === "memory.query" &&
      ["full_catalog", "full_body"].includes(o.runtime.p5_config.retrieval_mode)
    ) {
      if (!fits([...result])) fail("CONTEXT_BUDGET_EXCEEDED", "完整记忆及观察封套超过剩余容量");
      return result;
    }
    return this.fitGroups(result, fits, input.limit);
  }
}
