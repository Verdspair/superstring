import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import { recordQqOutboundMessageFact } from "../../src/server/db/qq-message-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { OneBotSendResult } from "../../src/server/services/onebot-connection";
import type { Delivery } from "../../src/shared/contracts/conversation";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const now = "2026-10-12T10:00:00.000000Z";
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
  if (!conversation) throw new Error("fixture: conversation missing");
  const repository = new OutboundIntentRepository(h.db);
  const epoch = h.db
    .query("SELECT binding_epoch AS epoch FROM conversations WHERE id=?")
    .get(conversation.id) as { epoch: number };
  const target: OutboundTarget = {
    accountId: "90001",
    conversationKind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    bindingId,
    bindingEpoch: epoch.epoch,
  };
  const commitIntent = (id: string, parts: Array<{ kind: "text"; text: string }>) => {
    const runId = `run-${id}`;
    new AgentRunRepository(h.db).createRun({
      runId,
      specId: "main",
      specVersion: "1",
      owner: { kind: "conversation", id: conversation.id },
      at: now,
    });
    const intent = repository.commit({
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
    recordQqOutboundMessageFact(h.orm, {
      intentId: id,
      accountId: "90001",
      agentId: DEFAULT_AGENT_ID,
      identity: {
        qq: "90001",
        groupCard: "合成名片",
        personalNickname: null,
        legacyDisplayName: null,
        nameState: "known",
      },
      occurredAtSeconds: Math.floor(Date.parse(now) / 1000),
    });
    return intent;
  };
  return { h, journal, repository, commitIntent };
}

function createDelivery(
  f: ReturnType<typeof setup>,
  send: () => Promise<OneBotSendResult>,
  onConfirmed?: (delivery: Delivery) => void,
) {
  return new OutboundDelivery({
    orm: f.h.orm,
    repository: f.repository,
    journal: f.journal,
    stickerFile: () => null,
    authorize: () => true,
    now: () => now,
    port: {
      async send() {
        return send();
      },
    },
    onConfirmed,
  });
}

type ConfirmedSnapshot = {
  delivery: Delivery;
  inTransaction: boolean;
  factParts: Array<{
    kind: "text" | "sticker";
    ordinal: number;
    platformMessageId: string | null;
    text: string | null;
  }>;
};

function confirmedFactParts(f: ReturnType<typeof setup>, intentId: string) {
  const row = f.h.db
    .query("SELECT parts FROM qq_outbound_message_facts WHERE intent_id=?")
    .get(intentId) as { parts: string } | undefined;
  if (!row) throw new Error("fixture: outbound facts missing");
  return JSON.parse(row.parts) as ConfirmedSnapshot["factParts"];
}

describe("OutboundDelivery confirmed-delivery notification", () => {
  it("notifies once, after the whole multi-part intent and its facts are committed", async () => {
    const f = setup();
    const intent = f.commitIntent("confirmation-two-parts", [
      { kind: "text", text: "first part" },
      { kind: "text", text: "second part" },
    ]);
    let sends = 0;
    const notifications: ConfirmedSnapshot[] = [];
    const delivery = createDelivery(
      f,
      async () => {
        sends++;
        if (sends === 2) {
          expect(notifications).toHaveLength(0);
          expect(f.repository.get(intent.id)).toMatchObject({
            status: "delivering",
            parts: [{ status: "confirmed" }, { status: "sending" }],
          });
        }
        return { kind: "confirmed", messageId: `platform-${sends}` };
      },
      (value) => {
        notifications.push({
          delivery: value,
          inTransaction: f.h.db.inTransaction,
          factParts: confirmedFactParts(f, intent.id),
        });
      },
    );

    await delivery.deliver(intent.id);

    expect(sends).toBe(2);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      delivery: {
        id: intent.id,
        status: "confirmed",
        parts: [
          { status: "confirmed", platformMessageId: "platform-1" },
          { status: "confirmed", platformMessageId: "platform-2" },
        ],
      },
      inTransaction: false,
      factParts: [
        { kind: "text", ordinal: 0, platformMessageId: "platform-1", text: "first part" },
        { kind: "text", ordinal: 1, platformMessageId: "platform-2", text: "second part" },
      ],
    });
  });

  it("does not notify for partial confirmation followed by failure, unknown, or not-sent", async () => {
    const f = setup();
    const partial = f.commitIntent("confirmation-partial-failure", [
      { kind: "text", text: "confirmed first" },
      { kind: "text", text: "failed second" },
    ]);
    let partialSends = 0;
    let partialNotifications = 0;
    const partialDelivery = createDelivery(
      f,
      async () => {
        partialSends++;
        return partialSends === 1
          ? { kind: "confirmed", messageId: "partial-platform-id" }
          : { kind: "failed", retcode: 1 };
      },
      () => {
        partialNotifications++;
      },
    );
    await partialDelivery.deliver(partial.id);
    expect(f.repository.get(partial.id)).toMatchObject({
      status: "failed",
      parts: [{ status: "confirmed" }, { status: "failed" }],
    });
    expect(partialNotifications).toBe(0);

    const uncertain = f.commitIntent("confirmation-unknown", [{ kind: "text", text: "unknown" }]);
    let unknownNotifications = 0;
    await createDelivery(
      f,
      async () => ({ kind: "unknown", reason: "timeout" }),
      () => {
        unknownNotifications++;
      },
    ).deliver(uncertain.id);
    expect(f.repository.get(uncertain.id)).toMatchObject({ status: "unknown" });
    expect(unknownNotifications).toBe(0);

    const rejected = f.commitIntent("confirmation-not-sent", [{ kind: "text", text: "not sent" }]);
    let notSentNotifications = 0;
    await createDelivery(
      f,
      async () => ({ kind: "not_sent", reason: "invalid_request" }),
      () => {
        notSentNotifications++;
      },
    ).deliver(rejected.id);
    expect(f.repository.get(rejected.id)).toMatchObject({ status: "failed" });
    expect(notSentNotifications).toBe(0);
  });

  it("isolates a throwing observer and never replays its confirmed receipt", async () => {
    const f = setup();
    const intent = f.commitIntent("confirmation-observer-throws", [
      { kind: "text", text: "confirmed despite observer" },
    ]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let sends = 0;
    let notifications = 0;
    const delivery = createDelivery(
      f,
      async () => ({ kind: "confirmed", messageId: `confirmed-${++sends}` }),
      () => {
        notifications++;
        throw new Error("observer failure");
      },
    );

    try {
      await delivery.deliver(intent.id);
      await delivery.deliver(intent.id);
      delivery.recover();
      await delivery.runOnce();
      expect(f.repository.get(intent.id)).toMatchObject({
        status: "confirmed",
        parts: [{ status: "confirmed", platformMessageId: "confirmed-1" }],
      });
      expect(sends).toBe(1);
      expect(notifications).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
