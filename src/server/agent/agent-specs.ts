import { z } from "zod";

export interface ActionDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  capability: string;
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

const outputBase = { targetId: z.string().min(1) };
export const OutputDraftSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...outputBase,
    kind: z.literal("inline"),
    text: z.string(),
    stickerIds: z.array(z.string()),
  }),
  z.strictObject({ ...outputBase, kind: z.literal("generate"), instructions: z.string() }),
]);
export type OutputDraft = z.infer<typeof OutputDraftSchema>;
export const AgentDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("invoke"),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ kind: z.literal("final"), outputs: z.array(OutputDraftSchema).min(1) }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/** Transport wrappers are not decisions: accept one complete JSON fence, never prose extraction. */
export function parseAgentDecision(raw: string): AgentDecision {
  const text = raw.trim();
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  return AgentDecisionSchema.parse(JSON.parse(fence?.[1] ?? text));
}

export const AGENT_DECISION_JSON_SCHEMA = z.toJSONSchema(AgentDecisionSchema) as Record<
  string,
  unknown
>;

export function leafSpec(id: string, options: Omit<LeafAgentSpec, "id"> = {}): LeafAgentSpec {
  return { id, ...options };
}
