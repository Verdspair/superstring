import { afterEach, describe, expect, it } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { BotWorker } from "../../src/server/conversation/bot-worker";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const time = 2_000_000_000;
function setup(follow = false) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "opportunities",
    triggers: { direct_reply: true, follow_up: follow, chiming_in: true, idle_topic: false },
    rhythm: { ...QQ_RHYTHM_DEFAULT, merge_window_seconds: 15, judgement_interval_turns: 1 },
  });
  const bindingId = crypto.randomUUID();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(
      bindingId,
      DEFAULT_AGENT_ID,
      scheme.id,
      new Date(time * 1000).toISOString(),
      new Date(time * 1000).toISOString(),
    );
  const clock = { seconds: time },
    journal = new ConversationEventRepository(h.db),
    wakes = new WakeRepository(h.db);
  let notifications = 0;
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
    wake: () => {
      notifications++;
    },
  });
  const now = () => new Date(clock.seconds * 1000).toISOString();
  const receive = (id: string, speaker = 20002, ingress = true) =>
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: clock.seconds,
          self_id: 10001,
          user_id: speaker,
          group_id: 30003,
          message_id: id,
          message: [{ type: "text", data: { text: "synthetic" } }],
          sender: { nickname: "synthetic" },
        },
        "10001",
      ),
      { accountId: "10001", ...(ingress ? { conversationIngress: adapter } : {}) },
    );
  const rows = () =>
    h.db.query("SELECT * FROM wake_signals ORDER BY created_at,id").all() as {
      id: string;
      cause: string;
      status: string;
      through_seq: number;
      ready_at: string;
      dedupe_key: string;
    }[];
  return {
    ...h,
    bindingId,
    clock,
    journal,
    wakes,
    adapter,
    receive,
    now,
    rows,
    get notifications() {
      return notifications;
    },
  };
}

describe("source-backed participant opportunities", () => {
  it("restoration is idempotent and never extends the deadline or re-notifies unchanged source", () => {
    const h = setup();
    h.receive("1");
    const original = h.rows();
    for (const offset of [1, 8, 15, 100]) {
      h.clock.seconds = time + offset;
      h.adapter.sweep();
    }
    expect(h.rows()).toEqual(original);
    expect(h.notifications).toBe(1);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })?.id).toBe(original[0]!.id);
  });
  it("terminal failure of a merged source is not resurrected by scanning its later event key", () => {
    const h = setup();
    h.receive("1");
    h.clock.seconds++;
    h.receive("2");
    h.clock.seconds += 20;
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    h.wakes.fail(claimed.id, claimed.leaseToken!, {
      at: h.now(),
      errorCode: "MODEL_FAILED",
      maxAttempts: 1,
      retryDelayMs: 15000,
    });
    const before = h.rows(),
      notifications = h.notifications;
    for (let i = 0; i < 5; i++) {
      h.clock.seconds += 30;
      h.adapter.sweep();
    }
    expect(h.rows()).toEqual(before);
    expect(h.notifications).toBe(notifications);
    h.receive("3");
    expect(h.rows().filter((r) => r.status === "pending")).toHaveLength(1);
  });
  it("a terminal source is not reclassified into a fresh initiative after later assistant speech", () => {
    const h = setup(true);
    const scope = {
      kind: "qq" as const,
      accountId: "10001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
    };
    recordQqSpeech(h.orm, { scope, kind: "direct_reply", spokeAtSeconds: time - 1, text: "old" });
    h.receive("1");
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    expect(claimed.cause).toBe("follow_up");
    h.wakes.fail(claimed.id, claimed.leaseToken!, {
      at: h.now(),
      errorCode: "MODEL_FAILED",
      maxAttempts: 1,
      retryDelayMs: 15000,
    });
    h.clock.seconds++;
    recordQqSpeech(h.orm, {
      scope,
      kind: "direct_reply",
      spokeAtSeconds: h.clock.seconds,
      text: "someone else",
    });
    const before = h.rows();
    h.adapter.sweep();
    expect(h.rows()).toEqual(before);
    expect(h.notifications).toBe(1);
  });
  it("restoration preserves retry backoff rather than reopening the same source early", () => {
    const h = setup();
    h.receive("1");
    h.clock.seconds += 15;
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    h.wakes.fail(claimed.id, claimed.leaseToken!, {
      at: h.now(),
      errorCode: "MODEL_FAILED",
      maxAttempts: 3,
      retryDelayMs: 60000,
    });
    const original = h.rows();
    h.clock.seconds += 20;
    h.adapter.sweep();
    expect(h.rows()).toEqual(original);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })).toBeNull();
  });
  it.each([false, true])(
    "historical speech chooses enabled continuation=%s without hiding initiative",
    (follow) => {
      const h = setup(follow);
      recordQqSpeech(h.orm, {
        scope: {
          kind: "qq",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
        },
        kind: "direct_reply",
        spokeAtSeconds: time - 100,
        text: "past",
      });
      h.receive("1");
      expect(h.rows().map((r) => r.cause)).toEqual([follow ? "follow_up" : "chiming_in"]);
    },
  );
  it("another participant cannot postpone a mature participant, but the same participant can extend their own window", () => {
    const h = setup();
    h.receive("1", 20002);
    h.clock.seconds += 14;
    h.receive("2", 20003);
    expect(h.rows()).toHaveLength(2);
    expect(h.wakes.nextReadyAt()).toBe(new Date((time + 15) * 1000).toISOString());
    h.clock.seconds++;
    const a = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    expect(a.throughSeq).toBe(1);
    h.wakes.complete(
      a.id,
      a.leaseToken!,
      "no_output",
      h.journal.sourceThroughSeq(a.conversationId),
      h.now(),
    );
    expect(h.rows().filter((r) => r.status === "pending")).toHaveLength(1);
    h.clock.seconds = time + 20;
    h.receive("3", 20003);
    h.clock.seconds = time + 29;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })).toBeNull();
    h.clock.seconds = time + 35;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })?.cause).toBe("chiming_in");
  });
  it("recovery finds each participant's latest retained source, not only the newest person", () => {
    const h = setup();
    h.receive("1", 20002, false);
    h.clock.seconds += 14;
    h.receive("2", 20003, false);
    h.clock.seconds++;
    h.adapter.sweep();
    expect(h.rows()).toHaveLength(2);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })).not.toBeNull();
    const original = h.rows();
    h.adapter.sweep();
    expect(h.rows()).toEqual(original);
  });
  it("explicit coverage consumes only the captured mature source, preserving a newer update", () => {
    const h = setup();
    h.receive("1", 20002);
    h.receive("2", 20003);
    h.clock.seconds += 15;
    const one = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const mature = h.wakes.readyParticipants({
      conversationId: one.conversationId,
      cause: "chiming_in",
      at: h.now(),
    });
    expect(mature.map((p) => p.participantId).sort()).toEqual(["20002", "20003"]);
    const other = mature.find((p) => p.wake.id !== one.id)!;
    h.receive("3", Number(other.participantId));
    h.wakes.complete(
      one.id,
      one.leaseToken!,
      "no_output",
      h.journal.sourceThroughSeq(one.conversationId),
      h.now(),
      mature.map((p) => ({ id: p.wake.id, throughSeq: p.wake.throughSeq })),
    );
    expect(h.wakes.get(other.wake.id)?.status).toBe("pending");
    expect(h.wakes.get(other.wake.id)!.throughSeq).toBeGreaterThan(other.wake.throughSeq);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })).toBeNull();
  });
  it("explicit mature coverage settles a batch without claiming a later participant", () => {
    const h = setup();
    h.receive("1", 20002);
    h.receive("2", 20003);
    h.clock.seconds += 14;
    h.receive("3", 20004);
    h.clock.seconds++;
    const one = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const mature = h.wakes.readyParticipants({
      conversationId: one.conversationId,
      cause: "chiming_in",
      at: h.now(),
    });
    expect(mature).toHaveLength(2);
    h.wakes.complete(
      one.id,
      one.leaseToken!,
      "no_output",
      h.journal.sourceThroughSeq(one.conversationId),
      h.now(),
      mature.map((p) => ({ id: p.wake.id, throughSeq: p.wake.throughSeq })),
    );
    expect(h.rows().filter((r) => r.status === "pending")).toHaveLength(1);
    expect(h.rows().filter((r) => r.status === "no_output")).toHaveLength(2);
  });
  it("expired sources do not become newly restored opportunities", () => {
    const h = setup();
    h.receive("1", 20002, false);
    h.db.exec("UPDATE qq_observation_text SET expires_at='2000-01-01T00:00:00.000Z'");
    h.adapter.sweep();
    expect(h.rows()).toEqual([]);
    expect(h.notifications).toBe(0);
  });
  it("completing one opportunity never silently consumes another equally mature participant", () => {
    const h = setup();
    h.receive("1", 20002);
    h.receive("2", 20003);
    h.clock.seconds += 15;
    const one = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    h.wakes.complete(
      one.id,
      one.leaseToken!,
      "no_output",
      h.journal.sourceThroughSeq(one.conversationId),
      h.now(),
    );
    expect(h.rows().filter((r) => r.status === "pending")).toHaveLength(1);
  });
});

it("even repeated producer notifications yield to timers while the transport is offline", async () => {
  let worker: BotWorker,
    cycles = 0,
    timerRan = false;
  let stopped: Promise<void> | undefined;
  const done = new Promise<void>((resolve) =>
    setTimeout(() => {
      timerRan = true;
      void worker.stop().then(resolve);
    }, 0),
  );
  worker = new BotWorker({
    canAdvance: () => false,
    sweep() {
      worker.wake();
      if (++cycles === 100) stopped = worker.stop();
    },
    advance: async () => {},
  });
  worker.start();
  await done;
  await stopped;
  expect(timerRan).toBe(true);
  expect(cycles).toBeLessThan(100);
});
