import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { createInterface } from "node:readline";
import type { HostLayout } from "./host-layout";

export interface DesktopStatus {
  app: "superstring";
  desktop: true;
  state: "ready";
  close_action: "background" | "exit";
  page_connections: number;
}

export interface BackendOptions {
  layout: HostLayout;
  startupTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
  onExit: (expected: boolean, code: number | null, signal: NodeJS.Signals | null) => void;
}

/** Native requests deliberately bypass Chromium/system proxies and never follow redirects. */
export function localRequest(
  origin: string,
  pathname: string,
  token?: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  const url = new URL(pathname, origin);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.origin !== origin) {
    return Promise.reject(new Error("DESKTOP_INVALID_SERVICE_ORIGIN"));
  }
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 64 * 1024) req.destroy(new Error("DESKTOP_INVALID_STATUS_RESPONSE"));
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("DESKTOP_CONTROL_TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}

export function childEnvironment(
  inherited: NodeJS.ProcessEnv,
  profileRoot: string,
  resourceRoot: string,
  token: string,
  layout?: HostLayout,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  // A packaged launch cannot be redirected into an unrelated database or source checkout.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("SUPERSTRING_") ||
      ["NODE_OPTIONS", "BUN_OPTIONS", "BUN_BE_BUN", "NODE_PATH"].includes(key)
    )
      delete env[key];
  }
  const control = {
    SUPERSTRING_DESKTOP_TOKEN: token,
    SUPERSTRING_DESKTOP_AUTO_PORT: "1",
    SUPERSTRING_DESKTOP_WINDOW_OWNED: "1",
    SUPERSTRING_SERVE_WEB: "1",
  } satisfies Record<string, string>;
  // The development host leaves app and resource roots to the server's own derivation.
  if (layout?.mode === "development-legacy")
    return Object.assign(env, control, { SUPERSTRING_DESKTOP_MANAGED: "1" });
  if (layout?.mode === "installed")
    return Object.assign(env, control, {
      SUPERSTRING_APP_MODE: "installed",
      SUPERSTRING_APP_ROOT: layout.appRoot,
      SUPERSTRING_DESKTOP_MANAGED: "1",
    });
  return Object.assign(env, control, {
    SUPERSTRING_APP_MODE: "desktop",
    SUPERSTRING_DESKTOP_MANAGED: "1",
    SUPERSTRING_APP_ROOT: layout?.profileRoot ?? profileRoot,
    SUPERSTRING_RESOURCE_ROOT: layout?.resourceRoot ?? resourceRoot,
  });
}

/** Owns precisely one child. Stop settles only after shutdown unless the outer job owns it. */
export class DesktopBackend {
  readonly token = randomBytes(32).toString("hex");
  origin: string | null = null;
  exitCode: number | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private expectedExit = false;
  private terminated = false;
  private ready = false;

  constructor(private readonly options: BackendOptions) {}

  async start(): Promise<string> {
    if (this.child || this.expectedExit) throw new Error("DESKTOP_BACKEND_ALREADY_STARTED");
    const launch = this.options.layout;
    const child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: childEnvironment(
        this.options.env ?? process.env,
        launch.profileRoot,
        launch.resourceRoot,
        this.token,
        this.options.layout,
      ),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    // A dead child can race a stop command; EPIPE is reported via the exit event instead.
    child.stdin.on("error", (error) => this.log(`stdin: ${error.message}`));
    this.exited = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        this.exitCode = code;
        this.child = null;
        resolve();
        this.options.onExit(this.expectedExit, code, signal);
      });
    });
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    stdout.on("line", (line) => this.log(line));
    stderr.on("line", (line) => this.log(line));
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => fail(new Error("DESKTOP_STARTUP_TIMEOUT")),
          this.options.startupTimeoutMs ?? 120_000,
        );
        const cleanup = () => {
          clearTimeout(timeout);
          stdout.off("line", onLine);
          child.off("error", fail);
          child.off("close", onClose);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = (code: number | null) => fail(new Error(`DESKTOP_SERVICE_EXITED:${code}`));
        const onLine = (line: string) => {
          const match = /^SUPERSTRING_DESKTOP_PORT (\d+)$/.exec(line);
          if (!match) return;
          const port = Number(match[1]);
          if (port < 1 || port > 65535) return fail(new Error("DESKTOP_INVALID_SERVICE_PORT"));
          this.origin = `http://127.0.0.1:${port}`;
          void this.status().then(() => {
            cleanup();
            resolve(this.origin as string);
          }, fail);
        };
        stdout.on("line", onLine);
        child.once("error", fail);
        child.once("close", onClose);
      });
      this.ready = true;
      return origin;
    } catch (error) {
      // Startup errors, including failed migrations, also shut down the child process.
      this.terminate();
      throw error;
    }
  }

  async status(): Promise<DesktopStatus> {
    if (!this.origin) throw new Error("DESKTOP_SERVICE_NOT_READY");
    const response = await localRequest(this.origin, "/__desktop/status", this.token);
    const value = response.status === 200 ? JSON.parse(response.body) : null;
    if (
      value?.app !== "superstring" ||
      value.desktop !== true ||
      value.state !== "ready" ||
      !Number.isInteger(value.page_connections) ||
      value.page_connections < 0 ||
      (value.close_action !== "background" && value.close_action !== "exit")
    ) {
      throw new Error("DESKTOP_SERVICE_IDENTITY_MISMATCH");
    }
    return value;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.expectedExit = true;
    this.stopping = (async () => {
      const child = this.child;
      if (!child) return;
      if (this.ready && this.origin) {
        try {
          await localRequest(this.origin, "/__desktop/stop", this.token, "POST");
        } catch (error) {
          this.log(`stop: ${String(error)}`);
        }
      }
      child.stdin.end();
      await this.exited;
    })();
    return this.stopping;
  }

  /**
   * Immediate ownership hand-off for the outer job owner: the exit is marked expected
   * before stdin closes and the child is signalled. Synchronous, idempotent and never
   * waits for the graceful shutdown the OS job already bounds.
   */
  terminate(): void {
    this.expectedExit = true;
    if (this.terminated) return;
    this.terminated = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    child.kill();
  }

  private log(message: string): void {
    this.options.log(message.replaceAll(this.token, "[desktop credential]"));
  }
}
