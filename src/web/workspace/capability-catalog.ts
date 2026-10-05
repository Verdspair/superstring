import { BookOpen, Brain, Globe, Image, ListChecks, MessagesSquare } from "lucide-react";
import type { SystemComponentTarget } from "../../shared/contracts/tool-directory";
import type { SettingsRoute } from "./settings-routes";

/** Every built-in capability is registered here: localized copy, search keywords, destination. */
export type CapabilityDetail = "memory" | "knowledge" | "web" | "media" | "execution" | "link";

export interface CapabilityEntry {
  /** Stable catalog id; never parsed for navigation. */
  id: string;
  nameKey: string;
  descriptionKey: string;
  /** Extra localized search terms (technical names users may type). */
  keywordKeys: readonly string[];
  /** The registered destination; the only source of navigation. */
  route: SettingsRoute;
  detail: CapabilityDetail;
  icon: typeof Brain;
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
  },
  {
    id: "knowledge-query",
    nameKey: "capabilities.knowledge.name",
    descriptionKey: "capabilities.knowledge.description",
    keywordKeys: ["capabilities.knowledge.keywords"],
    route: "knowledge-tools",
    detail: "knowledge",
    icon: BookOpen,
  },
  {
    id: "web-access",
    nameKey: "connections.web.title",
    descriptionKey: "connections.web.description",
    keywordKeys: ["capabilities.web.keywords"],
    route: "web-access",
    detail: "web",
    icon: Globe,
  },
  {
    id: "media-stickers",
    nameKey: "capabilities.media.name",
    descriptionKey: "capabilities.media.description",
    keywordKeys: ["capabilities.media.keywords"],
    route: "media-tools",
    detail: "media",
    icon: Image,
  },
  {
    id: "execution-limits",
    nameKey: "capabilities.execution.name",
    descriptionKey: "capabilities.execution.description",
    keywordKeys: ["capabilities.execution.keywords"],
    route: "execution-settings",
    detail: "execution",
    icon: ListChecks,
  },
  {
    id: "session-history-summary",
    nameKey: "capabilities.session.name",
    descriptionKey: "capabilities.session.description",
    keywordKeys: ["capabilities.session.keywords"],
    route: "session-history",
    detail: "link",
    icon: MessagesSquare,
  },
] as const;

/** Route lookup is the contract: callers navigate by route, never by id. */
export function capabilityByRoute(route: SettingsRoute): CapabilityEntry | null {
  return CAPABILITY_CATALOG.find((entry) => entry.route === route) ?? null;
}

export function capabilityComponents(entry: CapabilityEntry): readonly SystemComponentTarget[] {
  const toolNames: Record<CapabilityDetail, readonly string[]> = {
    memory: ["memory.query", "memory.read"],
    knowledge: ["knowledge.query", "knowledge.read"],
    web: ["web.search", "web.fetch"],
    media: ["media.list", "media.read", "media.note.read", "media.describe", "sticker.search"],
    execution: ["task.start", "task.read", "research.run", "code.run"],
    link: ["history.query", "history.read", "summary.query", "summary.read"],
  };
  const skillNames: Record<CapabilityDetail, string> = {
    memory: "system-evidence-reading",
    knowledge: "system-evidence-reading",
    web: "system-web-research",
    media: "system-media-reading",
    execution: "system-task-execution",
    link: "system-evidence-reading",
  };
  return [
    ...toolNames[entry.detail].map((id) => ({ kind: "tool" as const, id })),
    { kind: "skill", id: skillNames[entry.detail] },
  ];
}
