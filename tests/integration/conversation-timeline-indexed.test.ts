import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import type { BotEvidenceScope } from "../../src/server/modules/conversation-evidence";
import { inTimeline } from "../../src/server/modules/conversation-evidence-store";

it("preserves direct, nested, alias and confirmed-send timeline ownership on indexed reads", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE conversation_events(conversation_id TEXT,seq INTEGER,kind TEXT,source_kind TEXT,source_id TEXT,source_revision TEXT,sources TEXT,PRIMARY KEY(conversation_id,seq),UNIQUE(conversation_id,source_kind,source_id,source_revision));
    CREATE INDEX ix_conversation_events_source ON conversation_events(source_kind,source_id);
    CREATE TABLE qq_send_log(id TEXT PRIMARY KEY,outcome TEXT);`);
  const scope: BotEvidenceScope = {
    channel: "onebot11",
    conversationId: "c",
    agentId: "a",
    bindingId: "b",
    bindingEpoch: 1,
    authorityRevision: 1,
    accountId: "1",
    conversationKind: "group",
    peerId: "2",
  };
  try {
    const add = db.query("INSERT INTO conversation_events VALUES('c',?,?,?,?,'1',?)");
    db.transaction(() => {
      for (let i = 1; i <= 5000; i++) add.run(i, "inbound", "qq_event", `event-${i}`, "[]");
    })();
    add.run(
      5001,
      "inbound",
      "qq_event",
      "parent",
      JSON.stringify([{ kind: "qq_media", id: "media", revision: "1" }]),
    );
    add.run(5002, "delivery", "qq_event", "not-inbound", "[]");
    add.run(5003, "outbound", "qq_send", "sent", "[]");
    add.run(
      5004,
      "outbound",
      "qq_send",
      "unknown",
      JSON.stringify([{ kind: "qq_media", id: "blocked-media", revision: "1" }]),
    );
    db.query("INSERT INTO qq_send_log VALUES('sent','sent'),('unknown','unknown')").run();
    expect(inTimeline(db, scope, "qq_event", "event-5000")).toBe(true);
    expect(inTimeline(db, scope, "qq_observation", "event-5000")).toBe(true);
    expect(inTimeline(db, scope, "qq_media", "media")).toBe(true);
    expect(inTimeline(db, scope, "qq_event", "not-inbound")).toBe(false);
    expect(inTimeline(db, scope, "qq_send", "sent")).toBe(true);
    expect(inTimeline(db, scope, "qq_send", "unknown")).toBe(false);
    expect(inTimeline(db, scope, "qq_media", "blocked-media")).toBe(false);
    expect(inTimeline(db, { ...scope, conversationId: "foreign" }, "qq_event", "event-5000")).toBe(
      false,
    );
  } finally {
    db.close();
  }
});
