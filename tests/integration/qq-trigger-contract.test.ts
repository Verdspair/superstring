import { describe, expect, it } from "bun:test";
import { classifyQqTrigger } from "../../src/server/services/qq-trigger-contract";

const sample = { conversationKind: "group", speaker: "member", mentionsSelf: false };
describe("QQ trigger classification boundary", () => {
  it("classifies explicit group @ as direct reply regardless of initiative hint", () => {
    expect(classifyQqTrigger({ ...sample, mentionsSelf: true })).toEqual({
      kind: "classified",
      path: "direct_reply",
    });
    expect(
      classifyQqTrigger({ ...sample, mentionsSelf: true, initiativePath: "idle_topic" }),
    ).toEqual({ kind: "classified", path: "direct_reply" });
  });
  it("offers group talk as a judgement candidate, not permission to speak", () => {
    expect(classifyQqTrigger(sample)).toEqual({ kind: "candidate", path: "chiming_in" });
    expect(classifyQqTrigger({ ...sample, followsAssistant: false })).toEqual({
      kind: "candidate",
      path: "chiming_in",
    });
    expect(classifyQqTrigger({ ...sample, speaker: "anonymous" })).toEqual({
      kind: "pending",
      reason: "not_classified",
    });
  });
  it("routes private speech and verified follow-up without converting a hint into a send", () => {
    expect(classifyQqTrigger({ ...sample, conversationKind: "private" })).toEqual({
      kind: "classified",
      path: "direct_reply",
    });
    expect(
      classifyQqTrigger({ ...sample, conversationKind: "private", followsAssistant: true }),
    ).toEqual({
      kind: "classified",
      path: "follow_up",
    });
    expect(classifyQqTrigger({ ...sample, followsAssistant: true })).toEqual({
      kind: "classified",
      path: "follow_up",
    });
  });
  it("accepts only independently chosen initiative paths", () => {
    expect(classifyQqTrigger({ ...sample, initiativePath: "chiming_in" })).toEqual({
      kind: "classified",
      path: "chiming_in",
    });
    expect(classifyQqTrigger({ ...sample, initiativePath: "idle_topic" })).toEqual({
      kind: "classified",
      path: "idle_topic",
    });
    expect(() => classifyQqTrigger({ ...sample, initiativePath: "follow_up" })).toThrow(TypeError);
    expect(() => classifyQqTrigger({ ...sample, initiativePath: "direct_reply" })).toThrow(
      TypeError,
    );
  });
  it("never classifies a system notification", () => {
    expect(
      classifyQqTrigger({
        ...sample,
        speaker: "system",
        mentionsSelf: true,
        initiativePath: "chiming_in",
      }),
    ).toEqual({ kind: "ignored", reason: "system_message" });
  });
  it("rejects malformed, extra and missing input without logging content", () => {
    for (const input of [
      null,
      {},
      { ...sample, extra: "text" },
      { ...sample, mentionsSelf: "true" },
    ])
      expect(() => classifyQqTrigger(input)).toThrow(TypeError);
  });
});
