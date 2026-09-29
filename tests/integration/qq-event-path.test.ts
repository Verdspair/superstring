// The inbound event path (ADR0018 P5m): classify and report; media is recorded, never read.
//
// ADR0019 §8.11 moved understanding out of the inbound path: these cases pin that a picture — and a
// failed read waiting for a supplement — never spends a model call here, while classification, the
// recorded media fact and the canonical ingress wake are unchanged. The retired cycle is still
// callable directly, so the "waiting read" state is seeded with it rather than through this path.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readQqDispatchCandidate } from "../../src/server/db/qq-dispatch-repository";
import { mediaNoteRow, pendingMediaSupplementFor } from "../../src/server/db/qq-media-repository";
import {
  readQqSettings,
  updateQqSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import type { VisionClient } from "../../src/server/llm/vision-client";
import type { OneBotSocket } from "../../src/server/services/onebot-connection";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import { handleQqRecordedMessage } from "../../src/server/services/qq-event-path";
import {
  type QqIntakeEvent,
  QqIntakeRuntime,
  recordInbound,
} from "../../src/server/services/qq-intake";
import { readQqAddressedMediaOnce } from "../../src/server/services/qq-media-cycle";
import type { QqMediaReadAdapter } from "../../src/server/services/qq-media-reader";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "10001";
const PEER_ID = "30003";
const SPEAKER_ID = "20002";
const NOW = 2_000_000_000;
const TOKEN = "synthetic-token";
/** The three OneBot 11 source actions an automatic read would have sent. */
const MEDIA_ACTIONS: readonly string[] = ["get_image", "get_record", "get_file"];

function observation(patch: {
  eventKey?: string;
  mentionsSelf?: boolean;
  speakerId?: string | null;
  occurredAtSeconds?: number;
  segments?: QqObservation["segments"];
  conversationKind?: "group" | "private";
}): QqObservation {
  const eventKey = patch.eventKey ?? "evt-1";
  const speakerId = patch.speakerId === undefined ? SPEAKER_ID : patch.speakerId;
  return {
    accountId: ACCOUNT_ID,
    conversation: { kind: patch.conversationKind ?? "group", peerId: PEER_ID, key: "[]" },
    eventKey,
    messageId: eventKey,
    occurredAtSeconds: patch.occurredAtSeconds ?? NOW,
    subType: "normal",
    speaker: {
      kind: speakerId === null ? "anonymous" : "member",
      id: speakerId,
      displayName: "群友",
    },
    segments: patch.segments ?? [{ kind: "text", text: "群友说喜欢猫" }],
    text: "群友说喜欢猫",
    mentionsSelf: patch.mentionsSelf ?? false,
  };
}

interface Setup {
  h: BusinessDbHandle;
  dir: string;
  keyPath: string;
  close(): void;
}

function setup(): Setup {
  const dir = mkdtempSync(path.join(tmpdir(), "ss-event-path-"));
  const business = openBusinessDb();
  const keyPath = path.join(dir, "transport.key");
  ensureDefaults(business.orm, "synthetic-model");
  updateQqSettings(business.orm, {
    accountId: ACCOUNT_ID,
    enabled: true,
    expectedRevision: 1,
  });
  // The vision purpose on the shared settings row: the retired cycle (seeded below) needs it to
  // reach the model, exactly as an explicit Agent tool call will later.
  business.orm
    .update(schema.organizationSettings)
    .set({ visionModelName: "vision-local" })
    .where(eq(schema.organizationSettings.id, 1))
    .run();
  // The scheme must exist before the binding: a table trigger refuses a binding that names a
  // scheme which is not there, and that refusal is one of the guarantees these tests rely on.
  business.orm
    .insert(schema.qqSchemes)
    .values({ id: SCHEME_ID, name: "方案", revision: 1, createdAt: nowIso(), updatedAt: nowIso() })
    .run();
  const created = createQqBinding({
    id: BINDING_ID,
    accountId: ACCOUNT_ID,
    kind: "group",
    peerId: PEER_ID,
    agentId: AGENT_ID,
    schemeId: SCHEME_ID,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("expected a saved binding");
  business.orm
    .insert(schema.qqBindings)
    .values({
      id: created.binding.id,
      accountId: created.binding.accountId,
      conversationKind: created.binding.kind,
      peerId: created.binding.peerId,
      agentId: created.binding.agentId,
      schemeId: created.binding.schemeId,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  return {
    h: business,
    dir,
    keyPath,
    close() {
      business.close();
      rmSync(dir, { recursive: true, force: true });
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

/** One failed first read: the row is left with a spent attempt and no note, waiting for a supplement. */
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

/** One recorded message on a fresh database. */
function fixture(patch: Parameters<typeof observation>[0]) {
  const s = setup();
  const recorded = recordInbound(
    s.h.orm,
    { kind: "message", observation: observation(patch) },
    { accountId: ACCOUNT_ID },
  );
  if (recorded.kind !== "recorded") throw new Error("expected a recorded message");
  return { s };
}

describe("classification and queueing", () => {
  it("turns a group message that is not addressed into an initiative candidate", async () => {
    const { s } = fixture({ eventKey: "evt-1" });
    try {
      const outcome = await handleQqRecordedMessage(s.h.orm, {
        observation: observation({ eventKey: "evt-1" }),
        nowSeconds: NOW,
      });
      expect(outcome.dispatch).toMatchObject({ kind: "scheduled", path: "chiming_in" });
      expect(readQqDispatchCandidate(s.h.orm, '["qq","10001","group","30003"]')).not.toBeNull();
    } finally {
      s.close();
    }
  });

  it("leaves a direct mention out of the queue (it is the immediate path's)", async () => {
    const { s } = fixture({ eventKey: "evt-2", mentionsSelf: true });
    try {
      const outcome = await handleQqRecordedMessage(s.h.orm, {
        observation: observation({ eventKey: "evt-2", mentionsSelf: true }),
        nowSeconds: NOW,
      });
      expect(outcome.dispatch).toEqual({ kind: "not_scheduled", reason: "handled_directly" });
      expect(readQqDispatchCandidate(s.h.orm, '["qq","10001","group","30003"]')).toBeNull();
    } finally {
      s.close();
    }
  });

  it("uses the conversation's own merge window for readiness", async () => {
    const { s } = fixture({ eventKey: "evt-3" });
    try {
      await handleQqRecordedMessage(s.h.orm, {
        observation: observation({ eventKey: "evt-3" }),
        nowSeconds: NOW,
      });
      // The scheme's default merge window is 30s, so the candidate is not runnable yet.
      expect(
        readQqDispatchCandidate(s.h.orm, '["qq","10001","group","30003"]')?.readyAtSeconds,
      ).toBe(NOW + 30);
    } finally {
      s.close();
    }
  });
});

describe("media is recorded and never read (ADR0019 §8.11)", () => {
  it("records an addressed picture without reading it", async () => {
    const patch = {
      eventKey: "evt-4",
      mentionsSelf: true,
      segments: [{ kind: "image", file: "upstream-4" }],
    } as Parameters<typeof observation>[0];
    const { s } = fixture(patch);
    try {
      const outcome = await handleQqRecordedMessage(s.h.orm, {
        observation: observation(patch),
        nowSeconds: NOW,
      });
      expect(outcome.dispatch).toEqual({ kind: "not_scheduled", reason: "handled_directly" });
      expect(outcome.media).toEqual({ hasMedia: true, own: null, supplement: null });
      expect(mediaNoteRow(s.h.orm, "evt-4", 0)).toMatchObject({
        segmentKind: "image",
        attempts: 0,
        note: null,
        noteModel: null,
      });
    } finally {
      s.close();
    }
  });

  it("records a non-addressed picture without reading it either", async () => {
    const patch = {
      eventKey: "evt-5",
      segments: [{ kind: "image", file: "upstream-5" }],
    } as Parameters<typeof observation>[0];
    const { s } = fixture(patch);
    try {
      const outcome = await handleQqRecordedMessage(s.h.orm, {
        observation: observation(patch),
        nowSeconds: NOW,
      });
      expect(outcome.dispatch).toMatchObject({ kind: "scheduled", path: "chiming_in" });
      expect(outcome.media).toEqual({ hasMedia: true, own: null, supplement: null });
      expect(mediaNoteRow(s.h.orm, "evt-5", 0)).toMatchObject({
        attempts: 0,
        note: null,
        addressed: 0,
      });
    } finally {
      s.close();
    }
  });

  it("reports no media on a plain text message", async () => {
    const { s } = fixture({ eventKey: "evt-6" });
    try {
      const outcome = await handleQqRecordedMessage(s.h.orm, {
        observation: observation({ eventKey: "evt-6" }),
        nowSeconds: NOW,
      });
      expect(outcome.media).toEqual({ hasMedia: false, own: null, supplement: null });
    } finally {
      s.close();
    }
  });
});

describe("a waiting read is not woken by a supplement", () => {
  it("does not retry an earlier failed read when the conversation calls again", async () => {
    const patch = {
      eventKey: "evt-7",
      mentionsSelf: true,
      segments: [{ kind: "image", file: "upstream-7" }],
    } as Parameters<typeof observation>[0];
    const { s } = fixture(patch);
    const vision = recordingVision(true);
    try {
      // Seed the exact state the old supplement retry woke: one spent attempt, no note.
      const first = await seedFailedRead(s.h.orm, "evt-7", vision);
      expect(first).toMatchObject({
        kind: "read",
        result: { kind: "failed", awaitSupplement: true },
      });
      expect(vision.calls).toHaveLength(1);
      expect(mediaNoteRow(s.h.orm, "evt-7", 0)).toMatchObject({ attempts: 1, note: null });
      // The row really is a supplement candidate: only this module's retirement stops the retry.
      expect(
        pendingMediaSupplementFor(s.h.orm, {
          accountId: ACCOUNT_ID,
          conversationKind: "group",
          peerId: PEER_ID,
          sinceSeconds: NOW - 600,
          beforeSeconds: NOW + 300,
          excludeEventKey: "evt-8",
        }),
      ).toEqual({ eventKey: "evt-7", segmentIndex: 0 });

      // Five minutes later the same speaker calls the assistant about it: classification runs,
      // nothing is read, and the waiting row is untouched.
      const supplement = observation({
        eventKey: "evt-8",
        occurredAtSeconds: NOW + 300,
        mentionsSelf: true,
      });
      recordInbound(
        s.h.orm,
        { kind: "message", observation: supplement },
        { accountId: ACCOUNT_ID },
      );
      const outcome = await handleQqRecordedMessage(s.h.orm, {
        observation: supplement,
        nowSeconds: NOW + 300,
      });
      expect(outcome.dispatch).toEqual({ kind: "not_scheduled", reason: "handled_directly" });
      expect(outcome.media).toEqual({ hasMedia: false, own: null, supplement: null });
      expect(vision.calls).toHaveLength(1);
      expect(mediaNoteRow(s.h.orm, "evt-7", 0)).toMatchObject({ attempts: 1, note: null });
    } finally {
      s.close();
    }
  });
});

describe("the transport runtime drives the event path", () => {
  class FakeSocket extends EventTarget implements OneBotSocket {
    readyState = 0;
    sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
    onSend?: (request: { action: string; params: Record<string, unknown>; echo: string }) => void;
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    deliver(value: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
    }
    terminate() {
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
  }

  function wireMessage(patch: Record<string, unknown> = {}) {
    return {
      time: NOW,
      self_id: Number(ACCOUNT_ID),
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: -21,
      user_id: Number(SPEAKER_ID),
      group_id: Number(PEER_ID),
      message: [{ type: "text", data: { text: "群友说喜欢猫" } }],
      ...patch,
    };
  }

  /**
   * Install the responder BEFORE opening, exactly as the bot side would answer: the open event
   * starts verification synchronously, and an unanswered request fails the handshake by timeout.
   */
  function completeHandshake(socket: FakeSocket) {
    socket.onSend = (request) => {
      if (request.action === "get_login_info")
        socket.deliver({
          status: "ok",
          retcode: 0,
          data: { user_id: Number(ACCOUNT_ID) },
          echo: request.echo,
        });
      if (request.action === "get_status")
        socket.deliver({
          status: "ok",
          retcode: 0,
          data: { online: true, good: true },
          echo: request.echo,
        });
    };
    socket.open();
  }

  function rememberTransport(s: Setup) {
    updateQqTransportConfig(s.h.orm, {
      endpoint: "ws://127.0.0.1:3000/",
      token: TOKEN,
      expectedRevision: readQqSettings(s.h.orm).revision,
      keyPath: s.keyPath,
    });
  }

  async function waitForFollowUps(events: QqIntakeEvent[], count: number) {
    for (
      let i = 0;
      i < 80 && events.filter((event) => event.kind === "follow_up").length < count;
      i += 1
    ) {
      await Bun.sleep(5);
    }
  }

  it("queues what a real wire event produces, and leaves the pipeline silent when it cannot", async () => {
    const s = setup();
    let runtime: QqIntakeRuntime | undefined;
    try {
      rememberTransport(s);
      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      runtime = new QqIntakeRuntime({
        orm: s.h.orm,
        transportKeyPath: s.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        cycleIntervalMs: 60_000,
        nowSeconds: () => NOW,
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
      expect(await started).toEqual({ phase: "ready", accountId: ACCOUNT_ID });

      socket.deliver(wireMessage());
      await waitForFollowUps(events, 1);
      expect(events).toContainEqual({
        kind: "follow_up",
        hasMedia: false,
        dispatch: "scheduled",
        own: "none",
        supplement: "none",
      });
      expect(readQqDispatchCandidate(s.h.orm, '["qq","10001","group","30003"]')).not.toBeNull();
    } finally {
      runtime?.stop();
      s.close();
    }
  }, 15_000);

  it("records an image message without asking the bot side for its source", async () => {
    const s = setup();
    let runtime: QqIntakeRuntime | undefined;
    try {
      rememberTransport(s);
      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      runtime = new QqIntakeRuntime({
        orm: s.h.orm,
        transportKeyPath: s.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        cycleIntervalMs: 60_000,
        nowSeconds: () => NOW,
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
      await waitForFollowUps(events, 1);
      expect(events).toContainEqual({
        kind: "follow_up",
        hasMedia: true,
        dispatch: "scheduled",
        own: "none",
        supplement: "none",
      });
      // The zero-vision proof at this level: no source action ever left the socket, and the
      // recorded segment has spent none of its read attempts.
      expect(socket.sent.filter((request) => MEDIA_ACTIONS.includes(request.action))).toEqual([]);
      const eventKey = s.h.orm.select().from(schema.qqEvents).all().at(-1)?.eventKey;
      if (eventKey === undefined) throw new Error("expected a recorded event");
      expect(mediaNoteRow(s.h.orm, eventKey, 0)).toMatchObject({
        segmentKind: "image",
        attempts: 0,
        note: null,
        addressed: 0,
      });
    } finally {
      runtime?.stop();
      s.close();
    }
  }, 15_000);

  it("lets the canonical ingress schedule the wake for an addressed image, with nothing read", async () => {
    const s = setup();
    let runtime: QqIntakeRuntime | undefined;
    try {
      rememberTransport(s);
      // The canonical wake path runs on the scheme's triggers; the retired classifier did not.
      s.h.db.exec("UPDATE qq_schemes SET trigger_direct_reply=1,trigger_chiming_in=1");
      const journal = new ConversationEventRepository(s.h.db);
      const wakes = new WakeRepository(s.h.db);
      const adapter = new OneBot11Adapter({
        orm: s.h.orm,
        journal,
        wakes,
        nowSeconds: () => NOW,
      });
      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      runtime = new QqIntakeRuntime({
        orm: s.h.orm,
        transportKeyPath: s.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        cycleIntervalMs: 60_000,
        nowSeconds: () => NOW,
        conversationIngress: adapter,
        onEvent: (event) => events.push(event),
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

      // The `at` segment comes first, so the image sits at its own original index.
      socket.deliver(
        wireMessage({
          message_id: -22,
          message: [
            { type: "at", data: { qq: ACCOUNT_ID } },
            { type: "image", data: { file: "upstream-e2e" } },
          ],
        }),
      );
      await waitForFollowUps(events, 1);
      // Qualified wake: the canonical ingress created it for the addressed message.
      expect(
        wakes.peek({ at: new Date(NOW * 1000).toISOString(), cause: "direct_reply" }),
      ).not.toBeNull();
      // The legacy queue stays empty under the canonical ingress, the media fact is recorded at
      // its original segment index, and no source action ever left the socket.
      expect(s.h.orm.select().from(schema.qqDispatchCandidates).all()).toHaveLength(0);
      const eventKey = s.h.orm.select().from(schema.qqEvents).all().at(-1)?.eventKey;
      if (eventKey === undefined) throw new Error("expected a recorded event");
      expect(mediaNoteRow(s.h.orm, eventKey, 1)).toMatchObject({
        segmentIndex: 1,
        segmentKind: "image",
        attempts: 0,
        note: null,
        addressed: 1,
      });
      expect(socket.sent.filter((request) => MEDIA_ACTIONS.includes(request.action))).toEqual([]);
      expect(events).toContainEqual({
        kind: "follow_up",
        hasMedia: true,
        dispatch: "not_scheduled",
        own: "none",
        supplement: "none",
      });
    } finally {
      runtime?.stop();
      s.close();
    }
  }, 15_000);

  it("wakes for an addressed message without retrying a waiting read", async () => {
    const s = setup();
    let runtime: QqIntakeRuntime | undefined;
    try {
      rememberTransport(s);
      s.h.db.exec("UPDATE qq_schemes SET trigger_direct_reply=1");
      const journal = new ConversationEventRepository(s.h.db);
      const wakes = new WakeRepository(s.h.db);
      const adapter = new OneBot11Adapter({
        orm: s.h.orm,
        journal,
        wakes,
        nowSeconds: () => NOW,
      });
      // Seed a failed read directly through the retired cycle: one spent attempt, no note.
      const seeded = observation({
        eventKey: "evt-seed",
        segments: [{ kind: "image", file: "upstream-seed" }],
      });
      recordInbound(s.h.orm, { kind: "message", observation: seeded }, { accountId: ACCOUNT_ID });
      const vision = recordingVision(true);
      expect(await seedFailedRead(s.h.orm, "evt-seed", vision)).toMatchObject({
        kind: "read",
        result: { kind: "failed" },
      });
      expect(mediaNoteRow(s.h.orm, "evt-seed", 0)).toMatchObject({ attempts: 1, note: null });

      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      runtime = new QqIntakeRuntime({
        orm: s.h.orm,
        transportKeyPath: s.keyPath,
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
        cycleIntervalMs: 60_000,
        nowSeconds: () => NOW,
        conversationIngress: adapter,
        onEvent: (event) => events.push(event),
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

      socket.deliver(
        wireMessage({
          message_id: -31,
          message: [
            { type: "at", data: { qq: ACCOUNT_ID } },
            { type: "text", data: { text: "刚发的图你看到了吗" } },
          ],
        }),
      );
      await waitForFollowUps(events, 1);
      expect(
        wakes.peek({ at: new Date(NOW * 1000).toISOString(), cause: "direct_reply" }),
      ).not.toBeNull();
      expect(events).toContainEqual({
        kind: "follow_up",
        hasMedia: false,
        dispatch: "not_scheduled",
        own: "none",
        supplement: "none",
      });
      // Nothing woke the waiting read: no second model call, no attempt, no source request.
      expect(vision.calls).toHaveLength(1);
      expect(mediaNoteRow(s.h.orm, "evt-seed", 0)).toMatchObject({ attempts: 1, note: null });
      expect(socket.sent.filter((request) => MEDIA_ACTIONS.includes(request.action))).toEqual([]);
    } finally {
      runtime?.stop();
      s.close();
    }
  }, 15_000);
});
