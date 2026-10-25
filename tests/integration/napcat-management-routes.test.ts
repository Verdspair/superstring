import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type {
  NapCatManagedSession,
  NapCatManagementPort,
} from "../../src/server/napcat/management";

const CONFIG = "/v2/qq/managed-component/config";
const STATUS = "/v2/qq/managed-component/status";
const RETRY = "/v2/qq/managed-component/retry";
const QR = "/v2/qq/managed-component/qr";
const REFRESH_QR = "/v2/qq/managed-component/refresh-qr";
const MODEL = "qwen/qwen3-4b-2507";
const NATIVE_BLOCKED = {
  process: "unavailable",
  apply: "blocked",
  unavailable_reason: "native_validation_required",
} as const;
const PRIVATE_MARKERS = {
  path: "/synthetic-private/napcat.json",
  command: "synthetic-private-command",
  token: "synthetic-control-token",
  credential: "synthetic-session-credential",
  qrcode: "synthetic-login-qr",
  loginError: "synthetic-raw-login-error",
  ready: true,
};

function storeError(code: string) {
  return Object.assign(new Error(Object.values(PRIVATE_MARKERS).join(" ")), { code });
}

class FakePort implements NapCatManagementPort {
  config = { version: 1 as const, enabled: false };
  revision = "";
  reads = 0;
  snapshots = 0;
  replaceAttempts = 0;
  writes = 0;
  readError?: Error;
  replaceError?: Error;
  extraStatus = {};

  readConfig() {
    this.reads += 1;
    if (this.readError) throw this.readError;
    return { config: { ...this.config }, revision: this.revision };
  }

  replaceConfig(expectedRevision: string, config: { version: 1; enabled: boolean }) {
    this.replaceAttempts += 1;
    if (this.replaceError) throw this.replaceError;
    if (expectedRevision !== this.revision) throw storeError("NAPCAT_CONFIG_CONFLICT");
    if (this.config.enabled !== config.enabled) {
      this.config = { ...config };
      this.revision = String(this.writes + 1).padStart(64, "0");
      this.writes += 1;
    }
    return { config: { ...this.config }, revision: this.revision };
  }

  snapshot() {
    this.snapshots += 1;
    return { ...NATIVE_BLOCKED, ...this.extraStatus };
  }
}

class FakeManagedSession extends FakePort implements NapCatManagedSession {
  retries = 0;
  qrReads = 0;
  qrRefreshes = 0;
  qrPayload = "synthetic-login-qr";
  refreshedQrPayload = "synthetic-refreshed-login-qr";
  actionError?: Error;

  resourceReads = 0;
  resourcePrepares = 0;
  accountReads = 0;
  quickLoginAttempts = 0;
  starts = 0;
  stops = 0;
  resource = {
    revision: "resources-0",
    status: "ready" as const,
    root: "/synthetic-private/runtime",
    diagnostic_code: null,
  };

  readResources() {
    this.resourceReads += 1;
    return { ...this.resource };
  }
  async prepareResources(input: { expected_revision: string; root: string }) {
    this.resourcePrepares += 1;
    if (this.actionError) throw this.actionError;
    if (input.expected_revision !== this.resource.revision)
      throw storeError("NAPCAT_RESOURCE_CONFLICT");
    this.resource = { ...this.resource, revision: "resources-1", root: input.root };
    return { ...this.resource };
  }
  async listAccounts() {
    this.accountReads += 1;
    if (this.actionError) throw this.actionError;
    return { accounts: [{ account_id: "10001", display_name: "Synthetic account" }] };
  }
  async quickLogin(_input: { account_id: string; expected_settings_revision: number }) {
    this.quickLoginAttempts += 1;
    if (this.actionError) throw this.actionError;
  }
  async start() {
    this.starts += 1;
  }
  async stop() {
    this.stops += 1;
  }

  async retry() {
    this.retries += 1;
    if (this.actionError) throw this.actionError;
  }

  async getQr() {
    this.qrReads += 1;
    if (this.actionError) throw this.actionError;
    return { qr_payload: this.qrPayload };
  }

  async refreshQr() {
    this.qrRefreshes += 1;
    if (this.actionError) throw this.actionError;
    return { qr_payload: this.refreshedQrPayload };
  }
}

function methodCalls(session: FakeManagedSession) {
  return {
    readConfig: session.reads,
    snapshot: session.snapshots,
    replaceConfig: session.replaceAttempts,
    readResources: session.resourceReads,
    prepareResources: session.resourcePrepares,
    listAccounts: session.accountReads,
    quickLogin: session.quickLoginAttempts,
    retry: session.retries,
    getQr: session.qrReads,
    refreshQr: session.qrRefreshes,
    start: session.starts,
    stop: session.stops,
  };
}

function expectMethodDelta(
  session: FakeManagedSession,
  before: ReturnType<typeof methodCalls>,
  expected: Partial<ReturnType<typeof methodCalls>> = {},
) {
  const after = methodCalls(session);
  for (const key of Object.keys(after) as (keyof typeof after)[]) {
    expect(after[key] - before[key]).toBe(expected[key] ?? 0);
  }
}

function setup(
  port?: NapCatManagementPort,
  events?: import("../../src/server/napcat/routes").QqManagedEventsPort,
) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const app = createApp({
    business,
    napcatManagement: port,
    napcatEvents: events,
    qqConnectionState: () => ({ phase: "disconnected", reason: "synthetic_external_offline" }),
  });
  return { business, app };
}

type App = ReturnType<typeof createApp>;

function put(app: App, payload: unknown, headers: Record<string, string> = {}) {
  return app.request(CONFIG, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

function post(app: App, route: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.request(route, {
    method: "POST",
    headers: payload === undefined ? headers : { "content-type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function update(enabled: boolean, expectedRevision = "") {
  return { config: { version: 1, enabled }, expected_revision: expectedRevision };
}

async function expectSafeError(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  for (const marker of Object.values(PRIVATE_MARKERS)) {
    if (typeof marker === "string") expect(text).not.toContain(marker);
  }
  const body = JSON.parse(text) as { error: { code: string; message: string } };
  expect(body).toEqual({ error: { code: expect.any(String), message: expect.any(String) } });
  expect(body.error.message.length).toBeGreaterThan(0);
  return body;
}

async function businessView(app: App) {
  return {
    settings: await (await app.request("/qq/settings")).json(),
    status: await (await app.request("/qq/status")).json(),
  };
}

describe("NapCat management routes", () => {
  it("constructs a pure app and reads without saving or changing QQ business state", async () => {
    const port = new FakePort();
    const h = setup(port);
    try {
      expect([port.reads, port.snapshots, port.replaceAttempts]).toEqual([0, 0, 0]);
      const before = await businessView(h.app);
      const changes = h.business.db.query("SELECT total_changes() AS n").get();
      for (let i = 0; i < 2; i += 1) {
        const config = await h.app.request(CONFIG);
        expect(config.status).toBe(200);
        expect(config.headers.get("cache-control")).toBe("no-store");
        expect(await config.json()).toEqual({
          config: { version: 1, enabled: false },
          revision: "",
        });
        const status = await h.app.request(STATUS);
        expect(status.status).toBe(200);
        expect(status.headers.get("cache-control")).toBe("no-store");
        expect(await status.json()).toEqual(NATIVE_BLOCKED);
      }
      expect(port.reads).toBe(2);
      expect(port.snapshots).toBe(2);
      expect(port.replaceAttempts).toBe(0);
      expect(port.writes).toBe(0);
      expect(await businessView(h.app)).toEqual(before);
      expect(h.business.db.query("SELECT total_changes() AS n").get()).toEqual(changes);
    } finally {
      h.business.close();
    }
  });

  it("guards management operations before invoking any port method", async () => {
    const port = new FakeManagedSession();
    const h = setup(port);
    try {
      const operations = [
        { route: CONFIG, method: "GET" },
        { route: CONFIG, method: "PUT" },
        { route: STATUS, method: "GET" },
        { route: RETRY, method: "POST" },
        { route: QR, method: "POST" },
        { route: REFRESH_QR, method: "POST" },
        { route: "/v2/qq/managed-component/resources", method: "GET" },
        { route: "/v2/qq/managed-component/resources", method: "PUT" },
        { route: "/v2/qq/managed-component/accounts", method: "GET" },
        { route: "/v2/qq/managed-component/quick-login", method: "POST" },
      ];
      const before = methodCalls(port);
      for (const operation of operations) {
        const forbiddenHeaders: Record<string, string>[] = [
          { origin: "https://evil.example" },
          { "sec-fetch-site": "cross-site" },
        ];
        for (const headers of forbiddenHeaders) {
          const response = await h.app.request(operation.route, {
            method: operation.method,
            headers: { "content-type": "application/json", ...headers },
            body: operation.method === "PUT" ? JSON.stringify(update(true)) : undefined,
          });
          const error = await expectSafeError(response, 403);
          expect(error.error.code).toBe("PERMISSION_MANAGEMENT_FORBIDDEN");
        }
        const remote = await h.app.request(`https://remote.example${operation.route}`, {
          method: operation.method,
          headers: { "content-type": "application/json" },
          body: operation.method === "PUT" ? JSON.stringify(update(true)) : undefined,
        });
        expect((await expectSafeError(remote, 403)).error.code).toBe(
          "PERMISSION_MANAGEMENT_FORBIDDEN",
        );
      }
      const nonJson = await put(h.app, update(true), { "content-type": "text/plain" });
      expect((await expectSafeError(nonJson, 422)).error.code).toBe("VALIDATION_ERROR");
      const nonJsonActions = await Promise.all(
        [RETRY, QR, REFRESH_QR].map((route) =>
          post(h.app, route, undefined, { "content-type": "text/plain" }),
        ),
      );
      for (const response of nonJsonActions) {
        expect((await expectSafeError(response, 422)).error.code).toBe("VALIDATION_ERROR");
      }
      expect([port.reads, port.snapshots, port.replaceAttempts, port.writes]).toEqual([0, 0, 0, 0]);
      expectMethodDelta(port, before);

      const sameOrigin = await h.app.request(`http://localhost${CONFIG}`, {
        headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
      });
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers.get("cache-control")).toBe("no-store");
    } finally {
      h.business.close();
    }
  });

  it("rejects malformed or extra body fields with zero port writes", async () => {
    const port = new FakeManagedSession();
    const h = setup(port);
    try {
      const before = methodCalls(port);
      for (const payload of [
        null,
        [],
        {},
        { config: { version: 1, enabled: true } },
        { ...update(true), expected_revision: 1 },
        { ...update(true), expected_revision: null },
        { ...update(true), config: null },
        { ...update(true), config: { version: 2, enabled: true } },
        { ...update(true), config: { version: 1, enabled: "true" } },
        { ...update(true), config: { version: 1 } },
        { ...update(true), config: { version: 1, enabled: true, token: "not-allowed" } },
        { ...update(true), account_id: "10001" },
        { ...update(true), command: "not-allowed" },
      ]) {
        expect((await expectSafeError(await put(h.app, payload), 422)).error.code).toBe(
          "VALIDATION_ERROR",
        );
      }
      for (const raw of ["", "   ", "{bad-json"]) {
        const response = await h.app.request(CONFIG, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: raw,
        });
        expect((await expectSafeError(response, 422)).error.code).toBe("VALIDATION_ERROR");
      }
      expect(port.replaceAttempts).toBe(0);
      expect(port.writes).toBe(0);
      expect(port.config.enabled).toBe(false);
      expectMethodDelta(port, before);
    } finally {
      h.business.close();
    }
  });

  it("saves the preference while native apply stays blocked and external QQ remains unchanged", async () => {
    const port = new FakePort();
    const h = setup(port);
    try {
      const before = await businessView(h.app);
      const changes = h.business.db.query("SELECT total_changes() AS n").get();
      for (const enabled of [true, false]) {
        const saved = await put(h.app, update(enabled, port.revision));
        expect(saved.status).toBe(200);
        expect(saved.headers.get("cache-control")).toBe("no-store");
        const savedBody = await saved.json();
        expect(savedBody).toEqual({ config: { version: 1, enabled }, revision: port.revision });
        expect(savedBody.revision).not.toBe("");
        expect(await (await h.app.request(CONFIG)).json()).toEqual(savedBody);
        expect(await (await h.app.request(STATUS)).json()).toEqual(NATIVE_BLOCKED);
        expect(await businessView(h.app)).toEqual(before);
      }
      expect(port.writes).toBe(2);
      expect(h.business.db.query("SELECT total_changes() AS n").get()).toEqual(changes);
    } finally {
      h.business.close();
    }
  });

  it("maps stale CAS to 409 without changing the saved config", async () => {
    const port = new FakePort();
    const h = setup(port);
    try {
      expect((await put(h.app, update(true))).status).toBe(200);
      const before = { config: { ...port.config }, revision: port.revision };
      const stale = await put(h.app, update(false));
      expect((await expectSafeError(stale, 409)).error.code).toBe("NAPCAT_CONFIG_CONFLICT");
      expect(port.writes).toBe(1);
      expect(await (await h.app.request(CONFIG)).json()).toEqual(before);
      expect(await (await h.app.request(STATUS)).json()).toEqual(NATIVE_BLOCKED);
    } finally {
      h.business.close();
    }
  });

  it("sanitizes invalid and unreadable config errors without fake saves", async () => {
    const port = new FakePort();
    const h = setup(port);
    try {
      let stableMessage: string | undefined;
      for (const code of ["NAPCAT_CONFIG_INVALID", "NAPCAT_CONFIG_UNAVAILABLE"]) {
        port.readError = storeError(code);
        const readError = await expectSafeError(await h.app.request(CONFIG), 503);
        expect(readError.error.code).toBe(code);
        if (stableMessage === undefined) stableMessage = readError.error.message;
        expect(readError.error.message).toBe(stableMessage);
        port.readError = undefined;
        port.replaceError = storeError(code);
        expect(await expectSafeError(await put(h.app, update(true)), 503)).toEqual(readError);
        expect(port.writes).toBe(0);
        expect(port.config.enabled).toBe(false);
        port.replaceError = undefined;
      }
    } finally {
      h.business.close();
    }
  });

  it("does not expose private fields from a runtime snapshot", async () => {
    const port = new FakePort();
    port.extraStatus = PRIVATE_MARKERS;
    const h = setup(port);
    try {
      const response = await h.app.request(STATUS);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(NATIVE_BLOCKED);
    } finally {
      h.business.close();
    }
  });

  it("guards and sanitizes all managed actions and rejects arbitrary action bodies", async () => {
    const session = new FakeManagedSession();
    session.extraStatus = {
      process: "running",
      apply: "ready",
      ownership: "owned",
      phase: "waiting_scan",
      core_ready: false,
      transport_phase: "idle",
      network_apply: "pending",
      diagnostic_code: null,
      ...PRIVATE_MARKERS,
      qr_payload: PRIVATE_MARKERS.qrcode,
    };
    const h = setup(session);
    try {
      const retry = await post(h.app, RETRY);
      expect(retry.status).toBe(200);
      expect(retry.headers.get("cache-control")).toBe("no-store");
      expect(await retry.json()).toEqual({
        process: "running",
        apply: "ready",
        ownership: "owned",
        phase: "waiting_scan",
        core_ready: false,
        transport_phase: "idle",
        network_apply: "pending",
        diagnostic_code: null,
      });
      expect(session.retries).toBe(1);
      expect(session.snapshots).toBe(1);

      const status = await h.app.request(STATUS);
      expect(status.status).toBe(200);
      expect(status.headers.get("cache-control")).toBe("no-store");
      expect(await status.json()).toEqual({
        process: "running",
        apply: "ready",
        ownership: "owned",
        phase: "waiting_scan",
        core_ready: false,
        transport_phase: "idle",
        network_apply: "pending",
        diagnostic_code: null,
      });

      const qr = await post(h.app, QR);
      expect(qr.status).toBe(200);
      expect(qr.headers.get("cache-control")).toBe("no-store");
      expect(await qr.json()).toEqual({ qr_payload: session.qrPayload });
      expect(session.qrReads).toBe(1);

      const refreshed = await post(h.app, REFRESH_QR);
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers.get("cache-control")).toBe("no-store");
      expect(await refreshed.json()).toEqual({ qr_payload: session.refreshedQrPayload });
      expect(session.qrRefreshes).toBe(1);

      for (const route of [RETRY, QR, REFRESH_QR]) {
        const response = await post(h.app, route, {
          ...PRIVATE_MARKERS,
          arbitrary: "must-not-reach-managed-component",
        });
        expect((await expectSafeError(response, 422)).error.code).toBe("VALIDATION_ERROR");
      }
      expect([session.retries, session.qrReads, session.qrRefreshes]).toEqual([1, 1, 1]);

      session.actionError = storeError("NAPCAT_MANAGEMENT_UNAVAILABLE");
      for (const route of [RETRY, QR, REFRESH_QR]) {
        const error = await expectSafeError(await post(h.app, route), 503);
        expect(error.error.code).toBe("NAPCAT_MANAGEMENT_UNAVAILABLE");
      }
    } finally {
      h.business.close();
    }
  });

  it("invokes only each requested management method and its original status snapshot", async () => {
    const session = new FakeManagedSession();
    const h = setup(session);
    try {
      expectMethodDelta(session, {
        readConfig: 0,
        snapshot: 0,
        replaceConfig: 0,
        readResources: 0,
        prepareResources: 0,
        listAccounts: 0,
        quickLogin: 0,
        retry: 0,
        getQr: 0,
        refreshQr: 0,
        start: 0,
        stop: 0,
      });
      const operations = [
        [CONFIG, "GET", undefined, { readConfig: 1 }],
        [STATUS, "GET", undefined, { snapshot: 1 }],
        [CONFIG, "PUT", update(true), { replaceConfig: 1 }],
        ["/v2/qq/managed-component/resources", "GET", undefined, { readResources: 1 }],
        [
          "/v2/qq/managed-component/resources",
          "PUT",
          {
            expected_revision: "resources-0",
            root: "/synthetic/runtime",
          },
          { prepareResources: 1 },
        ],
        ["/v2/qq/managed-component/accounts", "GET", undefined, { listAccounts: 1 }],
        [
          "/v2/qq/managed-component/quick-login",
          "POST",
          {
            account_id: "10001",
            expected_settings_revision: 1,
          },
          { quickLogin: 1, snapshot: 1 },
        ],
        [RETRY, "POST", {}, { retry: 1, snapshot: 1 }],
        [QR, "POST", {}, { getQr: 1 }],
        [REFRESH_QR, "POST", {}, { refreshQr: 1 }],
      ] as const;
      for (const [route, method, body, expected] of operations) {
        const before = methodCalls(session);
        const response = await h.app.request(route, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await response.json();
        expectMethodDelta(session, before, expected);
      }
      for (const route of [RETRY, QR, REFRESH_QR]) {
        for (const body of ["{bad-json", "null", "[]", '{"extra":true}']) {
          const before = methodCalls(session);
          const response = await h.app.request(route, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          expect((await expectSafeError(response, 422)).error.code).toBe("VALIDATION_ERROR");
          expectMethodDelta(session, before);
        }
        const before = methodCalls(session);
        expect(
          (await expectSafeError(await post(h.app, `${route}?extra=1`, {}), 422)).error.code,
        ).toBe("VALIDATION_ERROR");
        expectMethodDelta(session, before);
        for (const body of [undefined, "   "]) {
          const validBefore = methodCalls(session);
          const response = await h.app.request(route, {
            method: "POST",
            body,
            ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
          });
          expect(response.status).toBe(200);
          await response.json();
          expectMethodDelta(
            session,
            validBefore,
            route === RETRY
              ? { retry: 1, snapshot: 1 }
              : route === QR
                ? { getQr: 1 }
                : { refreshQr: 1 },
          );
        }
      }
    } finally {
      h.business.close();
    }
  });

  it("refuses config operations without a port and reports management as unconfigured", async () => {
    const h = setup();
    try {
      const before = await businessView(h.app);
      const missingRead = await expectSafeError(await h.app.request(CONFIG), 503);
      const missingSave = await expectSafeError(await put(h.app, update(true)), 503);
      expect(missingRead.error.code).toBe("NAPCAT_MANAGEMENT_UNAVAILABLE");
      expect(missingSave).toEqual(missingRead);
      for (const route of [RETRY, QR, REFRESH_QR]) {
        const missingAction = await expectSafeError(await post(h.app, route), 503);
        expect(missingAction).toEqual(missingRead);
      }
      const status = await h.app.request(STATUS);
      expect(status.status).toBe(200);
      expect(status.headers.get("cache-control")).toBe("no-store");
      expect(await status.json()).toEqual({
        process: "unavailable",
        apply: "blocked",
        unavailable_reason: "management_not_configured",
      });
      expect(await businessView(h.app)).toEqual(before);
    } finally {
      h.business.close();
    }
  });
});

describe("NapCat first-use management endpoints", () => {
  const resources = "/v2/qq/managed-component/resources";
  const accounts = "/v2/qq/managed-component/accounts";
  const quickLogin = "/v2/qq/managed-component/quick-login";

  it("guards resource paths and login actions before any port call", async () => {
    const session = new FakeManagedSession();
    const h = setup(session);
    try {
      for (const [route, method, body] of [
        [resources, "GET", undefined],
        [resources, "PUT", { expected_revision: "resources-0", root: "/synthetic/runtime" }],
        [accounts, "GET", undefined],
        [quickLogin, "POST", { account_id: "10001", expected_settings_revision: 1 }],
      ] as const) {
        const response = await h.app.request(route, {
          method,
          headers: { origin: "https://evil.example", "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect((await expectSafeError(response, 403)).error.code).toBe(
          "PERMISSION_MANAGEMENT_FORBIDDEN",
        );
      }
      expect([
        session.resourceReads,
        session.resourcePrepares,
        session.accountReads,
        session.quickLoginAttempts,
      ]).toEqual([0, 0, 0, 0]);
    } finally {
      h.business.close();
    }
  });

  it("returns a root only on explicit protected resource reads and prepares with CAS", async () => {
    const session = new FakeManagedSession();
    const h = setup(session);
    try {
      const before = await businessView(h.app);
      const resource = await h.app.request(resources);
      expect(resource.status).toBe(200);
      expect(resource.headers.get("cache-control")).toBe("no-store");
      expect(await resource.json()).toEqual(session.resource);
      const response = await h.app.request(resources, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_revision: "resources-0",
          root: "/synthetic-private/new-runtime",
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(session.resource);
      expect(session.resourcePrepares).toBe(1);
      const statusText = await (await h.app.request(STATUS)).text();
      expect(statusText).not.toContain("/synthetic-private");
      expect(await businessView(h.app)).toEqual(before);
      const stale = await h.app.request(resources, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_revision: "resources-0", root: "/synthetic/runtime" }),
      });
      expect((await expectSafeError(stale, 409)).error.code).toBe("NAPCAT_RESOURCE_CONFLICT");
    } finally {
      h.business.close();
    }
  });

  it("uses only reviewed product fields and rejects arbitrary resource/login administration", async () => {
    const session = new FakeManagedSession();
    const h = setup(session);
    try {
      const before = methodCalls(session);
      for (const body of [
        {},
        { expected_revision: "resources-0", root: "" },
        { expected_revision: "resources-0", root: "/synthetic/runtime", token: "forbidden" },
      ]) {
        const response = await h.app.request(resources, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect((await expectSafeError(response, 422)).error.code).toBe("VALIDATION_ERROR");
      }
      for (const body of [
        {},
        { account_id: "bad", expected_settings_revision: 1 },
        { account_id: "10001", expected_settings_revision: 0 },
        { account_id: "10001", expected_settings_revision: 1, password: "forbidden" },
      ]) {
        expect((await expectSafeError(await post(h.app, quickLogin, body), 422)).error.code).toBe(
          "VALIDATION_ERROR",
        );
      }
      expect([session.resourcePrepares, session.quickLoginAttempts]).toEqual([0, 0]);
      expectMethodDelta(session, before);
      const list = await h.app.request(accounts);
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({
        accounts: [{ account_id: "10001", display_name: "Synthetic account" }],
      });
      const action = await post(h.app, quickLogin, {
        account_id: "10001",
        expected_settings_revision: 1,
      });
      expect(action.status).toBe(200);
      expect(session.quickLoginAttempts).toBe(1);
    } finally {
      h.business.close();
    }
  });

  it("maps resource busy/conflict and selected-account conflicts without raw upstream details", async () => {
    const session = new FakeManagedSession();
    const h = setup(session);
    try {
      for (const code of ["NAPCAT_RESOURCE_CONFLICT", "NAPCAT_RESOURCE_BUSY"]) {
        session.actionError = storeError(code);
        const response = await h.app.request(resources, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_revision: "resources-0", root: "/synthetic/runtime" }),
        });
        expect((await expectSafeError(response, 409)).error.code).toBe(code);
      }
      session.actionError = storeError("NAPCAT_ACCOUNT_SELECTION_CONFLICT");
      expect(
        (
          await expectSafeError(
            await post(h.app, quickLogin, { account_id: "10001", expected_settings_revision: 1 }),
            409,
          )
        ).error.code,
      ).toBe("NAPCAT_ACCOUNT_SELECTION_CONFLICT");
    } finally {
      h.business.close();
    }
  });
});

describe("NapCat bounded event management routes", () => {
  it("guards reads and emits only coalesced revision invalidation until cancellation", async () => {
    const generation = "00000000-0000-4000-8000-000000000001";
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    let listeners = 0;
    let listener:
      | ((notice: { generation: string; latest_sequence: number; revision: number }) => void)
      | null = null;
    const events = {
      generation,
      latestSequence: 1,
      revision: 1,
      snapshot: () => {
        snapshotCalls += 1;
        return {
          status: "ok" as const,
          generation,
          latest_sequence: 1,
          revision: 1,
          events: [],
          next_cursor: null,
          truncated: false,
        };
      },
      subscribe(next: typeof listener) {
        subscribeCalls += 1;
        listeners += 1;
        listener = next;
        return () => {
          listeners -= 1;
          listener = null;
        };
      },
    };
    const session = new FakeManagedSession();
    const h = setup(session, events);
    const before = methodCalls(session);
    try {
      for (const route of [
        "/v2/qq/managed-component/events",
        "/v2/qq/managed-component/events/changes",
      ]) {
        const forbiddenHeaders: Record<string, string>[] = [
          { origin: "https://evil.example" },
          { "sec-fetch-site": "cross-site" },
        ];
        for (const headers of forbiddenHeaders) {
          expect(
            (await expectSafeError(await h.app.request(route, { headers }), 403)).error.code,
          ).toBe("PERMISSION_MANAGEMENT_FORBIDDEN");
        }
        expect(
          (await expectSafeError(await h.app.request(`https://remote.example${route}`), 403)).error
            .code,
        ).toBe("PERMISSION_MANAGEMENT_FORBIDDEN");
      }
      expect([snapshotCalls, subscribeCalls, listeners]).toEqual([0, 0, 0]);
      expectMethodDelta(session, before);
      const forbidden = await h.app.request("/v2/qq/managed-component/events", {
        headers: { origin: "https://evil.example" },
      });
      expect(forbidden.status).toBe(403);
      expect(snapshotCalls).toBe(0);
      const invalid = await h.app.request("/v2/qq/managed-component/events?limit=101");
      expect(invalid.status).toBe(422);
      expect(snapshotCalls).toBe(0);
      const badCursor = await h.app.request("/v2/qq/managed-component/events?cursor=not-json");
      expect(badCursor.status).toBe(422);
      expect(snapshotCalls).toBe(0);
      for (const route of [
        `/v2/qq/managed-component/events?cursor=${encodeURIComponent(JSON.stringify({ generation, sequence: -1 }))}`,
        "/v2/qq/managed-component/events?extra=1",
        "/v2/qq/managed-component/events/changes?extra=1",
      ]) {
        expect((await expectSafeError(await h.app.request(route), 422)).error.code).toBe(
          "VALIDATION_ERROR",
        );
        expect([snapshotCalls, subscribeCalls, listeners]).toEqual([0, 0, 0]);
        expectMethodDelta(session, before);
      }
      const page = await h.app.request("/v2/qq/managed-component/events?kind=message&limit=10");
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect((await page.json()).events).toEqual([]);
      expect([snapshotCalls, subscribeCalls, listeners]).toEqual([1, 0, 0]);
      expectMethodDelta(session, before);
      const response = await h.app.request("/v2/qq/managed-component/events/changes");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const reader = response.body!.getReader();
      try {
        const ready = new TextDecoder().decode((await reader.read()).value);
        expect(ready).toContain("event: managed_events_ready");
        expect(ready).toContain('"revision":1');
        expect(ready).not.toContain("body");
        expect([snapshotCalls, subscribeCalls, listeners]).toEqual([1, 1, 1]);
        expect(listeners).toBe(1);
        listener!({ generation, latest_sequence: 1, revision: 2 });
        const changed = new TextDecoder().decode((await reader.read()).value);
        expect(changed).toContain("event: managed_events_changed");
        expect(changed).toContain('"revision":2');
        expect(changed).not.toContain("body");
        expect([snapshotCalls, subscribeCalls, listeners]).toEqual([1, 1, 1]);
        listener!({ generation, latest_sequence: 1, revision: 3 });
        listener!({ generation, latest_sequence: 1, revision: 4 });
        listener!({ generation, latest_sequence: 1, revision: 5 });
        const coalesced = new TextDecoder().decode((await reader.read()).value);
        expect(coalesced).toContain("event: managed_events_changed");
        expect(coalesced).toContain('"revision":5');
        expect(coalesced).not.toContain('"revision":3');
        expect(coalesced).not.toContain('"revision":4');
        expect(coalesced).not.toContain("body");
        expect([snapshotCalls, subscribeCalls, listeners]).toEqual([1, 1, 1]);
        expectMethodDelta(session, before);
      } finally {
        await reader.cancel();
      }
      expect(listeners).toBe(0);
      expect([snapshotCalls, subscribeCalls]).toEqual([1, 1]);
      expectMethodDelta(session, before);
    } finally {
      h.business.close();
    }
  });
});
