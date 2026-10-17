import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { projectConversationEvent } from "../../src/server/conversation/conversation-view";
import type { ConversationEvent } from "../../src/shared/contracts/conversation";

const at = "2026-01-01T00:00:00.000Z";
function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,binding_epoch INTEGER,agent_id TEXT,source_id TEXT);
    INSERT INTO conversations VALUES('c',1,'a','binding');
    CREATE TABLE agent_runs(run_id TEXT PRIMARY KEY,conversation_id TEXT,owner_kind TEXT,owner_id TEXT,
      agent_id TEXT,wake_id TEXT,spec_id TEXT,spec_version TEXT,observed_seq INTEGER,started_at TEXT);
    CREATE INDEX ix_run_scope ON agent_runs(conversation_id,agent_id);
    CREATE TABLE wake_signals(id TEXT PRIMARY KEY,conversation_id TEXT,transferred_task_id TEXT,
      cause TEXT,status TEXT,ready_at TEXT,error_code TEXT,through_seq INTEGER);
    INSERT INTO wake_signals VALUES('w','c','task','chiming_in','completed','${at}',NULL,7);
    CREATE TABLE qq_conversation_tasks(id TEXT PRIMARY KEY,conversation_id TEXT,binding_epoch INTEGER,
      agent_id TEXT,status TEXT,error_code TEXT,origin_run_id TEXT,origin_wake_id TEXT,cause TEXT,source_through_seq INTEGER);
    INSERT INTO qq_conversation_tasks VALUES('task','c',1,'a','completed',NULL,'origin','w','chiming_in',7);`);
  const add = (
    id: string,
    overrides: Partial<{
      conversation: string;
      ownerKind: string;
      owner: string;
      agent: string | null;
      wake: string | null;
      spec: string;
      version: string;
      observed: number;
      started: string;
    }> = {},
  ) => {
    const row = {
      conversation: "c",
      ownerKind: "conversation",
      owner: "c",
      agent: "a",
      wake: "w",
      spec: "onebot.initiative.batch",
      version: "1",
      observed: 7,
      started: at,
      ...overrides,
    };
    db.query("INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      id,
      row.conversation,
      row.ownerKind,
      row.owner,
      row.agent,
      row.wake,
      row.spec,
      row.version,
      row.observed,
      row.started,
    );
  };
  const event: ConversationEvent = {
    conversationId: "c",
    seq: 7,
    eventKey: "wake:w",
    kind: "wake",
    source: { kind: "wake", id: "w", revision: "1" },
    sources: [],
    occurredAt: at,
    recordedAt: at,
    participant: null,
    addressing: { reasons: [], mentionIds: [] },
    runId: null,
    outputId: null,
  };
  return { db, add, event };
}
const oldParent = `SELECT run_id FROM agent_runs WHERE conversation_id=? AND owner_kind='conversation'
  AND owner_id=? AND agent_id=? AND wake_id IS ? AND spec_id=? AND spec_version=?
  AND observed_seq=? ORDER BY rowid DESC LIMIT 1`;
const args = ["c", "c", "a", "w", "onebot.initiative.batch", "1", 7] as const;

describe("conversation parent attempt rowid bound", () => {
  it("keeps the latest matching insertion, excludes every mismatched scope, and seeks the origin bound", () => {
    const { db, add, event } = fixture();
    try {
      add("early", { started: "2099-01-01" });
      for (let i = 0; i < 200; i++) add(`old-unrelated-${i}`, { owner: "unrelated" });
      add("origin", { started: "2098-01-01" });
      const origin = db
        .query("SELECT rowid AS rowId FROM agent_runs WHERE run_id='origin'")
        .get() as { rowId: number };
      add("latest", { started: "2000-01-01" });
      const exclusions = [
        { conversation: "other" },
        { ownerKind: "memory_job" },
        { owner: "other" },
        { agent: "other" },
        { agent: null },
        { wake: "other" },
        { wake: null },
        { spec: "other" },
        { version: "2" },
        { observed: 8 },
      ];
      exclusions.forEach((scope, i) => {
        add(`excluded-${i}`, scope);
      });
      const querySpy = spyOn(db, "query");
      const projected = projectConversationEvent(db, event, at);
      const parentSql = querySpy.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes("NOT INDEXED"));
      querySpy.mockRestore();
      expect(projected.runId).toBe("latest");
      expect(db.query(oldParent).get(...args)).toEqual({ run_id: projected.runId });
      expect(parentSql).toBeDefined();
      const plan = db.query(`EXPLAIN QUERY PLAN ${parentSql!}`).all(origin.rowId, ...args) as {
        detail: string;
      }[];
      expect(
        plan.some((row) =>
          /SEARCH agent_runs USING INTEGER PRIMARY KEY \(rowid>\?\)/.test(row.detail),
        ),
      ).toBe(true);
      const broad = db
        .query(
          "EXPLAIN QUERY PLAN SELECT run_id FROM agent_runs NOT INDEXED ORDER BY rowid DESC LIMIT 1",
        )
        .all() as { detail: string }[];
      expect(broad.some((row) => row.detail.includes("SCAN agent_runs"))).toBe(true);
      db.query("DELETE FROM agent_runs WHERE run_id='latest'").run();
      expect(projectConversationEvent(db, event, at).runId).toBe("origin");
      expect(db.query(oldParent).get(...args)).toEqual({ run_id: "origin" });
    } finally {
      db.close();
    }
  });

  it("keeps NULL-agent origin fallback and rejects stale origins and rebound task scope", () => {
    const { db, add, event } = fixture();
    try {
      add("origin", { agent: null });
      add("later");
      expect(projectConversationEvent(db, event, at).runId).toBe("origin");
      db.query("UPDATE agent_runs SET agent_id='other' WHERE run_id='origin'").run();
      expect(projectConversationEvent(db, event, at).runId).toBeNull();
      db.query("UPDATE agent_runs SET agent_id='a' WHERE run_id='origin'").run();
      expect(projectConversationEvent(db, event, at).runId).toBe("later");
      db.query("UPDATE conversations SET binding_epoch=2").run();
      expect(projectConversationEvent(db, event, at).task).toBeUndefined();
      db.query("UPDATE conversations SET binding_epoch=1,agent_id='other'").run();
      expect(projectConversationEvent(db, event, at).task).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
