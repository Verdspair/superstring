import { afterEach, describe, expect, it } from "bun:test";
import { projectConversationEvent } from "../../src/server/conversation/conversation-view";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  prepareTurn,
  saveCompletedAssistantMessage,
  saveFailedAssistantMessage,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import {
  ConversationEventsSchema,
  ConversationEventViewSchema,
  ConversationListSchema,
  DeliverySchema,
} from "../../src/shared/contracts/conversation";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const at = "2026-09-26T01:00:00.000Z",
  later = "2026-09-26T02:00:00.000Z";
function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "model");
  const journal = new ConversationEventRepository(h.db);
  const wake = new WakeRepository(h.db);
  const outbox = new OutboundIntentRepository(h.db);
  const runs = new AgentRunRepository(h.db);
  const session = createSession(h.orm, "chat", { modelName: "model" });
  return { ...h, journal, wake, outbox, runs, session };
}
function bot(h: ReturnType<typeof setup>, id = "binding") {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(at, at);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'100','private','200',?,'scheme',?,?)",
    )
    .run(id, DEFAULT_AGENT_ID, at, at);
  return h.journal.ensureOneBot(id)!;
}
function incoming(h: ReturnType<typeof setup>, id: string, time: number) {
  h.db
    .query(
      "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed) VALUES(?,'100','private','200',?,?,?,'member','200',?,1)",
    )
    .run(id, DEFAULT_AGENT_ID, id, time, at);
  h.db
    .query("INSERT INTO qq_observation_text VALUES(?,?,?,?,?)")
    .run(id, `body ${id}`, time, later, at);
}
describe("canonical conversation source journal", () => {
  it("retains failed partial transcript and journals a same-ID retry as a new source revision", () => {
    const h = setup();
    const p = prepareTurn(h.orm, h.session.id, "question", "retry");
    saveFailedAssistantMessage(h.orm, h.session.id, "retry", "MODEL_ERROR", p.generationToken!, {
      partialContent: "partial",
    });
    h.journal.backfill();
    const c = h.journal.ensureWeb(h.session.id)!;
    const before = h.journal.eventsAfter(c.id);
    expect(before.items.map((e) => projectConversationEvent(h.db, e).text)).toEqual([
      "question",
      "partial",
    ]);
    expect(projectConversationEvent(h.db, before.items[1]!).messageStatus).toBe("failed");
    const retry = prepareTurn(h.orm, h.session.id, "question", "retry");
    saveCompletedAssistantMessage(h.orm, h.session.id, "full", "retry", retry.generationToken!);
    const revised = h.journal.ingestWebMessage(retry.messageId)!;
    expect(revised.source.id).toBe(before.items[1]!.source.id);
    expect(revised.seq).toBeGreaterThan(before.nextSeq);
    expect(projectConversationEvent(h.db, revised).text).toBe("full");
    expect(projectConversationEvent(h.db, before.items[1]!).contentState).toBe("unavailable");
  });

  it("journals a completed user message while its turn generation is still active", () => {
    const h = setup();
    const p = prepareTurn(h.orm, h.session.id, "accepted", "active");
    const user = h.db
      .query(
        "SELECT id FROM messages WHERE turn_id=(SELECT turn_id FROM messages WHERE id=?) AND role='user'",
      )
      .get(p.messageId) as { id: string };
    const event = h.journal.ingestWebMessage(user.id)!;
    expect(event).not.toBeNull();
    expect(projectConversationEvent(h.db, event).text).toBe("accepted");
    expect(h.journal.ingestWebMessage(p.messageId)).toBeNull();
  });

  it("allocates local monotonic seq for same-second/late sources and deduplicates only event identity", () => {
    const h = setup();
    const c = bot(h);
    incoming(h, "a", 100);
    incoming(h, "b", 100);
    incoming(h, "late", 90);
    expect(
      ["a", "b", "late", "a"].map((id) => h.journal.ingestOneBotEvent(id, "binding")!.seq),
    ).toEqual([1, 2, 3, 1]);
    expect(h.journal.get(c.id)!.lastSeq).toBe(3);
    expect(
      h.db
        .query("SELECT * FROM conversation_events")
        .all()
        .every((r) => !JSON.stringify(r).includes("body ")),
    ).toBe(true);
  });
  it("Web ingestion is idempotent and redaction cannot be bypassed by journal projection", () => {
    const h = setup();
    const p = prepareTurn(h.orm, h.session.id, "question", "req");
    saveCompletedAssistantMessage(h.orm, h.session.id, "answer", "req", p.generationToken!);
    h.journal.backfill();
    h.journal.backfill();
    const c = h.journal.ensureWeb(h.session.id, DEFAULT_USER_ID)!;
    expect(h.journal.ensureWeb(h.session.id, "other")).toBeNull();
    const page = h.journal.eventsAfter(c.id);
    expect(page.items.map((e) => projectConversationEvent(h.db, e).text)).toEqual([
      "question",
      "answer",
    ]);
    h.db.query("DELETE FROM messages WHERE id=?").run(page.items[0]!.source.id);
    expect(projectConversationEvent(h.db, page.items[0]!).contentState).toBe("revoked");
    expect(
      ConversationListSchema.safeParse(h.journal.list({ userId: DEFAULT_USER_ID })).success,
    ).toBe(true);
    expect(
      ConversationEventsSchema.safeParse({
        ...page,
        items: page.items.map((e) => projectConversationEvent(h.db, e)),
      }).success,
    ).toBe(true);
  });
  it("expiry removes live body while cursor still advances over retained identities", () => {
    const h = setup();
    const c = bot(h);
    incoming(h, "a", 100);
    h.journal.ingestOneBotEvent("a", "binding");
    const page = h.journal.eventsAfter(c.id);
    const view = projectConversationEvent(h.db, page.items[0]!, later);
    expect(view.text).toBeNull();
    expect(view.contentState).toBe("expired");
    expect(page.nextSeq).toBe(1);
  });
  it("new binding epochs do not inherit historical messages when A is rebound after B", () => {
    const h = setup();
    bot(h);
    incoming(h, "old", 100);
    h.journal.backfill();
    h.db
      .query(
        "INSERT INTO agents SELECT 'agent-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?",
      )
      .run(DEFAULT_AGENT_ID);
    h.db.query("UPDATE qq_bindings SET agent_id='agent-b' WHERE id='binding'").run();
    expect(h.journal.ensureOneBot("binding")!.bindingEpoch).toBe(2);
    h.db.query("UPDATE qq_bindings SET agent_id=? WHERE id='binding'").run(DEFAULT_AGENT_ID);
    const c = h.journal.ensureOneBot("binding")!;
    h.journal.backfill();
    expect(c.bindingEpoch).toBe(3);
    expect(h.journal.eventsAfter(c.id).items).toEqual([]);
  });
});
describe("durable wake and outbound transitions", () => {
  it("claims latest same-priority opportunity and only one lease per conversation", () => {
    const h = setup();
    const c = bot(h);
    for (let n = 1; n <= 2; n++)
      h.wake.enqueue({
        conversationId: c.id,
        cause: "message",
        throughSeq: n,
        dedupeKey: `${n}`,
        readyAt: at,
        priority: 10,
        at,
      });
    const w = h.wake.claim({ at, leaseMs: 1000, topology: "direct" })!;
    expect(w.throughSeq).toBe(2);
    expect(h.wake.claim({ at, leaseMs: 1000 })).toBeNull();
    h.wake.complete(w.id, w.leaseToken!, "no_output", 2, at);
    // Reading through sequence 2 does not silently resolve the other queued opportunity.
    expect(h.wake.claim({ at, leaseMs: 1000 })?.throughSeq).toBe(1);
  });
  it("failed wake retains retry and does not acknowledge source cursor", () => {
    const h = setup();
    const c = bot(h);
    h.wake.enqueue({
      conversationId: c.id,
      cause: "message",
      throughSeq: 0,
      dedupeKey: "once",
      readyAt: at,
      priority: 10,
    });
    const w = h.wake.claim({ at, leaseMs: 1000 })!;
    h.wake.fail(w.id, w.leaseToken!, {
      at,
      errorCode: "MODEL_FAILED",
      maxAttempts: 3,
      retryDelayMs: 100,
    });
    expect(h.wake.get(w.id)!.status).toBe("pending");
    expect(h.journal.get(c.id)!.consumedSeq).toBe(0);
    expect(h.wake.claim({ at, leaseMs: 1000 })).toBeNull();
  });
  it("projects the transferred task and its parent run instead of a newer completed child", () => {
    const h = setup();
    const c = bot(h);
    const queued = h.wake.enqueue({
      conversationId: c.id,
      cause: "idle_topic",
      throughSeq: 0,
      dedupeKey: "root-task-projection",
      readyAt: at,
      priority: 10,
    });
    const leased = h.wake.claim({ at, leaseMs: 1000 })!;
    const parentRunId = "root-task-parent-run";
    const childRunId = "root-task-evaluation-child";
    for (const [runId, specId] of [
      [parentRunId, "onebot.initiative.batch"],
      [childRunId, "onebot.initiative.evaluate_batch"],
    ]) {
      h.runs.createRun({
        runId,
        specId,
        specVersion: "1",
        owner: { kind: "conversation", id: c.id },
        at,
      });
      h.db
        .query("UPDATE agent_runs SET wake_id=?,conversation_id=? WHERE run_id=?")
        .run(leased.id, c.id, runId);
    }
    h.runs.setStatus(parentRunId, "failed", at, "AGENT_FAILED");
    h.runs.setStatus(childRunId, "completed", at);
    h.wake.complete(leased.id, leased.leaseToken!, "completed", 0, at);
    const taskId = "root-task-linked-failure";
    h.db
      .query(`INSERT INTO qq_conversation_tasks(
        id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,
        source_from_seq,source_through_seq,origin_wake_id,origin_run_id,status,
        judgement_done,cancellation_requested,created_at,updated_at,error_code
      ) VALUES(?,?,?,?,?,'ordinary','idle_topic',0,0,?,?,'failed',0,0,?,?,?)`)
      .run(
        taskId,
        "root-task-projection",
        c.id,
        c.bindingEpoch,
        DEFAULT_AGENT_ID,
        leased.id,
        parentRunId,
        at,
        at,
        "QQ_TASK_FAILED",
      );
    h.db.query("UPDATE wake_signals SET transferred_task_id=? WHERE id=?").run(taskId, leased.id);

    const event = h.journal.eventsAfter(c.id).items[0]!;
    const view = projectConversationEvent(h.db, event, at);
    expect(h.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(ConversationEventViewSchema.safeParse(view).success).toBe(true);
    expect(queued.status).toBe("pending");
    expect(h.wake.get(leased.id)!.status).toBe("completed");
    expect(view.runId).toBe(parentRunId);
    expect(view.task).toEqual({ id: taskId, status: "failed", errorCode: "QQ_TASK_FAILED" });
    expect(view.wake?.status).toBe("completed");
  });
  it("rejects a transferred task from another wake and conversation while retaining the legacy run", () => {
    const h = setup();
    const conversation = bot(h);
    h.db.query("UPDATE qq_bindings SET peer_id='201' WHERE id='binding'").run();
    const otherConversation = bot(h, "other-binding");
    const firstWake = h.wake.enqueue({
      conversationId: conversation.id,
      cause: "idle_topic",
      throughSeq: 0,
      dedupeKey: "first-conversation-wake",
      readyAt: at,
      priority: 10,
    });
    const firstLease = h.wake.claim({ at, leaseMs: 1000, wakeId: firstWake.id })!;
    const legacyRunId = "first-conversation-legacy-run";
    h.runs.createRun({
      runId: legacyRunId,
      specId: "onebot.initiative.batch",
      specVersion: "1",
      owner: { kind: "conversation", id: conversation.id },
      at,
    });
    h.db
      .query("UPDATE agent_runs SET wake_id=?,conversation_id=? WHERE run_id=?")
      .run(firstLease.id, conversation.id, legacyRunId);
    h.runs.setStatus(legacyRunId, "failed", at, "AGENT_FAILED");
    h.wake.complete(firstLease.id, firstLease.leaseToken!, "completed", 0, at);

    const otherWake = h.wake.enqueue({
      conversationId: otherConversation.id,
      cause: "idle_topic",
      throughSeq: 0,
      dedupeKey: "other-conversation-wake",
      readyAt: at,
      priority: 10,
    });
    const otherLease = h.wake.claim({ at, leaseMs: 1000, wakeId: otherWake.id })!;
    h.wake.complete(otherLease.id, otherLease.leaseToken!, "completed", 0, at);
    const foreignTaskId = "foreign-conversation-task";
    h.db
      .query(`INSERT INTO qq_conversation_tasks(
        id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,
        source_from_seq,source_through_seq,origin_wake_id,status,judgement_done,
        cancellation_requested,created_at,updated_at,error_code
      ) VALUES(?,?,?,?,?,'ordinary','idle_topic',0,0,?,'failed',0,0,?,?,?)`)
      .run(
        foreignTaskId,
        "foreign-task-key",
        otherConversation.id,
        otherConversation.bindingEpoch,
        DEFAULT_AGENT_ID,
        otherLease.id,
        at,
        at,
        "QQ_TASK_FAILED",
      );
    h.db
      .query("UPDATE wake_signals SET transferred_task_id=? WHERE id=?")
      .run(foreignTaskId, firstLease.id);

    const event = h.journal.eventsAfter(conversation.id).items[0]!;
    const view = projectConversationEvent(h.db, event, at);
    expect(h.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(view.task).toBeUndefined();
    expect(view.runId).toBe(legacyRunId);
    expect(view.wake?.status).toBe("completed");
  });
  it("persists before effect, fences simultaneous claims, and interrupted sending stays unknown", () => {
    const h = setup();
    const c = bot(h);
    h.runs.createRun({
      runId: "run",
      specId: "main",
      specVersion: "1",
      owner: { kind: "conversation", id: c.id },
      at,
    });
    const d = h.outbox.commit({
      runId: "run",
      conversationId: c.id,
      ordinal: 0,
      target: {
        accountId: "100",
        conversationKind: "private",
        peerId: "200",
        agentId: DEFAULT_AGENT_ID,
        bindingId: "binding",
        bindingEpoch: 1,
      },
      speechKind: "direct_reply",
      sourceThroughSeq: 0,
      deliverBy: later,
      createdAt: at,
      expiresAt: later,
      parts: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ],
    });
    expect(DeliverySchema.safeParse(d).success).toBe(true);
    expect(h.outbox.claimPart(d.id, at)!.payload).toEqual({ text: "first" });
    expect(h.outbox.claimPart(d.id, at)).toBeNull();
    expect(h.outbox.recover(at)).toBe(1);
    expect(h.outbox.get(d.id)!.parts.map((p) => p.status)).toEqual(["unknown", "not_sent"]);
    expect(h.outbox.claimPart(d.id, at)).toBeNull();
    expect(h.outbox.pending()).toEqual([]);
  });
  it("terminal transaction rollback retains wake/cursor/planned outputs consistently", () => {
    const h = setup();
    const c = bot(h);
    incoming(h, "a", 100);
    h.journal.ingestOneBotEvent("a", "binding");
    const w = h.wake.enqueue({
      conversationId: c.id,
      cause: "message",
      throughSeq: 1,
      dedupeKey: "a",
      readyAt: at,
      priority: 10,
    });
    const lease = h.wake.claim({ at, leaseMs: 1000 })!;
    expect(() =>
      h.db.transaction(() => {
        h.journal.acknowledge(c.id, 1);
        h.wake.complete(w.id, lease.leaseToken!, "completed", 1, at);
        throw new Error("write failed");
      })(),
    ).toThrow("write failed");
    expect(h.journal.get(c.id)!.consumedSeq).toBe(0);
    expect(h.wake.get(w.id)!.status).toBe("leased");
  });
});
