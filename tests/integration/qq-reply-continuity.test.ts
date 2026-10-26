import { describe, expect, it } from "bun:test";
import {
  CONFIRMED_ANSWER_TEXT,
  FIXED_NOW,
  INTENT_TEXT,
  jobs,
  peerReply,
  read,
  sourceFixture,
} from "../harness/qq-reply-continuity";

describe("QQ reply continuity over canonical delivery facts", () => {
  it("retains a valid public intent when the peer task completes before sending settles", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    const source = h.buildSource();
    expect(
      jobs(await read(source)).find((j) => j.taskId === "peer-inflight")?.declaredIntents?.[0]
        ?.intent,
    ).toBe(INTENT_TEXT);
    peer.complete();
    const material = await read(source);
    const peerJob = jobs(material).find((j) => j.taskId === "peer-inflight");
    expect(peerJob).toBeDefined();
    expect(peerJob?.declaredIntents?.[0]?.intent).toBe(INTENT_TEXT);
    expect(peerJob?.reply).toBe("planned");
    expect(JSON.stringify(material)).not.toContain(CONFIRMED_ANSWER_TEXT);
  });
  it("keeps unknown delivery unknown and does not expose its attempted text as a confirmed answer", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    peer.complete();
    peer.settle("unknown");
    const material = await read(h.buildSource());
    expect(jobs(material).find((j) => j.taskId === "peer-inflight")?.reply).toBe("unknown");
    expect(JSON.stringify(material)).not.toContain(CONFIRMED_ANSWER_TEXT);
  });
  it("does not restore a revoked public intent merely because an unsettled outbox exists", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    peer.complete();
    peer.runs.redactContext({ runId: peer.scoreRunId, stepId: peer.stepId }, "revoked");
    const material = await read(h.buildSource());
    expect(
      jobs(material).find((j) => j.taskId === "peer-inflight")?.declaredIntents,
    ).toBeUndefined();
    expect(JSON.stringify(material)).not.toContain(INTENT_TEXT);
  });
  it("refreshes a confirmed predecessor answer in an existing cached source and then reuses unchanged material", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    const source = h.buildSource();
    const first = await read(source);
    expect(JSON.stringify(first)).not.toContain(CONFIRMED_ANSWER_TEXT);
    peer.complete();
    peer.settle("confirmed");
    const second = await read(source);
    expect(JSON.stringify(second)).toContain(CONFIRMED_ANSWER_TEXT);
    const third = await read(source);
    expect(JSON.stringify(third)).toBe(JSON.stringify(second));
    expect(third.pending).toBe(second.pending);
  });
  it("does not rebuild for its own task delivery", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    const source = h.buildSource("peer-inflight");
    const first = await read(source);
    peer.complete();
    peer.settle("confirmed");
    const second = await read(source);
    expect(jobs(second).find((j) => j.taskId === "peer-inflight")).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain(CONFIRMED_ANSWER_TEXT);
    expect(second.pending).toBe(first.pending);
  });
  it("does not rebuild for another target's unrelated delivery", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    h.db
      .query(
        "UPDATE outbound_intents SET target=json_set(target,'$.participantId','20003') WHERE id=?",
      )
      .run(peer.intent.id);
    const source = h.buildSource();
    const first = await read(source);
    peer.complete();
    peer.settle("confirmed");
    const second = await read(source);
    expect(JSON.stringify(second)).not.toContain(CONFIRMED_ANSWER_TEXT);
    // Active-task metadata can change; unchanged history objects prove no full rebuild.
    expect(second.history?.[0]).toBe(first.history?.[0]);
  });
  it("does not turn an expired outbox into a new readable public intention", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    peer.complete();
    h.db
      .query("UPDATE outbound_intents SET expires_at=? WHERE id=?")
      .run(FIXED_NOW, peer.intent.id);
    const material = await read(h.buildSource());
    expect(jobs(material).find((j) => j.taskId === "peer-inflight")).toBeUndefined();
    expect(JSON.stringify(material)).not.toContain(INTENT_TEXT);
  });
  it("reports omitted related replies without widening the existing presentation bound", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    peer.complete();
    for (let index = 0; index < 7; index++) {
      h.db
        .query(`INSERT INTO outbound_intents(id,run_id,conversation_id,output_ordinal,target,speech_kind,
        source_through_seq,deliver_by,status,created_at,expires_at)
        SELECT ?,run_id,conversation_id,?,target,speech_kind,source_through_seq,deliver_by,status,created_at,expires_at
        FROM outbound_intents WHERE id=?`)
        .run(`extra-${index}`, index + 1, peer.intent.id);
    }
    const material = await read(h.buildSource());
    const projection = (material.pending ?? []).flatMap((m) =>
      m.content.flatMap((p) => {
        if (p.kind !== "text") return [];
        try {
          const value = JSON.parse(p.text);
          return value.kind === "qq_concurrent_jobs" ? [value] : [];
        } catch {
          return [];
        }
      }),
    )[0];
    expect(projection?.omittedRelatedReplies).toBe(3);
    expect(projection.jobs.length).toBeLessThanOrEqual(5);
  });
});
