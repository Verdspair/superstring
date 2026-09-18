import type { AgentResponse } from "../../../shared/contracts";
import type { AgentDraft } from "../../state/types";
import { toDraft } from "./draft";

export function buildSectionPayload(
  section: "A" | "B" | "C",
  draft: AgentDraft,
  persisted: AgentResponse,
) {
  const p5Config =
    section === "B"
      ? {
          ...persisted.p5_config,
          retrieval_mode: draft.p5_config.retrieval_mode,
          retrieval_presets: draft.p5_config.retrieval_presets,
        }
      : section === "C"
        ? {
            ...draft.p5_config,
            retrieval_mode: persisted.p5_config.retrieval_mode,
            retrieval_presets: persisted.p5_config.retrieval_presets,
          }
        : undefined;
  const payload =
    section === "A"
      ? {
          name: draft.name,
          description: draft.description,
          additional_instructions: draft.additional_instructions,
          model_name: draft.model_name,
          temperature: draft.temperature,
          is_active: draft.is_active,
          expected_version: draft.config_version,
        }
      : section === "B"
        ? {
            memory_consolidation_model_name: draft.memory_consolidation_model_name,
            memory_consolidation_prompt: draft.memory_consolidation_prompt,
            memory_consolidation_additional_instructions:
              draft.memory_consolidation_additional_instructions,
            memory_retrieval_model_name: draft.memory_retrieval_model_name,
            memory_retrieval_prompt: draft.memory_retrieval_prompt,
            p5_config: p5Config,
            expected_version: draft.config_version,
          }
        : {
            context_compression_model_name: draft.context_compression_model_name,
            p5_config: p5Config,
            expected_version: draft.config_version,
          };
  return payload;
}

export function mergeSavedSection(
  section: "A" | "B" | "C",
  currentDraft: AgentDraft | null,
  saved: AgentResponse,
  creating: boolean,
): AgentDraft {
  const serverDraft = toDraft(saved);
  const editorDraft =
    creating || !currentDraft
      ? serverDraft
      : section === "A"
        ? {
            ...currentDraft,
            name: serverDraft.name,
            description: serverDraft.description,
            additional_instructions: serverDraft.additional_instructions,
            model_name: serverDraft.model_name,
            temperature: serverDraft.temperature,
            is_active: serverDraft.is_active,
            config_version: serverDraft.config_version,
          }
        : section === "B"
          ? {
              ...currentDraft,
              memory_consolidation_model_name: serverDraft.memory_consolidation_model_name,
              memory_consolidation_prompt: serverDraft.memory_consolidation_prompt,
              memory_consolidation_additional_instructions:
                serverDraft.memory_consolidation_additional_instructions,
              memory_retrieval_model_name: serverDraft.memory_retrieval_model_name,
              memory_retrieval_prompt: serverDraft.memory_retrieval_prompt,
              p5_config: {
                ...currentDraft.p5_config,
                retrieval_mode: serverDraft.p5_config.retrieval_mode,
                retrieval_presets: serverDraft.p5_config.retrieval_presets,
              },
              config_version: serverDraft.config_version,
            }
          : {
              ...currentDraft,
              context_compression_model_name: serverDraft.context_compression_model_name,
              p5_config: {
                ...serverDraft.p5_config,
                retrieval_mode: currentDraft.p5_config.retrieval_mode,
                retrieval_presets: currentDraft.p5_config.retrieval_presets,
              },
              config_version: serverDraft.config_version,
            };
  return editorDraft;
}
