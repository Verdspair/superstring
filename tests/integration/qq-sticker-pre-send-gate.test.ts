import { afterEach, describe, expect, it } from "bun:test";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import { importQqSticker, setQqStickerEnabled } from "../../src/server/db/qq-sticker-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type {
  OneBotSendRequest,
  OneBotSendResult,
} from "../../src/server/services/onebot-connection";

const now = "2026-10-11T14:00:00.000000Z";
const expiry = "2036-10-11T14:00:00.000000Z";
const bindingId = "11111111-1111-4111-8111-111111111111";
const stickerId = "22222222-2222-4222-8222-222222222222";
const handles: ReturnType<typeof openBusinessDb>[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

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
  const imported = importQqSticker(h.orm, {
    id: stickerId,
    copy: { fileName: "fixture.png", byteSize: 128, mediaType: "image" },
  });
  setQqStickerEnabled(h.orm, imported.id, true);
  const stickerSources = [{ kind: "qq_sticker", id: stickerId, revision: imported.updatedAt }];
  const outbox = new OutboundIntentRepository(h.db);
  const authorityRevision = (
    h.db.query("SELECT authority_revision AS value FROM qq_bindings WHERE id=?").get(bindingId) as {
      value: number;
    }
  ).value;
  const bindingEpoch = (
    h.db
      .query("SELECT binding_epoch AS value FROM conversations WHERE id=?")
      .get(conversation.id) as {
      value: number;
    }
  ).value;
  const target: OutboundTarget = {
    accountId: "90001",
    conversationKind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    bindingId,
    bindingEpoch,
    authorityRevision,
  };
  const runId = "run-pre-send-gate";
  new AgentRunRepository(h.db).createRun({
    runId,
    specId: "main",
    specVersion: "1",
    owner: { kind: "conversation", id: conversation.id },
    at: now,
  });
  const intent = outbox.commit({
    id: "intent-pre-send-gate",
    runId,
    conversationId: conversation.id,
    ordinal: 0,
    target,
    speechKind: "direct_reply",
    sourceThroughSeq: 0,
    deliverBy: expiry,
    createdAt: now,
    expiresAt: expiry,
    parts: [
      { kind: "text", text: "合法文字", mentions: [] },
      { kind: "sticker", stickerId, mentions: [], stickerSources },
    ],
  });
  return {
    h,
    journal,
    outbox,
    intent,
    stickerSource: stickerSources[0],
  };
}

function isStickerRequest(request: OneBotSendRequest): boolean {
  return request.message.some((segment) => segment.type === "image");
}

describe("QQ sticker pre-send hard gate", () => {
  it("re-reads capability after file resolution and immediately before the platform request", async () => {
    const f = setup();
    let stickersEnabled = true;
    const events: string[] = [];
    const sent: OneBotSendRequest[] = [];
    const gateSources: (readonly { kind: string; id: string; revision: string }[] | undefined)[] =
      [];
    const delivery = new OutboundDelivery({
      orm: f.h.orm,
      repository: f.outbox,
      journal: f.journal,
      now: () => now,
      authorize: () => true,
      stickerFile() {
        events.push("file");
        // Synthetic concurrent policy change during synchronous file resolution.
        stickersEnabled = false;
        return "base64://fixture";
      },
      stickerAvailable(_id, _target, _at, sources) {
        events.push("gate");
        gateSources.push(sources);
        return stickersEnabled;
      },
      port: {
        async send(request): Promise<OneBotSendResult> {
          events.push(isStickerRequest(request) ? "send-sticker" : "send-text");
          sent.push(request);
          return { kind: "confirmed", messageId: `message-${sent.length}` };
        },
      },
    });

    await delivery.deliver(f.intent.id);

    expect(events).toEqual(["send-text", "file", "gate"]);
    expect(sent).toHaveLength(1);
    expect(isStickerRequest(sent[0]!)).toBe(false);
    expect(f.outbox.get(f.intent.id)?.parts.map((part) => part.status)).toEqual([
      "confirmed",
      "not_sent",
    ]);
    expect(f.outbox.parts(f.intent.id)[1]?.attempted_at).not.toBeNull();
    expect(JSON.parse(f.outbox.parts(f.intent.id)[1]?.payload ?? "{}").stickerSources).toEqual([
      f.stickerSource,
    ]);
    expect(gateSources).toEqual([[f.stickerSource]]);
    expect(f.outbox.get(f.intent.id)?.status).toBe("failed");
  });
});
