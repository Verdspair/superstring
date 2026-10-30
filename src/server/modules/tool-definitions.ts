import {
  codeRunDescription,
  evidenceToolDescriptions,
  QQ_MEDIA_TOOL_DESCRIPTIONS,
  QQ_MEMBER_TOOL_DESCRIPTIONS,
  qqReplyTerminalDescriptions,
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
  return [descriptions.query, descriptions.read].map(
    (description): SystemToolDefinition => ({
      description,
      functionId,
      scope: "conversation",
    }),
  );
};

export const SYSTEM_TOOL_DEFINITIONS: readonly SystemToolDefinition[] = [
  ...qqReplyTerminalDescriptions(true).map(
    (description): SystemToolDefinition => ({
      description,
      invocation: "host-terminal",
      scope: "qq-conversation",
      sandboxCallable: false,
      functionId: "qq-reply",
    }),
  ),
  ...evidenceDefinitions("memory", "memory-query"),
  ...evidenceDefinitions("knowledge", "knowledge-query"),
  ...evidenceDefinitions("history", "session-history-summary"),
  ...evidenceDefinitions("summary", "session-history-summary"),
  {
    description: QQ_MEMBER_TOOL_DESCRIPTIONS["qq.members.query"],
    sandboxCallable: false,
    functionId: "qq-members",
    scope: "qq-group",
  },
  {
    description: QQ_MEMBER_TOOL_DESCRIPTIONS["qq.members.read"],
    sandboxCallable: false,
    functionId: "qq-members",
    scope: "qq-group",
  },
  {
    description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.list"],
    functionId: "media-stickers",
    scope: "qq-conversation",
  },
  {
    description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.note.read"],
    functionId: "media-stickers",
    scope: "qq-conversation",
  },
  {
    description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.describe"],
    sandboxCallable: false,
    functionId: "media-stickers",
    scope: "qq-conversation",
  },
  {
    description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.read"],
    functionId: "media-stickers",
    scope: "qq-conversation",
  },
  {
    description: STICKER_SEARCH_DESCRIPTION,
    functionId: "media-stickers",
    scope: "qq-conversation",
  },
  {
    description: taskStartDescription([]),
    sandboxCallable: false,
    functionId: "execution-limits",
    scope: "conversation",
  },
  {
    description: TASK_READ_DESCRIPTION,
    sandboxCallable: false,
    functionId: "execution-limits",
    scope: "conversation",
  },
  {
    description: RESEARCH_ACTION_DESCRIPTION,
    sandboxCallable: false,
    functionId: "execution-limits",
    scope: "conversation",
  },
  {
    description: codeRunDescription([], 3),
    sandboxCallable: false,
    functionId: "execution-limits",
    scope: "conversation",
  },
];

export function systemToolDefinitions(execution: ExecutionPolicy): readonly SystemToolDefinition[] {
  return SYSTEM_TOOL_DEFINITIONS.map((definition) =>
    definition.description.name === "code.run"
      ? { ...definition, description: codeRunDescription([], execution.codeLimits.concurrency) }
      : definition,
  );
}
