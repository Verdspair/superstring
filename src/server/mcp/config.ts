// 读取与写入 MCP 服务器登记文件（0.4.0 P6 读；P7-b 增管理面写）。
//
// 与其它本机配置一致的三条：文件缺失＝没有登记（不是错误）；文件坏了＝带码拒绝（不猜内容）；
// 每次读取都算一遍内容哈希当**修订号**——策略变了就用新策略，不缓存旧授权。
// 写入用「读原文哈希比较 + 原子替换」：坏文件同样给哈希，因此可以带着修订把文件修好。

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type McpServerConfig, McpServersFileSchema } from "../../shared/contracts/mcp";

export interface McpRegistry {
  /** 文件内容哈希：空文件/缺失时是空串（没有登记）。 */
  readonly revision: string;
  readonly servers: readonly McpServerConfig[];
}

export interface McpRegistryRead {
  readonly revision: string;
  readonly servers: readonly McpServerConfig[];
  /** 读不出来时的稳定错误码；正常与"没有登记"都是 null。 */
  readonly code: string | null;
  /** 失败细节（不带码前缀）。 */
  readonly message: string;
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
/** 带稳定码但不加前缀：调用方（load/管理面）自己决定怎么呈现。 */
function issue(code: string, detail: string): Error {
  return Object.assign(new Error(detail), { code });
}

/** `$NAME` / `${NAME}` → 本机环境变量值；变量缺失就拒绝，不用空串顶替。 */
export function expandEnvValue(value: string, env: Record<string, string | undefined>): string {
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      const found = env[name];
      if (found === undefined)
        throw coded("MCP_CREDENTIAL_MISSING", `环境变量 ${name} 未设置，无法启动该 MCP 服务器`);
      return found;
    },
  );
  return expanded;
}

export function resolveServerEnv(
  server: Extract<McpServerConfig, { transport: "stdio" }>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(server.env).map(([name, value]) => [name, expandEnvValue(value, env)]),
  );
}

export function serverAuthorization(
  server: McpServerConfig,
  env: Record<string, string | undefined>,
): string | null {
  if (server.transport === "stdio" || server.authorizationEnv === undefined) return null;
  const token = env[server.authorizationEnv];
  if (token === undefined || token.trim().length === 0)
    throw coded(
      "MCP_CREDENTIAL_MISSING",
      `环境变量 ${server.authorizationEnv} 未设置，无法连接该 MCP 服务器`,
    );
  return token;
}

/** 只读解析：内容不合法就带码拒绝。 */
export function parseMcpServers(text: string): readonly McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw issue("MCP_CONFIG_INVALID", "MCP 服务器登记文件不是合法 JSON");
  }
  const result = McpServersFileSchema.safeParse(parsed);
  if (!result.success)
    throw issue("MCP_CONFIG_INVALID", `MCP 服务器登记文件不符合契约：${result.error.message}`);
  const seen = new Set<string>();
  for (const server of result.data.servers) {
    if (seen.has(server.id)) throw issue("MCP_CONFIG_INVALID", `MCP 服务器 id 重复：${server.id}`);
    seen.add(server.id);
  }
  return result.data.servers;
}

/**
 * 不抛出的读取：给管理面用——坏文件也要给出内容哈希（那是带修订覆盖修复的凭据），
 * 并把失败压成一个稳定码，让页面能解释而不是崩。
 */
export function readMcpRegistry(
  configPath: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): McpRegistryRead {
  let text: string;
  try {
    text = read(configPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { revision: "", servers: [], code: null, message: "" };
    return {
      revision: "",
      servers: [],
      code: "MCP_CONFIG_UNAVAILABLE",
      message: "MCP 服务器登记文件不可读",
    };
  }
  const revision = createHash("sha256").update(text).digest("hex");
  try {
    return { revision, servers: parseMcpServers(text), code: null, message: "" };
  } catch (error) {
    return {
      revision,
      servers: [],
      code:
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "MCP_CONFIG_INVALID",
      message: error instanceof Error ? error.message : "MCP 服务器登记文件不符合契约",
    };
  }
}

export function loadMcpRegistry(
  configPath: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): McpRegistry {
  const result = readMcpRegistry(configPath, read);
  if (result.code) throw coded(result.code, result.message);
  return { revision: result.revision, servers: result.servers };
}

/** 写入登记文件：expectedRevision 必须等于当前原文哈希；成功返回新修订。 */
export function writeMcpRegistry(
  configPath: string,
  expectedRevision: string,
  servers: readonly McpServerConfig[],
): McpRegistry {
  const current = readMcpRegistry(configPath);
  if (current.revision !== expectedRevision)
    throw issue("MCP_CONFIG_CONFLICT", "MCP 配置已变化，请重新读取后保存");
  const file = McpServersFileSchema.parse({ version: 1, servers });
  const seen = new Set<string>();
  for (const server of file.servers) {
    if (seen.has(server.id)) throw issue("MCP_CONFIG_INVALID", `MCP 服务器 id 重复：${server.id}`);
    seen.add(server.id);
  }
  const text = `${JSON.stringify(file, null, 2)}\n`;
  mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, configPath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve the original write failure. */
    }
    throw error;
  }
  return { revision: createHash("sha256").update(text).digest("hex"), servers: file.servers };
}
