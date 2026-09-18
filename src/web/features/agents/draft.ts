import type { AgentResponse } from "../../../shared/contracts";
import type { AgentDraft } from "../../state/types";

export const toDraft = (agent: AgentResponse): AgentDraft => ({
  name: agent.name,
  description: agent.description,
  additional_instructions: agent.additional_instructions,
  model_name: agent.model_name,
  temperature: agent.temperature,
  memory_consolidation_model_name: agent.memory_consolidation_model_name,
  memory_consolidation_prompt: agent.memory_consolidation_prompt,
  memory_consolidation_additional_instructions: agent.memory_consolidation_additional_instructions,
  memory_retrieval_model_name: agent.memory_retrieval_model_name,
  memory_retrieval_prompt: agent.memory_retrieval_prompt,
  context_compression_model_name: agent.context_compression_model_name,
  p5_config: agent.p5_config,
  is_active: agent.is_active,
  config_version: agent.config_version,
  persona_intensity: agent.persona_intensity,
});
