import { afterEach, expect, it } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

it("registers distinct same-sender @ messages as independent tasks before wake coalescing", () => {
  const business = openBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "synthetic");
  updateQqSettings(business.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(business.orm, {
    name: "parallel-mentions",
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
  });
  const bindingId = crypto.randomUUID();
  business.db
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
  const journal = new ConversationEventRepository(business.db);
  const wakes = new WakeRepository(business.db);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const adapter = new OneBot11Adapter({
    orm: business.orm,
    journal,
    wakes,
    nowSeconds: () => nowSeconds,
  });
  const receiveMention = (messageId: string) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: nowSeconds,
        self_id: 10001,
        user_id: 20002,
        group_id: 30003,
        message_id: messageId,
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: `question ${messageId}` } },
        ],
        sender: { nickname: "same sender" },
      },
      "10001",
    );
    expect(normalized.kind).toBe("message");
    return recordInbound(business.orm, normalized, {
      accountId: "10001",
      conversationIngress: adapter,
    });
  };

  const first = receiveMention("91001");
  const second = receiveMention("91002");
  expect(first.kind).toBe("recorded");
  expect(second.kind).toBe("recorded");
  expect(
    business.db
      .query("SELECT platform_message_id FROM qq_conversation_tasks ORDER BY platform_message_id")
      .all(),
  ).toEqual([{ platform_message_id: "91001" }, { platform_message_id: "91002" }]);
});
