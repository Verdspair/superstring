import type { AgentResponse, PersonaResponse, PolicyView } from "../../../shared/contracts";
import type { AgentDraft } from "../../state/types";
import { toDraft } from "./draft";

export const EDITABLE_PAGES = [
  "basic",
  "models",
  "identity",
  "expression",
  "long-memory",
  "context",
] as const;
// Explicit ownership: no future p5 field is silently assigned to a page.
export const PAGE_P5_FIELDS = {
  "long-memory": [
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
  return page === "long-memory" || page === "context" ? PAGE_P5_FIELDS[page] : [];
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export type EditablePage = (typeof EDITABLE_PAGES)[number];
export const PAGE_AGENT_FIELDS = {
  basic: ["name", "description", "is_active"],
  models: [
    "model_name",
    "temperature",
    "memory_retrieval_model_name",
    "memory_consolidation_model_name",
    "context_compression_model_name",
  ],
  identity: ["additional_instructions"],
  expression: ["persona_intensity"],
  "long-memory": [
    "memory_retrieval_prompt",
    "memory_consolidation_prompt",
    "memory_consolidation_additional_instructions",
  ],
  context: [],
} as const;
export const PAGE_PERSONA_FIELDS = {
  basic: [],
  models: [],
  identity: ["core_identity", "interaction_boundaries", "advanced_instructions"],
  expression: ["communication_style", "example_dialogues"],
  "long-memory": [],
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
export function isEditablePage(page: string): page is EditablePage {
  return EDITABLE_PAGES.some((item) => item === page);
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
export function pageAgentPayload(editor: PageEditor, page: EditablePage) {
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
            ...Object.fromEntries(p5Fields(page).map((key) => [key, editor.draft.p5_config[key]])),
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
