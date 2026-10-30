import { createHash } from "node:crypto";
import type { SharedActionDescription } from "../../shared/contracts/agent-action-descriptions";
import { type ExecutionPolicy, toolExecutionEnabled } from "../../shared/contracts/permissions";
import {
  describeTool,
  type SystemFunctionId,
  type ToolDefinition,
  type ToolDirectoryEntry,
  type ToolDirectoryInvocation,
  type ToolDirectoryScope,
} from "../../shared/contracts/tool-directory";

export interface SystemToolDefinition {
  description: SharedActionDescription;
  sandboxCallable?: boolean;
  functionId: SystemFunctionId;
  invocation?: ToolDirectoryInvocation;
  scope: ToolDirectoryScope;
}

function globallyEnabled(name: string, execution: ExecutionPolicy): boolean {
  if (!toolExecutionEnabled(execution, name)) return false;
  if (name.startsWith("media.")) return execution.modules.qqMedia;
  if (name.startsWith("qq.members.")) return execution.modules.qqMembers;
  if (name.startsWith("sticker.") || name === "reply.sticker") return execution.modules.qqStickers;
  if (name === "task.start") return execution.modules.tasks;
  if (name === "research.run") return execution.research;
  if (name === "code.run") return execution.code;
  return true;
}

function functionOf(name: string): SystemFunctionId | null {
  if (name.startsWith("qq.members.")) return "qq-members";
  if (name.startsWith("memory.")) return "memory-query";
  if (name.startsWith("knowledge.")) return "knowledge-query";
  if (name.startsWith("history.") || name.startsWith("summary.")) return "session-history-summary";
  if (name.startsWith("web.")) return "web-access";
  if (name.startsWith("media.") || name.startsWith("sticker.") || name === "reply.sticker")
    return "media-stickers";
  if (name.startsWith("task.") || name === "research.run" || name === "code.run")
    return "execution-limits";
  return null;
}

export function projectToolDirectory(
  system: readonly SystemToolDefinition[],
  actions: readonly ToolDefinition[],
  execution: ExecutionPolicy,
): ToolDirectoryEntry[] {
  const tools = new Map<string, ToolDirectoryEntry>();
  const add = (
    description: SharedActionDescription,
    sandboxCallable: boolean | undefined,
    functionId: SystemFunctionId | null,
    invocation: ToolDirectoryInvocation,
    scope: ToolDirectoryScope,
    permission?: ToolDefinition["permission"],
  ) => {
    if (tools.has(description.name)) throw new Error(`TOOL_CATALOG_DUPLICATE: ${description.name}`);
    const descriptor = describeTool({ description, sandboxCallable });
    const origin = description.name.startsWith("mcp.") ? "mcp" : "system";
    tools.set(description.name, {
      ...descriptor,
      origin,
      invocation,
      scope,
      // Terminals use host output gates, not executable pausedTools or resource grants.
      globalEnabled:
        invocation === "host-terminal"
          ? description.name !== "reply.sticker" || execution.modules.qqStickers
          : globallyEnabled(description.name, execution),
      functionId,
      resource: permission?.resource ?? null,
      revision:
        permission?.revision ??
        createHash("sha256").update(JSON.stringify(description)).digest("hex"),
      approvalRequired: permission?.approvalRequired ?? false,
      directories: [...(permission?.directories ?? [])],
    });
  };
  for (const definition of system)
    add(
      definition.description,
      definition.sandboxCallable,
      definition.functionId,
      definition.invocation ?? "action",
      definition.scope,
    );
  for (const action of actions)
    add(
      action.description,
      action.sandboxCallable,
      functionOf(action.description.name),
      "action",
      "conversation",
      action.permission,
    );
  return [...tools.values()].sort((left, right) => left.name.localeCompare(right.name));
}
