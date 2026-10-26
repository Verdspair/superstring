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
  catalogPending?: true;
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
  private reloadRequested = false;
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
          ? connection.catalogPending
            ? "pending"
            : "connected"
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
      const registry = loadMcpRegistry(this.options.configPath);
      if (registry.revision !== this.lastRevision) {
        if (this.reloading) this.reloadRequested = true;
        else void this.reload().catch((error) => this.report("-", error));
        this.publish(registry);
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
      if (this.reloadRequested) {
        this.reloadRequested = false;
        void this.reload().catch((error) => this.report("-", error));
      }
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
  private publish(registry: McpRegistry): void {
    if (this.lifetime.signal.aborted) return;
    this.actions = createMcpActions({
      sources: registry.servers.flatMap((server) => {
        const connection = this.connections.get(server.id);
        return server.enabled &&
          connection?.revision === revisionOf(server) &&
          !connection.catalogPending
          ? [connection.source]
          : [];
      }),
    });
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
    // A saved registry starts a new discovery result; old failures are not its result.
    if (registry.revision !== this.lastRevision) this.diagnostics.clear();
    const wanted = registry.servers.filter((server) => server.enabled);
    const closing: Promise<void>[] = [];
    for (const [id, connection] of this.connections) {
      const server = wanted.find((entry) => entry.id === id);
      if (!server || revisionOf(server) !== connection.revision) {
        this.connections.delete(id);
        this.diagnostics.delete(id);
        closing.push(connection.source.session.close());
      }
    }
    this.lastRevision = registry.revision;
    this.publish(registry);
    const signal = this.options.signal
      ? AbortSignal.any([this.lifetime.signal, this.options.signal])
      : this.lifetime.signal;
    await Promise.allSettled([
      ...closing,
      ...wanted.map(async (server) => {
        if (signal.aborted) return;
        let session: McpSession | undefined = this.connections.get(server.id)?.source.session;
        try {
          session ??= await (this.options.connect ?? connectMcpServer)(server, {
            env: this.options.env,
            signal,
            onToolsChanged: () => {
              const connection = this.connections.get(server.id);
              if (!connection || connection.source.session !== session) return;
              // Invalidate only this catalog, retaining its transport for rediscovery.
              this.connections.set(server.id, {
                ...connection,
                catalogPending: true,
                source: { ...connection.source, tools: [] },
              });
              this.actions = this.actions.filter(
                (action) => action.description.capability !== `mcp.${server.id}`,
              );
              if (this.reloading) this.reloadRequested = true;
              else void this.reload().catch((error) => this.report(server.id, error));
            },
            onClosed: () => {
              if (this.connections.get(server.id)?.source.session !== session) return;
              this.connections.delete(server.id);
              this.actions = this.actions.filter(
                (action) => action.description.capability !== `mcp.${server.id}`,
              );
              this.report(
                server.id,
                Object.assign(new Error("MCP connection closed"), { code: "MCP_SERVER_GONE" }),
              );
            },
            onDiagnostic: (code) => this.options.onDiagnostic?.({ serverId: server.id, code }),
          });
          const listingConnection = this.connections.get(server.id);
          const tools = await session.listTools(signal);
          signal.throwIfAborted();
          const currentRegistry = loadMcpRegistry(this.options.configPath);
          const current = currentRegistry.servers.find((entry) => entry.id === server.id);
          const revision = revisionOf(server);
          if (!current?.enabled || revisionOf(current) !== revision)
            throw new PermissionError("PERMISSION_REVISION_CHANGED");
          const existing = this.connections.get(server.id);
          if (listingConnection && existing !== listingConnection) return;
          if (
            existing &&
            !existing.catalogPending &&
            JSON.stringify(existing.source.tools) === JSON.stringify(tools)
          )
            return;
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
          this.publish(currentRegistry);
        } catch (error) {
          if (this.connections.get(server.id)?.source.session === session)
            this.connections.delete(server.id);
          this.actions = this.actions.filter(
            (action) => action.description.capability !== `mcp.${server.id}`,
          );
          await session?.close();
          if (!signal.aborted) this.report(server.id, error);
        }
      }),
    ]);
  }
}
