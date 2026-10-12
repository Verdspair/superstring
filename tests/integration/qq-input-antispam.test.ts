import { describe, expect, test } from "bun:test";
import {
  deriveQqInputAntispam,
  type QqAntispamEvent,
  type QqAntispamPart,
} from "../../src/server/channels/onebot11/qq-input-antispam";

// ---- fixtures ----------------------------------------------------------------------

function text(t: string): QqAntispamPart {
  return { kind: "text", text: t };
}
function face(): QqAntispamPart {
  return { kind: "face" };
}
function img(mediaId: string, expressionEvidence = false): QqAntispamPart {
  return { kind: "image", mediaId, expressionEvidence };
}
function otherMedia(mediaKind: "record" | "video" | "file" = "record"): QqAntispamPart {
  return { kind: "otherMedia", mediaKind };
}
function unsupported(): QqAntispamPart {
  return { kind: "unsupported" };
}

function ev(input: {
  seq: number;
  speakerId: string;
  occurredAtSeconds: number;
  parts: QqAntispamPart[];
  sourceAvailable?: boolean;
  explicitDirect?: boolean;
  eventId?: string;
}): QqAntispamEvent {
  return {
    seq: input.seq,
    eventId: input.eventId ?? `e${input.seq}`,
    speakerId: input.speakerId,
    occurredAtSeconds: input.occurredAtSeconds,
    sourceAvailable: input.sourceAvailable ?? true,
    explicitDirect: input.explicitDirect ?? false,
    parts: input.parts,
  };
}

function imageCarrier(
  seq: number,
  speakerId: string,
  occurredAtSeconds: number,
  count = 1,
): QqAntispamEvent {
  return ev({
    seq,
    speakerId,
    occurredAtSeconds,
    parts: Array.from({ length: count }, (_, i) => img(`m${seq}-${i}`)),
  });
}

const ENABLED = {
  enabled: true,
  burstMinMessages: 3,
  burstWindowSeconds: 3,
} as const;

// ---- pure expression (§5.2) ----------------------------------------------------------

describe("pure expression eligibility filter", () => {
  test("face-only message with empty text is excluded when enabled", () => {
    const events = [ev({ seq: 1, speakerId: "A", occurredAtSeconds: 10, parts: [face()] })];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.pureExpressionExcludedSeqs).toEqual([1]);
    expect(result.burstGroups).toEqual([]);
  });

  test("platform-marked expression image with empty text is excluded", () => {
    const events = [
      ev({ seq: 1, speakerId: "A", occurredAtSeconds: 10, parts: [img("m1", true)] }),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.pureExpressionExcludedSeqs).toEqual([1]);
  });

  test("whitespace-only text still counts as empty; meaningful text prevents exclusion", () => {
    const whitespace = deriveQqInputAntispam({
      ...ENABLED,
      events: [ev({ seq: 1, speakerId: "A", occurredAtSeconds: 10, parts: [text("  "), face()] })],
    });
    expect(whitespace.pureExpressionExcludedSeqs).toEqual([1]);

    const meaningful = deriveQqInputAntispam({
      ...ENABLED,
      events: [
        ev({ seq: 2, speakerId: "A", occurredAtSeconds: 10, parts: [text("看这个"), face()] }),
      ],
    });
    expect(meaningful.pureExpressionExcludedSeqs).toEqual([]);
  });

  test("unmarked image prevents exclusion even with expression evidence", () => {
    const result = deriveQqInputAntispam({
      ...ENABLED,
      events: [ev({ seq: 1, speakerId: "A", occurredAtSeconds: 10, parts: [face(), img("m1")] })],
    });
    expect(result.pureExpressionExcludedSeqs).toEqual([]);
  });

  test("unsupported content prevents exclusion (negative)", () => {
    const result = deriveQqInputAntispam({
      ...ENABLED,
      events: [
        ev({ seq: 1, speakerId: "A", occurredAtSeconds: 10, parts: [face(), unsupported()] }),
      ],
    });
    expect(result.pureExpressionExcludedSeqs).toEqual([]);
  });

  test("other media prevents exclusion", () => {
    const result = deriveQqInputAntispam({
      ...ENABLED,
      events: [
        ev({ seq: 1, speakerId: "A", occurredAtSeconds: 10, parts: [face(), otherMedia()] }),
      ],
    });
    expect(result.pureExpressionExcludedSeqs).toEqual([]);
  });

  test("explicit direct event is never excluded even when it looks pure", () => {
    const result = deriveQqInputAntispam({
      ...ENABLED,
      events: [
        ev({
          seq: 1,
          speakerId: "A",
          occurredAtSeconds: 10,
          parts: [face()],
          explicitDirect: true,
        }),
      ],
    });
    expect(result.pureExpressionExcludedSeqs).toEqual([]);
  });
});

// ---- unmarked pure-image burst (§5.3) --------------------------------------------------

describe("unmarked pure-image burst grouping", () => {
  test("three carriers within 3 seconds form one hit group", () => {
    const events = [
      imageCarrier(1, "A", 100),
      imageCarrier(2, "A", 101),
      imageCarrier(3, "A", 103),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toHaveLength(1);
    const group = result.burstGroups[0];
    expect(group.speakerId).toBe("A");
    expect(group.carriers.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(group.carriers.map((c) => c.eventId)).toEqual(["e1", "e2", "e3"]);
    expect(group.carriers.flatMap((c) => c.imageMediaIds)).toEqual(["m1-0", "m2-0", "m3-0"]);
    expect(group.firstOccurredAtSeconds).toBe(100);
    expect(group.lastOccurredAtSeconds).toBe(103);
    expect(group.spanSeconds).toBe(3);
    expect(result.burstExcludedSeqs).toEqual([1, 2, 3]);
    expect(result.burstExcludedImages).toEqual([
      { seq: 1, eventId: "e1", mediaId: "m1-0" },
      { seq: 2, eventId: "e2", mediaId: "m2-0" },
      { seq: 3, eventId: "e3", mediaId: "m3-0" },
    ]);
  });

  test("exactly two carriers never hit (strictly above 2)", () => {
    const result = deriveQqInputAntispam({
      ...ENABLED,
      events: [imageCarrier(1, "A", 100), imageCarrier(2, "A", 101)],
    });
    expect(result.burstGroups).toEqual([]);
  });

  test("minimum 2 and maximum 20 carriers apply at their inclusive boundaries", () => {
    const minTwo = deriveQqInputAntispam({
      ...ENABLED,
      events: [imageCarrier(1, "A", 100), imageCarrier(2, "A", 101)],
      burstMinMessages: 2,
      burstWindowSeconds: 1,
    });
    expect(minTwo.burstExcludedSeqs).toEqual([1, 2]);
    expect(minTwo.burstGroups[0]?.spanSeconds).toBe(1);

    const minTwenty = deriveQqInputAntispam({
      ...ENABLED,
      events: Array.from({ length: 20 }, (_, index) => imageCarrier(index + 1, "A", 200 + index)),
      burstMinMessages: 20,
      burstWindowSeconds: 30,
    });
    expect(minTwenty.burstExcludedSeqs).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );

    const belowMaximum = deriveQqInputAntispam({
      ...ENABLED,
      events: Array.from({ length: 19 }, (_, index) => imageCarrier(index + 1, "A", 200 + index)),
      burstMinMessages: 20,
      burstWindowSeconds: 30,
    });
    expect(belowMaximum.burstGroups).toEqual([]);
  });

  test("one-second and thirty-second windows are inclusive and close beyond the bound", () => {
    const atOneSecond = deriveQqInputAntispam({
      ...ENABLED,
      events: [imageCarrier(1, "A", 100), imageCarrier(2, "A", 101)],
      burstMinMessages: 2,
      burstWindowSeconds: 1,
    });
    expect(atOneSecond.burstExcludedSeqs).toEqual([1, 2]);

    const beyondOneSecond = deriveQqInputAntispam({
      ...ENABLED,
      events: [imageCarrier(1, "A", 100), imageCarrier(2, "A", 102)],
      burstMinMessages: 2,
      burstWindowSeconds: 1,
    });
    expect(beyondOneSecond.burstGroups).toEqual([]);

    const atThirtySeconds = deriveQqInputAntispam({
      ...ENABLED,
      events: [imageCarrier(1, "A", 100), imageCarrier(2, "A", 115), imageCarrier(3, "A", 130)],
      burstMinMessages: 3,
      burstWindowSeconds: 30,
    });
    expect(atThirtySeconds.burstExcludedSeqs).toEqual([1, 2, 3]);

    const beyondThirtySeconds = deriveQqInputAntispam({
      ...ENABLED,
      events: [imageCarrier(1, "A", 100), imageCarrier(2, "A", 131)],
      burstMinMessages: 2,
      burstWindowSeconds: 30,
    });
    expect(beyondThirtySeconds.burstGroups).toEqual([]);
  });

  test("span strictly above 3 seconds never hits", () => {
    const result = deriveQqInputAntispam({
      ...ENABLED,
      events: [imageCarrier(1, "A", 100), imageCarrier(2, "A", 102), imageCarrier(3, "A", 104)],
    });
    expect(result.burstGroups).toEqual([]);
  });

  test("sliding chain rejected: adjacent gaps within 3s but fixed first-to-last above", () => {
    const result = deriveQqInputAntispam({
      ...ENABLED,
      events: [
        imageCarrier(1, "A", 100),
        imageCarrier(2, "A", 102),
        imageCarrier(3, "A", 104),
        imageCarrier(4, "A", 106),
      ],
    });
    expect(result.burstGroups).toEqual([]);
  });

  test("single message with three images is one carrier and never hits alone", () => {
    const result = deriveQqInputAntispam({
      ...ENABLED,
      events: [imageCarrier(1, "A", 100, 3)],
    });
    expect(result.burstGroups).toEqual([]);
  });

  test("other senders interleaving do not break the group", () => {
    const events = [
      imageCarrier(1, "A", 100),
      imageCarrier(2, "B", 100),
      imageCarrier(3, "A", 101),
      imageCarrier(4, "B", 101),
      imageCarrier(5, "A", 102),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toHaveLength(1);
    expect(result.burstGroups[0].speakerId).toBe("A");
    expect(result.burstGroups[0].carriers.map((c) => c.seq)).toEqual([1, 3, 5]);
    expect(result.burstExcludedSeqs).toEqual([1, 3, 5]);
  });

  test("first-anchor window: carrier beyond first+3s closes a hit prefix and opens a new window", () => {
    const events = [
      imageCarrier(1, "A", 100),
      imageCarrier(2, "A", 101),
      imageCarrier(3, "A", 102),
      imageCarrier(4, "A", 104),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toHaveLength(1);
    expect(result.burstGroups[0].carriers.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(result.burstGroups[0].firstOccurredAtSeconds).toBe(100);
    expect(result.burstGroups[0].lastOccurredAtSeconds).toBe(102);
    expect(result.burstExcludedSeqs).toEqual([1, 2, 3]);
  });

  test("first-anchor window prevents fake hit across an internal time gap", () => {
    const events = [
      imageCarrier(1, "A", 100),
      imageCarrier(2, "A", 110),
      imageCarrier(3, "A", 102),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toEqual([]);
  });

  test("own meaningful text ends the current group", () => {
    const events = [
      imageCarrier(1, "A", 100),
      ev({ seq: 2, speakerId: "A", occurredAtSeconds: 101, parts: [text("等等")] }),
      imageCarrier(3, "A", 102),
      imageCarrier(4, "A", 103),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toEqual([]);
  });

  test("own other media and unsupported content end the current group", () => {
    const withMedia = deriveQqInputAntispam({
      ...ENABLED,
      events: [
        imageCarrier(1, "A", 100),
        ev({ seq: 2, speakerId: "A", occurredAtSeconds: 101, parts: [otherMedia()] }),
        imageCarrier(3, "A", 102),
        imageCarrier(4, "A", 103),
      ],
    });
    expect(withMedia.burstGroups).toEqual([]);

    const withUnsupported = deriveQqInputAntispam({
      ...ENABLED,
      events: [
        imageCarrier(1, "A", 100),
        ev({ seq: 2, speakerId: "A", occurredAtSeconds: 101, parts: [unsupported()] }),
        imageCarrier(3, "A", 102),
        imageCarrier(4, "A", 103),
      ],
    });
    expect(withUnsupported.burstGroups).toEqual([]);
  });

  test("own marked expression ends the current group", () => {
    const events = [
      imageCarrier(1, "A", 100),
      ev({ seq: 2, speakerId: "A", occurredAtSeconds: 101, parts: [img("mf", true)] }),
      imageCarrier(3, "A", 102),
      imageCarrier(4, "A", 103),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toEqual([]);
    expect(result.pureExpressionExcludedSeqs).toEqual([2]);
  });

  test("explicit direct event never joins and ends the current group", () => {
    const events = [
      imageCarrier(1, "A", 100),
      ev({
        seq: 2,
        speakerId: "A",
        occurredAtSeconds: 101,
        parts: [img("md")],
        explicitDirect: true,
      }),
      imageCarrier(3, "A", 102),
      imageCarrier(4, "A", 103),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toEqual([]);
  });

  test("mixed marked and unmarked images is not a pure burst carrier", () => {
    const events = [
      imageCarrier(1, "A", 100),
      ev({ seq: 2, speakerId: "A", occurredAtSeconds: 101, parts: [img("mm", true), img("mu")] }),
      imageCarrier(3, "A", 102),
      imageCarrier(4, "A", 103),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toEqual([]);
  });

  test("unknown-category unmarked images are valid burst carriers (platform flag false)", () => {
    const events = [
      imageCarrier(1, "A", 100),
      imageCarrier(2, "A", 101),
      imageCarrier(3, "A", 102),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toHaveLength(1);
  });
});

// ---- switch and source boundaries -----------------------------------------------------

describe("module switch and source boundaries", () => {
  test("disabled module outputs no exclusions and no groups", () => {
    const events = [
      ev({ seq: 1, speakerId: "A", occurredAtSeconds: 10, parts: [face()] }),
      imageCarrier(2, "A", 11),
      imageCarrier(3, "A", 12),
      imageCarrier(4, "A", 13),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, enabled: false, events });
    expect(result.pureExpressionExcludedSeqs).toEqual([]);
    expect(result.burstGroups).toEqual([]);
    expect(result.burstExcludedImages).toEqual([]);
    expect(result.burstExcludedSeqs).toEqual([]);
  });

  test("own source-unavailable event breaks the group and never participates", () => {
    // Without the boundary A would hold carriers 1,3,4 within 3s; the boundary splits it.
    const events = [
      imageCarrier(1, "A", 100),
      ev({
        seq: 2,
        speakerId: "A",
        occurredAtSeconds: 101,
        parts: [img("m-expired")],
        sourceAvailable: false,
      }),
      imageCarrier(3, "A", 102),
      imageCarrier(4, "A", 103),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toEqual([]);
    expect(result.burstExcludedSeqs).toEqual([]);
    expect(result.burstExcludedImages).toEqual([]);
  });

  test("another sender's expired event does not break a healthy group", () => {
    const events = [
      imageCarrier(1, "A", 100),
      ev({
        seq: 2,
        speakerId: "B",
        occurredAtSeconds: 101,
        parts: [img("m-expired")],
        sourceAvailable: false,
      }),
      imageCarrier(3, "A", 101),
      imageCarrier(4, "A", 102),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toHaveLength(1);
    expect(result.burstGroups[0].carriers.map((c) => c.seq)).toEqual([1, 3, 4]);
  });

  test("group resumes after the boundary; pre-boundary carriers fall back to existing behavior", () => {
    const events = [
      imageCarrier(1, "A", 100),
      imageCarrier(2, "A", 101),
      ev({
        seq: 3,
        speakerId: "A",
        occurredAtSeconds: 102,
        parts: [img("mx")],
        sourceAvailable: false,
      }),
      imageCarrier(4, "A", 103),
      imageCarrier(5, "A", 104),
      imageCarrier(6, "A", 105),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toHaveLength(1);
    expect(result.burstGroups[0].carriers.map((c) => c.seq)).toEqual([4, 5, 6]);
  });
});

// ---- input contract --------------------------------------------------------------------

describe("input contract and immutability", () => {
  test("late timestamp: carrier before the current first anchor closes the group and never emits", () => {
    const events = [
      imageCarrier(1, "A", 110),
      imageCarrier(2, "A", 120),
      imageCarrier(3, "A", 100),
    ];
    const result = deriveQqInputAntispam({ ...ENABLED, events });
    expect(result.burstGroups).toEqual([]);
  });

  test("derivation does not mutate input events", () => {
    const events = [
      ev({ seq: 1, speakerId: "A", occurredAtSeconds: 100, parts: [face()] }),
      imageCarrier(2, "A", 101),
      imageCarrier(3, "A", 102),
      imageCarrier(4, "A", 103),
    ];
    const before = JSON.stringify(events);
    deriveQqInputAntispam({ ...ENABLED, events: Object.freeze(events.slice()) });
    expect(JSON.stringify(events)).toBe(before);
  });

  test("group output carries only source identity fields, no vision/title payloads", () => {
    const result = deriveQqInputAntispam({
      ...ENABLED,
      events: [imageCarrier(1, "A", 100), imageCarrier(2, "A", 101), imageCarrier(3, "A", 102)],
    });
    expect(Object.keys(result.burstGroups[0]).sort()).toEqual([
      "carriers",
      "firstOccurredAtSeconds",
      "lastOccurredAtSeconds",
      "spanSeconds",
      "speakerId",
    ]);
    expect(Object.keys(result.burstGroups[0].carriers[0]).sort()).toEqual([
      "eventId",
      "imageMediaIds",
      "seq",
    ]);
  });
});
