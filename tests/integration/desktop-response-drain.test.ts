import { describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { childEnvironment } from "../../src/desktop/backend";
import { BUSINESS_MIGRATION_FILES } from "../../src/server/db/schema-gate";
import { DESKTOP_ACCESS_HEADER } from "../../src/server/desktop-access";
import { HttpResponseDrain } from "../../src/server/http-response-drain";

const TOKEN = "d8".repeat(32);
const entrypoint = path.resolve(import.meta.dir, "../../src/server/index.ts");
const EXIT_BUDGET_MS = 2_000;
const RESPONSE_BYTES = 32 * 1024 * 1024;

function fixture() {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "superstring-response-drain-"));
  const profile = path.join(root, "profile");
  const resources = path.join(root, "resources");
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(path.join(resources, "migrations/versions"), { recursive: true });
  mkdirSync(path.join(resources, "web"));
  const index = path.join(resources, "web/index.html");
  writeFileSync(index, "<!doctype html><body>");
  truncateSync(index, RESPONSE_BYTES);
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

function start(f: ReturnType<typeof fixture>) {
  const env = childEnvironment(process.env, f.profile, f.resources, TOKEN);
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
      () => reject(new Error(`server readiness timed out: ${diagnostic}`)),
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
  });
  return {
    child,
    closed,
    ready,
    diagnostic: () => diagnostic,
    stop: async (closePausedResponse?: () => void) => {
      closePausedResponse?.();
      child.stdin.end();
      await closed;
      lines.close();
    },
  };
}

function openPausedResponse(
  origin: string,
): Promise<{ bytesReceived: number; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    let bytesReceived = 0;
    const req = request(
      new URL("/", origin),
      { agent: false, headers: { [DESKTOP_ACCESS_HEADER]: TOKEN } },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          bytesReceived += chunk.byteLength;
          res.pause();
          resolve({ bytesReceived, destroy: () => req.destroy() });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForExit(closed: Promise<number | null>) {
  return Promise.race([
    closed.then((code) => ({ exited: true as const, code })),
    new Promise<{ exited: false }>((resolve) =>
      setTimeout(() => resolve({ exited: false }), EXIT_BUDGET_MS),
    ),
  ]);
}

describe("desktop response drain ownership", () => {
  it("releases after shutdown cancellation settles, including stream persistence", async () => {
    let settlePersistence!: () => void;
    const persisted = new Promise<void>((resolve) => {
      settlePersistence = resolve;
    });
    let releases = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1));
      },
      async cancel() {
        await persisted;
      },
    });
    const drain = new HttpResponseDrain(() => releases++);
    const response = drain.wrap(new Response(source));
    const body = response.body;
    if (!body) throw new Error("response has no body");
    const responseReader = body.getReader();
    await responseReader.read();
    const cancellation = drain.cancelActive();
    await Promise.resolve();
    expect(releases).toBe(0);
    settlePersistence();
    await cancellation;
    expect(releases).toBe(1);
  });

  it("keeps ownership through a pending read until shutdown cancellation persistence settles", async () => {
    let settlePersistence!: () => void;
    const persisted = new Promise<void>((resolve) => {
      settlePersistence = resolve;
    });
    let releases = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1));
      },
      cancel: () => persisted,
    });
    const drain = new HttpResponseDrain(() => releases++);
    const response = drain.wrap(new Response(source));
    const body = response.body;
    if (!body) throw new Error("response has no body");
    const reader = body.getReader();
    await reader.read();
    const pendingRead = reader.read();
    const cancellation = drain.cancelActive();
    await pendingRead;
    expect(releases).toBe(0);
    settlePersistence();
    await cancellation;
    expect(releases).toBe(1);
  });

  it("releases exactly once when shutdown cancellation and outer cancellation overlap", async () => {
    let settleCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      settleCancellation = resolve;
    });
    let releases = 0;
    const source = new ReadableStream<Uint8Array>({ cancel: () => cancellation });
    const drain = new HttpResponseDrain(() => releases++);
    const response = drain.wrap(new Response(source));
    const body = response.body;
    if (!body) throw new Error("response has no body");
    const outer = body.cancel();
    const shutdown = drain.cancelActive();
    settleCancellation();
    await Promise.all([outer, shutdown]);
    expect(releases).toBe(1);
  });

  it("releases exactly once across EOF and a later shutdown cancellation", async () => {
    let releases = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const drain = new HttpResponseDrain(() => releases++);
    const response = drain.wrap(new Response(source));
    const body = response.body;
    if (!body) throw new Error("response has no body");
    const reader = body.getReader();
    expect((await reader.read()).done).toBe(true);
    await drain.cancelActive();
    expect(releases).toBe(1);
  });

  it("settles a native HTTP response left unread under socket backpressure before shutdown", async () => {
    const f = fixture();
    const running = start(f);
    let paused: Awaited<ReturnType<typeof openPausedResponse>> | undefined;
    try {
      const origin = await running.ready;
      paused = await openPausedResponse(origin);
      expect(paused.bytesReceived).toBeGreaterThan(0);
      running.child.stdin.end();
      const result = await waitForExit(running.closed);
      expect(result).toEqual({ exited: true, code: 0 });
      paused.destroy();
    } finally {
      paused?.destroy();
      await running.stop(paused?.destroy);
      f.dispose();
    }
  }, 60_000);
});
