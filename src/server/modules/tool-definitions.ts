import {
  codeRunDescription,
  evidenceToolDescriptions,
  QQ_MEDIA_TOOL_DESCRIPTIONS,
  RESEARCH_ACTION_DESCRIPTION,
  STICKER_SEARCH_DESCRIPTION,
  TASK_READ_DESCRIPTION,
  taskStartDescription,
} from "../../shared/contracts/agent-action-descriptions";
import type { ExecutionPolicy } from "../../shared/contracts/permissions";
import type { SystemFunctionId } from "../../shared/contracts/tool-directory";
import type { SystemToolDefinition } from "../permissions/tool-directory";

const evidenceDefinitions = (
  kind: string,
  functionId: SystemFunctionId,
): SystemToolDefinition[] => {
  const descriptions = evidenceToolDescriptions(kind);
  return [descriptions.query, descriptions.read].map((description) => ({
    description,
    functionId,
  }));
};

export const SYSTEM_TOOL_DEFINITIONS: readonly SystemToolDefinition[] = [
  ...evidenceDefinitions("memory", "memory-query"),
  ...evidenceDefinitions("knowledge", "knowledge-query"),
  ...evidenceDefinitions("history", "session-history-summary"),
  ...evidenceDefinitions("summary", "session-history-summary"),
  { description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.list"], functionId: "media-stickers" },
  { description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.note.read"], functionId: "media-stickers" },
  {
    description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.describe"],
    sandboxCallable: false,
    functionId: "media-stickers",
  },
  { description: STICKER_SEARCH_DESCRIPTION, functionId: "media-stickers" },
  { description: taskStartDescription([]), sandboxCallable: false, functionId: "execution-limits" },
  { description: TASK_READ_DESCRIPTION, sandboxCallable: false, functionId: "execution-limits" },
  {
    description: RESEARCH_ACTION_DESCRIPTION,
    sandboxCallable: false,
    functionId: "execution-limits",
  },
  {
    description: codeRunDescription([], 3),
    sandboxCallable: false,
    functionId: "execution-limits",
  },
];

export function systemToolDefinitions(execution: ExecutionPolicy): readonly SystemToolDefinition[] {
  return SYSTEM_TOOL_DEFINITIONS.map((definition) =>
    definition.description.name === "code.run"
      ? { ...definition, description: codeRunDescription([], execution.codeLimits.concurrency) }
      : definition,
  );
}
