// T11 resume2: failure-gate purpose contract for the initiative media gate
// (src/server/db/qq-media-repository.ts, attemptedUnreadMedia*).
//
// Contract under test:
//  - a blocked note is resolved ONLY through a servable result of the SAME purpose:
//    baseline resolves baseline, detail resolves detail with the SAME question key;
//    a succeeded task of a DIFFERENT purpose never releases the failed gate
//  - the typed ledger cannot even hold unknown purpose data: the schema CHECK
//    (purpose IN ('baseline', 'detail')) refuses the row — typed insert and raw SQL
//    alike — so untyped data can never enter the servable lookup; the gate's code
//    path is additionally fail-closed (an out-of-band unknown purpose keeps the note
//    blocked instead of resolving it)
//
// Dependency boundary: repo-isolated by design — this file imports only the storage
// layer (schema / repositories / qq-media-repository / schema-gate / qq-retention),
// never the in-flight host chain; it runs against an in-memory synthetic database.

import { describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  attemptedUnreadMediaCount,
  attemptedUnreadMediaNoteIds,
} from "../../src/server/db/qq-media-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { mediaCacheExpiresAt } from "../../src/server/services/qq-retention";

const agentId = "00000000-0000-0000-0000-000000000001";
const now = 2_000_000_000;
/** The caller's real ISO `at` for the gate — derived from nowSeconds, never nowIso(). */
const atFromSeconds = (seconds: number) => new Date(seconds * 1000).toISOString();
const liveExpiry = (occurredAtSeconds: number) => mediaCacheExpiresAt(occurredAtSeconds);

function setup() {
  const h = openBusinessDb();
  // qq_events.agent_id is a real FK: the storage defaults mint the synthetic agent/account.
  ensureDefaults(h.orm, "synthetic-model");
  event(h.orm, "latest", now - 40);
  return h;
}

function event(orm: Orm, key: string, at: number) {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
      messageId: key,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: nowIso(),
    })
    .run();
}

function mediaRow(orm: Orm, eventKey: string) {
  return orm
    .insert(schema.qqMediaNotes)
    .values({
      id: crypto.randomUUID(),
      eventKey,
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: "qq-media://synthetic",
      note: null,
      noteModel: null,
      attempts: 0,
      addressed: 0,
      expiresAt: liveExpiry(now - 40),
      recordedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning()
    .get();
}

type TaskSeed = {
  readonly mediaNoteId: string;
  readonly purpose: "baseline" | "detail";
  readonly questionKey?: string | null;
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly attempts: number;
  readonly note?: string | null;
  readonly modelName?: string | null;
};

/** Insert a typed read-task row directly: the gate counts rows, not claims. */
function taskRow(orm: Orm, seed: TaskSeed) {
  return orm
    .insert(schema.qqMediaReadTasks)
    .values({
      id: crypto.randomUUID(),
      mediaNoteId: seed.mediaNoteId,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
      purpose: seed.purpose,
      questionKey: seed.questionKey ?? null,
      modelName: seed.modelName ?? null,
      policy: "baseline/v1/synthetic",
      attempts: seed.attempts,
      status: seed.status,
      note: seed.note ?? null,
      revision: 1,
      expiresAt: liveExpiry(now - 40),
      recordedAt: nowIso(),
    })
    .returning()
    .get();
}

/** A task retry succeeding is the ordinary resolution path: the SAME row turns servable. */
function succeedRow(orm: Orm, id: string) {
  orm
    .update(schema.qqMediaReadTasks)
    .set({ status: "succeeded", attempts: 2, note: "一只橘猫趴在键盘上", modelName: "vision-a" })
    .where(eq(schema.qqMediaReadTasks.id, id))
    .run();
}

describe("the failure gate resolves only through a servable result of the SAME purpose", () => {
  it("a failed baseline task blocks; a live succeeded baseline result resolves it", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      const task = taskRow(h.orm, {
        mediaNoteId: row.id,
        purpose: "baseline",
        status: "failed",
        attempts: 1,
      });
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now))).toBe(1);
      expect(attemptedUnreadMediaNoteIds(h.orm, ["latest"], atFromSeconds(now))).toEqual([row.id]);
      succeedRow(h.orm, task.id);
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now))).toBe(0);
    } finally {
      h.close();
    }
  });

  it("a failed detail task blocks; a baseline success never resolves it — only the same-purpose same-question success does", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      const task = taskRow(h.orm, {
        mediaNoteId: row.id,
        purpose: "detail",
        questionKey: "q1",
        status: "failed",
        attempts: 1,
      });
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now))).toBe(1);
      // A succeeded BASELINE answer does not answer a detail question.
      taskRow(h.orm, {
        mediaNoteId: row.id,
        purpose: "baseline",
        status: "succeeded",
        attempts: 2,
        note: "一只橘猫趴在键盘上",
        modelName: "vision-a",
      });
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now))).toBe(1);
      succeedRow(h.orm, task.id);
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now))).toBe(0);
    } finally {
      h.close();
    }
  });

  it("a failed baseline task is not resolved by a succeeded detail answer", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      const task = taskRow(h.orm, {
        mediaNoteId: row.id,
        purpose: "baseline",
        status: "failed",
        attempts: 1,
      });
      taskRow(h.orm, {
        mediaNoteId: row.id,
        purpose: "detail",
        questionKey: "q1",
        status: "succeeded",
        attempts: 2,
        note: "局部放大里的文字",
        modelName: "vision-a",
      });
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now))).toBe(1);
      succeedRow(h.orm, task.id);
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now))).toBe(0);
    } finally {
      h.close();
    }
  });
});

describe("unknown purpose data can never release the failed gate", () => {
  it("the typed ledger refuses an out-of-band purpose through the typed insert path", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      // Deliberately out-of-band data — the schema CHECK must reject what the type system
      // already prevents (double-cast only smuggles the fixture past the compiler).
      const badSeed = {
        purpose: "unknown",
        mediaNoteId: row.id,
        status: "failed",
        attempts: 1,
      } as unknown as TaskSeed;
      expect(() => taskRow(h.orm, badSeed)).toThrow(/CHECK/i);
    } finally {
      h.close();
    }
  });

  it("the typed ledger refuses an out-of-band purpose through raw SQL too", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      // Drizzle wraps raw-SQL failures; the real verdict sits on the error's cause chain.
      let cause = "no error thrown";
      try {
        h.orm.run(sql`INSERT INTO qq_media_read_tasks
          (id, media_note_id, account_id, conversation_kind, peer_id, agent_id, purpose,
           question_key, model_name, policy, attempts, status, note, revision, expires_at, recorded_at)
          VALUES (${crypto.randomUUID()}, ${row.id}, '10001', 'group', '30003', ${agentId},
           'unknown', NULL, NULL, 'baseline/v1/synthetic', 1, 'failed', NULL, 1,
           ${liveExpiry(now - 40)}, ${nowIso()})`);
      } catch (err) {
        cause = String((err as { cause?: { message?: string } }).cause?.message ?? err);
      }
      expect(cause).toMatch(/CHECK constraint failed: purpose IN \('baseline', 'detail'\)/);
      // Nothing entered the ledger: the gate still sees zero typed rows for this content.
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now))).toBe(0);
    } finally {
      h.close();
    }
  });
});
