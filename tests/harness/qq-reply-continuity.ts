import { afterEach } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  confirmQqOutboundPart,
  recordQqOutboundMessageFact,
} from "../../src/server/db/qq-message-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

/** Isolated production context-source fixture (same shape as the drift-review repro). */
const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const FIXED_SECONDS = Math.floor(Date.now() / 1000);
export const FIXED_NOW = new Date(FIXED_SECONDS * 1000).toISOString();

export function sourceFixture() {
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "reply-model");
  const seconds = FIXED_SECONDS;
  const now = FIXED_NOW;
  updateQqSettings(handle.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(handle.orm, {
    name: "reply-continuity",
    context: { ...QQ_CONTEXT_DEFAULT },
  });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(handle.orm, created.binding);
  const capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("snapshot");
  const row = getAgentRow(handle.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.compression_enabled = false;
  const journal = new ConversationEventRepository(handle.db);
  const outbox = new OutboundIntentRepository(handle.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const probe = { capacity: 65536 };
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => probe.capacity,
    complete: async () => '{"facts":[]}',
    async *streamChat() {
      yield "unused";
    },
  };
  const spec: AgentSpec = {
    id: "test.reply-continuity",
    model: "reply-model",
    context: "conversation",
    instructions: "synthetic context",
    availableActions: [],
    limits: { steps: 16 },
  };
  const buildSource = (ownTaskId?: string, path: "direct_reply" | "chiming_in" = "direct_reply") =>
    new BotContextSource({
      ...handle,
      gateway,
      agentRuntime: createAgentRuntime({
        gateway,
        repository: new AgentRunRepository(handle.db),
      }),
      journal,
      outbox,
      conversationId: conversation.id,
      ...(ownTaskId === undefined ? {} : { ownTaskId }),
      binding,
      snapshot: capture.snapshot,
      scheme,
      runtime,
      spec,
      path,
      decisionTier: "reply",
      targets: () => [{ id: "alice", speakerId: "20002" }],
      assertCurrent() {},
      now: () => now,
    });
  const seed = (text: string, age = 0) => {
    const eventKey = crypto.randomUUID();
    handle.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        messageId: eventKey,
        occurredAtSeconds: seconds - age,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
      })
      .run();
    handle.orm
      .insert(schema.qqMessageFacts)
      .values({
        eventKey,
        legacyDisplayName: "member",
        nameState: "legacy",
        parts: JSON.stringify([{ kind: "text", text }]),
        revision: 1,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    handle.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey,
        body: text,
        occurredAtSeconds: seconds - age,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    journal.ingestOneBotEvent(eventKey, binding.id);
    return eventKey;
  };
  const seedPeerTask = (taskId: string) => {
    handle.db
      .query(
        `INSERT INTO qq_conversation_tasks(id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,
          source_from_seq,source_through_seq,status,cancellation_requested,source_expires_at,lease_expires_at,created_at,updated_at,platform_message_id,lease_token)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        taskId,
        `key-${taskId}`,
        conversation.id,
        1,
        DEFAULT_AGENT_ID,
        "mention",
        "direct_reply",
        1,
        1,
        "pending",
        0,
        null,
        null,
        now,
        now,
        `platform-${taskId}`,
        null,
      );
  };
  return { ...handle, seed, seedPeerTask, buildSource, binding, journal, outbox, conversation };
}

export const INTENT_TEXT = "Add an independent detail to this topic";
export const CONFIRMED_ANSWER_TEXT = "CONFIRMED-PREDECESSOR-ANSWER";

export function peerReply(h: ReturnType<typeof sourceFixture>) {
  h.seedPeerTask("peer-inflight");
  const wakeId = crypto.randomUUID();
  h.db
    .query(
      "INSERT INTO wake_signals(id,conversation_id,cause,through_seq,dedupe_key,ready_at,priority,status,created_at) VALUES(?,?,'chiming_in',1,?,?,50,'completed',?)",
    )
    .run(wakeId, h.conversation.id, wakeId, FIXED_NOW, FIXED_NOW);
  h.db
    .query(
      "UPDATE qq_conversation_tasks SET task_class='ordinary',cause='chiming_in',platform_message_id=NULL,judgement_done=1,origin_wake_id=? WHERE id='peer-inflight'",
    )
    .run(wakeId);
  const runs = new AgentRunRepository(h.db);
  const owner = {
    kind: "qq_binding",
    id: h.binding.id,
    agentId: DEFAULT_AGENT_ID,
    userId: DEFAULT_USER_ID,
  };
  const scoreRunId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  runs.createRun({
    runId: scoreRunId,
    specId: "onebot.initiative.evaluate_batch",
    specVersion: "1",
    owner,
    at: FIXED_NOW,
  });
  h.db
    .query("UPDATE agent_runs SET conversation_id=?,wake_id=?,observed_seq=1 WHERE run_id=?")
    .run(h.conversation.id, wakeId, scoreRunId);
  runs.startStep({
    runId: scoreRunId,
    stepId,
    stepNo: 1,
    model: "reply-model",
    phase: "leaf",
    at: FIXED_NOW,
    messages: [
      {
        role: "user",
        content: [
          {
            kind: "text",
            text: JSON.stringify({
              kind: "qq_batch_targets",
              trust: "data_only",
              sourceSeqs: [1],
              targets: [{ targetId: "20002", speakerId: "20002", sourceSeqs: [1] }],
            }),
          },
        ],
      },
    ],
    sources: [],
  });
  runs.finishStep(stepId, "completed", FIXED_NOW, {
    output: {
      text: JSON.stringify({
        evaluations: [{ targetId: "20002", score: 8, intent: INTENT_TEXT, sourceSeqs: [1] }],
      }),
      format: "text",
      complete: true,
    },
  });
  runs.setStatus(scoreRunId, "completed", FIXED_NOW);
  const runId = crypto.randomUUID();
  runs.createRun({ runId, specId: "onebot.main", specVersion: "1", owner, at: FIXED_NOW });
  const expiresAt = new Date(Date.parse(FIXED_NOW) + 3600000).toISOString();
  const intent = h.outbox.commit({
    runId,
    conversationId: h.conversation.id,
    ordinal: 0,
    target: {
      accountId: h.binding.accountId,
      conversationKind: h.binding.kind,
      peerId: h.binding.peerId,
      participantId: "20002",
      agentId: DEFAULT_AGENT_ID,
      bindingId: h.binding.id,
      bindingEpoch: h.conversation.bindingEpoch,
      authorityRevision: h.binding.authorityRevision,
      qqTaskId: "peer-inflight",
      sources: [],
    },
    speechKind: "chiming_in",
    sourceThroughSeq: 1,
    createdAt: FIXED_NOW,
    deliverBy: expiresAt,
    expiresAt,
    parts: [{ kind: "text", text: CONFIRMED_ANSWER_TEXT, mentions: [] }],
  });
  recordQqOutboundMessageFact(h.orm, {
    intentId: intent.id,
    accountId: h.binding.accountId,
    agentId: DEFAULT_AGENT_ID,
    occurredAtSeconds: FIXED_SECONDS,
    identity: {
      qq: h.binding.accountId,
      groupCard: null,
      personalNickname: null,
      legacyDisplayName: "assistant",
      nameState: "legacy",
    },
  });
  const revision = (state: string) =>
    h.journal.append({
      conversationId: h.conversation.id,
      eventKey: `${state}:${intent.id}`,
      kind: "delivery",
      source: { kind: "outbound_intent", id: intent.id, revision: state, expiresAt },
      occurredAt: FIXED_NOW,
      runId,
      outputId: intent.id,
    });
  revision("planned");
  const complete = () =>
    h.db
      .query(
        "UPDATE qq_conversation_tasks SET status='completed',finished_at=?,updated_at=? WHERE id='peer-inflight'",
      )
      .run(FIXED_NOW, FIXED_NOW);
  const settle = (status: "confirmed" | "unknown") => {
    const claim = h.outbox.claimPart(intent.id, FIXED_NOW);
    if (!claim) throw new Error("Expected an unattempted canonical delivery part");
    h.outbox.settlePart(
      claim.part.id,
      status === "confirmed" ? { status, messageId: "55555" } : { status },
      FIXED_NOW,
    );
    if (status === "confirmed") {
      confirmQqOutboundPart(
        h.orm,
        {
          intentId: intent.id,
          platformMessageId: "55555",
          kind: "text",
          ordinal: 0,
          text: CONFIRMED_ANSWER_TEXT,
        },
        h.db,
      );
      const speech = recordQqSpeech(h.orm, {
        scope: {
          kind: "qq",
          accountId: h.binding.accountId,
          conversationKind: h.binding.kind,
          peerId: h.binding.peerId,
          agentId: DEFAULT_AGENT_ID,
        },
        kind: "chiming_in",
        spokeAtSeconds: FIXED_SECONDS,
        text: CONFIRMED_ANSWER_TEXT,
      });
      h.db
        .query("UPDATE outbound_intents SET legacy_send_id=? WHERE id=?")
        .run(speech.id, intent.id);
    }
    revision(status);
  };
  return { intent, complete, settle, runs, scoreRunId, stepId };
}
export const read = (source: BotContextSource) =>
  source.read({ signal: new AbortController().signal, observations: [] });
export const jobs = (material: Awaited<ReturnType<typeof read>>) =>
  (material.pending ?? []).flatMap((m) =>
    m.content.flatMap((p) => {
      if (p.kind !== "text") return [];
      try {
        const value = JSON.parse(p.text);
        return value.kind === "qq_concurrent_jobs" ? value.jobs : [];
      } catch {
        return [];
      }
    }),
  ) as { taskId: string; reply?: string; declaredIntents?: { intent: string }[] }[];
