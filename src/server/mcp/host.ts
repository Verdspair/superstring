import { createHash } from "node:crypto";
import type { McpServerConfig, McpServerState, McpServerStatus } from "../../shared/contracts/mcp";
import type { BuiltInAction } from "../agent/built-in-actions";
import { PermissionError } from "../permissions/service";
import { createMcpActions, type McpToolSource } from "./actions";
import { connectMcpServer, type McpConnectOptions, type McpSession } from "./client";
import { loadMcpRegistry, type McpRegistry, readMcpRegistry } from "./config";

export interface McpHostDiagnostic {
  readonly serverId: string;
  readonly code: string;
}
export interface McpToolHostOptions {
  readonly configPath: string;
  readonly env?: Record<string, string | undefined>;
  readonly onDiagnostic?: (event: McpHostDiagnostic) => void;
  readonly signal?: AbortSignal;
  readonly connect?: (server: McpServerConfig, options: McpConnectOptions) => Promise<McpSession>;
}
interface Connected {
  revision: string;
  source: McpToolSource;
}
const revisionOf = (server: McpServerConfig) =>
  createHash("sha256").update(JSON.stringify(server)).digest("hex");

export class McpToolHost {
  private readonly connections = new Map<string, Connected>();
  private readonly diagnostics = new Map<string, string>();
  private readonly lifetime = new AbortController();
  private actions: BuiltInAction[] = [];
  private lastRevision: string | null = null;
  private reloading?: Promise<void>;
  constructor(private readonly options: McpToolHostOptions) {}

  /**
   * 管理面的状态投影：文件事实（含坏文件的码）+ 本进程的连接结果。
   * 登记文件与已建连接不同修订时一律显示 pending——保存成功不等于连接成功。
   */
  status(): McpServerStatus[] {
    if (this.lifetime.signal.aborted) return [];
    const registry = readMcpRegistry(this.options.configPath);
    const stale = this.lastRevision !== registry.revision;
    return registry.servers.map((config) => {
      const connection = this.connections.get(config.id);
      const failure = this.diagnostics.get(config.id) ?? null;
      const state: McpServerState = !config.enabled
        ? "disabled"
        : !stale && connection
          ? "connected"
          : !stale && failure
            ? "error"
            : "pending";
      return {
        config,
        state,
        code: state === "error" ? (failure ?? "MCP_CONNECT_FAILED") : null,
        tools:
          connection && !stale
            ? connection.source.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                readOnly: tool.readOnly,
              }))
            : [],
      };
    });
  }

  current(): readonly BuiltInAction[] {
    if (this.lifetime.signal.aborted) return [];
    try {
      if (loadMcpRegistry(this.options.configPath).revision !== this.lastRevision) {
        this.actions = [];
        void this.reload();
      }
    } catch {
      return [];
    }
    return this.actions;
  }
  start(): Promise<void> {
    return this.reload();
  }
  reload(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (this.reloading) return this.reloading;
    this.reloading = this.doReload().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }
  async stop(): Promise<void> {
    this.lifetime.abort(new PermissionError("MCP_HOST_STOPPED"));
    this.actions = [];
    await this.reloading;
    await Promise.all(
      [...this.connections.values()].map((connection) => connection.source.session.close()),
    );
    this.connections.clear();
  }
  private report(serverId: string, error: unknown): void {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "MCP_CONNECT_FAILED";
    this.diagnostics.set(serverId, code);
    try {
      this.options.onDiagnostic?.({ serverId, code });
    } catch {
      /* Diagnostics do not own connection lifecycle. */
    }
  }
  private async doReload(): Promise<void> {
    let registry: McpRegistry;
    try {
      registry = loadMcpRegistry(this.options.configPath);
    } catch (error) {
      this.actions = [];
      this.report("-", error);
      return;
    }
    this.actions = [];
    const wanted = registry.servers.filter((server) => server.enabled);
    for (const [id, connection] of this.connections) {
      const server = wanted.find((entry) => entry.id === id);
      if (!server || revisionOf(server) !== connection.revision) {
        this.connections.delete(id);
        await connection.source.session.close();
      }
    }
    const signal = this.options.signal
      ? AbortSignal.any([this.lifetime.signal, this.options.signal])
      : this.lifetime.signal;
    for (const server of wanted) {
      if (signal.aborted) break;
      if (this.connections.has(server.id)) continue;
      let session: McpSession | undefined;
      try {
        session = await (this.options.connect ?? connectMcpServer)(server, {
          env: this.options.env,
          signal,
        });
        const tools = await session.listTools(signal);
        signal.throwIfAborted();
        const revision = revisionOf(server);
        const connection: Connected = {
          revision,
          source: {
            config: server,
            session,
            tools,
            assertAvailable: () => {
              const current = loadMcpRegistry(this.options.configPath).servers.find(
                (entry) => entry.id === server.id,
              );
              if (
                this.lifetime.signal.aborted ||
                this.connections.get(server.id) !== connection ||
                !current?.enabled ||
                revisionOf(current) !== revision
              )
                throw new PermissionError("PERMISSION_REVISION_CHANGED");
            },
          },
        };
        this.connections.set(server.id, connection);
        this.diagnostics.delete(server.id);
      } catch (error) {
        await session?.close();
        if (!signal.aborted) this.report(server.id, error);
      }
    }
    this.lastRevision = registry.revision;
    if (!signal.aborted)
      this.actions = createMcpActions({
        sources: [...this.connections.values()].map((entry) => entry.source),
      });
  }
}
