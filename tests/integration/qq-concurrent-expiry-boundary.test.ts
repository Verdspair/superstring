import { describe, expect, it } from "bun:test";
import { readConcurrentReplyJobs } from "../../src/server/channels/onebot11/concurrent-reply-context";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { cloneBusinessDb } from "../harness/business-db";

const NOW = "2026-10-16T00:00:00.000Z";
function projection(expiry: string, running = false) {
  const h = cloneBusinessDb();
  try {
    ensureDefaults(h.orm, "expiry-model");
    h.db
      .query(
        "INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,created_at,updated_at) VALUES('expiry-conversation','onebot11','shared','expiry-binding',?,?,1,?,?)",
      )
      .run(DEFAULT_AGENT_ID, DEFAULT_USER_ID, NOW, NOW);
    h.db
      .query(`INSERT INTO qq_conversation_tasks(id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,source_from_seq,source_through_seq,status,source_expires_at,lease_expires_at,lease_token,platform_message_id,created_at,updated_at)
      VALUES('expiry-task','expiry-key','expiry-conversation',1,?,'mention','direct_reply',1,1,?,?,?,?, 'expiry-message',?,?)`)
      .run(
        DEFAULT_AGENT_ID,
        running ? "running" : "pending",
        running ? null : expiry,
        running ? expiry : null,
        running ? "expiry-lease" : null,
        NOW,
        NOW,
      );
    return readConcurrentReplyJobs(h.db, {
      conversationId: "expiry-conversation",
      bindingEpoch: 1,
      agentId: DEFAULT_AGENT_ID,
      now: NOW,
      visibleEventKeys: new Set<string>(),
    });
  } finally {
    h.close();
  }
}
describe("concurrent responsibility expiry instant", () => {
  for (const expiry of [
    "2026-10-16T00:00:00.000000Z",
    "2026-10-16T00:00:00Z",
    "2026-10-16T08:00:00+08:00",
  ]) {
    it(`excludes equal source expiry ${expiry}`, () => {
      expect(projection(expiry).jobs).toHaveLength(0);
    });
    it(`excludes equal running lease expiry ${expiry}`, () => {
      expect(projection(expiry, true).jobs).toHaveLength(0);
    });
  }
  it("retains responsibility one millisecond before a six-digit expiry", () => {
    expect(projection("2026-10-16T00:00:00.001000Z").jobs).toHaveLength(1);
  });
  it("retains a future instant expressed with a negative UTC offset", () => {
    expect(projection("2026-10-15T20:00:01-04:00").jobs).toHaveLength(1);
  });
});
