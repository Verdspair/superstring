import { z } from "zod";
import type { SharedActionDescription } from "./agent-action-descriptions";
import type { PermissionRequirement } from "./permissions";

export interface ToolDefinition {
  description: SharedActionDescription;
  permission?: PermissionRequirement;
  sandboxCallable?: boolean;
}

export interface ToolDescriptor extends Omit<SharedActionDescription, "effect"> {
  readonly effect: "read" | "write";
  readonly sandboxCallable: boolean;
}

export function describeTool(action: ToolDefinition): ToolDescriptor {
  const effect = action.description.effect ?? "write";
  return Object.freeze({
    ...action.description,
    effect,
    sandboxCallable: effect === "read" && action.sandboxCallable !== false,
  });
}

export const SystemFunctionIdSchema = z.enum([
  "memory-query",
  "knowledge-query",
  "web-access",
  "media-stickers",
  "execution-limits",
  "session-history-summary",
  "qq-members",
  "qq-reply",
]);
export type SystemFunctionId = z.infer<typeof SystemFunctionIdSchema>;

export const ToolDirectoryInvocationSchema = z.enum(["action", "host-terminal"]);
export const ToolDirectoryScopeSchema = z.enum(["conversation", "qq-conversation", "qq-group"]);
export type ToolDirectoryInvocation = z.infer<typeof ToolDirectoryInvocationSchema>;
export type ToolDirectoryScope = z.infer<typeof ToolDirectoryScopeSchema>;

export const ToolDirectoryEntrySchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  capability: z.string(),
  effect: z.enum(["read", "write"]),
  sandboxCallable: z.boolean(),
  origin: z.enum(["system", "mcp"]),
  invocation: ToolDirectoryInvocationSchema,
  scope: ToolDirectoryScopeSchema,
  globalEnabled: z.boolean(),
  functionId: SystemFunctionIdSchema.nullable(),
  resource: z.string().nullable(),
  revision: z.string().nullable(),
  approvalRequired: z.boolean(),
  directories: z.array(z.string()),
});
export type ToolDirectoryEntry = z.infer<typeof ToolDirectoryEntrySchema>;

export const ToolDirectoryResponseSchema = z.strictObject({
  tools: z.array(ToolDirectoryEntrySchema),
});
export type ToolDirectoryResponse = z.infer<typeof ToolDirectoryResponseSchema>;

export interface SystemComponentTarget {
  kind: "tool" | "skill" | "mcp";
  id: string;
}
