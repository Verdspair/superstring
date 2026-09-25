// P2e: the intake that turns a wire message into durable rows (ADR0018).
//
// Two things are easy to get wrong here and both are silent: de-duplicating a
// re-delivery by rewriting the identity row, and treating a media-only message as if
// it had text. The first corrupts provenance; the second would make a group's memory
// claim to know about an image nobody could read.

import { describe, expect, it } from "bun:test";
import { recordObservation, sweepObservations } from "../../src/server/db/qq-observation-intake";
import {
  observationText,
  pendingObservationCount,
} from "../../src/server/db/qq-observation-repository";
import { createSession, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import type { QqMemoryScope } from "../../src/server/services/qq-binding-contract";
import { enqueueQqMemory } from "../../src/server/services/qq-memory-enqueue";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";
const NOW_MS = Date.parse("2026-09-22T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

const GROUP_A: QqMemoryScope & { kind: "qq" } = {
  kind: "qq",
  accountId: "10001",
  conversationKind: "group",
  peerId: "20001",
  agentId: AGENT_ID,
} as QqMemoryScope & { kind: "qq" };

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const sessionId = createSession(business.orm, "会话", { modelName: MODEL }).id;
  return { business, orm: business.orm, sessionId };
}
/** A normalised observation as the protocol layer would hand it over. */
function observation(patch: Partial<QqObservation> = {}): QqObservation {
  return {
    accountId: "10001",
    conversation: { kind: "group", peerId: "20001", key: '["qq","10001","group","20001"]' },
    eventKey: "evt_1",
    messageId: "-7",
    occurredAtSeconds: NOW_SECONDS,
    subType: "normal",
    speaker: { kind: "member", id: "30001", displayName: "群友" },
    segments: [{ kind: "text", text: "群友说喜欢猫" }],
    text: "群友说喜欢猫",
    mentionsSelf: false,
    ...patch,
  };
}

describe("recording an observation", () => {
  it("writes the identity and the body, and offers the body for consolidation", () => {
    const h = setup();
    try {
      const result = recordObservation(h.orm, observation(), AGENT_ID);
      expect(result).toEqual({ eventKey: "evt_1", recorded: true, hasText: true });
      const event = h.orm.select().from(schema.qqEvents).get();
      expect(event?.eventKey).toBe("evt_1");
      expect(event?.agentId).toBe(AGENT_ID);
      expect(event?.speakerKind).toBe("member");
      expect(event?.speakerId).toBe("30001");
      expect(observationText(h.orm, ["evt_1"], nowIso()).get("evt_1")).toBe("群友说喜欢猫");
      expect(pendingObservationCount(h.orm, GROUP_A, nowIso())).toBe(1);
    } finally {
      h.business.close();
    }
  });

  it("records a media-only message as identity without inventing text", () => {
    const h = setup();
    try {
      const result = recordObservation(
        h.orm,
        observation({
          eventKey: "evt_image",
          segments: [{ kind: "image", url: "https://example.invalid/a.png" }],
          text: "",
        }),
        AGENT_ID,
      );
      expect(result).toEqual({ eventKey: "evt_image", recorded: true, hasText: false });
      // The identity exists (so a re-delivery de-duplicates and media can attach later),
      // but there is no body and therefore no consolidation candidate.
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
      expect(h.orm.select().from(schema.qqObservationText).all()).toEqual([]);
      expect(h.orm.select().from(schema.qqMediaNotes).all()).toMatchObject([
        {
          eventKey: "evt_image",
          segmentIndex: 0,
          sourceRef: "https://example.invalid/a.png",
          note: null,
        },
      ]);
      expect(pendingObservationCount(h.orm, GROUP_A, nowIso())).toBe(0);
      expect(
        enqueueQqMemory(h.orm, { scope: GROUP_A, requestKey: "req_media", limit: 10 }),
      ).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("keeps media positions stable across text and multiple references", () => {
    const h = setup();
    try {
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_multi",
          segments: [
            { kind: "text", text: "看图" },
            { kind: "image", file: "a.jpg" },
            { kind: "face", id: "12" },
            { kind: "record", file: "b.amr" },
          ],
          text: "看图",
        }),
        AGENT_ID,
      );
      expect(
        h.orm
          .select()
          .from(schema.qqMediaNotes)
          .all()
          .map((row) => [row.segmentIndex, row.segmentKind, row.sourceRef]),
      ).toEqual([
        [1, "image", "a.jpg"],
        [3, "record", "b.amr"],
      ]);
      expect(h.orm.select().from(schema.qqObservationText).get()?.body).toBe("看图");
    } finally {
      h.business.close();
    }
  });

  it("treats a whitespace-only message as textless rather than storing a blank body", () => {
    const h = setup();
    try {
      const result = recordObservation(
        h.orm,
        observation({ eventKey: "evt_blank", text: "   \n  " }),
        AGENT_ID,
      );
      expect(result.hasText).toBe(false);
      expect(h.orm.select().from(schema.qqObservationText).all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("de-duplicates a re-delivery without rewriting the identity", () => {
    const h = setup();
    try {
      recordObservation(h.orm, observation(), AGENT_ID);
      const before = h.orm.select().from(schema.qqEvents).get();
      // The same message arrives again, with a later local recording time.
      const again = recordObservation(h.orm, observation(), AGENT_ID);
      expect(again.recorded).toBe(false);
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
      expect(h.orm.select().from(schema.qqEvents).get()).toEqual(before);
      expect(h.orm.select().from(schema.qqObservationText).all()).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });

  it("refuses a delivery that reuses an event key for a different message", () => {
    const h = setup();
    try {
      recordObservation(h.orm, observation(), AGENT_ID);
      // Same key, different content/speaker: this must never be merged.
      expect(() => recordObservation(h.orm, observation({ messageId: "-9" }), AGENT_ID)).toThrow();
      expect(() =>
        recordObservation(
          h.orm,
          observation({ speaker: { kind: "member", id: "30002", displayName: null } }),
          AGENT_ID,
        ),
      ).toThrow();
      expect(() =>
        recordObservation(
          h.orm,
          observation({
            conversation: { kind: "group", peerId: "20002", key: '["qq","10001","group","20002"]' },
          }),
          AGENT_ID,
        ),
      ).toThrow();
      // Nothing was overwritten.
      const event = h.orm.select().from(schema.qqEvents).get();
      expect(event?.messageId).toBe("-7");
      expect(event?.peerId).toBe("20001");
      expect(event?.speakerId).toBe("30001");
    } finally {
      h.business.close();
    }
  });

  it("records an anonymous or system speaker without a member id, and refuses a member without one", () => {
    const h = setup();
    try {
      expect(() =>
        recordObservation(
          h.orm,
          observation({
            eventKey: "evt_bad",
            speaker: { kind: "member", id: null, displayName: null },
          }),
          AGENT_ID,
        ),
      ).toThrow();
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_anon",
          speaker: { kind: "anonymous", id: null, displayName: "路人" },
        }),
        AGENT_ID,
      );
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_sys",
          speaker: { kind: "system", id: null, displayName: null },
        }),
        AGENT_ID,
      );
      const rows = h.orm.select().from(schema.qqEvents).all();
      expect(rows.map((row) => [row.speakerKind, row.speakerId])).toEqual([
        ["anonymous", null],
        ["system", null],
      ]);
      // Both still carry text, so both are readable observations.
      expect(pendingObservationCount(h.orm, GROUP_A, nowIso())).toBe(2);
    } finally {
      h.business.close();
    }
  });

  it("keeps the same message in two groups as two identities", () => {
    const h = setup();
    try {
      recordObservation(h.orm, observation(), AGENT_ID);
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_other_group",
          conversation: { kind: "group", peerId: "20002", key: '["qq","10001","group","20002"]' },
        }),
        AGENT_ID,
      );
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(2);
      // Each group's memory sees only its own observation.
      const groupB = { ...GROUP_A, peerId: "20002" } as typeof GROUP_A;
      expect(pendingObservationCount(h.orm, GROUP_A, nowIso())).toBe(1);
      expect(pendingObservationCount(h.orm, groupB, nowIso())).toBe(1);
    } finally {
      h.business.close();
    }
  });
});

describe("retention sweep through the intake", () => {
  it("removes only expired bodies and leaves identities and memories usable", () => {
    const h = setup();
    try {
      recordObservation(
        h.orm,
        observation({ eventKey: "evt_old", occurredAtSeconds: NOW_SECONDS - 15 * 24 * 3600 }),
        AGENT_ID,
      );
      recordObservation(h.orm, observation({ eventKey: "evt_new" }), AGENT_ID);
      expect(sweepObservations(h.orm, nowIso())).toBe(1);
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(2);
      expect(
        h.orm
          .select()
          .from(schema.qqObservationText)
          .all()
          .map((row) => row.eventKey),
      ).toEqual(["evt_new"]);
      // Only the readable one is offered.
      expect(pendingObservationCount(h.orm, GROUP_A, nowIso())).toBe(1);
    } finally {
      h.business.close();
    }
  });

  it("is a no-op when nothing has expired", () => {
    const h = setup();
    try {
      recordObservation(h.orm, observation(), AGENT_ID);
      expect(sweepObservations(h.orm, nowIso())).toBe(0);
      expect(h.orm.select().from(schema.qqObservationText).all()).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });
});
