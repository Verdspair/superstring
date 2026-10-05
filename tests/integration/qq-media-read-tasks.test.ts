// T08: typed media read tasks (plan T08 Steps 2/4/5, spec §8.1/§12).
//
// Coverage:
//  - a task's stable identity is scope + media identity + purpose + question_key;
//    baseline is unique per media row, detail is unique per question key
//  - two attempts per task, claimed by CAS; a different model or policy does
//    NOT reset the consumed attempts (换模型不重置)
//  - a failed first attempt blocks a second until a related supplement
//    arrives; the second attempt exhausts the task
//  - a detail question the model merely paraphrases lands on the same key —
//    punctuation/wording changes and restarts cannot fork new tasks
//  - a succeeded task blocks a duplicate baseline read; a separate detail
//    question still gets its own task
//  - recording a result validates media source state inside the same
//    transaction and stamps the actual model/purpose/question on the task
//  - claim, publication and failure all re-validate the frozen source state
//    through a REQUIRED host checkpoint inside the same immediate transaction;
//    a moved binding/agent/authority/capability state refuses with
//    CONTEXT_SOURCE_INVALID and writes nothing (attempts stay consumed)
//  - a stale failure for a missing or succeeded task is refused, not swallowed
//  - the unread gate counts real unfinished/failed tasks — a task that
//    succeeded no longer blocks, and legacy attempts are never zeroed
//  - the legacy migration import keeps old attempts, model and expiry

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  attemptMediaReadTask,
  failedMediaReadTaskCount,
  failMediaReadTask,
  findMediaReadTask,
  MediaReadTaskRejectedError,
  type MediaTaskSourceGuard,
  normalizeQuestionKey,
  recordMediaReadTask,
  recordMediaReadTaskResult,
} from "../../src/server/db/qq-media-task-repository";
import { qqBindings, qqGroupAgentConfigs, qqMediaReadTasks } from "../../src/server/db/schema";
import { BUSINESS_MIGRATION_FILES, ensureBusinessSchema } from "../../src/server/db/schema-gate";
import { fail } from "../../src/server/errors";
import { cloneBusinessDb } from "../harness/business-db";

const AGENT = "00000000-0000-0000-0000-000000000001";
const AGENT2 = "00000000-0000-0000-0000-000000000002";
const BINDING_ID = "bd-1";
const VERSIONS_DIR = path.join(import.meta.dir, "../../migrations/versions");
// The repositories validate windows against the real clock, so the fixtures
// use live windows derived from now.
const NOW = new Date().toISOString().replace("Z", "000Z").slice(0, 26);
const EXPIRES = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  .toISOString()
  .replace("Z", "000Z")
  .slice(0, 26);

// The source state the synthetic host checkpoint freezes at claim time: the
// binding's agent, authority revision and on/off switch, plus the per-binding
// group capability revisions. Every negative test moves exactly these rows.
const SHA = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
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
  h.db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
      p5_config, model_name, memory_consolidation_prompt,
      memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
    VALUES ('${AGENT2}', 'synthetic-2', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
  // Host-side authorization state the checkpoint re-reads: one binding for the
  // seeded conversation plus its per-binding group capability record.
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
  // The supplement lateness check compares real event times against the task's
  // creation clock, so fixtures use plausible epoch seconds, not constants.
  const baseSeconds = Math.floor(Date.now() / 1000) - 60;
  const seedNote = (
    id: string,
    opts?: { peerId?: string; occurredAtSeconds?: number; expiresAt?: string },
  ) => {
    const peer = opts?.peerId ?? "20001";
    const occurred = opts?.occurredAtSeconds ?? baseSeconds;
    const expires = opts?.expiresAt ?? EXPIRES;
    h.db
      .query(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES ('ev-' || ?, '10001', 'group', ?, '${AGENT}', 'm-' || ?, ?, 'member', '30001', ?)`,
      )
      .run(id, peer, id, occurred, NOW);
    h.db
      .query(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES (?, 'ev-' || ?, 0, 'image', 'ref-' || ?, 0, ?, ?, ?)`,
      )
      .run(id, id, id, expires, NOW, NOW);
  };
  seedNote("mn-1");
  return { h, seedNote, baseSeconds };
}

/**
 * The synthetic host checkpoint: re-reads the binding authorization state
 * through the LIVE transaction handle and refuses with the authority code when
 * it no longer matches what was frozen at claim time — never a noop.
 */
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

/** Bun's rejects.toMatchObject does not walk Error properties; assert by hand. */
async function rejectsReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { reason?: string }).reason ?? "<no reason>";
  }
  return "<no rejection>";
}

function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "<no code>";
  }
  return "<no throw>";
}

async function rejectedCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "<no code>";
  }
  return "<no rejection>";
}

/** Every task row's identity + budget + state, for whole-table unchanged checks. */
function taskStateSnapshot(orm: ReturnType<typeof cloneBusinessDb>["orm"]) {
  return orm
    .select({
      mediaNoteId: qqMediaReadTasks.mediaNoteId,
      purpose: qqMediaReadTasks.purpose,
      questionKey: qqMediaReadTasks.questionKey,
      attempts: qqMediaReadTasks.attempts,
      status: qqMediaReadTasks.status,
      note: qqMediaReadTasks.note,
      revision: qqMediaReadTasks.revision,
    })
    .from(qqMediaReadTasks)
    .all();
}

describe("typed QQ media read tasks", () => {
  it("keys a task by media + purpose + question, not by model or policy", () => {
    const { h } = taskFixture();
    try {
      const task = recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      expect(task.created).toBe(true);
      // Same identity again — even with a different model and policy — is the
      // SAME task: 换模型/换策略不能另开新任务。
      const rekeyed = recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-b",
        policy: "p2",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      expect(rekeyed.created).toBe(false);
      // task is {task, created}: the row lives on .task — the wrapper's own id
      // is undefined, and asserting on it proves nothing.
      expect(rekeyed.task.id).toBe(task.task.id);
      expect(findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" })?.id).toBe(
        task.task.id,
      );
      expect(
        findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "detail", questionKey: "q" }),
      ).toBeNull();
      // A genuinely new detail question is its own task.
      const detail = recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("图里写了什么字？"),
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      expect(detail.created).toBe(true);
      expect(detail.task.id).not.toBe(task.task.id);
      // A detail task without a question key is a contract violation.
      expect(() =>
        recordMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "detail",
          modelName: "vision-a",
          policy: "p1",
          contentSha256: SHA,
          expiresAt: EXPIRES,
        }),
      ).toThrow(TypeError);
    } finally {
      h.close();
    }
  });

  it("folds punctuation and wording changes into the same detail task", () => {
    const { h } = taskFixture();
    try {
      const first = recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("图里写了什么字？"),
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      // 模型改写 / 改标点 / 随机大小写空白：同一规范化问题 ⇒ 同一任务键。
      const paraphrased = recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("  图里写了什么字。 "),
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      expect(paraphrased.created).toBe(false);
      expect(paraphrased.task.id).toBe(first.task.id);
    } finally {
      h.close();
    }
  });

  it("spends attempts by CAS and never resets them on a model or policy change", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      const first = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        relatedSupplementArrived: false,
        assertCurrent: guard,
      });
      expect(first).toMatchObject({ claimed: true, attempt: 1 });
      // Competing claimants cannot both take attempt 1.
      await expect(
        attemptMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          modelName: "vision-a",
          policy: "p1",
          contentSha256: SHA,
          assertCurrent: guard,
        }),
      ).rejects.toBeInstanceOf(MediaReadTaskRejectedError);
      // A first failure waits for a related supplement — not for a new model.
      // The consumed attempt must first resolve (here: failed), and the host
      // proves the supplement genuinely postdates the claim.
      failMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        expectedAttempt: first.attempt,
        revisionAtClaim: first.task.revision,
        claimToken: first.claimToken,
        assertCurrent: guard,
      });
      expect(
        await rejectsReason(
          attemptMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            modelName: "vision-b",
            policy: "p9",
            contentSha256: SHA,
            assertCurrent: guard,
          }),
        ),
      ).toBe("awaiting_supplement");
      await expect(
        attemptMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          modelName: "vision-b",
          policy: "p9",
          contentSha256: SHA,
          relatedSupplementArrived: true,
          proveSupplementLaterThan: () => true,
          assertCurrent: guard,
        }),
      ).resolves.toMatchObject({ claimed: true, attempt: 2 });
      // Two attempts are the whole budget — for every model and policy.
      expect(
        await rejectsReason(
          attemptMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            modelName: "vision-c",
            policy: "p10",
            contentSha256: SHA,
            relatedSupplementArrived: true,
            assertCurrent: guard,
          }),
        ),
      ).toBe("attempts_exhausted");
    } finally {
      h.close();
    }
  });

  it("refuses a second claim while an attempt is still running (fail closed)", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      const first = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        relatedSupplementArrived: false,
        assertCurrent: guard,
      });
      // The row is now `running` at attempt 1: a second claim on the SAME
      // in-flight task must fail closed even if a supplement is claimed — the
      // first attempt has not resolved yet, so no second budget exists to take.
      expect(
        await rejectsReason(
          attemptMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            modelName: "vision-b",
            policy: "p2",
            contentSha256: SHA,
            relatedSupplementArrived: true,
            assertCurrent: guard,
          }),
        ),
      ).toBe("awaiting_supplement");
      // The input boolean alone is not host evidence either way; the claimant
      // must prove the supplement through the callback the store exposes.
      expect(
        await rejectsReason(
          attemptMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            modelName: "vision-b",
            policy: "p2",
            contentSha256: SHA,
            relatedSupplementArrived: false,
            assertCurrent: guard,
          }),
        ),
      ).toBe("awaiting_supplement");
      // A failure callback with a wrong token cannot resolve the attempt.
      expect(() =>
        failMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          expectedAttempt: first.attempt,
          revisionAtClaim: first.task.revision,
          claimToken: "invalid-token",
          assertCurrent: guard,
        }),
      ).toThrow();
      expect(findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" })).toMatchObject({
        status: "running",
      });
      // The real claim resolves the attempt as failed; a genuinely later
      // related supplement (callback confirms it postdates the first attempt)
      // then opens attempt 2 — the only path to a second claim.
      failMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        expectedAttempt: first.attempt,
        revisionAtClaim: first.task.revision,
        claimToken: first.claimToken,
        assertCurrent: guard,
      });
      expect(
        await rejectsReason(
          attemptMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            modelName: "vision-b",
            policy: "p2",
            contentSha256: SHA,
            relatedSupplementArrived: true,
            // The supplement message predates the first attempt's claim: not a
            // NEW related supplement — host evidence callback rejects it.
            proveSupplementLaterThan: () => false,
            assertCurrent: guard,
          }),
        ),
      ).toBe("awaiting_supplement");
      await expect(
        attemptMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          modelName: "vision-b",
          policy: "p2",
          contentSha256: SHA,
          relatedSupplementArrived: true,
          proveSupplementLaterThan: () => true,
          assertCurrent: guard,
        }),
      ).resolves.toMatchObject({ claimed: true, attempt: 2 });
    } finally {
      h.close();
    }
  });

  it("publishes results only onto the exact running attempt (strict CAS)", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      const first = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        relatedSupplementArrived: false,
        assertCurrent: guard,
      });
      // A result carrying no expected attempt is a best-effort publish: refuse.
      // (The old AND-condition `attempts mismatch && status not running` let a
      // late result overwrite a running task.)
      // The malformed call is made through the REAL function with a genuinely
      // missing field object — Reflect.apply keeps the negative shape exact
      // without widening the production signature.
      expect(() =>
        Reflect.apply(recordMediaReadTaskResult, undefined, [
          h.orm,
          {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            note: "迟到的结果",
            modelName: "vision-a",
            assertCurrent: guard,
          },
        ]),
      ).toThrow();
      // The claimed attempt number must match the row exactly.
      expect(() =>
        recordMediaReadTaskResult(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          note: "错号的结果",
          modelName: "vision-a",
          expectedAttempts: first.attempt + 1,
          claimToken: first.claimToken,
          assertCurrent: guard,
        }),
      ).toThrow();
      // A mismatching claim token also refuses even with the right number.
      expect(() =>
        recordMediaReadTaskResult(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          note: "伪造令牌",
          modelName: "vision-a",
          expectedAttempts: first.attempt,
          claimToken: "not-the-real-token",
          assertCurrent: guard,
        }),
      ).toThrow();
      // The correct attempt + token publishes; the UPDATE itself is a CAS on
      // (status, attempts, revision) — a raced writer cannot double-succeed.
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        note: "橘猫在沙发上",
        modelName: "vision-a",
        expectedAttempts: first.attempt,
        claimToken: first.claimToken,
        assertCurrent: guard,
      });
      expect(findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" })).toMatchObject({
        status: "succeeded",
        attempts: 1,
      });
    } finally {
      h.close();
    }
  });

  it("fails only the exact claimed attempt; a stale failure cannot clobber a newer claim", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      const claim = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        relatedSupplementArrived: false,
        assertCurrent: guard,
      });
      // A failure naming the wrong attempt number must not touch the row.
      expect(() =>
        failMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          expectedAttempt: claim.attempt + 1,
          revisionAtClaim: claim.task.revision,
          claimToken: claim.claimToken,
          assertCurrent: guard,
        }),
      ).toThrow();
      expect(findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" })).toMatchObject({
        status: "running",
      });
      // The right attempt + token marks exactly this attempt failed.
      failMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        expectedAttempt: claim.attempt,
        revisionAtClaim: claim.task.revision,
        claimToken: claim.claimToken,
        assertCurrent: guard,
      });
      expect(findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" })).toMatchObject({
        status: "failed",
        attempts: 1,
      });
    } finally {
      h.close();
    }
  });

  it("blocks a duplicate baseline read after success and validates results in-transaction", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      // Claim attempt 1, then publish the result stamped with the actual model.
      const claim = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        relatedSupplementArrived: false,
        assertCurrent: guard,
      });
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        note: "橘猫在沙发上",
        modelName: "vision-a",
        expectedAttempts: claim.attempt,
        claimToken: claim.claimToken,
        assertCurrent: guard,
      });
      const done = findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" });
      expect(done).toMatchObject({
        status: "succeeded",
        note: "橘猫在沙发上",
        modelName: "vision-a",
        purpose: "baseline",
        questionKey: null,
        attempts: 1,
      });
      // A successful cache hit is the answer: no new baseline task, no reset.
      expect(
        await rejectsReason(
          attemptMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            modelName: "vision-b",
            policy: "p2",
            contentSha256: SHA,
            assertCurrent: guard,
          }),
        ),
      ).toBe("already_succeeded");
      // A distinct detail question still gets its own task (cache not enough).
      const detail = recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("左上角的时间"),
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      expect(detail.created).toBe(true);
      // Result stamps carry purpose/question on detail tasks too.
      const detailClaim = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("左上角的时间"),
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        assertCurrent: guard,
      });
      // A detail result that omits its question key is refused (the type
      // system hides the shape, so the malformed call goes through the REAL
      // function via Reflect.apply with a genuinely key-less object — the
      // valid attempt/token prove it is the missing key that is rejected).
      expect(() =>
        Reflect.apply(recordMediaReadTaskResult, undefined, [
          h.orm,
          {
            mediaNoteId: "mn-1",
            purpose: "detail",
            note: "左上角写着 12:00",
            modelName: "vision-a",
            expectedAttempts: detailClaim.attempt,
            claimToken: detailClaim.claimToken,
            assertCurrent: guard,
          },
        ]),
      ).toThrow(TypeError);
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("左上角的时间"),
        note: "左上角写着 12:00",
        modelName: "vision-a",
        expectedAttempts: detailClaim.attempt,
        claimToken: detailClaim.claimToken,
        assertCurrent: guard,
      });
      expect(
        findMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "detail",
          questionKey: normalizeQuestionKey("左上角的时间"),
        }),
      ).toMatchObject({ status: "succeeded", note: "左上角写着 12:00" });
    } finally {
      h.close();
    }
  });

  it("refuses a result when the media row changed under the task", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      const claim = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        assertCurrent: guard,
      });
      // The media row expired while the model was reading: the result must not
      // be published, and the task stays failed at 1 consumed attempt.
      h.db
        .query("UPDATE qq_media_notes SET expires_at='2000-01-01T00:00:00.000000Z' WHERE id='mn-1'")
        .run();
      expect(() =>
        recordMediaReadTaskResult(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          note: "过期结果",
          modelName: "vision-a",
          expectedAttempts: claim.attempt,
          claimToken: claim.claimToken,
          assertCurrent: guard,
        }),
      ).toThrow();
      // The consumed attempt is recorded as failure evidence, not a success.
      failMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        expectedAttempt: claim.attempt,
        revisionAtClaim: claim.task.revision,
        claimToken: claim.claimToken,
        assertCurrent: guard,
      });
      expect(findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" })).toMatchObject({
        status: "failed",
        note: null,
        attempts: 1,
      });
    } finally {
      h.close();
    }
  });

  it("re-validates the frozen source state through the required host checkpoint", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      const claim = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        relatedSupplementArrived: false,
        assertCurrent: guard,
      });
      // The source state moved while the model was reading: agent rebound,
      // authority bumped, group capability turned. (`paused` cannot move in the
      // same UPDATE — the 0005 CHECK pairs it with owner_identity_revision —
      // so the off-switch moves in its own write.)
      h.db
        .query(
          `UPDATE qq_bindings SET agent_id='${AGENT2}', authority_revision=2, revision=2 WHERE id='${BINDING_ID}'`,
        )
        .run();
      h.db
        .query(
          `UPDATE qq_group_agent_configs SET capability_revisions='{"media_input":1}' WHERE binding_id='${BINDING_ID}'`,
        )
        .run();
      // Success refuses loudly with the authority code — never a swallowed
      // pseudo-failure publication.
      expect(
        thrownCode(() =>
          recordMediaReadTaskResult(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            note: "撤权后的迟到结果",
            modelName: "vision-a",
            expectedAttempts: claim.attempt,
            claimToken: claim.claimToken,
            assertCurrent: guard,
          }),
        ),
      ).toBe("CONTEXT_SOURCE_INVALID");
      // The failure callback hits the same wall.
      expect(
        thrownCode(() =>
          failMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            expectedAttempt: claim.attempt,
            revisionAtClaim: claim.task.revision,
            claimToken: claim.claimToken,
            assertCurrent: guard,
          }),
        ),
      ).toBe("CONTEXT_SOURCE_INVALID");
      // Nothing was written: note/status/revision unchanged and the consumed
      // attempt stays counted — revocation never resets the budget.
      expect(findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" })).toMatchObject({
        status: "running",
        note: null,
        attempts: 1,
        revision: claim.task.revision,
      });
      // A fresh claim on a second task hits the same wall at the claim
      // boundary: no attempt is spent either.
      recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("撤权后的新问题"),
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      expect(
        await rejectedCode(
          attemptMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "detail",
            questionKey: normalizeQuestionKey("撤权后的新问题"),
            modelName: "vision-a",
            policy: "p1",
            contentSha256: SHA,
            assertCurrent: guard,
          }),
        ),
      ).toBe("CONTEXT_SOURCE_INVALID");
      expect(
        findMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "detail",
          questionKey: normalizeQuestionKey("撤权后的新问题"),
        }),
      ).toMatchObject({ status: "pending", attempts: 0 });
    } finally {
      h.close();
    }
  });

  it("advances a same-epoch success and failure through the required checkpoint", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      const claim = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        relatedSupplementArrived: false,
        assertCurrent: guard,
      });
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        note: "橘猫在沙发上",
        modelName: "vision-a",
        expectedAttempts: claim.attempt,
        claimToken: claim.claimToken,
        assertCurrent: guard,
      });
      expect(findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" })).toMatchObject({
        status: "succeeded",
        note: "橘猫在沙发上",
        attempts: 1,
      });
      // The failure path advances through the same checkpoint on its own task.
      recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("同纪元的失败"),
        policy: "p1",
        contentSha256: SHA,
        expiresAt: EXPIRES,
      });
      const detailClaim = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("同纪元的失败"),
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        assertCurrent: guard,
      });
      failMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "detail",
        questionKey: normalizeQuestionKey("同纪元的失败"),
        expectedAttempt: detailClaim.attempt,
        revisionAtClaim: detailClaim.task.revision,
        claimToken: detailClaim.claimToken,
        assertCurrent: guard,
      });
      expect(
        findMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "detail",
          questionKey: normalizeQuestionKey("同纪元的失败"),
        }),
      ).toMatchObject({ status: "failed", attempts: 1 });
    } finally {
      h.close();
    }
  });

  it("refuses a stale failure for a missing or succeeded task instead of swallowing it", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      // No task row exists yet: the late failure must be refused, not dropped.
      expect(
        thrownCode(() =>
          failMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            expectedAttempt: 1,
            revisionAtClaim: 1,
            claimToken: "no-such-claim",
            assertCurrent: guard,
          }),
        ),
      ).toBe("MEMORY_SOURCE_INVALID");
      // A succeeded task: the late failure is refused like every strict write.
      const claim = await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        relatedSupplementArrived: false,
        assertCurrent: guard,
      });
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        note: "橘猫在沙发上",
        modelName: "vision-a",
        expectedAttempts: claim.attempt,
        claimToken: claim.claimToken,
        assertCurrent: guard,
      });
      expect(
        thrownCode(() =>
          failMediaReadTask(h.orm, {
            mediaNoteId: "mn-1",
            purpose: "baseline",
            expectedAttempt: claim.attempt,
            revisionAtClaim: claim.task.revision,
            claimToken: claim.claimToken,
            assertCurrent: guard,
          }),
        ),
      ).toBe("MEMORY_SOURCE_INVALID");
      expect(findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" })).toMatchObject({
        status: "succeeded",
        attempts: 1,
      });
    } finally {
      h.close();
    }
  });

  it("counts real unfinished and failed tasks for the unread gate", () => {
    const { h } = taskFixture();
    try {
      // A failed legacy task (attempts preserved) counts against the gate...
      h.db
        .query(
          `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, model_name,
            policy, attempts, status, note, revision, expires_at, recorded_at,
            account_id, conversation_kind, peer_id, agent_id)
           VALUES ('rt-legacy-fail', 'mn-1', 'baseline', NULL, NULL, 'legacy', 2, 'failed', NULL, 1, ?, ?,
            '10001', 'group', '20001', '${AGENT}')`,
        )
        .run(EXPIRES, NOW);
      expect(failedMediaReadTaskCount(h.orm, ["mn-1"], NOW)).toBe(1);
      // ...and a succeeded task no longer does: 新 task 成功后按真实状态放行。
      h.db
        .query(
          "UPDATE qq_media_read_tasks SET status='succeeded', note='有效读法', model_name='vision-a' WHERE id='rt-legacy-fail'",
        )
        .run();
      expect(failedMediaReadTaskCount(h.orm, ["mn-1"], NOW)).toBe(0);
      // In-flight (running) tasks count too — fail closed.
      h.db
        .query(
          "UPDATE qq_media_read_tasks SET status='running', note=NULL WHERE id='rt-legacy-fail'",
        )
        .run();
      expect(failedMediaReadTaskCount(h.orm, ["mn-1"], NOW)).toBe(1);
      // Expired tasks block nothing.
      expect(failedMediaReadTaskCount(h.orm, ["mn-1"], EXPIRES)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("guard rejection on a fresh task leaves NO task row, attempt or revision behind", async () => {
    const { h } = taskFixture();
    try {
      // A revocation write placed at the guard boundary (same live tx) makes the
      // frozen state stale: the claim is refused and rolls back atomically.
      const guardThatThrows = (tx: Parameters<MediaTaskSourceGuard>[0]) => {
        // (0005 pairs authority_revision with revision — a real revocation
        // moves both, and so does this simulated racing writer.)
        tx.run(
          sql`UPDATE qq_bindings SET authority_revision = 2, revision = 2 WHERE id = ${BINDING_ID}`,
        );
        const moved = tx
          .select({ authorityRevision: qqBindings.authorityRevision })
          .from(qqBindings)
          .where(eq(qqBindings.id, BINDING_ID))
          .get();
        // The frozen state no longer matches what the host froze at claim
        // time: refuse with the authority code.
        if (!moved || moved.authorityRevision !== INITIAL_SOURCE_STATE.authorityRevision) {
          fail("CONTEXT_SOURCE_INVALID", "会话绑定、授权或能力已变化");
        }
      };
      const before = taskStateSnapshot(h.orm);
      expect(before).toEqual([]);
      const promise = attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        assertCurrent: guardThatThrows,
      });
      await expect(promise).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      // The atomicity claim: nothing persisted — no task row, no spent attempt.
      expect(taskStateSnapshot(h.orm)).toEqual(before);
    } finally {
      h.close();
    }
  });

  it("a claim refused by already-moved source state consumes nothing and creates nothing", async () => {
    const { h } = taskFixture();
    try {
      const guard = bindingCheckpoint(INITIAL_SOURCE_STATE);
      // Move the frozen state before the claim: the guard refuses inside the
      // same transaction, so creation rolls back with it. (0005 pairs
      // authority_revision with revision, as a real revocation does.)
      h.db
        .query(`UPDATE qq_bindings SET authority_revision=2, revision=2 WHERE id='${BINDING_ID}'`)
        .run();
      const promise = attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        assertCurrent: guard,
      });
      await expect(promise).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(taskStateSnapshot(h.orm)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("a claim whose task revision moves between the task read and the CAS is refused at the same-tx boundary", async () => {
    const { h } = taskFixture();
    try {
      // Interleave a revision bump through the documented post-read callback
      // (proveSupplementLaterThan) after the claim reads the row but before its
      // CAS: the revision guard must refuse; deleting it would let this claim
      // really take attempt 2.
      const claimPromise = attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-1",
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        contentSha256: SHA,
        assertCurrent: bindingCheckpoint(INITIAL_SOURCE_STATE),
      }).then((first) => {
        // Consume attempt 1, fail it: attempt 2 requires the callback, the only
        // real-time hook between the claim's read and its CAS.
        failMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          expectedAttempt: first.attempt,
          revisionAtClaim: first.task.revision,
          claimToken: first.claimToken,
          assertCurrent: bindingCheckpoint(INITIAL_SOURCE_STATE),
        });
        return attemptMediaReadTask(h.orm, {
          mediaNoteId: "mn-1",
          purpose: "baseline",
          modelName: "vision-a",
          policy: "p1",
          contentSha256: SHA,
          proveSupplementLaterThan: () => {
            h.orm
              .update(qqMediaReadTasks)
              .set({ revision: sql`${qqMediaReadTasks.revision} + 1` })
              .where(eq(qqMediaReadTasks.id, first.task.id))
              .run();
            return true;
          },
          assertCurrent: bindingCheckpoint(INITIAL_SOURCE_STATE),
        });
      });
      await expect(claimPromise).rejects.toMatchObject({ reason: "attempts_exhausted" });
      // Attempt 2 was NOT taken; the refusal also rolls back the interleaved
      // bump, so the row keeps the revision (3) the failure wrote.
      const task = findMediaReadTask(h.orm, { mediaNoteId: "mn-1", purpose: "baseline" });
      expect(task).toMatchObject({ status: "failed", attempts: 1 });
      expect(task?.revision).toBe(3);
    } finally {
      h.close();
    }
  });

  it("imports legacy notes and attempts without zeroing or extending them", () => {
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
         VALUES ('ev-ok', '10001', 'group', '20001', '${AGENT}', 'm1', 10, 'member', '30001', '${NOW}')`,
      );
      db.exec(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES ('ev-fail', '10001', 'group', '20001', '${AGENT}', 'm2', 10, 'member', '30001', '${NOW}')`,
      );
      db.exec(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          note, note_model, attempts, expires_at, recorded_at, updated_at)
         VALUES ('mn-ok', 'ev-ok', 0, 'image', 'ref', '旧描述', '旧模型', 1, '${EXPIRES}', '${NOW}', '${NOW}')`,
      );
      db.exec(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES ('mn-fail', 'ev-fail', 0, 'image', 'ref', 2, '${EXPIRES}', '${NOW}', '${NOW}')`,
      );
      ensureBusinessSchema(db);
      expect(
        db
          .query(
            `SELECT media_note_id, purpose, question_key, model_name, policy, attempts, status,
              note, expires_at FROM qq_media_read_tasks ORDER BY media_note_id`,
          )
          .all(),
      ).toEqual([
        {
          media_note_id: "mn-fail",
          purpose: "baseline",
          question_key: null,
          model_name: null,
          policy: "legacy",
          attempts: 2,
          status: "failed",
          note: null,
          expires_at: EXPIRES,
        },
        {
          media_note_id: "mn-ok",
          purpose: "baseline",
          question_key: null,
          model_name: "旧模型",
          policy: "legacy",
          attempts: 1,
          status: "succeeded",
          note: "旧描述",
          expires_at: EXPIRES,
        },
      ]);
    } finally {
      db.close();
    }
  });
});
