// Production-composition coverage for concurrent replies before awareness material is added.

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { cloneBusinessDb } from "../harness/business-db";

const ACCOUNT_ID = "10001";
const GROUP_ID = "30003";
const A = "20002";
const B = "20003";

const isBatchScore = (request: ModelRequest): boolean =>
  (request.responseSchema as { properties?: Record<string, unknown> } | undefined)?.properties
    ?.evaluations !== undefined;
const isDecision = (request: ModelRequest): boolean =>
  Array.isArray((request.responseSchema as { oneOf?: unknown } | undefined)?.oneOf);

type BatchEnvelope = { kind: string; sourceSeqs: number[]; targets: { targetId: string }[] };
const batchEnvelopeOf = (request: ModelRequest): BatchEnvelope => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const parsed = JSON.parse(part.text) as BatchEnvelope;
        if (parsed.kind === "qq_batch_targets" && Array.isArray(parsed.targets)) return parsed;
      } catch {}
    }
  }
  throw new Error("SCORE_TARGETS_MISSING");
};

type ConcurrentJobDump = {
  taskId: string;
  cause: string;
  taskClass: string;
  status: string;
  questionSeq: number;
  reply?: string;
};
type ConcurrentJobsDump = {
  kind: string;
  trust: string;
  guidance: string;
  jobs: ConcurrentJobDump[];
  omitted?: number;
};
/** The host-projected data_only concurrent-jobs material, if this call carried one. */
const concurrentJobsDumpOf = (request: ModelRequest): ConcurrentJobsDump | null => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const parsed = JSON.parse(part.text) as ConcurrentJobsDump;
        if (parsed?.kind === "qq_concurrent_jobs") return parsed;
      } catch {}
    }
  }
  return null;
};

type DecisionTrigger = { seq: number; cause: string };
const decisionTriggerOf = (request: ModelRequest): DecisionTrigger => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const dump = JSON.parse(part.text) as { kind?: string; value?: Record<string, unknown> };
        if (dump?.kind !== "activation_trigger" || dump.value === undefined) continue;
        return {
          seq: Number(dump.value.seq ?? -1),
          cause: String(dump.value.cause ?? ""),
        };
      } catch {}
    }
  }
  throw new Error("DECISION_CALL_WITHOUT_TRIGGER");
};

const authorizedTargetOf = (request: ModelRequest): string => {
  const targetId = JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1];
  if (!targetId) throw new Error("AUTHORIZED_TARGET_MISSING");
  return targetId;
};

const inlineReply = (targetId: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });

const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_TIMEOUT_PRODUCTION_CASE");
    await Bun.sleep(5);
  }
};

/** Controlled promise gate: the call parks until released; bounded so a stuck case fails. */
type ControlledGate = ReturnType<typeof controlledGate>;
const pendingGates: (() => void)[] = [];
const composed: ReturnType<typeof createOneBotConversationRuntime>[] = [];
const handles: BusinessDbHandle[] = [];
const controlledGate = () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
    pendingGates.push(release);
  });
  const bounded = (code: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      gate,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), 4000);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  return { gate, release, bounded };
};

afterEach(async () => {
  for (const release of pendingGates.splice(0)) release();
  for (const bot of composed.splice(0)) {
    bot.scheduler.stop();
    await bot.scheduler.waitForIdle().catch(() => {});
    bot.delivery.stop();
    await bot.delivery.waitForIdle().catch(() => {});
    bot.release();
  }
  for (const h of handles.splice(0)) h.close();
});

function composeFixture(options: {
  autonomyScore: number;
  /** Facts-aware score hook: receives the batch envelope and the concurrent-jobs projection actually sent. */
  scoreFromFacts?: (input: { envelope: BatchEnvelope; jobs: ConcurrentJobsDump | null }) => number;
}) {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "awareness-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: `reply-awareness-${crypto.randomUUID()}`,
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
    reply: { split_by_speaker: true },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      initiative_batch_target_count: 1,
      initiative_batch_jitter_count: 0,
      initiative_time_window_enabled: false,
      merge_window_seconds: 0,
      reply_cooldown_seconds: 1,
      judgement_interval_turns: 1,
    },
  });
  const bindingId = crypto.randomUUID();
  const now = () => new Date().toISOString();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(bindingId, DEFAULT_AGENT_ID, scheme.id, now(), now());
  const journal = new ConversationEventRepository(h.db);
  const runs = new AgentRunRepository(h.db);
  const batchEnvelopes: BatchEnvelope[] = [];
  const scoreJobDumps: (ConcurrentJobsDump | null)[] = [];
  const decisionJobDumps: (ConcurrentJobsDump | null)[] = [];
  const phases: string[] = [];
  const decisionGates = new Map<number, ControlledGate>();
  const model: ModelPort = {
    async complete(request) {
      if (isBatchScore(request)) {
        phases.push("autonomy-score");
        const envelope = batchEnvelopeOf(request);
        batchEnvelopes.push(envelope);
        const jobs = concurrentJobsDumpOf(request);
        scoreJobDumps.push(jobs);
        const score = options.scoreFromFacts?.({ envelope, jobs }) ?? options.autonomyScore;
        return JSON.stringify({
          evaluations: envelope.targets.map((target) => ({
            targetId: target.targetId,
            score,
            intent: `autonomy intent ${target.targetId}`,
            sourceSeqs: [...envelope.sourceSeqs],
          })),
        });
      }
      if (!isDecision(request)) {
        decisionJobDumps.push(concurrentJobsDumpOf(request));
        return "{}";
      }
      decisionJobDumps.push(concurrentJobsDumpOf(request));
      const trigger = decisionTriggerOf(request);
      const targetId = authorizedTargetOf(request);
      if (trigger.cause === "direct_reply") {
        phases.push("direct-decision");
        const gate = decisionGates.get(trigger.seq);
        if (gate) await gate.bounded("DIRECT_GATE_TIMEOUT");
        return inlineReply(targetId, `direct-${targetId}`);
      }
      phases.push("autonomy-child");
      return inlineReply(targetId, `autonomy-${targetId}`);
    },
    async *streamText() {
      yield "";
    },
    async completeMultimodal() {
      return "";
    },
  };
  const runtime = new AgentRuntime({ repository: runs, model, now });
  const gateway = {
    async complete() {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    async loadedContextCapacity() {
      return 65536;
    },
  };
  const sends: { peerId: string; request: unknown }[] = [];
  const bot = createOneBotConversationRuntime({
    orm: h.orm,
    db: h.db,
    gateway,
    agentRuntime: runtime,
    host: new ConversationHost({ runtime }),
    journal,
    store: new QqStickerStore({ directory: "synthetic-reply-awareness-stickers" }),
    port: {
      async send(request) {
        sends.push({ peerId: request.peerId, request });
        return { kind: "confirmed", messageId: String(40000 + sends.length) };
      },
    },
    wake: () => {},
    policy: () => ({
      maxSteps: 20,
      deliveryTtlSeconds: 600,
      retryDelayMs: 1000,
      maxAttempts: 3,
      globalConcurrency: 4,
      modelCallConcurrency: 4,
    }),
  });
  composed.push(bot);
  const receive = (messageId: string, memberId: string, text: string, addressed: boolean) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: Math.floor(Date.now() / 1000),
        self_id: Number(ACCOUNT_ID),
        user_id: Number(memberId),
        group_id: Number(GROUP_ID),
        message_id: messageId,
        message: [
          ...(addressed ? [{ type: "at", data: { qq: ACCOUNT_ID } }] : []),
          { type: "text", data: { text } },
        ],
        sender: { nickname: memberId },
      },
      ACCOUNT_ID,
    );
    return recordInbound(h.orm, normalized, {
      accountId: ACCOUNT_ID,
      conversationIngress: bot.adapter,
    });
  };
  return {
    h,
    bot,
    journal,
    sends,
    phases,
    batchEnvelopes,
    scoreJobDumps,
    decisionJobDumps,
    decisionGates,
    receive,
  };
}

type TaskRow = {
  id: string;
  cause: string;
  status: string;
  source_from_seq: number;
  source_through_seq: number;
  origin_event_key: string | null;
  execution_snapshot: string | null;
};
const taskRows = (db: Database): TaskRow[] =>
  db
    .query(
      "SELECT id,cause,status,source_from_seq,source_through_seq,origin_event_key,execution_snapshot FROM qq_conversation_tasks ORDER BY rowid",
    )
    .all() as TaskRow[];
const taskByCause = (db: Database, cause: string): TaskRow => {
  const row = taskRows(db).find((task) => task.cause === cause);
  if (!row) throw new Error(`TASK_MISSING_${cause}`);
  return row;
};
type IntentRow = {
  speech_kind: string;
  status: string;
  st: number;
  participant: string | null;
};
const intentRows = (db: Database): IntentRow[] =>
  db
    .query(
      "SELECT speech_kind,status,source_through_seq AS st,json_extract(target,'$.participantId') AS participant FROM outbound_intents ORDER BY rowid",
    )
    .all() as IntentRow[];
const phaseCount = (phases: string[], name: string): number =>
  phases.filter((phase) => phase === name).length;

describe("qq concurrent reply awareness (S1 facts reach the existing single judge and normal decisions)", () => {
  it("a gated direct job is projected into the ordinary batch score with truthful status, and a facts-driven low score settles silently with exactly one score call", async () => {
    const f = composeFixture({
      autonomyScore: 10,
      scoreFromFacts: ({ jobs }) => {
        // The controlled judge "reads" the projection: the gated direct question is already
        // owned by a running job, so B's ordinary note adds no value -> low score.
        expect(jobs).not.toBeNull();
        expect(jobs!.trust).toBe("data_only");
        expect(jobs!.jobs).toHaveLength(1);
        const job = jobs!.jobs[0]!;
        expect(job.cause).toBe("direct_reply");
        expect(job.taskClass).toBe("mention");
        expect(job.status).toBe("running");
        expect(job.questionSeq).toBe(seqDirect!);
        // No reply has been committed for the gated job yet: no fake answered/planned fact.
        expect(job.reply).toBeUndefined();
        return 0;
      },
    });
    let seqDirect: number | undefined;
    f.receive("71001", A, "direct question from A", true);
    seqDirect = taskByCause(f.h.db, "direct_reply").source_through_seq;
    f.decisionGates.set(seqDirect, controlledGate());
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.phases.includes("direct-decision"));
    expect(taskByCause(f.h.db, "direct_reply").status).toBe("running");

    f.receive("71002", B, "ordinary note from B", false);
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.phases.includes("autonomy-score"));
    const envelope = f.batchEnvelopes[0]!;
    // Candidate eligibility is unchanged: only B is a candidate, while the frozen citable
    // window still includes the gated direct message's seq (background, owned by A's job).
    expect(envelope.targets.map((target) => target.targetId)).toEqual([B]);
    expect(envelope.sourceSeqs).toContain(seqDirect);
    const seqB = taskByCause(f.h.db, "chiming_in").source_through_seq;
    expect(envelope.sourceSeqs).toContain(seqB);

    // The projection reached the FIRST score (not only post-intent child material), and the
    // facts-driven low score consumes the batch silently: zero children, zero sends, exactly
    // one score call — no second score, no extra coordination call.
    await waitFor(() => taskByCause(f.h.db, "chiming_in").status === "no_output");
    expect(phaseCount(f.phases, "autonomy-child")).toBe(0);
    expect(f.sends).toHaveLength(0);
    expect(phaseCount(f.phases, "autonomy-score")).toBe(1);

    f.decisionGates.get(seqDirect)!.release();
    await waitFor(() => taskByCause(f.h.db, "direct_reply").status === "completed");
    await f.bot.scheduler.waitForIdle();
    expect(phaseCount(f.phases, "direct-decision")).toBe(1);
    expect(phaseCount(f.phases, "autonomy-score")).toBe(1);
    expect(phaseCount(f.phases, "autonomy-child")).toBe(0);
    expect(f.sends).toHaveLength(1);
    expect(JSON.stringify(f.sends[0]!.request)).toContain(`direct-${A}`);
  });

  it("distinct mention tasks in the same group stay concurrent with no added waiting, and each later decision sees the other job as a truthful running background fact", async () => {
    const f = composeFixture({ autonomyScore: 10 });
    f.receive("72001", A, "mention from A", true);
    const seqA = taskByCause(f.h.db, "direct_reply").source_through_seq;
    f.decisionGates.set(seqA, controlledGate());
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.phases.includes("direct-decision"));
    expect(taskRows(f.h.db)[0]!.status).toBe("running");

    f.receive("72002", B, "mention from B", true);
    const seqB = taskRows(f.h.db)[1]!.source_through_seq;
    f.decisionGates.set(seqB, controlledGate());
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => phaseCount(f.phases, "direct-decision") === 2);

    // Both tasks run at the same time behind default limits (the projection adds no waiting,
    // no merge, no whole-room block); their frozen claims stay distinct.
    const mid = taskRows(f.h.db);
    expect(mid.map((task) => task.status)).toEqual(["running", "running"]);
    expect(mid[0]!.origin_event_key).not.toBe(mid[1]!.origin_event_key);
    expect(mid[0]!.source_from_seq).toBe(mid[0]!.source_through_seq);
    expect(mid[1]!.source_from_seq).toBe(mid[1]!.source_through_seq);
    const snapshots = mid.map(
      (task) => JSON.parse(task.execution_snapshot!) as Record<string, unknown>,
    );
    expect(snapshots.map((snap) => snap.taskClass)).toEqual(["mention", "mention"]);
    expect(snapshots[0]!.authorizedTargets).toEqual([A]);
    expect(snapshots[1]!.authorizedTargets).toEqual([B]);
    expect(snapshots[0]!.mentionTaskLimit).toBe(4);
    expect(snapshots[1]!.mentionTaskLimit).toBe(4);

    // Facts reach the normal reply decision of the LATER task: B's decision sees A's gated
    // mention job as a running background fact owned by that job (A's own task is excluded
    // from its own projection; A's decision ran before B's task existed).
    const dumpsAfterSecond = f.decisionJobDumps.filter((dump) => dump !== null);
    expect(dumpsAfterSecond.length).toBeGreaterThanOrEqual(1);
    const seenByB = dumpsAfterSecond[dumpsAfterSecond.length - 1]!;
    expect(seenByB.jobs).toHaveLength(1);
    expect(seenByB.jobs[0]!.taskId).toBe(mid[0]!.id);
    expect(seenByB.jobs[0]!.cause).toBe("direct_reply");
    expect(seenByB.jobs[0]!.status).toBe("running");
    expect(seenByB.jobs[0]!.questionSeq).toBe(seqA);
    for (const dump of dumpsAfterSecond) {
      for (const job of dump.jobs) expect(job.taskId).not.toBe(mid[1]!.id);
    }

    // Releasing B first lets B settle and deliver while A is still parked on its gate.
    f.decisionGates.get(seqB)!.release();
    await waitFor(() => taskRows(f.h.db)[1]!.status === "completed");
    expect(taskRows(f.h.db)[0]!.status).toBe("running");
    expect(f.sends).toHaveLength(1);
    expect(JSON.stringify(f.sends[0]!.request)).toContain(`direct-${B}`);

    f.decisionGates.get(seqA)!.release();
    await f.bot.scheduler.waitForIdle();
    expect(taskRows(f.h.db).map((task) => task.status)).toEqual(["completed", "completed"]);
    const intents = intentRows(f.h.db);
    expect(intents.map((intent) => [intent.participant, intent.status]).sort()).toEqual([
      [A, "confirmed"],
      [B, "confirmed"],
    ]);
    expect(new Set(intents.map((intent) => intent.st))).toEqual(new Set([seqA, seqB]));
    expect(f.sends).toHaveLength(2);
    const bodies = f.sends.map((send) => JSON.stringify(send.request));
    expect(bodies.some((body) => body.includes(`direct-${A}`))).toBe(true);
    expect(bodies.some((body) => body.includes(`direct-${B}`))).toBe(true);
    expect(phaseCount(f.phases, "direct-decision")).toBe(2);
    expect(phaseCount(f.phases, "autonomy-score")).toBe(0);
  });

  it("an independent ordinary question still scores high and its autonomy child completes while the direct job stays gated (parallel preserved)", async () => {
    const f = composeFixture({ autonomyScore: 10 });
    f.receive("73001", A, "direct question from A", true);
    const seqDirect = taskByCause(f.h.db, "direct_reply").source_through_seq;
    f.decisionGates.set(seqDirect, controlledGate());
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.phases.includes("direct-decision"));

    f.receive("73002", B, "independent question from B", false);
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.phases.includes("autonomy-score"));
    const envelope = f.batchEnvelopes[0]!;
    expect(envelope.targets.map((target) => target.targetId)).toEqual([B]);
    expect(envelope.sourceSeqs).toContain(seqDirect);
    const seqB = taskByCause(f.h.db, "chiming_in").source_through_seq;
    expect(envelope.sourceSeqs).toContain(seqB);

    // The projection is present in the score input: same data_only contract, the gated direct
    // job is marked as running background with its own question seq — the judge may still
    // find new value in B's independent question.
    const jobs = f.scoreJobDumps[0]!;
    expect(jobs).not.toBeNull();
    expect(jobs!.jobs).toHaveLength(1);
    expect(jobs!.jobs[0]!.cause).toBe("direct_reply");
    expect(jobs!.jobs[0]!.status).toBe("running");
    expect(jobs!.jobs[0]!.questionSeq).toBe(seqDirect);
    expect(jobs!.jobs[0]!.taskId).toBe(taskByCause(f.h.db, "direct_reply").id);

    // The high score keeps the same contract: refs [direct seq, B seq] pass, one child commits
    // and delivers for B while the direct decision is still parked.
    await waitFor(() => taskByCause(f.h.db, "chiming_in").status === "completed");
    expect(phaseCount(f.phases, "autonomy-child")).toBe(1);
    expect(f.sends).toHaveLength(1);
    expect(JSON.stringify(f.sends[0]!.request)).toContain(`autonomy-${B}`);
    expect(phaseCount(f.phases, "direct-decision")).toBe(1);

    f.decisionGates.get(seqDirect)!.release();
    await waitFor(() => taskByCause(f.h.db, "direct_reply").status === "completed");
    await f.bot.scheduler.waitForIdle();

    const intents = intentRows(f.h.db);
    expect(intents.map((intent) => [intent.speech_kind, intent.status])).toEqual([
      ["chiming_in", "confirmed"],
      ["direct_reply", "confirmed"],
    ]);
    expect(new Set(intents.map((intent) => intent.st))).toEqual(new Set([seqDirect, seqB]));
    expect(intents.find((intent) => intent.speech_kind === "chiming_in")?.participant).toBe(B);
    expect(intents.find((intent) => intent.speech_kind === "direct_reply")?.participant).toBe(A);
    expect(f.sends).toHaveLength(2);
    const bodies = f.sends.map((send) => JSON.stringify(send.request));
    expect(bodies.some((body) => body.includes(`direct-${A}`))).toBe(true);
    expect(bodies.some((body) => body.includes(`autonomy-${B}`))).toBe(true);
    expect(phaseCount(f.phases, "autonomy-score")).toBe(1);
    expect(phaseCount(f.phases, "direct-decision")).toBe(1);
    expect(phaseCount(f.phases, "autonomy-child")).toBe(1);
  });
});
