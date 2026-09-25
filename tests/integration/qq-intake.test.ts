// P2g: the intake runtime — connection events become durable observations (ADR0018).
//
// The whole point of this layer is what it does NOT do: it records and it schedules,
// and it never decides to speak. Two rules are easy to get backwards and are pinned
// here: a PAUSED conversation still observes (pausing stops talking, not watching), and
// an UNBOUND conversation is ignored rather than recorded, because a message that
// cannot be attributed to an assistant cannot be stored at all.
//
// The transport is injected, so nothing here opens a real connection, logs into QQ or
// touches a network.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readBindingByConversation,
  saveQqBinding,
} from "../../src/server/db/qq-binding-repository";
import { pendingObservationCount } from "../../src/server/db/qq-observation-repository";
import {
  readQqSettings,
  updateQqSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  OneBotConnection,
  type OneBotSendRequest,
  type OneBotSocket,
} from "../../src/server/services/onebot-connection";
import type { QqMessageResult } from "../../src/server/services/onebot-protocol";
import {
  createQqBinding,
  type QqBinding,
  updateQqBinding,
} from "../../src/server/services/qq-binding-contract";
import {
  type QqIntakeEvent,
  QqIntakeRuntime,
  qqIntakeCycle,
  recordInbound,
} from "../../src/server/services/qq-intake";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const NOW_SECONDS = Math.floor(Date.parse("2026-09-22T12:00:00.000Z") / 1000);
const TOKEN = "synthetic-token";

/** Same shape as the transport tests' fake, so both layers are exercised alike. */
class FakeSocket extends EventTarget implements OneBotSocket {
  readyState = 0;
  sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  terminations = 0;
  onSend?: (request: { action: string; params: Record<string, unknown>; echo: string }) => void;
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  /** Deliver a wire event, exactly as the transport would see it. */
  deliver(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
  terminate() {
    this.terminations += 1;
    this.readyState = 3;
  }
  send(payload: string) {
    const request = JSON.parse(payload) as {
      action: string;
      params: Record<string, unknown>;
      echo: string;
    };
    this.sent.push(request);
    this.onSend?.(request);
  }
  respond(request: { echo: string }, data: unknown) {
    this.deliver({ status: "ok", retcode: 0, data, echo: request.echo });
  }
}

/** Complete the handshake so the connection reaches `ready`. */
function completeHandshake(socket: FakeSocket, accountId = "10001") {
  // Install the responder BEFORE opening: the open event synchronously starts
  // verification, and an unanswered request would fail the handshake by timeout.
  socket.onSend = (request) => {
    if (request.action === "get_login_info")
      socket.respond(request, { user_id: Number(accountId) });
    if (request.action === "get_status") socket.respond(request, { online: true, good: true });
  };
  socket.open();
}

/** A wire group message from the synthetic group. */
function wireMessage(patch: Record<string, unknown> = {}) {
  return {
    time: NOW_SECONDS,
    self_id: 10001,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: -12,
    user_id: 20002,
    group_id: 30003,
    message: [{ type: "text", data: { text: "群友说喜欢猫" } }],
    ...patch,
  };
}

const GROUP: { accountId: string; kind: "group"; peerId: string } = {
  accountId: "10001",
  kind: "group",
  peerId: "30003",
};

function setup(options: { enabled?: boolean } = {}) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const sessionId = createSession(business.orm, "会话", { modelName: MODEL }).id;
  // A per-test key file, removed on close so the suite leaves no state behind.
  const dir = mkdtempSync(path.join(tmpdir(), "ss-qq-key-"));
  const keyPath = path.join(dir, "qq-transport.key");
  const h = {
    business,
    orm: business.orm,
    sessionId,
    keyPath,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
  // The switch is off in the seeded row, and intake refuses everything while it is, so
  // a test that means "intake is on" has to actually turn it on.
  if (options.enabled) setEnabled(h, true);
  return h;
}
type Setup = ReturnType<typeof setup>;

function setEnabled(h: Setup, enabled: boolean) {
  const current = readQqSettings(h.orm);
  updateQqSettings(h.orm, { enabled, accountId: "10001", expectedRevision: current.revision });
}

/**
 * Save the transport configuration the runtime will read. Tests point the key file at a
 * per-test temp path so no real key is touched, and nothing is left behind.
 */
function saveTransport(h: Setup, patch: { endpoint?: string | null; token?: string | null } = {}) {
  const current = readQqSettings(h.orm);
  updateQqTransportConfig(h.orm, {
    endpoint: patch.endpoint === undefined ? "ws://127.0.0.1:3000/" : patch.endpoint,
    token: patch.token === undefined ? TOKEN : patch.token,
    expectedRevision: current.revision,
    keyPath: h.keyPath,
  });
}

/** Persist a binding through the contract + repository, as a real caller would. */
function bind(
  h: Setup,
  patch: { memoryBatchSize?: number | null; paused?: boolean } = {},
): QqBinding {
  const created = createQqBinding({
    id: BINDING_ID,
    ...GROUP,
    agentId: AGENT_ID,
    schemeId: SCHEME_ID,
    paused: patch.paused ?? false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("expected a saved binding");
  // A binding must name a real scheme; the table trigger enforces it.
  insertScheme(h.orm);
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: created.binding.id,
      accountId: created.binding.accountId,
      conversationKind: created.binding.kind,
      peerId: created.binding.peerId,
      agentId: created.binding.agentId,
      schemeId: created.binding.schemeId,
      paused: created.binding.paused ? 1 : 0,
      shareWebMemory: created.binding.shareWebMemory ? 1 : 0,
      memoryBatchSize: patch.memoryBatchSize ?? null,
      ownerIdentityRevision: created.binding.ownerIdentityRevision,
      revision: created.binding.revision,
      authorityRevision: created.binding.authorityRevision,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  const saved = readBindingByConversation(h.orm, GROUP);
  if (saved === null) throw new Error("expected the binding to be readable");
  return saved;
}

/** Close the database and remove the per-test key directory. */
function closeSetup(h: Setup) {
  h.business.close();
  h.dispose();
}

/** Every binding in these tests names the same synthetic scheme. */
function insertScheme(orm: Orm, id = SCHEME_ID) {
  orm
    .insert(schema.qqSchemes)
    .values({ id, name: `方案 ${id}`, revision: 1, createdAt: nowIso(), updatedAt: nowIso() })
    .onConflictDoNothing()
    .run();
}

/** The memory scope a conversation writes into, built field by field. */
function qqScopeOf(identity: { accountId: string; kind: "group" | "private"; peerId: string }) {
  return {
    kind: "qq" as const,
    accountId: identity.accountId,
    conversationKind: identity.kind,
    peerId: identity.peerId,
    agentId: AGENT_ID,
  };
}

function messageResult(
  text = "群友说喜欢猫",
  messageId = -12,
  eventKey = `evt_${messageId}`,
): QqMessageResult {
  return {
    kind: "message",
    observation: {
      accountId: "10001",
      conversation: { kind: "group", peerId: "30003", key: '["qq","10001","group","30003"]' },
      eventKey,
      messageId: String(messageId),
      occurredAtSeconds: NOW_SECONDS,
      subType: "normal",
      speaker: { kind: "member", id: "20002", displayName: "群友" },
      segments: [{ kind: "text", text }],
      text,
      mentionsSelf: false,
    },
  };
}

describe("the row to contract mapping", () => {
  it("turns stored integers into the contract's booleans and kind", () => {
    const h = setup();
    try {
      const binding = bind(h, { paused: true });
      expect(binding.paused).toBe(true);
      expect(binding.shareWebMemory).toBe(false);
      expect(binding.kind).toBe("group");
      expect(binding.memoryBatchSize).toBeNull();
      // The mapping is validated by the contract, so what came out is a usable binding.
      expect(readBindingByConversation(h.orm, GROUP)?.id).toBe(BINDING_ID);
      expect(readBindingByConversation(h.orm, { ...GROUP, peerId: "99999" })).toBeNull();
    } finally {
      closeSetup(h);
    }
  });

  it("saves with compare-and-swap and refuses a stale revision", () => {
    const h = setup();
    try {
      const binding = bind(h);
      const changed = updateQqBinding(binding, { memoryBatchSize: 5 }, binding.revision);
      if (changed.kind !== "saved") throw new Error("expected a saved binding");
      const stored = saveQqBinding(h.orm, {
        binding: changed.binding,
        expectedRevision: binding.revision,
      });
      expect(stored.memoryBatchSize).toBe(5);
      // A second save from the same stale read must not clobber the newer row.
      expect(() =>
        saveQqBinding(h.orm, { binding: changed.binding, expectedRevision: binding.revision }),
      ).toThrow();
    } finally {
      closeSetup(h);
    }
  });
});

describe("handling one inbound message", () => {
  it("records a message from a bound conversation", () => {
    const h = setup({ enabled: true });
    try {
      bind(h);
      const events: QqIntakeEvent[] = [];
      const outcome = recordInbound(h.orm, messageResult(), {
        accountId: "10001",
        onEvent: (event) => events.push(event),
      });
      expect(outcome).toEqual({ kind: "recorded", recorded: true, hasText: true });
      expect(events).toEqual([{ kind: "recorded", recorded: true, hasText: true }]);
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
      expect(pendingObservationCount(h.orm, qqScopeOf(GROUP), nowIso())).toBe(1);
    } finally {
      closeSetup(h);
    }
  });

  it("still records while the conversation is paused, because pausing stops talking", () => {
    const h = setup({ enabled: true });
    try {
      bind(h, { paused: true, memoryBatchSize: 1 });
      expect(recordInbound(h.orm, messageResult("暂停期间说的话"), { accountId: "10001" })).toEqual(
        { kind: "recorded", recorded: true, hasText: true },
      );
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
      // Observation continues, but no work is triggered for a paused conversation.
      expect(qqIntakeCycle(h.orm).enqueued).toBe(0);
      expect(h.orm.select().from(schema.memoryJobs).all()).toEqual([]);
    } finally {
      closeSetup(h);
    }
  });

  it("ignores a message from an unbound conversation", () => {
    const h = setup({ enabled: true });
    try {
      const base = messageResult("别的群");
      if (base.kind !== "message") throw new Error("expected a message result");
      const elsewhere: QqMessageResult = {
        kind: "message",
        observation: {
          ...base.observation,
          conversation: { kind: "group", peerId: "40004", key: '["qq","10001","group","40004"]' },
        },
      };
      const outcome = recordInbound(h.orm, elsewhere, { accountId: "10001" });
      expect(outcome).toEqual({ kind: "ignored", reason: "unbound_conversation" });
      // Nothing can be stored without an assistant to attribute it to.
      expect(h.orm.select().from(schema.qqEvents).all()).toEqual([]);
    } finally {
      closeSetup(h);
    }
  });

  it("ignores traffic while the third-party switch is off, even on a live connection", () => {
    const h = setup();
    try {
      bind(h);
      expect(recordInbound(h.orm, messageResult(), { accountId: "10001" })).toEqual({
        kind: "ignored",
        reason: "switch_off",
      });
      expect(h.orm.select().from(schema.qqEvents).all()).toEqual([]);
    } finally {
      closeSetup(h);
    }
  });

  it("ignores a non-message result and a message for another account", () => {
    const h = setup({ enabled: true });
    try {
      bind(h);
      expect(
        recordInbound(h.orm, { kind: "ignored", reason: "self_message" }, { accountId: "10001" }),
      ).toEqual({ kind: "ignored", reason: "not_a_message" });
      expect(
        recordInbound(h.orm, { kind: "invalid", reason: "invalid_event" }, { accountId: "10001" }),
      ).toEqual({ kind: "ignored", reason: "not_a_message" });
      expect(recordInbound(h.orm, messageResult("别的账号"), { accountId: "10002" })).toEqual({
        kind: "discarded",
        reason: "invalid_observation",
      });
      expect(h.orm.select().from(schema.qqEvents).all()).toEqual([]);
    } finally {
      closeSetup(h);
    }
  });

  it("reports a duplicate delivery as a no-op and a conflicting one as a discard", () => {
    const h = setup({ enabled: true });
    try {
      bind(h);
      expect(recordInbound(h.orm, messageResult(), { accountId: "10001" })).toEqual({
        kind: "recorded",
        recorded: true,
        hasText: true,
      });
      // Same event key, same content: idempotent, and reported as not-newly-recorded.
      expect(recordInbound(h.orm, messageResult(), { accountId: "10001" })).toEqual({
        kind: "recorded",
        recorded: false,
        hasText: false,
      });
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
      // Same event key, different message: refused, and it must not take down intake.
      expect(
        recordInbound(h.orm, messageResult("换了内容", -99, "evt_-12"), { accountId: "10001" }),
      ).toEqual({ kind: "discarded", reason: "duplicate_key_conflict" });
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
    } finally {
      closeSetup(h);
    }
  });

  it("records a media-only message as an identity with no text", () => {
    const h = setup({ enabled: true });
    try {
      bind(h, { memoryBatchSize: 1 });
      const media = messageResult("", -20);
      if (media.kind !== "message") throw new Error("expected a message result");
      const withMedia: QqMessageResult = {
        kind: "message",
        observation: {
          ...media.observation,
          segments: [{ kind: "image", url: "https://example.invalid/a.png" }],
          text: "",
        },
      };
      expect(recordInbound(h.orm, withMedia, { accountId: "10001" })).toEqual({
        kind: "recorded",
        recorded: true,
        hasText: false,
      });
      // Identity only, so nothing is offered for consolidation.
      expect(qqIntakeCycle(h.orm).due).toBe(0);
    } finally {
      closeSetup(h);
    }
  });
});

describe("the housekeeping pass", () => {
  it("sweeps expired text before counting, so a trigger cannot fire on unreadable messages", () => {
    const h = setup({ enabled: true });
    try {
      bind(h, { memoryBatchSize: 2 });
      // One old message whose text has already expired, one fresh.
      const old = messageResult("过期消息", -30);
      if (old.kind !== "message") throw new Error("expected a message result");
      const expired: QqMessageResult = {
        kind: "message",
        observation: { ...old.observation, occurredAtSeconds: NOW_SECONDS - 20 * 24 * 3600 },
      };
      recordInbound(h.orm, expired, { accountId: "10001" });
      recordInbound(h.orm, messageResult("新消息", -31), { accountId: "10001" });
      // Two rows exist, but only one has readable text, so the count of 2 is not met.
      const result = qqIntakeCycle(h.orm);
      expect(result.purged).toBe(1);
      expect(result.due).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(h.orm.select().from(schema.memoryJobs).all()).toEqual([]);
    } finally {
      closeSetup(h);
    }
  });

  it("queues once the count is reached and reports a fixed summary", () => {
    const h = setup({ enabled: true });
    try {
      bind(h, { memoryBatchSize: 2 });
      recordInbound(h.orm, messageResult("第一条", -40), { accountId: "10001" });
      recordInbound(h.orm, messageResult("第二条", -41), { accountId: "10001" });
      const result = qqIntakeCycle(h.orm);
      expect(result).toEqual({ purged: 0, due: 1, enqueued: 1 });
      const job = h.orm.select().from(schema.memoryJobs).get();
      expect(job?.kind).toBe("manual");
      expect(
        (JSON.parse(job?.configSnapshot ?? "{}") as { scope_key: string }).scope_key,
      ).toContain("30003");
    } finally {
      closeSetup(h);
    }
  });
});

describe("the transport supervisor (P5r)", () => {
  /** A socket whose close event can be fired, which is what a dropped link looks like here. */
  function drop(socket: FakeSocket) {
    socket.readyState = 3;
    socket.dispatchEvent(new Event("close"));
  }

  function supervised(h: Setup, sockets: FakeSocket[], intervalMs = 10) {
    return new QqIntakeRuntime({
      orm: h.orm,
      transportKeyPath: h.keyPath,
      connectTimeoutMs: 500,
      requestTimeoutMs: 200,
      superviseIntervalMs: intervalMs,
      socketFactory: (): OneBotSocket => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
  }

  /**
   * A bot side that answers whenever it is dialled. The handshake is scheduled rather than run
   * inside the factory: the transport attaches its listeners after the factory returns, so
   * answering immediately would talk to nobody.
   */
  function answering(h: Setup, sockets: FakeSocket[], intervalMs = 10) {
    return new QqIntakeRuntime({
      orm: h.orm,
      transportKeyPath: h.keyPath,
      connectTimeoutMs: 500,
      requestTimeoutMs: 200,
      superviseIntervalMs: intervalMs,
      socketFactory: (): OneBotSocket => {
        const socket = new FakeSocket();
        sockets.push(socket);
        setTimeout(() => completeHandshake(socket), 0);
        return socket;
      },
    });
  }

  async function waitForPhase(runtime: QqIntakeRuntime, phase: string) {
    for (let attempt = 0; attempt < 80 && runtime.state.phase !== phase; attempt += 1) {
      await Bun.sleep(5);
    }
    return runtime.state;
  }

  it("reconnects after a dropped link instead of staying dead", async () => {
    const h = setup({ enabled: true });
    try {
      bind(h);
      saveTransport(h);
      const sockets: FakeSocket[] = [];
      const runtime = answering(h, sockets);
      await runtime.start();
      expect(await waitForPhase(runtime, "ready")).toEqual({
        phase: "ready",
        accountId: "10001",
      });

      // The link dies. Nothing tells the runtime to restart, so the supervisor has to notice —
      // and this test waits for the TIMER to do it rather than driving a pass by hand.
      drop(sockets[0] as FakeSocket);
      expect(runtime.state.phase).toBe("closed");
      expect(await waitForPhase(runtime, "ready")).toEqual({
        phase: "ready",
        accountId: "10001",
      });
      expect(sockets).toHaveLength(2);
      runtime.stop();
    } finally {
      closeSetup(h);
    }
  }, 15_000);

  it("gives up a live connection once the switch is turned off", async () => {
    const h = setup({ enabled: true });
    try {
      bind(h);
      saveTransport(h);
      const sockets: FakeSocket[] = [];
      const runtime = supervised(h, sockets);
      const started = runtime.start();
      completeHandshake(sockets[0] as FakeSocket);
      await started;
      expect(runtime.state.phase).toBe("ready");

      // The user switches the third-party transport off: that has to close the link, not just
      // stop new work on it.
      updateQqSettings(h.orm, { enabled: false, expectedRevision: readQqSettings(h.orm).revision });
      const after = await runtime.superviseOnce();
      expect(after.phase).not.toBe("ready");
      expect(runtime.connection).toBeNull();
      // …and it does not dial again while the switch is off.
      expect(sockets).toHaveLength(1);
      await runtime.superviseOnce();
      expect(sockets).toHaveLength(1);
      runtime.stop();
    } finally {
      closeSetup(h);
    }
  }, 15_000);

  it("lets stop() win over a handshake that is still in flight", async () => {
    const h = setup({ enabled: true });
    try {
      bind(h);
      saveTransport(h);
      const sockets: FakeSocket[] = [];
      const ticks: number[] = [];
      const runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        cycleIntervalMs: 1,
        superviseIntervalMs: 10,
        socketFactory: (): OneBotSocket => {
          const socket = new FakeSocket();
          sockets.push(socket);
          // The bot side answers later, on purpose: the handshake is in flight across stop().
          setTimeout(() => completeHandshake(socket), 30);
          return socket;
        },
      });
      const original = runtime.tick.bind(runtime);
      runtime.tick = (now?: string) => {
        ticks.push(1);
        return original(now);
      };
      const started = runtime.start();
      runtime.stop();
      // Let the in-flight handshake resolve after the stop.
      await Bun.sleep(60);
      await started;
      // The stopped runtime neither keeps the connection nor arms the housekeeping timer.
      expect(runtime.connection).toBeNull();
      expect(runtime.state.phase).not.toBe("ready");
      expect(ticks).toEqual([]);
      await runtime.superviseOnce();
      expect(sockets).toHaveLength(1);
    } finally {
      closeSetup(h);
    }
  }, 15_000);

  it("keeps looking while the configuration is incomplete, and stops looking after stop()", async () => {
    const h = setup({ enabled: true });
    try {
      bind(h);
      saveTransport(h, { token: null });
      const sockets: FakeSocket[] = [];
      const runtime = supervised(h, sockets);
      await runtime.start();
      // Switched on but half-configured: no socket, and the supervisor keeps checking.
      expect(sockets).toHaveLength(0);
      await runtime.superviseOnce();
      expect(sockets).toHaveLength(0);

      // Completing the configuration is enough for the next pass to dial — no restart needed.
      saveTransport(h);
      await runtime.superviseOnce();
      expect(sockets).toHaveLength(1);
      completeHandshake(sockets[0] as FakeSocket);

      runtime.stop();
      const before = sockets.length;
      await runtime.superviseOnce();
      expect(sockets).toHaveLength(before);
    } finally {
      closeSetup(h);
    }
  }, 15_000);
});

describe("the assembled runtime over an injected transport", () => {
  it("refuses to connect while the switch is off, and reports a fixed event", async () => {
    const h = setup();
    try {
      const events: QqIntakeEvent[] = [];
      let built = 0;
      const runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        socketFactory: () => {
          built += 1;
          return new FakeSocket();
        },
        onEvent: (event) => events.push(event),
      });
      expect(await runtime.start()).toEqual({ phase: "idle" });
      // No socket was ever created, so no login and no traffic.
      expect(built).toBe(0);
      expect(events).toEqual([{ kind: "ignored", reason: "switch_off" }]);
      expect(runtime.connection).toBeNull();
    } finally {
      closeSetup(h);
    }
  });

  it("does not connect while the saved configuration is incomplete", async () => {
    const h = setup({ enabled: true });
    try {
      const events: QqIntakeEvent[] = [];
      let built = 0;
      const runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        socketFactory: (): OneBotSocket => {
          built += 1;
          return new FakeSocket();
        },
        onEvent: (event) => events.push(event),
      });
      // Switched on, but no endpoint/token saved yet: a distinct outcome from "off",
      // and still no socket.
      expect(await runtime.start()).toEqual({ phase: "idle" });
      expect(built).toBe(0);
      expect(events).toEqual([{ kind: "ignored", reason: "not_configured" }]);
      // With only an endpoint saved it is still incomplete.
      saveTransport(h, { token: null });
      expect(await runtime.start()).toEqual({ phase: "idle" });
      expect(built).toBe(0);
      // With only a token saved it is still incomplete.
      saveTransport(h, { endpoint: null, token: TOKEN });
      expect(await runtime.start()).toEqual({ phase: "idle" });
      expect(built).toBe(0);
      // Complete: now it dials.
      saveTransport(h);
      const started = runtime.start();
      expect(built).toBe(1);
      runtime.stop();
      await started;
    } finally {
      closeSetup(h);
    }
  });

  it("records a delivered message, then triggers on the next housekeeping pass", async () => {
    const h = setup({ enabled: true });
    try {
      bind(h, { memoryBatchSize: 1 });
      saveTransport(h);
      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      const runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        cycleIntervalMs: 60_000,
        socketFactory: (): OneBotSocket => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        onEvent: (event) => events.push(event),
      });
      const started = runtime.start();
      const socket = sockets[0];
      if (!socket) throw new Error("expected a socket");
      completeHandshake(socket);
      expect(await started).toEqual({ phase: "ready", accountId: "10001" });

      // A real wire event, normalised by the transport, recorded by intake.
      socket.deliver(wireMessage());
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
      expect(events).toContainEqual({ kind: "recorded", recorded: true, hasText: true });

      expect(runtime.tick()).toEqual({ purged: 0, due: 1, enqueued: 1 });
      expect(events.filter((event) => event.kind === "cycle")).toHaveLength(1);
      runtime.stop();
      expect(socket.terminations).toBe(1);
    } finally {
      closeSetup(h);
    }
  });

  it("keeps the transport alive when a message would otherwise throw", async () => {
    const h = setup({ enabled: true });
    try {
      bind(h);
      saveTransport(h);
      // A conflicting re-delivery makes the storage layer refuse; the consumer must
      // absorb that instead of aborting the connection (which reports consumer_error).
      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      const runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        socketFactory: (): OneBotSocket => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        onEvent: (event) => events.push(event),
      });
      const started = runtime.start();
      const socket = sockets[0];
      if (!socket) throw new Error("expected a socket");
      completeHandshake(socket);
      await started;

      socket.deliver(wireMessage());
      // Same identity, different text: still the SAME message, so it is an idempotent
      // duplicate. The body is not part of the event identity.
      socket.deliver(wireMessage({ message: [{ type: "text", data: { text: "换了内容" } }] }));
      expect(events).toContainEqual({ kind: "recorded", recorded: false, hasText: false });
      // Same identity, different speaker: that is a genuine conflict and must be
      // refused rather than overwrite the recorded provenance.
      socket.deliver(wireMessage({ user_id: 20003 }));
      expect(events).toContainEqual({ kind: "discarded", reason: "duplicate_key_conflict" });
      // Still ready: the bad message did not take down the transport.
      expect(runtime.state).toEqual({ phase: "ready", accountId: "10001" });
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
      runtime.stop();
    } finally {
      closeSetup(h);
    }
  });

  it("keeps no failed attempt around, and retries on the supervisor's next pass", async () => {
    const h = setup({ enabled: true });
    try {
      saveTransport(h);
      let built = 0;
      const runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 100,
        requestTimeoutMs: 100,
        superviseIntervalMs: 10,
        socketFactory: (): OneBotSocket => {
          built += 1;
          const socket = new FakeSocket();
          // Never opens: the attempt must fail by timeout rather than hang.
          return socket;
        },
      });
      expect(await runtime.start()).toEqual({ phase: "idle" });
      expect(built).toBe(1);
      expect(runtime.connection).toBeNull();
      // The failed attempt is dropped, not kept — and the retry belongs to the supervisor, which
      // decides when to try again instead of the transport retrying underneath us.
      await runtime.superviseOnce();
      expect(built).toBe(2);
      expect(runtime.connection).toBeNull();
      runtime.stop();
    } finally {
      closeSetup(h);
    }
  });
});

void OneBotConnection;
void (undefined as unknown as OneBotSendRequest);
