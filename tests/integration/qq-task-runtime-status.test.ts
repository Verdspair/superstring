import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { handleError } from "../../src/server/api/error-handler";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  claimNextQqConversationTask,
  createQqConversationTask,
  deferQqConversationTask,
  type QqConversationTaskSourceGuard,
} from "../../src/server/db/qq-task-repository";
import { createSession, DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { WakeRepository } from "../../src/server/db/wake-repository";
import {
  QqTaskExecutionSnapshotSchema,
  qqConversationTaskKey,
} from "../../src/shared/contracts/qq-task";
import { cloneBusinessDb } from "../harness/business-db";

const now = "2026-10-11T08:00:00.000Z";
const futureReadyAt = "2026-10-11T08:05:00.000Z";
const handles: BusinessDbHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function setup() {
  const business = cloneBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "status-fixture-model");
  const scheme = createQqScheme(business.orm, { name: "status fixture" });
  const bindingId = crypto.randomUUID();
  business.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,'group',?,?,?,?,?)",
    )
    .run(bindingId, "10001", "30003", DEFAULT_AGENT_ID, scheme.id, now, now);
  const journal = new ConversationEventRepository(business.db);
  const conversation = journal.ensureOneBot(bindingId);
  if (!conversation) throw new Error("Missing synthetic QQ conversation");
  const eventKey = `status-event-${crypto.randomUUID()}`;
  business.db
    .query(
      "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed) VALUES(?,?,'group',?,?,?, ?, 'member',?,?,0)",
    )
    .run(eventKey, "10001", "30003", DEFAULT_AGENT_ID, "91001", 1791705600, "20002", now);
  const event = journal.ingestOneBotEvent(eventKey, bindingId);
  if (!event) throw new Error("Missing synthetic source event");
  const wakes = new WakeRepository(business.db);
  const wake = wakes.enqueue({
    conversationId: conversation.id,
    cause: "follow_up",
    throughSeq: event.seq,
    dedupeKey: `status-wake-${crypto.randomUUID()}`,
    priority: 100,
    readyAt: now,
    at: now,
  });
  const claimedWake = wakes.claim({ at: now, leaseMs: 120_000, globalConcurrency: 1 });
  if (!claimedWake || claimedWake.id !== wake.id || !claimedWake.leaseToken)
    throw new Error("Could not claim synthetic wake");
  const sourceState: QqConversationTaskSourceGuard = (transaction, identity) => {
    const db = (transaction as typeof transaction & { $client: BusinessDbHandle["db"] }).$client;
    const current = db
      .query(
        "SELECT 1 AS ok FROM conversations c JOIN qq_bindings b ON b.id=c.source_id WHERE c.id=? AND c.binding_epoch=? AND c.agent_id=? AND c.closed_at IS NULL AND b.agent_id=c.agent_id",
      )
      .get(identity.conversationId, identity.bindingEpoch, identity.agentId);
    if (!current) return "revoked";
    const source = db
      .query(
        "SELECT 1 AS ok FROM conversation_events ce JOIN qq_events e ON e.event_key=ce.source_id JOIN conversations c ON c.id=ce.conversation_id JOIN qq_bindings b ON b.id=c.source_id WHERE ce.conversation_id=? AND ce.source_kind='qq_event' AND e.agent_id=? AND b.account_id=e.account_id AND b.peer_id=e.peer_id AND ce.seq=?",
      )
      .get(identity.conversationId, identity.agentId, identity.sourceThroughSeq);
    return source ? "valid" : "revoked";
  };
  const input = {
    taskKey: qqConversationTaskKey.ordinary({
      conversationId: conversation.id,
      bindingEpoch: conversation.bindingEpoch,
      agentId: DEFAULT_AGENT_ID,
      wakeId: wake.id,
    }),
    conversationId: conversation.id,
    bindingEpoch: conversation.bindingEpoch,
    agentId: DEFAULT_AGENT_ID,
    taskClass: "ordinary" as const,
    cause: "follow_up" as const,
    sourceFromSeq: event.seq,
    sourceThroughSeq: event.seq,
    originWakeId: wake.id,
    wakeLeaseToken: claimedWake.leaseToken,
    at: now,
  };
  const task = createQqConversationTask(business.orm, input, { validateSource: sourceState });
  const app = new Hono()
    .onError(handleError)
    .route("/v2/conversations", conversationRoutes(business.db, { includeShared: true }));
  return {
    business,
    conversation,
    task: task.task,
    wake,
    app,
    sourceState,
    journal,
    wakes,
    eventKey,
    event,
  };
}

const limits = () => ({ mentionTaskLimit: 4, ordinaryTaskLimit: 1 });

const freezeAtClaim: NonNullable<
  Parameters<typeof claimNextQqConversationTask>[1]["freezeAtClaim"]
> = (transaction, task, limitsForTask) => {
  const db = (transaction as typeof transaction & { $client: BusinessDbHandle["db"] }).$client;
  const row = db
    .query(`SELECT b.id AS binding_id,b.account_id,b.revision AS binding_revision,
      b.authority_revision,s.id AS scheme_id,s.revision AS scheme_revision,a.config_version
      FROM conversations c JOIN qq_bindings b ON b.id=c.source_id
      JOIN qq_schemes s ON s.id=b.scheme_id JOIN agents a ON a.id=b.agent_id WHERE c.id=?`)
    .get(task.conversationId) as {
    binding_id: string;
    account_id: string;
    binding_revision: number;
    authority_revision: number;
    scheme_id: string;
    scheme_revision: number;
    config_version: number;
  };
  return QqTaskExecutionSnapshotSchema.parse({
    accountId: row.account_id,
    conversationId: task.conversationId,
    bindingId: row.binding_id,
    bindingEpoch: task.bindingEpoch,
    agentId: task.agentId,
    schemeId: row.scheme_id,
    bindingRevision: row.binding_revision,
    authorityRevision: row.authority_revision,
    schemeRevision: row.scheme_revision,
    agentConfigVersion: row.config_version,
    taskClass: task.taskClass,
    cause: task.cause,
    sourceFromSeq: task.sourceFromSeq,
    sourceThroughSeq: task.sourceThroughSeq,
    sourceExpiresAt: task.sourceExpiresAt,
    authorizedTargets: ["30003"],
    targetParticipants: [{ targetId: "30003", speakerId: "20002" }],
    maxSteps: 12,
    deliveryTtlSeconds: 900,
    mentionTaskLimit: limitsForTask.mentionTaskLimit,
    ordinaryTaskLimit: limitsForTask.ordinaryTaskLimit,
    taskKey: task.taskKey,
  });
};

async function readStatus(app: Hono, conversationId: string) {
  const response = await app.request(`/v2/conversations/${conversationId}/status`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("QQ durable task conversation status projection", () => {
  it("counts a handed-off cap-pending durable task without counting its settled wake", async () => {
    const f = setup();
    expect(f.task.status).toBe("pending");
    expect(
      f.business.db
        .query("SELECT status,transferred_task_id FROM wake_signals WHERE id=?")
        .get(f.wake.id),
    ).toEqual({ status: "completed", transferred_task_id: f.task.id });
    expect(f.business.db.query("SELECT COUNT(*) AS n FROM agent_runs").get()).toEqual({ n: 0 });
    const status = await readStatus(f.app, f.conversation.id);
    expect(status).toMatchObject({
      pendingTasks: 1,
      queuedCount: 1,
      pendingWakes: 0,
      activeRuns: 0,
      nextReadyAt: null,
    });
  });

  it("includes a deferred durable task deadline after its wake handoff is settled", async () => {
    const f = setup();
    const claimed = claimNextQqConversationTask(f.business.orm, {
      at: now,
      leaseToken: "status-task-lease",
      leaseExpiresAt: futureReadyAt,
      limitsFor: limits,
      sourceState: f.sourceState,
      freezeAtClaim,
    });
    expect(claimed?.task.id).toBe(f.task.id);
    expect(claimed?.task.status).toBe("running");
    expect(
      deferQqConversationTask(f.business.orm, {
        taskId: f.task.id,
        leaseToken: "status-task-lease",
        at: now,
        readyAt: futureReadyAt,
        sourceState: f.sourceState,
      }),
    ).toBe(true);
    expect(
      f.business.db
        .query("SELECT status,ready_at FROM qq_conversation_tasks WHERE id=?")
        .get(f.task.id),
    ).toEqual({ status: "pending", ready_at: futureReadyAt });
    expect(
      f.business.db
        .query("SELECT status,transferred_task_id FROM wake_signals WHERE id=?")
        .get(f.wake.id),
    ).toEqual({ status: "completed", transferred_task_id: f.task.id });
    expect(f.business.db.query("SELECT COUNT(*) AS n FROM agent_runs").get()).toEqual({ n: 0 });
    const status = await readStatus(f.app, f.conversation.id);
    expect(status).toMatchObject({
      pendingTasks: 1,
      queuedCount: 1,
      pendingWakes: 0,
      activeRuns: 0,
      nextReadyAt: futureReadyAt,
    });
  });

  it("does not count a pending mention task and its intake wake twice", async () => {
    const f = setup();
    const mention = createQqConversationTask(
      f.business.orm,
      {
        taskKey: qqConversationTaskKey.mention({
          accountId: "10001",
          conversationId: f.conversation.id,
          bindingEpoch: f.conversation.bindingEpoch,
          platformMessageId: "91001",
          agentId: DEFAULT_AGENT_ID,
        }),
        conversationId: f.conversation.id,
        bindingEpoch: f.conversation.bindingEpoch,
        agentId: DEFAULT_AGENT_ID,
        taskClass: "mention",
        cause: "direct_reply",
        sourceFromSeq: f.event.seq,
        sourceThroughSeq: f.event.seq,
        originEventKey: f.eventKey,
        platformMessageId: "91001",
        at: now,
      },
      { validateSource: f.sourceState },
    );
    f.wakes.enqueue({
      conversationId: f.conversation.id,
      cause: "direct_reply",
      throughSeq: f.event.seq,
      dedupeKey: "mention-intake",
      priority: 100,
      readyAt: futureReadyAt,
      at: now,
    });
    expect(mention.task.status).toBe("pending");
    const status = await readStatus(f.app, f.conversation.id);
    expect(status).toMatchObject({
      pendingWakes: 1,
      pendingTasks: 2,
      queuedCount: 2,
      nextReadyAt: null,
    });
  });

  it("preserves a Web conversation's wake-only queue and deadline", async () => {
    const f = setup();
    const session = createSession(f.business.orm, "Web status", {
      modelName: "status-fixture-model",
    });
    const conversation = f.journal.ensureWeb(session.id);
    if (!conversation) throw new Error("Missing Web conversation");
    const event = f.journal.append({
      conversationId: conversation.id,
      eventKey: "web-status-event",
      kind: "inbound",
      source: { kind: "fixture", id: "web-status", revision: "1" },
      occurredAt: now,
    });
    f.wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: event.seq,
      dedupeKey: "web-intake",
      priority: 100,
      readyAt: futureReadyAt,
      at: now,
    });
    const status = await readStatus(f.app, conversation.id);
    expect(status).toMatchObject({
      pendingWakes: 1,
      pendingTasks: 0,
      queuedCount: 1,
      nextReadyAt: futureReadyAt,
    });
  });
});
