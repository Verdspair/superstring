import { afterEach, describe, expect, it } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { cloneBusinessDb } from "../harness/business-db";

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function setup(enabled: boolean, direct = false) {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const clock = { seconds: Math.floor(Date.now() / 1000) - 10 };
  const scheme = createQqScheme(h.orm, {
    name: `antispam-${crypto.randomUUID()}`,
    triggers: { direct_reply: direct, follow_up: false, chiming_in: true, idle_topic: false },
    inputAntiSpam: { enabled },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      initiative_batch_target_count: 2,
      initiative_batch_jitter_count: 0,
      initiative_time_window_enabled: false,
      merge_window_seconds: 0,
    },
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
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const journal = new ConversationEventRepository(h.db);
  const wakes = new WakeRepository(h.db);
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
  });
  let messageId = 90000;
  const receive = (parts: unknown[], sender = 20002) => {
    const id = String(++messageId);
    const parsed = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: clock.seconds,
        self_id: 10001,
        user_id: sender,
        group_id: 30003,
        message_id: id,
        message: parts,
        sender: { nickname: String(sender) },
      },
      "10001",
    );
    expect(parsed.kind).toBe("message");
    const result = recordInbound(h.orm, parsed, {
      accountId: "10001",
      conversationIngress: adapter,
    });
    expect(result.kind).toBe("recorded");
    const row = h.db.query("SELECT event_key FROM qq_events WHERE message_id=?").get(id) as {
      event_key: string;
    };
    return row.event_key;
  };
  const pending = () =>
    h.db
      .query(
        "SELECT id,through_seq FROM wake_signals WHERE cause='chiming_in' AND status='pending'",
      )
      .all();
  const resetOrdinary = () => h.db.exec("DELETE FROM wake_signals WHERE cause='chiming_in'");
  const image = () => [{ type: "image", data: { file: `synthetic-${messageId}.png` } }];
  return { ...h, clock, receive, pending, resetOrdinary, image, bindingId, journal };
}

function expire(h: ReturnType<typeof setup>, key: string) {
  h.db
    .query("UPDATE qq_observation_text SET expires_at='2000-01-01T00:00:00.000Z' WHERE event_key=?")
    .run(key);
  h.db
    .query("UPDATE qq_media_notes SET expires_at='2000-01-01T00:00:00.000Z' WHERE event_key=?")
    .run(key);
  h.db
    .query("UPDATE qq_message_facts SET expires_at='2000-01-01T00:00:00.000Z' WHERE event_key=?")
    .run(key);
}

describe("input anti-spam production opportunity projection", () => {
  it("collapses three unmarked image carriers to one opportunity when enabled; OFF counts all three and keeps raw records", () => {
    const on = setup(true);
    on.receive(on.image());
    on.clock.seconds++;
    on.receive(on.image());
    on.clock.seconds++;
    on.resetOrdinary();
    on.receive(on.image());
    expect(on.pending()).toHaveLength(0);
    expect(on.db.query("SELECT COUNT(*) AS n FROM qq_events").get()).toEqual({ n: 3 });
    const off = setup(false);
    off.receive(off.image());
    off.clock.seconds++;
    off.receive(off.image());
    off.clock.seconds++;
    off.resetOrdinary();
    off.receive(off.image());
    expect(off.pending()).toHaveLength(1);
    expect(off.db.query("SELECT COUNT(*) AS n FROM qq_events").get()).toEqual({ n: 3 });
  });

  it("keeps a processed direct message in the same sender's sequence as a burst breaker", () => {
    const h = setup(true, true);
    h.receive(h.image());
    h.clock.seconds++;
    h.receive([
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: "direct" } },
    ]);
    const direct = h.db.query("SELECT id FROM wake_signals WHERE cause='direct_reply'").get() as {
      id: string;
    };
    h.db.query("UPDATE wake_signals SET status='no_output' WHERE id=?").run(direct.id);
    h.receive(h.image());
    h.clock.seconds++;
    h.resetOrdinary();
    h.receive(h.image());
    expect(h.pending()).toHaveLength(1);
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_events").get()).toEqual({ n: 4 });
  });

  it("a sender's expired event breaks its image group, while another sender's expired event does not", () => {
    for (const sameSender of [true, false]) {
      const h = setup(true);
      h.receive(h.image());
      h.clock.seconds++;
      const key = h.receive(
        [{ type: "text", data: { text: "expired boundary" } }],
        sameSender ? 20002 : 20003,
      );
      expire(h, key);
      h.receive(h.image());
      h.clock.seconds++;
      h.resetOrdinary();
      h.receive(h.image());
      expect(h.pending()).toHaveLength(sameSender ? 1 : 0);
      expect(h.db.query("SELECT COUNT(*) AS n FROM qq_events").get()).toEqual({ n: 4 });
    }
  });

  it("pure platform expressions do not count as ordinary input but an explicit mention is not swallowed", () => {
    const h = setup(true, true);
    h.receive([{ type: "text", data: { text: "normal" } }]);
    h.receive([{ type: "face", data: { id: "14" } }]);
    expect(h.pending()).toHaveLength(0);
    h.receive([
      {
        type: "image",
        data: { file: "market.png", emoji_id: "1", emoji_package_id: 1, summary: "expression" },
      },
    ]);
    expect(h.pending()).toHaveLength(0);
    const factKey = h.receive([
      { type: "at", data: { qq: "10001" } },
      { type: "face", data: { id: "14" } },
    ]);
    expect(
      h.db
        .query("SELECT COUNT(*) AS n FROM qq_conversation_tasks WHERE task_class='mention'")
        .get(),
    ).toEqual({ n: 1 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_events").get()).toEqual({ n: 4 });
    // The mention task's source validity comes from the typed fact row of this very event:
    // the stored task deadline equals the fact expiry, so a later guard re-check keeps the
    // pure-face source readable until the same TTL, without any text or media row.
    const factExpires = h.db
      .query("SELECT expires_at FROM qq_message_facts WHERE event_key=?")
      .get(factKey) as { expires_at: string };
    expect(factExpires.expires_at).toBeTruthy();
    const task = h.db
      .query("SELECT source_expires_at FROM qq_conversation_tasks WHERE task_class='mention'")
      .get() as { source_expires_at: string | null };
    expect(task.source_expires_at).toBe(factExpires.expires_at);
  });
});
