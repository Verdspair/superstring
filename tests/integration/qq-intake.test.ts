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
import { eq } from "drizzle-orm";
import {
  readBindingByConversation,
  saveQqBinding,
} from "../../src/server/db/qq-binding-repository";
import { mediaNoteRow } from "../../src/server/db/qq-media-repository";
import { pendingObservationCount } from "../../src/server/db/qq-observation-repository";
import {
  readQqSettings,
  updateQqSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { VisionClient } from "../../src/server/llm/vision-client";
import type { SourceEvent } from "../../src/server/modules/contracts";
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
import { readQqAddressedMediaOnce } from "../../src/server/services/qq-media-cycle";
import type { QqMediaReadAdapter } from "../../src/server/services/qq-media-reader";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const TOKEN = "synthetic-token";
/** The three OneBot 11 source actions an automatic read would have sent. */
const MEDIA_ACTIONS: readonly string[] = ["get_image", "get_record", "get_file"];

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

/** A vision client that fails on the first call (optionally) and counts its calls. */
function recordingVision(failFirst: boolean): VisionClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async annotate(request) {
      calls.push(request.model);
      if (failFirst && calls.length === 1) throw new Error("synthetic model failure");
      return "图里是一只猫";
    },
  };
}

/** The retired cycle is still callable directly (§8.11): fixtures seed "a failed read" with it. */
function mediaCycleAdapter(vision: VisionClient & { calls: string[] }): QqMediaReadAdapter {
  return {
    capabilities: ["image"],
    read: ({ model }) => vision.annotate({ model, prompt: "看图", images: [] }),
  };
}

/** One failed first read: the row is left with a spent attempt and no note. */
async function seedFailedRead(
  orm: Orm,
  eventKey: string,
  vision: VisionClient & { calls: string[] },
) {
  return readQqAddressedMediaOnce(orm, mediaCycleAdapter(vision), {
    eventKey,
    addressedToAssistant: true,
    relatedSupplementArrived: false,
    modelConfig: { visionModelName: "vision-local", transcriptionModelName: null },
  });
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
      // The media fact is recorded for later (explicit) understanding, with nothing spent.
      expect(mediaNoteRow(h.orm, "evt_-20", 0)).toMatchObject({
        segmentKind: "image",
        sourceRef: "https://example.invalid/a.png",
        attempts: 0,
        note: null,
      });
    } finally {
      closeSetup(h);
    }
  });
});

describe("the housekeeping pass", () => {
  it("leaves expired text in place — deletion is manual — and does not count it", () => {
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
      // Only one row is still readable, so the count of 2 is not met — and the cycle itself
      // deleted nothing: every physical deletion is the explicit manual cleanup.
      const result = qqIntakeCycle(h.orm);
      expect(result).toEqual({ due: 0, enqueued: 0 });
      expect(pendingObservationCount(h.orm, qqScopeOf(GROUP))).toBe(1);
      expect(h.orm.select().from(schema.qqObservationText).all()).toHaveLength(2);
      expect(h.orm.select().from(schema.memoryJobs).all()).toEqual([]);
    } finally {
      closeSetup(h);
    }
  });

  it("purges nothing while the conversation is paused or the runtime is disconnected", () => {
    const h = setup({ enabled: true });
    try {
      // Paused: it keeps observing (the intake rule), and its expired rows stay put.
      bind(h, { memoryBatchSize: 2, paused: true });
      const old = messageResult("过期消息", -30);
      if (old.kind !== "message") throw new Error("expected a message result");
      const expired: QqMessageResult = {
        kind: "message",
        observation: { ...old.observation, occurredAtSeconds: NOW_SECONDS - 20 * 24 * 3600 },
      };
      recordInbound(h.orm, expired, { accountId: "10001" });
      // A runtime that never connected (no start, no socket): its tick schedules only.
      const events: QqIntakeEvent[] = [];
      const runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        onEvent: (event) => events.push(event),
      });
      expect(runtime.tick()).toEqual({ due: 0, enqueued: 0 });
      expect(events).toEqual([{ kind: "cycle", due: 0, enqueued: 0 }]);
      // Text AND nickname rows survive; nothing is reclaimed in the background.
      expect(h.orm.select().from(schema.qqObservationText).all()).toHaveLength(1);
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(1);
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
      expect(result).toEqual({ due: 1, enqueued: 1 });
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

      expect(runtime.tick()).toEqual({ due: 1, enqueued: 1 });
      expect(events.filter((event) => event.kind === "cycle")).toHaveLength(1);
      runtime.stop();
      expect(socket.terminations).toBe(1);
    } finally {
      closeSetup(h);
    }
  });

  it("notifies an asynchronous stateful memory module after committing each unique observation", async () => {
    const h = setup({ enabled: true });
    let runtime: QqIntakeRuntime | undefined;
    try {
      bind(h);
      saveTransport(h);
      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      class MemoryObserver {
        observed: SourceEvent[] = [];
        async observe(source: SourceEvent) {
          const row = h.business.db
            .query("SELECT event_key FROM qq_events WHERE event_key=?")
            .get(source.source.id);
          expect(row).toEqual({ event_key: source.source.id });
          await Promise.resolve();
          this.observed.push(source);
          return { source: source.source, created: false };
        }
      }
      const memory = new MemoryObserver();
      runtime = new QqIntakeRuntime({
        orm: h.orm,
        memory,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        cycleIntervalMs: 60_000,
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        onEvent: (event) => events.push(event),
      });
      const started = runtime.start();
      completeHandshake(sockets[0]);
      await started;
      sockets[0].deliver(wireMessage());
      sockets[0].deliver(wireMessage());
      await Bun.sleep(0);
      expect(memory.observed).toHaveLength(1);
      expect(memory.observed[0].source.kind).toBe("qq_event");
      expect(events).not.toContainEqual({ kind: "follow_up_failed" });
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
    } finally {
      runtime?.stop();
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
      // Same identity, a different body: a genuine conflict, not an idempotent duplicate.
      // A reused event key describing different text is refused, and the already-recorded
      // body must survive the refusal untouched.
      socket.deliver(wireMessage({ message: [{ type: "text", data: { text: "换了内容" } }] }));
      expect(events).toContainEqual({ kind: "discarded", reason: "duplicate_key_conflict" });
      // Re-read the stored fact: the conflict must not backfill or rewrite the recorded body.
      const factsAfterConflict = h.orm.select().from(schema.qqMessageFacts).all();
      expect(factsAfterConflict).toHaveLength(1);
      expect(JSON.parse(factsAfterConflict[0].parts)).toEqual([
        { kind: "text", text: "群友说喜欢猫" },
      ]);
      // Same identity, different speaker: that is a genuine conflict and must be
      // refused rather than overwrite the recorded provenance.
      socket.deliver(wireMessage({ user_id: 20003 }));
      expect(events).toContainEqual({ kind: "discarded", reason: "duplicate_key_conflict" });
      // A true identical redelivery — the original packet with the exact same body — is
      // the idempotent duplicate: not newly recorded, and no text is re-recorded.
      socket.deliver(wireMessage());
      expect(events).toContainEqual({ kind: "recorded", recorded: false, hasText: false });
      // Still ready: the bad messages did not take down the transport.
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

describe("an image message is recorded and never read (ADR0019 §8.11)", () => {
  it("records the segment and asks the bot side for nothing", async () => {
    const h = setup({ enabled: true });
    let runtime: QqIntakeRuntime | undefined;
    try {
      bind(h);
      saveTransport(h);
      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        cycleIntervalMs: 60_000,
        nowSeconds: () => NOW_SECONDS,
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

      socket.deliver(
        wireMessage({
          message_id: -91,
          message: [{ type: "image", data: { file: "upstream-91" } }],
        }),
      );
      for (let i = 0; i < 80 && !events.some((event) => event.kind === "follow_up"); i += 1) {
        await Bun.sleep(5);
      }
      expect(events).toContainEqual({
        kind: "follow_up",
        hasMedia: true,
        dispatch: "scheduled",
        own: "none",
        supplement: "none",
      });
      // Zero vision: no source action ever left the socket, and no attempt was spent.
      expect(socket.sent.filter((request) => MEDIA_ACTIONS.includes(request.action))).toEqual([]);
      const eventKey = h.orm.select().from(schema.qqEvents).all().at(-1)?.eventKey;
      if (eventKey === undefined) throw new Error("expected a recorded event");
      expect(mediaNoteRow(h.orm, eventKey, 0)).toMatchObject({
        segmentKind: "image",
        attempts: 0,
        note: null,
        addressed: 0,
      });
    } finally {
      runtime?.stop();
      closeSetup(h);
    }
  }, 15_000);

  it("does not retry a waiting read when the assistant is called again", async () => {
    const h = setup({ enabled: true });
    let runtime: QqIntakeRuntime | undefined;
    try {
      bind(h);
      saveTransport(h);
      h.orm
        .update(schema.organizationSettings)
        .set({ visionModelName: "vision-local" })
        .where(eq(schema.organizationSettings.id, 1))
        .run();
      // Seed a failed read through the retired cycle: one spent attempt, no note.
      const base = messageResult("", -20);
      if (base.kind !== "message") throw new Error("expected a message result");
      const withMedia: QqMessageResult = {
        kind: "message",
        observation: {
          ...base.observation,
          segments: [{ kind: "image", file: "upstream-seed" }],
          text: "",
        },
      };
      recordInbound(h.orm, withMedia, { accountId: "10001" });
      const vision = recordingVision(true);
      expect(await seedFailedRead(h.orm, "evt_-20", vision)).toMatchObject({
        kind: "read",
        result: { kind: "failed" },
      });
      expect(vision.calls).toHaveLength(1);
      expect(mediaNoteRow(h.orm, "evt_-20", 0)).toMatchObject({ attempts: 1, note: null });

      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      let addressed = 0;
      runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        cycleIntervalMs: 60_000,
        nowSeconds: () => NOW_SECONDS,
        onAddressedMessage: () => {
          addressed += 1;
        },
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

      // The same group calls the assistant about the picture, inside the old retry window.
      socket.deliver(
        wireMessage({
          message_id: -32,
          message: [
            { type: "at", data: { qq: "10001" } },
            { type: "text", data: { text: "刚发的图你看到了吗" } },
          ],
        }),
      );
      for (let i = 0; i < 80 && !events.some((event) => event.kind === "follow_up"); i += 1) {
        await Bun.sleep(5);
      }
      // The qualified wake still fires — the message is recorded, classified and signalled…
      expect(addressed).toBe(1);
      expect(events).toContainEqual({
        kind: "follow_up",
        hasMedia: false,
        dispatch: "not_scheduled",
        own: "none",
        supplement: "none",
      });
      // …but the waiting read is not: one model call in total, no second attempt, no source request.
      expect(vision.calls).toHaveLength(1);
      expect(mediaNoteRow(h.orm, "evt_-20", 0)).toMatchObject({ attempts: 1, note: null });
      expect(socket.sent.filter((request) => MEDIA_ACTIONS.includes(request.action))).toEqual([]);
    } finally {
      runtime?.stop();
      closeSetup(h);
    }
  }, 15_000);
});

describe("the main Agent's explicit source lookup (ADR0019 §8.11)", () => {
  it("answers not_ready while no connection is up", async () => {
    const h = setup({ enabled: true });
    try {
      bind(h);
      const runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
      });
      expect(await runtime.resolveMediaSource({ kind: "image", sourceRef: "upstream-1" })).toEqual({
        kind: "unavailable",
        reason: "not_ready",
      });
    } finally {
      closeSetup(h);
    }
  });

  it("passes a live request to the bot side and returns its reference verbatim", async () => {
    const h = setup({ enabled: true });
    let runtime: QqIntakeRuntime | undefined;
    try {
      bind(h);
      saveTransport(h);
      const sockets: FakeSocket[] = [];
      runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        socketFactory: (): OneBotSocket => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const started = runtime.start();
      const socket = sockets[0];
      if (!socket) throw new Error("expected a socket");
      completeHandshake(socket);
      await started;

      const pending = runtime.resolveMediaSource({ kind: "image", sourceRef: "upstream-7" });
      const asked = socket.sent.find((request) => request.action === "get_image");
      if (!asked) throw new Error("expected a get_image request");
      expect(asked.params).toEqual({ file: "upstream-7" });
      socket.respond(asked, { file: "C:/napcat/cache/a.png" });
      expect(await pending).toEqual({ kind: "source", reference: "C:/napcat/cache/a.png" });
    } finally {
      runtime?.stop();
      closeSetup(h);
    }
  }, 15_000);

  it("refuses an invalid request on a live connection", async () => {
    const h = setup({ enabled: true });
    let runtime: QqIntakeRuntime | undefined;
    try {
      bind(h);
      saveTransport(h);
      const sockets: FakeSocket[] = [];
      runtime = new QqIntakeRuntime({
        orm: h.orm,
        transportKeyPath: h.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        socketFactory: (): OneBotSocket => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const started = runtime.start();
      const socket = sockets[0];
      if (!socket) throw new Error("expected a socket");
      completeHandshake(socket);
      await started;

      expect(await runtime.resolveMediaSource({ kind: "video", sourceRef: "" })).toEqual({
        kind: "unavailable",
        reason: "invalid_request",
      });
    } finally {
      runtime?.stop();
      closeSetup(h);
    }
  }, 15_000);
});

void OneBotConnection;
void (undefined as unknown as OneBotSendRequest);
