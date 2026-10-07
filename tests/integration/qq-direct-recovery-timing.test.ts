import { afterEach, describe, expect, it } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
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

/** 恢复时机（direct 无 merge）：恢复扫描只读已落 journal 的事件，不重新走 ingress。 */
function setup(follow = false) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: `recovery-timing-${follow}`,
    triggers: { direct_reply: true, follow_up: follow, chiming_in: !follow, idle_topic: false },
    rhythm: { ...QQ_RHYTHM_DEFAULT, merge_window_seconds: 60, judgement_interval_turns: 1 },
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
  const journal = new ConversationEventRepository(h.db);
  const wakes = new WakeRepository(h.db);
  const clock = { seconds: time };
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
  });
  const now = () => new Date(clock.seconds * 1000).toISOString();
  const rows = () =>
    h.db.query("SELECT * FROM wake_signals ORDER BY created_at,id").all() as {
      id: string;
      cause: string;
      status: string;
      through_seq: number;
      ready_at: string;
      dedupe_key: string;
    }[];
  return { ...h, bindingId, clock, journal, wakes, adapter, now, rows };
}

describe("direct recovery timing (merge belongs to continuous only)", () => {
  it("a recovered addressed direct source is immediately claimable without merge window", () => {
    const h = setup();
    // 事件在 now-60 已落 journal（同秒记录，恢复扫描按 occurred_at 排序取每人最新）。
    const arrived = time - 60;
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: arrived,
          self_id: 10001,
          user_id: 20002,
          group_id: 30003,
          message_id: "1",
          message: [
            { type: "at", data: { qq: "10001" } },
            { type: "text", data: { text: "synthetic" } },
          ],
          sender: { nickname: "synthetic" },
        },
        "10001",
      ),
      { accountId: "10001" },
    );
    h.clock.seconds = time;
    h.adapter.sweep();
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    expect(claimed.cause).toBe("direct_reply");
    expect(claimed.readyAt).toBe(new Date(arrived * 1000).toISOString());
  });
  it("a recovered continuous source matures at arrival+merge and is not claimable early", () => {
    const h = setup(true);
    const arrived = time - 30;
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: arrived,
          self_id: 10001,
          user_id: 20002,
          group_id: 30003,
          message_id: "1",
          message: [{ type: "text", data: { text: "synthetic" } }],
          sender: { nickname: "synthetic" },
        },
        "10001",
      ),
      { accountId: "10001" },
    );
    h.clock.seconds = time;
    h.adapter.sweep();
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })).toBeNull();
    expect(h.wakes.nextReadyAt()).toBe(new Date((arrived + 60) * 1000).toISOString());
  });
  it("direct off: an addressed source does not become a direct wake", () => {
    const h = setup();
    h.db.exec(`UPDATE qq_bindings SET trigger_direct_reply=0 WHERE id='${h.bindingId}'`);
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: time - 10,
          self_id: 10001,
          user_id: 20002,
          group_id: 30003,
          message_id: "1",
          message: [
            { type: "at", data: { qq: "10001" } },
            { type: "text", data: { text: "synthetic" } },
          ],
          sender: { nickname: "synthetic" },
        },
        "10001",
      ),
      { accountId: "10001" },
    );
    h.clock.seconds = time;
    h.adapter.sweep();
    expect(h.rows().filter((r) => r.cause === "direct_reply")).toEqual([]);
  });
});
