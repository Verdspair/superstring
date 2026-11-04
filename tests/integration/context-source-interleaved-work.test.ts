import { describe, expect, it } from "bun:test";
import { assertContextSources, sourceAccess } from "../../src/server/agent/context-access";
import { loadQqMessageFact } from "../../src/server/channels/onebot11/message-projection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
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
const principal = { userId: DEFAULT_USER_ID };

function fixture(count: number) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  h.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)")
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','90001','group','30003',?,'scheme',?,?)",
    )
    .run(DEFAULT_AGENT_ID, now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot("binding");
  if (!conversation) throw new Error("conversation fixture missing");
  const binding = h.db
    .query("SELECT authority_revision FROM qq_bindings WHERE id='binding'")
    .get() as { authority_revision: number };
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: "90001",
    conversationKind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    bindingId: "binding",
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
  for (let i = 0; i < count; i++) {
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
    journal.ingestOneBotEvent(normalized.observation.eventKey, "binding");
    const fact = loadQqMessageFact(h, scope, String(messageId), now);
    if (!fact) throw new Error("fact missing");
    const factRef = fact.sources.find((ref) => ref.kind === "qq_message_fact");
    const bodyRef = fact.sources.find((ref) => ref.kind === "qq_observation");
    if (!factRef || !bodyRef) throw new Error("fact and body refs expected");
    pairs.push([factRef, bodyRef]);
  }
  return { h, owner, pairs };
}

function grouped(pairs: SourceRef[][]): SourceRef[] {
  return [...pairs.map((pair) => pair[0]!), ...pairs.map((pair) => pair[1]!)];
}

function check(
  h: ReturnType<typeof openBusinessDb>,
  sources: SourceRef[],
  owner: RunOwner,
  resolveSource?: (source: SourceRef) => "available" | undefined,
) {
  try {
    assertContextSources({
      db: h.db,
      sources,
      owner,
      now,
      resolveSource,
      memoryRevisions: () => new Map(),
      messages: { memory: "memory changed", other: "source invalid" },
    });
    return { status: "available" };
  } catch (error) {
    const e = error as { code?: string; message?: string; statusCode?: number };
    return { status: "error", code: e.code, message: e.message, statusCode: e.statusCode };
  }
}

function countReads<T>(h: ReturnType<typeof openBusinessDb>, run: () => T) {
  const counts = { fact: 0, observation: 0 };
  const db = h.db as unknown as { query: (sql: string) => unknown };
  const original = db.query;
  db.query = ((sql: string) => {
    const statement = Reflect.apply(original, h.db, [sql]) as object;
    const kind = /CROSS JOIN qq_message_facts f/.test(sql)
      ? "fact"
      : /FROM qq_events e/.test(sql) && /qq_observation_text/.test(sql)
        ? "observation"
        : null;
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (kind && (property === "get" || property === "all")) {
          return (...bindings: unknown[]) => {
            counts[kind]++;
            return Reflect.apply(value as (...args: unknown[]) => unknown, target, bindings);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    return { value: run(), counts };
  } finally {
    db.query = original;
  }
}

describe("interleaved QQ fact and observation source work", () => {
  for (const count of [1, 32, 400]) {
    it(`keeps ${count} projected pairs equivalent and bounds both SQL read counts`, () => {
      const { h, owner, pairs } = fixture(count);
      try {
        const interleaved = pairs.flat();
        const ordered = grouped(pairs);
        expect(interleaved.map((ref) => sourceAccess(h.db, ref, owner, principal, now))).toEqual(
          Array(count * 2).fill("available"),
        );
        const a = countReads(h, () => check(h, interleaved, owner));
        const b = countReads(h, () => check(h, ordered, owner));
        expect(a.value).toEqual({ status: "available" });
        expect(a.value).toEqual(b.value);
        expect(b.counts).toEqual({ fact: 1, observation: 1 });
        expect(a.counts.fact).toBeLessThanOrEqual(1);
        expect(a.counts.observation).toBeLessThanOrEqual(1);
      } finally {
        h.close();
      }
    });
  }

  it("re-reads a later QQ block after a custom resolver mutates its observation", () => {
    const { h, owner, pairs } = fixture(2);
    try {
      const right = pairs[1]![1]!;
      const barrier: SourceRef = { kind: "custom_barrier", id: "barrier", revision: "1" };
      let calls = 0;
      expect(
        check(h, [...pairs[0]!, barrier, ...pairs[1]!], owner, (source) => {
          if (source.kind !== barrier.kind) return undefined;
          calls++;
          h.db
            .query("UPDATE qq_observation_text SET body=? WHERE event_key=?")
            .run("changed", right.id);
          return "available";
        }),
      ).toEqual({
        status: "error",
        code: "CONTEXT_SOURCE_INVALID",
        message: "source invalid",
        statusCode: 409,
      });
      expect(calls).toBe(1);
      expect(sourceAccess(h.db, right, owner, principal, now)).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("does not cache observation rows across calls", () => {
    const { h, owner, pairs } = fixture(1);
    try {
      expect(check(h, pairs.flat(), owner)).toEqual({ status: "available" });
      const body = pairs[0]![1]!;
      h.db.query("UPDATE qq_observation_text SET body=? WHERE event_key=?").run("changed", body.id);
      expect(check(h, pairs.flat(), owner)).toEqual({
        status: "error",
        code: "CONTEXT_SOURCE_INVALID",
        message: "source invalid",
        statusCode: 409,
      });
    } finally {
      h.close();
    }
  });

  it("checks each duplicate observation id against its own revision and expiry cap", () => {
    const { h, owner, pairs } = fixture(1);
    try {
      const body = pairs[0]![1]!;
      const invalid = {
        status: "error",
        code: "CONTEXT_SOURCE_INVALID",
        message: "source invalid",
        statusCode: 409,
      };
      expect(check(h, [body, { ...body }], owner)).toEqual({ status: "available" });
      for (const bad of [
        { ...body, revision: "stale" },
        { ...body, expiresAt: "2000-01-01T00:00:00.000Z" },
      ]) {
        expect(sourceAccess(h.db, bad, owner, principal, now)).not.toBe("available");
        expect(check(h, [body, bad], owner)).toEqual(invalid);
        expect(check(h, [bad, body], owner)).toEqual(invalid);
      }
    } finally {
      h.close();
    }
  });

  it("keeps expired, stale and wrong-owner outcomes and errors when ordering changes", () => {
    const { h, owner, pairs } = fixture(2);
    try {
      const expired = { ...pairs[0]![0]!, expiresAt: "2000-01-01T00:00:00.000Z" };
      const stale = { ...pairs[0]![0]!, revision: "stale" };
      const wrongOwner = { ...owner, id: "other-conversation" };
      expect(sourceAccess(h.db, expired, owner, principal, now)).toBe("expired");
      expect(sourceAccess(h.db, expired, wrongOwner, principal, now)).toBe("revoked");
      expect(sourceAccess(h.db, stale, owner, principal, now)).toBe("revoked");
      const invalid = {
        status: "error",
        code: "CONTEXT_SOURCE_INVALID",
        message: "source invalid",
        statusCode: 409,
      };
      for (const first of [expired, stale]) {
        const modified = [[first, pairs[0]![1]!], pairs[1]!];
        expect(check(h, modified.flat(), owner)).toEqual(invalid);
        expect(check(h, grouped(modified), owner)).toEqual(invalid);
      }
      expect(check(h, pairs.flat(), wrongOwner)).toEqual(invalid);
      expect(check(h, grouped(pairs), wrongOwner)).toEqual(invalid);
    } finally {
      h.close();
    }
  });
});
