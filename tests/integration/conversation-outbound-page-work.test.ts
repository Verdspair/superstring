import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as projection from "../../src/server/channels/onebot11/message-projection";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import {
  confirmQqOutboundPart,
  recordQqOutboundMessageFact,
} from "../../src/server/db/qq-message-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { qqOutboundFactSourceAccess } from "../../src/server/services/qq-outbound-fact-sources";
import type { QqConversationScope, QqMessageFact } from "../../src/shared/contracts/qq-message";
import { cloneBusinessDb } from "../harness/business-db";

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";
const far = "2033-01-01T00:00:00.000000Z";
const bindingId = "11111111-1111-4111-8111-111111111111";
const principal = { userId: DEFAULT_USER_ID };

function setup() {
  const h = cloneBusinessDb();
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

function liveScope(
  h: ReturnType<typeof cloneBusinessDb>,
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

type Batch = (
  store: ReturnType<typeof cloneBusinessDb>,
  scope: QqConversationScope,
  platformIds: readonly string[],
  now?: string,
) => QqMessageFact[];
function batchProjector(): Batch {
  const batch = (projection as unknown as { loadQqOutboundMessageFacts?: Batch })
    .loadQqOutboundMessageFacts;
  expect(typeof batch).toBe("function");
  return batch!;
}

function confirmed(
  f: ReturnType<typeof setup>,
  id: string,
  platformId: string,
  text = `synthetic ${id}`,
) {
  const intent = f.commitIntent(id, [{ kind: "text", text, mentions: ["40004"] }]);
  f.seedFacts(intent.id);
  const part = f.outbox.claimPart(intent.id, now)!;
  f.outbox.settlePart(part.part.id, { status: "confirmed", messageId: platformId }, now);
  confirmQqOutboundPart(f.h.orm, {
    intentId: intent.id,
    platformMessageId: platformId,
    kind: "text",
    ordinal: 0,
    text,
  });
  const snapshot = JSON.stringify([["confirmed", platformId]]);
  f.journal.append({
    conversationId: f.conversation.id,
    eventKey: `delivery:${id}`,
    kind: "delivery",
    source: { kind: "outbound_intent", id, revision: snapshot },
    occurredAt: now,
    recordedAt: now,
  });
  return { intent, partId: part.part.id };
}

// The established scalar load followed by the established source keeper is the full
// output oracle. No projected fields, source hashes or identity snapshots are omitted.
function scalar(f: ReturnType<typeof setup>, scope: QqConversationScope, ids: readonly string[]) {
  return ids.flatMap((id) => {
    const fact = projection.loadQqOutboundMessageFact(f.h, scope, id, now);
    if (!fact) return [];
    const ref = fact.sources.find((source) => source.kind === "qq_outbound_message_fact")!;
    return qqOutboundFactSourceAccess(
      f.h.db,
      ref,
      {
        kind: "conversation",
        id: scope.conversationId,
        userId: DEFAULT_USER_ID,
        agentId: scope.agentId,
      },
      principal,
      now,
    ) === "available"
      ? [fact]
      : [];
  });
}
function parity(f: ReturnType<typeof setup>, scope: QqConversationScope, ids: readonly string[]) {
  const expected = scalar(f, scope, ids);
  expect(batchProjector()(f.h, scope, ids, now)).toEqual(expected);
  return expected;
}
function measured(db: Database, run: () => QqMessageFact[]) {
  const calls: string[] = [];
  const original = db.query.bind(db);
  const trace = spyOn(db, "query").mockImplementation(((sql: string) => {
    const statement = original(sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "get" || key === "all") calls.push(sql);
          return Reflect.apply(value, target, args);
        };
      },
    });
  }) as typeof db.query);
  const start = performance.now();
  try {
    return { facts: run(), calls, ms: performance.now() - start };
  } finally {
    trace.mockRestore();
  }
}

describe("outbound selected page shared proof", () => {
  it("preserves full scalar facts including repeated event references with shared row/claim reads", () => {
    const f = setup();
    const ids = Array.from({ length: 25 }, (_, n) => String(-8000 - n));
    ids.forEach((id, n) => {
      confirmed(f, `page:${n}`, id);
    });
    const scope = liveScope(f.h, f.conversation);
    const repeated = [...ids, ...ids.slice(0, 5)];
    const expected = scalar(f, scope, repeated);
    expect(expected).toHaveLength(30);
    const project = batchProjector();
    const baseline = measured(f.h.db, () => scalar(f, scope, repeated));
    const selected = measured(f.h.db, () => project(f.h, scope, repeated, now));
    expect(selected.facts).toEqual(expected);
    expect(selected.calls.length).toBeLessThan(baseline.calls.length);
    const rawJoins = selected.calls.filter(
      (sql) => sql.includes("targetRaw") && sql.includes("factParts"),
    );
    expect(rawJoins).toHaveLength(1);
    const claims = selected.calls.filter(
      (sql) => /COUNT\(\*\)/.test(sql) && sql.includes("outbound_parts"),
    );
    expect(claims).toHaveLength(1);
    console.info(
      JSON.stringify({
        outboundPageWork: {
          selected: 25,
          returned: 30,
          scalar: { sql: baseline.calls.length, ms: baseline.ms },
          batch: { sql: selected.calls.length, ms: selected.ms },
        },
      }),
    );
  });

  it("rejects an unconfirmed matching-platform sibling that has facts even with one confirmed claim", () => {
    const f = setup();
    confirmed(f, "confirmed", "-9001");
    f.commitIntent("unconfirmed", [{ kind: "text", text: "not sent" }]);
    f.seedFacts("unconfirmed");
    f.h.db
      .query("UPDATE outbound_parts SET platform_message_id='-9001' WHERE intent_id='unconfirmed'")
      .run();
    const scope = liveScope(f.h, f.conversation);
    expect(parity(f, scope, ["-9001"])).toEqual([]);
  });

  it("counts confirmed claims without facts and foreign fact identities before accepting a platform ID", () => {
    const f = setup();
    confirmed(f, "visible", "-9002");
    const other = f.commitIntent("other", [{ kind: "text", text: "other" }]);
    const part = f.outbox.claimPart(other.id, now)!;
    f.outbox.settlePart(part.part.id, { status: "confirmed", messageId: "-9002" }, now);
    const scope = liveScope(f.h, f.conversation);
    expect(parity(f, scope, ["-9002"])).toEqual([]);
    f.seedFacts(other.id);
    f.h.db
      .query("UPDATE qq_outbound_message_facts SET account_id='foreign' WHERE intent_id=?")
      .run(other.id);
    expect(parity(f, scope, ["-9002"])).toEqual([]);
  });

  it("does not borrow current permission from a history root, stale epoch, authority or foreign scope", () => {
    const f = setup();
    confirmed(f, "scoped", "-9003");
    const scope = liveScope(f.h, f.conversation);
    expect(parity(f, scope, ["-9003"])).toHaveLength(1);
    for (const override of [
      { bindingEpoch: scope.bindingEpoch + 1 },
      { authorityRevision: scope.authorityRevision + 1 },
      { conversationId: bindingId },
      { accountId: "foreign" },
      { agentId: "foreign" },
      { peerId: "foreign" },
    ])
      expect(parity(f, { ...scope, ...override }, ["-9003"])).toEqual([]);
    f.h.db
      .query(
        "UPDATE qq_bindings SET authority_revision=authority_revision+1,revision=revision+1 WHERE id=?",
      )
      .run(bindingId);
    expect(parity(f, scope, ["-9003"])).toEqual([]);
  });

  it("sees payload, target, fact identity and journal mutations on each new call", () => {
    const f = setup();
    const one = confirmed(f, "mutable", "-9004");
    const scope = liveScope(f.h, f.conversation);
    expect(parity(f, scope, ["-9004"])).toHaveLength(1);
    const target = (
      f.h.db.query("SELECT target FROM outbound_intents WHERE id='mutable'").get() as {
        target: string;
      }
    ).target;
    f.h.db
      .query("UPDATE outbound_intents SET target=? WHERE id='mutable'")
      .run(JSON.stringify({ ...JSON.parse(target), bindingEpoch: true }));
    expect(parity(f, scope, ["-9004"])).toEqual([]);
    f.h.db.query("UPDATE outbound_intents SET target=? WHERE id='mutable'").run(target);
    f.h.db
      .query("UPDATE outbound_parts SET payload=? WHERE id=?")
      .run(JSON.stringify({ text: "changed" }), one.partId);
    expect(parity(f, scope, ["-9004"])).toEqual([]);
    f.h.db
      .query("UPDATE outbound_parts SET payload=? WHERE id=?")
      .run(JSON.stringify({ text: "synthetic mutable", mentions: ["40004"] }), one.partId);
    expect(parity(f, scope, ["-9004"])).toHaveLength(1);
    const before = parity(f, scope, ["-9004"])[0]!;
    f.h.db
      .query(
        "UPDATE qq_outbound_message_facts SET group_card='new name',revision=revision+1 WHERE intent_id='mutable'",
      )
      .run();
    const after = parity(f, scope, ["-9004"])[0]!;
    expect(after.speaker.groupCard).toBe("new name");
    expect(after.sources[0]!.revision).not.toBe(before.sources[0]!.revision);
    f.h.db
      .query(
        "DELETE FROM conversation_events WHERE source_kind='outbound_intent' AND source_id='mutable'",
      )
      .run();
    expect(parity(f, scope, ["-9004"])).toEqual([]);
  });

  it("retains both TTL windows, empty/missing behavior and next-call unconfirmation", () => {
    const f = setup();
    const one = confirmed(f, "ttl", "-9005");
    const scope = liveScope(f.h, f.conversation);
    expect(parity(f, scope, ["missing", "-9005"])).toHaveLength(1);
    expect(parity(f, scope, [])).toEqual([]);
    f.h.db
      .query("UPDATE qq_outbound_message_facts SET expires_at='2020-01-01' WHERE intent_id='ttl'")
      .run();
    expect(parity(f, scope, ["-9005"])).toEqual([]);
    f.h.db
      .query("UPDATE qq_outbound_message_facts SET expires_at=? WHERE intent_id='ttl'")
      .run(far);
    f.h.db.query("UPDATE outbound_intents SET expires_at='2020-01-01' WHERE id='ttl'").run();
    expect(parity(f, scope, ["-9005"])).toEqual([]);
    f.h.db.query("UPDATE outbound_intents SET expires_at=? WHERE id='ttl'").run(far);
    f.h.db.query("UPDATE outbound_parts SET status='unknown' WHERE id=?").run(one.partId);
    expect(parity(f, scope, ["-9005"])).toEqual([]);
  });
});
