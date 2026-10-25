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
  const session = createNapCatManagedSession({
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
    stats: () => ({ reads, spawns, kills, requests, statusRequests, maxActiveStatus }),
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

  it("returns QR only on explicit logged-out operations and never in status", async () => {
    const h = harness();
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
