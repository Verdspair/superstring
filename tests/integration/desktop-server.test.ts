import { describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { childEnvironment } from "../../src/desktop/backend";
import { BUSINESS_MIGRATION_FILES } from "../../src/server/db/schema-gate";
import { DESKTOP_ACCESS_HEADER } from "../../src/server/desktop-access";

const TOKEN = "c4".repeat(32);
const entrypoint = path.resolve(import.meta.dir, "../../src/server/index.ts");

function fixture() {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "superstring-desktop-server-"));
  const profile = path.join(root, "profile");
  const resources = path.join(root, "resources");
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(path.join(resources, "migrations/versions"), { recursive: true });
  mkdirSync(path.join(resources, "web"));
  writeFileSync(
    path.join(resources, "web/index.html"),
    "<!doctype html><html><head></head><body>synthetic desktop</body></html>",
  );
  for (const name of BUSINESS_MIGRATION_FILES) {
    cpSync(
      path.resolve(import.meta.dir, "../../migrations/versions", name),
      path.join(resources, "migrations/versions", name),
    );
  }
  return {
    root,
    profile,
    resources,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function http(origin: string, pathname: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(new URL(pathname, origin), { headers, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error("synthetic desktop request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function start(f: ReturnType<typeof fixture>) {
  const env = childEnvironment(process.env, f.profile, f.resources, TOKEN);
  // No call below requests inference; this also confines an accidental probe
  // to a closed local port instead of an inherited user model service.
  env.LM_STUDIO_BASE_URL = "http://127.0.0.1:9/v1";
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [entrypoint], {
    cwd: f.profile,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnostic += chunk;
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`sidecar readiness timed out: ${diagnostic}`)),
      20_000,
    );
    lines.on("line", (line) => {
      const match = /^SUPERSTRING_DESKTOP_PORT (\d+)$/.exec(line);
      if (!match) return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${match[1]}`);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    void closed.then((code) => {
      clearTimeout(timeout);
      reject(new Error(`sidecar exited ${code} before readiness: ${diagnostic}`));
    });
  });
  async function stop(): Promise<void> {
    child.stdin.end();
    // Only test-created synthetic processes are eligible for fixture cleanup.
    // The production host deliberately never uses a timed hard kill.
    const cleanupDeadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      await closed;
    } finally {
      clearTimeout(cleanupDeadline);
      lines.close();
    }
  }
  return { ready, closed, child, stop };
}

describe("managed desktop source sidecar wiring", () => {
  it("reports authenticated readiness, gates real APIs, exits on host EOF and reopens the same profile", async () => {
    const f = fixture();
    let running = start(f);
    try {
      const origin = await running.ready;
      const control = { Authorization: `Bearer ${TOKEN}` };
      const allowed = { [DESKTOP_ACCESS_HEADER]: TOKEN };
      const status = await http(origin, "/__desktop/status", control);
      expect(status.status).toBe(200);
      expect(JSON.parse(status.body)).toMatchObject({
        app: "superstring",
        desktop: true,
        state: "ready",
      });
      expect((await http(origin, "/agents")).status).toBe(403);
      expect((await http(origin, "/agents", control)).status).toBe(403);
      expect(
        (await http(origin, "/agents", { ...allowed, Origin: "https://example.invalid" })).status,
      ).toBe(403);
      const agents = await http(origin, "/agents", allowed);
      expect(agents.status).toBe(200);
      const agentList = JSON.parse(agents.body) as Array<{ id: string }>;
      expect(agentList.length).toBeGreaterThan(0);
      const page = await http(origin, "/", allowed);
      expect(page.status).toBe(200);
      expect(page.body).toContain('name="desktop-mode"');

      // EOF alone must perform graceful shutdown: no HTTP stop or signal here.
      await running.stop();
      expect(await running.closed).toBe(0);
      running = start(f);
      const reopened = await http(await running.ready, "/agents", allowed);
      expect(reopened.status).toBe(200);
      expect((JSON.parse(reopened.body) as Array<{ id: string }>).map((agent) => agent.id)).toEqual(
        agentList.map((agent) => agent.id),
      );
      await running.stop();
      expect(await running.closed).toBe(0);
    } finally {
      await running.stop();
      f.dispose();
    }
  }, 45_000);
});
