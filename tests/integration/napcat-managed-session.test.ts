import { describe, expect, it } from "bun:test";
import path from "node:path";
import { NapCatControlClient } from "../../src/server/napcat/control-client";
import { createNapCatManagedSession } from "../../src/server/napcat/management";
import { NapCatRuntimeManager } from "../../src/server/napcat/runtime-manager";
import { QqManagedQrSchema, QqManagedStatusSchema } from "../../src/shared/contracts/qq-managed";

const privateToken = "synthetic-private-control-token";
const privateCredential = "synthetic-private-session-credential";
const privateQr = "https://synthetic.invalid/private-qr";

function harness(enabled = true) {
  let saved = { version: 1 as const, enabled };
  let revision = "initial";
  let online = true;
  let coreReady = true;
  let loggedIn = true;
  let identityMatches = true;
  let phase: "idle" | "ready" = "idle";
  let loginPhase = "Online";
  let challenge = false;
  let authFailure = false;
  let blockedStatus: Promise<void> | null = null;
  let blockedAuth: Promise<void> | null = null;
  let reads = 0;
  let spawns = 0;
  let kills = 0;
  let requests = 0;
  let statusRequests = 0;
  let activeStatus = 0;
  let maxActiveStatus = 0;
  let resolveExit!: (code: number) => void;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let settings = {
    revision: 1,
    enabled: true,
    accountId: "10001" as string | null,
    endpoint: "ws://127.0.0.1:3001/" as string | null,
    token: "synthetic-onebot-token" as string | null,
  };
  let loginAccount = "10001";
  let network = { network: { websocketServers: [] as Record<string, unknown>[] }, unknown: "keep" };
  let networkWrites = 0;
  let networkReads = 0;
  let quickLogins = 0;
  let accountReads = 0;
  let blockedAccounts: Promise<void> | null = null;
  let applyConfig = true;
  let unknownWrite = false;
  let resourceRevision = "resource-0";
  let prepares = 0;
  const manager = new NapCatRuntimeManager({
    enabled: true,
    spawnChild() {
      spawns += 1;
      online = true;
      return {
        pid: 41001,
        exited: new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
        stdout: null,
        stderr: null,
        kill() {
          kills += 1;
          online = false;
          resolveExit(0);
        },
      };
    },
  });
  const client = new NapCatControlClient({
    baseUrl: "http://127.0.0.1:6099",
    timeoutMs: 1000,
    async fetch(input, init) {
      requests += 1;
      if (!online) throw Object.assign(new Error("synthetic offline"), { code: "ECONNREFUSED" });
      const route = new URL(String(input)).pathname;
      let data: unknown;
      if (route === "/api/auth/login") {
        if (blockedAuth) await blockedAuth;
        if (authFailure) return Response.json({ code: -1, message: "rejected" }, { status: 401 });
        data = challenge
          ? { require2FA: true, message: "synthetic challenge" }
          : { Credential: privateCredential };
      } else {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${privateCredential}`);
        if (route === "/api/QQLogin/CheckLoginStatus") {
          statusRequests += 1;
          activeStatus += 1;
          maxActiveStatus = Math.max(maxActiveStatus, activeStatus);
          try {
            if (blockedStatus) await blockedStatus;
          } finally {
            activeStatus -= 1;
          }
          data = {
            isLogin: loggedIn,
            isOffline: false,
            loginPhase,
            qrLoginAccepted: false,
            coreReady,
            qrcodeurl: privateQr,
            loginError: "synthetic-private-upstream-error",
          };
        } else if (route === "/api/QQLogin/GetQQLoginQrcode") data = { qrcode: privateQr };
        else if (route === "/api/QQLogin/RefreshQRcode") data = { qrcodeurl: privateQr };
        else throw new Error("unexpected route");
      }
      return Response.json({ code: 0, message: "success", data });
    },
  });
  Object.assign(client, {
    async getLoginAccount() {
      return loginAccount;
    },
    async getQuickLoginAccounts() {
      accountReads += 1;
      if (blockedAccounts) await blockedAccounts;
      return [{ account_id: "10001", display_name: "Synthetic account" }];
    },
    async quickLogin() {
      quickLogins += 1;
    },
    async getOneBotConfig() {
      networkReads += 1;
      return structuredClone(network);
    },
    async setOneBotConfig(_credential: string, value: typeof network) {
      networkWrites += 1;
      if (applyConfig) network = structuredClone(value);
      if (unknownWrite) throw new Error("synthetic write outcome unknown");
    },
  });
  const session = createNapCatManagedSession({
    resources: {
      read: () => ({
        revision: resourceRevision,
        status: "ready" as const,
        root: path.resolve("synthetic"),
        diagnostic_code: null,
      }),
      prepare: (input: { expected_revision: string; root: string }) => {
        prepares += 1;
        if (input.expected_revision !== resourceRevision)
          throw Object.assign(new Error("conflict"), { code: "NAPCAT_RESOURCE_CONFLICT" });
        resourceRevision = "resource-1";
        return {
          revision: resourceRevision,
          status: "ready" as const,
          root: input.root,
          diagnostic_code: null,
        };
      },
    },
    readConnectionSettings: () => ({ ...settings }),
    store: {
      read() {
        reads += 1;
        return { revision, config: { ...saved } };
      },
      replace(expectedRevision: string, config: typeof saved) {
        if (expectedRevision !== revision)
          throw Object.assign(new Error("conflict"), { code: "NAPCAT_CONFIG_CONFLICT" });
        saved = { ...config };
        revision = "saved";
        return { revision, config: { ...saved } };
      },
    },
    manager,
    loadRuntime: () => ({
      client,
      launch: {
        command: path.resolve("synthetic/node.exe"),
        cwd: path.resolve("synthetic"),
        args: ["index.js"],
        env: {},
      },
      token: privateToken,
    }),
    transportState: () => ({ phase }),
    identityMatches: () => identityMatches,
    pollIntervalMs: 5000,
    stopDeadlineMs: 1000,
    setTimeoutFn(callback: () => void, milliseconds: number) {
      expect(milliseconds).toBe(5000);
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeoutFn(id: unknown) {
      timers.delete(id as number);
    },
  });
  return {
    session,
    manager,
    timers,
    stats: () => ({
      reads,
      spawns,
      kills,
      requests,
      statusRequests,
      maxActiveStatus,
      networkReads,
      networkWrites,
      accountReads,
      quickLogins,
      prepares,
    }),
    patchSettings(patch: Partial<typeof settings>) {
      settings = { ...settings, ...patch };
    },
    setLoginAccount(value: string) {
      loginAccount = value;
    },
    setNetworkApply(value: boolean) {
      applyConfig = value;
    },
    setUnknownWrite(value: boolean) {
      unknownWrite = value;
    },
    network: () => structuredClone(network),
    setNetworkServers(entries: Record<string, unknown>[]) {
      network.network.websocketServers = structuredClone(entries);
    },
    blockAccounts(value: Promise<void> | null) {
      blockedAccounts = value;
    },
    setOnline(value: boolean) {
      online = value;
    },
    setLogin(value: boolean, ready = value, nextPhase = "QRCode") {
      loggedIn = value;
      coreReady = ready;
      loginPhase = nextPhase;
    },
    setIdentity(value: boolean) {
      identityMatches = value;
    },
    setTransport(value: "idle" | "ready") {
      phase = value;
    },
    setChallenge() {
      challenge = true;
    },
    setAuthFailure() {
      authFailure = true;
    },
    blockStatus(value: Promise<void> | null) {
      blockedStatus = value;
    },
    blockAuth(value: Promise<void> | null) {
      blockedAuth = value;
    },
    fireTimer() {
      const entry = timers.entries().next().value;
      if (!entry) throw new Error("missing timer");
      timers.delete(entry[0]);
      entry[1]();
    },
  };
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function expectSafeStatus(value: unknown) {
  expect(QqManagedStatusSchema.safeParse(value).success).toBe(true);
  const text = JSON.stringify(value);
  for (const secret of [
    privateToken,
    privateCredential,
    privateQr,
    "synthetic-private-upstream-error",
  ])
    expect(text).not.toContain(secret);
}

describe("NapCat managed session", () => {
  it("keeps snapshot pure and disabled start free of native/auth/timer work", async () => {
    const h = harness(false);
    const before = h.stats();
    expectSafeStatus(h.session.snapshot());
    expect(h.stats()).toEqual(before);
    await h.session.start();
    expect(h.session.snapshot()).toMatchObject({
      process: "disabled",
      ownership: "none",
      phase: "stopped",
    });
    expect(h.stats()).toMatchObject({ spawns: 0, requests: 0, kills: 0 });
    expect(h.timers.size).toBe(0);
    await h.session.stop();
  });

  it("observes a pre-existing runtime without adopting or killing it even after disable", async () => {
    const h = harness();
    await Promise.all([h.session.start(), h.session.start()]);
    expect(h.session.snapshot()).toMatchObject({
      ownership: "external",
      process: "running",
      phase: "core_online",
    });
    expect(h.stats()).toMatchObject({ spawns: 0 });
    expect(h.timers.size).toBe(1);
    h.session.replaceConfig("initial", { version: 1, enabled: false });
    await h.session.retry();
    await h.session.stop();
    expect(h.stats()).toMatchObject({ kills: 0, spawns: 0 });
    expect(h.timers.size).toBe(0);
  });

  it("starts exactly one owned child only after unavailable control and awaits its stop", async () => {
    const h = harness();
    h.setOnline(false);
    await Promise.all([h.session.start(), h.session.retry()]);
    expect(h.stats()).toMatchObject({ spawns: 1 });
    expect(h.session.snapshot()).toMatchObject({ ownership: "owned", process: "running" });
    await h.session.stop();
    expect(h.stats()).toMatchObject({ kills: 1 });
    expect(h.manager.snapshot.status).toBe("stopped");
    expect(h.timers.size).toBe(0);
  });

  it("requires core readiness, real transport readiness and account match together", async () => {
    const h = harness();
    h.setTransport("ready");
    h.setIdentity(false);
    await h.session.start();
    expect(h.session.snapshot()).toMatchObject({
      phase: "error",
      diagnostic_code: "account_mismatch",
    });
    h.setIdentity(true);
    h.setLogin(true, false);
    h.fireTimer();
    await flush();
    expect(h.session.snapshot()).not.toMatchObject({ phase: "transport_ready" });
    h.setLogin(true, true);
    h.fireTimer();
    await flush();
    expect(h.session.snapshot()).toMatchObject({
      phase: "transport_ready",
      core_ready: true,
      transport_phase: "ready",
    });
    expectSafeStatus(h.session.snapshot());
    await h.session.stop();
  });

  it("keeps core online while idle transport has not established account identity", async () => {
    const h = harness();
    h.setTransport("idle");
    h.setIdentity(false);
    await h.session.start();
    try {
      expect(h.session.snapshot()).toMatchObject({
        phase: "core_online",
        core_ready: true,
        transport_phase: "idle",
        diagnostic_code: null,
      });
    } finally {
      await h.session.stop();
    }
  });

  it("ignores a captured old timer after stop and restart", async () => {
    const h = harness();
    await h.session.start();
    const oldCallback = h.timers.values().next().value!;
    await h.session.stop();
    await h.session.start();
    const before = h.stats();
    const newTimers = [...h.timers.entries()];
    try {
      oldCallback();
      await flush();
      expect(h.stats()).toEqual(before);
      expect([...h.timers.entries()]).toEqual(newTimers);
    } finally {
      await h.session.stop();
    }
    expect(h.timers.size).toBe(0);
  });

  it("polls sequentially and stop prevents late status from reviving the session", async () => {
    const h = harness();
    await h.session.start();
    let release!: () => void;
    h.blockStatus(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    h.fireTimer();
    await flush();
    expect(h.timers.size).toBe(0);
    const stopping = h.session.stop();
    release();
    await stopping;
    await flush();
    expect(h.stats().maxActiveStatus).toBe(1);
    expect(h.timers.size).toBe(0);
    expect(h.session.snapshot()).toMatchObject({ phase: "stopped" });
  });

  it("returns QR only on explicit owned logged-out operations and never in status", async () => {
    const h = harness();
    h.setOnline(false);
    h.setLogin(false, false);
    await h.session.start();
    expect(h.session.snapshot()).toMatchObject({ phase: "waiting_scan" });
    expectSafeStatus(h.session.snapshot());
    const current = await h.session.getQr();
    expect(QqManagedQrSchema.parse(current)).toEqual({ qr_payload: privateQr });
    expect(await h.session.refreshQr()).toEqual({ qr_payload: privateQr });
    h.setLogin(true, true);
    h.fireTimer();
    await flush();
    const before = h.stats().requests;
    expect(await h.session.refreshQr()).toEqual({ qr_payload: null });
    expect(h.stats().requests).toBe(before);
    await h.session.stop();
  });

  it("does not spawn over a reachable server that rejects control authentication", async () => {
    const h = harness();
    h.setAuthFailure();
    await h.session.start();
    expect(h.stats().spawns).toBe(0);
    expect(h.session.snapshot()).toMatchObject({
      ownership: "external",
      phase: "error",
      diagnostic_code: "control_unavailable",
    });
    expectSafeStatus(h.session.snapshot());
    await h.session.stop();
  });

  it("reports two-factor challenge without spawning or leaking the control secret", async () => {
    const h = harness();
    h.setChallenge();
    await h.session.start();
    expect(h.session.snapshot()).toMatchObject({
      ownership: "external",
      phase: "challenge",
      diagnostic_code: "challenge_required",
    });
    expect(h.stats().spawns).toBe(0);
    expectSafeStatus(h.session.snapshot());
    await h.session.stop();
  });
});

describe("NapCat managed first-use and owned network", () => {
  it("never mutates external runtime config or offers its remembered accounts", async () => {
    const h = harness();
    await h.session.start();
    try {
      expect(h.session.snapshot()).toMatchObject({
        ownership: "external",
        network_apply: "not_owned",
      });
      expect(h.stats()).toMatchObject({ networkReads: 0, networkWrites: 0, accountReads: 0 });
      await expect(h.session.listAccounts()).rejects.toThrow();
      expect(h.stats().accountReads).toBe(0);
      h.setLogin(false, false);
      h.fireTimer();
      await flush();
      const before = h.stats().requests;
      expect(await h.session.getQr()).toEqual({ qr_payload: null });
      expect(await h.session.refreshQr()).toEqual({ qr_payload: null });
      expect(h.stats().requests).toBe(before);
    } finally {
      await h.session.stop();
    }
  });

  it("waits for core online and selected real login identity before touching per-account config", async () => {
    const h = harness();
    h.setOnline(false);
    h.setLogin(false, false);
    await h.session.start();
    try {
      expect(h.stats()).toMatchObject({ networkReads: 0, networkWrites: 0 });
      h.setLogin(true, true);
      h.setLoginAccount("10002");
      h.fireTimer();
      await flush();
      expect(h.session.snapshot()).toMatchObject({
        phase: "error",
        diagnostic_code: "account_mismatch",
      });
      expect(h.stats()).toMatchObject({ networkReads: 0, networkWrites: 0 });
    } finally {
      await h.session.stop();
    }
  });

  it("applies one owned listener once, preserves unknown values and requires current handshake", async () => {
    const h = harness();
    h.setOnline(false);
    await h.session.start();
    try {
      expect(h.stats().networkWrites).toBe(1);
      expect(h.network().unknown).toBe("keep");
      expect(h.session.snapshot()).toMatchObject({ core_ready: true, network_apply: "pending" });
      h.setTransport("ready");
      h.fireTimer();
      await flush();
      expect(h.session.snapshot()).toMatchObject({
        phase: "transport_ready",
        network_apply: "verified",
      });
      expect(h.stats().networkWrites).toBe(1);
      h.patchSettings({ token: "changed-token", revision: 2 });
      h.setIdentity(false);
      expect(h.session.snapshot()).not.toMatchObject({ network_apply: "verified" });
      h.fireTimer();
      await flush();
      expect(h.stats().networkWrites).toBe(2);
      expect(h.session.snapshot()).not.toMatchObject({ phase: "transport_ready" });
    } finally {
      await h.session.stop();
    }
  });

  it("does not turn business on or create green readiness while business is disabled", async () => {
    const h = harness();
    h.patchSettings({ enabled: false });
    h.setOnline(false);
    await h.session.start();
    try {
      expect(h.session.snapshot()).toMatchObject({ core_ready: true, network_apply: "pending" });
      expect(h.session.snapshot()).not.toMatchObject({ phase: "transport_ready" });
      expect(h.stats().spawns).toBe(1);
    } finally {
      await h.session.stop();
    }
  });

  it("does not replay unknown SetConfig outcomes during ordinary polling", async () => {
    const h = harness();
    h.setOnline(false);
    h.setNetworkApply(false);
    h.setUnknownWrite(true);
    await h.session.start();
    try {
      expect(h.stats().networkWrites).toBe(1);
      expect(h.session.snapshot()).toMatchObject({ network_apply: "failed" });
      h.fireTimer();
      await flush();
      expect(h.stats().networkWrites).toBe(1);
      expect(h.session.snapshot()).not.toMatchObject({ phase: "transport_ready" });
      expect(h.stats().networkReads).toBeGreaterThan(1);
    } finally {
      await h.session.stop();
    }
  });

  it("keeps unavailable settings explicit and does no network config work", async () => {
    const h = harness();
    h.setOnline(false);
    h.patchSettings({ accountId: null, token: null });
    await h.session.start();
    try {
      expect(h.session.snapshot()).toMatchObject({
        phase: "configuration_required",
        network_apply: "not_configured",
      });
      expect(h.stats()).toMatchObject({ networkReads: 0, networkWrites: 0 });
    } finally {
      await h.session.stop();
    }
  });

  it("quick-login is one explicit saved-account action and stale requests never call the vendor", async () => {
    const h = harness();
    h.setOnline(false);
    h.setLogin(false, false);
    await h.session.start();
    try {
      expect(await h.session.listAccounts()).toEqual({
        accounts: [{ account_id: "10001", display_name: "Synthetic account" }],
      });
      expect(h.timers.size).toBe(1);
      await expect(
        h.session.quickLogin({ account_id: "10001", expected_settings_revision: 2 }),
      ).rejects.toThrow();
      await expect(
        h.session.quickLogin({ account_id: "10002", expected_settings_revision: 1 }),
      ).rejects.toThrow();
      expect(h.stats().quickLogins).toBe(0);
      await h.session.quickLogin({ account_id: "10001", expected_settings_revision: 1 });
      expect(h.stats().quickLogins).toBe(1);
      h.fireTimer();
      await flush();
      expect(h.stats().quickLogins).toBe(1);
    } finally {
      await h.session.stop();
    }
  });

  it("resource inspection is pure and an active owned child cannot be replaced by preparation", async () => {
    const h = harness();
    const before = h.stats();
    expect(h.session.readResources()).toMatchObject({ status: "ready", revision: "resource-0" });
    expect(h.stats()).toEqual(before);
    h.setOnline(false);
    await h.session.start();
    try {
      await expect(
        h.session.prepareResources({
          expected_revision: "resource-0",
          root: path.resolve("other-synthetic"),
        }),
      ).rejects.toThrow();
      expect(h.stats().prepares).toBe(0);
    } finally {
      await h.session.stop();
    }
    expect(
      await h.session.prepareResources({
        expected_revision: "resource-0",
        root: path.resolve("other-synthetic"),
      }),
    ).toMatchObject({ revision: "resource-1" });
    expect(h.stats().prepares).toBe(1);
  });
});

describe("NapCat owned operation cleanup", () => {
  it("does not prepare over a previously observed external service after disabling", async () => {
    const h = harness();
    await h.session.start();
    await h.session.stop();
    await expect(
      h.session.prepareResources({
        expected_revision: "resource-0",
        root: path.resolve("other-synthetic"),
      }),
    ).rejects.toThrow();
    expect(h.stats()).toMatchObject({ prepares: 0, kills: 0 });
    h.setOnline(false);
    const saved = await h.session.prepareResources({
      expected_revision: "resource-0",
      root: path.resolve("other-synthetic"),
    });
    expect(saved).toMatchObject({ revision: "resource-1" });
    expect(h.stats()).toMatchObject({ prepares: 1, kills: 0 });
  });
});

describe("NapCat existing listener readiness", () => {
  const listener = {
    name: "existing-official-listener",
    enable: true,
    host: "127.0.0.1",
    port: 3001,
    token: "synthetic-onebot-token",
    messagePostFormat: "array",
    reportSelfMessage: false,
    heartInterval: 30000,
    enableForcePushEvent: true,
    debug: false,
  };
  it("preserves an exact existing listener without SetConfig and verifies the current handshake", async () => {
    const h = harness();
    h.setOnline(false);
    h.setNetworkServers([listener]);
    h.setTransport("ready");
    await h.session.start();
    try {
      expect(h.stats().networkWrites).toBe(0);
      expect(h.network().network.websocketServers).toEqual([listener]);
      expect(h.session.snapshot()).toMatchObject({
        network_apply: "verified",
        phase: "transport_ready",
      });
    } finally {
      await h.session.stop();
    }
  });
  it("does not use an old ready socket to hide a conflicting listener", async () => {
    const h = harness();
    h.setOnline(false);
    h.setNetworkServers([{ ...listener, token: "other-secret" }]);
    h.setTransport("ready");
    await h.session.start();
    try {
      expect(h.stats().networkWrites).toBe(0);
      expect(h.session.snapshot()).toMatchObject({
        network_apply: "not_configured",
        phase: "configuration_required",
      });
      expect(h.session.snapshot()).not.toMatchObject({ phase: "transport_ready" });
    } finally {
      await h.session.stop();
    }
  });
});

describe("NapCat explicit login operation cancellation", () => {
  it("cancels stale account action publication and still stops the owned child", async () => {
    const h = harness();
    h.setOnline(false);
    h.setLogin(false, false);
    await h.session.start();
    let release!: () => void;
    h.blockAccounts(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const action = h.session.quickLogin({ account_id: "10001", expected_settings_revision: 1 });
    const outcome = action.then(
      () => null,
      (error: unknown) => error,
    );
    await flush();
    const stop = h.session.stop();
    release();
    expect(await outcome).toBeInstanceOf(Error);
    await stop;
    expect(h.stats()).toMatchObject({ quickLogins: 0, kills: 1 });
    expect(h.session.snapshot()).toMatchObject({ phase: "stopped" });
    expect(h.timers.size).toBe(0);
  });
});

describe("NapCat write uncertainty and resource probe serialization", () => {
  it("does not replay an unknown SetConfig even on explicit retry", async () => {
    const h = harness();
    h.setOnline(false);
    h.setNetworkApply(false);
    h.setUnknownWrite(true);
    await h.session.start();
    try {
      expect(h.stats().networkWrites).toBe(1);
      await h.session.retry();
      expect(h.stats().networkWrites).toBe(1);
      expect(h.session.snapshot()).toMatchObject({ network_apply: "failed" });
    } finally {
      await h.session.stop();
    }
  });

  it("does not half-start while an explicit stopped resource probe is in flight", async () => {
    const h = harness();
    await h.session.start();
    await h.session.stop();
    let release!: () => void;
    h.blockAuth(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const prepare = h.session.prepareResources({
      expected_revision: "resource-0",
      root: path.resolve("other-synthetic"),
    });
    const prepareOutcome = prepare.then(
      () => null,
      (error: unknown) => error,
    );
    await flush();
    const start = h.session.start();
    const startOutcome = start.then(
      () => null,
      (error: unknown) => error,
    );
    release();
    expect(await prepareOutcome).toBeInstanceOf(Error);
    expect(await startOutcome).toBeInstanceOf(Error);
    expect(h.session.snapshot()).toMatchObject({ phase: "stopped" });
    expect(h.timers.size).toBe(0);
    h.blockAuth(null);
    await h.session.start();
    expect(h.session.snapshot()).toMatchObject({ ownership: "external", core_ready: true });
    expect(h.timers.size).toBe(1);
    await h.session.stop();
  });
});
