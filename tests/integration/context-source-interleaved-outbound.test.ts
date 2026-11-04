import { describe, expect, it } from "bun:test";
import { assertContextSources, sourceAccess } from "../../src/server/agent/context-access";
import {
  loadQqMessageFact,
  loadQqOutboundMessageFact,
} from "../../src/server/channels/onebot11/message-projection";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { recordQqOutboundMessageFact } from "../../src/server/db/qq-message-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const at = Math.floor(Date.now() / 1000);
const now = new Date(at * 1000).toISOString().replace("Z", "000Z");
const bindingId = "11111111-1111-4111-8111-111111111111";
const principal = { userId: DEFAULT_USER_ID };

async function fixture() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  h.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)")
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'90001','group','30003',?,'scheme',?,?)",
    )
    .run(bindingId, DEFAULT_AGENT_ID, now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(bindingId);
  if (!conversation) throw new Error("conversation fixture missing");
  const binding = h.db
    .query("SELECT authority_revision FROM qq_bindings WHERE id=?")
    .get(bindingId) as { authority_revision: number };
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: "90001",
    conversationKind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    bindingId,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: binding.authority_revision,
  };
  const owner: RunOwner = {
    kind: "conversation",
    id: conversation.id,
    userId: DEFAULT_USER_ID,
    agentId: DEFAULT_AGENT_ID,
  };
  const pairs: SourceRef[][] = [];
  let sourceThroughSeq = 0;
  for (let i = 0; i < 1; i++) {
    const messageId = -1000 - i;
    const normalized = normalizeOneBotMessage(
      {
        time: at,
        self_id: 90001,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: messageId,
        user_id: 10001,
        group_id: 30003,
        sender: { nickname: "Synthetic" },
        message: [{ type: "text", data: { text: `body-${i}` } }],
      },
      "90001",
    );
    if (normalized.kind !== "message") throw new Error("message expected");
    recordObservation(h.orm, normalized.observation, DEFAULT_AGENT_ID);
    const event = journal.ingestOneBotEvent(normalized.observation.eventKey, bindingId);
    if (!event) throw new Error("inbound journal event missing");
    sourceThroughSeq = event.seq;
    const fact = loadQqMessageFact(h, scope, String(messageId), now);
    if (!fact) throw new Error("fact missing");
    const factRef = fact.sources.find((ref) => ref.kind === "qq_message_fact");
    const bodyRef = fact.sources.find((ref) => ref.kind === "qq_observation");
    if (!factRef || !bodyRef) throw new Error("fact and body refs expected");
    pairs.push([factRef, bodyRef]);
  }
  const outbox = new OutboundIntentRepository(h.db);
  new AgentRunRepository(h.db).createRun({
    runId: "outbound-run",
    specId: "main",
    specVersion: "1",
    owner: { kind: "conversation", id: conversation.id },
    at: now,
  });
  const far = "2033-01-01T00:00:00.000000Z";
  const intent = outbox.commit({
    id: "outbound-intent",
    runId: "outbound-run",
    conversationId: conversation.id,
    ordinal: 0,
    target: {
      accountId: scope.accountId,
      conversationKind: scope.conversationKind,
      peerId: scope.peerId,
      agentId: scope.agentId,
      bindingId: scope.bindingId,
      bindingEpoch: scope.bindingEpoch,
      authorityRevision: scope.authorityRevision,
    },
    speechKind: "direct_reply",
    sourceThroughSeq,
    deliverBy: far,
    createdAt: now,
    expiresAt: far,
    parts: [{ kind: "text", text: "outgoing" }],
  });
  recordQqOutboundMessageFact(
    h.orm,
    {
      intentId: intent.id,
      accountId: scope.accountId,
      agentId: scope.agentId,
      identity: {
        qq: scope.accountId,
        groupCard: "Synthetic",
        personalNickname: null,
        legacyDisplayName: null,
        nameState: "known",
      },
      occurredAtSeconds: at,
    },
    6000,
  );
  const delivery = new OutboundDelivery({
    orm: h.orm,
    repository: outbox,
    journal,
    stickerFile: () => "base64://synthetic-sticker",
    authorize: () => true,
    now: () => now,
    port: {
      async send() {
        return { kind: "confirmed", messageId: "-7001" };
      },
    },
  });
  const delivered = await delivery.deliver(intent.id);
  if (delivered?.status !== "confirmed") {
    throw new Error(`outbound delivery not confirmed: ${delivered?.status ?? "missing"}`);
  }
  const outbound = loadQqOutboundMessageFact(h, scope, "-7001", now);
  const outgoing = outbound?.sources.find((ref) => ref.kind === "qq_outbound_message_fact");
  if (!outgoing) throw new Error("confirmed outgoing fact missing");
  return { h, owner, incoming: pairs[0]![0]!, observation: pairs[0]![1]!, outgoing };
}

function assertSources(
  h: ReturnType<typeof openBusinessDb>,
  sources: SourceRef[],
  owner: RunOwner,
  visited: SourceRef[] = [],
) {
  assertContextSources({
    db: h.db,
    sources,
    owner,
    now,
    memoryRevisions: () => new Map(),
    skip: (source) => {
      visited.push(source);
      return false;
    },
    messages: { memory: "memory changed", other: "source invalid" },
  });
}

describe("interleaved incoming and confirmed outbound source authorization", () => {
  it("matches scalar authorization and retains source order for grouped and interleaved refs", async () => {
    const f = await fixture();
    try {
      const grouped = [
        f.incoming,
        { ...f.incoming },
        f.observation,
        { ...f.observation },
        f.outgoing,
        { ...f.outgoing },
      ];
      const interleaved = [
        f.outgoing,
        f.incoming,
        f.observation,
        { ...f.outgoing },
        { ...f.observation },
        { ...f.incoming },
      ];
      for (const sources of [grouped, interleaved]) {
        expect(sources.map((ref) => sourceAccess(f.h.db, ref, f.owner, principal, now))).toEqual(
          sources.map(() => "available"),
        );
        const visited: SourceRef[] = [];
        assertSources(f.h, sources, f.owner, visited);
        expect(visited).toEqual(sources);
      }
    } finally {
      f.h.close();
    }
  });

  it("rejects duplicate outbound refs with stale revision or expired cap and wrong owner", async () => {
    const f = await fixture();
    try {
      const badRefs = [
        { ...f.outgoing, revision: "stale" },
        { ...f.outgoing, expiresAt: "2000-01-01T00:00:00.000Z" },
      ];
      for (const bad of badRefs) {
        expect(sourceAccess(f.h.db, bad, f.owner, principal, now)).not.toBe("available");
        for (const sources of [
          [f.incoming, f.observation, f.outgoing, bad],
          [bad, f.incoming, f.outgoing, f.observation],
        ]) {
          expect(() => assertSources(f.h, sources, f.owner)).toThrow("source invalid");
        }
      }
      const wrong = { ...f.owner, id: "other-conversation" };
      expect(sourceAccess(f.h.db, f.outgoing, wrong, principal, now)).toBe("revoked");
      expect(() => assertSources(f.h, [f.incoming, f.outgoing, f.observation], wrong)).toThrow(
        "source invalid",
      );
    } finally {
      f.h.close();
    }
  });

  it("propagates the selected observation query failure without scalar fallback", async () => {
    const f = await fixture();
    const db = f.h.db as unknown as { query: (sql: string) => unknown };
    const original = db.query;
    const failure = new Error("synthetic observation query failure");
    let executions = 0;
    db.query = ((sql: string) => {
      const statement = Reflect.apply(original, f.h.db, [sql]) as object;
      if (!/FROM qq_events e/.test(sql) || !/qq_observation_text/.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "all" || property === "get") {
            return () => {
              executions++;
              throw failure;
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof db.query;
    try {
      let caught: unknown;
      try {
        assertSources(f.h, [f.incoming, f.observation, f.outgoing], f.owner);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(executions).toBe(1);
    } finally {
      db.query = original;
      f.h.close();
    }
  });
});
