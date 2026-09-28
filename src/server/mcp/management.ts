// MCP 管理端口（P7-b）：登记文件的读写与连接状态都经同一宿主，页面不另起平行客户端。
//
// 「保存成功」只证明文件已写入并进入重新发现；「连接成功」是随后 reload 的结果，
// 两者分开呈现（单台失败不清空其余连接，也不把保存说成连上了）。

import type { McpServerConfig, McpStatusResponse } from "../../shared/contracts/mcp";
import { readMcpRegistry, writeMcpRegistry } from "./config";
import type { McpToolHost } from "./host";

export interface McpManagement {
  status(): McpStatusResponse;
  /** 写入并触发后台重新发现；返回写入后的快照（连接结果随后由 status/reload 给出）。 */
  update(expectedRevision: string, servers: readonly McpServerConfig[]): McpStatusResponse;
  /** 显式重新连接与发现，等这次结果。 */
  reload(): Promise<McpStatusResponse>;
}

export function createMcpManagement(options: {
  configPath: string;
  host: McpToolHost;
}): McpManagement {
  const status = (): McpStatusResponse => {
    const registry = readMcpRegistry(options.configPath);
    return {
      revision: registry.revision,
      code: registry.code,
      servers: registry.code ? [] : options.host.status(),
    };
  };
  return {
    status,
    update(expectedRevision, servers) {
      writeMcpRegistry(options.configPath, expectedRevision, servers);
      void options.host.reload();
      return status();
    },
    async reload() {
      await options.host.reload();
      return status();
    },
  };
}
