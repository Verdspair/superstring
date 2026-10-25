import { describe, expect, it } from "bun:test";
import { createNapCatEventStream } from "../../src/server/napcat/event-stream";
import {
  type OneBotProtocolEvent,
  OneBotProtocolEventSchema,
} from "../../src/shared/contracts/onebot-events";
import {
  QqManagedEventsInvalidationSchema,
  QqManagedEventsPageSchema,
  QqManagedProtocolEventSchema,
} from "../../src/shared/contracts/qq-managed-events";

const generationA = "00000000-0000-4000-8000-000000000001";
const generationB = "00000000-0000-4000-8000-000000000002";
type MessageProtocolEvent = Extract<OneBotProtocolEvent, { kind: "message" }> & {
  event_key: string;
};
const baseEvent = (patch: Partial<MessageProtocolEvent> = {}): MessageProtocolEvent => ({
  kind: "message",
  account_id: "10001",
  occurred_at_seconds: 1_790_000_000,
  observed_at: "2026-10-25T03:00:00.000Z",
  event_key: `["qq","10001","group","30003","-12"]`,
  message_id: "-12",
  message_type: "group",
  sub_type: "normal",
  peer_id: "30003",
  sender_id: "20002",
  segments: {
    text: 1,
    mention: 0,
    reply: 0,
    face: 0,
    image: 0,
    record: 0,
    video: 0,
    file: 0,
    unsupported: 0,
  },
  ...patch,
});

describe("NapCat bounded diagnostic event stream", () => {
  it("accepts only strict allowlisted DTOs and excludes raw bodies and credentials", () => {
    const event = baseEvent();
    const { event_key: _privateKey, ...publicEvent } = event;
    expect(QqManagedProtocolEventSchema.parse(publicEvent)).toEqual(publicEvent);
    expect(OneBotProtocolEventSchema.parse(event)).toEqual(event);
    expect(() =>
      QqManagedProtocolEventSchema.parse({
        ...event,
        message: [{ type: "text", data: { text: "secret" } }],
      }),
    ).toThrow();
    expect(() =>
      QqManagedProtocolEventSchema.parse({ ...event, access_token: "secret" }),
    ).toThrow();
    expect(() =>
      QqManagedEventsInvalidationSchema.parse({
        generation: generationA,
        latest_sequence: 1,
        event,
      }),
    ).toThrow();
  });

  it("keeps fixed notice/request/meta projections under the same strict event union", () => {
    const stream = createNapCatEventStream({
      createGeneration: () => generationA,
      now: () => 1_790_000_000_000,
    });
    const notice: OneBotProtocolEvent = {
      kind: "notice",
      account_id: "10001",
      occurred_at_seconds: 1_790_000_000,
      observed_at: "2026-10-25T03:00:00.000Z",
      notice_type: "group_ban",
      sub_type: "ban",
      user_id: "20002",
      group_id: "30003",
      operator_id: "10001",
      target_id: "20002",
      message_id: null,
    };
    const request: OneBotProtocolEvent = {
      kind: "request",
      account_id: "10001",
      occurred_at_seconds: 1_790_000_001,
      observed_at: "2026-10-25T03:00:01.000Z",
      request_type: "friend",
      sub_type: null,
      user_id: "20002",
      group_id: null,
    };
    const meta: OneBotProtocolEvent = {
      kind: "meta_event",
      account_id: "10001",
      occurred_at_seconds: 1_790_000_002,
      observed_at: "2026-10-25T03:00:02.000Z",
      meta_event_type: "heartbeat",
      sub_type: null,
      heartbeat: { good: true, online: true, interval_ms: 5000 },
    };
    expect(stream.record(notice)).toBe(1);
    expect(stream.record(request)).toBe(2);
    expect(stream.record(meta)).toBe(3);
    const page = stream.snapshot({ limit: 3 });
    expect(page.status).toBe("ok");
    if (page.status !== "ok") throw new Error("Expected event page");
    expect(page.events.map((entry) => entry.event.kind)).toEqual([
      "meta_event",
      "request",
      "notice",
    ]);
  });

  it("bounds count, bytes and per-entry size, returns newest first, and marks eviction", () => {
    const stream = createNapCatEventStream({
      now: () => 1_790_000_000_000,
      createGeneration: () => generationA,
      maxEntries: 2,
      maxBytes: 65536,
      maxEntryBytes: 512,
      ttlMs: 900_000,
    });
    expect(stream.record(baseEvent({ message_id: "1" }))).toBe(1);
    expect(stream.record(baseEvent({ message_id: "2" }))).toBe(2);
    expect(stream.record(baseEvent({ message_id: "3" }))).toBe(3);
    const page = stream.snapshot({ limit: 50 });
    expect(page).toMatchObject({
      status: "ok",
      generation: generationA,
      latest_sequence: 3,
      truncated: true,
    });
    if (page.status !== "ok") throw new Error("Expected an event page");
    expect(page.events.map((entry) => entry.sequence)).toEqual([3, 2]);
    expect(stream.bytes).toBeLessThanOrEqual(65536);
    expect(stream.record(baseEvent({ sub_type: "x".repeat(513) }))).toBeNull();
  });

  it("filters and pages by generation-scoped cursor, rejecting stale cursors after clear", () => {
    let generation = generationA;
    const stream = createNapCatEventStream({
      now: () => 1_790_000_000_000,
      createGeneration: () => generation,
    });
    stream.record(baseEvent({ message_id: "1" }));
    stream.record({
      kind: "notice",
      account_id: "10001",
      occurred_at_seconds: 1_790_000_000,
      observed_at: "2026-10-25T03:00:00.000Z",
      notice_type: "group_increase",
      sub_type: "approve",
      user_id: "20002",
      group_id: "30003",
      operator_id: null,
      target_id: null,
      message_id: null,
    });
    const first = stream.snapshot({ kind: "notice", limit: 1 });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("Expected an event page");
    expect(first.events).toHaveLength(1);
    const cursor = first.next_cursor;
    expect(cursor).toBeNull();
    const oldCursor = JSON.stringify({ generation: generationA, sequence: 2 });
    generation = generationB;
    stream.clear();
    expect(stream.snapshot({ cursor: oldCursor }).status).toBe("reset_required");
    expect(stream.snapshot({}).generation).toBe(generationB);
  });

  it("expires entries lazily without a timer and notifies subscribers with invalidation metadata only", () => {
    let now = 1_790_000_000_000;
    const stream = createNapCatEventStream({
      now: () => now,
      createGeneration: () => generationA,
      ttlMs: 1000,
    });
    const notices: unknown[] = [];
    const unsubscribe = stream.subscribe((notice) => notices.push(notice));
    stream.record(baseEvent());
    expect(notices).toEqual([{ generation: generationA, latest_sequence: 1, revision: 1 }]);
    expect(QqManagedEventsInvalidationSchema.safeParse(notices[0]).success).toBe(true);
    expect(JSON.stringify(notices)).not.toContain("message_id");
    expect(JSON.stringify(notices)).not.toContain("secret");
    now += 1001;
    const expired = stream.snapshot({});
    expect(expired.status).toBe("ok");
    if (expired.status !== "ok") throw new Error("Expected event page");
    expect(expired.events).toEqual([]);
    unsubscribe();
    stream.record(baseEvent({ message_id: "2" }));
    expect(notices).toHaveLength(2);
  });

  it("links one immutable original source reference, invalidates the read, and exposes only a live callback preview", () => {
    const stream = createNapCatEventStream({
      createGeneration: () => generationA,
      now: () => 1_790_000_000_000,
    });
    const event = baseEvent();
    stream.record(event);
    const ref = {
      event_key: event.event_key,
      scope: {
        conversationId: "00000000-0000-4000-8000-000000000099",
        accountId: "10001",
        conversationKind: "group" as const,
        peerId: "30003",
        agentId: "00000000-0000-4000-8000-000000000002",
        bindingId: "00000000-0000-4000-8000-000000000003",
        bindingEpoch: 1,
        authorityRevision: 1,
      },
      source: {
        kind: "qq_observation" as const,
        id: event.event_key,
        revision: "body-hash",
        expiresAt: "2026-10-25T04:00:00.000Z",
      },
    };
    const notices: unknown[] = [];
    const unsubscribe = stream.subscribe((notice) => notices.push(notice));
    expect(stream.linkMessageSource(event.event_key, ref)).toBe(true);
    expect(stream.linkMessageSource(event.event_key, ref)).toBe(true);
    expect(notices).toEqual([{ generation: generationA, latest_sequence: 1, revision: 2 }]);
    const page = stream.snapshot({}, (source) => {
      expect(source).toEqual(ref);
      return "body preview";
    });
    expect(QqManagedEventsPageSchema.safeParse(page).success).toBe(true);
    expect(page.status).toBe("ok");
    if (page.status !== "ok") throw new Error("Expected event page");
    expect(page.events[0]).toMatchObject({
      conversation_binding: "bound",
      message_preview: "body preview",
      preview_state: "available",
    });
    expect(JSON.stringify(page)).not.toContain("event_key");
    expect(JSON.stringify(page)).not.toContain("bindingEpoch");
    expect(stream.bytes).toBeLessThanOrEqual(65_536);
    expect(stream.snapshot({}, () => "new source body")).toMatchObject({
      events: [{ message_preview: "new source body" }],
    });
    expect(
      stream.linkMessageSource(event.event_key, {
        ...ref,
        source: { ...ref.source, revision: "other" },
      }),
    ).toBe(false);
    expect(
      stream.linkMessageSource(event.event_key, {
        ...ref,
        source: { ...ref.source, id: "x".repeat(2_000) },
      }),
    ).toBe(false);
    unsubscribe();
  });

  it("counts source metadata in the 1536-byte entry cap and recomputes index after byte eviction", () => {
    const stream = createNapCatEventStream({
      createGeneration: () => generationA,
      now: () => 1_790_000_000_000,
      maxEntries: 3,
      maxBytes: 1_500,
      maxEntryBytes: 512,
    });
    const first = baseEvent({ event_key: "first", message_id: "1" });
    const second = baseEvent({ event_key: "second", message_id: "2" });
    const third = baseEvent({ event_key: "third", message_id: "3" });
    expect(stream.record(first)).toBe(1);
    expect(stream.record(second)).toBe(2);
    expect(stream.record(third)).toBe(3);
    const reference = (event: MessageProtocolEvent) => ({
      event_key: event.event_key,
      scope: {
        conversationId: "00000000-0000-4000-8000-000000000099",
        accountId: "10001",
        conversationKind: "group" as const,
        peerId: "30003",
        agentId: "00000000-0000-4000-8000-000000000002",
        bindingId: "00000000-0000-4000-8000-000000000003",
        bindingEpoch: 1,
        authorityRevision: 1,
      },
      source: {
        kind: "qq_observation" as const,
        id: event.event_key,
        revision: "hash",
        expiresAt: "2026-10-25T04:00:00.000Z",
      },
    });
    expect(stream.linkMessageSource(third.event_key, reference(third))).toBe(true);
    const page = stream.snapshot({ limit: 3 });
    expect(page.status).toBe("ok");
    if (page.status !== "ok") throw new Error("Expected event page");
    expect(page.events.map((row) => row.sequence)).toEqual([3, 2]);
    expect(page.events[0]?.conversation_binding).toBe("bound");
    expect(stream.bytes).toBeLessThanOrEqual(1_500);
  });

  it("clears on generation reset and never restores events", () => {
    let nextGeneration = generationA;
    const stream = createNapCatEventStream({
      createGeneration: () => nextGeneration,
      now: () => 1_790_000_000_000,
    });
    stream.record(baseEvent());
    nextGeneration = generationB;
    stream.clear();
    expect(stream.snapshot({})).toMatchObject({
      status: "ok",
      generation: generationB,
      latest_sequence: 0,
      events: [],
      truncated: false,
    });
  });
});
