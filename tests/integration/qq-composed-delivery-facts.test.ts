import { afterEach, describe, expect, it } from "bun:test";
import { sourceAccess } from "../../src/server/agent/context-access";
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
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { OneBotSendRequest } from "../../src/server/services/onebot-connection";
import type { QqMessagePart } from "../../src/shared/contracts/qq-message";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const now = "2026-10-08T05:00:00.000000Z";
const expiresAt = "2033-01-01T00:00:00.000000Z";
const bindingId = "11111111-1111-4111-8111-111111111111";

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
  const binding = h.db
    .query("SELECT authority_revision AS revision FROM qq_bindings WHERE id=?")
    .get(bindingId) as { revision: number };
  const epoch = h.db
    .query("SELECT binding_epoch AS epoch FROM conversations WHERE id=?")
    .get(conversation.id) as { epoch: number };
  const target: OutboundTarget = {
    accountId: "90001",
    conversationKind: "group",
    peerId: "30003",
    participantId: "20001",
    agentId: DEFAULT_AGENT_ID,
    bindingId,
    bindingEpoch: epoch.epoch,
    authorityRevision: binding.revision,
  };
  const commit = (
    id: string,
    parts: (
      | { kind: "text"; text: string; mentions?: readonly string[]; replyToMessageId?: string }
      | {
          kind: "sticker";
          stickerId: string;
          mentions?: readonly string[];
          replyToMessageId?: string;
        }
    )[],
  ) => {
    const runId = `run-${id}`;
    new AgentRunRepository(h.db).createRun({
      runId,
      specId: "main",
      specVersion: "1",
      owner: { kind: "conversation", id: conversation.id },
      at: now,
    });
    const intent = outbox.commit({
      id,
      runId,
      conversationId: conversation.id,
      ordinal: 0,
      target,
      speechKind: "direct_reply",
      sourceThroughSeq: 0,
      deliverBy: expiresAt,
      createdAt: now,
      expiresAt,
      parts,
    });
    journal.append({
      conversationId: conversation.id,
      eventKey: `output:${id}`,
      kind: "delivery",
      source: { kind: "outbound_intent", id, revision: "planned", expiresAt },
      occurredAt: now,
      runId,
      outputId: id,
    });
    recordQqOutboundMessageFact(h.orm, {
      intentId: id,
      accountId: "90001",
      agentId: DEFAULT_AGENT_ID,
      identity: {
        qq: "90001",
        groupCard: "助手名片",
        personalNickname: null,
        legacyDisplayName: null,
        nameState: "known",
      },
      occurredAtSeconds: Math.floor(Date.parse(now) / 1000),
    });
    return intent;
  };
  const seedSticker = (id: string) => {
    const collection = createQqStickerCollection(h.orm, { name: `collection-${id}` });
    importQqSticker(h.orm, {
      id,
      copy: { fileName: `${id}.png`, byteSize: 64, mediaType: "image" },
      name: `sticker-${id}`,
      width: 64,
      height: 64,
      collectionIds: [collection.id],
    });
  };
  return { h, journal, outbox, conversation, target, commit, seedSticker };
}

type DeliveryStep = { kind: "confirmed"; messageId: string } | { kind: "unknown" };

async function send(f: ReturnType<typeof setup>, intentId: string, script: DeliveryStep[]) {
  const requests: OneBotSendRequest[] = [];
  let index = 0;
  const delivery = new OutboundDelivery({
    orm: f.h.orm,
    repository: f.outbox,
    journal: f.journal,
    stickerFile: () => "base64://synthetic-sticker",
    authorize: () => true,
    now: () => now,
    port: {
      async send(request) {
        requests.push(request);
        const result = script[index++];
        return result?.kind === "confirmed"
          ? { kind: "confirmed", messageId: result.messageId }
          : { kind: "unknown", reason: "timeout" };
      },
    },
  });
  await delivery.deliver(intentId);
  return { requests, delivery };
}

function wireParts(message: OneBotSendRequest["message"]): QqMessagePart[] {
  return message.flatMap((segment): QqMessagePart[] => {
    if (segment.type === "text") return [{ kind: "text", text: segment.data.text }];
    if (segment.type === "at") return [{ kind: "mention", qq: segment.data.qq }];
    return [];
  });
}

describe("composed QQ delivery facts", () => {
  it("delivers quote, explicit mentions and text once on the first part and projects the captured wire", async () => {
    const f = setup();
    const intent = f.commit("composed-quote-mentions", [
      { kind: "text", text: "正文继续", mentions: ["20002"], replyToMessageId: "-501" },
      { kind: "text", text: "第二部件", mentions: ["20002"], replyToMessageId: "-501" },
    ]);
    const { requests } = await send(f, intent.id, [
      { kind: "confirmed", messageId: "-601" },
      { kind: "confirmed", messageId: "-602" },
    ]);
    expect(requests.map((request) => request.message)).toEqual([
      [
        { type: "reply", data: { id: "-501" } },
        { type: "text", data: { text: "正文继续" } },
        { type: "at", data: { qq: "20002" } },
      ],
      [{ type: "text", data: { text: "第二部件" } }],
    ]);
    const scope = {
      conversationId: f.conversation.id,
      accountId: "90001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      bindingId,
      bindingEpoch: f.target.bindingEpoch,
      authorityRevision: f.target.authorityRevision ?? 0,
    };
    const first = loadQqOutboundMessageFact(f.h, scope, "-601", now);
    const second = loadQqOutboundMessageFact(f.h, scope, "-602", now);
    const firstSend = requests[0];
    const secondSend = requests[1];
    if (!first || !second || !firstSend || !secondSend)
      throw new Error("fixture: confirmed parts and captured sends expected");
    expect(first.parts).toEqual(wireParts(firstSend.message));
    expect(first.mentions).toEqual([{ qq: "20002", identity: null }]);
    expect(first.replyTo).toEqual({ platformMessageId: "-501" });
    expect(second.parts).toEqual(wireParts(secondSend.message));
    expect(second.mentions).toEqual([]);
    expect(second.replyTo).toBeNull();
  });

  it("supports mention-only text and a quoted sticker without treating image bytes as text", async () => {
    const f = setup();
    f.seedSticker("synthetic-quoted-sticker");
    const mention = f.commit("mention-only", [{ kind: "text", text: "", mentions: ["20003"] }]);
    const quotedMention = f.commit("quote-mention-only", [
      { kind: "text", text: "", mentions: ["20007"], replyToMessageId: "-506" },
    ]);
    const sticker = f.commit("quoted-sticker", [
      {
        kind: "sticker",
        stickerId: "synthetic-quoted-sticker",
        mentions: ["20004"],
        replyToMessageId: "-502",
      },
    ]);
    const mentionSent = await send(f, mention.id, [{ kind: "confirmed", messageId: "-611" }]);
    const quotedMentionSent = await send(f, quotedMention.id, [
      { kind: "confirmed", messageId: "-613" },
    ]);
    const stickerSent = await send(f, sticker.id, [{ kind: "confirmed", messageId: "-612" }]);
    expect(mentionSent.requests[0]?.message).toEqual([{ type: "at", data: { qq: "20003" } }]);
    expect(quotedMentionSent.requests[0]?.message).toEqual([
      { type: "reply", data: { id: "-506" } },
      { type: "at", data: { qq: "20007" } },
    ]);
    expect(stickerSent.requests[0]?.message).toEqual([
      { type: "reply", data: { id: "-502" } },
      { type: "at", data: { qq: "20004" } },
      { type: "image", data: { file: "base64://synthetic-sticker" } },
    ]);
    const scope = {
      conversationId: f.conversation.id,
      accountId: "90001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      bindingId,
      bindingEpoch: f.target.bindingEpoch,
      authorityRevision: f.target.authorityRevision ?? 0,
    };
    const mentionFact = loadQqOutboundMessageFact(f.h, scope, "-611", now);
    const quotedMentionFact = loadQqOutboundMessageFact(f.h, scope, "-613", now);
    const stickerFact = loadQqOutboundMessageFact(f.h, scope, "-612", now);
    expect(mentionFact?.parts).toEqual([{ kind: "mention", qq: "20003" }]);
    expect(mentionFact?.mentions).toEqual([{ qq: "20003", identity: null }]);
    expect(quotedMentionFact?.parts).toEqual([{ kind: "mention", qq: "20007" }]);
    expect(quotedMentionFact?.replyTo).toEqual({ platformMessageId: "-506" });
    expect(stickerFact?.parts).toEqual([
      { kind: "mention", qq: "20004" },
      { kind: "unavailable", type: "sticker" },
    ]);
    expect(stickerFact?.mentions).toEqual([{ qq: "20004", identity: null }]);
    expect(stickerFact?.replyTo).toEqual({ platformMessageId: "-502" });
    const stickerSend = stickerSent.requests[0];
    if (!stickerSend) throw new Error("fixture: quoted sticker send missing");
    expect(stickerFact?.parts).toEqual([
      ...wireParts(stickerSend.message),
      { kind: "unavailable", type: "sticker" },
    ]);
    expect(JSON.stringify(stickerFact)).not.toContain("base64://");
  });

  it("encodes quote plus plain text and explicit plain text without adding recipient mentions", async () => {
    const f = setup();
    const quoted = f.commit("quote-plus-text", [
      { kind: "text", text: "只引用再答", replyToMessageId: "-505" },
    ]);
    const plain = f.commit("structured-plain-text", [
      { kind: "text", text: "只发正文", mentions: [] },
    ]);
    const quotedSent = await send(f, quoted.id, [{ kind: "confirmed", messageId: "-641" }]);
    const plainSent = await send(f, plain.id, [{ kind: "confirmed", messageId: "-642" }]);
    expect(quotedSent.requests[0]?.message).toEqual([
      { type: "reply", data: { id: "-505" } },
      { type: "text", data: { text: "只引用再答" } },
    ]);
    expect(plainSent.requests[0]?.message).toEqual([{ type: "text", data: { text: "只发正文" } }]);
    const scope = {
      conversationId: f.conversation.id,
      accountId: "90001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      bindingId,
      bindingEpoch: f.target.bindingEpoch,
      authorityRevision: f.target.authorityRevision ?? 0,
    };
    const quotedFact = loadQqOutboundMessageFact(f.h, scope, "-641", now);
    const plainFact = loadQqOutboundMessageFact(f.h, scope, "-642", now);
    expect(quotedFact?.parts).toEqual([{ kind: "text", text: "只引用再答" }]);
    expect(quotedFact?.replyTo).toEqual({ platformMessageId: "-505" });
    expect(plainFact?.parts).toEqual([{ kind: "text", text: "只发正文" }]);
    expect(plainFact?.mentions).toEqual([]);
    expect(plainFact?.replyTo).toBeNull();
  });

  it("keeps an unknown first-part receipt out of the projected facts and never resends it", async () => {
    const f = setup();
    const intent = f.commit("unknown-quoted", [
      { kind: "text", text: "未确认", mentions: ["20005"], replyToMessageId: "-503" },
      { kind: "text", text: "不能补发" },
    ]);
    const { requests } = await send(f, intent.id, [{ kind: "unknown" }]);
    expect(requests).toHaveLength(1);
    expect(f.outbox.get(intent.id)).toMatchObject({
      status: "unknown",
      parts: [{ status: "unknown" }, { status: "not_sent" }],
    });
    expect(
      loadQqOutboundMessageFact(
        f.h,
        {
          conversationId: f.conversation.id,
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
          bindingId,
          bindingEpoch: f.target.bindingEpoch,
          authorityRevision: f.target.authorityRevision ?? 0,
        },
        "-603",
        now,
      ),
    ).toBeNull();
    const restarted = new OutboundDelivery({
      orm: f.h.orm,
      repository: f.outbox,
      journal: f.journal,
      stickerFile: () => "base64://synthetic-sticker",
      authorize: () => true,
      now: () => now,
      port: {
        async send(request) {
          requests.push(request);
          return { kind: "confirmed", messageId: "-604" };
        },
      },
    });
    restarted.recover();
    await restarted.runOnce();
    expect(requests).toHaveLength(1);
  });

  it("revokes the old source ref if confirmed quote metadata is changed in the raw payload", async () => {
    const f = setup();
    const intent = f.commit("quote-metadata-source-drift", [
      { kind: "text", text: "有来源的正文", mentions: ["20006"], replyToMessageId: "-504" },
    ]);
    await send(f, intent.id, [{ kind: "confirmed", messageId: "-631" }]);
    const scope = {
      conversationId: f.conversation.id,
      accountId: "90001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      bindingId,
      bindingEpoch: f.target.bindingEpoch,
      authorityRevision: f.target.authorityRevision ?? 0,
    };
    const fact = loadQqOutboundMessageFact(f.h, scope, "-631", now);
    expect(fact?.replyTo).toEqual({ platformMessageId: "-504" });
    const source = fact?.sources[0];
    if (!source) throw new Error("fact source missing");
    expect(
      sourceAccess(
        f.h.db,
        source,
        {
          kind: "conversation",
          id: scope.conversationId,
          userId: DEFAULT_USER_ID,
          agentId: scope.agentId,
        },
        { userId: DEFAULT_USER_ID },
        now,
      ),
    ).toBe("available");
    const raw = f.h.db
      .query("SELECT payload FROM outbound_parts WHERE intent_id=?")
      .get(intent.id) as { payload: string };
    const payload = JSON.parse(raw.payload) as Record<string, unknown>;
    expect(payload.replyToMessageId).toBe("-504");
    f.h.db
      .query("UPDATE outbound_parts SET payload=? WHERE intent_id=? AND ordinal=0")
      .run(JSON.stringify({ ...payload, replyToMessageId: "-999" }), intent.id);
    expect(
      sourceAccess(
        f.h.db,
        source,
        {
          kind: "conversation",
          id: scope.conversationId,
          userId: DEFAULT_USER_ID,
          agentId: scope.agentId,
        },
        { userId: DEFAULT_USER_ID },
        now,
      ),
    ).toBe("revoked");
    expect(loadQqOutboundMessageFact(f.h, scope, "-631", now)?.replyTo).toEqual({
      platformMessageId: "-999",
    });
  });

  it("does not add quote metadata to an absent-key legacy payload", async () => {
    const f = setup();
    const intent = f.commit("legacy-no-composed-metadata", [{ kind: "text", text: "历史原文" }]);
    const legacyPart = f.outbox.parts(intent.id)[0];
    if (!legacyPart?.payload) throw new Error("fixture: legacy payload missing");
    expect(JSON.parse(legacyPart.payload)).toEqual({ text: "历史原文" });
    await send(f, intent.id, [{ kind: "confirmed", messageId: "-621" }]);
    const scope = {
      conversationId: f.conversation.id,
      accountId: "90001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      bindingId,
      bindingEpoch: f.target.bindingEpoch,
      authorityRevision: f.target.authorityRevision ?? 0,
    };
    const fact = loadQqOutboundMessageFact(f.h, scope, "-621", now);
    expect(fact?.parts).toEqual([
      { kind: "mention", qq: "20001" },
      { kind: "text", text: " 历史原文" },
    ]);
    expect(fact?.replyTo).toBeNull();
    const state = f.h.db
      .query("SELECT payload FROM outbound_parts WHERE intent_id=?")
      .get(intent.id) as { payload: string };
    expect(JSON.parse(state.payload)).toEqual({ text: "历史原文" });
  });
});
