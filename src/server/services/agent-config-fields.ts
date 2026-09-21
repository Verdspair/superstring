import { P5ConfigSchema } from "../../shared/contracts";
import type { agents } from "../db/schema";
import { AppError } from "../errors";

export type AgentConfigRow = Pick<
  typeof agents.$inferSelect,
  | "name"
  | "description"
  | "systemPrompt"
  | "additionalInstructions"
  | "modelName"
  | "temperature"
  | "memoryConsolidationModelName"
  | "memoryConsolidationPrompt"
  | "memoryConsolidationAdditionalInstructions"
  | "memoryRetrievalModelName"
  | "memoryRetrievalPrompt"
  | "contextCompressionModelName"
  | "p5Config"
  | "isActive"
>;

// Validate without normalizing the stored object: old missing fields are still
// filled by the runtime schema, and reading never rewrites stored settings.
export function readStoredP5(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidStoredConfig();
  }
  if (!P5ConfigSchema.safeParse(value).success) throw invalidStoredConfig();
  return value as Record<string, unknown>;
}

function invalidStoredConfig(): AppError {
  return new AppError(
    "INVALID_SESSION_CONFIG",
    "助手上下文与记忆配置无效，请检查迁移或恢复备份",
    409,
  );
}

// Shared configuration fields only. Response metadata and snapshot-only fields
// stay at their own boundaries so this mapping cannot widen a save whitelist.
export function agentConfigFields(row: AgentConfigRow) {
  return {
    name: row.name,
    description: row.description,
    system_prompt: row.systemPrompt,
    additional_instructions: row.additionalInstructions,
    model_name: row.modelName,
    temperature: row.temperature,
    memory_consolidation_model_name: row.memoryConsolidationModelName,
    memory_consolidation_prompt: row.memoryConsolidationPrompt,
    memory_consolidation_additional_instructions: row.memoryConsolidationAdditionalInstructions,
    memory_retrieval_model_name: row.memoryRetrievalModelName,
    memory_retrieval_prompt: row.memoryRetrievalPrompt,
    context_compression_model_name: row.contextCompressionModelName,
    p5_config: readStoredP5(row.p5Config),
    is_active: row.isActive === 1,
  };
}
