import { describe, expect, it } from "bun:test";
import {
  type ObservationAudience,
  observationRelevant,
} from "../../src/server/conversation/observation-relevance";
import type { ConversationEvent } from "../../src/shared/contracts/conversation";

const at = "2026-10-09T00:00:00.000Z";

function event(
  input: { kind: ConversationEvent["kind"] } & Partial<ConversationEvent>,
): ConversationEvent {
  return {
    conversationId: "c1",
    seq: 1,
    eventKey: "e1",
    source: { kind: "qq_event", id: "e1", revision: at },
    sources: [{ kind: "qq_event", id: "e1", revision: at }],
    occurredAt: at,
    recordedAt: at,
    participant: { id: "u1", label: "u1", role: "member" },
    addressing: { reasons: [], mentionIds: [] },
    runId: null,
    outputId: null,
    ...input,
  };
}

const inbound = event({ kind: "inbound" });
// 宿主读入的来源就是该消息的 sources：qq_event 父消息 + qq_observation + qq_media。
const sharedChiming: ObservationAudience = {
  topology: "shared",
  participantIds: [null],
  purpose: "chiming_in",
  usedSources: [
    { kind: "qq_event", id: "e1", revision: at },
    { kind: "qq_media", id: "m1", revision: "1" },
  ],
};

describe("observationRelevant", () => {
  it("keeps the pre-existing rule when purpose and usedSources are absent", () => {
    const audience: ObservationAudience = { topology: "shared", participantIds: ["u1"] };
    expect(observationRelevant(inbound, audience)).toBe(true);
    expect(
      observationRelevant(event({ kind: "inbound", participant: null }), {
        topology: "shared",
        participantIds: ["u2"],
      }),
    ).toBe(false);
    expect(
      observationRelevant(
        event({ kind: "inbound", addressing: { reasons: ["mention"], mentionIds: [] } }),
        {
          topology: "shared",
          participantIds: ["u2"],
        },
      ),
    ).toBe(true);
    expect(observationRelevant(inbound, { topology: "direct", participantIds: [] })).toBe(true);
    expect(observationRelevant(event({ kind: "wake" }), sharedChiming)).toBe(false);
  });

  it("sends ordinary group chiming input to the next batch", () => {
    expect(observationRelevant(inbound, sharedChiming)).toBe(false);
    expect(
      observationRelevant(
        event({
          kind: "inbound",
          addressing: { reasons: ["mention", "reply_to_agent"], mentionIds: [] },
          participant: { id: "u9", label: "u9", role: "member" },
        }),
        sharedChiming,
      ),
    ).toBe(false);
  });

  it("still invalidates the batch when used content is revised", () => {
    const media = event({
      kind: "media_revision",
      sources: [
        { kind: "qq_event", id: "e1", revision: at },
        { kind: "qq_media", id: "m1", revision: "2" },
      ],
    });
    expect(observationRelevant(media, sharedChiming)).toBe(true);
    const parentRevision = event({
      kind: "media_revision",
      sources: [{ kind: "qq_event", id: "e1", revision: at }],
    });
    expect(observationRelevant(parentRevision, sharedChiming)).toBe(true);
    const unused = event({
      kind: "media_revision",
      sources: [
        { kind: "qq_event", id: "e2", revision: at },
        { kind: "qq_media", id: "m2", revision: "2" },
      ],
    });
    expect(observationRelevant(unused, sharedChiming)).toBe(false);
  });

  it("does not treat a replay of the used source id as a revision", () => {
    const replay = event({
      kind: "inbound",
      sources: [{ kind: "qq_media", id: "m1", revision: "1" }],
    });
    expect(observationRelevant(replay, sharedChiming)).toBe(false);
  });

  it("leaves other purposes on the original filtering, used sources included", () => {
    const outside = event({
      kind: "media_revision",
      participant: { id: "u9", label: "u9", role: "member" },
      sources: [{ kind: "qq_media", id: "m1", revision: "2" }],
    });
    const blocked: ObservationAudience = {
      topology: "shared",
      participantIds: ["u1"],
      attentionMembers: ["u1"],
      usedSources: [{ kind: "qq_media", id: "m1", revision: "1" }],
    };
    expect(observationRelevant(outside, { ...blocked, purpose: "direct_reply" })).toBe(false);
    expect(observationRelevant(outside, { ...blocked, purpose: "follow_up" })).toBe(false);
    expect(observationRelevant(outside, { ...blocked, purpose: "idle_topic" })).toBe(false);
    expect(
      observationRelevant(outside, {
        ...blocked,
        topology: "direct",
        purpose: "direct_reply",
        attentionMembers: undefined,
      }),
    ).toBe(true);
    // 原判据：解除 attentionMembers 后只按 participantIds 说话人判，未知说话人仍 false。
    expect(
      observationRelevant(outside, {
        ...blocked,
        purpose: "follow_up",
        attentionMembers: undefined,
      }),
    ).toBe(false);
    expect(
      observationRelevant(
        event({ kind: "media_revision", sources: [{ kind: "qq_media", id: "m1", revision: "2" }] }),
        { ...blocked, purpose: "follow_up", attentionMembers: undefined },
      ),
    ).toBe(true);
  });
});
