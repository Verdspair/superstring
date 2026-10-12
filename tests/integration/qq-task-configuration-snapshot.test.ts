// Production-composed regression for ordinary scheme edits made after a QQ task is claimed.
// Uses the migrated synthetic business DB, real ingress/task scheduler/host, and a finite model gate.
import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import {
  createQqScheme,
  readQqScheme,
  restoreQqSchemeSnapshot,
  schemeResponse,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  claimNextQqConversationTask,
  recoverQqConversationTaskLease,
} from "../../src/server/db/qq-task-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { cloneBusinessDb } from "../harness/business-db";

const ACCOUNT_ID = "10001";
type Task = {
  id: string;
  status: string;
  error_code: string | null;
  source_through_seq: number;
  execution_snapshot: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
};
const tasks = (db: BusinessDbHandle["db"]): Task[] =>
  db
    .query(
      "SELECT id,status,error_code,source_through_seq,execution_snapshot,lease_token,lease_expires_at FROM qq_conversation_tasks ORDER BY rowid",
    )
    .all() as Task[];
const authorizedTarget = (request: ModelRequest): string =>
  JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1] ?? "20002";
const finalReply = (target: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId: target, text }] });
const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WAIT_TIMEOUT");
    await Bun.sleep(5);
  }
};

const composed: ReturnType<typeof createOneBotConversationRuntime>[] = [];
const handles: BusinessDbHandle[] = [];
const pendingGates: (() => void)[] = [];
afterEach(async () => {
  for (const release of pendingGates.splice(0)) release();
  for (const bot of composed.splice(0)) {
    bot.scheduler.stop();
    await bot.scheduler.waitForIdle().catch(() => {});
    bot.delivery.stop();
    await bot.delivery.waitForIdle().catch(() => {});
    bot.release();
  }
  for (const handle of handles.splice(0)) handle.close();
});

function setup(model: ModelPort) {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const journal = new ConversationEventRepository(h.db);
  const wakes = new WakeRepository(h.db);
  const outbox = new OutboundIntentRepository(h.db);
  const runs = new AgentRunRepository(h.db);
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => nowSeconds,
  });
  const scheme = createQqScheme(h.orm, {
    name: "ordinary-config-snapshot",
    description: "description before claim",
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
    reply: { split_by_speaker: true },
  });
  const bindingId = crypto.randomUUID();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(
      bindingId,
      DEFAULT_AGENT_ID,
      scheme.id,
      new Date(nowSeconds * 1000).toISOString(),
      new Date(nowSeconds * 1000).toISOString(),
    );
  const receive = (messageId: string, text: string) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: nowSeconds,
        self_id: 10001,
        user_id: 20002,
        group_id: 30003,
        message_id: messageId,
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text } },
        ],
        sender: { nickname: "20002" },
      },
      ACCOUNT_ID,
    );
    expect(normalized.kind).toBe("message");
    return recordInbound(h.orm, normalized, {
      accountId: ACCOUNT_ID,
      conversationIngress: adapter,
    });
  };
  const sends: unknown[] = [];
  const runtime = new AgentRuntime({
    repository: runs,
    now: () => new Date().toISOString(),
    model,
  });
  const gateway = {
    complete: async () => {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    loadedContextCapacity: async () => 65536,
  };
  const bot = createOneBotConversationRuntime({
    orm: h.orm,
    db: h.db,
    gateway,
    agentRuntime: runtime,
    host: new ConversationHost({ runtime }),
    journal,
    store: new QqStickerStore({ directory: "synthetic-qq-stickers" }),
    port: {
      async send(request) {
        sends.push(request);
        return { kind: "confirmed", messageId: String(100000 + sends.length) };
      },
    },
    wake: () => {},
    policy: () => ({
      maxSteps: 20,
      deliveryTtlSeconds: 600,
      retryDelayMs: 1000,
      maxAttempts: 3,
      globalConcurrency: 4,
      modelCallConcurrency: 1,
    }),
  });
  composed.push(bot);
  return { h, scheme, receive, bot, outbox, sends };
}

describe("QQ claimed task configuration snapshot", () => {
  it("continues one claimed task with its frozen ordinary scheme and uses the new revision for later work", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    pendingGates.push(releaseGate);
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    let firstRequest: ModelRequest | null = null;
    let callCount = 0;
    const model: ModelPort = {
      complete: async (request) => {
        callCount += 1;
        if (callCount === 1) {
          firstRequest = request;
          await Promise.race([
            gate,
            new Promise<never>((_, reject) => {
              gateTimer = setTimeout(() => reject(new Error("CONFIG_GATE_TIMEOUT")), 4000);
            }),
          ]).finally(() => clearTimeout(gateTimer));
          return finalReply(authorizedTarget(request), "reply from original snapshot");
        }
        return finalReply(authorizedTarget(request), "reply from later snapshot");
      },
      async *streamText() {
        yield "";
      },
      completeMultimodal: async () => "",
    };
    const f = setup(model);
    const first = f.receive("93001", "configuration snapshot first task");
    expect(first.kind).toBe("recorded");
    const [claimedCandidate] = tasks(f.h.db);
    if (!claimedCandidate) throw new Error("FIRST_TASK_NOT_REGISTERED");

    // Real scheduler claim freezes the production execution snapshot before model work blocks.
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => firstRequest !== null || tasks(f.h.db)[0]?.status !== "running");
    if (firstRequest === null) {
      const diagnostic = {
        task: tasks(f.h.db)[0] ?? null,
        runs: f.h.db
          .query("SELECT spec_id,status,error_code FROM agent_runs ORDER BY started_at,rowid")
          .all(),
        steps: f.h.db
          .query("SELECT phase,status,error_code FROM agent_steps ORDER BY started_at,rowid")
          .all(),
      };
      throw new Error(`MODEL_GATE_NOT_REACHED:${JSON.stringify(diagnostic)}`);
    }
    const [claimed] = tasks(f.h.db);
    if (!claimed?.execution_snapshot || !claimed.lease_token)
      throw new Error("FIRST_TASK_NOT_CLAIMED_WITH_SNAPSHOT_AND_LEASE");
    const originalSnapshotJson = claimed.execution_snapshot;
    const oldSnapshot = JSON.parse(originalSnapshotJson) as Record<string, unknown>;
    expect(claimed.status).toBe("running");
    expect(oldSnapshot.schemeRevision).toBe(f.scheme.revision);

    // A formal ordinary description save advances the scheme revision, not binding authority.
    const changedScheme = updateQqScheme(f.h.orm, f.scheme.id, {
      name: f.scheme.name,
      description: "description saved while task is gated",
      expectedRevision: f.scheme.revision,
    });
    expect(changedScheme.revision).toBe(f.scheme.revision + 1);
    expect(readQqScheme(f.h.orm, f.scheme.id)?.description).toBe(
      "description saved while task is gated",
    );
    expect(tasks(f.h.db)[0]?.status).toBe("running");

    releaseGate();
    await f.bot.scheduler.waitForIdle();
    const [completed] = tasks(f.h.db);
    expect(completed).toMatchObject({ status: "completed", error_code: null });
    expect(JSON.parse(completed!.execution_snapshot!) as Record<string, unknown>).toEqual(
      oldSnapshot,
    );
    expect(f.h.db.query("SELECT status FROM outbound_intents ORDER BY rowid").all()).toEqual([
      { status: "confirmed" },
    ]);
    expect(f.sends).toHaveLength(1);

    // A distinct later message claims normally and records the now-current scheme revision.
    const second = f.receive("93002", "configuration snapshot second task");
    expect(second.kind).toBe("recorded");
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await f.bot.scheduler.waitForIdle();
    const done = tasks(f.h.db);
    expect(done.map((task) => task.status)).toEqual(["completed", "completed"]);
    const laterSnapshot = JSON.parse(done[1]!.execution_snapshot!) as Record<string, unknown>;
    expect(laterSnapshot.schemeRevision).toBe(changedScheme.revision);
    expect(f.h.db.query("SELECT status FROM outbound_intents ORDER BY rowid").all()).toEqual([
      { status: "confirmed" },
      { status: "confirmed" },
    ]);
    expect(f.sends).toHaveLength(2);
    expect(callCount).toBe(2);
  });

  it("recovers the exact claimed scheme snapshot after an ordinary edit", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    pendingGates.push(releaseGate);
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    let firstRequest: ModelRequest | null = null;
    const model: ModelPort = {
      complete: async (request) => {
        firstRequest = request;
        await Promise.race([
          gate,
          new Promise<never>((_, reject) => {
            gateTimer = setTimeout(() => reject(new Error("RECOVERY_GATE_TIMEOUT")), 4000);
          }),
        ]).finally(() => clearTimeout(gateTimer));
        return finalReply(authorizedTarget(request), "reply after recovery");
      },
      async *streamText() {
        yield "";
      },
      completeMultimodal: async () => "",
    };
    const f = setup(model);
    expect(f.receive("93011", "snapshot recovery task").kind).toBe("recorded");
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => firstRequest !== null || tasks(f.h.db)[0]?.status !== "running");
    if (firstRequest === null)
      throw new Error(`RECOVERY_MODEL_GATE_NOT_REACHED:${JSON.stringify(tasks(f.h.db)[0])}`);

    const [claimed] = tasks(f.h.db);
    if (!claimed?.execution_snapshot || !claimed.lease_token || !claimed.lease_expires_at)
      throw new Error("RECOVERY_TASK_MISSING_SNAPSHOT_OR_LEASE");
    const originalSnapshotJson = claimed.execution_snapshot;
    const originalSnapshot = JSON.parse(originalSnapshotJson) as Record<string, unknown>;
    const frozenScheme = originalSnapshot.schemeConfig as Record<string, unknown>;
    expect(claimed.status).toBe("running");
    expect(frozenScheme).toMatchObject({
      id: f.scheme.id,
      revision: f.scheme.revision,
      name: f.scheme.name,
      description: "description before claim",
    });

    const changedScheme = updateQqScheme(f.h.orm, f.scheme.id, {
      name: f.scheme.name,
      description: "description changed before recovery",
      expectedRevision: f.scheme.revision,
    });
    expect(changedScheme.revision).toBe(f.scheme.revision + 1);
    const currentScheme = readQqScheme(f.h.orm, f.scheme.id);
    expect(currentScheme?.description).toBe("description changed before recovery");
    if (!currentScheme) throw new Error("RECOVERY_SCHEME_MISSING");
    const restored = restoreQqSchemeSnapshot(
      currentScheme,
      frozenScheme as unknown as QqSchemeResponse,
    );
    const restoredResponse = schemeResponse(f.h.orm, restored);
    expect(restoredResponse).toEqual(frozenScheme as unknown as QqSchemeResponse);
    expect(restoredResponse).toMatchObject({
      id: f.scheme.id,
      revision: f.scheme.revision,
      name: f.scheme.name,
      description: "description before claim",
    });

    const recoveredAt = claimed.lease_expires_at;
    expect(
      recoverQqConversationTaskLease(f.h.orm, {
        taskId: claimed.id,
        leaseToken: claimed.lease_token,
        at: recoveredAt,
        resolveExistingRunAndOutbox: () => "resume",
      }),
    ).toBe("resume");
    const [pending] = tasks(f.h.db);
    expect(pending).toMatchObject({ status: "pending", execution_snapshot: originalSnapshotJson });
    expect(pending?.lease_token).toBeNull();

    const reclaimedAt = new Date(Date.parse(recoveredAt) + 1).toISOString();
    const newLease = "snapshot-recovery-new-lease";
    const reclaimed = claimNextQqConversationTask(f.h.orm, {
      at: reclaimedAt,
      leaseToken: newLease,
      leaseExpiresAt: new Date(Date.parse(reclaimedAt) + 60_000).toISOString(),
      limitsFor: () => ({ mentionTaskLimit: 4, ordinaryTaskLimit: 1 }),
      sourceState: () => "valid",
      freezeAtClaim: () => {
        throw new Error("RECOVERY_MUST_REUSE_ORIGINAL_SNAPSHOT");
      },
    });
    expect(reclaimed?.task.executionSnapshot).toBe(originalSnapshotJson);
    expect(JSON.parse(reclaimed!.task.executionSnapshot!) as Record<string, unknown>).toEqual(
      originalSnapshot,
    );

    releaseGate();
    await f.bot.scheduler.waitForIdle();
    const [rowAfterOldWorker] = tasks(f.h.db);
    expect(rowAfterOldWorker).toMatchObject({ status: "running", lease_token: newLease });
    expect(rowAfterOldWorker?.execution_snapshot).toBe(originalSnapshotJson);
    expect(f.h.db.query("SELECT status FROM outbound_intents ORDER BY rowid").all()).toEqual([]);
    expect(f.sends).toHaveLength(0);
  });
});
