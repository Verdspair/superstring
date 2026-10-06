import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { handleError } from "../../src/server/api/error-handler";
import { parseSseFrames } from "../../src/server/api/sse";
import {
  type ConversationChange,
  subscribeConversationChanges,
} from "../../src/server/conversation/conversation-changes";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

const at = "2030-01-01T00:00:00.000Z";

/** Binds one OneBot group conversation (wake/claim paths need channel=onebot11). */
function fixture() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "model");
  cleanups.push(() => business.close());
  business.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','test',?,?)")
    .run(at, at);
  business.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','100','group','200',?,'scheme',?,?)",
    )
    .run(DEFAULT_AGENT_ID, at, at);
  const journal = new ConversationEventRepository(business.db);
  const conversationId = journal.ensureOneBot("binding")!.id;
  return { db: business.db, journal, conversationId };
}

/** Collects hub notifications; the flush is a microtask, so tick before asserting. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function collector(db: Parameters<typeof subscribeConversationChanges>[0]) {
  const changes: ConversationChange[] = [];
  const unsubscribe = subscribeConversationChanges(db, (change) => changes.push(change));
  return {
    changes,
    stop: unsubscribe,
    async drained() {
      await tick();
      const snapshot = [...changes];
      changes.length = 0;
      return snapshot;
    },
  };
}

describe("persisted state changes notify the conversation hub (same seq)", () => {
  it("wake claim / complete / defer / fail publish; recover reuses fail; renew does not", async () => {
    const h = fixture();
    const wakes = new WakeRepository(h.db);
    const seen = collector(h.db);
    const wake = wakes.enqueueChanged({
      conversationId: h.conversationId,
      cause: "chiming_in",
      dedupeKey: "w1",
      throughSeq: 1,
      readyAt: at,
      priority: 50,
      at,
    }).wake;
    // The enqueue wake event already publishes through the journal append.
    expect(await seen.drained()).toEqual([
      { conversationId: h.conversationId, seq: 1, bindingEpoch: 1 },
    ]);
    expect((await seen.drained()).length).toBe(0);

    const claimed = wakes.claim({ at, leaseMs: 60_000 });
    expect(claimed?.id).toBe(wake.id);
    const claimFrames = await seen.drained();
    expect(claimFrames.length).toBeGreaterThanOrEqual(1);
    expect(claimFrames.at(-1)).toEqual({
      conversationId: h.conversationId,
      seq: wake.throughSeq,
      bindingEpoch: 1,
    });

    // renew is lease bookkeeping only: no notification.
    expect(wakes.renew(wake.id, claimed!.leaseToken!, at, 120_000)).toBe(true);
    expect((await seen.drained()).length).toBe(0);

    // defer returns the wake to pending: a real status change.
    wakes.defer(wake.id, claimed!.leaseToken!, at, at);
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);

    // re-claim and fail (terminal): publish. recover must not double-notify a live lease.
    const again = wakes.claim({ at, leaseMs: 60_000 })!;
    await seen.drained();
    expect(
      wakes.fail(again.id, again.leaseToken!, {
        at,
        errorCode: "MODEL_UNAVAILABLE",
        maxAttempts: 1,
        retryDelayMs: 1000,
      }),
    ).toBe(true);
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    // Nothing leased remains: recover has nothing to change and must not publish.
    wakes.recover({ at, maxAttempts: 3, retryDelayMs: 1000 });
    expect((await seen.drained()).length).toBe(0);
    seen.stop();
  });

  it("silent eligibility no_output completes the wake without a failure code and publishes once", async () => {
    const h = fixture();
    const wakes = new WakeRepository(h.db);
    const seen = collector(h.db);
    const wake = wakes.enqueueChanged({
      conversationId: h.conversationId,
      cause: "direct_reply",
      dedupeKey: "w2",
      throughSeq: 1,
      readyAt: at,
      priority: 100,
      at,
    }).wake;
    wakes.claim({ at, leaseMs: 60_000 });
    await seen.drained();
    const leased = wakes.get(wake.id)!.leaseToken!;
    wakes.complete(wake.id, leased, "no_output", wake.throughSeq, at, []);
    const frames = await seen.drained();
    expect(frames.length).toBe(1);
    const settled = wakes.get(wake.id)!;
    expect(settled.status).toBe("no_output");
    expect(settled.errorCode).toBeNull();
    seen.stop();
  });

  it("agent run semantic status changes and terminal finish publish; output deltas do not", async () => {
    const h = fixture();
    const runs = new AgentRunRepository(h.db);
    const seen = collector(h.db);
    runs.createRun({
      runId: "run-1",
      specId: "qq-reply",
      specVersion: "1",
      owner: { kind: "conversation", id: h.conversationId, agentId: DEFAULT_AGENT_ID },
      at,
    });
    runs.setStatus("run-1", "deciding", at);
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    // Same-value repeat may notify; the hub coalesces per conversation within one flush.
    runs.setStatus("run-1", "deciding", at);
    runs.setStatus("run-1", "generating", at);
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    runs.appendEvent(
      "run-1",
      { type: "output_delta", outputId: "o1", text: "abc" },
      at,
      h.conversationId,
    );
    expect((await seen.drained()).length).toBe(0);
    runs.appendEvent("run-1", { type: "started" }, at, h.conversationId);
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    runs.finishRun("run-1", "no_output", { type: "no_output" }, at, {
      conversationId: h.conversationId,
    });
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    seen.stop();
  });

  it("task create, claim, approval wait, approve and settle publish through the hub", async () => {
    const h = fixture();
    const tasks = new AgentTaskRepository(h.db);
    const seen = collector(h.db);
    const task = tasks.enqueue({
      conversationId: h.conversationId,
      agentId: DEFAULT_AGENT_ID,
      dedupeKey: "task-1",
      sources: [],
      at,
      expiresAt: "2030-01-02T00:00:00.000Z",
      calls: [{ name: "web.search", revision: "1", effect: "read", arguments: { q: "x" } }],
    });
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    const claimed = tasks.claim(at, 60_000);
    expect(claimed?.id).toBe(task.id);
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    tasks.waitApproval(task.id, claimed!.leaseToken!, 0, "rev-1", at);
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    expect(tasks.approve(task.id, 0, "rev-1", at)).toBe(true);
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    tasks.settle(task.id, "completed", at);
    expect((await seen.drained()).length).toBeGreaterThanOrEqual(1);
    seen.stop();
  });

  it("the SSE stream carries same-seq frames for state-only changes", async () => {
    const h = fixture();
    const app = new Hono()
      .onError(handleError)
      .route("/v2/conversations", conversationRoutes(h.db, { includeShared: true }));
    const controller = new AbortController();
    const response = await app.request("/v2/conversations/changes", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
      { event: "ready", data: { ready: true } },
    ]);
    // The connect-time ensure frame (seq 0, no events yet) drains first.
    const ready = parseSseFrames(decoder.decode((await reader.read()).value!));
    expect(ready).toEqual([
      {
        event: "conversation_changed",
        data: { conversationId: h.conversationId, seq: 0, bindingEpoch: 1 },
      },
    ]);
    const wakes = new WakeRepository(h.db);
    wakes.enqueueChanged({
      conversationId: h.conversationId,
      cause: "chiming_in",
      dedupeKey: "w3",
      throughSeq: 1,
      readyAt: at,
      priority: 50,
      at,
    });
    const first = parseSseFrames(decoder.decode((await reader.read()).value!));
    expect(first).toEqual([
      {
        event: "conversation_changed",
        data: { conversationId: h.conversationId, seq: expect.any(Number), bindingEpoch: 1 },
      },
    ]);
    const firstSeq = (first[0]!.data as { seq: number }).seq;
    wakes.claim({ at, leaseMs: 60_000 });
    const second = parseSseFrames(decoder.decode((await reader.read()).value!));
    // Same seq as the enqueue frame: a state-only change with no new event row.
    expect(second).toEqual([
      {
        event: "conversation_changed",
        data: { conversationId: h.conversationId, seq: firstSeq, bindingEpoch: 1 },
      },
    ]);
    controller.abort();
    expect((await reader.read()).done).toBe(true);
  });
});
