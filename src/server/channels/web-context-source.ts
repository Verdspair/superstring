import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../../shared/contracts";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { ContextUsage } from "../../shared/contracts/context-usage";
import type { Evidence, SourceRef } from "../../shared/contracts/evidence";
import type { AgentRuntime } from "../agent/agent-runtime";
import type { AgentSpec } from "../agent/agent-specs";
import { type BuiltInAction, createBuiltInActions } from "../agent/built-in-actions";
import { sourceAccess } from "../agent/context-access";
import {
  type ActionObservation,
  ContextEngine,
  type ContextMaterial,
  type ConversationContextSource,
  inputUnits,
  type RenderedContext,
  textMessage,
} from "../agent/context-engine";
import type { ContextBuilder } from "../agent/conversation-context";
import { currentUser, memoryBodies, systemPrompt } from "../db/context-repository";
import { DEFAULT_USER_ID, getChatContext, type Orm } from "../db/repositories";
import { fail } from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import {
  createSqliteQueryFactory,
  type ModuleQueryFactory,
  type ModuleSourceResolver,
} from "../modules/composition";
import { turnSources } from "../modules/provenance";

/** Web's existing compression and initial evidence policy, reusable by the Agent loop. */
export class WebContextSource implements ConversationContextSource {
  readonly spec: AgentSpec;
  readonly actions: BuiltInAction[];
  private material?: ContextMaterial;
  private observations: readonly ActionObservation[] = [];
  private usage?: ContextUsage;
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
      builder: ContextBuilder | null;
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
    this.actions = createBuiltInActions({
      ...(runtime.p5_config.retrieval_mode !== "off"
        ? {
            memory: {
              query: async (
                input: { query: string; limit?: number },
                context: { signal: AbortSignal },
              ) =>
                this.query("memory.query", input, (budget) =>
                  memory.query({
                    agentId: runtime.agent_id,
                    sessionId: options.sessionId,
                    mode: runtime.p5_config.retrieval_mode,
                    scopes: null,
                    query: input.query,
                    budget,
                    owner: this.owner,
                    signal: context.signal,
                    sources: this.sources(),
                  }),
                ),
            },
          }
        : {}),
      ...(runtime.knowledge_read?.config.enabled !== false
        ? {
            knowledge: {
              query: async (
                input: { query: string; limit?: number },
                context: { signal: AbortSignal },
              ) =>
                this.query("knowledge.query", input, (budget) =>
                  knowledge.query({
                    agentId: runtime.agent_id,
                    query: input.query,
                    budget,
                    owner: this.owner,
                    signal: context.signal,
                    sources: this.sources(),
                  }),
                ),
            },
          }
        : {}),
    });
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
  async read(input: {
    signal: AbortSignal;
    observations: readonly ActionObservation[];
  }): Promise<ContextMaterial> {
    this.observations = input.observations;
    input.signal.throwIfAborted();
    const o = this.options;
    if (!this.material) {
      // Reserve the actual decision protocol before the legacy compression policy allocates history.
      const legacySystem = systemPrompt(o.runtime).map((m) => textMessage(m.role, m.content));
      const reserve =
        this.engine.render(this.spec, {}, [], ["reply"], "stream").units - inputUnits(legacySystem);
      let sources: SourceRef[] = [];
      const messages = o.builder
        ? await o.builder.build({
            sessionId: o.sessionId,
            currentTurnId: o.turnId,
            runtime: o.runtime,
            generationToken: o.generationToken,
            signal: input.signal,
            reservedInputUnits: reserve,
            onUsage: (usage) => {
              this.usage = usage;
            },
            onSources: (value) => {
              sources = value;
            },
          })
        : getChatContext(o.orm, o.sessionId, { currentTurnId: o.turnId, runtime: o.runtime });
      const data = messages
        .filter((m) => m.role !== "system")
        .map((m) => textMessage(m.role === "assistant" ? "assistant" : "user", m.content));
      this.material = {
        history: data.slice(0, -1),
        pending: data.slice(-1),
        sources: sources.length ? sources : turnSources(o.orm, [o.turnId]),
      };
      if (this.usage) {
        const limit = this.usage.capacity - this.usage.output_reserved - this.usage.safety_reserved;
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
    o.builder?.assertKnowledgeAccess(o.turnId, o.runtime.agent_id);
    this.assertSources(this.sources());
  }
  private sources(): SourceRef[] {
    return [
      ...(this.material?.sources ?? []),
      ...this.observations.flatMap((observation) => observation.sources),
    ];
  }
  private assertSources(sources: readonly SourceRef[]): void {
    const o = this.options;
    currentUser(o.orm, o.runtime.agent_id, o.sessionId, o.turnId, {
      generationToken: o.generationToken,
    });
    const at = new Date().toISOString();
    const resolved = new Map(
      sources.map((source) => [source, o.resolveSource?.(source, this.owner, at)]),
    );
    const memoryRefs = sources.filter(
      (source) => source.kind === "memory" && resolved.get(source) === undefined,
    );
    const memory = new Map(
      (memoryRefs.length
        ? memoryBodies(
            o.orm,
            o.runtime.agent_id,
            o.sessionId,
            memoryRefs.map((source) => source.id),
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
        fail("CONTEXT_SOURCE_INVALID", "已选记忆正文或来源发生变化");
      if (source.kind === "web_turn" && source.id === o.turnId) continue;
      if (
        (resolved.get(source) ??
          sourceAccess(o.db, source, this.owner, { userId: DEFAULT_USER_ID }, at)) !== "available"
      )
        fail("CONTEXT_SOURCE_INVALID", "上下文来源已删除或授权已撤销");
    }
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
      if (observation.name === "memory.query") memoryUnits += units;
      else if (observation.name === "knowledge.query") knowledgeUnits += units;
    }
    const protocol =
      context.units -
      (usage.input_units - usage.components.protocol) -
      memoryUnits -
      knowledgeUnits;
    return {
      ...usage,
      input_units: context.units,
      input_limit,
      remaining: Math.max(0, input_limit - context.units),
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
    input: { query: string; limit?: number },
    read: (budget: number) => Promise<readonly Evidence[]>,
  ): Promise<readonly Evidence[]> {
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
          { ...empty, value: items, sources: items.flatMap((i) => i.sources) },
        ],
        ["reply"],
        "stream",
      ).units;
    const budget = limit - cost([]);
    if (budget < 1) fail("CONTEXT_BUDGET_EXCEEDED", "没有可用空间读取补充资料");
    const result = await read(budget);
    this.assertCurrent();
    this.assertSources(result.flatMap((entry) => entry.sources));
    const full =
      name === "memory.query" &&
      ["full_catalog", "full_body"].includes(this.options.runtime.p5_config.retrieval_mode);
    if (full) {
      if (cost(result) > limit) fail("CONTEXT_BUDGET_EXCEEDED", "完整记忆及协议开销超过剩余容量");
      return result;
    }
    const selected: Evidence[] = [];
    for (const entry of result) {
      if (input.limit !== undefined && selected.length >= input.limit) break;
      if (cost([...selected, entry]) <= limit) selected.push(entry);
    }
    return selected;
  }
}
