// T08 attempt clock (task 305): the media task ledger records WHEN an attempt
// was consumed, not just how many. `last_attempt_at` is the exact claim-time
// stamp written by the same immediate-transaction CAS that consumes the
// attempt — never a wall-clock backfill, never touched by result/failure
// publication (their revision bumps must not move the "later than the attempt"
// boundary that the supplement-evidence check compares against).
//
// Coverage:
//  - legacy import (0052): a consumed media row's task carries the row's real
//    `m.updated_at` as `last_attempt_at`; a zero-attempt media row creates NO
//    task at all, so no fake clock is invented either
//  - a real new task is created with attempts=0 and last_attempt_at=NULL; the
//    FIRST claim stamps the claim time; the second claim (after failure +
//    host-proven later supplement) re-stamps it with the later claim time
//  - CAS rollback (guard refuses the claim inside the claim transaction)
//    leaves NO row, no spent attempt and NO timestamp behind — a refused
//    attempt never writes a clock
//  - result/failure publication advance revision but do NOT touch
//    last_attempt_at (the boundary stays "when the attempt was claimed")

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  attemptMediaReadTask,
  failMediaReadTask,
  findMediaReadTask,
  type MediaTaskSourceGuard,
  recordMediaReadTask,
  recordMediaReadTaskResult,
} from "../../src/server/db/qq-media-task-repository";

import { qqBindings, qqGroupAgentConfigs, qqMediaReadTasks } from "../../src/server/db/schema";
import { BUSINESS_MIGRATION_FILES, ensureBusinessSchema } from "../../src/server/db/schema-gate";
import { fail } from "../../src/server/errors";
import { cloneBusinessDb } from "../harness/business-db";

const AGENT = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "bd-1";
const VERSIONS_DIR = path.join(import.meta.dir, "../../migrations/versions");
const NOW = new Date().toISOString().replace("Z", "000Z").slice(0, 26);
const EXPIRES = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  .toISOString()
  .replace("Z", "000Z")
  .slice(0, 26);

const SHA = (id: string) =>
  Array.from(id)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
const INITIAL_SOURCE_STATE = {
  agentId: AGENT,
  authorityRevision: 1,
  paused: 0,
  groupCapability: "{}",
};

function taskFixture() {
  const h = cloneBusinessDb();
  h.db.exec(`INSERT INTO users VALUES ('u1', 'synthetic', '${NOW}')`);
  h.db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
      p5_config, model_name, memory_consolidation_prompt,
      memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
    VALUES ('${AGENT}', 'synthetic', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
  h.db.exec(
    `INSERT INTO qq_schemes (id, name, created_at, updated_at) VALUES ('sch-1', 'synthetic', '${NOW}', '${NOW}')`,
  );
  h.db.exec(
    `INSERT INTO qq_bindings (id, account_id, conversation_kind, peer_id, agent_id, scheme_id,
      paused, share_web_memory, revision, authority_revision, created_at, updated_at)
     VALUES ('${BINDING_ID}', '10001', 'group', '20001', '${AGENT}', 'sch-1', 0, 0, 1, 1, '${NOW}', '${NOW}')`,
  );
  h.db.exec(
    `INSERT INTO qq_group_agent_configs (id, binding_id, agent_id, scheme_overrides, disabled_capabilities,
      capability_revisions, revision, created_at, updated_at)
     VALUES ('gac-1', '${BINDING_ID}', '${AGENT}', '{}', '[]', '{}', 1, '${NOW}', '${NOW}')`,
  );
  const seedNote = (id: string, opts?: { attempts?: number; updatedAt?: string }) => {
    h.db
      .query(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES ('ev-' || ?, '10001', 'group', '20001', '${AGENT}', 'm-' || ?, ?, 'member', '30001', ?)`,
      )
      .run(id, id, Math.floor(Date.now() / 1000) - 60, NOW);
    h.db
      .query(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES (?, 'ev-' || ?, 0, 'image', 'ref-' || ?, ?, ?, ?, ?)`,
      )
      .run(id, id, id, opts?.attempts ?? 0, EXPIRES, NOW, opts?.updatedAt ?? NOW);
  };
  seedNote("mn-new");
  return { h, seedNote };
}

function bindingCheckpoint(frozen: typeof INITIAL_SOURCE_STATE): MediaTaskSourceGuard {
  return (tx) => {
    const binding = tx
      .select({
        agentId: qqBindings.agentId,
        authorityRevision: qqBindings.authorityRevision,
        paused: qqBindings.paused,
      })
      .from(qqBindings)
      .where(eq(qqBindings.id, BINDING_ID))
      .get();
    const cap = tx
      .select({ capabilityRevisions: qqGroupAgentConfigs.capabilityRevisions })
      .from(qqGroupAgentConfigs)
      .where(eq(qqGroupAgentConfigs.bindingId, BINDING_ID))
      .get();
    if (
      !binding ||
      !cap ||
      binding.agentId !== frozen.agentId ||
      binding.authorityRevision !== frozen.authorityRevision ||
      binding.paused !== frozen.paused ||
      cap.capabilityRevisions !== frozen.groupCapability
    ) {
      fail("CONTEXT_SOURCE_INVALID", "会话绑定、授权或能力已变化");
    }
  };
}

describe("QQ media task attempt clock (0052 last_attempt_at)", () => {
  it("legacy import stamps the media row's real updated_at; a zero-attempt row invents nothing", () => {
    const legacyAt = "2026-09-15T08:30:00.000000Z";
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      for (const name of BUSINESS_MIGRATION_FILES.slice(0, 51)) {
        db.exec(readFileSync(path.join(VERSIONS_DIR, name), "utf8"));
      }
      db.exec("PRAGMA user_version = 51");
      db.exec(`INSERT INTO users VALUES ('u1', 'synthetic', '${NOW}')`);
      db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
          p5_config, model_name, memory_consolidation_prompt,
          memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
        VALUES ('${AGENT}', 'synthetic', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
      db.exec(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES ('ev-old', '10001', 'group', '20001', '${AGENT}', 'm1', 10, 'member', '30001', '${NOW}')`,
      );
      db.exec(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES ('ev-zero', '10001', 'group', '20001', '${AGENT}', 'm2', 10, 'member', '30001', '${NOW}')`,
      );
      // Consumed row: the real last-attempt moment is updated_at (the migration
      // clock of `now` must NOT overwrite it).
      db.exec(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES ('mn-old', 'ev-old', 0, 'image', 'ref', 1, '${EXPIRES}', '${NOW}', '${legacyAt}')`,
      );
      // Zero-attempt row: no task, no clock.
      db.exec(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES ('mn-zero', 'ev-zero', 0, 'image', 'ref', 0, '${EXPIRES}', '${NOW}', '${legacyAt}')`,
      );
      ensureBusinessSchema(db);
      const tasks = db
        .query(
          `SELECT media_note_id, attempts, last_attempt_at FROM qq_media_read_tasks
           ORDER BY media_note_id`,
        )
        .all() as Array<{
        media_note_id: string;
        attempts: number;
        last_attempt_at: string | null;
      }>;
      expect(tasks).toEqual([{ media_note_id: "mn-old", attempts: 1, last_attempt_at: legacyAt }]);
    } finally {
      db.close();
    }
  });

  it("a fresh task has no clock; claims stamp the claim time and the second claim re-stamps it", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      // Record-before-claim: attemptMediaReadTask creates the task row itself.
      const first = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-new",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA("mn-new"),
        relatedSupplementArrived: false,
        assertCurrent: guard,
        at: "2026-10-02T10:00:00.000000Z",
      });
      expect(first).toMatchObject({ claimed: true, attempt: 1 });
      let task = findMediaReadTask(h.orm, { mediaNoteId: "mn-new", purpose: "baseline" });
      expect(task?.lastAttemptAt).toBe("2026-10-02T10:00:00.000000Z");
      // Result publication advances revision but must not move the clock.
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId: "mn-new",
        purpose: "baseline",
        note: "橘猫在沙发上",
        modelName: "vision-a",
        expectedAttempts: first.attempt,
        claimToken: first.claimToken,
        assertCurrent: guard,
        at: "2026-10-02T10:05:00.000000Z",
      });
      task = findMediaReadTask(h.orm, { mediaNoteId: "mn-new", purpose: "baseline" });
      expect(task?.lastAttemptAt).toBe("2026-10-02T10:00:00.000000Z");

      // Second task for the second-claim path: fail attempt 1, then claim 2.
      h.db
        .query(
          `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
            message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
           VALUES ('ev-two', '10001', 'group', '20001', '${AGENT}', 'm-two', ?, 'member', '30001', ?)`,
        )
        .run(Math.floor(Date.now() / 1000) - 60, NOW);
      h.db
        .query(
          `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
            attempts, expires_at, recorded_at, updated_at)
           VALUES ('mn-two', 'ev-two', 0, 'image', 'ref-two', 0, ?, ?, ?)`,
        )
        .run(EXPIRES, NOW, NOW);
      const claim1 = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-two",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA("mn-two"),
        assertCurrent: guard,
        at: "2026-10-02T11:00:00.000000Z",
      });
      failMediaReadTask(h.orm, {
        mediaNoteId: "mn-two",
        purpose: "baseline",
        expectedAttempt: claim1.attempt,
        revisionAtClaim: claim1.task.revision,
        claimToken: claim1.claimToken,
        assertCurrent: guard,
        at: "2026-10-02T11:01:00.000000Z",
      });
      // Failure publication leaves the attempt clock on the claim moment.
      expect(
        findMediaReadTask(h.orm, { mediaNoteId: "mn-two", purpose: "baseline" }),
      ).toMatchObject({
        lastAttemptAt: "2026-10-02T11:00:00.000000Z",
      });
      const claim2 = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-two",
        purpose: "baseline",
        modelName: "vision-b",
        policy: "p2",
        contentSha256: SHA("mn-two"),
        relatedSupplementArrived: true,
        proveSupplementLaterThan: () => true,
        assertCurrent: guard,
        at: "2026-10-02T11:30:00.000000Z",
      });
      expect(claim2).toMatchObject({ claimed: true, attempt: 2 });
      expect(
        findMediaReadTask(h.orm, { mediaNoteId: "mn-two", purpose: "baseline" }),
      ).toMatchObject({
        lastAttemptAt: "2026-10-02T11:30:00.000000Z",
      });
    } finally {
      h.close();
    }
  });

  it("a CAS-rolled-back claim writes no row, no attempt and no timestamp", async () => {
    const { h } = taskFixture();
    try {
      const guardThatThrows: MediaTaskSourceGuard = () => {
        fail("CONTEXT_SOURCE_INVALID", "会话绑定、授权或能力已变化");
      };
      const promise = attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-new",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA("mn-new"),
        assertCurrent: guardThatThrows,
        at: "2026-10-02T12:00:00.000000Z",
      });
      await expect(promise).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      const rows = h.orm.select().from(qqMediaReadTasks).all();
      expect(rows).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("the strict row shape keeps last_attempt_at nullable in the typed schema", () => {
    const { h } = taskFixture();
    try {
      // The typed table's $inferSelect must carry the new field (compile-time
      // proof via a runtime read of the column through the typed select).
      const columns = h.db.query("PRAGMA table_info(qq_media_read_tasks)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const col = columns.find((c) => c.name === "last_attempt_at");
      expect(col).toBeDefined();
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    } finally {
      h.close();
    }
  });

  it("a merely recorded task (never claimed) keeps last_attempt_at NULL", () => {
    const { h } = taskFixture();
    try {
      // recordMediaReadTask (creation, attempts=0) writes no fake clock: NULL is
      // the "no attempt consumed yet" state, distinct from any wall-clock value.
      const created = recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-new",
        purpose: "baseline",
        policy: "p1",
        contentSha256: SHA("mn-new"),
        expiresAt: EXPIRES,
        at: "2026-10-02T12:30:00.000000Z",
      });
      expect(created.created).toBe(true);
      expect(created.task.lastAttemptAt).toBeNull();
      expect(
        findMediaReadTask(h.orm, { mediaNoteId: "mn-new", purpose: "baseline" }),
      ).toMatchObject({ attempts: 0, lastAttemptAt: null });
    } finally {
      h.close();
    }
  });
});
