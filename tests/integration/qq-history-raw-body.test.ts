// Tagged `qq-message:<eventKey>` history loader: the paged object is the raw message
// body, sources are the real qq_message_fact + qq_observation refs, and the fact
// state comes from the same shared service as the fact projection. Negative cases
// refuse without leaking. Numeric-seq history and the Web paths stay covered by
// conversation-evidence-tools.test.ts; the tag is opaque — never parsed as a UUID
// or reversed into a platform message ID.
import type { SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { sourceAccess } from "../../src/server/agent/context-access";
import {
  bodyRevision,
  ConversationEventRepository,
} from "../../src/server/db/conversation-event-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID as AGENT,
  ensureDefaults,
  DEFAULT_USER_ID as USER,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { BotEvidenceScope } from "../../src/server/modules/conversation-evidence";
import { loadConversationEvidence } from "../../src/server/modules/conversation-evidence-store";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const at = "2026-10-02T00:00:00.000Z",
  epochSeconds = Math.floor(Date.parse(at) / 1000);
const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "model");
  const exec = (sql: string, ...args: SQLQueryBindings[]) => h.db.query(sql).run(...args);
  exec(
    "INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    at,
    at,
  );
  exec(
    "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','100','group','200',?,'scheme',?,?)",
    AGENT,
    at,
    at,
  );
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot("binding");
  if (!conversation) throw new Error("conversation fixture missing");
  const scope: BotEvidenceScope = {
    channel: "onebot11",
    agentId: AGENT,
    conversationId: conversation.id,
    bindingId: "binding",
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: 1,
    accountId: "100",
    conversationKind: "group",
    peerId: "200",
  };
  /** 生产链：recordObservation（真实 facts + 正文行）＋可选 journal ingest（timeline）。 */
  function ingest(messageId: number, text: string | null, peer = "200", append = true) {
    const result = normalizeOneBotMessage(
      {
        time: epochSeconds,
        self_id: 100,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: messageId,
        user_id: 300,
        group_id: 200,
        sender: { card: "阿林", nickname: "林某" },
        message: text === null ? [] : [{ type: "text", data: { text } }],
      },
      "100",
    );
    if (result.kind !== "message") throw new Error("message expected");
    const observation =
      peer === "200"
        ? result.observation
        : {
            ...result.observation,
            conversation: { ...result.observation.conversation, peerId: peer },
          };
    recordObservation(h.orm, observation, AGENT);
    if (append) journal.ingestOneBotEvent(observation.eventKey, "binding");
    return { eventKey: observation.eventKey };
  }
  const owner = { kind: "qq_binding", id: "binding", userId: USER, agentId: AGENT };
  function assertAvailable(sources: readonly SourceRef[]) {
    for (const s of sources)
      if (sourceAccess(h.db, s, owner, { userId: USER }, at) !== "available")
        throw new Error("CONTEXT_SOURCE_INVALID");
  }
  return { h, exec, scope, ingest, assertAvailable };
}

describe("tagged qq-message history loader", () => {
  it("serves the exact raw body with real, revalidatable fact+observation sources", () => {
    const f = setup();
    const raw = "阿林 2026-10-02 08:00:05\n🦄 伪header\n第二行";
    const { eventKey } = f.ingest(-102, raw);
    const row = loadConversationEvidence(
      { db: f.h.db, orm: f.h.orm },
      f.scope,
      "history",
      `qq-message:${eventKey}`,
      at,
    );
    if (!row) throw new Error("tagged load returned null");
    // 原文逐字：不渲染姓名/时间标题，emoji 与换行原样保留。
    expect(row.text).toBe(raw);
    expect(row.title).not.toContain("阿林");
    expect(row.title).not.toContain("08:00:05");
    const fact = row.sources.find((s) => s.kind === "qq_message_fact");
    const body = row.sources.find((s) => s.kind === "qq_observation");
    if (!fact || !body) throw new Error("fact/body sources missing");
    expect(fact.id).toBe(eventKey);
    expect(body.id).toBe(eventKey);
    expect(body.revision).toBe(bodyRevision(raw));
    expect(fact.expiresAt).toBeString();
    expect(body.expiresAt).toBeString();
    // 真实服务端 access 复验：两个来源都必须 available。
    f.assertAvailable(row.sources);
    expect(row.revision).toBeString();
  });

  it("refuses foreign scope, stale authority, unjournaled events and malformed keys", () => {
    const f = setup();
    const { eventKey } = f.ingest(-103, "本群可见");
    const foreign = f.ingest(-104, "别群的话", "999");
    const store = { db: f.h.db, orm: f.h.orm };
    expect(
      loadConversationEvidence(store, f.scope, "history", `qq-message:${eventKey}`, at)?.text,
    ).toBe("本群可见");
    // 跨群正文：键指到别 peer 的事件 → null，不泄露。
    expect(
      loadConversationEvidence(store, f.scope, "history", `qq-message:${foreign.eventKey}`, at),
    ).toBeNull();
    // 伪造 scope（别 peer / 错 authority）拿本群消息 → null。
    expect(
      loadConversationEvidence(
        store,
        { ...f.scope, peerId: "999" },
        "history",
        `qq-message:${eventKey}`,
        at,
      ),
    ).toBeNull();
    expect(
      loadConversationEvidence(
        store,
        { ...f.scope, authorityRevision: 7 },
        "history",
        `qq-message:${eventKey}`,
        at,
      ),
    ).toBeNull();
    // 换绑（authority 推进）后旧 scope 失效。
    f.exec("UPDATE qq_bindings SET revision=2,authority_revision=2 WHERE id='binding'");
    expect(
      loadConversationEvidence(store, f.scope, "history", `qq-message:${eventKey}`, at),
    ).toBeNull();
    // 坏 tag / 任意字符串 / UUID 形状 / 超长：一律 null，不当 UUID、不反解平台 ID。
    expect(loadConversationEvidence(store, f.scope, "history", "qq-message:", at)).toBeNull();
    expect(
      loadConversationEvidence(store, f.scope, "history", "web-message:whatever", at),
    ).toBeNull();
    expect(
      loadConversationEvidence(store, f.scope, "history", "qq-message:not-a-known-key", at),
    ).toBeNull();
    expect(
      loadConversationEvidence(store, f.scope, "history", `qq-message:${crypto.randomUUID()}`, at),
    ).toBeNull();
    expect(
      loadConversationEvidence(store, f.scope, "history", `qq-message:${"x".repeat(1025)}`, at),
    ).toBeNull();
    // 只落库不 journal → 不在 timeline → null。
    const unjournaled = f.ingest(-105, "只有事实没有journal", "200", false);
    expect(
      loadConversationEvidence(store, f.scope, "history", `qq-message:${unjournaled.eventKey}`, at),
    ).toBeNull();
  });

  it("serves a legacy name snapshot's known body; refuses expired body, expired fact and media-only", () => {
    const f = setup();
    const { eventKey } = f.ingest(-106, "旧名字时代的原话");
    const store = { db: f.h.db, orm: f.h.orm };
    const key = `qq-message:${eventKey}`;
    expect(loadConversationEvidence(store, f.scope, "history", key, at)?.text).toBe(
      "旧名字时代的原话",
    );
    // legacy 单昵称快照：正文仍是已知合法原文，不因 legacy 一刀切拒绝。
    f.exec(
      "UPDATE qq_message_facts SET group_card=NULL,group_card_source=NULL,personal_nickname=NULL,personal_nickname_source=NULL,legacy_display_name='阿林',name_state='legacy' WHERE event_key=?",
      eventKey,
    );
    const legacy = loadConversationEvidence(store, f.scope, "history", key, at);
    if (!legacy) throw new Error("legacy body refused");
    expect(legacy.text).toBe("旧名字时代的原话");
    f.assertAvailable(legacy.sources);
    // 正文早于事实到期：qq_observation 帽到期 → null（不复活旧文）。
    f.exec("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?", at, eventKey);
    expect(loadConversationEvidence(store, f.scope, "history", key, at)).toBeNull();
    // 事实快照到期 → null。
    const factOnly = f.ingest(-107, "事实到期");
    const factKey = `qq-message:${factOnly.eventKey}`;
    expect(loadConversationEvidence(store, f.scope, "history", factKey, at)?.text).toBe("事实到期");
    f.exec("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?", at, factOnly.eventKey);
    expect(loadConversationEvidence(store, f.scope, "history", factKey, at)).toBeNull();
    // media-only（无正文行）→ null，不编造空 body。
    const media = f.ingest(-108, null);
    expect(
      loadConversationEvidence(store, f.scope, "history", `qq-message:${media.eventKey}`, at),
    ).toBeNull();
  });

  it("fails closed on source revalidation after body rewrite or fact expiry", () => {
    const f = setup();
    const { eventKey } = f.ingest(-109, "原句");
    const store = { db: f.h.db, orm: f.h.orm };
    const key = `qq-message:${eventKey}`;
    const row = loadConversationEvidence(store, f.scope, "history", key, at);
    if (!row) throw new Error("row");
    f.assertAvailable(row.sources);
    // 正文改写 → qq_observation 哈希与事实一致性同时失效 → 拒。
    f.exec("UPDATE qq_observation_text SET body='改写后的句子' WHERE event_key=?", eventKey);
    expect(() => f.assertAvailable(row.sources)).toThrow(/CONTEXT_SOURCE_INVALID/);
    expect(loadConversationEvidence(store, f.scope, "history", key, at)).toBeNull();
    f.exec("UPDATE qq_observation_text SET body='原句' WHERE event_key=?", eventKey);
    const fresh = loadConversationEvidence(store, f.scope, "history", key, at);
    if (!fresh) throw new Error("fresh row");
    f.assertAvailable(fresh.sources);
    // 事实快照到期 → qq_message_fact 复验 expired → 拒。
    f.exec("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?", at, eventKey);
    expect(() => f.assertAvailable(fresh.sources)).toThrow(/CONTEXT_SOURCE_INVALID/);
    expect(loadConversationEvidence(store, f.scope, "history", key, at)).toBeNull();
  });
});
