import type { SharedActionDescription } from "../../shared/contracts/agent-action-descriptions";

/** Missing effect defaults to write; only explicit reads may run in parallel. */
export type ActionDescription = SharedActionDescription;
export interface LeafAgentSpec {
  id: string;
  version?: string;
  instructions?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  /** Existing task-specific budgets; omitted means the gateway's existing limit applies. */
  limits?: { inputUnits?: number; inputBytes?: number; deadlineMs?: number };
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
  limits: {
    inputUnits?: number;
    inputBytes?: number;
    outputTokens?: number;
    steps: number;
    deadlineMs?: number;
  };
}
