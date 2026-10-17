import { describe, expect, it } from "bun:test";
import {
  concurrentJobsDumpValue,
  readConcurrentReplyJobs,
} from "../../src/server/channels/onebot11/concurrent-reply-context";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { AppError } from "../../src/server/errors";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import { cloneBusinessDb } from "../harness/business-db";

const NOW = "2026-10-16T00:00:00.000Z";
const REF: SourceRef = { kind: "fixture", id: "source", revision: "1" };
function fixture() {
  const h = cloneBusinessDb();
  ensureDefaults(h.orm, "intent-model");
  h.db
    .query(
      "INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,created_at,updated_at) VALUES('conv','onebot11','shared','binding',?,?,1,?,?)",
    )
    .run(DEFAULT_AGENT_ID, DEFAULT_USER_ID, NOW, NOW);
  h.db
    .query(
      "INSERT INTO wake_signals(id,conversation_id,cause,through_seq,dedupe_key,ready_at,priority,status,created_at) VALUES('wake','conv','chiming_in',2,'wake',?,50,'completed',?)",
    )
    .run(NOW, NOW);
  h.db
    .query(
      "INSERT INTO qq_conversation_tasks(id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,source_from_seq,source_through_seq,status,judgement_done,origin_wake_id,created_at,updated_at) VALUES('task','key','conv',1,?,'ordinary','chiming_in',1,2,'pending',1,'wake',?,?)",
    )
    .run(DEFAULT_AGENT_ID, NOW, NOW);
  const runs = new AgentRunRepository(h.db);
  runs.createRun({
    runId: "score",
    specId: "onebot.initiative.evaluate_batch",
    specVersion: "1",
    owner: {
      kind: "qq_binding",
      id: "binding",
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
    },
    at: NOW,
  });
  h.db
    .query(
      "UPDATE agent_runs SET conversation_id='conv',wake_id='wake',observed_seq=2 WHERE run_id='score'",
    )
    .run();
  const envelope = {
    kind: "qq_batch_targets",
    trust: "data_only",
    sourceSeqs: [1, 2],
    targets: [{ targetId: "member", speakerId: "member", sourceSeqs: [2] }],
  };
  runs.startStep({
    runId: "score",
    stepId: "step",
    stepNo: 1,
    model: "test",
    phase: "leaf",
    at: NOW,
    messages: [{ role: "user", content: [{ kind: "text", text: JSON.stringify(envelope) }] }],
    sources: [REF],
  });
  const intent = "new contribution ".repeat(100);
  const answer = { evaluations: [{ targetId: "member", score: 8, intent, sourceSeqs: [1] }] };
  runs.finishStep("step", "completed", NOW, {
    output: { text: JSON.stringify(answer), format: "text", complete: true },
  });
  runs.setStatus("score", "completed", NOW);
  const read = (assertSources?: (sources: readonly SourceRef[]) => void) =>
    readConcurrentReplyJobs(h.db, {
      conversationId: "conv",
      bindingEpoch: 1,
      agentId: DEFAULT_AGENT_ID,
      now: NOW,
      visibleEventKeys: new Set(),
      ...(assertSources ? { assertSources } : {}),
    });
  return { h, runs, read, intent, answer };
}
describe("protected declared intent facts", () => {
  it("unwraps the real protected response, retains full intent and provenance, and defaults to metadata without a guard", () => {
    const f = fixture();
    try {
      expect(f.read().jobs[0]?.declaredIntents).toBeUndefined();
      let checked = 0;
      const result = f.read((refs) => {
        checked++;
        expect(refs).toEqual([REF]);
      });
      expect(checked).toBe(1);
      expect(result.jobs[0]?.declaredIntents).toEqual([
        { targetId: "member", score: 8, intent: f.intent },
      ]);
      expect(result.sources).toEqual([REF]);
      expect(result.contexts).toEqual([{ runId: "score", stepId: "step", expiresAt: null }]);
      const dump = JSON.stringify(concurrentJobsDumpValue(result));
      expect(dump).not.toContain("source_refs");
      expect(dump).not.toContain("contexts");
      expect(dump).not.toContain("evaluations");
    } finally {
      f.h.close();
    }
  });
  it("omits only unavailable unrelated sources and propagates operational errors", () => {
    const f = fixture();
    try {
      for (const code of ["CONTEXT_SOURCE_INVALID", "QQ_GROUP_CAPABILITY_DISABLED"] as const) {
        const p = f.read(() => {
          throw new AppError(code, "revoked");
        });
        expect(p.jobs[0]?.declaredIntents).toBeUndefined();
        expect(p.sources).toEqual([]);
      }
      expect(() =>
        f.read(() => {
          throw new Error("SQL_READ_FAILED");
        }),
      ).toThrow("SQL_READ_FAILED");
    } finally {
      f.h.close();
    }
  });
  for (const mutation of [
    "UPDATE agent_runs SET owner_id='other' WHERE run_id='score'",
    "UPDATE agent_runs SET observed_seq=3 WHERE run_id='score'",
    "UPDATE agent_runs SET status='failed' WHERE run_id='score'",
    "UPDATE context_snapshots SET status='revoked' WHERE step_id='step'",
    "UPDATE context_snapshots SET expires_at='2026-10-15T23:59:59Z' WHERE step_id='step'",
    "UPDATE context_snapshots SET output_recorded=0 WHERE step_id='step'",
    "UPDATE context_snapshots SET protected_output=NULL WHERE step_id='step'",
    "UPDATE qq_conversation_tasks SET judgement_done=0 WHERE id='task'",
  ])
    it(`rejects unavailable or mismatched proof: ${mutation}`, () => {
      const f = fixture();
      try {
        f.h.db.exec(mutation);
        expect(f.read(() => {}).jobs[0]?.declaredIntents).toBeUndefined();
      } finally {
        f.h.close();
      }
    });
  it("does not replace an unavailable first step with a later valid step", () => {
    const f = fixture();
    try {
      f.runs.startStep({
        runId: "score",
        stepId: "later",
        stepNo: 2,
        model: "test",
        phase: "leaf",
        at: NOW,
        messages: [],
        sources: [],
      });
      f.runs.finishStep("later", "completed", NOW, {
        output: { text: JSON.stringify(f.answer), format: "text", complete: true },
      });
      f.runs.redactContext({ runId: "score", stepId: "step" }, "revoked");
      expect(f.read(() => {}).jobs[0]?.declaredIntents).toBeUndefined();
    } finally {
      f.h.close();
    }
  });
  for (const answer of [
    { evaluations: [{ targetId: "other", score: 8, intent: "wrong target", sourceSeqs: [1] }] },
    { evaluations: [{ targetId: "member", score: 8, intent: "wrong reference", sourceSeqs: [3] }] },
    {
      evaluations: [
        { targetId: "member", score: 8, intent: "duplicate", sourceSeqs: [] },
        { targetId: "member", score: 8, intent: "duplicate", sourceSeqs: [] },
      ],
    },
  ])
    it("does not expose an output rejected by the original target/reference envelope", () => {
      const f = fixture();
      try {
        f.h.db
          .query("UPDATE context_snapshots SET protected_output=? WHERE step_id='step'")
          .run(JSON.stringify({ text: JSON.stringify(answer), format: "text", complete: true }));
        expect(f.read(() => {}).jobs[0]?.declaredIntents).toBeUndefined();
      } finally {
        f.h.close();
      }
    });
});
