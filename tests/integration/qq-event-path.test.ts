// The inbound event path (ADR0018 P5m): classify, queue, and understand the media.
//
// The three user decisions of 2026-09-24 are what these cases pin, because each one is a rule that
// would otherwise be invisible in the code:
//   * "related supplement" = the SAME SPEAKER inside the scheme's window (no text matching);
//   * the window is a scheme parameter, 10 minutes by default, and 0 turns the wait off;
//   * non-addressed media is read ONCE too — but §7.2 still forbids retrying it.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readQqDispatchCandidate } from "../../src/server/db/qq-dispatch-repository";
import { mediaNoteRow } from "../../src/server/db/qq-media-repository";
import {
  readQqSettings,
  updateQqSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import type { VisionClient } from "../../src/server/llm/vision-client";
import type { OneBotSocket } from "../../src/server/services/onebot-connection";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import { handleQqRecordedMessage } from "../../src/server/services/qq-event-path";
import {
  type QqIntakeEvent,
  QqIntakeRuntime,
  recordInbound,
} from "../../src/server/services/qq-intake";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "10001";
const PEER_ID = "30003";
const SPEAKER_ID = "20002";
const NOW = 2_000_000_000;
const TOKEN = "synthetic-token";

const PNG = new Uint8Array(encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8));
const DATA_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

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
  // §7.1's picture purpose, on the shared settings row. Unset means "cannot understand", so every
  // media case here would otherwise stop at `model_not_configured` before reaching the model.
  business.orm
    .update(schema.organizationSettings)
    .set({ visionModelName: "vision-local" })
    .where(eq(schema.organizationSettings.id, 1))
    .run();
  // The scheme must exist before the binding: a table trigger refuses a binding that names a
  // scheme which is not there, and that refusal is one of the guarantees these tests rely on.
  // Inserted directly under the fixed id rather than created by the contract, because the id is
  // what the binding names and the name is what the unique index would collide on.
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

/** A vision client that answers with a fixed note and counts its calls. */
function fakeVision(notes: string[] = ["图里是一只猫"]): VisionClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async annotate(request) {
      calls.push(request.model);
      return notes[calls.length - 1] ?? notes[notes.length - 1] ?? "图里有一只猫";
    },
  };
}

function fixture(patch: Parameters<typeof observation>[0], notes?: string[]) {
  const s = setup();
  const vision = fakeVision(notes);
  const deps = {
    media: {
      // A stub adapter: these cases are about WHEN a read happens, so the bytes never travel.
      // The end-to-end case below runs the real adapter instead.
      adapterFor: ({ mediaPrompt }: { mediaPrompt: string }) => {
        return {
          async read({
            kind,
            sourceRef,
            model,
          }: {
            kind: string;
            sourceRef: string;
            model: string;
          }) {
            void kind;
            void sourceRef;
            return vision.annotate({ model, prompt: mediaPrompt, images: [] });
          },
        };
      },
    },
  };
  const recorded = recordInbound(
    s.h.orm,
    { kind: "message", observation: observation(patch) },
    {
      accountId: ACCOUNT_ID,
    },
  );
  if (recorded.kind !== "recorded") throw new Error("expected a recorded message");
  return { s, vision, deps };
}

describe("classification and queueing", () => {
  it("turns a group message that is not addressed into an initiative candidate", async () => {
    const { s, deps } = fixture({ eventKey: "evt-1" });
    try {
      const outcome = await handleQqRecordedMessage(
        s.h.orm,
        { observation: observation({ eventKey: "evt-1" }), nowSeconds: NOW },
        deps,
      );
      expect(outcome.dispatch).toMatchObject({ kind: "scheduled", path: "chiming_in" });
      expect(readQqDispatchCandidate(s.h.orm, '["qq","10001","group","30003"]')).not.toBeNull();
    } finally {
      s.close();
    }
  });

  it("leaves a direct mention out of the queue (it is the immediate path's)", async () => {
    const { s, deps } = fixture({ eventKey: "evt-2", mentionsSelf: true });
    try {
      const outcome = await handleQqRecordedMessage(
        s.h.orm,
        { observation: observation({ eventKey: "evt-2", mentionsSelf: true }), nowSeconds: NOW },
        deps,
      );
      expect(outcome.dispatch).toEqual({ kind: "not_scheduled", reason: "handled_directly" });
      expect(readQqDispatchCandidate(s.h.orm, '["qq","10001","group","30003"]')).toBeNull();
    } finally {
      s.close();
    }
  });

  it("uses the conversation's own merge window for readiness", async () => {
    const { s, deps } = fixture({ eventKey: "evt-3" });
    try {
      await handleQqRecordedMessage(
        s.h.orm,
        { observation: observation({ eventKey: "evt-3" }), nowSeconds: NOW },
        deps,
      );
      // The scheme's default merge window is 30s, so the candidate is not runnable yet.
      expect(
        readQqDispatchCandidate(s.h.orm, '["qq","10001","group","30003"]')?.readyAtSeconds,
      ).toBe(NOW + 30);
    } finally {
      s.close();
    }
  });
});

describe("understanding the media of the message itself", () => {
  it("reads an addressed picture once and stores the note", async () => {
    const patch = {
      eventKey: "evt-4",
      mentionsSelf: true,
      segments: [{ kind: "image", file: "upstream-4" }],
    } as Parameters<typeof observation>[0];
    const { s, vision, deps } = fixture(patch, ["（被@的图）一只猫"]);
    try {
      const outcome = await handleQqRecordedMessage(
        s.h.orm,
        { observation: observation(patch), nowSeconds: NOW },
        deps,
      );
      expect(outcome.media).toMatchObject({ hasMedia: true, own: { kind: "read" } });
      expect(vision.calls).toHaveLength(1);
      expect(mediaNoteRow(s.h.orm, "evt-4", 0)?.note).toBe("（被@的图）一只猫");
    } finally {
      s.close();
    }
  });

  it("reads a non-addressed picture once too (user decision 2026-09-24)", async () => {
    const patch = {
      eventKey: "evt-5",
      segments: [{ kind: "image", file: "upstream-5" }],
    } as Parameters<typeof observation>[0];
    const { s, vision, deps } = fixture(patch);
    try {
      const outcome = await handleQqRecordedMessage(
        s.h.orm,
        { observation: observation(patch), nowSeconds: NOW },
        deps,
      );
      expect(outcome.media.own?.kind).toBe("read");
      expect(vision.calls).toHaveLength(1);
      // …but the stored flag keeps §7.2's asymmetry: only an addressed read is ever retried.
      expect(mediaNoteRow(s.h.orm, "evt-5", 0)).toMatchObject({ attempts: 1, addressed: 0 });
    } finally {
      s.close();
    }
  });

  it("records media without reading it when no vision seam is wired", async () => {
    const patch = {
      eventKey: "evt-6",
      mentionsSelf: true,
      segments: [{ kind: "image", file: "upstream-6" }],
    } as Parameters<typeof observation>[0];
    const { s } = fixture(patch);
    try {
      const outcome = await handleQqRecordedMessage(s.h.orm, {
        observation: observation(patch),
        nowSeconds: NOW,
      });
      expect(outcome.media).toEqual({ hasMedia: true, own: null, supplement: null });
      expect(mediaNoteRow(s.h.orm, "evt-6", 0)).toMatchObject({ attempts: 0, note: null });
    } finally {
      s.close();
    }
  });
});

describe("waking a failed read on a same-speaker supplement", () => {
  /** The first read fails, so the segment is left waiting for one more understanding. */
  function failingThenSucceeding(notes: string[]) {
    const s = setup();
    let call = 0;
    const vision: VisionClient & { calls: number } = {
      calls: 0,
      async annotate() {
        call += 1;
        vision.calls = call;
        if (call === 1) throw new Error("synthetic model failure");
        return notes[call - 2] ?? "补读成功";
      },
    };
    return { s, vision };
  }

  it("retries the earlier failed segment when the assistant is called again inside the window", async () => {
    const patch = {
      eventKey: "evt-7",
      mentionsSelf: true,
      segments: [{ kind: "image", file: "upstream-7" }],
    } as Parameters<typeof observation>[0];
    const { s, vision } = failingThenSucceeding(["补读成功"]);
    try {
      const deps = {
        media: {
          adapterFor: ({ mediaPrompt }: { mediaPrompt: string }) => ({
            read: ({ model }: { model: string }) =>
              vision.annotate({ model, prompt: mediaPrompt, images: [] }),
          }),
        },
      };
      recordInbound(
        s.h.orm,
        { kind: "message", observation: observation(patch) },
        { accountId: ACCOUNT_ID },
      );
      const first = await handleQqRecordedMessage(
        s.h.orm,
        { observation: observation(patch), nowSeconds: NOW },
        deps,
      );
      expect(first.media.own).toMatchObject({ kind: "read" });
      expect(mediaNoteRow(s.h.orm, "evt-7", 0)).toMatchObject({ attempts: 1, note: null });

      // Five minutes later, the same speaker adds a plain text message: that is the supplement.
      // 2026-09-25 后续：唤醒不再要求同一个说话人——是"被叫到"这一次决定要不要重试。
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
      const second = await handleQqRecordedMessage(
        s.h.orm,
        { observation: supplement, nowSeconds: NOW + 300 },
        deps,
      );
      expect(second.media.supplement).toMatchObject({ kind: "read", segmentIndex: 0 });
      expect(mediaNoteRow(s.h.orm, "evt-7", 0)).toMatchObject({
        attempts: 2,
        note: "补读成功",
      });
      expect(vision.calls).toBe(2);
    } finally {
      s.close();
    }
  });

  it("does not wake anything once the window has passed", async () => {
    const patch = {
      eventKey: "evt-9",
      mentionsSelf: true,
      segments: [{ kind: "image", file: "upstream-9" }],
    } as Parameters<typeof observation>[0];
    const { s, vision } = failingThenSucceeding(["补读成功"]);
    try {
      const deps = {
        media: {
          adapterFor: ({ mediaPrompt }: { mediaPrompt: string }) => ({
            read: ({ model }: { model: string }) =>
              vision.annotate({ model, prompt: mediaPrompt, images: [] }),
          }),
        },
      };
      recordInbound(
        s.h.orm,
        { kind: "message", observation: observation(patch) },
        { accountId: ACCOUNT_ID },
      );
      await handleQqRecordedMessage(
        s.h.orm,
        { observation: observation(patch), nowSeconds: NOW },
        deps,
      );
      // Eleven minutes later: outside the default ten-minute window.
      const late = observation({ eventKey: "evt-10", occurredAtSeconds: NOW + 660 });
      recordInbound(s.h.orm, { kind: "message", observation: late }, { accountId: ACCOUNT_ID });
      const outcome = await handleQqRecordedMessage(
        s.h.orm,
        { observation: late, nowSeconds: NOW + 660 },
        deps,
      );
      expect(outcome.media.supplement).toBeNull();
      expect(mediaNoteRow(s.h.orm, "evt-9", 0)).toMatchObject({ attempts: 1, note: null });
    } finally {
      s.close();
    }
  });

  it("wakes a failed read when the assistant is called, and not on unrelated chatter", async () => {
    const patch = {
      eventKey: "evt-11",
      segments: [{ kind: "image", file: "upstream-11" }],
    } as Parameters<typeof observation>[0];
    const { s, vision } = failingThenSucceeding(["补读成功"]);
    try {
      const deps = {
        media: {
          adapterFor: ({ mediaPrompt }: { mediaPrompt: string }) => ({
            read: ({ model }: { model: string }) =>
              vision.annotate({ model, prompt: mediaPrompt, images: [] }),
          }),
        },
      };
      // The first read fails, and the message was NOT addressed (a plain group picture). That is
      // the case the user reported: somebody later replies to the assistant about exactly this.
      recordInbound(
        s.h.orm,
        { kind: "message", observation: observation(patch) },
        { accountId: ACCOUNT_ID },
      );
      const first = await handleQqRecordedMessage(
        s.h.orm,
        { observation: observation(patch), nowSeconds: NOW },
        deps,
      );
      expect(first.media.own).toMatchObject({ kind: "read", result: { kind: "failed" } });
      expect(mediaNoteRow(s.h.orm, "evt-11", 0)).toMatchObject({ attempts: 1, note: null });

      // Unrelated chatter inside the window must NOT spend another attempt.
      const chatter = observation({ eventKey: "evt-12", occurredAtSeconds: NOW + 120 });
      recordInbound(s.h.orm, { kind: "message", observation: chatter }, { accountId: ACCOUNT_ID });
      const second = await handleQqRecordedMessage(
        s.h.orm,
        { observation: chatter, nowSeconds: NOW + 120 },
        deps,
      );
      // The candidate is found, and the reader refuses it politely — without spending an attempt.
      expect(second.media.supplement).toMatchObject({
        kind: "read",
        result: { kind: "unreadable", reason: "not_addressed" },
      });
      expect(mediaNoteRow(s.h.orm, "evt-11", 0)).toMatchObject({ attempts: 1, note: null });

      // A call inside the window wakes it, once.
      const called = observation({
        eventKey: "evt-13",
        occurredAtSeconds: NOW + 240,
        mentionsSelf: true,
      });
      recordInbound(s.h.orm, { kind: "message", observation: called }, { accountId: ACCOUNT_ID });
      const third = await handleQqRecordedMessage(
        s.h.orm,
        { observation: called, nowSeconds: NOW + 240 },
        deps,
      );
      expect(third.media.supplement).toMatchObject({ kind: "read", result: { kind: "described" } });
      expect(mediaNoteRow(s.h.orm, "evt-11", 0)).toMatchObject({ attempts: 2, note: "补读成功" });
    } finally {
      s.close();
    }
  });

  it("waits for nobody when the scheme's window is 0", async () => {
    const patch = {
      eventKey: "evt-13",
      mentionsSelf: true,
      segments: [{ kind: "image", file: "upstream-13" }],
    } as Parameters<typeof observation>[0];
    const { s, vision } = failingThenSucceeding(["补读成功"]);
    try {
      s.h.orm.update(schema.qqSchemes).set({ mediaSupplementWindowMinutes: 0 }).run();
      const deps = {
        media: {
          adapterFor: ({ mediaPrompt }: { mediaPrompt: string }) => ({
            read: ({ model }: { model: string }) =>
              vision.annotate({ model, prompt: mediaPrompt, images: [] }),
          }),
        },
      };
      recordInbound(
        s.h.orm,
        { kind: "message", observation: observation(patch) },
        { accountId: ACCOUNT_ID },
      );
      await handleQqRecordedMessage(
        s.h.orm,
        { observation: observation(patch), nowSeconds: NOW },
        deps,
      );
      const supplement = observation({ eventKey: "evt-14", occurredAtSeconds: NOW + 60 });
      recordInbound(
        s.h.orm,
        { kind: "message", observation: supplement },
        { accountId: ACCOUNT_ID },
      );
      const outcome = await handleQqRecordedMessage(
        s.h.orm,
        { observation: supplement, nowSeconds: NOW + 60 },
        deps,
      );
      expect(outcome.media.supplement).toBeNull();
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

  it("queues what a real wire event produces, and leaves the pipeline silent when it cannot", async () => {
    const s = setup();
    try {
      updateQqTransportConfig(s.h.orm, {
        endpoint: "ws://127.0.0.1:3000/",
        token: TOKEN,
        expectedRevision: readQqSettings(s.h.orm).revision,
        keyPath: s.keyPath,
      });
      const sockets: FakeSocket[] = [];
      const events: QqIntakeEvent[] = [];
      const runtime = new QqIntakeRuntime({
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
      // The follow-up is asynchronous on purpose: give it a turn to finish.
      await Bun.sleep(10);
      expect(events).toContainEqual({
        kind: "follow_up",
        hasMedia: false,
        dispatch: "scheduled",
        own: "none",
        supplement: "none",
      });
      expect(readQqDispatchCandidate(s.h.orm, '["qq","10001","group","30003"]')).not.toBeNull();
      runtime.stop();
    } finally {
      s.close();
    }
  }, 15_000);

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "reads media with canonical ingress=%s, supplement retry=%s and one queue owner",
    async (canonical, retry) => {
      const s = setup();
      try {
        updateQqTransportConfig(s.h.orm, {
          endpoint: "ws://127.0.0.1:3000/",
          token: TOKEN,
          expectedRevision: readQqSettings(s.h.orm).revision,
          keyPath: s.keyPath,
        });
        // The whole chain runs for real except the two ends: NapCat is a fake socket that answers
        // `get_image` with a data URL, and the model is a fake vision client.
        s.h.db.exec("UPDATE qq_schemes SET trigger_direct_reply=1,trigger_chiming_in=1");
        const vision = fakeVision(retry ? ["", "端到端：图里是一只猫"] : ["端到端：图里是一只猫"]);
        const journal = new ConversationEventRepository(s.h.db);
        const wakes = new WakeRepository(s.h.db);
        const adapter = canonical
          ? new OneBot11Adapter({ orm: s.h.orm, journal, wakes, nowSeconds: () => NOW })
          : undefined;
        const sockets: FakeSocket[] = [];
        const events: QqIntakeEvent[] = [];
        const runtime = new QqIntakeRuntime({
          orm: s.h.orm,
          transportKeyPath: s.keyPath,
          connectTimeoutMs: 500,
          requestTimeoutMs: 200,
          cycleIntervalMs: 60_000,
          nowSeconds: () => NOW,
          media: { vision },
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
        // Now answer the source resolution the way the bot side would: a data URL of the bytes.
        const handshakeResponder = socket.onSend;
        socket.onSend = (request) => {
          if (request.action === "get_image") {
            socket.deliver({
              status: "ok",
              retcode: 0,
              data: { file: DATA_URL },
              echo: request.echo,
            });
            return;
          }
          handshakeResponder?.(request);
        };
        // A non-addressed group message exercises the old chiming-in enqueue as well.
        socket.deliver(wireMessage({ message_id: -21 }));
        socket.deliver(
          wireMessage({
            message_id: -22,
            message: [
              { type: "at", data: { qq: ACCOUNT_ID } },
              { type: "image", data: { file: "upstream-e2e" } },
            ],
          }),
        );
        const eventKey = s.h.orm.select().from(schema.qqEvents).all().at(-1)?.eventKey;
        if (eventKey === undefined) throw new Error("expected a recorded event");
        // The image sits at its own ORIGINAL position in the message: the `at` segment comes first,
        // which is exactly why the reader is given a segment index rather than "the media".
        const readRow = () =>
          s.h.orm
            .select()
            .from(schema.qqMediaNotes)
            .where(eq(schema.qqMediaNotes.eventKey, eventKey))
            .all()
            .find((row) => row.note !== null);
        if (retry) {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            if (events.filter((event) => event.kind === "follow_up").length === 2) break;
            await Bun.sleep(25);
          }
          socket.deliver(
            wireMessage({
              message_id: -23,
              time: NOW + 1,
              message: [
                { type: "at", data: { qq: ACCOUNT_ID } },
                { type: "text", data: { text: "再看看上面的图片" } },
              ],
            }),
          );
        }
        for (let attempt = 0; attempt < 60; attempt += 1) {
          if (readRow()) break;
          await Bun.sleep(25);
        }
        expect(readRow()).toMatchObject({
          segmentIndex: 1,
          segmentKind: "image",
          note: "端到端：图里是一只猫",
          noteModel: "vision-local",
          addressed: 1,
        });
        // The bytes really travelled through the injected transport: the bot side was asked for the
        // source, and the answer (a data URL) is what the vision client received.
        expect(socket.sent.some((request) => request.action === "get_image")).toBe(true);
        expect(vision.calls).toEqual(retry ? ["vision-local", "vision-local"] : ["vision-local"]);
        expect(s.h.orm.select().from(schema.qqDispatchCandidates).all()).toHaveLength(
          canonical ? 0 : 1,
        );
        if (canonical) {
          expect(
            wakes.peek({ at: new Date(NOW * 1000).toISOString(), cause: "direct_reply" }),
          ).not.toBeNull();
          const conversation = journal.ensureOneBot(BINDING_ID)!;
          const events = journal.eventsAfter(conversation.id, 0, 100);
          const revision = events.items.find((event) => event.kind === "media_revision");
          expect(revision).toBeDefined();
          expect(
            s.h.db
              .query("SELECT event_key FROM qq_media_notes WHERE id=?")
              .get(revision!.source.id),
          ).toEqual({ event_key: eventKey });
        }
        runtime.stop();
      } finally {
        s.close();
      }
    },
    15_000,
  );
});
