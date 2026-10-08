import { describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { serve } from "bun";
import { childEnvironment } from "../../src/desktop/backend";
import { BUSINESS_MIGRATION_FILES } from "../../src/server/db/schema-gate";
import { DESKTOP_ACCESS_HEADER } from "../../src/server/desktop-access";

const TOKEN = "c4".repeat(32);
const entrypoint = path.resolve(import.meta.dir, "../../src/server/index.ts");
const CLOSE_BUDGET_MS = 15_000;
const HANDSHAKE_BUDGET_MS = 10_000;
// Observed pre-fix shutdown sat on a fixed pre-abort idle wait (~5s) before the
// abort even fired; after cancelling that wait first, a parked-models EOF exit
// is bounded well below that. generous, synthetic-only budget.
const EOF_EXIT_BUDGET_MS = 2_000;

function fixture() {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "superstring-shutdown-"));
  const profile = path.join(root, "profile");
  const resources = path.join(root, "resources");
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(path.join(resources, "migrations/versions"), { recursive: true });
  mkdirSync(path.join(resources, "web"));
  writeFileSync(
    path.join(resources, "web/index.html"),
    "<!doctype html><html><head></head><body>synthetic shutdown</body></html>",
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
    req.setTimeout(5_000, () => req.destroy(new Error("synthetic request timed out")));
    req.on("error", reject);
    req.end();
  });
}

interface Started {
  ready: Promise<string>;
  closed: Promise<number | null>;
  exited: Promise<number | null>;
  child: ChildProcessWithoutNullStreams;
  diagnostic: () => string;
  eof: () => void;
  stop: () => Promise<void>;
}

function start(f: ReturnType<typeof fixture>, overrides: Record<string, string> = {}): Started {
  const env = childEnvironment(process.env, f.profile, f.resources, TOKEN);
  env.LM_STUDIO_BASE_URL = "http://127.0.0.1:9/v1";
  Object.assign(env, overrides);
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
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
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
    void exited.then((code) => {
      clearTimeout(timeout);
      reject(new Error(`sidecar exited ${code} before readiness: ${diagnostic}`));
    });
  });
  let eofIssued = false;
  const eof = () => {
    if (eofIssued) return;
    eofIssued = true;
    child.stdin.end();
  };
  async function stop(): Promise<void> {
    eof();
    const cleanupDeadline = setTimeout(() => child.kill("SIGKILL"), CLOSE_BUDGET_MS);
    try {
      await closed;
    } finally {
      clearTimeout(cleanupDeadline);
      lines.close();
    }
  }
  return {
    ready,
    closed,
    exited,
    child,
    diagnostic: () => diagnostic,
    eof,
    stop,
  };
}

/** Open the conversation change stream and hold it without consuming to EOF. */
async function openChangeStream(origin: string) {
  const controller = new AbortController();
  const response = await fetch(new URL("/v2/conversations/changes", origin), {
    headers: { [DESKTOP_ACCESS_HEADER]: TOKEN },
    signal: controller.signal,
  });
  if (response.status !== 200) throw new Error(`changes status ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const first = await reader.read();
  return {
    controller,
    reader,
    firstChunk: new TextDecoder().decode(first.value ?? new Uint8Array()),
  };
}

/**
 * Model service stub: answers the OpenAI catalog, holds one exact path open.
 * Every hit is recorded so a failed handshake reports what actually arrived.
 */
function modelStub(holdPath: string) {
  const hits: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stub = serve({
    port: 0,
    // Hold the parked request for the whole observation window: Bun's idle
    // timeout must never be the thing that releases the gateway call.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      hits.push(`${req.method} ${url.pathname}`);
      if (url.pathname === holdPath) {
        release();
        await new Promise(() => {});
        return new Response(null, { status: 500 });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "stub-model" }] });
      }
      return Response.json({ data: [{ id: "stub-model" }] });
    },
  });
  return {
    stub,
    hits: () => hits,
    url: () => `http://127.0.0.1:${stub.port}/v1`,
    held: async () => {
      const winner = await Promise.race([
        held.then(() => true as const),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), HANDSHAKE_BUDGET_MS)),
      ]);
      return { reached: winner, hits: hits.slice() };
    },
  };
}

async function awaitExit(closed: Promise<number | null>) {
  return Promise.race([
    closed.then((code) => ({ closed: true as const, code })),
    new Promise<{ closed: false }>((resolve) =>
      setTimeout(() => resolve({ closed: false }), CLOSE_BUDGET_MS),
    ),
  ]);
}

describe("desktop shutdown lifecycle", () => {
  it("closes promptly on host EOF with no connections (baseline)", async () => {
    const f = fixture();
    const running = start(f);
    try {
      const origin = await running.ready;
      expect((await http(origin, "/agents", { [DESKTOP_ACCESS_HEADER]: TOKEN })).status).toBe(200);
      const began = Date.now();
      running.eof();
      expect(await running.closed).toBe(0);
      expect(Date.now() - began).toBeLessThan(CLOSE_BUDGET_MS);
    } finally {
      await running.stop();
      f.dispose();
    }
  }, 60_000);

  it("closes promptly on host EOF while a conversation change stream is connected", async () => {
    const f = fixture();
    const running = start(f);
    try {
      const origin = await running.ready;
      const stream = await openChangeStream(origin);
      expect(stream.firstChunk).toContain("ready");
      const began = Date.now();
      // Host EOF while the stream is still connected: graceful shutdown must
      // settle the stream and exit, no client-side abort and no kill.
      running.eof();
      expect(await running.closed).toBe(0);
      expect(Date.now() - began).toBeLessThan(CLOSE_BUDGET_MS);
      stream.controller.abort();
    } finally {
      await running.stop();
      f.dispose();
    }
  }, 60_000);

  it("closes promptly on host EOF after the browser already disconnected the stream", async () => {
    const f = fixture();
    const running = start(f);
    try {
      const origin = await running.ready;
      const stream = await openChangeStream(origin);
      stream.controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const began = Date.now();
      running.eof();
      expect(await running.closed).toBe(0);
      expect(Date.now() - began).toBeLessThan(CLOSE_BUDGET_MS);
    } finally {
      await running.stop();
      f.dispose();
    }
  }, 60_000);

  it("closes on host EOF while a models-list pre-response is parked on a hung model service", async () => {
    const f = fixture();
    const { stub, hits, url, held } = modelStub("/v1/models");
    const running = start(f, { LM_STUDIO_BASE_URL: url() });
    try {
      const origin = await running.ready;
      void fetch(new URL("/models/local", origin), {
        headers: { [DESKTOP_ACCESS_HEADER]: TOKEN },
      }).catch(() => {});
      const handshake = await held();
      if (!handshake.reached) {
        throw new Error(
          `model stub never received ${"/v1/models"} within ${HANDSHAKE_BUDGET_MS}ms; stub hits: ${JSON.stringify(handshake.hits)}; base=${url()}`,
        );
      }
      // The pre-shutdown idle wait must be cancelled, not waited out: nothing
      // here produces in-flight traffic, so EOF should reach a full process
      // exit without a fixed drain delay. The clock starts immediately before
      // EOF and ends at the real exit event of this parked-models probe only.
      const began = Date.now();
      running.eof();
      const winner = await awaitExit(running.exited);
      if (!winner.closed) {
        throw new Error(
          `shutdown did not settle within ${CLOSE_BUDGET_MS}ms while a models-list request was parked on a hung model service; stub hits: ${JSON.stringify(hits())}; stderr: ${running.diagnostic().slice(-2000)}`,
        );
      }
      expect(winner.code).toBe(0);
      expect(Date.now() - began).toBeLessThan(EOF_EXIT_BUDGET_MS);
    } finally {
      await running.stop();
      stub.stop(true);
      f.dispose();
    }
  }, 60_000);
});
