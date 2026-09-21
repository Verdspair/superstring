export const SETTINGS_GROUPS = [
  { id: "persona", title: "人设" },
  { id: "memory", title: "记忆" },
] as const;

export const SETTINGS_ROUTES = [
  {
    id: "basic",
    group: "management",
    title: "助手管理",
    section: "A",
    scope: "agent",
    state: "transition",
    note: "名称、描述与启用状态。",
  },
  {
    id: "models",
    group: "management",
    title: "默认模型",
    section: "A",
    scope: "mixed",
    state: "transition",
    note: "统一管理全部用途模型；全局默认、知识库与当前助手分别保存。",
  },
  {
    id: "external-api",
    group: "management",
    title: "外部模型API",
    scope: "agent",
    state: "unavailable",
    note: "外部模型 API 接入尚未开放。",
  },
  {
    id: "apps",
    group: "management",
    title: "第三方App接入",
    section: "F",
    scope: "agent",
    state: "unavailable",
    note: "外部软件接入暂不可用；现有本地聊天不受影响。",
  },
  {
    id: "identity",
    group: "persona",
    title: "身份与行为",
    section: "D",
    scope: "agent",
    state: "transition",
    note: "核心身份、互动边界、高级指令与补充指令。",
  },
  {
    id: "expression",
    group: "persona",
    title: "性格与表达",
    section: "D",
    scope: "agent",
    state: "transition",
    note: "沟通风格、示例对话与性格强度。",
  },
  {
    id: "emotion",
    group: "persona",
    title: "情绪",
    section: "E",
    scope: "agent",
    state: "unavailable",
    note: "情绪功能尚未开放，当前无需配置。",
  },
  {
    id: "context",
    group: "memory",
    title: "短期上下文",
    section: "C",
    scope: "agent",
    state: "transition",
    note: "容量与预算、压缩与读取摘要策略。",
  },
  {
    id: "long-memory",
    group: "memory",
    title: "长期记忆",
    section: "B",
    scope: "agent",
    state: "transition",
    note: "设置记忆读取与整理，管理已存记忆。",
  },
  {
    id: "knowledge-config",
    group: "memory",
    title: "知识库配置",
    scope: "mixed",
    state: "transition",
    note: "当前助手的读取配置与全局共享配置分开显示。",
  },
  {
    id: "profile",
    group: "memory",
    title: "用户画像",
    section: "G",
    scope: "agent",
    state: "unavailable",
    note: "用户画像暂未开放，当前无需设置。",
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
  "原文或整理稿偏好",
  "资料检索规则",
  "资料优先级",
  "检索时机",
  "找不到资料时的行为",
] as const;
