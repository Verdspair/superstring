import { afterEach, describe, expect, it } from "bun:test";
import { projectQqMessageFacts } from "../../src/server/channels/onebot11/message-projection";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { qqConversationScopeOfBinding } from "../../src/server/services/qq-binding-contract";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(closeHarnesses);

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
});
