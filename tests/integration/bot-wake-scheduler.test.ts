import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WakeScheduler } from "../../src/server/conversation/wake-scheduler";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});
const at = "2030-01-01T00:00:00.000Z";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bot-global-lease-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const first = openBusinessDb({ path: join(dir, "business.db") });
  ensureDefaults(first.orm, "model");
  const second = openBusinessDb({ path: join(dir, "business.db") });
  cleanups.push(
    () => first.close(),
    () => second.close(),
  );
  const journal = new ConversationEventRepository(first.db);
  first.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','test',?,?)")
    .run(at, at);
  const ids = ["200", "300"].map((peer) => {
    first.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'100','group',?,?,'scheme',?,?)",
      )
      .run(peer, peer, DEFAULT_AGENT_ID, at, at);
    return journal.ensureOneBot(peer)!.id;
  });
  return {
    first,
    second,
    journal,
    ids,
    a: new WakeRepository(first.db),
    b: new WakeRepository(second.db),
  };
}
function offer(h: ReturnType<typeof fixture>, index: number, key: string, seq = 1, time = at) {
  return h.a.enqueue({
    conversationId: h.ids[index]!,
    cause: "chiming_in",
    dedupeKey: key,
    throughSeq: seq,
    readyAt: at,
    priority: 50,
    at: time,
  });
}
describe("durable cross-process Bot concurrency", () => {
  it("atomically shares one default slot across two SQLite handles, renews, and recovers after expiry", () => {
    const h = fixture();
    offer(h, 0, "a");
    offer(h, 1, "b", 1, "2030-01-01T00:00:00.001Z");
    const one = h.a.claim({ at: "2030-01-01T00:00:00.002Z", leaseMs: 1000 })!;
    expect(one.conversationId).toBe(h.ids[1]!);
    expect(h.b.claim({ at, leaseMs: 1000 })).toBeNull();
    expect(h.a.renew(one.id, one.leaseToken!, at, 2000)).toBe(true);
    expect(h.b.claim({ at: "2030-01-01T00:00:01.500Z", leaseMs: 1000 })).toBeNull();
    h.b.recover({ at: "2030-01-01T00:00:02.100Z", maxAttempts: 3, retryDelayMs: 100 });
    expect(h.b.claim({ at: "2030-01-01T00:00:02.100Z", leaseMs: 1000 })?.conversationId).toBe(
      h.ids[0]!,
    );
  });
  it("allows configured two slots but never concurrent runs for the same conversation", () => {
    const h = fixture();
    offer(h, 0, "a");
    offer(h, 0, "a2");
    offer(h, 1, "b");
    const one = h.a.claim({ at, leaseMs: 1000, globalConcurrency: 2 })!;
    const two = h.b.claim({ at, leaseMs: 1000, globalConcurrency: 2 })!;
    expect(one.conversationId).not.toBe(two.conversationId);
    expect(h.a.claim({ at, leaseMs: 1000, globalConcurrency: 3 })).toBeNull();
  });
  it("compares activity time across conversations instead of incomparable local sequence values", () => {
    const h = fixture();
    offer(h, 0, "old", 1000, "2029-12-31T23:59:59.000Z");
    offer(h, 1, "new", 1, at);
    expect(h.a.claim({ at, leaseMs: 1000 })?.conversationId).toBe(h.ids[1]!);
  });
  it("appends one metadata wake event on creation, merges opportunity without moving source cursor", () => {
    const h = fixture();
    const wake = offer(h, 0, "merge");
    offer(h, 0, "merge", 20, "2030-01-01T00:00:01.000Z");
    expect(h.journal.eventsAfter(h.ids[0]!).items).toMatchObject([
      { kind: "wake", source: { kind: "wake", id: wake.id } },
    ]);
    expect(h.journal.sourceThroughSeq(h.ids[0]!)).toBe(0);
    expect(h.a.get(wake.id)!.throughSeq).toBe(20);
  });
  it("ordinary merge waits for latest ready time; completing direct work does not swallow idle", () => {
    const h = fixture();
    const c = h.ids[0]!;
    h.a.enqueue({
      conversationId: c,
      cause: "chiming_in",
      dedupeKey: "merge",
      throughSeq: 1,
      readyAt: at,
      priority: 1,
      at,
      mergeReadyAt: "latest",
    });
    h.a.enqueue({
      conversationId: c,
      cause: "chiming_in",
      dedupeKey: "merge",
      throughSeq: 2,
      readyAt: "2030-01-01T00:00:10.000Z",
      priority: 1,
      at,
      mergeReadyAt: "latest",
    });
    expect(h.a.peek({ at })).toBeNull();
    const direct = h.a.enqueue({
      conversationId: c,
      cause: "direct_reply",
      dedupeKey: "direct",
      throughSeq: 2,
      readyAt: at,
      priority: 100,
      at,
    });
    h.a.enqueue({
      conversationId: c,
      cause: "idle_topic",
      dedupeKey: "idle",
      throughSeq: 2,
      readyAt: at,
      priority: 0,
      at,
    });
    const lease = h.a.claim({ at, leaseMs: 1000 })!;
    expect(lease.id).toBe(direct.id);
    h.a.complete(lease.id, lease.leaseToken!, "no_output", 2, at);
    expect(h.a.peek({ at })?.cause).toBe("idle_topic");
  });
});

it("publishes stable error codes without exposing failure text", async () => {
  const h = fixture();
  const wake = offer(h, 0, "typed-error");
  const scheduler = new WakeScheduler({
    repository: h.a,
    policy: () => ({ leaseMs: 1000, renewMs: 500, retryDelayMs: 100, maxAttempts: 1 }),
    now: () => at,
    activate: async () => {
      throw Object.assign(new Error("private model response and local path"), {
        code: "CONTEXT_MEMORY_BUDGET",
      });
    },
  });
  expect(await scheduler.runOnce()).toBe(true);
  expect(h.a.get(wake.id)?.errorCode).toBe("CONTEXT_MEMORY_BUDGET");
  scheduler.stop();
  const next = offer(h, 1, "opaque-error");
  const opaque = new WakeScheduler({
    repository: h.a,
    policy: () => ({ leaseMs: 1000, renewMs: 500, retryDelayMs: 100, maxAttempts: 1 }),
    now: () => at,
    activate: async () => {
      throw Object.assign(new Error("private model response and local path"), {
        code: "sensitive lowercase payload",
      });
    },
  });
  expect(await opaque.runOnce()).toBe(true);
  expect(h.a.get(next.id)?.errorCode).toBe("BOT_RUN_FAILED");
  opaque.stop();
});
