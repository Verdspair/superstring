import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type BusinessDbHandle, toOrmHandle } from "../../src/server/db/connection";
import {
  listQqDispatchCandidates,
  readQqDispatchLease,
} from "../../src/server/db/qq-dispatch-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { BUSINESS_SCHEMA_VERSION, openBusinessDb } from "../../src/server/db/schema-gate";
import {
  QqRuntime,
  type QqRuntimeEvent,
  qqDispatchRunner,
} from "../../src/server/services/qq-runtime";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000;

function event(orm: Orm, key: string, at: number, text: string, peerId = "30003") {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId,
      messageId: key,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.qqObservationText)
    .values({
      eventKey: key,
      body: text,
      occurredAtSeconds: at,
      expiresAt: new Date((at + 3600) * 1000).toISOString(),
      recordedAt: nowIso(),
    })
    .run();
}

/** One account, one scheme that allows all four triggers, one bound group with two member messages. */
function seed(orm: Orm): void {
  ensureDefaults(orm, "synthetic-model");
  updateQqSettings(orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(orm, {
    name: "synthetic",
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: true },
  });
  orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  event(orm, "old-30003", now - 90, "旧消息");
  event(orm, "latest-30003", now - 40, "新消息");
}

/**
 * A migrated in-memory image, cloned per case — the business chain is 24 files, so replaying it
 * per case would dominate this file. `PRAGMA foreign_keys` is per connection and is re-applied
 * exactly as `connection.ts` does.
 */
const migratedImage = (() => {
  const h = openBusinessDb();
  const image = h.db.serialize();
  h.close();
  return image;
})();

function cloneBusinessDb(): BusinessDbHandle {
  const db = Database.deserialize(migratedImage);
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return toOrmHandle(db);
}

/** The sweep's quiet threshold is 15 minutes for the seeded scheme. */
const quietAt = now + 15 * 60;

describe("the runtime host fills the queue without spending a model call", () => {
  it("sweeps a quiet room, and reports the queue as filled rather than advanced", async () => {
    const h = cloneBusinessDb();
    try {
      seed(h.orm);
      const events: QqRuntimeEvent[] = [];
      const host = new QqRuntime({
        orm: h.orm,
        clockSeconds: () => quietAt,
        onEvent: (e) => events.push(e),
      });
      const cycle = await host.runCycle();
      expect(cycle.sweep.scheduled).toHaveLength(1);
      expect(cycle.sweep.scheduled[0]?.path).toBe("idle_topic");
      // No runner was wired: nothing claimed the lease, nothing was generated, nothing was sent.
      expect(cycle.dispatch).toBeNull();
      expect(events).toEqual([
        {
          kind: "cycle",
          swept: 1,
          skipped: 0,
          dispatch: "not_advanced",
          immediate: "not_advanced",
        },
      ]);
      expect(listQqDispatchCandidates(h.orm)).toHaveLength(1);
      expect(readQqDispatchLease(h.orm).token).toBeNull();
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("does not fill a second candidate while the first one is still pending", async () => {
    const h = cloneBusinessDb();
    try {
      seed(h.orm);
      const host = new QqRuntime({ orm: h.orm, clockSeconds: () => quietAt });
      await host.runCycle();
      const second = await host.runCycle(quietAt + 60);
      expect(second.sweep.scheduled).toEqual([]);
      expect(second.sweep.skipped.map((s) => s.reason)).toEqual(["candidate_pending"]);
      expect(listQqDispatchCandidates(h.orm)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("keeps sweeping conversations that are still silent after the first candidate is spent", async () => {
    // This is the shape the queue has today: the sweep has no memory of what it already offered,
    // because the plan's "an opener nobody answered is not followed by another one" rule reads a
    // SPEECH record, and only a real submission can write one. The host therefore must not run the
    // chain on its own (see the module header); the day a runner is wired, that record has to
    // start learning from it or every tick would open the same room again.
    const h = cloneBusinessDb();
    try {
      seed(h.orm);
      const host = new QqRuntime({ orm: h.orm, clockSeconds: () => quietAt });
      await host.runCycle();
      const spent = listQqDispatchCandidates(h.orm)[0];
      if (!spent) throw new Error("candidate");
      // Consume it the way the dispatch guard does, then sweep again with no new member message.
      h.orm.delete(schema.qqDispatchCandidates).run();
      const again = await host.runCycle(quietAt + 60);
      expect(again.sweep.scheduled).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe("the queue advance is an injected capability", () => {
  it("runs one task through the injected runner and still never sends", async () => {
    const h = cloneBusinessDb();
    let calls = 0;
    try {
      seed(h.orm);
      const store = new QqStickerStore({
        directory: path.join(import.meta.dir, "no-such-stickers"),
      });
      const host = new QqRuntime({
        orm: h.orm,
        clockSeconds: () => quietAt,
        dispatch: qqDispatchRunner({
          orm: h.orm,
          gateway: {
            loadedContextCapacity: async () => 65536,
            complete: async () => {
              calls += 1;
              return calls === 1 ? '{"score":8}' : "纯文字草稿";
            },
          },
          store,
        }),
      });
      const cycle = await host.runCycle();
      expect(cycle.dispatch).toMatchObject({ kind: "authorized", path: "idle_topic" });
      // Judgement + draft. A third call would mean the sticker stage asked a model it had no
      // reason to ask (the library is empty, so `isAvailable` is false for everything).
      expect(calls).toBe(2);
      expect(listQqDispatchCandidates(h.orm)).toEqual([]);
      expect(readQqDispatchLease(h.orm).token).toBeNull();
      // `authorized` is not a send licence: no ledger row may appear from it.
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("is wired by the product entry point behind a live-connection gate (P5o)", () => {
    // P5k deliberately left this unwired: with no transport for speech, an authorized draft had no
    // destination and the no-reply rule had nothing to learn from. P5o closed both — the sender
    // records a confirmed delivery as the assistant's own speech — so the entry point now wires the
    // runner, and what remains is the gate: no live QQ connection means no model calls at all.
    const runtimeSource = readFileSync(
      path.join(import.meta.dir, "../../src/server/runtime.ts"),
      "utf8",
    );
    expect(runtimeSource).toContain("qqDispatchRunner(");
    expect(runtimeSource).toContain("qqReplySender(");
    expect(runtimeSource).toContain('canAdvance: () => qqIntake.state.phase === "ready"');
    // The sender goes through the transport's own send, and never invents a request of its own.
    expect(runtimeSource).toContain("qqIntake.connection?.send(request)");
  });

  /**
   * A（用户 2026-09-25）：收到"冲着她来的"消息就立刻跑一轮，不再等下一次轮询（最多 15 秒）。
   * 机制在这里钉住；接线（入站 → `wake()`）用源码断言，因为那是一条装配事实。
   */
  it("runs another cycle immediately when woken instead of waiting out the poll interval", async () => {
    const h = cloneBusinessDb();
    try {
      seed(h.orm);
      const events: QqRuntimeEvent[] = [];
      const host = new QqRuntime({
        orm: h.orm,
        clockSeconds: () => quietAt,
        // 一个长到不可能自然跑完第二轮的时间：第二轮只可能来自 wake()。
        pollIntervalMs: 60_000,
        onEvent: (e) => events.push(e),
      });
      host.start();
      await Bun.sleep(30);
      const afterFirst = events.length;
      expect(afterFirst).toBeGreaterThan(0);
      host.wake();
      await Bun.sleep(60);
      expect(events.length).toBeGreaterThan(afterFirst);
      await host.stop();
    } finally {
      h.close();
    }
  });

  it("wires the intake's addressed-message signal to the wake-up (2026-09-25)", () => {
    const intakeSource = readFileSync(
      path.join(import.meta.dir, "../../src/server/services/qq-intake.ts"),
      "utf8",
    );
    // 只有"冲着她来的"才发信号：其余消息走合并窗口，天然有等待。
    expect(intakeSource).toContain("this.#options.onAddressedMessage?.()");
    expect(intakeSource).toContain("message.observation.mentionsSelf");
    const runtimeSource = readFileSync(
      path.join(import.meta.dir, "../../src/server/runtime.ts"),
      "utf8",
    );
    expect(runtimeSource).toContain("onAddressedMessage: () => qqRuntime.wake()");
  });

  it("does not call the runner while the gate says the transport is not connected", async () => {
    const h = cloneBusinessDb();
    try {
      seed(h.orm);
      let calls = 0;
      const host = new QqRuntime({
        orm: h.orm,
        clockSeconds: () => quietAt,
        canAdvance: () => false,
        dispatch: async () => {
          calls += 1;
          return { kind: "idle" };
        },
      });
      const cycle = await host.runCycle();
      expect(calls).toBe(0);
      expect(cycle.dispatch).toBeNull();
      // The sweep still ran: the queue is what tells the user a room is waiting.
      expect(cycle.sweep.scheduled).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe("the host loop", () => {
  it("ticks on its own timer, stops on request, and is idempotent about both", async () => {
    const h = cloneBusinessDb();
    try {
      seed(h.orm);
      const events: QqRuntimeEvent[] = [];
      const host = new QqRuntime({
        orm: h.orm,
        clockSeconds: () => quietAt,
        pollIntervalMs: 1,
        onEvent: (e) => events.push(e),
      });
      host.start();
      host.start();
      await Bun.sleep(50);
      await host.stop();
      await host.stop();
      expect(events.length).toBeGreaterThan(0);
      const settled = events.length;
      await Bun.sleep(20);
      expect(events.length).toBe(settled);
    } finally {
      h.close();
    }
  });

  it("keeps the loop alive when a cycle throws, without reporting the draft behind it", async () => {
    const h = cloneBusinessDb();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      seed(h.orm);
      const events: QqRuntimeEvent[] = [];
      const host = new QqRuntime({
        orm: h.orm,
        clockSeconds: () => quietAt,
        pollIntervalMs: 20,
        dispatch: async () => {
          throw new Error("synthetic model failure with draft text inside");
        },
        onEvent: (e) => events.push(e),
      });
      host.start();
      await Bun.sleep(60);
      await host.stop();
      expect(events).toContainEqual({ kind: "cycle_failed" });
      // The failure event carries nothing but its kind: no message, no exception repr.
      for (const event of events) expect(Object.keys(event)).toEqual(["kind"]);
      // Neither does the log: one fixed sentence, and nothing the failing cycle was holding.
      expect(warn).toHaveBeenCalledWith("qq runtime cycle failed; retrying next check");
    } finally {
      warn.mockRestore();
      h.close();
    }
  });

  it("clones the current schema version and still enforces foreign keys", () => {
    const h = cloneBusinessDb();
    try {
      expect(h.db.query("PRAGMA user_version").get()).toEqual({
        user_version: BUSINESS_SCHEMA_VERSION,
      });
    } finally {
      h.close();
    }
  });
});
