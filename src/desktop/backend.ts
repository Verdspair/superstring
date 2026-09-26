import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { createInterface } from "node:readline";

export interface DesktopStatus {
  app: "superstring";
  desktop: true;
  state: "ready";
  close_action: "background" | "exit";
  page_connections: number;
}

export interface BackendOptions {
  executable: string;
  args?: string[];
  profileRoot: string;
  resourceRoot: string;
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
  return Object.assign(env, {
    SUPERSTRING_APP_MODE: "desktop",
    SUPERSTRING_DESKTOP_MANAGED: "1",
    SUPERSTRING_APP_ROOT: profileRoot,
    SUPERSTRING_RESOURCE_ROOT: resourceRoot,
    SUPERSTRING_DESKTOP_TOKEN: token,
    SUPERSTRING_DESKTOP_AUTO_PORT: "1",
    SUPERSTRING_SERVE_WEB: "1",
  });
}

/** Owns precisely one child. Stop settles only after the child's database shutdown completes. */
export class DesktopBackend {
  readonly token = randomBytes(32).toString("hex");
  origin: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private expectedExit = false;

  constructor(private readonly options: BackendOptions) {}

  async start(): Promise<string> {
    if (this.child || this.expectedExit) throw new Error("DESKTOP_BACKEND_ALREADY_STARTED");
    const child = spawn(this.options.executable, this.options.args ?? [], {
      cwd: this.options.profileRoot,
      env: childEnvironment(
        this.options.env ?? process.env,
        this.options.profileRoot,
        this.options.resourceRoot,
        this.token,
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
      return origin;
    } catch (error) {
      // EOF is also understood during startup, including a migration failure.
      void this.stop();
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
      if (this.origin) {
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

  private log(message: string): void {
    this.options.log(message.replaceAll(this.token, "[desktop credential]"));
  }
}
