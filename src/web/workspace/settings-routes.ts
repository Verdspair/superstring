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
    title: "schemes.qq.detailTitle",
    state: "transition",
    note: "schemes.qq.detailNote",
  },
  // QQ 应用级管理（P9）：开关、连接与保留数据都随应用，不随单个方案保存。
  {
    id: "qq-app-schemes",
    title: "schemes.qq.appTitle",
    state: "transition",
    note: "schemes.qq.description",
  },
  {
    id: "qq-app-groups",
    title: "schemes.qq.groupConfigTitle",
    state: "transition",
    note: "schemes.qq.groupConfigNote",
  },
  {
    id: "qq-connection",
    title: "schemes.qq.connectionTitle",
    state: "transition",
    note: "schemes.qq.scopeNote",
  },
  {
    id: "qq-storage",
    title: "connections.dataRetention",
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
    title: "connections.tools.title",
    state: "transition",
    note: "connections.tools.description",
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
  // 方案（P9）：独立一级目录；按应用登记（QQ 现在唯一实现），应用详情沿用既有 qq 路由。
  {
    id: "scheme-library",
    title: "workspace.schemes",
    state: "transition",
    note: "schemes.catalogNote",
  },
  // 绑定归方案：这是绑定的首次发现入口；日常编辑走方案详情的绑定视图，不做成平级 Tab。
  {
    id: "scheme-bindings",
    title: "schemes.bindings.title",
    state: "transition",
    note: "schemes.bindings.note",
  },
  // 本群配置：从某个群的「本群配置」入口打开；仅本群作用域，
  // 路由登记在这里是为了归属方案空间与命令面板归属，不做成顶层目录入口。
  {
    id: "qq-group-config",
    title: "schemes.qq.groupConfigTitle",
    state: "transition",
    note: "schemes.qq.groupConfigNote",
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
