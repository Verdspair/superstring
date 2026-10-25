import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAppPaths } from "../../src/server/app-paths";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type {
  createNapCatManagedSession,
  NapCatManagedSession,
} from "../../src/server/napcat/management";
import { createRuntime } from "../../src/server/runtime";

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

function runtimeFor(
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
  return createRuntime(options);
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

async function saveConfig(app: ReturnType<typeof createRuntime>["app"], enabled: boolean) {
  return app.request(CONFIG, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: { version: 1, enabled },
      expected_revision: "",
    }),
  });
}

describe("NapCat runtime management wiring", () => {
  it("constructs managed wiring without reading config or loading the runtime", async () => {
    const directory = temporaryDirectory();
    const configDirectory = path.join(directory, "not-created-yet");
    const harness = managedSessionHarness();
    const runtime = runtimeFor(path.join(configDirectory, "napcat.json"), {
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
    const runtime = runtimeFor(path.join(directory, "napcat.json"), {
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
    const runtime = runtimeFor(path.join(directory, "napcat.json"), {
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
    const runtime = runtimeFor();
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
    const runtime = runtimeFor(file);
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
    const runtime = runtimeFor(file);
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
    const runtime = runtimeFor(file);
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
