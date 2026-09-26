export const SETTINGS_GROUPS = [
  { id: "persona", title: "workspace.persona" },
  { id: "memory", title: "workspace.memory" },
] as const;

export const SETTINGS_ROUTES = [
  {
    id: "basic",
    group: "management",
    title: "workspace.assistant_management",
    section: "A",
    scope: "agent",
    state: "transition",
    note: "workspace.name_description_and_enabled_status",
  },
  {
    id: "models",
    group: "management",
    title: "workspace.default_models",
    section: "A",
    scope: "mixed",
    state: "transition",
    note: "workspace.manage_every_model_purpose_here_global_defaults_library_and_assistant_se",
  },
  {
    id: "external-api",
    group: "management",
    title: "workspace.external_model_api",
    // Application-level resource: a provider serves the whole app, not one assistant (0032).
    scope: "global",
    state: "transition",
    note: "workspace.register_an_openai_compatible_model_service_type_each_model_s_context_wi",
  },
  {
    id: "identity",
    group: "persona",
    title: "workspace.identity_and_behavior",
    section: "D",
    scope: "agent",
    state: "transition",
    note: "workspace.core_identity_interaction_boundaries_advanced_and_additional_instruction",
  },
  {
    id: "expression",
    group: "persona",
    title: "workspace.personality_and_expression",
    section: "D",
    scope: "agent",
    state: "transition",
    note: "workspace.communication_style_example_dialogues_and_personality_intensity",
  },
  {
    id: "emotion",
    group: "persona",
    title: "workspace.emotion",
    section: "E",
    scope: "agent",
    state: "unavailable",
    note: "workspace.emotion_features_are_not_available_yet_no_configuration_is_needed",
  },
  // §11.1's QQ 额外配置 area: the three entries live under 人设 and are QQ-global, so none of
  // them follows the assistant being configured. Only the sticker library is implemented; the
  // other two keep their entry and say so, rather than pretending to be configurable.
  {
    id: "qq-stickers",
    group: "persona",
    title: "workspace.sticker_library",
    area: "qq",
    scope: "global",
    state: "transition",
    note: "workspace.qq_wide_shared_stickers_import_describe_file_and_enable",
  },
  {
    id: "qq-scheme-config",
    group: "persona",
    title: "workspace.chat_schemes",
    area: "qq",
    scope: "global",
    state: "transition",
    note: "workspace.qq_wide_schemes_speech_and_rhythm_context_and_memory_media_and_expressio",
  },
  {
    id: "qq-storage",
    group: "persona",
    title: "workspace.storage_and_diagnostics",
    area: "qq",
    scope: "global",
    state: "transition",
    note: "workspace.what_the_qq_side_keeps_how_long_it_keeps_it_and_the_one_cleanup_entry_th",
  },
  {
    id: "context",
    group: "memory",
    title: "workspace.short_term_context",
    section: "C",
    scope: "agent",
    state: "transition",
    note: "workspace.capacity_budgets_compression_and_summary_reading",
  },
  {
    id: "long-memory",
    group: "memory",
    title: "workspace.long_term_memory",
    section: "B",
    scope: "agent",
    state: "transition",
    note: "workspace.configure_memory_reading_and_organization_manage_stored_memories",
  },
  {
    id: "knowledge-config",
    group: "memory",
    title: "workspace.knowledge_settings",
    scope: "mixed",
    state: "transition",
    note: "workspace.assistant_reading_settings_and_global_shared_settings_are_shown_separate",
  },
  {
    id: "profile",
    group: "memory",
    title: "workspace.user_profile",
    section: "G",
    scope: "agent",
    state: "unavailable",
    note: "workspace.user_profiles_are_not_available_yet_no_settings_required",
  },
] as const;
// Legacy model route is accepted only as an alias to Quick management.
export type SettingsRoute =
  | (typeof SETTINGS_ROUTES)[number]["id"]
  | "management"
  | "knowledge-model";
export function settingsRoute(id: SettingsRoute) {
  return SETTINGS_ROUTES.find((item) => item.id === id);
}
export const KNOWLEDGE_PLANNED_FIELDS = [
  "workspace.original_or_organized_content_preference",
  "workspace.document_retrieval_rules",
  "workspace.document_priority",
  "workspace.retrieval_timing",
  "workspace.behavior_when_no_document_matches",
] as const;
