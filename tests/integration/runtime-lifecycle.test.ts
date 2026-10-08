import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createModelProvider } from "../../src/server/db/model-provider-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import {
  readQqSettings,
  updateQqSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import { createSession, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import {
  createRuntime,
  DEFAULT_BUSINESS_DB_PATH,
  resolveBusinessDbPath,
} from "../../src/server/runtime";
import type { MemoryService } from "../../src/server/services/memory-service";
import { PermissionPolicySchema } from "../../src/shared/contracts/permissions";

const testBrowserStateSecret = "runtime-lifecycle-synthetic-secret";
const gateway: ModelGateway = {
  config: {
    baseUrl: "http://synthetic.invalid/v1",
    model: "qwen/test",
    timeoutSeconds: 1,
  },
  async listModels() {
    return ["qwen/test"];
  },
  async loadedContextCapacity() {
    return 32768;
  },
  async probeModelLoaded() {
    return true;
  },
  async complete() {
    return '{"memory":null}';
  },
  async *streamChat() {
    yield "ok";
  },
};
function fakeWorker(log: string[]): MemoryService {
  return {
    start() {
      log.push("worker-start");
    },
    async stop() {
      log.push("worker-stop");
    },
  } as MemoryService;
}

describe("application runtime lifecycle", () => {
  it("resolves the development business database without touching other projects", () => {
    expect(resolveBusinessDbPath({})).toBe(DEFAULT_BUSINESS_DB_PATH);
    expect(resolveBusinessDbPath({ SUPERSTRING_DB_PATH: ":memory:" })).toBe(":memory:");
    expect(resolveBusinessDbPath({ SUPERSTRING_DB_PATH: " data/custom.sqlite " })).toBe(
      path.resolve("data/custom.sqlite"),
    );
  });
  it("mounts business routes without any internal development endpoint", async () => {
    const runtime = createRuntime({
      businessDbPath: ":memory:",
      gateway,
      browserStateSecret: testBrowserStateSecret,
    });
    try {
      expect((await runtime.app.request("/health")).status).toBe(200);
      const sessions = await runtime.app.request("/sessions");
      expect(sessions.status).toBe(200);
      expect(await sessions.json()).toEqual([]);
      for (const endpoint of ["/__dev/ready", "/__dev/probe"]) {
        expect((await runtime.app.request(endpoint)).status).toBe(404);
      }
    } finally {
      await runtime.stop();
    }
  });
  it("shares one stop completion, cancels owners before drain, and closes SQLite after persistence", async () => {
    const log: string[] = [];
    const actualBusiness = openBusinessDb();
    const runtime = createRuntime({
      business: {
        ...actualBusiness,
        close() {
          log.push("business-close");
          actualBusiness.close();
        },
      },
      gateway,
      memoryService: fakeWorker(log),
      browserStateSecret: testBrowserStateSecret,
    });
    let settleDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      settleDrain = resolve;
    });
    runtime.start();
    const first = runtime.stop(drain);
    const second = runtime.stop();
    expect(second).toBe(first);
    expect(log).toEqual(["worker-start", "worker-stop"]);
    expect(() => actualBusiness.db.query("SELECT 1").get()).not.toThrow();
    settleDrain();
    await first;
    expect(log).toEqual(["worker-start", "worker-stop", "business-close"]);
    expect(runtime.stop()).toBe(first);
  });

  it("cancels background owners synchronously before awaiting either worker drain", async () => {
    const log: string[] = [];
    const underlying = openBusinessDb();
    const business = {
      ...underlying,
      close() {
        log.push("business-close");
        underlying.close();
      },
    };
    const runtime = createRuntime({
      business,
      gateway,
      browserStateSecret: testBrowserStateSecret,
    });
    let releaseBot!: () => void;
    let releaseModules!: () => void;
    const botDrain = new Promise<void>((resolve) => {
      releaseBot = resolve;
    });
    const moduleDrain = new Promise<void>((resolve) => {
      releaseModules = resolve;
    });
    const stopBot = runtime.botWorker.stop.bind(runtime.botWorker);
    const stopModules = runtime.modules.stop.bind(runtime.modules);
    runtime.botWorker.stop = () => {
      log.push("bot-stop-start");
      const settled = stopBot();
      return Promise.all([settled, botDrain]).then(() => {
        log.push("bot-stop-finished");
      });
    };
    runtime.modules.stop = () => {
      log.push("modules-stop-start");
      const settled = stopModules();
      return Promise.all([settled, moduleDrain]).then(() => {
        log.push("modules-stop-finished");
      });
    };
    runtime.start();
    const stopping = runtime.stop();
    expect(log).toEqual(["bot-stop-start", "modules-stop-start"]);
    expect(() => business.db.query("SELECT 1").get()).not.toThrow();
    releaseBot();
    releaseModules();
    await stopping;
    expect(log).toContain("bot-stop-finished");
    expect(log).toContain("modules-stop-finished");
    expect(log.slice(-1)).toEqual(["business-close"]);
    expect(() => business.db.query("SELECT 1").get()).toThrow();
  });

  it("hard-exits an owned synthetic child, then recovers committed history and unknown delivery", async () => {
    const dbPath = path.join(tmpdir(), `superstring-shutdown-reopen-${crypto.randomUUID()}.sqlite`);
    const setup = openBusinessDb({ path: dbPath });
    ensureDefaults(setup.orm, "synthetic-model");
    const session = createSession(setup.orm, "committed synthetic history", {
      clientRequestId: `reopen-${crypto.randomUUID()}`,
    });
    const journal = new ConversationEventRepository(setup.db);
    const conversationId = journal.ensureWeb(session.id)?.id;
    if (!conversationId) throw new Error("synthetic session conversation missing");
    journal.append({
      conversationId,
      eventKey: "committed-before-hard-exit",
      kind: "inbound",
      source: { kind: "synthetic", id: "history", revision: "1" },
      occurredAt: "2026-10-08T00:00:00.000Z",
    });
    const outbox = new OutboundIntentRepository(setup.db);
    const intentId = crypto.randomUUID();
    const runId = `run-${intentId}`;
    new AgentRunRepository(setup.db).createRun({
      runId,
      specId: "test",
      specVersion: "1",
      owner: { kind: "conversation", id: conversationId },
      at: "2026-10-08T00:00:00.000Z",
    });
    outbox.commit({
      id: intentId,
      runId,
      conversationId,
      ordinal: 0,
      target: {
        accountId: "synthetic-account",
        conversationKind: "group",
        peerId: "synthetic-peer",
        agentId: session.agentId,
        bindingId: "synthetic-binding",
        bindingEpoch: 1,
      },
      speechKind: "direct_reply",
      sourceThroughSeq: 1,
      deliverBy: "2026-10-09T00:00:00.000Z",
      createdAt: "2026-10-08T00:00:00.000Z",
      expiresAt: "2026-10-09T00:00:00.000Z",
      parts: [{ kind: "text", text: "synthetic" }],
    });
    expect(outbox.claimPart(intentId, "2026-10-08T00:00:01.000Z")?.part.status).toBe("sending");
    setup.close();

    const childProgram = `
      import { openBusinessDb } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/server/db/schema-gate.ts"))};
      import { ConversationEventRepository } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/server/db/conversation-event-repository"))};
      import { OutboundIntentRepository } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/server/db/outbound-intent-repository"))};
      const handle = openBusinessDb({path:${JSON.stringify(dbPath)}});
      const events = new ConversationEventRepository(handle.db).historyRows(${JSON.stringify(conversationId)});
      const delivery = new OutboundIntentRepository(handle.db).get(${JSON.stringify(intentId)});
      if(events.length !== 1 || delivery?.status !== "delivering") process.exit(3);
      console.log("OWNED_SYNTHETIC_DB_OPEN");
      await new Promise(() => {});
    `;
    const child = spawn(process.execPath, ["--eval", childProgram], {
      cwd: path.dirname(dbPath),
      env: {
        ...process.env,
        SUPERSTRING_APP_MODE: undefined,
        SUPERSTRING_DB_PATH: undefined,
        SUPERSTRING_APP_ROOT: undefined,
        SUPERSTRING_RESOURCE_ROOT: undefined,
        SUPERSTRING_DESKTOP_TOKEN: undefined,
        SUPERSTRING_LM_STUDIO_API_KEY: undefined,
        LM_STUDIO_API_KEY: undefined,
        LM_STUDIO_BASE_URL: undefined,
        LM_STUDIO_MODEL: undefined,
        LM_STUDIO_TIMEOUT: undefined,
        SUPERSTRING_QQ_TRANSPORT_KEY_PATH: undefined,
        SUPERSTRING_MODEL_PROVIDER_KEY_PATH: undefined,
        SUPERSTRING_BROWSER_STATE_SECRET: undefined,
        SUPERSTRING_BROWSER_STATE_SECRET_PATH: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    const readiness = await Promise.race([
      new Promise<boolean>((resolve) => {
        const inspect = () => {
          if (stdout.includes("OWNED_SYNTHETIC_DB_OPEN")) return resolve(true);
          if (stderr || child.exitCode !== null) return resolve(false);
          setTimeout(inspect, 5);
        };
        inspect();
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!readiness) {
      child.kill();
      await exit;
      throw new Error(`synthetic owned child did not open fixture DB: ${stderr}`);
    }
    child.kill("SIGKILL");
    expect(await exit).toMatchObject({ signal: "SIGKILL" });

    const reopened = openBusinessDb({ path: dbPath });
    try {
      const recoveredOutbox = new OutboundIntentRepository(reopened.db);
      expect(new ConversationEventRepository(reopened.db).historyRows(conversationId).length).toBe(
        1,
      );
      expect(recoveredOutbox.recover("2026-10-08T00:00:02.000Z")).toBe(1);
      expect(recoveredOutbox.get(intentId)?.status).toBe("unknown");
      expect(recoveredOutbox.pending()).toEqual([]);
    } finally {
      reopened.close();
      Bun.gc(true);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("starts the worker once and stops it before closing the business database", async () => {
    const log: string[] = [];
    const actualBusiness = openBusinessDb();
    const runtime = createRuntime({
      business: {
        ...actualBusiness,
        close() {
          log.push("business-close");
          actualBusiness.close();
        },
      },
      gateway,
      memoryService: fakeWorker(log),
      browserStateSecret: testBrowserStateSecret,
    });
    runtime.start();
    runtime.start();
    await runtime.stop();
    await runtime.stop();
    runtime.start();
    expect(log).toEqual(["worker-start", "worker-stop", "business-close"]);
  });
  it("does not start the worker or change an unknown database when the schema gate fails", () => {
    const log: string[] = [];
    const dbPath = path.join(tmpdir(), `superstring-bad-${crypto.randomUUID()}.sqlite`);
    const invalid = new Database(dbPath);
    invalid.run("CREATE TABLE unexpected(id INTEGER PRIMARY KEY)");
    invalid.run("PRAGMA user_version = 99");
    invalid.close();
    try {
      expect(() =>
        createRuntime({
          businessDbPath: dbPath,
          gateway,
          memoryService: fakeWorker(log),
          browserStateSecret: testBrowserStateSecret,
        }),
      ).toThrow(/REJECT_UNKNOWN_VERSION|REJECT_UNKNOWN_STRUCTURE/);
      expect(log).toEqual([]);
      const preserved = new Database(dbPath);
      try {
        expect(preserved.query("PRAGMA user_version").get()).toEqual({
          user_version: 99,
        });
        expect(preserved.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
          { name: "unexpected" },
        ]);
      } finally {
        preserved.close();
      }
    } finally {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });
  it("gives the QQ transport the key path it was told to use", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-transport-key-"));
    const keyPath = path.join(dir, "qq-transport.key");
    const business = openBusinessDb();
    try {
      const runtime = createRuntime({
        business,
        gateway,
        qqTransportKeyPath: keyPath,
        browserStateSecret: testBrowserStateSecret,
      });
      // Nothing saved yet: the runtime resolves through the SAME path it was given, which is what
      // keeps a saved token readable in an installed layout (the dev default is a different file).
      expect(runtime.qqIntake.connectionConfig()).toBeNull();
      updateQqSettings(business.orm, {
        accountId: "10001",
        enabled: true,
        expectedRevision: 1,
      });
      updateQqTransportConfig(business.orm, {
        endpoint: "ws://127.0.0.1:3000/",
        token: "synthetic-token",
        expectedRevision: readQqSettings(business.orm).revision,
        keyPath,
      });
      expect(runtime.qqIntake.connectionConfig()).toEqual({
        endpoint: "ws://127.0.0.1:3000/",
        token: "synthetic-token",
        accountId: "10001",
      });
      // The page reads the live transport state through this app: the runtime is wired, and it is
      // not connected, which is exactly what "idle" means here.
      const status = await runtime.app.request("/qq/status");
      expect(await status.json()).toEqual({ connection: { phase: "idle", reason: null } });
    } finally {
      business.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the default model limit when only another conversation policy is overridden", async () => {
    let active = 0;
    let peak = 0;
    const runtime = createRuntime({
      businessDbPath: ":memory:",
      browserStateSecret: testBrowserStateSecret,
      botConversationPolicy: { maxSteps: 4 },
      gateway: {
        ...gateway,
        async complete() {
          active += 1;
          peak = Math.max(peak, active);
          await Bun.sleep(10);
          active -= 1;
          return "ok";
        },
      },
    });
    try {
      await Promise.all(
        ["a", "b"].map((id) =>
          runtime.agentRuntime.completeLeaf(
            { id },
            { owner: { kind: "test", id }, messages: [{ role: "user", content: id }] },
          ),
        ),
      );
      // 模型并发缺省 4、同服务 2：只覆盖会话策略不动模型名额，两个任务同服务可真实重叠。
      expect(peak).toBe(2);
    } finally {
      await runtime.stop();
    }
  });

  it("wires the real sandbox only for an enabled policy and a declared model capability", async () => {
    const parent = path.join(import.meta.dir, "../../artifacts/validation/0.4.0/P6");
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(path.join(parent, "policy-"));
    const file = path.join(dir, "permissions.json");
    const policy = new PermissionService(new FilePermissionStore(file));
    const business = openBusinessDb();
    const model = "code-capable";
    ensureDefaults(business.orm, model);
    let enabled = false,
      calls = 0;
    const runtime = createRuntime({
      business,
      permissionConfigPath: file,
      browserStateSecret: testBrowserStateSecret,
      gateway: {
        ...gateway,
        async complete(request) {
          const code = request.tools?.some((tool) => tool.name === "code.run") ?? false;
          expect(code).toBe(enabled && request.model === model);
          if (code && ++calls === 1)
            return JSON.stringify({
              kind: "invoke",
              calls: [
                { name: "code.run", arguments: { script: 'return {conclusion:"sandbox-42"};' } },
              ],
            });
          if (code) expect(JSON.stringify(request.messages)).toContain("sandbox-42");
          return JSON.stringify({
            kind: "final",
            outputs: [{ kind: "generate", targetId: "reply", instructions: "answer" }],
          });
        },
      },
    });
    try {
      createModelProvider(business.orm, {
        id: crypto.randomUUID(),
        name: "fixture",
        baseUrl: "http://synthetic.invalid",
        models: [
          {
            name: model,
            context_window: 65536,
            capabilities: { codeExecution: true, toolCalling: true, parallelToolCalls: true },
          },
        ],
        keyPath: path.join(dir, "unused.key"),
      });
      const session = createSession(business.orm, "sandbox", { modelName: model });
      const chat = async (message: string) => {
        const response = await runtime.app.request("http://localhost/v2/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: session.id,
            client_request_id: crypto.randomUUID(),
            message,
          }),
        });
        const body = await response.text();
        expect(body).toContain("event: completed");
        expect(body).not.toContain("event: failed");
      };
      await chat("default off");
      policy.replace(
        policy.snapshot().revision,
        // 只写要改的键：其余执行分组按缺省值生效（有效值由 executionPolicy 补齐）。
        PermissionPolicySchema.parse({
          version: 1,
          grants: [],
          execution: { code: true, research: false },
        }),
      );
      enabled = true;
      await chat("use code");
      expect(calls).toBe(2);
      const trace = business.db
        .query("SELECT status,code,details FROM runtime_spans WHERE name='agent.code'")
        .get() as { status: string; code: string; details: string };
      expect(trace.status).toBe("completed");
      expect(trace.code).toBe("CODE_COMPLETED");
      expect(JSON.parse(trace.details)).toMatchObject({ orchestration: "code", toolCalls: 0 });
      policy.replace(policy.snapshot().revision, { version: 1, grants: [] });
      enabled = false;
      await chat("off again");
    } finally {
      await runtime.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps createApp pure: constructing an app does not start a worker", async () => {
    const business = openBusinessDb();
    try {
      const app = createApp({
        business,
        gateway,
        browserStateSecret: testBrowserStateSecret,
      });
      expect((await app.request("/sessions")).status).toBe(200);
    } finally {
      business.close();
    }
  });
  it("closes the business database when service construction fails", () => {
    const business = openBusinessDb();
    let closed = false;
    expect(() =>
      createRuntime({
        business: {
          ...business,
          close() {
            closed = true;
            business.close();
          },
        },
        get gateway(): ModelGateway {
          throw new Error("synthetic construction failure");
        },
        browserStateSecret: testBrowserStateSecret,
      }),
    ).toThrow("synthetic construction failure");
    expect(closed).toBe(true);
  });
});
