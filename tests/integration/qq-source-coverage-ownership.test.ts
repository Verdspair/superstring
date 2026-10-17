import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
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
const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_FOR_PRODUCTION_CASE");
    await Bun.sleep(5);
  }
};
const isBatchScore = (request: ModelRequest): boolean =>
  (request.responseSchema as { properties?: Record<string, unknown> } | undefined)?.properties
    ?.evaluations !== undefined;
const isDecision = (request: ModelRequest): boolean =>
  Array.isArray((request.responseSchema as { oneOf?: unknown } | undefined)?.oneOf);
const activationCause = (request: ModelRequest): string | null => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const parsed = JSON.parse(part.text) as { kind?: string; value?: { cause?: string } };
        if (parsed.kind === "activation_trigger") return parsed.value?.cause ?? null;
      } catch {}
    }
  }
  return null;
};
const authorizedTarget = (request: ModelRequest): string => {
  const targetId = JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1];
  if (!targetId) throw new Error("AUTHORIZED_TARGET_MISSING");
  return targetId;
};
type BatchTargets = { kind: string; targets: { targetId: string }[] };
const batchTargets = (request: ModelRequest): BatchTargets | null => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const parsed = JSON.parse(part.text) as BatchTargets;
        if (parsed.kind === "qq_batch_targets" && Array.isArray(parsed.targets)) return parsed;
      } catch {}
    }
  }
  return null;
};
const inlineReply = (targetId: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });

const openTasks = new Set<ReturnType<typeof composeFixture>>();
const openHandles: BusinessDbHandle[] = [];
afterEach(async () => {
  for (const fixture of openTasks) {
    fixture.releaseGates();
    fixture.bot.scheduler.stop();
    await fixture.bot.scheduler.waitForIdle().catch(() => {});
    fixture.bot.delivery.stop();
    await fixture.bot.delivery.waitForIdle().catch(() => {});
    fixture.bot.release();
    openTasks.delete(fixture);
  }
  for (const handle of openHandles.splice(0)) handle.close();
});

function composeFixture(options: {
  batchSize: 1 | 2;
  gateScore?: boolean;
  gateOldGeneration?: boolean;
}) {
  const h: BusinessDbHandle = cloneBusinessDb();
  openHandles.push(h);
  ensureDefaults(h.orm, "coverage-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: `source-coverage-${crypto.randomUUID()}`,
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
    reply: { split_by_speaker: true },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      participation_timing: "resource_window",
      initiative_batch_target_count: options.batchSize,
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
  const outbox = new OutboundIntentRepository(h.db);
  let resolveScore: () => void = () => {};
  let releaseScore: () => void = () => {};
  const scoreReached = new Promise<void>((resolve) => {
    resolveScore = resolve;
  });
  const scoreGate = new Promise<void>((resolve) => {
    releaseScore = resolve;
  });
  let resolveGeneration: () => void = () => {};
  let releaseGeneration: () => void = () => {};
  const generationReached = new Promise<void>((resolve) => {
    resolveGeneration = resolve;
  });
  const generationGate = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  let scoreSignal: AbortSignal | undefined;
  let oldGenerationSignal: AbortSignal | undefined;
  const childTargets: string[] = [];
  const calls: { phase: string; target: string | null }[] = [];
  const model: ModelPort = {
    async complete(request) {
      if (isBatchScore(request)) {
        calls.push({ phase: "ordinary-score", target: null });
        if (options.gateScore && scoreSignal === undefined) {
          scoreSignal = request.signal;
          resolveScore();
          await scoreGate;
        }
        const payload = batchTargets(request);
        if (!payload) throw new Error("SCORE_TARGETS_MISSING");
        return JSON.stringify({
          evaluations: payload.targets.map((target) => ({
            targetId: target.targetId,
            score: 10,
            intent: `intent-${target.targetId}`,
            sourceSeqs: [],
          })),
        });
      }
      if (!isDecision(request)) return "{}";
      const cause = activationCause(request);
      const targetId = authorizedTarget(request);
      if (cause === "direct_reply") {
        calls.push({ phase: "direct-reply", target: targetId });
        return inlineReply(targetId, `direct-${targetId}`);
      }
      childTargets.push(targetId);
      calls.push({ phase: "ordinary-child", target: targetId });
      if (options.gateOldGeneration) {
        return JSON.stringify({
          kind: "final",
          outputs: [{ kind: "generate", targetId, instructions: "ordinary reply" }],
        });
      }
      return inlineReply(targetId, `ordinary-${targetId}`);
    },
    async *streamText(request) {
      oldGenerationSignal = request.signal;
      resolveGeneration();
      await generationGate;
      request.signal?.throwIfAborted();
      yield `ordinary-${A}`;
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
    store: new QqStickerStore({ directory: "synthetic-source-coverage-stickers" }),
    port: {
      async send(request) {
        sends.push({ peerId: request.peerId, request });
        return { kind: "confirmed", messageId: String(30000 + sends.length) };
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
  const fixture = {
    h,
    bot,
    journal,
    outbox,
    sends,
    calls,
    childTargets,
    receive,
    scoreReached,
    generationReached,
    scoreSignal: () => scoreSignal,
    oldGenerationSignal: () => oldGenerationSignal,
    releaseGates() {
      releaseScore();
      releaseGeneration();
    },
  };
  openTasks.add(fixture);
  return fixture;
}

const taskRow = (db: Database, cause: "chiming_in" | "direct_reply") =>
  db
    .query(
      "SELECT id,status,execution_snapshot,source_through_seq FROM qq_conversation_tasks WHERE cause=? ORDER BY rowid LIMIT 1",
    )
    .get(cause) as {
    id: string;
    status: string;
    execution_snapshot: string | null;
    source_through_seq: number;
  } | null;
const confirmedIntentCount = (db: Database, cause: string, participant: string) =>
  db
    .query(
      "SELECT COUNT(*) AS n FROM outbound_intents WHERE speech_kind=? AND status='confirmed' AND json_extract(target,'$.participantId')=?",
    )
    .get(cause, participant) as { n: number };

describe("QQ source coverage ownership (production composition)", () => {
  it("aborts a claimed single-target ordinary task before releasing its gated generation", async () => {
    const f = composeFixture({ batchSize: 1, gateOldGeneration: true });
    expect(f.receive("63001", A, "old ordinary A", false).kind).toBe("recorded");
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.oldGenerationSignal() !== undefined);
    const old = taskRow(f.h.db, "chiming_in");
    expect(old?.status).toBe("running");
    const oldSignal = f.oldGenerationSignal();
    expect(oldSignal).toBeDefined();
    expect(oldSignal?.aborted).toBe(false);

    expect(f.receive("63002", A, "new direct A", true).kind).toBe("recorded");
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => taskRow(f.h.db, "direct_reply")?.status === "completed");
    expect(confirmedIntentCount(f.h.db, "direct_reply", A).n).toBe(1);
    expect(f.sends).toHaveLength(1);

    // The older provider gate is deliberately still closed at this assertion.
    expect(oldSignal?.aborted).toBe(true);
    f.releaseGates();
    await f.bot.scheduler.waitForIdle();
    expect(f.sends).toHaveLength(1);
    expect(confirmedIntentCount(f.h.db, "chiming_in", A).n).toBe(0);
  });

  it("keeps a two-target parent snapshot intact and launches only the uncovered child", async () => {
    const f = composeFixture({ batchSize: 2, gateScore: true });
    expect(f.receive("64001", A, "ordinary A", false).kind).toBe("recorded");
    expect(f.receive("64002", B, "ordinary B", false).kind).toBe("recorded");
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await f.scoreReached;
    const old = taskRow(f.h.db, "chiming_in");
    expect(old?.status).toBe("running");
    const snapshotBefore = old?.execution_snapshot;
    expect(snapshotBefore).toBeTruthy();
    const frozen = JSON.parse(snapshotBefore ?? "") as {
      authorizedTargets: string[];
      targetParticipants: { targetId: string; speakerId: string | null }[];
    };
    expect([...frozen.authorizedTargets].sort()).toEqual([A, B]);
    expect(frozen.targetParticipants.map((target) => target.targetId).sort()).toEqual([A, B]);
    expect(f.scoreSignal()?.aborted).toBe(false);

    expect(f.receive("64003", A, "direct A", true).kind).toBe("recorded");
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => taskRow(f.h.db, "direct_reply")?.status === "completed");
    expect(confirmedIntentCount(f.h.db, "direct_reply", A).n).toBe(1);
    expect(f.scoreSignal()?.aborted).toBe(false);
    expect(taskRow(f.h.db, "chiming_in")?.status).toBe("running");

    f.releaseGates();
    await f.bot.scheduler.waitForIdle();
    const oldAfter = taskRow(f.h.db, "chiming_in");
    expect(oldAfter?.execution_snapshot).toBe(snapshotBefore);
    expect(JSON.parse(oldAfter?.execution_snapshot ?? "")).toEqual(frozen);
    expect(oldAfter?.status).toBe("completed");
    expect(f.childTargets).toEqual([B]);
    expect(confirmedIntentCount(f.h.db, "direct_reply", A).n).toBe(1);
    expect(confirmedIntentCount(f.h.db, "chiming_in", A).n).toBe(0);
    expect(confirmedIntentCount(f.h.db, "chiming_in", B).n).toBe(1);
  });
});
