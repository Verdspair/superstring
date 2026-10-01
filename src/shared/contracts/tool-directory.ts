import { z } from "zod";

export const SystemFunctionIdSchema = z.enum([
  "memory-query",
  "knowledge-query",
  "web-access",
  "media-stickers",
  "execution-limits",
  "session-history-summary",
]);
export type SystemFunctionId = z.infer<typeof SystemFunctionIdSchema>;

export const ToolDirectoryEntrySchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  capability: z.string(),
  effect: z.enum(["read", "write"]),
  sandboxCallable: z.boolean(),
  origin: z.enum(["system", "mcp"]),
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
