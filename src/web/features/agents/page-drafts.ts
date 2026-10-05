import type { AgentResponse, PersonaResponse, PolicyView } from "../../../shared/contracts";
import type { AgentDraft } from "../../state/types";
import { toDraft } from "./draft";

export const EDITABLE_PAGES = [
  "basic",
  "models",
  "identity",
  "expression",
  "long-memory",
  "memory-tools",
  "context",
] as const;
// Explicit ownership: no future p5 field is silently assigned to a page.
export const PAGE_P5_FIELDS = {
  // 目录批次两项只在 full_catalog/full_body 生效（memory-query 的批次循环）；仍随本页白名单保存。
  "memory-tools": [
    "retrieval_mode",
    "retrieval_presets",
    "max_catalog_batches",
    "catalog_batch_size",
  ],
  context: [
    "context_window",
    "max_output_tokens",
    "safety_margin_ratio",
    "compression_enabled",
    "compression_trigger_ratio",
    "recent_turns",
    "summary_target_tokens",
    "summary_max_tokens",
    "summary_read_max_tokens",
    "auxiliary_timeout_seconds",
  ],
} as const;
export const POLICY_FIELDS = ["auto_enabled", "every_turns", "target_chars"] as const;
export function policyDirty(editor: PageEditor): boolean {
  return (
    !!editor.policy &&
    !!editor.policyDraft &&
    POLICY_FIELDS.some((key) => editor.policyDraft?.[key] !== editor.policy?.[key])
  );
}
export function p5Fields(page: EditablePage) {
  return page === "memory-tools" || page === "context" ? PAGE_P5_FIELDS[page] : [];
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export type EditablePage = (typeof EDITABLE_PAGES)[number];
export const PAGE_AGENT_FIELDS = {
  basic: ["name", "description", "is_active"],
  models: [
    "model_name",
    "temperature",
    "memory_consolidation_model_name",
    "context_compression_model_name",
  ],
  identity: ["additional_instructions"],
  expression: ["persona_intensity"],
  "long-memory": ["memory_consolidation_prompt", "memory_consolidation_additional_instructions"],
  "memory-tools": [],
  context: [],
} as const;
export const PAGE_PERSONA_FIELDS = {
  basic: [],
  models: [],
  identity: ["core_identity", "interaction_boundaries", "advanced_instructions"],
  expression: ["communication_style", "example_dialogues"],
  "long-memory": [],
  "memory-tools": [],
  context: [],
} as const;

export interface PageEditor {
  // An edit-session identity, not a server revision or persisted field.
  token: object;
  agent: AgentResponse;
  persona: PersonaResponse;
  draft: AgentDraft;
  personaDraft: PersonaResponse;
  policy: PolicyView | null;
  policyDraft: PolicyView | null;
}
export function newPageEditor(
  agent: AgentResponse,
  persona: PersonaResponse,
  policy: PolicyView | null = null,
): PageEditor {
  return {
    token: {},
    agent,
    persona,
    draft: toDraft(agent),
    personaDraft: { ...persona },
    policy,
    policyDraft: policy ? { ...policy } : null,
  };
}
export function agentPageDirty(editor: PageEditor, page: EditablePage): boolean {
  return (
    PAGE_AGENT_FIELDS[page].some((key) => editor.draft[key] !== editor.agent[key]) ||
    p5Fields(page).some((key) => !equal(editor.draft.p5_config[key], editor.agent.p5_config[key]))
  );
}
export function personaPageDirty(editor: PageEditor, page: EditablePage): boolean {
  return PAGE_PERSONA_FIELDS[page].some((key) => editor.personaDraft[key] !== editor.persona[key]);
}
export function dirtyPages(editor: PageEditor | null): EditablePage[] {
  return editor
    ? EDITABLE_PAGES.filter(
        (page) =>
          agentPageDirty(editor, page) ||
          personaPageDirty(editor, page) ||
          (page === "long-memory" && policyDirty(editor)),
      )
    : [];
}
export function mergeRetrievalPresets(
  baseline: AgentDraft["p5_config"]["retrieval_presets"],
  draft: AgentDraft["p5_config"]["retrieval_presets"],
) {
  const merged = { ...baseline };
  for (const mode of ["conservative", "standard", "broad"] as const) {
    // Only tool allowances are editable; retain the stored relevance instruction verbatim.
    merged[mode] = {
      ...baseline[mode],
      candidate_limit: draft[mode].candidate_limit,
      max_entries: draft[mode].max_entries,
      max_tokens: draft[mode].max_tokens,
    };
  }
  return merged;
}
export function pageAgentPayload(editor: PageEditor, page: EditablePage) {
  const p5 = editor.draft.p5_config;
  // Intensity belongs to the persona endpoint; the generic agent endpoint rejects it.
  return {
    ...Object.fromEntries(
      PAGE_AGENT_FIELDS[page]
        .filter((key) => key !== "persona_intensity")
        .map((key) => [key, editor.draft[key]]),
    ),
    ...(p5Fields(page).length
      ? {
          p5_config: {
            ...editor.agent.p5_config,
            ...Object.fromEntries(p5Fields(page).map((key) => [key, p5[key]])),
            ...(page === "memory-tools"
              ? {
                  // Retired legacy modes normalize to broad only when the user actively
                  // switched the mode away from the stored full mode this draft session.
                  // A stored full mode kept untouched stays full in the payload, so catalog
                  // batch edits remain consumed by the server's batch loop.
                  retrieval_mode:
                    p5.retrieval_mode !== editor.agent.p5_config.retrieval_mode &&
                    (p5.retrieval_mode === "full_catalog" || p5.retrieval_mode === "full_body")
                      ? "broad"
                      : p5.retrieval_mode,
                  retrieval_presets: mergeRetrievalPresets(
                    editor.agent.p5_config.retrieval_presets,
                    p5.retrieval_presets,
                  ),
                }
              : {}),
          },
        }
      : {}),
    expected_version: editor.agent.config_version,
  };
}
export function pagePersonaPayload(editor: PageEditor, page: "identity" | "expression") {
  // PUT replaces all five fields. Other pages must come from the SAVED baseline.
  const fields = {
    core_identity: editor.persona.core_identity,
    interaction_boundaries: editor.persona.interaction_boundaries,
    advanced_instructions: editor.persona.advanced_instructions,
    communication_style: editor.persona.communication_style,
    example_dialogues: editor.persona.example_dialogues,
  };
  for (const key of PAGE_PERSONA_FIELDS[page]) fields[key] = editor.personaDraft[key];
  return {
    ...fields,
    ...(page === "expression" ? { persona_intensity: editor.draft.persona_intensity } : {}),
  };
}
export function acceptPageAgent(
  editor: PageEditor,
  page: EditablePage,
  saved: AgentResponse,
): PageEditor {
  return {
    ...editor,
    agent: saved,
    draft: {
      ...editor.draft,
      ...Object.fromEntries(PAGE_AGENT_FIELDS[page].map((key) => [key, saved[key]])),
      p5_config: {
        ...editor.draft.p5_config,
        ...Object.fromEntries(p5Fields(page).map((key) => [key, saved.p5_config[key]])),
      },
      config_version: saved.config_version,
    },
  };
}
export function acceptPagePersona(
  editor: PageEditor,
  page: "identity" | "expression",
  saved: PersonaResponse,
): PageEditor {
  const intensity =
    page === "expression" ? editor.draft.persona_intensity : editor.agent.persona_intensity;
  return {
    ...editor,
    persona: saved,
    personaDraft: {
      ...editor.personaDraft,
      ...Object.fromEntries(PAGE_PERSONA_FIELDS[page].map((key) => [key, saved[key]])),
      updated_at: saved.updated_at,
    },
    agent: { ...editor.agent, persona_intensity: intensity },
  };
}
