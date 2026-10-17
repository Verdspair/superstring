import { describe, expect, it } from "bun:test";
import {
  CONFIRMED_ANSWER_TEXT,
  peerReply,
  read,
  sourceFixture,
} from "../harness/qq-reply-continuity";

describe("QQ related-reply checkpoints", () => {
  it("detects a changed related delivery before the next model read and consumes it once", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    const source = h.buildSource(undefined, "chiming_in");
    await read(source);
    expect(source.relatedRepliesChanged()).toBe(false);
    peer.complete();
    peer.settle("confirmed");
    expect(source.relatedRepliesChanged()).toBe(true);
    await read(source);
    expect(source.relatedRepliesChanged()).toBe(false);
  });
  it("keeps child view changes private while both children can read a newly confirmed peer answer", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    const parent = h.buildSource(undefined, "chiming_in");
    await read(parent);
    const child = (id: string) =>
      parent.childReplySession({
        spec: {
          id,
          model: "reply-model",
          context: "conversation",
          instructions: "synthetic",
          availableActions: [],
          limits: { steps: 16 },
        },
        targets: [{ id: "alice", speakerId: "20002" }],
        decisionTier: "reply",
        batchIntents: { value: [], sources: [] },
      });
    const first = child("child-one");
    const second = child("child-two");
    await read(first);
    await read(second);
    peer.complete();
    peer.settle("confirmed");
    expect(first.relatedRepliesChanged()).toBe(true);
    expect(second.relatedRepliesChanged()).toBe(true);
    await read(first);
    expect(first.relatedRepliesChanged()).toBe(false);
    expect(second.relatedRepliesChanged()).toBe(true);
    expect(JSON.stringify(await read(second))).toContain(CONFIRMED_ANSWER_TEXT);
  });
  it("leaves stable terminal budget feedback readable but fails closed if a related answer changes", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    const source = h.buildSource(undefined, "chiming_in");
    await read(source);
    // The host exposes terminal status, while its flag remains run-private.
    (source as unknown as { terminalBudgetFeedback: boolean }).terminalBudgetFeedback = true;
    await read(source);
    peer.complete();
    peer.settle("confirmed");
    await expect(read(source)).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
  });
  it("does not acknowledge changed facts when only a tool-result fitter prepares a cached view", async () => {
    const h = sourceFixture();
    h.seed("CURRENT-TOPIC");
    const peer = peerReply(h);
    const source = h.buildSource(undefined, "chiming_in");
    await read(source);
    peer.complete();
    peer.settle("confirmed");
    expect(source.relatedRepliesChanged()).toBe(true);
    await source.actionResultFitter(
      "web.fetch",
      { url: "https://public.example" },
      new AbortController().signal,
      true,
    );
    expect(source.relatedRepliesChanged()).toBe(true);
    await read(source);
    expect(source.relatedRepliesChanged()).toBe(false);
  });
});
