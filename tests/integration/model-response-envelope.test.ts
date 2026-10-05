// T10a 红绿测试：同次模型响应封装的严格纯解析（规格 §7.2 / §10）。
// 只测纯解析器本体；不接线宿主，不做真实模型调用，不覆盖 consume 落库（留 T10 service）。
import { describe, expect, it } from "bun:test";
import {
  parseModelEnvelope,
  parseModelScoreEnvelope,
  parseModelTextEnvelope,
} from "../../src/server/agent/model-response-envelope";

const SENT = new Set(["img-1", "img-2"]);

describe("parseModelEnvelope (decision)", () => {
  it("accepts a none decision without media", () => {
    const result = parseModelEnvelope({ decision: { kind: "none" } }, SENT);
    expect(result.decision).toEqual({ kind: "none" });
    expect(result.media).toEqual([]);
  });

  it("accepts a decision with classifications inside the sent set", () => {
    const envelope = {
      decision: { kind: "none" },
      media: [{ mediaId: "img-1", category: "expression" }],
    };
    const result = parseModelEnvelope(envelope, SENT);
    expect(result.decision).toEqual({ kind: "none" });
    expect(result.media).toEqual([{ mediaId: "img-1", category: "expression" }]);
  });

  it("accepts invoke within the 1..4 batch limit", () => {
    const decision = {
      kind: "invoke" as const,
      calls: [
        { name: "a", arguments: {} },
        { name: "b", arguments: {} },
        { name: "c", arguments: {} },
        { name: "d", arguments: {} },
      ],
    };
    expect(parseModelEnvelope({ decision }, SENT).decision).toEqual(decision);
  });

  it("rejects an invoke batch over the limit (original schema authority)", () => {
    const decision = {
      kind: "invoke",
      calls: [
        { name: "a", arguments: {} },
        { name: "b", arguments: {} },
        { name: "c", arguments: {} },
        { name: "d", arguments: {} },
        { name: "e", arguments: {} },
      ],
    };
    expect(() => parseModelEnvelope({ decision }, SENT)).toThrow();
  });

  it("rejects an invoke with zero calls", () => {
    expect(() => parseModelEnvelope({ decision: { kind: "invoke", calls: [] } }, SENT)).toThrow();
  });

  it("rejects a final with no outputs", () => {
    expect(() => parseModelEnvelope({ decision: { kind: "final", outputs: [] } }, SENT)).toThrow();
  });

  it("rejects a forged mediaId outside the sent set", () => {
    const envelope = {
      decision: { kind: "none" },
      media: [{ mediaId: "forged", category: "ordinary" }],
    };
    expect(() => parseModelEnvelope(envelope, SENT)).toThrow();
  });

  it("rejects an unknown category", () => {
    const envelope = {
      decision: { kind: "none" },
      media: [{ mediaId: "img-1", category: "sticker" }],
    };
    expect(() => parseModelEnvelope(envelope, SENT)).toThrow();
  });

  it("rejects duplicate mediaId even with the same category", () => {
    const envelope = {
      decision: { kind: "none" },
      media: [
        { mediaId: "img-1", category: "ordinary" },
        { mediaId: "img-1", category: "ordinary" },
      ],
    };
    expect(() => parseModelEnvelope(envelope, SENT)).toThrow();
  });

  it("rejects duplicate mediaId with conflicting categories", () => {
    const envelope = {
      decision: { kind: "none" },
      media: [
        { mediaId: "img-1", category: "ordinary" },
        { mediaId: "img-1", category: "expression" },
      ],
    };
    expect(() => parseModelEnvelope(envelope, SENT)).toThrow();
  });

  it("rejects an empty mediaId", () => {
    const envelope = {
      decision: { kind: "none" },
      media: [{ mediaId: "", category: "ordinary" }],
    };
    expect(() => parseModelEnvelope(envelope, SENT)).toThrow();
  });

  it("rejects an extra top-level key (pseudo scope)", () => {
    expect(() =>
      parseModelEnvelope({ decision: { kind: "none" }, scope: "run-url" }, SENT),
    ).toThrow();
  });

  it("rejects an extra key inside a classification", () => {
    const envelope = {
      decision: { kind: "none" },
      media: [{ mediaId: "img-1", category: "ordinary", source: "model" }],
    };
    expect(() => parseModelEnvelope(envelope, SENT)).toThrow();
  });

  it("rejects an empty sent set with any classification", () => {
    const envelope = {
      decision: { kind: "none" },
      media: [{ mediaId: "img-1", category: "ordinary" }],
    };
    expect(() => parseModelEnvelope(envelope, new Set())).toThrow();
  });

  it("rejects a missing decision body even when media is valid", () => {
    expect(() => parseModelEnvelope({ media: [] }, SENT)).toThrow();
  });

  it("rejects a decision with an unknown kind (pseudo call shape)", () => {
    expect(() => parseModelEnvelope({ decision: { kind: "call", name: "x" } }, SENT)).toThrow();
  });

  it("does not mutate the caller's sent set and is independent across calls", () => {
    const sent = new Set(["img-1"]);
    parseModelEnvelope(
      { decision: { kind: "none" }, media: [{ mediaId: "img-1", category: "ordinary" }] },
      sent,
    );
    expect([...sent]).toEqual(["img-1"]);
    expect(() =>
      parseModelEnvelope(
        { decision: { kind: "none" }, media: [{ mediaId: "img-2", category: "ordinary" }] },
        sent,
      ),
    ).toThrow();
  });

  it("strips media and leaves the body strictly valid under the original schema", () => {
    const envelope = {
      decision: {
        kind: "final",
        outputs: [{ kind: "inline", targetId: "t1", text: "hello", stickerIds: [] }],
      },
      media: [{ mediaId: "img-1", category: "unknown" }],
    };
    const result = parseModelEnvelope(envelope, SENT);
    expect(result.decision.kind).toBe("final");
    expect(result.media).toEqual([{ mediaId: "img-1", category: "unknown" }]);
  });
});

describe("parseModelScoreEnvelope", () => {
  it("accepts score 0 and 10 without media", () => {
    expect(parseModelScoreEnvelope({ scoreResult: { score: 0 } }, SENT).scoreResult).toEqual({
      score: 0,
      reason: null,
    });
    expect(parseModelScoreEnvelope({ scoreResult: { score: 10 } }, SENT).scoreResult).toEqual({
      score: 10,
      reason: null,
    });
  });

  it("accepts a nullable and an absent reason", () => {
    expect(parseModelScoreEnvelope({ scoreResult: { score: 5, reason: null } }, SENT)).toEqual({
      scoreResult: { score: 5, reason: null },
      media: [],
    });
    expect(
      parseModelScoreEnvelope({ scoreResult: { score: 5 } }, SENT).scoreResult.reason,
    ).toBeNull();
  });

  it("rejects a fractional score (5.5)", () => {
    expect(() => parseModelScoreEnvelope({ scoreResult: { score: 5.5 } }, SENT)).toThrow();
  });

  it("rejects an out-of-range score (11, -1)", () => {
    expect(() => parseModelScoreEnvelope({ scoreResult: { score: 11 } }, SENT)).toThrow();
    expect(() => parseModelScoreEnvelope({ scoreResult: { score: -1 } }, SENT)).toThrow();
  });

  it("rejects a string score", () => {
    expect(() => parseModelScoreEnvelope({ scoreResult: { score: "7" } }, SENT)).toThrow();
  });

  it("rejects a reason over 200 chars", () => {
    expect(() =>
      parseModelScoreEnvelope({ scoreResult: { score: 5, reason: "x".repeat(201) } }, SENT),
    ).toThrow();
  });

  it("rejects an unreadable scoreResult shape (extra key, array, garbage)", () => {
    expect(() =>
      parseModelScoreEnvelope({ scoreResult: { score: 5, extra: true } }, SENT),
    ).toThrow();
    expect(() => parseModelScoreEnvelope({ scoreResult: [5] }, SENT)).toThrow();
    expect(() => parseModelScoreEnvelope({ scoreResult: "not a verdict" }, SENT)).toThrow();
  });

  it("rejects a missing scoreResult", () => {
    expect(() => parseModelScoreEnvelope({}, SENT)).toThrow();
  });

  it("carries validated media alongside the score", () => {
    const envelope = {
      scoreResult: { score: 5, reason: "ok" },
      media: [{ mediaId: "img-2", category: "expression" }],
    };
    expect(parseModelScoreEnvelope(envelope, SENT).media).toEqual([
      { mediaId: "img-2", category: "expression" },
    ]);
  });

  it("rejects a forged media classification", () => {
    expect(() =>
      parseModelScoreEnvelope(
        { scoreResult: { score: 5 }, media: [{ mediaId: "forged", category: "ordinary" }] },
        SENT,
      ),
    ).toThrow();
  });

  it("rejects an extra top-level key", () => {
    expect(() =>
      parseModelScoreEnvelope({ scoreResult: { score: 5 }, verdict: "go" }, SENT),
    ).toThrow();
  });
});

describe("parseModelTextEnvelope", () => {
  it("accepts an empty string (stickerOnly validity is the host's business)", () => {
    expect(parseModelTextEnvelope({ text: "" }, SENT)).toEqual({ text: "", media: [] });
  });

  it("accepts normal text with media", () => {
    const envelope = {
      text: "hello",
      media: [{ mediaId: "img-1", category: "ordinary" as const }],
    };
    expect(parseModelTextEnvelope(envelope, SENT)).toEqual(envelope);
  });

  it("rejects a non-string text", () => {
    expect(() => parseModelTextEnvelope({ text: 42 }, SENT)).toThrow();
    expect(() => parseModelTextEnvelope({ text: null }, SENT)).toThrow();
  });

  it("rejects a missing text", () => {
    expect(() => parseModelTextEnvelope({ media: [] }, SENT)).toThrow();
  });

  it("rejects an extra top-level key", () => {
    expect(() => parseModelTextEnvelope({ text: "x", url: "https://fake" }, SENT)).toThrow();
  });

  it("rejects a forged media classification", () => {
    expect(() =>
      parseModelTextEnvelope(
        { text: "x", media: [{ mediaId: "not-sent", category: "unknown" }] },
        SENT,
      ),
    ).toThrow();
  });
});
