// 出站消息事实的受限读取：按当前 scope 从真实 outbound_parts 台账与
// qq_outbound_message_facts 快照投影「已确认送达」的单个部件，并经统一来源复验
// （qq_outbound_message_fact）。fixture 走真实 OutboundDelivery + 合成端口制造投递与
// delivery journal，不接真实 QQ/模型/网络；平台消息 ID 用负数字符串（合法）。
import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  assertContextSources,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import { loadQqOutboundMessageFact } from "../../src/server/channels/onebot11/message-projection";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import { recordQqOutboundMessageFact } from "../../src/server/db/qq-message-repository";
import {
  createQqStickerCollection,
  importQqSticker,
} from "../../src/server/db/qq-sticker-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { OneBotSendRequest } from "../../src/server/services/onebot-connection";
import { qqOutboundFactSourceAccess } from "../../src/server/services/qq-outbound-fact-sources";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope, QqMessagePart } from "../../src/shared/contracts/qq-message";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";
const far = "2033-01-01T00:00:00.000000Z";
const bindingId = "11111111-1111-4111-8111-111111111111";
const principal = { userId: DEFAULT_USER_ID };

function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic-model");
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
    )
    .run(bindingId, "90001", "group", "30003", DEFAULT_AGENT_ID, now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(bindingId);
  if (!conversation) throw new Error("fixture: ensureOneBot returned null");
  const outbox = new OutboundIntentRepository(h.db);
  const authorityRevision = (
    h.db.query("SELECT authority_revision AS n FROM qq_bindings WHERE id=?").get(bindingId) as {
      n: number;
    }
  ).n;
  const bindingEpoch = (
    h.db.query("SELECT binding_epoch AS n FROM conversations WHERE id=?").get(conversation.id) as {
      n: number;
    }
  ).n;
  const target = (overrides: Partial<OutboundTarget> = {}): OutboundTarget => ({
    accountId: "90001",
    conversationKind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    bindingId,
    bindingEpoch,
    authorityRevision,
    ...overrides,
  });
  const commitIntent = (
    intentId: string,
    parts: (
      | { kind: "text"; text: string; mentions?: readonly string[] }
      | { kind: "sticker"; stickerId: string }
    )[],
    targetOverrides: Partial<OutboundTarget> = {},
  ) => {
    new AgentRunRepository(h.db).createRun({
      runId: `run-${intentId}`,
      specId: "main",
      specVersion: "1",
      owner: { kind: "conversation", id: conversation.id },
      at: now,
    });
    return outbox.commit({
      id: intentId,
      runId: `run-${intentId}`,
      conversationId: conversation.id,
      ordinal: 0,
      target: target(targetOverrides),
      speechKind: "direct_reply",
      sourceThroughSeq: 0,
      deliverBy: far,
      createdAt: now,
      expiresAt: far,
      parts,
    });
  };
  /** 出站事实行由 bot-host 在 commit 时以真实账号/昵称快照播种；此测试等价播种。 */
  const seedFacts = (intentId: string) =>
    recordQqOutboundMessageFact(
      h.orm,
      {
        intentId,
        accountId: "90001",
        agentId: DEFAULT_AGENT_ID,
        identity: {
          qq: "90001",
          groupCard: "值班猫娘",
          personalNickname: null,
          legacyDisplayName: null,
          nameState: "known",
        },
        occurredAtSeconds: at,
      },
      6000,
    );
  return { h, journal, outbox, conversation, commitIntent, seedFacts };
}

type DeliveryStep =
  | { kind: "confirmed"; messageId: string }
  | { kind: "unknown" }
  | { kind: "failed" };

type CapturedSend = { request: OneBotSendRequest; step: DeliveryStep | undefined };

/** 真实 OutboundDelivery + 捕获端口：记录实际 send.message 线上片段（@ 关系的事实来源）。 */
async function deliverCaptured(
  h: ReturnType<typeof openBusinessDb>,
  journal: ConversationEventRepository,
  outbox: OutboundIntentRepository,
  intentId: string,
  script: DeliveryStep[],
): Promise<CapturedSend[]> {
  let index = 0;
  const captured: CapturedSend[] = [];
  const delivery = new OutboundDelivery({
    orm: h.orm,
    repository: outbox,
    journal,
    stickerFile: () => "base64://synthetic-sticker",
    authorize: () => true,
    now: () => now,
    port: {
      async send(request) {
        const step = script[index++];
        captured.push({ request, step });
        if (step?.kind === "confirmed") return { kind: "confirmed", messageId: step.messageId };
        if (step?.kind === "failed") return { kind: "failed", retcode: -1 };
        return { kind: "unknown", reason: "timeout" };
      },
    },
  });
  await delivery.deliver(intentId);
  return captured;
}

async function deliver(
  h: ReturnType<typeof openBusinessDb>,
  journal: ConversationEventRepository,
  outbox: OutboundIntentRepository,
  intentId: string,
  script: DeliveryStep[],
) {
  let index = 0;
  const delivery = new OutboundDelivery({
    orm: h.orm,
    repository: outbox,
    journal,
    stickerFile: () => "base64://synthetic-sticker",
    authorize: () => true,
    now: () => now,
    port: {
      async send() {
        const step = script[index++];
        if (step?.kind === "confirmed") return { kind: "confirmed", messageId: step.messageId };
        if (step?.kind === "failed") return { kind: "failed", retcode: -1 };
        return { kind: "unknown", reason: "timeout" };
      },
    },
  });
  return delivery.deliver(intentId);
}

function liveScope(
  h: ReturnType<typeof openBusinessDb>,
  conversation: { id: string },
): QqConversationScope {
  const c = h.db
    .query("SELECT binding_epoch AS epoch FROM conversations WHERE id=?")
    .get(conversation.id) as { epoch: number };
  const b = h.db
    .query(
      "SELECT account_id,conversation_kind,peer_id,agent_id,authority_revision FROM qq_bindings WHERE id=?",
    )
    .get(bindingId) as {
    account_id: string;
    conversation_kind: "group" | "private";
    peer_id: string;
    agent_id: string;
    authority_revision: number;
  };
  return {
    conversationId: conversation.id,
    accountId: b.account_id,
    conversationKind: b.conversation_kind,
    peerId: b.peer_id,
    agentId: b.agent_id,
    bindingId,
    bindingEpoch: c.epoch,
    authorityRevision: b.authority_revision,
  };
}

function ownerFor(scope: QqConversationScope, kind: "conversation" | "qq_binding"): RunOwner {
  return {
    kind,
    id: kind === "conversation" ? scope.conversationId : scope.bindingId,
    userId: DEFAULT_USER_ID,
    agentId: scope.agentId,
  };
}

function outboundRefOf(fact: NonNullable<ReturnType<typeof loadQqOutboundMessageFact>>): SourceRef {
  const ref = fact.sources.find((source) => source.kind === "qq_outbound_message_fact");
  if (!ref) throw new Error("qq_outbound_message_fact ref missing");
  return ref;
}

function partIdOf(h: ReturnType<typeof openBusinessDb>, intentId: string, ordinal: number): string {
  const row = h.db
    .query("SELECT id FROM outbound_parts WHERE intent_id=? AND ordinal=?")
    .get(intentId, ordinal) as { id: string };
  return row.id;
}

describe("qq_outbound_message_fact scoped read", () => {
  it("projects only the located confirmed text part with real identity, journal seq and a minted scoped ref", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent("intent-scope-two", [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ]);
      seedFacts(intent.id);
      await deliver(h, journal, outbox, intent.id, [
        { kind: "confirmed", messageId: "-7001" },
        { kind: "confirmed", messageId: "-7002" },
      ]);
      const scope = liveScope(h, conversation);
      const first = loadQqOutboundMessageFact(h, scope, "-7001", now);
      if (!first) throw new Error("first part fact missing");
      expect(first.id).toBe(partIdOf(h, intent.id, 0));
      expect(first.platformMessageId).toBe("-7001");
      // 只投影这一部件的正文，绝不整条多部件输出拼成单条原文。
      expect(first.parts).toEqual([{ kind: "text", text: "first" }]);
      expect(first.speaker).toMatchObject({
        role: "assistant",
        qq: "90001",
        groupCard: "值班猫娘",
        personalNickname: null,
        legacyDisplayName: null,
        nameState: "known",
      });
      expect(first.mentions).toEqual([]);
      expect(first.replyTo).toBeNull();
      expect(first.completeness).toBe("full");
      expect(first.occurredAtSeconds).toBe(at);
      // seq 取真实同 intent delivery journal 的 seq（不造）。
      const journalSeq = h.db
        .query(
          "SELECT MIN(seq) AS seq FROM conversation_events WHERE conversation_id=? AND kind='delivery' AND source_kind='outbound_intent' AND source_id=?",
        )
        .get(conversation.id, intent.id) as { seq: number };
      expect(first.seq).toBe(journalSeq.seq);
      const ref = outboundRefOf(first);
      expect(ref.id).toBe(partIdOf(h, intent.id, 0));
      expect(ref.expiresAt).toBe(far);
      // 统一入口与直接服务一致：两种 owner 形态都 available。
      expect(
        qqOutboundFactSourceAccess(h.db, ref, ownerFor(scope, "conversation"), principal, now),
      ).toBe("available");
      expect(sourceAccess(h.db, ref, ownerFor(scope, "qq_binding"), principal, now)).toBe(
        "available",
      );
      const second = loadQqOutboundMessageFact(h, scope, "-7002", now);
      if (!second) throw new Error("second part fact missing");
      expect(second.parts).toEqual([{ kind: "text", text: "second" }]);
      expect(second.id).not.toBe(first.id);
      expect(outboundRefOf(second).id).not.toBe(ref.id);
      expect(loadQqOutboundMessageFact(h, scope, "-7999", now)).toBeNull();
      assertContextSources({
        db: h.db,
        sources: [ref, outboundRefOf(second)],
        owner: ownerFor(scope, "conversation"),
        now,
        memoryRevisions: () => new Map(),
        messages: { memory: "memory changed", other: "source invalid" },
      });
    } finally {
      h.close();
    }
  });

  it("a mixed intent keeps its real confirmed part readable while the never-sent sibling stays absent", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent("intent-scope-mixed", [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ]);
      seedFacts(intent.id);
      await deliver(h, journal, outbox, intent.id, [
        { kind: "confirmed", messageId: "-7101" },
        { kind: "unknown" },
      ]);
      // 整条 intent 不是 confirmed；可读性按实际已确认部件判定。
      expect(
        (
          h.db.query("SELECT status FROM outbound_intents WHERE id=?").get(intent.id) as {
            status: string;
          }
        ).status,
      ).toBe("unknown");
      const scope = liveScope(h, conversation);
      const fact = loadQqOutboundMessageFact(h, scope, "-7101", now);
      if (!fact) throw new Error("confirmed part fact missing");
      expect(fact.parts).toEqual([{ kind: "text", text: "first" }]);
      const sibling = h.db
        .query(
          "SELECT status,platform_message_id FROM outbound_parts WHERE intent_id=? AND ordinal=1",
        )
        .get(intent.id) as { status: string; platform_message_id: string | null };
      expect(sibling).toMatchObject({ status: "unknown", platform_message_id: null });
      expect(
        sourceAccess(h.db, outboundRefOf(fact), ownerFor(scope, "conversation"), principal, now),
      ).toBe("available");
    } finally {
      h.close();
    }
  });

  it("a confirmed sticker part is marked as existing without fabricating text", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent("intent-scope-sticker", [
        { kind: "sticker", stickerId: "synthetic-sticker" },
      ]);
      seedFacts(intent.id);
      // qq_send_part.sticker_id 外键要求真实贴纸资产行（合成导入，不读真实素材）。
      const collection = createQqStickerCollection(h.orm, { name: "coll-scope-sticker" });
      importQqSticker(h.orm, {
        id: "synthetic-sticker",
        copy: { fileName: "synthetic-sticker.png", byteSize: 64, mediaType: "image" },
        name: "wave-synthetic",
        width: 64,
        height: 64,
        collectionIds: [collection.id],
      });
      await deliver(h, journal, outbox, intent.id, [{ kind: "confirmed", messageId: "-7200" }]);
      const scope = liveScope(h, conversation);
      const fact = loadQqOutboundMessageFact(h, scope, "-7200", now);
      if (!fact) throw new Error("sticker part fact missing");
      expect(fact.parts).toEqual([{ kind: "unavailable", type: "sticker" }]);
      expect(fact.completeness).toBe("unavailable");
      expect(fact.speaker).toMatchObject({ role: "assistant", qq: "90001" });
      expect(
        sourceAccess(h.db, outboundRefOf(fact), ownerFor(scope, "conversation"), principal, now),
      ).toBe("available");
    } finally {
      h.close();
    }
  });

  it("owner authorization is four-dimensional and a foreign scope cannot mint", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent("intent-scope-owner", [{ kind: "text", text: "hello" }]);
      seedFacts(intent.id);
      await deliver(h, journal, outbox, intent.id, [{ kind: "confirmed", messageId: "-7300" }]);
      const scope = liveScope(h, conversation);
      const fact = loadQqOutboundMessageFact(h, scope, "-7300", now);
      if (!fact) throw new Error("fact missing");
      const ref = outboundRefOf(fact);
      const owner = ownerFor(scope, "conversation");
      expect(qqOutboundFactSourceAccess(h.db, ref, owner, principal, now)).toBe("available");
      // principal 与 owner.userId 不一致 / principal 非默认用户。
      expect(
        qqOutboundFactSourceAccess(
          h.db,
          ref,
          { ...owner, userId: "someone-else" },
          { userId: "someone-else" },
          now,
        ),
      ).toBe("revoked");
      expect(qqOutboundFactSourceAccess(h.db, ref, owner, { userId: "someone-else" }, now)).toBe(
        "revoked",
      );
      // 缺显式 agentId / 错 agentId。
      const noAgent = { ...owner } as RunOwner;
      delete (noAgent as { agentId?: string }).agentId;
      expect(qqOutboundFactSourceAccess(h.db, ref, noAgent, principal, now)).toBe("revoked");
      expect(
        qqOutboundFactSourceAccess(h.db, ref, { ...owner, agentId: "other-agent" }, principal, now),
      ).toBe("revoked");
      // owner 指向别间会话 / 未知 owner kind。
      expect(
        qqOutboundFactSourceAccess(
          h.db,
          ref,
          { ...owner, id: "other-conversation" },
          principal,
          now,
        ),
      ).toBe("revoked");
      expect(
        qqOutboundFactSourceAccess(
          h.db,
          ref,
          { kind: "web_turn", id: "t1", userId: DEFAULT_USER_ID },
          principal,
          now,
        ),
      ).toBe("revoked");
      // 外 scope（peer/agent/authority 不符）不能 mint。
      expect(loadQqOutboundMessageFact(h, { ...scope, peerId: "30099" }, "-7300", now)).toBeNull();
      expect(
        loadQqOutboundMessageFact(
          h,
          { ...scope, agentId: "00000000-0000-4000-8000-000000000002" },
          "-7300",
          now,
        ),
      ).toBeNull();
      expect(
        loadQqOutboundMessageFact(
          h,
          { ...scope, authorityRevision: scope.authorityRevision + 1 },
          "-7300",
          now,
        ),
      ).toBeNull();
    } finally {
      h.close();
    }
  });

  it("a target without (or with a different) authorityRevision cannot pose as the current scope", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const legacy = commitIntent(
        "intent-scope-legacy",
        [{ kind: "text", text: "legacy target" }],
        { authorityRevision: undefined },
      );
      seedFacts(legacy.id);
      await deliver(h, journal, outbox, legacy.id, [{ kind: "confirmed", messageId: "-7350" }]);
      const wrong = commitIntent(
        "intent-scope-wrongauth",
        [{ kind: "text", text: "wrong authority" }],
        { authorityRevision: 99 },
      );
      seedFacts(wrong.id);
      await deliver(h, journal, outbox, wrong.id, [{ kind: "confirmed", messageId: "-7351" }]);
      const scope = liveScope(h, conversation);
      expect(loadQqOutboundMessageFact(h, scope, "-7350", now)).toBeNull();
      expect(loadQqOutboundMessageFact(h, scope, "-7351", now)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("closed conversation and a new binding epoch revoke old refs and cannot revive them", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent("intent-scope-epoch", [{ kind: "text", text: "epoch" }]);
      seedFacts(intent.id);
      await deliver(h, journal, outbox, intent.id, [{ kind: "confirmed", messageId: "-7400" }]);
      const scope = liveScope(h, conversation);
      const fact = loadQqOutboundMessageFact(h, scope, "-7400", now);
      if (!fact) throw new Error("fact missing");
      const ref = outboundRefOf(fact);
      expect(
        qqOutboundFactSourceAccess(h.db, ref, ownerFor(scope, "conversation"), principal, now),
      ).toBe("available");
      // 关会话：旧 scope 不存在；两个 owner 形态都 revoked。
      h.db.query("UPDATE conversations SET closed_at=? WHERE id=?").run(now, conversation.id);
      expect(loadQqOutboundMessageFact(h, scope, "-7400", now)).toBeNull();
      expect(
        qqOutboundFactSourceAccess(h.db, ref, ownerFor(scope, "conversation"), principal, now),
      ).toBe("revoked");
      expect(
        qqOutboundFactSourceAccess(h.db, ref, ownerFor(scope, "qq_binding"), principal, now),
      ).toBe("revoked");
      // 新纪元会话：旧 intent 属旧会话，旧 ref 不复活。
      const conversation2 = journal.ensureOneBot(bindingId);
      if (!conversation2) throw new Error("second conversation missing");
      expect(conversation2.id).not.toBe(conversation.id);
      const scope2 = liveScope(h, conversation2);
      expect(loadQqOutboundMessageFact(h, scope2, "-7400", now)).toBeNull();
      expect(
        qqOutboundFactSourceAccess(h.db, ref, ownerFor(scope2, "qq_binding"), principal, now),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("authority advance revokes the old ref and refuses re-minting under the old target", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent("intent-scope-authority", [{ kind: "text", text: "authority" }]);
      seedFacts(intent.id);
      await deliver(h, journal, outbox, intent.id, [{ kind: "confirmed", messageId: "-7500" }]);
      const scope = liveScope(h, conversation);
      const fact = loadQqOutboundMessageFact(h, scope, "-7500", now);
      if (!fact) throw new Error("fact missing");
      const ref = outboundRefOf(fact);
      expect(sourceAccess(h.db, ref, ownerFor(scope, "conversation"), principal, now)).toBe(
        "available",
      );
      h.orm
        .update(schema.qqBindings)
        .set({ revision: 2, authorityRevision: 2 })
        .where(eq(schema.qqBindings.id, bindingId))
        .run();
      expect(loadQqOutboundMessageFact(h, scope, "-7500", now)).toBeNull();
      const scope2 = liveScope(h, conversation);
      expect(scope2.authorityRevision).toBe(2);
      expect(loadQqOutboundMessageFact(h, scope2, "-7500", now)).toBeNull();
      expect(
        qqOutboundFactSourceAccess(h.db, ref, ownerFor(scope2, "qq_binding"), principal, now),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("duplicate platform id is ambiguous: refuse to project, and identity cannot be swapped by equal text", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const first = commitIntent("intent-dup-a", [{ kind: "text", text: "重复的话" }]);
      seedFacts(first.id);
      await deliver(h, journal, outbox, first.id, [{ kind: "confirmed", messageId: "-7600" }]);
      const scope = liveScope(h, conversation);
      const fact = loadQqOutboundMessageFact(h, scope, "-7600", now);
      if (!fact) throw new Error("fact missing");
      const ref = outboundRefOf(fact);
      expect(sourceAccess(h.db, ref, ownerFor(scope, "conversation"), principal, now)).toBe(
        "available",
      );
      const second = commitIntent("intent-dup-b", [{ kind: "text", text: "重复的话" }]);
      seedFacts(second.id);
      await deliver(h, journal, outbox, second.id, [{ kind: "confirmed", messageId: "-7600" }]);
      expect(loadQqOutboundMessageFact(h, scope, "-7600", now)).toBeNull();
      expect(sourceAccess(h.db, ref, ownerFor(scope, "conversation"), principal, now)).toBe(
        "revoked",
      );
      // 同文本不同部件：把 ref 的 id 换到另一个部件的身份上仍 revoked（sha 不授权）。
      const swapped = { ...ref, id: partIdOf(h, second.id, 0) };
      expect(sourceAccess(h.db, swapped, ownerFor(scope, "conversation"), principal, now)).toBe(
        "revoked",
      );
    } finally {
      h.close();
    }
  });

  it("ledger/fact drift (payload delete/rewrite, status flip, facts id change, journal loss) is refused before expiry", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const scope = liveScope(h, conversation);
      const owner = ownerFor(scope, "conversation");
      const intent = commitIntent("intent-scope-drift", [{ kind: "text", text: "drift" }]);
      seedFacts(intent.id);
      await deliver(h, journal, outbox, intent.id, [{ kind: "confirmed", messageId: "-7700" }]);
      const fact = loadQqOutboundMessageFact(h, scope, "-7700", now);
      if (!fact) throw new Error("fact missing");
      const ref = outboundRefOf(fact);
      const partId = partIdOf(h, intent.id, 0);
      expect(sourceAccess(h.db, ref, owner, principal, now)).toBe("available");
      // payload 删除。
      h.db.query("UPDATE outbound_parts SET payload=NULL WHERE id=?").run(partId);
      expect(loadQqOutboundMessageFact(h, scope, "-7700", now)).toBeNull();
      expect(sourceAccess(h.db, ref, owner, principal, now)).toBe("revoked");
      // payload 改写。
      h.db
        .query("UPDATE outbound_parts SET payload=? WHERE id=?")
        .run(JSON.stringify({ text: "rewritten" }), partId);
      expect(loadQqOutboundMessageFact(h, scope, "-7700", now)).toBeNull();
      expect(sourceAccess(h.db, ref, owner, principal, now)).toBe("revoked");
      // 退确认（status 翻转）。
      h.db.query("UPDATE outbound_parts SET status='failed' WHERE id=?").run(partId);
      expect(loadQqOutboundMessageFact(h, scope, "-7700", now)).toBeNull();
      expect(sourceAccess(h.db, ref, owner, principal, now)).toBe("revoked");
      // facts 侧平台 id 漂移。
      const second = commitIntent("intent-scope-drift2", [{ kind: "text", text: "drift2" }]);
      seedFacts(second.id);
      await deliver(h, journal, outbox, second.id, [{ kind: "confirmed", messageId: "-7701" }]);
      const fact2 = loadQqOutboundMessageFact(h, scope, "-7701", now);
      if (!fact2) throw new Error("second fact missing");
      const ref2 = outboundRefOf(fact2);
      h.db
        .query("UPDATE qq_outbound_message_facts SET parts=? WHERE intent_id=?")
        .run(
          JSON.stringify([
            { kind: "text", ordinal: 0, platformMessageId: "-999999", text: "drift2" },
          ]),
          second.id,
        );
      expect(loadQqOutboundMessageFact(h, scope, "-7701", now)).toBeNull();
      expect(sourceAccess(h.db, ref2, owner, principal, now)).toBe("revoked");
      // delivery journal 归属消失。
      const third = commitIntent("intent-scope-drift3", [{ kind: "text", text: "drift3" }]);
      seedFacts(third.id);
      await deliver(h, journal, outbox, third.id, [{ kind: "confirmed", messageId: "-7702" }]);
      const fact3 = loadQqOutboundMessageFact(h, scope, "-7702", now);
      if (!fact3) throw new Error("third fact missing");
      const ref3 = outboundRefOf(fact3);
      h.db
        .query("DELETE FROM conversation_events WHERE kind='delivery' AND source_id=?")
        .run(third.id);
      expect(loadQqOutboundMessageFact(h, scope, "-7702", now)).toBeNull();
      expect(sourceAccess(h.db, ref3, owner, principal, now)).toBe("revoked");
      // facts revision 前进：旧 ref revoked，新投影获得新 revision（一致 mint/access）。
      const fourth = commitIntent("intent-scope-drift4", [{ kind: "text", text: "drift4" }]);
      seedFacts(fourth.id);
      await deliver(h, journal, outbox, fourth.id, [{ kind: "confirmed", messageId: "-7703" }]);
      const fact4 = loadQqOutboundMessageFact(h, scope, "-7703", now);
      if (!fact4) throw new Error("fourth fact missing");
      const ref4 = outboundRefOf(fact4);
      h.db
        .query("UPDATE qq_outbound_message_facts SET revision=revision+1 WHERE intent_id=?")
        .run(fourth.id);
      expect(sourceAccess(h.db, ref4, owner, principal, now)).toBe("revoked");
      const fresh = loadQqOutboundMessageFact(h, scope, "-7703", now);
      if (!fresh) throw new Error("fresh fact missing");
      expect(outboundRefOf(fresh).revision).not.toBe(ref4.revision);
    } finally {
      h.close();
    }
  });

  it("consumable cap is the earliest of intent and fact windows; an old ref cap never extends", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent("intent-scope-cap", [{ kind: "text", text: "cap" }]);
      seedFacts(intent.id);
      await deliver(h, journal, outbox, intent.id, [{ kind: "confirmed", messageId: "-7800" }]);
      const scope = liveScope(h, conversation);
      const owner = ownerFor(scope, "conversation");
      // fact 帽提前：可消费帽取 fact 最早值。
      const factCap = "2026-10-01T16:30:00.000000Z";
      h.db
        .query("UPDATE qq_outbound_message_facts SET expires_at=? WHERE intent_id=?")
        .run(factCap, intent.id);
      const capped = loadQqOutboundMessageFact(h, scope, "-7800", now);
      if (!capped) throw new Error("capped fact missing");
      const ref = outboundRefOf(capped);
      expect(ref.expiresAt).toBe(factCap);
      const afterFact = "2026-10-01T16:30:01.000000Z";
      expect(loadQqOutboundMessageFact(h, scope, "-7800", afterFact)).toBeNull();
      expect(sourceAccess(h.db, ref, owner, principal, afterFact)).toBe("expired");
      expect(sourceAccess(h.db, ref, owner, principal, now)).toBe("available");
      // cross-owner 不得探得 expired 态（先判 owner）。
      expect(
        sourceAccess(h.db, ref, { ...owner, agentId: "other-agent" }, principal, afterFact),
      ).toBe("revoked");
      // 放宽 fact 窗口：旧 ref 帽不延长；新投影拿新帽（intent 帽）。
      h.db
        .query("UPDATE qq_outbound_message_facts SET expires_at=? WHERE intent_id=?")
        .run("2033-06-01T00:00:00.000000Z", intent.id);
      expect(sourceAccess(h.db, ref, owner, principal, afterFact)).toBe("expired");
      const fresh = loadQqOutboundMessageFact(h, scope, "-7800", afterFact);
      if (!fresh) throw new Error("fresh fact missing");
      expect(outboundRefOf(fresh).expiresAt).toBe(far);
      // intent 帽最早。
      const intentCap = "2026-10-01T16:45:00.000000Z";
      h.db.query("UPDATE outbound_intents SET expires_at=? WHERE id=?").run(intentCap, intent.id);
      const fresh2 = loadQqOutboundMessageFact(h, scope, "-7800", afterFact);
      if (!fresh2) throw new Error("intent-capped fact missing");
      expect(outboundRefOf(fresh2).expiresAt).toBe(intentCap);
      const afterIntent = "2026-10-01T16:45:01.000000Z";
      expect(loadQqOutboundMessageFact(h, scope, "-7800", afterIntent)).toBeNull();
      expect(sourceAccess(h.db, outboundRefOf(fresh2), owner, principal, afterIntent)).toBe(
        "expired",
      );
    } finally {
      h.close();
    }
  });

  it("assertContextSources/inspectContext keep the direct-domain verdict: a resolver can never flip it", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent("intent-scope-keeper", [{ kind: "text", text: "keeper" }]);
      seedFacts(intent.id);
      await deliver(h, journal, outbox, intent.id, [{ kind: "confirmed", messageId: "-7900" }]);
      const scope = liveScope(h, conversation);
      const owner = ownerFor(scope, "conversation");
      const fact = loadQqOutboundMessageFact(h, scope, "-7900", now);
      if (!fact) throw new Error("fact missing");
      const ref = outboundRefOf(fact);
      const repository = new AgentRunRepository(h.db);
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      repository.createRun({ runId, specId: "test", specVersion: "1", owner, at: nowIso() });
      repository.startStep({
        runId,
        stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "generate",
        at: nowIso(),
        messages: [{ role: "user", content: [{ kind: "text", text: "合成出站原文" }] }],
        sources: [ref],
      });
      expect(inspectContext(h.db, repository, { runId, stepId }, principal)?.status).toBe("exact");
      h.db
        .query("UPDATE qq_outbound_message_facts SET revision=revision+1 WHERE intent_id=?")
        .run(intent.id);
      // 恶意/越权 resolver 返回 available 也不能翻掉直接域判定。
      expect(() =>
        assertContextSources({
          db: h.db,
          sources: [ref],
          owner,
          now: nowIso(),
          resolveSource: () => "available",
          memoryRevisions: () => new Map(),
          messages: { memory: "memory changed", other: "source invalid" },
        }),
      ).toThrow("source invalid");
      expect(
        inspectContext(h.db, repository, { runId, stepId }, principal, undefined, () => "available")
          ?.status,
      ).toBe("revoked");
      expect(repository.getContext({ runId, stepId })?.messages).toBeNull();
    } finally {
      h.close();
    }
  });
});

describe("outbound projection: legacy wire replay and the structured protocol stay distinct", () => {
  it("a legacy part (no mentions) replays its own wire: program recipient first, body CQ at in order", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent(
        "intent-scope-at",
        [
          { kind: "text", text: "at 回复 [CQ:at,qq=30001] [CQ:at,qq=30001] 再说 @30002 好的" },
          { kind: "text", text: "第二条 [CQ:at,qq=30003]" },
        ],
        { participantId: "20002" },
      );
      seedFacts(intent.id);
      const captured = await deliverCaptured(h, journal, outbox, intent.id, [
        { kind: "confirmed", messageId: "-8001" },
        { kind: "confirmed", messageId: "-8002" },
      ]);
      // 真实线上片段：ordinal0 首位是程序收件人 at（target.participantId）；CQ at 按原
      // 文顺序转真实 at 且重复保持；字面 @30002 不转；ordinal1 不自动加收件人。
      expect(captured[0]?.request.message).toEqual([
        { type: "at", data: { qq: "20002" } },
        { type: "text", data: { text: " at 回复 " } },
        { type: "at", data: { qq: "30001" } },
        { type: "text", data: { text: " " } },
        { type: "at", data: { qq: "30001" } },
        { type: "text", data: { text: " 再说 @30002 好的" } },
      ]);
      expect(captured[1]?.request.message).toEqual([
        { type: "text", data: { text: "第二条 " } },
        { type: "at", data: { qq: "30003" } },
      ]);
      const scope = liveScope(h, conversation);
      const first = loadQqOutboundMessageFact(h, scope, "-8001", now);
      if (!first) throw new Error("first part fact missing");
      const second = loadQqOutboundMessageFact(h, scope, "-8002", now);
      if (!second) throw new Error("second part fact missing");
      // 投影与实际发送片段逐段一致（at→mention、text→text），顺序不重排。
      const toParts = (message: CapturedSend["request"]["message"]): QqMessagePart[] => {
        const parts: QqMessagePart[] = [];
        for (const segment of message) {
          if (segment.type === "at") parts.push({ kind: "mention", qq: segment.data.qq });
          else if (segment.type === "text") parts.push({ kind: "text", text: segment.data.text });
        }
        return parts;
      };
      const firstSend = captured[0];
      const secondSend = captured[1];
      if (!firstSend || !secondSend) throw new Error("fixture: expected two captured sends");
      expect(first.parts).toEqual(toParts(firstSend.request.message));
      expect(second.parts).toEqual(toParts(secondSend.request.message));
      // mentions 按真实顺序与重复收集；字面 @ 不产生 mention。
      expect(first.mentions).toEqual([
        { qq: "20002", identity: null },
        { qq: "30001", identity: null },
        { qq: "30001", identity: null },
      ]);
      expect(second.mentions).toEqual([{ qq: "30003", identity: null }]);
      // 事实写入与 ref 复验通路不变：两个 ref 仍 available。
      expect(
        sourceAccess(h.db, outboundRefOf(first), ownerFor(scope, "conversation"), principal, now),
      ).toBe("available");
      expect(
        sourceAccess(h.db, outboundRefOf(second), ownerFor(scope, "conversation"), principal, now),
      ).toBe("available");
    } finally {
      h.close();
    }
  });

  it("a structured new part sends its body literally and only its explicit mentions, and the projection agrees", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent(
        "intent-scope-structured",
        [{ kind: "text", text: "你们看 [CQ:at,qq=30001] 这个", mentions: ["20002"] }],
        { participantId: "20003" },
      );
      seedFacts(intent.id);
      const captured = await deliverCaptured(h, journal, outbox, intent.id, [
        { kind: "confirmed", messageId: "-8200" },
      ]);
      // 正文按字面（CQ 不再解释），收件人 participantId 不再自动 @，唯一的 at 是显式 mention。
      expect(captured[0]?.request.message).toEqual([
        { type: "text", data: { text: "你们看 [CQ:at,qq=30001] 这个" } },
        { type: "at", data: { qq: "20002" } },
      ]);
      const scope = liveScope(h, conversation);
      const fact = loadQqOutboundMessageFact(h, scope, "-8200", now);
      if (!fact) throw new Error("structured part fact missing");
      expect(fact.parts).toEqual([
        { kind: "text", text: "你们看 [CQ:at,qq=30001] 这个" },
        { kind: "mention", qq: "20002" },
      ]);
      expect(fact.mentions).toEqual([{ qq: "20002", identity: null }]);
      expect(
        sourceAccess(h.db, outboundRefOf(fact), ownerFor(scope, "conversation"), principal, now),
      ).toBe("available");
    } finally {
      h.close();
    }
  });

  it("rewriting a text part's mentions is a payload drift: the old ref is revoked, not silently replayed", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent(
        "intent-scope-mention-drift",
        [{ kind: "text", text: "在的", mentions: ["20002"] }],
        { participantId: "20003" },
      );
      seedFacts(intent.id);
      await deliverCaptured(h, journal, outbox, intent.id, [
        { kind: "confirmed", messageId: "-8300" },
      ]);
      const scope = liveScope(h, conversation);
      const owner = ownerFor(scope, "conversation");
      const before = loadQqOutboundMessageFact(h, scope, "-8300", now);
      if (!before) throw new Error("fact missing before drift");
      const ref = outboundRefOf(before);
      expect(sourceAccess(h.db, ref, owner, principal, now)).toBe("available");
      // 破坏性负例：payload 的 mentions 被改写（正文没变）。
      h.db
        .query("UPDATE outbound_parts SET payload=? WHERE intent_id=? AND ordinal=0")
        .run(JSON.stringify({ text: "在的", mentions: ["99999"] }), intent.id);
      // 已冻结的 ref 复验为 revoked：旧线上事实不再可读，也不按新 payload 悄悄改写。
      expect(sourceAccess(h.db, ref, owner, principal, now)).toBe("revoked");
      // 重新定位读到的是当前 payload 的新事实（新 revision），不是那份被冻结的旧编码。
      const after = loadQqOutboundMessageFact(h, scope, "-8300", now);
      if (!after) throw new Error("fact missing after drift");
      expect(after.mentions).toEqual([{ qq: "99999", identity: null }]);
      expect(outboundRefOf(after).revision).not.toBe(ref.revision);
    } finally {
      h.close();
    }
  });

  it("an invalid structured mention id on the read side refuses the fact instead of fabricating an at", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const intent = commitIntent(
        "intent-scope-bad-mention",
        [{ kind: "text", text: "在的", mentions: ["20002"] }],
        { participantId: "20003" },
      );
      seedFacts(intent.id);
      await deliverCaptured(h, journal, outbox, intent.id, [
        { kind: "confirmed", messageId: "-8400" },
      ]);
      h.db
        .query("UPDATE outbound_parts SET payload=? WHERE intent_id=? AND ordinal=0")
        .run(JSON.stringify({ text: "在的", mentions: ["all"] }), intent.id);
      const scope = liveScope(h, conversation);
      expect(loadQqOutboundMessageFact(h, scope, "-8400", now)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("a sticker part never gains a mention even when the target has a participant", async () => {
    const { h, journal, outbox, conversation, commitIntent, seedFacts } = setup();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "coll-scope-at-sticker" });
      importQqSticker(h.orm, {
        id: "synthetic-sticker-at",
        copy: { fileName: "synthetic-sticker-at.png", byteSize: 64, mediaType: "image" },
        name: "wave-synthetic-at",
        width: 64,
        height: 64,
        collectionIds: [collection.id],
      });
      const intent = commitIntent(
        "intent-scope-at-sticker",
        [{ kind: "sticker", stickerId: "synthetic-sticker-at" }],
        { participantId: "20002" },
      );
      seedFacts(intent.id);
      const captured = await deliverCaptured(h, journal, outbox, intent.id, [
        { kind: "confirmed", messageId: "-8100" },
      ]);
      // 表情真实发送就是纯 image 段：线上不存在 at，投影不得编 mention。
      expect(captured[0]?.request.message).toEqual([
        { type: "image", data: { file: "base64://synthetic-sticker" } },
      ]);
      const scope = liveScope(h, conversation);
      const fact = loadQqOutboundMessageFact(h, scope, "-8100", now);
      if (!fact) throw new Error("sticker part fact missing");
      expect(fact.parts).toEqual([{ kind: "unavailable", type: "sticker" }]);
      expect(fact.mentions).toEqual([]);
    } finally {
      h.close();
    }
  });
});
