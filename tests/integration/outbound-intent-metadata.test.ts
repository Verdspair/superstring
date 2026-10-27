import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { cloneBusinessDb } from "../harness/business-db";

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const NOW = "2030-06-01T00:00:00.000Z";
const EXPIRY = "2099-01-01T00:00:00.000Z";
const migration = readFileSync(
  new URL("../../migrations/versions/0072_outbound_intent_metadata.sql", import.meta.url),
  "utf8",
);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "fixture");
  h.db
    .query(`INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,created_at,updated_at)
    VALUES('metadata-conversation','onebot11','shared','binding',?,?,1,?,?)`)
    .run(DEFAULT_AGENT_ID, DEFAULT_USER_ID, NOW, NOW);
  new AgentRunRepository(h.db).createRun({
    runId: "metadata-run",
    specId: "fixture",
    specVersion: "1",
    owner: {
      kind: "conversation",
      id: "metadata-conversation",
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
    },
    at: NOW,
  });
  return h;
}
function insert(h: ReturnType<typeof fixture>, id: string, target: unknown) {
  h.db
    .query(`INSERT INTO outbound_intents(id,run_id,conversation_id,output_ordinal,target,speech_kind,source_through_seq,
    deliver_by,status,created_at,expires_at) VALUES(?,'metadata-run','metadata-conversation',?,?,'direct_reply',7,?,'planned',?,?)`)
    .run(id, Number(id.replace(/\D/g, "")) || 0, JSON.stringify(target), EXPIRY, NOW, EXPIRY);
}
const fields = [
  ["qq_task_id", "qqTaskId"],
  ["account_id", "accountId"],
  ["conversation_kind", "conversationKind"],
  ["peer_id", "peerId"],
  ["participant_id", "participantId"],
  ["binding_id", "bindingId"],
  ["binding_epoch", "bindingEpoch"],
  ["agent_id", "agentId"],
  ["authority_revision", "authorityRevision"],
  ["observed_through_seq", "observedThroughSeq"],
] as const;
function assertExact(h: ReturnType<typeof fixture>) {
  for (const [column, key] of fields) {
    const row = h.db
      .query(`SELECT COUNT(*) AS mismatches FROM outbound_intents i
      JOIN outbound_intent_metadata m ON m.intent_id=i.id
      WHERE typeof(m.${column})<>typeof(json_extract(i.target,'$.${key}'))
        OR m.${column} IS NOT json_extract(i.target,'$.${key}')`)
      .get();
    expect(row).toEqual({ mismatches: 0 });
  }
  expect(h.db.query("SELECT COUNT(*) AS n FROM outbound_intent_metadata").get()).toEqual(
    h.db.query("SELECT COUNT(*) AS n FROM outbound_intents").get(),
  );
}
it("backfills every legacy random ID with exact JSON storage types and leaves target bytes unchanged", () => {
  const h = fixture();
  h.db.exec(
    "DROP TRIGGER project_outbound_metadata_insert; DROP TRIGGER project_outbound_metadata_target_update; DROP TRIGGER project_outbound_metadata_fields_update; DROP TABLE outbound_intent_metadata",
  );
  for (const [index, value] of [
    undefined,
    null,
    "42",
    42,
    42.5,
    true,
    false,
    ["42"],
    { id: "42" },
  ].entries())
    insert(h, `random-${index + 1}`, {
      qqTaskId: value,
      participantId: value,
      bindingEpoch: value,
      source: ["synthetic"],
    });
  const before = h.db.query("SELECT id,target FROM outbound_intents ORDER BY id").all() as {
    id: string;
    target: string;
  }[];
  const hashes = before.map((row) => digest(row.target));
  h.db.exec(migration);
  assertExact(h);
  const after = h.db.query("SELECT id,target FROM outbound_intents ORDER BY id").all() as {
    id: string;
    target: string;
  }[];
  expect(after.map((row) => digest(row.target))).toEqual(hashes);
  expect(after).toEqual(before);
  expect(h.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("tracks parent updates, rollback and deletion through one derived projection", () => {
  const h = fixture();
  insert(h, "random-1", {
    qqTaskId: "task",
    participantId: "member",
    sources: Array(100).fill({ kind: "fixture", id: "1", revision: "1" }),
  });
  const before = h.db.query("SELECT * FROM outbound_intent_metadata").all();
  h.db.exec("BEGIN");
  h.db
    .query(
      "UPDATE outbound_intents SET target=?,status='confirmed',source_through_seq=9,expires_at=? WHERE id='random-1'",
    )
    .run(JSON.stringify({ qqTaskId: 33, participantId: null }), "2098-01-01T00:00:00.000Z");
  assertExact(h);
  expect(
    h.db
      .query(
        "SELECT status,source_through_seq FROM outbound_intent_metadata WHERE intent_id='random-1'",
      )
      .get(),
  ).toEqual({ status: "confirmed", source_through_seq: 9 });
  h.db.exec("ROLLBACK");
  expect(h.db.query("SELECT * FROM outbound_intent_metadata").all()).toEqual(before);
  h.db.query("DELETE FROM outbound_intents WHERE id='random-1'").run();
  expect(h.db.query("SELECT COUNT(*) AS n FROM outbound_intent_metadata").get()).toEqual({ n: 0 });
});
it("keeps idempotent planned replacement metadata tied to the persisted target, not a discarded input", () => {
  const h = fixture();
  const repo = new OutboundIntentRepository(h.db);
  const target = {
    accountId: "100",
    conversationKind: "group" as const,
    peerId: "200",
    agentId: DEFAULT_AGENT_ID,
    bindingId: "binding",
    bindingEpoch: 1,
    qqTaskId: "original-task",
  };
  const input = {
    id: "logical",
    runId: "metadata-run",
    conversationId: "metadata-conversation",
    ordinal: 0,
    target,
    speechKind: "direct_reply" as const,
    sourceThroughSeq: 7,
    deliverBy: EXPIRY,
    createdAt: NOW,
    expiresAt: EXPIRY,
    parts: [{ kind: "text" as const, text: "first" }],
  };
  repo.commit(input);
  new AgentRunRepository(h.db).createRun({
    runId: "metadata-run-next",
    specId: "fixture",
    specVersion: "1",
    owner: { kind: "conversation", id: "metadata-conversation", userId: DEFAULT_USER_ID },
    at: NOW,
  });
  repo.commit({
    ...input,
    runId: "metadata-run-next",
    target: { ...target, qqTaskId: "discarded-task" },
    createdAt: "2030-06-02T00:00:00.000Z",
  });
  expect(
    h.db
      .query(
        "SELECT run_id,qq_task_id,created_at FROM outbound_intent_metadata WHERE intent_id='logical'",
      )
      .get(),
  ).toEqual({
    run_id: "metadata-run-next",
    qq_task_id: "original-task",
    created_at: "2030-06-02T00:00:00.000Z",
  });
  assertExact(h);
});

function recoveryDelivery(h: ReturnType<typeof fixture>, repository: OutboundIntentRepository) {
  return new OutboundDelivery({
    orm: h.orm,
    repository,
    journal: new ConversationEventRepository(h.db),
    port: {
      async send() {
        throw new Error("recovery must not send");
      },
    },
    stickerFile: () => null,
    authorize: () => true,
    now: () => NOW,
  });
}
it("does not load any full targets when a thousand terminal deliveries are already projected", () => {
  const h = fixture();
  h.db.transaction(() => {
    for (let n = 1; n <= 1000; n++) {
      insert(h, `history-${n}`, {
        sources: [{ kind: "fixture", id: "source", revision: "1" }],
        padding: "x".repeat(4096),
      });
      h.db
        .query("UPDATE outbound_intents SET status='confirmed',legacy_send_id=? WHERE id=?")
        .run(`send-${n}`, `history-${n}`);
    }
  })();
  const repository = new OutboundIntentRepository(h.db);
  const original = h.db.query;
  let fullTargets = 0;
  h.db.query = ((sql: string) => {
    if (sql.includes("SELECT * FROM outbound_intents")) fullTargets++;
    return original.call(h.db, sql);
  }) as typeof original;
  try {
    expect(recoveryDelivery(h, repository).recover()).toBe(0);
    expect(fullTargets).toBe(0);
    expect(h.db.query("SELECT COUNT(*) AS n FROM conversation_events").get()).toEqual({ n: 0 });
  } finally {
    h.db.query = original;
  }
});
it("recovers only missing legacy receipts and retains revisions for unattempted terminal rows", () => {
  const h = fixture();
  const target = {
    accountId: "100",
    conversationKind: "group",
    peerId: "200",
    agentId: DEFAULT_AGENT_ID,
    bindingId: "binding",
    bindingEpoch: 1,
  };
  insert(h, "missing-1", target);
  insert(h, "unattempted-2", target);
  insert(h, "pending-3", target);
  h.db.query("UPDATE outbound_intents SET status='confirmed' WHERE id='missing-1'").run();
  h.db.query("UPDATE outbound_intents SET status='stale' WHERE id='unattempted-2'").run();
  h.db
    .query(`INSERT INTO outbound_parts(id,intent_id,ordinal,kind,payload,status,platform_message_id,attempted_at,finished_at)
    VALUES('part','missing-1',0,'text',?,'confirmed','platform',?,?)`)
    .run(JSON.stringify({ text: "recovered text", mentions: [] }), NOW, NOW);
  h.db
    .query(`INSERT INTO outbound_parts(id,intent_id,ordinal,kind,payload,status)
    VALUES('unattempted-part','unattempted-2',0,'text',?,'stale')`)
    .run(JSON.stringify({ text: "not sent", mentions: [] }));
  const repository = new OutboundIntentRepository(h.db);
  const delivery = recoveryDelivery(h, repository);
  expect(repository.legacyProjectionCandidates()).toEqual([
    { id: "missing-1", attempted: 1 },
    { id: "unattempted-2", attempted: 0 },
  ]);
  expect(delivery.recover()).toBe(0);
  const projected = repository.row("missing-1")!;
  expect(projected.legacy_send_id).toBeTruthy();
  expect(repository.row("unattempted-2")!.legacy_send_id).toBeNull();
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_send_log").get()).toEqual({ n: 1 });
  const revisions = h.db
    .query("SELECT event_key FROM conversation_events WHERE kind='delivery' ORDER BY event_key")
    .all();
  expect(revisions).toHaveLength(2);
  delivery.recover();
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_send_log").get()).toEqual({ n: 1 });
  expect(
    h.db
      .query("SELECT event_key FROM conversation_events WHERE kind='delivery' ORDER BY event_key")
      .all(),
  ).toEqual(revisions);
});
it("expires payloads by compact authoritative expiry without touching future payloads", () => {
  const h = fixture();
  insert(h, "expired-1", {});
  insert(h, "future-2", {});
  h.db
    .query(
      "UPDATE outbound_intents SET expires_at='2029-01-01T00:00:00.000Z',status='confirmed' WHERE id='expired-1'",
    )
    .run();
  h.db.query("UPDATE outbound_intents SET status='confirmed' WHERE id='future-2'").run();
  for (const id of ["expired-1", "future-2"])
    h.db
      .query(
        "INSERT INTO outbound_parts(id,intent_id,ordinal,kind,payload,status) VALUES(?,?,0,'text',?,'confirmed')",
      )
      .run(`part-${id}`, id, JSON.stringify({ text: id, mentions: [] }));
  const repository = new OutboundIntentRepository(h.db);
  expect(repository.purgeExpired(NOW)).toBe(1);
  expect(repository.parts("expired-1")[0]?.payload).toBeNull();
  expect(repository.parts("future-2")[0]?.payload).not.toBeNull();
  expect(repository.purgeExpired(NOW)).toBe(0);
});

it("selects partial speech candidates from compact metadata without loading wide targets", () => {
  const h = fixture();
  const repository = new OutboundIntentRepository(h.db);
  const wideTarget = (qqTaskId: string) => ({
    accountId: "100",
    conversationKind: "group" as const,
    peerId: "200",
    agentId: DEFAULT_AGENT_ID,
    bindingId: "binding",
    bindingEpoch: 1,
    qqTaskId,
    padding: "x".repeat(32_768),
  });
  const commit = (
    id: string,
    ordinal: number,
    parts: Array<{ text: string }>,
    expiresAt: string = EXPIRY,
  ) =>
    repository.commit({
      id,
      runId: "metadata-run",
      conversationId: "metadata-conversation",
      ordinal,
      target: wideTarget(id),
      speechKind: "direct_reply",
      sourceThroughSeq: 7,
      deliverBy: expiresAt,
      createdAt: NOW,
      expiresAt,
      parts: parts.map((part) => ({ kind: "text" as const, ...part })),
    });
  const receipt = (
    id: string,
    status: "confirmed" | "unknown" | "failed",
    at: string,
    messageId?: string,
  ) => {
    const part = repository.claimPart(id, at);
    expect(part).not.toBeNull();
    if (!part) throw new Error("partial speech part missing");
    if (status === "confirmed" && !messageId) throw new Error("confirmed message id missing");
    repository.settlePart(
      part.part.id,
      status === "confirmed" ? { status, messageId } : { status },
      at,
    );
  };

  commit("partial-1", 1, [{ text: "partial words" }, { text: "unsettled revision" }]);
  commit("unknown-2", 2, [{ text: "unknown words" }]);
  commit("confirmed-3", 3, [{ text: "already complete" }]);
  commit("expired-4", 4, [{ text: "expired words" }], "2029-01-01T00:00:00.000Z");
  commit("revision-5", 5, [{ text: "revision words" }, { text: "failed revision" }]);

  receipt("partial-1", "confirmed", "2030-06-01T00:00:10.000Z", "platform-partial");
  receipt("partial-1", "unknown", "2030-06-01T00:00:11.000Z");
  receipt("unknown-2", "unknown", "2030-06-01T00:00:20.000Z");
  receipt("confirmed-3", "confirmed", "2030-06-01T00:00:30.000Z", "platform-confirmed");
  receipt("expired-4", "confirmed", "2028-06-01T00:00:40.000Z", "platform-expired");
  receipt("revision-5", "confirmed", "2030-06-01T00:00:50.000Z", "platform-revision");
  receipt("revision-5", "failed", "2030-06-01T00:00:51.000Z");

  // Keep a real partially settled row after the receipt sequence.
  const residualPart = h.db
    .query("SELECT id FROM outbound_parts WHERE intent_id=? AND ordinal=1")
    .get("partial-1") as { id: string };
  h.db.query("UPDATE outbound_parts SET status='planned' WHERE id=?").run(residualPart.id);
  h.db.query("UPDATE outbound_intents SET status='delivering' WHERE id='partial-1'").run();

  const original = h.db.query;
  const observed: string[] = [];
  h.db.query = ((sql: string) => {
    observed.push(sql);
    return original.call(h.db, sql);
  }) as typeof original;
  let result: ReturnType<OutboundIntentRepository["partialSpeechSince"]>;
  try {
    result = repository.partialSpeechSince("metadata-conversation", {
      sinceSeconds: Math.floor(Date.parse("2030-06-01T00:00:00.000Z") / 1000),
      limit: 2,
      at: NOW,
    });
  } finally {
    h.db.query = original;
  }

  const candidate = observed.find(
    (sql) =>
      /SELECT[\s\S]*\bexpires_at\b/i.test(sql) &&
      /FROM\s+outbound_(?:intents|intent_metadata)/i.test(sql),
  );
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("partial speech candidate query missing");
  const plan = h.db
    .query(`EXPLAIN QUERY PLAN ${candidate}`)
    .all("metadata-conversation", NOW) as Array<{ detail: string }>;
  expect(plan.some((row) => /outbound_intent_metadata/i.test(row.detail))).toBe(true);
  expect(plan.some((row) => /outbound_intents\b/i.test(row.detail))).toBe(false);

  expect(result).toHaveLength(2);
  expect(result.map((entry) => entry.sources[0]?.id)).toEqual(["revision-5", "partial-1"]);
  expect(result.map((entry) => entry.text)).toEqual(["revision words", "partial words"]);
  expect(result.every((entry) => entry.occurredAtSeconds > 0)).toBe(true);
  expect(result[0]?.sources).toEqual([
    {
      kind: "outbound_intent",
      id: "revision-5",
      revision: digest("revision words"),
      expiresAt: EXPIRY,
    },
  ]);
  expect(result[1]?.sources).toEqual([
    {
      kind: "outbound_intent",
      id: "partial-1",
      revision: digest("partial words"),
      expiresAt: EXPIRY,
    },
  ]);
  expect(
    repository
      .partialSpeechSince("metadata-conversation", {
        sinceSeconds: Math.floor(Date.parse("2030-06-01T00:00:20.000Z") / 1000),
        limit: 10,
        at: NOW,
      })
      .map((entry) => entry.sources[0]?.id),
  ).toEqual(["revision-5"]);
});
