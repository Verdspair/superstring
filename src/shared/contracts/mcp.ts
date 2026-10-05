import { z } from "zod";

export const McpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "服务器 id 只能用小写字母、数字与连字符");

/**
 * 单次请求（含 tools/call）的墙钟上限（ms）；单次调用结果进入模型上下文前的字符上限
 * （超了判失败，不截断）。管理草稿 UI 与这里共用同一默认值，避免两处数字漂移。
 */
export const MCP_TIMEOUT_MS_DEFAULT = 15_000;
export const MCP_MAX_RESULT_CHARS_DEFAULT = 8_000;

const serverCommon = {
  id: IdSchema,
  name: z.string().min(1).max(100),
  enabled: z.boolean().default(false),
  trustToolAnnotations: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).default(MCP_TIMEOUT_MS_DEFAULT),
  maxResultChars: z.number().int().min(1).max(200_000).default(MCP_MAX_RESULT_CHARS_DEFAULT),
};

export const McpServerSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    ...serverCommon,
    transport: z.literal("stdio"),
    command: z.string().min(1).max(500),
    args: z.array(z.string().max(500)).max(50).default([]),
    /** 追加给子进程的环境变量；值可引用本机变量（`$NAME`／`${NAME}`），不落真实凭据。 */
    env: z.record(z.string(), z.string().max(2_000)).default({}),
  }),
  z.strictObject({
    ...serverCommon,
    transport: z.literal("http"),
    url: z.string().url().max(2_000),
    /** 承载 Bearer 令牌的本机环境变量名；省略＝不带 Authorization。 */
    authorizationEnv: z.string().min(1).max(200).optional(),
  }),
  z.strictObject({
    ...serverCommon,
    transport: z.literal("sse"),
    url: z.string().url().max(2_000),
    authorizationEnv: z.string().min(1).max(200).optional(),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const McpServersFileSchema = z.strictObject({
  version: z.literal(1),
  servers: z.array(McpServerSchema).max(20).default([]),
});
export type McpServersFile = z.infer<typeof McpServersFileSchema>;

// ---- 管理面（P7-b）：登记文件读写与连接状态投影 --------------------------------
// 保存成功与连接成功是两件事：`revision` 只证明文件已写入；`state` 反映这次进程里的
// 连接结果。凭据仍只以变量名出现（值连接时从本机环境读，回包不展开）。

export const McpServerStateSchema = z.enum(["disabled", "pending", "connected", "error"]);
export type McpServerState = z.infer<typeof McpServerStateSchema>;

export const McpToolSummarySchema = z.strictObject({
  name: z.string(),
  description: z.string().nullable(),
  readOnly: z.boolean(),
});

export const McpServerStatusSchema = z.strictObject({
  config: McpServerSchema,
  state: McpServerStateSchema,
  /** 最近一次失败的稳定错误码；连接成功或停用后为 null。 */
  code: z.string().nullable(),
  tools: z.array(McpToolSummarySchema),
});
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpStatusResponseSchema = z.strictObject({
  /** 登记文件内容哈希；缺失为空串，坏文件也给出哈希，便于带修订覆盖修复。 */
  revision: z.string(),
  /** 文件不可读/不合法时为稳定错误码（servers 为空）；正常时为 null。 */
  code: z.string().nullable(),
  servers: z.array(McpServerStatusSchema),
});
export type McpStatusResponse = z.infer<typeof McpStatusResponseSchema>;

export const McpServersUpdateSchema = z.strictObject({
  expectedRevision: z.string(),
  servers: z.array(McpServerSchema).max(20),
});
export type McpServersUpdate = z.infer<typeof McpServersUpdateSchema>;

/** `tools/list` 的一条工具：annotations 只在服务端明确给了才算数。 */
export interface McpToolInfo {
  readonly name: string;
  readonly description: string | null;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly readOnly: boolean;
}

export interface McpCallResult {
  /** 文本部件拼接；非文本部件只计数（这一版不把图片/资源塞进这条路径）。 */
  readonly text: string;
  readonly isError: boolean;
  readonly omittedParts: number;
  readonly structuredContent?: unknown;
}
