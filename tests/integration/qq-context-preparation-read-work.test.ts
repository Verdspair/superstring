import { afterEach, describe, expect, it } from "bun:test";
import { projectQqMessageFacts } from "../../src/server/channels/onebot11/message-projection";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { qqConversationScopeOfBinding } from "../../src/server/services/qq-binding-contract";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(closeHarnesses);

function eventMetadataReads(h: ReturnType<typeof createOneBotHarness>) {
  const query = h.db.query;
  const prepare = h.db.prepare;
  const wrapped = new WeakSet<object>();
  const calls: { sql: string; args: string[] }[] = [];
  const trace = (sql: string, statement: ReturnType<typeof h.db.query>) => {
    if (
      wrapped.has(statement) ||
      !/^\s*select\b/i.test(sql) ||
      !/\b(?:from|join)\s+["`]?qq_events["`]?\b/i.test(sql) ||
      !/speaker_kind/i.test(sql) ||
      !/message_id/i.test(sql) ||
      /qq_message_facts/i.test(sql)
    )
      return statement;
    const proxy = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "values" || key === "all")
          return (...args: string[]) => {
            calls.push({ sql, args });
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    wrapped.add(proxy);
    return proxy;
  };
  h.db.query = ((sql: string, ...args: unknown[]) =>
    trace(sql, Reflect.apply(query, h.db, [sql, ...args]))) as typeof h.db.query;
  h.db.prepare = ((sql: string, ...args: unknown[]) =>
    trace(sql, Reflect.apply(prepare, h.db, [sql, ...args]))) as typeof h.db.prepare;
  return {
    calls,
    reset: () => {
      calls.length = 0;
    },
    restore: () => {
      h.db.query = query;
      h.db.prepare = prepare;
    },
  };
}

describe("selected QQ fact projection read work", () => {
  it("does not perform another fact-table read for every selected event", () => {
    const h = createOneBotHarness();
    for (let index = 1; index <= 32; index++) {
      h.receive({
        id: String(80000 + index),
        text: `synthetic selected fact ${index}`,
        speaker: "20002",
      });
    }
    const binding = readQqBinding(h.orm, h.bindingId);
    const conversation = h.journal.get(h.conversationId);
    if (!binding || !conversation) throw new Error("synthetic scope missing");
    const scope = qqConversationScopeOfBinding({
      conversationId: h.conversationId,
      binding,
      bindingEpoch: conversation.bindingEpoch,
    });
    const keys = (
      h.db
        .query(
          "SELECT event_key FROM qq_events WHERE account_id=? AND peer_id=? ORDER BY message_id",
        )
        .all(binding.accountId, binding.peerId) as { event_key: string }[]
    ).map((row) => row.event_key);
    expect(keys).toHaveLength(32);
    const query = h.db.query;
    let factReads = 0;
    h.db.query = ((sql: string, ...args: unknown[]) => {
      if (/\b(?:from|join)\s+["`]?qq_message_facts["`]?\b/i.test(sql)) factReads++;
      return Reflect.apply(query, h.db, [sql, ...args]);
    }) as typeof h.db.query;
    try {
      const small = projectQqMessageFacts(h, scope, keys.slice(0, 1), h.now());
      expect(small).toHaveLength(1);
      const smallReads = factReads;
      factReads = 0;
      const large = projectQqMessageFacts(h, scope, keys, h.now());
      expect(large.map((fact) => fact.id)).toEqual(keys);
      expect(large[0]).toEqual(small[0]);
      expect(factReads).toBeLessThanOrEqual(smallReads);
      factReads = 0;
      const denied = projectQqMessageFacts(
        h,
        { ...scope, bindingEpoch: scope.bindingEpoch + 1 },
        keys,
        h.now(),
      );
      expect(denied).toEqual([]);
      expect(factReads).toBe(0);
    } finally {
      h.db.query = query;
    }
  });

  it("drives event metadata reads from requested keys instead of unrelated peer history", () => {
    const h = createOneBotHarness();
    for (let index = 1; index <= 400; index++)
      h.receive({ id: String(90000 + index), text: `selected ${index}`, speaker: "20002" });
    const binding = readQqBinding(h.orm, h.bindingId);
    const conversation = h.journal.get(h.conversationId);
    if (!binding || !conversation) throw new Error("synthetic scope missing");
    const scope = qqConversationScopeOfBinding({
      conversationId: h.conversationId,
      binding,
      bindingEpoch: conversation.bindingEpoch,
    });
    const keys = (
      h.db
        .query(
          "SELECT event_key FROM qq_events WHERE account_id=? AND peer_id=? ORDER BY message_id",
        )
        .all(binding.accountId, binding.peerId) as { event_key: string }[]
    ).map((row) => row.event_key);
    expect(keys).toHaveLength(400);
    const first = keys[0];
    const third = keys[2];
    if (!first || !third) throw new Error("selected event keys missing");
    const unrelated = h.db.query(`INSERT INTO qq_events
      (event_key,account_id,conversation_kind,peer_id,agent_id,message_id,
       occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed)
      SELECT ?,account_id,conversation_kind,?,agent_id,?,
        occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed
      FROM qq_events WHERE event_key=?`);
    for (let index = 0; index < 256; index++)
      unrelated.run(`unrelated-${index}`, String(40000 + (index % 4)), String(index), first);
    const reads = eventMetadataReads(h);
    try {
      for (const size of [1, 32, 400]) {
        reads.reset();
        const requested = keys.slice(0, size);
        expect(projectQqMessageFacts(h, scope, requested, h.now()).map((fact) => fact.id)).toEqual(
          requested,
        );
        expect(reads.calls).toHaveLength(1);
        const call = reads.calls[0];
        if (!call) throw new Error("event metadata query missing");
        const plan = h.db.query(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args) as {
          detail: string;
        }[];
        const eventReads = plan.filter((row) =>
          /\b(?:SCAN|SEARCH) (?:e|qq_events)\b/.test(row.detail),
        );
        expect(eventReads).toHaveLength(1);
        const eventRead = eventReads[0];
        if (!eventRead) throw new Error("event lookup plan missing");
        expect(
          eventReads.every((row) =>
            /\bSEARCH (?:e|qq_events)\b.*\(event_key=\?\)/.test(row.detail),
          ),
        ).toBe(true);
        const requestedScan = plan.findIndex((row) => /VIRTUAL TABLE/.test(row.detail));
        if (requestedScan >= 0) expect(plan.indexOf(eventRead)).toBeGreaterThan(requestedScan);
      }
      const mixed = [third, "missing-key", first, third, "unrelated-0"];
      expect(projectQqMessageFacts(h, scope, mixed, h.now()).map((fact) => fact.id)).toEqual([
        third,
        first,
        third,
      ]);
      for (const requested of [[], keys]) {
        reads.reset();
        expect(
          projectQqMessageFacts(
            h,
            requested.length ? { ...scope, bindingEpoch: scope.bindingEpoch + 1 } : scope,
            requested,
            h.now(),
          ),
        ).toEqual([]);
        expect(reads.calls).toHaveLength(0);
      }
    } finally {
      reads.restore();
    }
  });
});
