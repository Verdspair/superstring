// T08 Step5 闸迁移（spec §8.1）: the initiative media gate and the supplement-candidate
// query must read the REAL read-task state (typed ledger), not only the 0012 media-row
// projection (`note IS NULL AND attempts > 0`).
//
// Coverage:
//  - a typed baseline task that failed (or is still running) blocks the initiative gate
//    even though the media row itself has attempts = 0 (typed failures never write it)
//  - a live succeeded typed task unblocks — including a row whose legacy attempts were
//    spent and whose note is still NULL (旧失败记录保留，新 task 成功有效解除)
//  - legacy row-level failures (attempts > 0, no note, no task rows) keep blocking
//  - an expired task window and another conversation's/agent's task block nothing
//  - the count API takes the caller's real ISO `at` (host clock injected, not nowIso())
//  - supplement candidates require a genuinely failed task (attempt >= 1) plus a later
//    related message from the same conversation; a running or succeeded task is not one

import { describe, expect, it } from "bun:test";
import {
  attemptedUnreadMediaCount,
  pendingMediaSupplementFor,
} from "../../src/server/db/qq-media-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { prepareQqJudgement } from "../../src/server/services/qq-judgement-preparation";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import { mediaCacheExpiresAt } from "../../src/server/services/qq-retention";

const agentId = "00000000-0000-0000-0000-000000000001";
const agentId2 = "00000000-0000-0000-0000-000000000002";
const bindingId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000;
/** The caller's real ISO `at` for the gate — derived from nowSeconds, never nowIso(). */
const atFromSeconds = (seconds: number) => new Date(seconds * 1000).toISOString();
const liveExpiry = (occurredAtSeconds: number) => mediaCacheExpiresAt(occurredAtSeconds);
const pastExpiry = "1970-01-01T00:00:00.000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, {
    accountId: "10001",
    enabled: true,
    expectedRevision: 1,
  });
  const scheme = createQqScheme(h.orm, {
    name: "synthetic",
    triggers: {
      direct_reply: false,
      follow_up: false,
      chiming_in: true,
      idle_topic: true,
    },
    prompts: { ...QQ_PROMPT_DEFAULTS, judge: "自定义判断任务" },
  });
  h.orm
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
  event(h.orm, "old", now - 90, "旧消息");
  event(h.orm, "latest", now - 40, "新消息");
  return h;
}

function event(orm: Orm, key: string, at: number, text: string, speakerId = "20002") {
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
      speakerId,
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

function mediaRow(
  orm: Orm,
  eventKey: string,
  overrides: { attempts?: number; note?: string | null; noteModel?: string | null } = {},
) {
  return orm
    .insert(schema.qqMediaNotes)
    .values({
      id: crypto.randomUUID(),
      eventKey,
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: "qq-media://synthetic",
      note: overrides.note ?? null,
      noteModel: overrides.noteModel ?? null,
      attempts: overrides.attempts ?? 0,
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
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly attempts: number;
  readonly note?: string | null;
  readonly modelName?: string | null;
  readonly purpose?: "baseline" | "detail";
  readonly expiresAt?: string;
  readonly agentId?: string;
  readonly peerId?: string;
  readonly questionKey?: string | null;
};

/** Insert a typed read-task row directly: the gate counts rows, not claims. */
function taskRow(orm: Orm, seed: TaskSeed) {
  orm
    .insert(schema.qqMediaReadTasks)
    .values({
      id: crypto.randomUUID(),
      mediaNoteId: seed.mediaNoteId,
      accountId: "10001",
      conversationKind: "group",
      peerId: seed.peerId ?? "30003",
      agentId: seed.agentId ?? agentId,
      purpose: seed.purpose ?? "baseline",
      questionKey: seed.questionKey ?? null,
      modelName: seed.modelName ?? null,
      policy: "baseline/v1/synthetic",
      attempts: seed.attempts,
      status: seed.status,
      note: seed.note ?? null,
      revision: 1,
      expiresAt: seed.expiresAt ?? liveExpiry(now - 40),
      recordedAt: nowIso(),
    })
    .run();
}

const request = (path = "chiming_in", seconds = now) => ({
  bindingId,
  path,
  nowSeconds: seconds,
});

describe("the initiative media gate reads real typed task state", () => {
  it("a typed failed baseline task blocks chiming in although the media row was never row-attempted", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      taskRow(h.orm, { mediaNoteId: row.id, status: "failed", attempts: 1 });
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
    } finally {
      h.close();
    }
  });

  it("a running typed task blocks too (fail closed while in flight)", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      taskRow(h.orm, { mediaNoteId: row.id, status: "running", attempts: 1 });
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
    } finally {
      h.close();
    }
  });

  it("a live succeeded typed task unblocks — even a legacy row whose attempts were spent and note still NULL", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest", { attempts: 2 });
      taskRow(h.orm, {
        mediaNoteId: row.id,
        status: "succeeded",
        attempts: 2,
        note: "一只橘猫趴在键盘上",
        modelName: "vision-a",
      });
      expect(prepareQqJudgement(h.orm, request()).kind).toBe("prepared");
    } finally {
      h.close();
    }
  });

  it("a legacy row-level failure with no task rows still blocks (旧失败记录保留)", () => {
    const h = setup();
    try {
      mediaRow(h.orm, "latest", { attempts: 1 });
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
    } finally {
      h.close();
    }
  });

  it("an expired task window blocks nothing", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      taskRow(h.orm, {
        mediaNoteId: row.id,
        status: "failed",
        attempts: 2,
        expiresAt: pastExpiry,
      });
      expect(prepareQqJudgement(h.orm, request()).kind).toBe("prepared");
    } finally {
      h.close();
    }
  });

  it("another agent's failed task on another conversation does not silence this one", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      taskRow(h.orm, {
        mediaNoteId: row.id,
        status: "failed",
        attempts: 1,
        agentId: agentId2,
        peerId: "40004",
      });
      expect(prepareQqJudgement(h.orm, request()).kind).toBe("prepared");
    } finally {
      h.close();
    }
  });

  it("the count API counts the typed failed task and honours the caller's real ISO at", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      taskRow(h.orm, { mediaNoteId: row.id, status: "failed", attempts: 1 });
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now))).toBe(1);
      // At a moment past the task's window the same caller clock stops counting it.
      expect(attemptedUnreadMediaCount(h.orm, ["latest"], atFromSeconds(now + 40 * 86400))).toBe(0);
      // No messages handed in: nothing to count.
      expect(attemptedUnreadMediaCount(h.orm, [], atFromSeconds(now))).toBe(0);
    } finally {
      h.close();
    }
  });
});

describe("supplement candidates read genuinely failed typed tasks", () => {
  it("a failed typed task with a later related message is a candidate", () => {
    const h = setup();
    try {
      event(h.orm, "wakeup", now - 10, "后来他又说了一句");
      const row = mediaRow(h.orm, "latest");
      taskRow(h.orm, { mediaNoteId: row.id, status: "failed", attempts: 1 });
      expect(
        pendingMediaSupplementFor(h.orm, {
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          sinceSeconds: now - 120,
          beforeSeconds: now,
          excludeEventKey: "wakeup",
        }),
      ).toEqual({ eventKey: "latest", segmentIndex: 0 });
    } finally {
      h.close();
    }
  });

  it("a running task is not a supplement candidate (candidate needs a real failure)", () => {
    const h = setup();
    try {
      event(h.orm, "wakeup", now - 10, "后来他又说了一句");
      const row = mediaRow(h.orm, "latest");
      taskRow(h.orm, { mediaNoteId: row.id, status: "running", attempts: 1 });
      expect(
        pendingMediaSupplementFor(h.orm, {
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          sinceSeconds: now - 120,
          beforeSeconds: now,
          excludeEventKey: "wakeup",
        }),
      ).toBeNull();
    } finally {
      h.close();
    }
  });

  it("a succeeded task is not a supplement candidate", () => {
    const h = setup();
    try {
      event(h.orm, "wakeup", now - 10, "后来他又说了一句");
      const row = mediaRow(h.orm, "latest");
      taskRow(h.orm, {
        mediaNoteId: row.id,
        status: "succeeded",
        attempts: 1,
        note: "一只橘猫趴在键盘上",
        modelName: "vision-a",
      });
      expect(
        pendingMediaSupplementFor(h.orm, {
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          sinceSeconds: now - 120,
          beforeSeconds: now,
          excludeEventKey: "wakeup",
        }),
      ).toBeNull();
    } finally {
      h.close();
    }
  });
});
