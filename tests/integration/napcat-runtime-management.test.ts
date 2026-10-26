import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAppPaths } from "../../src/server/app-paths";
import {
  readQqSettings,
  updateQqSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type { BotEvidenceScope } from "../../src/server/modules/conversation-evidence";
import { loadConversationEvidence } from "../../src/server/modules/conversation-evidence-store";
import type {
  createNapCatManagedSession,
  NapCatManagedSession,
} from "../../src/server/napcat/management";
import { createRuntime } from "../../src/server/runtime";
import { runtimeFixtureBusiness } from "../harness/business-db";

type ManagedSessionFactoryOptions = Parameters<typeof createNapCatManagedSession>[0];
type ManagedSessionFactory = typeof createNapCatManagedSession;

const CONFIG = "/v2/qq/managed-component/config";
const STATUS = "/v2/qq/managed-component/status";
const MODEL = "qwen/qwen3-4b-2507";
const gateway: ModelGateway = {
  config: { baseUrl: "http://synthetic.invalid/v1", model: MODEL, timeoutSeconds: 1 },
  async listModels() {
    return [MODEL];
  },
  async loadedContextCapacity() {
    return 32768;
  },
  async probeModelLoaded() {
    return true;
  },
  async complete() {
    return "{}";
  },
  async *streamChat() {
    yield "ok";
  },
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "napcat-runtime-management-"));
  directories.push(directory);
  return directory;
}

async function runtimeFor(
  napcatConfigPath?: string,
  managedSession?: { runtimeConfigPath?: string; factory: ManagedSessionFactory },
) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const options = {
    business,
    gateway,
    browserStateSecret: "synthetic-runtime-management-secret",
    ...(napcatConfigPath ? { napcatConfigPath } : {}),
    ...(managedSession
      ? {
          ...(managedSession.runtimeConfigPath
            ? { napcatRuntimeConfigPath: managedSession.runtimeConfigPath }
            : {}),
          napcatManagedSessionFactory: managedSession.factory,
        }
      : {}),
  };
  return await createRuntime(options);
}

function managedSessionHarness(onStop?: () => Promise<void>) {
  const state: {
    factoryCalls: number;
    runtimeLoadCalls: number;
    startCalls: number;
    stopCalls: number;
    loadRuntime?: ManagedSessionFactoryOptions["loadRuntime"];
  } = { factoryCalls: 0, runtimeLoadCalls: 0, startCalls: 0, stopCalls: 0 };
  const factory: ManagedSessionFactory = (options) => {
    state.factoryCalls += 1;
    state.loadRuntime = async () => {
      state.runtimeLoadCalls += 1;
      return options.loadRuntime();
    };
    return {
      readConfig: () => ({ config: { version: 1, enabled: false }, revision: "" }),
      replaceConfig: (_expectedRevision, config) => ({ config, revision: "synthetic-revision" }),
      snapshot: () => ({
        process: "unavailable",
        apply: "blocked",
        unavailable_reason: "native_validation_required",
      }),
      readResources: () => ({
        revision: "",
        status: "missing",
        root: null,
        diagnostic_code: "runtime_not_selected",
      }),
      async prepareResources() {
        return {
          revision: "synthetic-resource",
          status: "ready",
          root: path.resolve("synthetic"),
          diagnostic_code: null,
        };
      },
      async listAccounts() {
        return { accounts: [] };
      },
      async quickLogin() {},
      async start() {
        state.startCalls += 1;
      },
      async stop() {
        state.stopCalls += 1;
        await onStop?.();
      },
      async retry() {},
      async getQr() {
        return { qr_payload: null };
      },
      async refreshQr() {
        return { qr_payload: null };
      },
    } satisfies NapCatManagedSession;
  };
  return { state, factory };
}

async function saveConfig(app: Awaited<ReturnType<typeof createRuntime>>["app"], enabled: boolean) {
  return app.request(CONFIG, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: { version: 1, enabled },
      expected_revision: "",
    }),
  });
}

async function measurePageReads<T>(db: Database, read: () => Promise<T>) {
  const executions: { sql: string; method: string }[] = [];
  const wrapped = new WeakMap<object, object>();
  const proxies = new WeakSet<object>();
  function wrap(statement: object, sql: string) {
    if (proxies.has(statement)) return statement;
    const existing = wrapped.get(statement);
    if (existing) return existing;
    const proxy = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "get" || key === "all" || key === "values" || key === "run") {
            executions.push({ sql: sql.replace(/\s+/g, " ").trim(), method: key });
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    wrapped.set(statement, proxy);
    proxies.add(proxy);
    return proxy;
  }
  const originalQuery = db.query.bind(db);
  const originalPrepare = db.prepare.bind(db);
  const queryTrace = spyOn(db, "query").mockImplementation(((sql: string, ...args: unknown[]) =>
    wrap(Reflect.apply(originalQuery, db, [sql, ...args]), sql)) as typeof db.query);
  const prepareTrace = spyOn(db, "prepare").mockImplementation(((sql: string, ...args: unknown[]) =>
    wrap(Reflect.apply(originalPrepare, db, [sql, ...args]), sql)) as typeof db.prepare);
  try {
    return { value: await read(), executions };
  } finally {
    prepareTrace.mockRestore();
    queryTrace.mockRestore();
  }
}

describe("NapCat runtime management wiring", () => {
  it("constructs managed wiring without reading config or loading the runtime", async () => {
    const directory = temporaryDirectory();
    const configDirectory = path.join(directory, "not-created-yet");
    const harness = managedSessionHarness();
    const runtime = await runtimeFor(path.join(configDirectory, "napcat.json"), {
      runtimeConfigPath: path.join(configDirectory, "napcat-runtime.json"),
      factory: harness.factory,
    });
    try {
      expect(harness.state.factoryCalls).toBe(1);
      expect(harness.state.runtimeLoadCalls).toBe(0);
      expect(harness.state.startCalls).toBe(0);
      expect(harness.state.stopCalls).toBe(0);
      expect(existsSync(configDirectory)).toBe(false);
      await runtime.stop();
      expect(harness.state.stopCalls).toBe(1);
      expect(harness.state.runtimeLoadCalls).toBe(0);
      expect(existsSync(configDirectory)).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  it("starts the injected session once and awaits its stop before closing the business DB", async () => {
    const directory = temporaryDirectory();
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const harness = managedSessionHarness(() => stopGate);
    const runtime = await runtimeFor(path.join(directory, "napcat.json"), {
      runtimeConfigPath: path.join(directory, "napcat-runtime.json"),
      factory: harness.factory,
    });
    try {
      runtime.start();
      runtime.start();
      expect(harness.state.startCalls).toBe(1);
      expect(harness.state.runtimeLoadCalls).toBe(0);
      const stopping = runtime.stop();
      await Promise.resolve();
      expect(harness.state.stopCalls).toBe(1);
      expect(() => runtime.business.db.query("SELECT 1").get()).not.toThrow();
      releaseStop();
      await stopping;
      await runtime.stop();
      expect(harness.state.startCalls).toBe(1);
      expect(harness.state.stopCalls).toBe(1);
      expect(() => runtime.business.db.query("SELECT 1").get()).toThrow();
    } finally {
      releaseStop();
      await runtime.stop();
    }
  });

  it("keeps the old blocked management port when no runtime config path is injected", async () => {
    const directory = temporaryDirectory();
    const harness = managedSessionHarness();
    const runtime = await runtimeFor(path.join(directory, "napcat.json"), {
      factory: harness.factory,
    });
    try {
      const config = await runtime.app.request(CONFIG);
      expect(config.status).toBe(200);
      expect(await config.json()).toEqual({
        config: { version: 1, enabled: false },
        revision: "",
      });
      runtime.start();
      expect(harness.state.factoryCalls).toBe(0);
      expect(harness.state.startCalls).toBe(0);
    } finally {
      await runtime.stop();
    }
  });

  it("places the private config in each existing application layout", () => {
    const root = path.resolve("synthetic-napcat-layout-root");
    const resources = path.resolve("synthetic-napcat-layout-resources");
    for (const paths of [
      resolveAppPaths({ mode: "development", root }),
      resolveAppPaths({ mode: "installed", root }),
      resolveAppPaths({ mode: "desktop", root, resourceRoot: resources }),
    ]) {
      expect(paths.napcatConfig).toBe(path.join(paths.configDir, "napcat.json"));
      expect(path.isAbsolute(paths.napcatConfig)).toBe(true);
    }
  });

  it("keeps management unconfigured when no private config path is injected", async () => {
    const runtime = await runtimeFor();
    try {
      const before = await (await runtime.app.request("/qq/settings")).json();
      const config = await runtime.app.request(CONFIG);
      expect(config.status).toBe(503);
      expect(config.headers.get("cache-control")).toBe("no-store");
      expect(await config.json()).toMatchObject({
        error: { code: "NAPCAT_MANAGEMENT_UNAVAILABLE" },
      });
      const rejectedSave = await saveConfig(runtime.app, true);
      expect(rejectedSave.status).toBe(503);
      expect(await rejectedSave.json()).toMatchObject({
        error: { code: "NAPCAT_MANAGEMENT_UNAVAILABLE" },
      });
      const status = await runtime.app.request(STATUS);
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({
        process: "unavailable",
        apply: "blocked",
        unavailable_reason: "management_not_configured",
      });
      expect(await (await runtime.app.request("/qq/settings")).json()).toEqual(before);
    } finally {
      await runtime.stop();
    }
  });

  it("does not read or create a missing config during construction and defaults it only on GET", async () => {
    const directory = temporaryDirectory();
    const configDirectory = path.join(directory, "not-created-yet");
    const file = path.join(configDirectory, "napcat.json");
    const runtime = await runtimeFor(file);
    try {
      expect(existsSync(configDirectory)).toBe(false);
      const config = await runtime.app.request(CONFIG);
      expect(config.status).toBe(200);
      expect(await config.json()).toEqual({
        config: { version: 1, enabled: false },
        revision: "",
      });
      expect(existsSync(configDirectory)).toBe(false);
      const status = await runtime.app.request(STATUS);
      expect(await status.json()).toEqual({
        process: "unavailable",
        apply: "blocked",
        unavailable_reason: "native_validation_required",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("saves enabled only to the injected NapCat file and leaves QQ settings unchanged", async () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "napcat.json");
    const runtime = await runtimeFor(file);
    try {
      const qqSettings = await (await runtime.app.request("/qq/settings")).json();
      const databaseChanges = runtime.business.db.query("SELECT total_changes() AS n").get();
      expect(existsSync(file)).toBe(false);
      const initial = await runtime.app.request(CONFIG);
      expect(await initial.json()).toEqual({
        config: { version: 1, enabled: false },
        revision: "",
      });
      const saved = await saveConfig(runtime.app, true);
      expect(saved.status).toBe(200);
      const snapshot = await saved.json();
      expect(snapshot).toEqual({
        config: { version: 1, enabled: true },
        revision: expect.any(String),
      });
      expect(snapshot.revision).not.toBe("");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, enabled: true });
      expect(readdirSync(directory)).toEqual(["napcat.json"]);
      expect(await (await runtime.app.request("/qq/settings")).json()).toEqual(qqSettings);
      expect(runtime.business.db.query("SELECT total_changes() AS n").get()).toEqual(
        databaseChanges,
      );
      const status = await runtime.app.request(STATUS);
      expect(await status.json()).toEqual({
        process: "unavailable",
        apply: "blocked",
        unavailable_reason: "native_validation_required",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("lets runtime startup proceed with invalid managed config and rejects it on management GET", async () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "napcat.json");
    const invalid = "{ invalid synthetic managed config";
    writeFileSync(file, invalid);
    const runtime = await runtimeFor(file);
    let releaseDrain!: () => void;
    const requestDrain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    try {
      expect(readFileSync(file, "utf8")).toBe(invalid);
      expect(() => runtime.start()).not.toThrow();
      const config = await runtime.app.request(CONFIG);
      expect(config.status).toBe(503);
      expect(config.headers.get("cache-control")).toBe("no-store");
      expect(await config.json()).toMatchObject({ error: { code: "NAPCAT_CONFIG_INVALID" } });
      expect(readFileSync(file, "utf8")).toBe(invalid);
      const status = await runtime.app.request(STATUS);
      expect(await status.json()).toEqual({
        process: "unavailable",
        apply: "blocked",
        unavailable_reason: "native_validation_required",
      });
      const stopping = runtime.stop(requestDrain);
      expect(() => runtime.business.db.query("SELECT 1").get()).not.toThrow();
      releaseDrain();
      await stopping;
      expect(() => runtime.business.db.query("SELECT 1").get()).toThrow();
    } finally {
      releaseDrain();
      await runtime.stop();
    }
  });
});

describe("NapCat event source runtime composition", () => {
  it("links incoming tap to committed preview and rechecks source revision and original epoch", async () => {
    const directory = temporaryDirectory();
    const business = openBusinessDb();
    ensureDefaults(business.orm, MODEL);
    const keyPath = path.join(directory, "transport.key");
    let settings = readQqSettings(business.orm);
    updateQqSettings(business.orm, {
      enabled: true,
      accountId: "10001",
      expectedRevision: settings.revision,
    });
    settings = readQqSettings(business.orm);
    updateQqTransportConfig(business.orm, {
      endpoint: "ws://127.0.0.1:3001/",
      token: "synthetic-event-token",
      expectedRevision: settings.revision,
      keyPath,
    });
    const schemeId = "22222222-2222-4222-8222-222222222222";
    const bindingId = "11111111-1111-4111-8111-111111111111";
    business.orm
      .insert(schema.qqSchemes)
      .values({
        id: schemeId,
        name: "Synthetic event scheme",
        revision: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    business.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingId,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        schemeId,
        paused: 1,
        shareWebMemory: 0,
        memoryBatchSize: null,
        ownerIdentityRevision: null,
        revision: 1,
        authorityRevision: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    let socket: EventSocket | undefined;
    let sockets = 0;
    let modelCalls = 0;
    class EventSocket extends EventTarget {
      readyState = 0;
      constructor() {
        super();
        sockets += 1;
        socket = this;
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        });
      }
      send(payload: string) {
        const request: { action: string; echo: string } = JSON.parse(payload);
        const data =
          request.action === "get_login_info"
            ? { user_id: 10001 }
            : request.action === "get_status"
              ? { online: true, good: true }
              : null;
        this.deliver({ status: "ok", retcode: 0, echo: request.echo, data });
      }
      deliver(value: unknown) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
      }
      terminate() {
        this.readyState = 3;
      }
    }
    const originalSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: EventSocket,
    });
    const insertedAt = Math.floor(Date.now() / 1000) * 1000;
    let clock = insertedAt;
    const clockSpy = spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const runtime = await createRuntime({
        business: runtimeFixtureBusiness(business),
        qqTransportKeyPath: keyPath,
        browserStateSecret: "synthetic-event-runtime-secret",
        gateway: {
          ...gateway,
          async complete() {
            modelCalls += 1;
            throw new Error("Unexpected model call");
          },
          async *streamChat() {
            modelCalls += 1;
            yield "Unexpected model call";
          },
        },
      });
      const pageVectors: { scenario: string; executions: { sql: string; method: string }[] }[] = [];
      const page = async (scenario: string) => {
        const measured = await measurePageReads(business.db, async () => {
          const response = await runtime.app.request(
            "/v2/qq/managed-component/events?kind=message",
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          return response.json();
        });
        pageVectors.push({ scenario, executions: measured.executions });
        return measured.value;
      };
      try {
        expect((await runtime.qqIntake.start()).phase).toBe("ready");
        if (!socket) throw new Error("Expected one synthetic socket");
        socket.deliver({
          // Original 14-day retention expires in one minute, before this new ring entry does.
          time: insertedAt / 1000 - 14 * 24 * 60 * 60 + 60,
          self_id: 10001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -991,
          user_id: 20002,
          group_id: 30003,
          message: [{ type: "text", data: { text: "Synthetic committed preview" } }],
        });
        const initial = await page("available");
        expect(initial.events).toHaveLength(1);
        const sourceEntry = business.db
          .query(
            "SELECT c.id,c.binding_epoch,e.sources FROM conversations c JOIN conversation_events e ON e.conversation_id=c.id WHERE c.source_id=? AND e.kind='inbound'",
          )
          .get(bindingId) as { id: string; binding_epoch: number; sources: string };
        const originalSource = (
          JSON.parse(sourceEntry.sources) as {
            kind: string;
            id: string;
            revision: string;
            expiresAt?: string;
          }[]
        ).find((source) => source.kind === "qq_observation");
        if (!originalSource?.expiresAt) throw new Error("Expected committed observation source");
        const originalScope: BotEvidenceScope = {
          channel: "onebot11",
          conversationId: sourceEntry.id,
          bindingEpoch: sourceEntry.binding_epoch,
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
          bindingId,
          authorityRevision: 1,
        };
        const readable = loadConversationEvidence(
          business,
          originalScope,
          "history",
          `qq-message:${originalSource.id}`,
          nowIso(),
        );
        expect(readable?.text).toBe("Synthetic committed preview");
        const readableSource = readable?.sources.find((source) => source.kind === "qq_observation");
        expect(readableSource?.revision).toBe(originalSource.revision);
        expect(originalSource.expiresAt).toMatch(/\.\d{6}Z$/);
        expect(readableSource?.expiresAt).toMatch(/\.\d{3}Z$/);
        expect(Date.parse(readableSource?.expiresAt ?? "")).toBe(
          Date.parse(originalSource.expiresAt),
        );
        expect(initial.events[0]).toMatchObject({
          conversation_binding: "bound",
          preview_state: "available",
          message_preview: "Synthetic committed preview",
        });
        const event = business.db
          .query("SELECT event_key FROM qq_events WHERE message_id=?")
          .get("-991") as { event_key: string };
        const activation = business.db
          .query(
            "SELECT id,binding_epoch FROM conversations WHERE source_id=? AND closed_at IS NULL",
          )
          .get(bindingId) as { id: string; binding_epoch: number };
        const body = business.db
          .query("SELECT body FROM qq_observation_text WHERE event_key=?")
          .get(event.event_key) as { body: string };
        const facts = business.db
          .query("SELECT parts FROM qq_message_facts WHERE event_key=?")
          .get(event.event_key) as { parts: string };
        business.db
          .query("UPDATE qq_observation_text SET body=? WHERE event_key=?")
          .run("Changed source revision", event.event_key);
        business.db
          .query("UPDATE qq_message_facts SET parts=? WHERE event_key=?")
          .run(
            JSON.stringify([{ kind: "text", text: "Changed source revision" }]),
            event.event_key,
          );
        expect((await page("revision_changed")).events[0].message_preview).toBeNull();
        business.db
          .query("UPDATE qq_observation_text SET body=? WHERE event_key=?")
          .run(body.body, event.event_key);
        business.db
          .query("UPDATE qq_message_facts SET parts=? WHERE event_key=?")
          .run(facts.parts, event.event_key);
        expect((await page("revision_restored")).events[0].message_preview).toBe(
          "Synthetic committed preview",
        );
        business.db
          .query(
            "UPDATE qq_bindings SET revision=revision+1,authority_revision=authority_revision+1 WHERE id=?",
          )
          .run(bindingId);
        expect((await page("authority_revoked")).events[0].message_preview).toBeNull();
        business.db
          .query("UPDATE qq_bindings SET revision=1,authority_revision=1 WHERE id=?")
          .run(bindingId);
        business.db
          .query("UPDATE conversations SET binding_epoch=binding_epoch+1 WHERE id=?")
          .run(activation.id);
        expect((await page("epoch_changed")).events[0].message_preview).toBeNull();
        business.db
          .query("UPDATE conversations SET binding_epoch=? WHERE id=?")
          .run(activation.binding_epoch, activation.id);
        expect((await page("epoch_restored")).events[0].message_preview).toBe(
          "Synthetic committed preview",
        );
        const sourceExpiresAt = Date.parse(originalSource.expiresAt);
        expect(sourceExpiresAt).toBe(insertedAt + 60_000);
        expect(Date.parse(initial.events[0].expires_at)).toBeGreaterThan(sourceExpiresAt);
        clock = sourceExpiresAt + 1;
        const expired = await page("source_expired_ring_retained");
        expect(expired.events).toHaveLength(1);
        expect(expired.generation).toBe(initial.generation);
        expect(expired.events[0].sequence).toBe(initial.events[0].sequence);
        expect(expired.events[0]).toMatchObject({
          conversation_binding: "bound",
          message_preview: null,
          preview_state: "expired",
        });
        expect(Date.parse(expired.events[0].expires_at)).toBeGreaterThan(clock);
        console.log("NAPCAT_RUNTIME_PAGE_EXECUTION_VECTORS", JSON.stringify(pageVectors));
        expect(sockets).toBe(1);
        expect(modelCalls).toBe(0);
      } finally {
        await runtime.stop();
      }
    } finally {
      clockSpy.mockRestore();
      if (originalSocket) Object.defineProperty(globalThis, "WebSocket", originalSocket);
      else Reflect.deleteProperty(globalThis, "WebSocket");
    }
  });
});
