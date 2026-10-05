export interface ActionDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  capability: string;
  /**
   * 有没有副作用。**默认 `write`（保守）**：没声明的一律串行执行，只有明确声明 `read` 的动作
   * 才允许同批并行——一个动作"看起来只读"不是理由。
   */
  effect?: "read" | "write";
}
export interface LeafAgentSpec {
  id: string;
  version?: string;
  instructions?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  /** Existing task-specific budgets; omitted means the gateway's existing limit applies. */
  limits?: { inputUnits?: number; deadlineMs?: number };
}
export interface AgentGenerationConfig {
  /** Channel reply instructions may differ from decision/review instructions. */
  instructions?: string;
  /** Some channels may complete an empty body with a non-text output, e.g. a sticker. */
  allowEmpty?: boolean;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  inputUnits?: number;
}

export interface AgentSpec extends LeafAgentSpec {
  context: "conversation";
  availableActions: readonly ActionDescription[];
  /** Different routes may decide and write; hosts can specialize each output. */
  generation?: AgentGenerationConfig;
  limits: { inputUnits?: number; outputTokens?: number; steps: number; deadlineMs?: number };
}
