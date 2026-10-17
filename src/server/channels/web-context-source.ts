import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../../shared/contracts";
import { AGENT_DECISION_JSON_SCHEMA } from "../../shared/contracts/agent-output";
import type { ModelMessage, RunOwner } from "../../shared/contracts/agent-run";
import {
  type AuxiliaryAllocationProfile,
  contextAllocationMode,
} from "../../shared/contracts/context-allocation";
import type { ContextUsage } from "../../shared/contracts/context-usage";
import type { Evidence, SourceRef } from "../../shared/contracts/evidence";
import type { AgentRuntime } from "../agent/agent-runtime";
import type { AgentSpec } from "../agent/agent-specs";
import {
  type BuiltInAction,
  createBuiltInActions,
  evidenceCatalogEntry,
} from "../agent/built-in-actions";
import { assertContextSources } from "../agent/context-access";
import {
  type ActionObservation,
  ContextEngine,
  type ContextMaterial,
  type ConversationContextSource,
  inputUnits,
  measureContextTokens,
  type RenderedContext,
  textMessage,
} from "../agent/context-engine";
import type { ContextBuilder } from "../agent/conversation-context";
import type { ModelContextBudget } from "../agent/model-port";
import { ReservationLedger } from "../agent/reservation-ledger";
import {
  type ContextMessage,
  currentUser,
  readMemoryCandidate,
  systemPrompt,
} from "../db/context-repository";
import { KnowledgeRepository } from "../db/knowledge-repository";
import { DEFAULT_USER_ID, type Orm } from "../db/repositories";
import type { ModelGateway } from "../llm/model-gateway";
import {
  createSqliteQueryFactory,
  type ModuleQueryFactory,
  type ModuleSourceResolver,
} from "../modules/composition";
import {
  type EvidenceQueryPage,
  type EvidenceQueryResponse,
  evidenceQueryPage,
} from "../modules/contracts";
import {
  conversationEvidenceSourceAccess,
  createWebConversationEvidence,
} from "../modules/conversation-evidence";
import { turnSources } from "../modules/provenance";

export class WebContextSource implements ConversationContextSource {
  readonly spec: AgentSpec;
  readonly actions: BuiltInAction[];
  private material?: ContextMaterial;
  private observations: readonly ActionObservation[] = [];
  /** 同批在飞动作各自的投影增量（token→相对基线 U(observations) 的 units）。 */
  private readonly reservations = new ReservationLedger();

  private usage?: ContextUsage;
  /** Main-route descriptor for this turn, prepared once and reused; nothing global. */
  private preparedMain?: ModelContextBudget;
  private readonly engine = new ContextEngine();
  private readonly owner: RunOwner;
  constructor(
    private readonly options: {
      db: Database;
      orm: Orm;
      gateway: ModelGateway;
      agentRuntime: AgentRuntime;
      modules?: ModuleQueryFactory;
      resolveSource?: ModuleSourceResolver;
      /** 外部（MCP）动作：这一轮开始时取一次；没有登记时为空。 */
      extraActions?: readonly BuiltInAction[];
      builder: ContextBuilder;
      runtime: RuntimeConfig;
      sessionId: string;
      turnId: string;
      generationToken: string;
      maxSteps: number;
    },
  ) {
    const { runtime } = options;
    this.owner = {
      kind: "web_turn",
      id: options.turnId,
      userId: DEFAULT_USER_ID,
      agentId: runtime.agent_id,
    };
    const { memory, knowledge } = (options.modules ?? createSqliteQueryFactory(options))({
      runtime,
      assertSources: (sources) => this.assertSources(sources),
    });
    // 已存历史与摘要是显式查询的有界只读工具：不预取、不触发压缩，模块本身不随记忆检索开关关闭。
    const evidence = createWebConversationEvidence({
      db: options.db,
      orm: options.orm,
      agentId: runtime.agent_id,
      sessionId: options.sessionId,
      currentTurnId: options.turnId,
      retrievalEnabled: runtime.p5_config.retrieval_mode !== "off",
      assertCurrent: () => this.assertCurrent(),
      assertSources: (sources) => this.assertSources(sources),
    });
    const readMemory = memory.read?.bind(memory);
    const readKnowledge = knowledge.read?.bind(knowledge);
    const mode = runtime.p5_config.retrieval_mode;
    const preset =
      mode === "conservative" || mode === "standard" || mode === "broad" ? mode : "broad";
    this.actions = createBuiltInActions(
      {
        ...(runtime.p5_config.retrieval_mode !== "off"
          ? {
              memory: {
                query: async (
                  input: { query: string; limit?: number; cursor?: string },
                  context: { signal: AbortSignal },
                ) =>
                  this.query("memory.query", input, (budget) =>
                    memory.query({
                      agentId: runtime.agent_id,
                      sessionId: options.sessionId,
                      mode: runtime.p5_config.retrieval_mode,
                      scopes: null,
                      ...input,
                      projection: "catalog",
                      budget,
                      owner: this.owner,
                      signal: context.signal,
                      sources: this.sources(),
                    }),
                  ),
                ...(readMemory
                  ? {
                      read: (
                        input: { evidence: Evidence; offset: number; limit: number },
                        context: { signal: AbortSignal },
                      ) => {
                        this.assertCurrent();
                        return readMemory({
                          ...input,
                          agentId: runtime.agent_id,
                          sessionId: options.sessionId,
                          scopes: null,
                          owner: this.owner,
                          signal: context.signal,
                          sources: this.sources(),
                        });
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(runtime.knowledge_read?.config.enabled !== false
          ? {
              knowledge: {
                query: async (
                  input: { query: string; limit?: number; cursor?: string },
                  context: { signal: AbortSignal },
                ) =>
                  this.query("knowledge.query", input, (budget) =>
                    knowledge.query({
                      agentId: runtime.agent_id,
                      ...input,
                      projection: "catalog",
                      budget,
                      owner: this.owner,
                      signal: context.signal,
                      sources: this.sources(),
                    }),
                  ),
                ...(readKnowledge
                  ? {
                      read: (
                        input: { evidence: Evidence; offset: number; limit: number },
                        context: { signal: AbortSignal },
                      ) => {
                        this.assertCurrent();
                        return readKnowledge({
                          ...input,
                          agentId: runtime.agent_id,
                          owner: this.owner,
                          signal: context.signal,
                          sources: this.sources(),
                        });
                      },
                    }
                  : {}),
              },
            }
          : {}),
        history: evidence.history,
        summary: evidence.summary,
      },
      {
        assertSources: (sources) => {
          this.assertCurrent();
          this.assertSources(sources);
        },
        fit: async (name, arguments_, signal) => {
          signal.throwIfAborted();
          // 同批只读工具并发跑，每个的 fit 只看到"上一轮已提交的 observations"；
          // 保守联合预留：把本批其它在飞结果的增量也算进来，宁可少装，不许下一步渲染炸轮。
          const token = Symbol("action-result-fit");
          // Auto 模式的同步提案边界：builder 持有本轮冻结的历史候选，返回
          // 纯提案 {messages, sources, commit()}；是否提交由本闭包在全部
          // 门槛（整请求 fit、联合预留、领域配额）通过后决定。
          const reselect =
            contextAllocationMode(runtime.p5_config.allocation) === "auto"
              ? this.options.builder.reselectFor(options.turnId, runtime.agent_id)
              : undefined;
          // Legacy ceiling in byte units; token mode uses the same field as a token
          // ceiling, so one limit serves both and neither mixes the two units.
          const limit =
            this.spec.limits.inputUnits ??
            runtime.p5_config.context_window ??
            Number.MAX_SAFE_INTEGER;
          return (value, sources) => {
            // 检查与登记必须在同一同步块内完成，才能消除并发竞态（JS 单线程）。
            // 提案不落任何状态：material / 预留 / builder 校验点只在全部门槛
            // （整请求 fit、同批联合预留、领域配额）通过后一次提交。
            const observations = [
              ...this.observations,
              {
                id: "00000000-0000-0000-0000-000000000000",
                name,
                arguments: arguments_,
                value,
                sources,
              },
            ];
            const renderWith = (material: ContextMaterial): RenderedContext =>
              this.engine.render(this.spec, material, observations, ["reply"], "stream");
            const renderBase = (material: ContextMaterial): RenderedContext =>
              this.engine.render(this.spec, material, this.observations, ["reply"], "stream");
            const fits = (rendered: RenderedContext): boolean =>
              this.tokenCounter() !== undefined
                ? this.fitsDecision(rendered.messages, token)
                : rendered.units + this.reservations.reserved(token) <= limit;
            const currentMaterial = () => this.material ?? {};
            // Domain quota first: it is independent of the history selection, so a
            // quota rejection never starts (or commits) a reclaim proposal.
            if (name.startsWith("knowledge.")) {
              const nonempty = observations.filter((observation) => {
                const result = observation.value as { items?: unknown[] } | null;
                return (
                  observation.name.startsWith("knowledge.") &&
                  Array.isArray(result?.items) &&
                  result.items.length > 0
                );
              });
              const actionUnits =
                this.engine.render(this.spec, {}, nonempty, ["reply"], "stream").units -
                this.engine.render(this.spec, {}, [], ["reply"], "stream").units;
              if (
                (this.usage?.components.knowledge ?? 0) + actionUnits >
                (runtime.knowledge_read?.budget ?? Number.MAX_SAFE_INTEGER)
              )
                return false;
            }
            const directRender = renderWith(currentMaterial());
            const directBase = renderBase(currentMaterial());
            let admitted = directRender;
            if (!fits(directRender) && reselect !== undefined) {
              // Auto only: propose reclaiming still-selectable history pairs,
              // oldest first. Each proposal is verified against the WHOLE rebuilt
              // request before any commit; a proposal that still does not fit
              // leaves material and reservations untouched and the result is
              // rejected like the fixed path.
              for (let drop = 1; ; drop += 1) {
                const proposal = reselect(({ historyTurnIds, summaryIds }) => {
                  if (drop <= historyTurnIds.length) {
                    return { historyTurnIds: historyTurnIds.slice(drop), summaryIds };
                  }
                  const summaryDrop = drop - historyTurnIds.length;
                  return summaryDrop > summaryIds.length
                    ? null
                    : { historyTurnIds: [], summaryIds: summaryIds.slice(summaryDrop) };
                });
                if (proposal === null) return false;
                const nonSystem = proposal.messages.filter((m) => m.role !== "system");
                const asChannel = (m: (typeof nonSystem)[number]) =>
                  textMessage(m.role === "assistant" ? "assistant" : "user", m.content);
                const proposalMaterial: ContextMaterial = {
                  ...currentMaterial(),
                  sources: proposal.sources,
                  history: nonSystem.slice(0, -1).map(asChannel),
                  pending: nonSystem.slice(-1).map(asChannel),
                };
                const proposed = renderWith(proposalMaterial);
                if (fits(proposed)) {
                  signal.throwIfAborted();
                  this.assertCurrent();
                  this.assertSources([
                    ...proposal.sources,
                    ...observations.flatMap((item) => item.sources),
                  ]);
                  proposal.commit();
                  this.material = proposalMaterial;
                  admitted = proposed;
                  break;
                }
                // This reclaim did not create room — try the next oldest pair.
              }
            } else if (!fits(directRender)) {
              return false;
            }
            // 通过则覆盖自己的预留（fitter 记住上次通过的值）；失败不改预留。
            // 预留基线与已提交 material 同源：回收后按回收后的基线计量增量。
            const baseRender =
              admitted === directRender ? directBase : renderBase(currentMaterial());
            this.reservations.set(
              token,
              this.tokenCounter() === undefined
                ? admitted.units - baseRender.units
                : Math.max(
                    0,
                    this.tokensOf(admitted.messages) - this.tokensOf(baseRender.messages),
                  ),
            );
            return true;
          };
        },
        budget: (kind) =>
          kind === "memory"
            ? runtime.p5_config.retrieval_presets[preset].max_tokens
            : kind === "knowledge"
              ? (runtime.knowledge_read?.budget ?? Number.MAX_SAFE_INTEGER)
              : Number.MAX_SAFE_INTEGER,
      },
    );
    this.actions = [...this.actions, ...(options.extraActions ?? [])];
    this.spec = {
      id: "conversation.web",
      version: "2",
      context: "conversation",
      instructions: systemPrompt(runtime)
        .map((m) => m.content)
        .join("\n\n"),
      model: runtime.model_name,
      temperature: runtime.temperature,
      maxTokens: runtime.p5_config.max_output_tokens,
      generation: {
        model: runtime.model_name,
        temperature: runtime.temperature,
        maxTokens: runtime.p5_config.max_output_tokens,
      },
      availableActions: this.actions.map((a) => a.description),
      limits: { steps: options.maxSteps },
    };
  }
  configureActions(actions: AgentSpec["availableActions"]): void {
    this.spec.availableActions = actions;
  }

  /** This agent's research auxiliary allocation, absent = keep caller defaults. */
  researchAllocation(): AuxiliaryAllocationProfile | undefined {
    return this.options.runtime.p5_config.auxiliary_allocation?.research;
  }

  /**
   * Prepares this turn's main-route budget descriptor through the gateway's own hook
   * and keeps it for the turn. Optional capability: a gateway without the hook, a
   * turn cancelled before it ran, or a declared capacity of null all leave the
   * source on the legacy byte unit. Repeated calls return the same descriptor, so the
   * Runtime bridge hook and this method share one preparation instead of two.
   */
  async prepareModelContext(
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelContextBudget | undefined> {
    if (this.options.runtime.resolved_model_contexts === undefined) return undefined;
    if (model !== this.options.runtime.model_name) {
      throw new Error("Web context budget belongs to a different requested model");
    }
    signal?.throwIfAborted();
    if (this.preparedMain !== undefined) {
      this.preparedMain.assertCurrent();
      return this.preparedMain;
    }
    const prepare = this.options.gateway.prepareContextModel?.bind(this.options.gateway);
    if (prepare === undefined) return undefined;
    signal?.throwIfAborted();
    const budget = await prepare(model, { signal });
    signal?.throwIfAborted();
    budget.assertCurrent();
    // Only a usable descriptor (counter + declared encoding) switches the unit.
    this.preparedMain = budget;
    return budget;
  }

  /** The main descriptor in the descriptor's own unit; undefined = legacy bytes. */
  private tokenCounter():
    | {
        budget: ModelContextBudget;
        counter: {
          encoding: NonNullable<ModelContextBudget["tokenizerEncoding"]>;
          count: (text: string) => number;
        };
      }
    | undefined {
    const budget = this.preparedMain;
    const countText = budget?.countText;
    const encoding = budget?.tokenizerEncoding;
    if (budget === undefined || countText === undefined || encoding === undefined) {
      return undefined;
    }
    return { budget, counter: { encoding, count: countText } };
  }

  /**
   * The decision request this turn will really send, built around the builder's
   * candidate: the protocol system text, advertised actions and declared schema
   * come from the engine render; the builder's own instruction system message is
   * already inside that protocol text, so it is not counted twice.
   */
  private decisionRequest(candidate: readonly ContextMessage[]): ModelMessage[] {
    const rest = candidate.filter((message) => message.role !== "system");
    const pending = rest.at(-1);
    const asModel = (message: ContextMessage): ModelMessage =>
      textMessage(message.role as ModelMessage["role"], message.content);
    return this.engine.render(
      this.spec,
      {
        history: rest.slice(0, -1).map(asModel),
        ...(pending === undefined ? {} : { pending: [asModel(pending)] }),
      },
      this.observations,
      ["reply"],
      "stream",
    ).messages;
  }

  /**
   * Prices one whole rendered decision request in token units — including the
   * actually advertised actions and the declared decision schema — and subtracts
   * this batch's in-flight token reservations. Only the descriptor's own counter
   * runs: no index, no cache, no provider call per fit.
   */
  private fitsDecision(
    messages: readonly ModelMessage[],
    except?: symbol,
    explicitLimit?: number,
  ): boolean {
    const counter = this.tokenCounter();
    if (counter === undefined) return true;
    const limit = explicitLimit ?? this.spec.limits.inputUnits;
    if (limit === undefined) return true;
    const measured = measureContextTokens(messages, counter.counter, {
      responseSchema: AGENT_DECISION_JSON_SCHEMA,
      tools: this.spec.availableActions,
    });
    counter.budget.assertCurrent();
    return measured.textTokens + this.reservations.reserved(except) <= limit;
  }

  /** Delta of one rendered request in the descriptor's unit; 0 outside token mode. */
  private tokensOf(messages: readonly ModelMessage[]): number {
    const counter = this.tokenCounter();
    if (counter === undefined) return 0;
    return measureContextTokens(messages, counter.counter, {
      responseSchema: AGENT_DECISION_JSON_SCHEMA,
      tools: this.spec.availableActions,
    }).textTokens;
  }
  async read(input: {
    signal: AbortSignal;
    observations: readonly ActionObservation[];
  }): Promise<ContextMaterial> {
    this.observations = input.observations;
    // observations 被替换＝上一批的投影已并入基线，旧预留不再代表"在飞结果"。
    this.reservations.clear();
    input.signal.throwIfAborted();
    const o = this.options;
    if (!this.material) {
      // Reserve the actual decision protocol before the legacy compression policy allocates history.
      const legacySystem = systemPrompt(o.runtime).map((m) => textMessage(m.role, m.content));
      const reserve =
        this.engine.render(this.spec, {}, [], ["reply"], "stream").units - inputUnits(legacySystem);
      // One preparation per turn on the real main route; the Runtime bridge hook may
      // have done it already, and absence leaves the legacy byte unit untouched.
      if (this.preparedMain === undefined) {
        await this.prepareModelContext(o.runtime.model_name, input.signal);
      }
      let sources: SourceRef[] = [];
      const messages = await o.builder.build({
        sessionId: o.sessionId,
        currentTurnId: o.turnId,
        runtime: o.runtime,
        generationToken: o.generationToken,
        signal: input.signal,
        reservedInputUnits: reserve,
        ...(this.preparedMain === undefined ? {} : { preparedMain: this.preparedMain }),
        buildFits: (candidate) =>
          this.fitsDecision(
            this.decisionRequest(candidate),
            undefined,
            this.preparedMain?.capacity === null || this.preparedMain?.capacity === undefined
              ? undefined
              : (o.runtime.p5_config.context_window ?? this.preparedMain.capacity) -
                  o.runtime.p5_config.max_output_tokens -
                  Math.ceil(
                    (o.runtime.p5_config.context_window ?? this.preparedMain.capacity) *
                      o.runtime.p5_config.safety_margin_ratio,
                  ),
          ),
        onUsage: (usage) => {
          this.usage = usage;
        },
        onSources: (value) => {
          sources = value;
        },
      });
      const data = messages
        .filter((m) => m.role !== "system")
        .map((m) => textMessage(m.role === "assistant" ? "assistant" : "user", m.content));
      this.material = {
        history: data.slice(0, -1),
        pending: data.slice(-1),
        sources: sources.length ? sources : turnSources(o.orm, [o.turnId]),
      };
      if (this.usage) {
        // Token mode takes the measured token ceiling; legacy mode keeps the byte one.
        const limit =
          this.usage.model_tokens?.input_limit ??
          this.usage.capacity - this.usage.output_reserved - this.usage.safety_reserved;
        this.spec.limits.inputUnits = limit;
        this.spec.generation = { ...this.spec.generation, inputUnits: limit };
      }
    }
    this.assertCurrent();
    return this.material;
  }
  assertCurrent(): void {
    const o = this.options;
    currentUser(o.orm, o.runtime.agent_id, o.sessionId, o.turnId, {
      generationToken: o.generationToken,
    });
    o.builder.assertCurrent(o.turnId, o.runtime.agent_id);
    this.assertSources(this.sources());
  }
  private sources(): SourceRef[] {
    return [
      ...(this.material?.sources ?? []),
      ...this.observations.flatMap((observation) => observation.sources),
    ];
  }
  assertSources(sources: readonly SourceRef[]): void {
    const o = this.options;
    currentUser(o.orm, o.runtime.agent_id, o.sessionId, o.turnId, {
      generationToken: o.generationToken,
    });
    assertContextSources({
      db: o.db,
      sources,
      owner: this.owner,
      now: new Date().toISOString(),
      // 会话证据先本地复验（持久存储），外部注入解析器不能把已撤权的引用改判为 available。
      resolveSource: (source, owner, at) =>
        conversationEvidenceSourceAccess(o, source, owner, at) ??
        o.resolveSource?.(source, owner, at),
      memoryRevisions: (ids) =>
        new Map(
          [...new Set(ids)].map((id) => {
            const item = readMemoryCandidate(o.orm, o.runtime.agent_id, null, id, o.sessionId);
            return [item.id, item.revision];
          }),
        ),
      skip: (source) => source.kind === "web_turn" && source.id === o.turnId,
      messages: {
        memory: "已选记忆正文或来源发生变化",
        other: "上下文来源已删除或授权已撤销",
      },
    });
  }
  contextUsage(context: RenderedContext): ContextUsage | undefined {
    if (!this.usage) return undefined;
    const usage = this.usage;
    const input_limit = usage.capacity - usage.output_reserved - usage.safety_reserved;
    const observationBase = this.engine.render(this.spec, {}, [], [], "stream").units;
    let memoryUnits = 0,
      knowledgeUnits = 0;
    for (const observation of this.observations) {
      const units =
        this.engine.render(this.spec, {}, [observation], [], "stream").units - observationBase;
      if (observation.name === "memory.query" || observation.name === "memory.read")
        memoryUnits += units;
      else if (observation.name === "knowledge.query" || observation.name === "knowledge.read")
        knowledgeUnits += units;
    }
    const protocol =
      context.units -
      (usage.input_units - usage.components.protocol) -
      memoryUnits -
      knowledgeUnits;
    // Token mode recomputes the reported token usage from this render, keeping the
    // in-flight reservations in the same unit; legacy fields stay byte-domain.
    const requestTokens =
      context.tokenMeasure?.textTokens ??
      (this.tokenCounter() === undefined ? undefined : this.tokensOf(context.messages));
    return {
      ...usage,
      input_units: context.units,
      input_limit,
      remaining: Math.max(0, input_limit - context.units),
      ...(usage.model_tokens === undefined || requestTokens === undefined
        ? {}
        : {
            model_tokens: {
              ...usage.model_tokens,
              input_tokens: requestTokens,
              media_state: context.tokenMeasure?.mediaState ?? usage.model_tokens.media_state,
            },
          }),
      // T14 观测接线：本层是唯一同时持有真实渲染上下文的组装点，把 engine 已算出的
      // visionCost 逐字透传（§11：unknown 不是 0，pixels 是准备元数据不是 token）。
      vision_cost: context.visionCost,
      components: {
        ...usage.components,
        long_term_memory: usage.components.long_term_memory + memoryUnits,
        knowledge: usage.components.knowledge + knowledgeUnits,
        protocol: Math.max(0, protocol),
      },
    };
  }
  private async query(
    name: string,
    input: { query: string; limit?: number; cursor?: string },
    read: (budget: number) => Promise<EvidenceQueryResponse>,
  ): Promise<EvidenceQueryPage> {
    this.assertCurrent();
    const material = this.material as ContextMaterial;
    const empty: ActionObservation = {
      id: "00000000-0000-0000-0000-000000000000",
      name,
      arguments: input,
      value: [],
      sources: [],
    };
    const limit =
      this.spec.limits.inputUnits ??
      this.options.runtime.p5_config.context_window ??
      Number.MAX_SAFE_INTEGER;
    const cost = (items: readonly Evidence[]) =>
      this.engine.render(
        this.spec,
        material,
        [
          ...this.observations,
          {
            ...empty,
            value: {
              status: "ok",
              items: items.map((item) => evidenceCatalogEntry(name.split(".")[0], item)),
            },
            sources: items.flatMap((i) => i.sources),
          },
        ],
        ["reply"],
        "stream",
      ).units;
    // Retrieval keeps its own byte quota: it is a module budget, not token room.
    // In token mode it stays an upper bound and the per-result fit stays the real
    // token admission, so a byte room is never priced as tokens.
    const budget =
      this.tokenCounter() === undefined
        ? limit - cost([]) - this.reservations.reserved()
        : name.startsWith("knowledge.")
          ? (this.options.runtime.knowledge_read?.budget ??
            new KnowledgeRepository(this.options.db).settings().context_budget)
          : this.options.runtime.p5_config.retrieval_presets[
              ["conservative", "standard", "broad"].includes(
                this.options.runtime.p5_config.retrieval_mode,
              )
                ? (this.options.runtime.p5_config.retrieval_mode as
                    | "conservative"
                    | "standard"
                    | "broad")
                : "broad"
            ].max_tokens;
    if (budget < 1) return { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED", items: [] };
    const result = evidenceQueryPage(await read(budget));
    this.assertCurrent();
    // Byte upper bound is not a token admission: recheck the real request.
    if (
      this.tokenCounter() !== undefined &&
      !this.fitsDecision(
        this.engine.render(
          this.spec,
          material,
          [
            ...this.observations,
            {
              ...empty,
              value: result.items.map((item) => evidenceCatalogEntry(name.split(".")[0], item)),
              sources: result.items.flatMap((item) => item.sources),
            },
          ],
          ["reply"],
          "stream",
        ).messages,
      )
    ) {
      return { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED", items: [] };
    }
    this.assertCurrent();
    return result;
  }
}
