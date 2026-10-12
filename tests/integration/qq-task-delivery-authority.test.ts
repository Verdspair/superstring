import { afterEach, describe, expect, it } from "bun:test";
import { qqDeliveryAuthorize } from "../../src/server/channels/onebot11/delivery-authority";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  createQqScheme,
  schemeResponse,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import type { QqTaskExecutionSnapshot } from "../../src/shared/contracts/qq-task";
import { cloneBusinessDb } from "../harness/business-db";

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
const now = "2026-10-12T10:00:00.000Z";
const future = "2099-01-01T00:00:00.000Z";
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function fixture(input: { schemeConfig: boolean; mismatchRun?: boolean; groupRoom?: boolean }) {
  const handle = cloneBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "qq-delivery-authority");
  updateQqSettings(handle.orm, { enabled: true, accountId: "100", expectedRevision: 1 });
  const journal = new ConversationEventRepository(handle.db);
  const scheme = createQqScheme(handle.orm, {
    name: `authority-${crypto.randomUUID()}`,
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
    reply: { split_by_speaker: !input.groupRoom },
  });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "100",
    kind: input.groupRoom ? "group" : "private",
    peerId: input.groupRoom ? "300" : "200",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("FIXTURE_BINDING_CREATE_FAILED");
  const binding = insertQqBinding(handle.orm, created.binding);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("FIXTURE_CONVERSATION_MISSING");
  journal.append({
    conversationId: conversation.id,
    eventKey: "source:authority",
    kind: "inbound",
    source: { kind: "fixture", id: "source:authority", revision: "r1" },
    occurredAt: now,
    recordedAt: now,
  });
  const sourceThroughSeq = journal.sourceThroughSeq(conversation.id);
  const agent = getAgentRow(handle.orm, DEFAULT_AGENT_ID);
  if (!agent) throw new Error("FIXTURE_AGENT_MISSING");
  const taskId = `task-${crypto.randomUUID()}`;
  const runId = `run-${crypto.randomUUID()}`;
  const taskKey = `qq-task:${crypto.randomUUID()}`;
  const runs = new AgentRunRepository(handle.db);
  runs.createRun({
    runId,
    specId: "onebot.task",
    specVersion: "1",
    owner: {
      kind: "conversation",
      id: conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: agent.id,
    },
    at: now,
  });
  journal.linkRun(runId, conversation.id, sourceThroughSeq);
  const snapshot: QqTaskExecutionSnapshot = {
    accountId: binding.accountId,
    conversationId: conversation.id,
    bindingId: binding.id,
    bindingEpoch: conversation.bindingEpoch,
    agentId: agent.id,
    schemeId: scheme.id,
    bindingRevision: binding.revision,
    authorityRevision: binding.authorityRevision,
    schemeRevision: scheme.revision,
    ...(input.schemeConfig ? { schemeConfig: schemeResponse(handle.orm, scheme) } : {}),
    agentConfigVersion: agent.configVersion,
    taskClass: "ordinary",
    cause: "direct_reply",
    sourceFromSeq: 0,
    sourceThroughSeq,
    sourceExpiresAt: null,
    authorizedTargets: [binding.peerId],
    targetParticipants: [
      { targetId: binding.peerId, speakerId: input.groupRoom ? null : binding.peerId },
    ],
    maxSteps: 20,
    deliveryTtlSeconds: 600,
    mentionTaskLimit: 4,
    ordinaryTaskLimit: 4,
    taskKey,
  };
  handle.db
    .query(`INSERT INTO qq_conversation_tasks(
    id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,source_from_seq,source_through_seq,
    source_expires_at,origin_wake_id,origin_event_key,platform_message_id,origin_run_id,status,judgement_done,
    lease_token,lease_expires_at,cancellation_requested,created_at,updated_at,finished_at,error_code,
    execution_snapshot,claimed_at,ready_at
  ) VALUES(?,?,?,?,?,'ordinary','direct_reply',0,?,NULL,NULL,NULL,NULL,?,'running',0,'lease',?,0,?,?,NULL,NULL,?,?,NULL)`)
    .run(
      taskId,
      taskKey,
      conversation.id,
      conversation.bindingEpoch,
      agent.id,
      sourceThroughSeq,
      runId,
      "2099-01-01T00:00:00.000Z",
      now,
      now,
      JSON.stringify(snapshot),
      now,
    );
  const target: OutboundTarget = {
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: agent.id,
    bindingId: binding.id,
    bindingEpoch: conversation.bindingEpoch,
    bindingRevision: binding.revision,
    authorityRevision: binding.authorityRevision,
    ownerIdentityRevision: binding.ownerIdentityRevision,
    schemeId: scheme.id,
    schemeRevision: scheme.revision,
    qqTaskId: taskId,
    agentConfigVersion: agent.configVersion,
    sources: [],
  };
  const intentRunId = input.mismatchRun ? `foreign-${runId}` : runId;
  if (input.mismatchRun) {
    runs.createRun({
      runId: intentRunId,
      specId: "onebot.task",
      specVersion: "1",
      owner: {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: agent.id,
      },
      at: now,
    });
    journal.linkRun(intentRunId, conversation.id, sourceThroughSeq - 1);
  }
  const outbox = new OutboundIntentRepository(handle.db);
  const intent = outbox.commit({
    id: `intent-${crypto.randomUUID()}`,
    runId: intentRunId,
    conversationId: conversation.id,
    ordinal: 0,
    target,
    speechKind: "direct_reply",
    sourceThroughSeq,
    deliverBy: future,
    createdAt: now,
    expiresAt: future,
    parts: [{ kind: "text", text: "synthetic reply" }],
  });
  const authorize = qqDeliveryAuthorize({
    orm: handle.orm,
    db: handle.db,
    journal,
    outbox,
    guard: new QqGroupCapabilityGuard(handle.orm),
  });
  return { handle, scheme, target, intent, authorize };
}

describe("QQ task delivery authority", () => {
  it("accepts a canonical frozen task snapshot after an ordinary scheme edit", () => {
    const f = fixture({ schemeConfig: true });
    expect(f.authorize(f.target, f.intent)).toBe(true);
    const changed = updateQqScheme(f.handle.orm, f.scheme.id, {
      name: f.scheme.name,
      description: "ordinary edit while task is running",
      expectedRevision: f.scheme.revision,
    });
    expect(changed.revision).toBe(f.scheme.revision + 1);
    expect(f.authorize(f.target, f.intent)).toBe(true);
  });

  it("accepts a canonical idle-topic child without requiring a persisted parent graph", () => {
    const f = fixture({ schemeConfig: true, groupRoom: true });
    const row = f.handle.db
      .query("SELECT execution_snapshot,origin_run_id FROM qq_conversation_tasks WHERE id=?")
      .get(f.target.qqTaskId!) as { execution_snapshot: string; origin_run_id: string };
    const frozen = JSON.parse(row.execution_snapshot) as QqTaskExecutionSnapshot;
    frozen.cause = "idle_topic";
    f.handle.db
      .query("UPDATE qq_conversation_tasks SET cause='idle_topic',execution_snapshot=? WHERE id=?")
      .run(JSON.stringify(frozen), f.target.qqTaskId!);
    updateQqScheme(f.handle.orm, f.scheme.id, {
      name: f.scheme.name,
      triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: true },
      expectedRevision: f.scheme.revision,
    });
    const childId = `child-${crypto.randomUUID()}`;
    new AgentRunRepository(f.handle.db).createRun({
      runId: childId,
      specId: "onebot.main",
      specVersion: "1",
      owner: {
        kind: "conversation",
        id: f.intent.conversationId,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
      at: now,
    });
    new ConversationEventRepository(f.handle.db).linkRun(
      childId,
      f.intent.conversationId,
      f.intent.sourceThroughSeq,
    );
    f.handle.db
      .query("UPDATE outbound_intents SET run_id=?,speech_kind='idle_topic' WHERE id=?")
      .run(childId, f.intent.id);
    const delivery = new OutboundIntentRepository(f.handle.db).get(f.intent.id)!;
    expect(f.authorize(f.target, delivery)).toBe(true);
    expect(f.authorize({ ...f.target, participantId: "999" }, delivery)).toBe(false);
  });

  it("keeps legacy snapshots only at their current scheme revision and rejects another run or recipient", () => {
    const legacy = fixture({ schemeConfig: false });
    expect(legacy.authorize(legacy.target, legacy.intent)).toBe(true);
    updateQqScheme(legacy.handle.orm, legacy.scheme.id, {
      name: legacy.scheme.name,
      description: "revision changed",
      expectedRevision: legacy.scheme.revision,
    });
    expect(legacy.authorize(legacy.target, legacy.intent)).toBe(false);

    const wrongRun = fixture({ schemeConfig: true, mismatchRun: true });
    expect(wrongRun.authorize(wrongRun.target, wrongRun.intent)).toBe(false);
    expect(wrongRun.authorize({ ...wrongRun.target, participantId: "999" }, wrongRun.intent)).toBe(
      false,
    );

    const room = fixture({ schemeConfig: true, groupRoom: true });
    expect(room.authorize(room.target, room.intent)).toBe(true);
  });
});
