import { describe, expect, it } from "vitest";
import type { ConversationEventView } from "../../src/shared/contracts/conversation";
import { timelineKey } from "../../src/web/features/conversations/use-timeline-scroll";
import { timelineRows } from "../../src/web/screens/conversations/timeline-projection";

function makeInbound(
  seq: number,
  occurredAt: string,
  id = `inbound-${seq}`,
  text = `inbound message ${seq}`,
): ConversationEventView {
  const source = { kind: "qq_event", id, revision: "1" };
  return {
    conversationId: "conv-order-test",
    seq,
    eventKey: `onebot:${id}`,
    kind: "inbound",
    source,
    sources: [source],
    occurredAt,
    recordedAt: occurredAt,
    participant: { id: "user-1", label: "User 1", role: "user" },
    addressing: { reasons: ["private"], mentionIds: [] },
    runId: null,
    outputId: null,
    text,
    contentState: "active",
    media: [],
    deliveryStatus: null,
    messageStatus: null,
    wake: null,
  };
}

function makeOrphanMediaRevision(
  seq: number,
  occurredAt: string,
  noteId = `note-${seq}`,
  parentId = `unloaded-parent-${seq}`,
  revisionNo = "1",
  options: {
    contentState?: "active" | "unavailable";
    availability?: "available" | "expired" | "unavailable";
    description?: string | null;
  } = {},
): ConversationEventView {
  const mediaRef = { kind: "qq_media", id: noteId, revision: revisionNo };
  const parentRef = { kind: "qq_event", id: parentId, revision: "1" };
  const resolvedDescription =
    options.description === undefined ? `description for ${noteId}` : options.description;

  return {
    conversationId: "conv-order-test",
    seq,
    eventKey: `media:${noteId}:${revisionNo}`,
    kind: "media_revision",
    source: mediaRef,
    sources: [parentRef, mediaRef],
    occurredAt,
    recordedAt: occurredAt,
    participant: { id: "user-1", label: "User 1", role: "user" },
    addressing: { reasons: [], mentionIds: [] },
    runId: null,
    outputId: null,
    text: null,
    contentState: options.contentState ?? "active",
    media: [
      {
        id: noteId,
        kind: "image",
        description: resolvedDescription,
        availability: options.availability ?? "available",
      },
    ],
    deliveryStatus: null,
    messageStatus: null,
    wake: null,
  };
}

describe("onebot media revision display ordering and timeline contracts", () => {
  it("places older orphan media revision with late seq before fresh human message while preserving core order", () => {
    // Inbound 1 at 10:00 (seq 10)
    const core1 = makeInbound(10, "2026-10-16T10:00:00.000Z", "inbound-10", "earlier chat");
    // Fresh human message at 17:28 (seq 20)
    const core2 = makeInbound(20, "2026-10-16T17:28:00.000Z", "inbound-20", "fresh human message");
    // Media revision appended later with seq 50, but occurred in the morning at 03:40
    const orphan = makeOrphanMediaRevision(
      50,
      "2026-10-16T03:40:00.000Z",
      "note-morning",
      "cut-parent-seq-5",
    );

    const rows = timelineRows([core1, core2, orphan]);

    expect(rows).toHaveLength(3);
    // Chronologically, morning orphan (03:40) must appear before fresh human message (17:28)
    // while core inbounds retain their canonical relative sequence (10 before 20).
    expect(rows.map((r) => r.seq)).toEqual([50, 10, 20]);
    expect(rows[0].kind).toBe("media_revision");
    expect(rows[1].text).toBe("earlier chat");
    expect(rows[2].text).toBe("fresh human message");
  });

  it("preserves core causal sequence even when core timestamps are inverted/nonmonotonic", () => {
    // Core step 1 has seq 10 with later timestamp 17:30
    const coreStep1 = makeInbound(10, "2026-10-16T17:30:00.000Z", "inbound-10", "core step 1");
    // Core step 2 has seq 20 with earlier timestamp 17:28 (e.g. clock drift / causal lifecycle)
    const coreStep2 = makeInbound(20, "2026-10-16T17:28:00.000Z", "inbound-20", "core step 2");
    // Morning orphan media revision at 03:40 with late seq 50
    const orphan = makeOrphanMediaRevision(
      50,
      "2026-10-16T03:40:00.000Z",
      "note-morning-inverted",
      "cut-parent-inv",
    );

    const rows = timelineRows([coreStep1, coreStep2, orphan]);

    expect(rows).toHaveLength(3);
    // Orphan (03:40, seq 50) sorts before afternoon core events.
    // Core events MUST preserve their canonical seq relative order (seq 10 strictly before seq 20)
    // despite seq 10 having a later timestamp (17:30) than seq 20 (17:28).
    expect(rows.map((r) => r.seq)).toEqual([50, 10, 20]);
    expect(rows[1].text).toBe("core step 1");
    expect(rows[2].text).toBe("core step 2");
  });

  it("deduplicates multiple orphan media revisions to latest version and preserves expired availability", () => {
    const rev1 = makeOrphanMediaRevision(
      30,
      "2026-10-16T03:40:00.000Z",
      "shared-note-dedup",
      "parent-x",
      "1",
      { description: "v1 early note" },
    );
    const rev2 = makeOrphanMediaRevision(
      35,
      "2026-10-16T03:45:00.000Z",
      "shared-note-dedup",
      "parent-x",
      "2",
      { contentState: "unavailable", availability: "expired", description: null },
    );
    const core = makeInbound(40, "2026-10-16T12:00:00.000Z", "inbound-40", "noon message");

    const rows = timelineRows([rev1, rev2, core]);

    expect(rows).toHaveLength(2);
    // Deduplicated to latest revision (seq 35, revision 2)
    const orphanRow = rows.find((r) => r.kind === "media_revision");
    expect(orphanRow).toBeDefined();
    expect(orphanRow?.seq).toBe(35);
    expect(orphanRow?.contentState).toBe("unavailable");
    expect(orphanRow?.media[0]?.availability).toBe("expired");
    expect(orphanRow?.media[0]?.description).toBeNull();
    // Older orphan (03:45) sits before noon message (12:00)
    expect(rows.map((r) => r.seq)).toEqual([35, 40]);
  });

  it("merges media revision into loaded parent inbound without emitting standalone orphan card", () => {
    const parentInbound = makeInbound(
      15,
      "2026-10-16T08:00:00.000Z",
      "parent-loaded",
      "original input with photo",
    );
    const attachedRevision = makeOrphanMediaRevision(
      60,
      "2026-10-16T08:30:00.000Z",
      "note-attached",
      "parent-loaded",
      "1",
      { description: "detailed image description" },
    );
    const laterCore = makeInbound(
      70,
      "2026-10-16T14:00:00.000Z",
      "inbound-70",
      "afternoon message",
    );

    const rows = timelineRows([parentInbound, attachedRevision, laterCore]);

    // Media revision must be merged into parent inbound (seq 15); exactly 2 rows
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.seq)).toEqual([15, 70]);
    expect(rows[0].kind).toBe("inbound");
    expect(rows[0].media).toHaveLength(1);
    expect(rows[0].media[0].id).toBe("note-attached");
    expect(rows[0].media[0].description).toBe("detailed image description");
  });

  it("stably breaks ties on canonical seq when events share identical occurredAt timestamps", () => {
    const sharedTime = "2026-10-16T12:00:00.000Z";
    const core1 = makeInbound(10, sharedTime, "inbound-same-1", "same time 1");
    const orphan = makeOrphanMediaRevision(15, sharedTime, "note-same", "unloaded-same");
    const core2 = makeInbound(20, sharedTime, "inbound-same-2", "same time 2");

    const rows = timelineRows([core1, orphan, core2]);

    expect(rows).toHaveLength(3);
    // When occurredAt matches, order must fall back deterministically to seq
    expect(rows.map((r) => r.seq)).toEqual([10, 15, 20]);
  });

  it("preserves original input immutability, canonical seq numbers, and timelineKey identity", () => {
    const inbound = makeInbound(10, "2026-10-16T09:00:00.000Z", "immut-inbound");
    const orphan = makeOrphanMediaRevision(25, "2026-10-16T08:00:00.000Z", "immut-orphan");
    const activityRow: ConversationEventView & { activityId?: string } = {
      ...makeInbound(30, "2026-10-16T10:00:00.000Z", "activity-inbound"),
      activityId: "activity-chain-1",
    };

    const inputSnapshot = JSON.stringify([inbound, orphan, activityRow]);
    const rows = timelineRows([inbound, orphan, activityRow]);

    // Input objects must not be mutated
    expect(JSON.stringify([inbound, orphan, activityRow])).toBe(inputSnapshot);

    // Timeline keys and seq numbers remain canonical
    expect(rows.map((r) => r.seq)).toEqual([25, 10, 30]);
    const orphanOut = rows.find((r) => r.seq === 25)!;
    const inboundOut = rows.find((r) => r.seq === 10)!;
    const activityOut = rows.find((r) => r.seq === 30)!;

    expect(timelineKey(orphanOut)).toBe("source:qq_media:immut-orphan");
    expect(timelineKey(inboundOut)).toBe("source:qq_event:immut-inbound");
    expect(timelineKey(activityOut)).toBe("activity:activity-chain-1");
  });
});
