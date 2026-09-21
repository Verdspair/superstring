// Runtime snapshot construction, 1:1 with `services/agent_config.py:221-309`.
//
// This is the module that freezes "what the model will see" for a session and
// for each Turn. Three behaviours from the source that must not drift:
//   1. `require_chat` — only `chat` mode is open; anything else is
//      `MODE_NOT_AVAILABLE` 409 (agent_config.py:221-223).
//   2. Organization uses assistant override > shared default > chat model.
//      Retrieval and compression independently fall back to the chat model.
//   3. `runtime_from_agent` must NOT touch the persona relation when no persona
//      is passed — it reuses the already-compiled `system_prompt`
//      (agent_config.py:247-250). In the TS port this is simply "use
//      agent.system_prompt", but the guard is kept as a documented invariant.

import { type RuntimeConfig, RuntimeConfigSchema } from "../../shared/contracts";
import { AppError } from "../errors";
import { type AgentConfigRow, readStoredP5 } from "./agent-config-fields";
import { compilePersona, PERSONA_INTENSITY_DEFAULT, type PersonaSource } from "./persona";
import { pyStrip } from "./text";

/** The subset of an `agents` row that snapshot construction reads. */
export interface AgentRow extends Omit<AgentConfigRow, "description"> {
  id: string;
  personaIntensity: number;
  configVersion: number;
}

/** agent_config.py:221-223 */
export function requireChat(mode: string): void {
  if (mode !== "chat") {
    throw new AppError("MODE_NOT_AVAILABLE", "工作模式尚未开放，请使用聊天模式", 409);
  }
}

/** agent_config.py:226-227 */
export function resolveModel(configured: string | null, conversationModel: string): string {
  return configured || conversationModel;
}

function clampIntensity(value: number): number {
  const truncated = Math.trunc(value);
  return Math.max(0, Math.min(100, truncated));
}

/**
 * agent_config.py:230-280.
 *
 * `p5Config` arrives as the JSON TEXT stored in `agents.p5_config`; it is parsed
 * and validated by `RuntimeConfigSchema` so a corrupt row surfaces as a config
 * error rather than silently producing a wrong snapshot.
 */
export function runtimeFromAgent(
  agent: AgentRow,
  options: {
    mode?: string;
    persona?: PersonaSource | null;
    personaIntensity?: number | null;
    organizationModel?: string | null;
  } = {},
): RuntimeConfig {
  const mode = options.mode ?? "chat";
  requireChat(mode);

  const conversationModel = pyStrip(String(agent.modelName ?? ""));
  const strength = clampIntensity(
    options.personaIntensity === undefined || options.personaIntensity === null
      ? agent.personaIntensity
      : options.personaIntensity,
  );

  const systemPrompt =
    options.persona != null
      ? compilePersona(options.persona, strength)
      : // Never fall back to the persona relation here: reuse the already
        // compiled column (agent_config.py:247-250).
        pyStrip(String(agent.systemPrompt ?? ""));

  const parsedP5 = readStoredP5(agent.p5Config);

  const candidate = {
    agent_id: agent.id,
    name: agent.name,
    system_prompt: systemPrompt,
    additional_instructions: pyStrip(String(agent.additionalInstructions ?? "")),
    model_name: conversationModel,
    temperature: agent.temperature,
    memory_consolidation_model_name: resolveModel(
      agent.memoryConsolidationModelName || options.organizationModel || null,
      conversationModel,
    ),
    memory_consolidation_prompt: agent.memoryConsolidationPrompt,
    memory_consolidation_additional_instructions: pyStrip(
      String(agent.memoryConsolidationAdditionalInstructions ?? ""),
    ),
    memory_retrieval_model_name: resolveModel(agent.memoryRetrievalModelName, conversationModel),
    memory_retrieval_prompt: agent.memoryRetrievalPrompt,
    context_compression_model_name: resolveModel(
      agent.contextCompressionModelName,
      conversationModel,
    ),
    p5_config: parsedP5,
    resolved_model_capacities: {},
    mode,
    config_version: agent.configVersion,
    persona_intensity: strength,
  };

  const parsed = RuntimeConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    // Mirrors the ValueError raised by the Pydantic model, which the callers
    // translate into INVALID_SESSION_CONFIG / INVALID_TURN_CONFIG.
    throw new Error("RuntimeConfig validation failed");
  }
  return parsed.data;
}

/** agent_config.py:287-293 */
export function compileSystemPrompt(runtime: RuntimeConfig): string {
  const sections: string[] = [];
  const persona = runtime.system_prompt.trim();
  if (persona) sections.push(persona);
  const extra = runtime.additional_instructions.trim();
  if (extra) sections.push(`## 基础额外指令\n${extra}`);
  return sections.join("\n\n");
}

export interface HistoryItem {
  role: string;
  content: string;
  status: string;
  context_valid?: boolean;
}

/** agent_config.py:296-309 */
export function buildPrompt(
  runtime: RuntimeConfig,
  history: HistoryItem[],
): Array<{ role: string; content: string }> {
  requireChat(runtime.mode);
  const messages: Array<{ role: string; content: string }> = [];
  const systemPrompt = compileSystemPrompt(runtime);
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  for (const item of history) {
    if (
      item.status === "completed" &&
      (item.context_valid ?? true) &&
      (item.role === "user" || item.role === "assistant" || item.role === "system")
    ) {
      messages.push({ role: item.role, content: item.content });
    }
  }
  return messages;
}

export { PERSONA_INTENSITY_DEFAULT };
