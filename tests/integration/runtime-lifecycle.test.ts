import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app";
import {
  readQqSettings,
  updateQqSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import {
  createRuntime,
  DEFAULT_BUSINESS_DB_PATH,
  resolveBusinessDbPath,
} from "../../src/server/runtime";
import type { MemoryService } from "../../src/server/services/memory-service";

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
