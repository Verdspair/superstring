import {
  BookOpen,
  Brain,
  Globe,
  Image,
  ListChecks,
  MessagesSquare,
  Puzzle,
  Users,
} from "lucide-react";
import type {
  SystemComponentTarget,
  ToolDirectoryEntry,
} from "../../shared/contracts/tool-directory";
import type { SettingsRoute } from "./settings-routes";

export type CapabilityDetail =
  | "memory"
  | "knowledge"
  | "web"
  | "media"
  | "members"
  | "execution"
  | "link";

export interface BaseCapabilityEntry {
  id: string;
  nameKey: string;
  descriptionKey: string;
  keywordKeys: readonly string[];
  route: SettingsRoute;
  icon: typeof Brain;
  skills: readonly string[];
}

export interface BuiltInCapabilityEntry extends BaseCapabilityEntry {
  detail: CapabilityDetail;
}

export interface SchemeCapabilityEntry extends BaseCapabilityEntry {
  detail?: undefined;
  actionNoteKey: string;
}

export interface ExternalCapabilityEntry extends BaseCapabilityEntry {
  detail?: undefined;
}

export type CapabilityEntry =
  | BuiltInCapabilityEntry
  | SchemeCapabilityEntry
  | ExternalCapabilityEntry;

export function isBuiltInCapability(entry: CapabilityEntry): entry is BuiltInCapabilityEntry {
  return entry.detail !== undefined;
}

export const CAPABILITY_CATALOG: readonly CapabilityEntry[] = [
  {
    id: "memory-query",
    nameKey: "capabilities.memory.name",
    descriptionKey: "capabilities.memory.description",
    keywordKeys: ["capabilities.memory.keywords"],
    route: "memory-tools",
    detail: "memory",
    icon: Brain,
    skills: ["system-evidence-reading"],
  },
  {
    id: "knowledge-query",
    nameKey: "capabilities.knowledge.name",
    descriptionKey: "capabilities.knowledge.description",
    keywordKeys: ["capabilities.knowledge.keywords"],
    route: "knowledge-tools",
    detail: "knowledge",
    icon: BookOpen,
    skills: ["system-evidence-reading"],
  },
  {
    id: "session-history-summary",
    nameKey: "capabilities.session.name",
    descriptionKey: "capabilities.session.description",
    keywordKeys: ["capabilities.session.keywords"],
    route: "session-history",
    detail: "link",
    icon: MessagesSquare,
    skills: [],
  },
  {
    id: "web-access",
    nameKey: "connections.web.title",
    descriptionKey: "connections.web.description",
    keywordKeys: ["capabilities.web.keywords"],
    route: "web-access",
    detail: "web",
    icon: Globe,
    skills: ["system-web-research"],
  },
  {
    id: "media-stickers",
    nameKey: "capabilities.media.name",
    descriptionKey: "capabilities.media.description",
    keywordKeys: ["capabilities.media.keywords"],
    route: "media-tools",
    detail: "media",
    icon: Image,
    skills: ["system-media-reading"],
  },
  {
    id: "qq-reply",
    nameKey: "capabilities.qqReply.name",
    descriptionKey: "capabilities.qqReply.description",
    keywordKeys: ["capabilities.qqReply.keywords"],
    route: "qq-app-schemes",
    icon: MessagesSquare,
    skills: ["system-qq-reply"],
    actionNoteKey: "capabilities.qqReply.actionNote",
  },
  {
    id: "qq-members",
    nameKey: "capabilities.members.name",
    descriptionKey: "capabilities.members.description",
    keywordKeys: ["capabilities.members.keywords"],
    route: "qq-member-tools",
    detail: "members",
    icon: Users,
    skills: ["system-qq-members"],
  },
  {
    id: "execution-limits",
    nameKey: "capabilities.execution.name",
    descriptionKey: "capabilities.execution.description",
    keywordKeys: ["capabilities.execution.keywords"],
    route: "execution-settings",
    detail: "execution",
    icon: ListChecks,
    skills: ["system-task-execution"],
  },
  {
    id: "external-integrations",
    nameKey: "capabilities.external.name",
    descriptionKey: "capabilities.external.description",
    keywordKeys: ["capabilities.external.keywords"],
    route: "mcp-servers",
    icon: Puzzle,
    skills: [],
  },
] as const;

export function capabilityByRoute(route: SettingsRoute): BuiltInCapabilityEntry | null {
  const match = CAPABILITY_CATALOG.find(
    (entry) => isBuiltInCapability(entry) && entry.route === route,
  );
  if (match && isBuiltInCapability(match)) {
    return match;
  }
  return null;
}

export interface FunctionGroup {
  id: "materials" | "web" | "qq" | "execution" | "external";
  titleKey: string;
  descriptionKey: string;
  entryIds: readonly CapabilityEntry["id"][];
}

export const FUNCTION_GROUPS: readonly FunctionGroup[] = [
  {
    id: "materials",
    titleKey: "capabilities.group.materials",
    descriptionKey: "capabilities.group.materials.description",
    entryIds: ["memory-query", "knowledge-query", "session-history-summary"],
  },
  {
    id: "web",
    titleKey: "capabilities.group.web",
    descriptionKey: "capabilities.group.web.description",
    entryIds: ["web-access"],
  },
  {
    id: "qq",
    titleKey: "capabilities.group.qq",
    descriptionKey: "capabilities.group.qq.description",
    entryIds: ["media-stickers", "qq-reply", "qq-members"],
  },
  {
    id: "execution",
    titleKey: "capabilities.group.execution",
    descriptionKey: "capabilities.group.execution.description",
    entryIds: ["execution-limits"],
  },
  {
    id: "external",
    titleKey: "capabilities.group.external",
    descriptionKey: "capabilities.group.external.description",
    entryIds: ["external-integrations"],
  },
] as const;

export const TOOL_HUMAN_LABELS: Record<string, string> = {
  "memory.query": "capabilities.labels.memoryQuery",
  "memory.read": "capabilities.labels.memoryRead",
  "knowledge.query": "capabilities.labels.knowledgeQuery",
  "knowledge.read": "capabilities.labels.knowledgeRead",
  "history.query": "capabilities.labels.historyQuery",
  "history.read": "capabilities.labels.historyRead",
  "summary.query": "capabilities.labels.summaryQuery",
  "summary.read": "capabilities.labels.summaryRead",
  "web.search": "capabilities.labels.webSearch",
  "web.fetch": "capabilities.labels.webFetch",
  "media.list": "capabilities.labels.mediaList",
  "media.read": "capabilities.labels.mediaRead",
  "media.note.read": "capabilities.labels.mediaNoteRead",
  "media.describe": "capabilities.labels.mediaDescribe",
  "sticker.search": "capabilities.labels.stickerSearch",
  "task.start": "capabilities.labels.taskStart",
  "task.read": "capabilities.labels.taskRead",
  "research.run": "capabilities.labels.researchRun",
  "code.run": "capabilities.labels.codeRun",
  "qq.members.query": "capabilities.labels.qqMembersQuery",
  "qq.members.read": "capabilities.labels.qqMembersRead",
};

export const SKILL_HUMAN_LABELS: Record<string, string> = {
  "system-evidence-reading": "capabilities.labels.skillEvidenceReading",
  "system-web-research": "capabilities.labels.skillWebResearch",
  "system-media-reading": "capabilities.labels.skillMediaReading",
  "system-task-execution": "capabilities.labels.skillTaskExecution",
  "system-qq-reply": "capabilities.labels.skillQqReply",
  "system-qq-members": "capabilities.labels.skillQqMembers",
};

export function capabilityComponents(
  entry: CapabilityEntry,
  tools: readonly ToolDirectoryEntry[] = [],
): readonly SystemComponentTarget[] {
  const functionTools = tools.filter((tool) => tool.functionId === entry.id);
  const toolTargets: SystemComponentTarget[] = functionTools.map((t) => ({
    kind: "tool",
    id: t.name,
  }));
  const skillTargets: SystemComponentTarget[] = entry.skills.map((s) => ({ kind: "skill", id: s }));
  return [...toolTargets, ...skillTargets];
}
