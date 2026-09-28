// MCP 服务登记的编辑草稿（P7-d）：纯函数，便于单测；面板只做展示与提交。
//
// 凭据只以变量引用出现（`$VAR` 或变量名），这里不解析也不展开环境变量值。

import { type McpServerConfig, McpServerSchema } from "../../../shared/contracts/mcp";

export interface McpServerDraft {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  enabled: boolean;
  /** stdio：可执行文件、每行一个参数、每行 KEY=VALUE 的环境引用。 */
  command: string;
  args: string;
  env: string;
  /** http / sse：地址与承载 Bearer 令牌的本机变量名。 */
  url: string;
  authorizationEnv: string;
  timeoutMs: string;
  maxResultChars: string;
}

export type McpDraftProblem = "id" | "name" | "command" | "url" | "args" | "env" | "numbers";

export function draftOf(config: McpServerConfig): McpServerDraft {
  return {
    id: config.id,
    name: config.name,
    transport: config.transport,
    enabled: config.enabled,
    command: config.transport === "stdio" ? config.command : "",
    args: config.transport === "stdio" ? config.args.join("\n") : "",
    env:
      config.transport === "stdio"
        ? Object.entries(config.env)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n")
        : "",
    url: config.transport === "stdio" ? "" : config.url,
    authorizationEnv: config.transport === "stdio" ? "" : (config.authorizationEnv ?? ""),
    timeoutMs: String(config.timeoutMs),
    maxResultChars: String(config.maxResultChars),
  };
}

export function emptyDraft(): McpServerDraft {
  return {
    id: "",
    name: "",
    transport: "stdio",
    enabled: false,
    command: "",
    args: "",
    env: "",
    url: "",
    authorizationEnv: "",
    timeoutMs: "15000",
    maxResultChars: "8000",
  };
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function envPairs(value: string): Record<string, string> | null {
  const entries: [string, string][] = [];
  for (const line of lines(value)) {
    const at = line.indexOf("=");
    if (at <= 0) return null;
    entries.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return Object.fromEntries(entries);
}

/** 草稿 → 契约条目；不合法时给出可定位的问题名，不猜值。 */
export function serverPayload(
  draft: McpServerDraft,
): { ok: true; server: McpServerConfig } | { ok: false; problem: McpDraftProblem } {
  const env = draft.transport === "stdio" ? envPairs(draft.env) : {};
  if (env === null) return { ok: false, problem: "env" };
  const timeoutMs = Number(draft.timeoutMs);
  const maxResultChars = Number(draft.maxResultChars);
  if (!Number.isFinite(timeoutMs) || !Number.isFinite(maxResultChars))
    return { ok: false, problem: "numbers" };
  const common = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    enabled: draft.enabled,
    timeoutMs,
    maxResultChars,
  };
  const candidate =
    draft.transport === "stdio"
      ? {
          ...common,
          transport: "stdio" as const,
          command: draft.command.trim(),
          args: lines(draft.args),
          env,
        }
      : {
          ...common,
          transport: draft.transport,
          url: draft.url.trim(),
          ...(draft.authorizationEnv.trim()
            ? { authorizationEnv: draft.authorizationEnv.trim() }
            : {}),
        };
  const parsed = McpServerSchema.safeParse(candidate);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") ?? "";
    if (path.startsWith("id")) return { ok: false, problem: "id" };
    if (path.startsWith("name")) return { ok: false, problem: "name" };
    if (path.startsWith("command")) return { ok: false, problem: "command" };
    if (path.startsWith("url")) return { ok: false, problem: "url" };
    if (path.startsWith("args")) return { ok: false, problem: "args" };
    return { ok: false, problem: "numbers" };
  }
  return { ok: true, server: parsed.data };
}

/** originalId 为空＝新增；否则按原 id 替换（改 id 也走这里）。 */
export function upsertServer(
  servers: readonly McpServerConfig[],
  server: McpServerConfig,
  originalId: string | null,
): McpServerConfig[] {
  const at = originalId === null ? -1 : servers.findIndex((entry) => entry.id === originalId);
  if (at < 0) return [...servers, server];
  return servers.map((entry, index) => (index === at ? server : entry));
}

export function removeServer(servers: readonly McpServerConfig[], id: string): McpServerConfig[] {
  return servers.filter((entry) => entry.id !== id);
}
