export const SETTINGS_ROUTES = [
  {
    id: "basic",
    title: "workspace.assistant_management",
    state: "transition",
    note: "workspace.name_description_and_enabled_status",
  },
  {
    id: "models",
    title: "workspace.default_models",
    state: "transition",
    note: "workspace.manage_every_model_purpose_here_global_defaults_library_and_assistant_se",
  },
  {
    id: "external-api",
    title: "workspace.external_model_api",
    // Application-level resource: a provider serves the whole app, not one assistant (0032).
    state: "transition",
    note: "workspace.register_an_openai_compatible_model_service_type_each_model_s_context_wi",
  },
  {
    id: "identity",
    title: "workspace.identity_and_behavior",
    state: "transition",
    note: "workspace.core_identity_interaction_boundaries_advanced_and_additional_instruction",
  },
  {
    id: "expression",
    title: "workspace.personality_and_expression",
    state: "transition",
    note: "workspace.communication_style_example_dialogues_and_personality_intensity",
  },
  {
    id: "emotion",
    title: "workspace.emotion",
    state: "unavailable",
    note: "workspace.emotion_features_are_not_available_yet_no_configuration_is_needed",
  },
  // QQ-wide configuration lives under 人设 and does not follow the configured assistant.
  {
    id: "qq-stickers",
    title: "workspace.sticker_library",
    state: "transition",
    note: "workspace.qq_wide_shared_stickers_import_describe_file_and_enable",
  },
  {
    id: "qq-scheme-config",
    title: "workspace.chat_schemes",
    state: "transition",
    note: "workspace.qq_wide_schemes_speech_and_rhythm_context_and_memory_media_and_expressio",
  },
  {
    id: "qq-storage",
    title: "workspace.storage_and_diagnostics",
    state: "transition",
    note: "workspace.what_the_qq_side_keeps_how_long_it_keeps_it_and_the_one_cleanup_entry_th",
  },
  // 接入（P7-d）：MCP 登记、技能目录与统一工具授权；都是应用级资源，不跟随某个助手。
  {
    id: "mcp-servers",
    title: "connections.mcp.title",
    state: "transition",
    note: "connections.mcp.description",
  },
  {
    id: "skill-catalog",
    title: "connections.skills.title",
    state: "transition",
    note: "connections.skills.description",
  },
  {
    id: "tool-grants",
    title: "connections.grants.title",
    state: "transition",
    note: "connections.grants.description",
  },
  // 系统能力（P8）：独立一级目录；内置能力在此登记，联网与执行设置从接入、运行移归此处。
  {
    id: "system-capabilities",
    title: "workspace.capabilities",
    state: "transition",
    note: "workspace.manage_built_in_capabilities_and_execution_limits_by_function",
  },
  {
    id: "memory-tools",
    title: "capabilities.memory.name",
    state: "transition",
    note: "capabilities.memory.description",
  },
  {
    id: "knowledge-tools",
    title: "capabilities.knowledge.name",
    state: "transition",
    note: "capabilities.knowledge.description",
  },
  {
    id: "media-tools",
    title: "capabilities.media.name",
    state: "transition",
    note: "capabilities.media.description",
  },
  {
    id: "web-access",
    title: "connections.web.title",
    state: "transition",
    note: "connections.web.description",
  },
  {
    id: "execution-settings",
    title: "connections.execution.title",
    state: "transition",
    note: "connections.execution.description",
  },
  {
    id: "session-history",
    title: "capabilities.session.name",
    state: "transition",
    note: "capabilities.session.description",
  },
  // 运行（P7-d）：执行台账与任务与审批；执行设置已移归系统能力（P8）。
  {
    id: "execution-ledger",
    title: "connections.runs.ledger",
    state: "transition",
    note: "connections.runs.ledgerNote",
  },
  {
    id: "task-ledger",
    title: "connections.tasks.title",
    state: "transition",
    note: "connections.tasks.description",
  },
  {
    id: "context",
    title: "workspace.short_term_context",
    state: "transition",
    note: "workspace.capacity_budgets_compression_and_summary_reading",
  },
  {
    id: "long-memory",
    title: "workspace.long_term_memory",
    state: "transition",
    note: "workspace.configure_memory_reading_and_organization_manage_stored_memories",
  },
  {
    id: "knowledge-config",
    title: "workspace.knowledge_settings",
    state: "transition",
    note: "workspace.assistant_reading_settings_and_global_shared_settings_are_shown_separate",
  },
  {
    id: "profile",
    title: "workspace.user_profile",
    state: "unavailable",
    note: "workspace.user_profiles_are_not_available_yet_no_settings_required",
  },
] as const;
// Legacy model route is accepted only as an alias to Quick management.
export type SettingsRoute =
  | (typeof SETTINGS_ROUTES)[number]["id"]
  | "management"
  | "knowledge-model";
