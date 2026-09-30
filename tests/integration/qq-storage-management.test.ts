// QQ 存储管理面（ADR0018 §11.1）：设置、元数据列表与按类别/选中行的清理。
//
// 这个面只报它真正持有的数据，删除只发生在"已到期且未被保全"的行上。用例的重点是三条
// 不变量：列表永不带正文/来源引用，预览零写，执行只清选中范围内的到期行——identity
// （qq_events）、方案/绑定、素材与活记录在每种路径下都必须原样存在。

import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import {
  createQqStickerCollection,
  importQqSticker,
} from "../../src/server/db/qq-sticker-repository";
import { DEFAULT_USER_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  QqStorageCleanupSelectionResponseSchema,
  QqStorageItemsResponseSchema,
  QqStorageSettingsResponseSchema,
} from "../../src/shared/contracts/qq-storage";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT = "00000000-0000-0000-0000-000000000001";
const PAST = "2020-01-01T00:00:00.000000Z";
const FUTURE = "2030-01-01T00:00:00.000000Z";
const UNICODE_PEER = "群组-😀";

const SEND_PLAIN = "33333333-3333-4333-8333-333333333333";
const SEND_UNKNOWN = "44444444-4444-4444-8444-444444444444";
const SEND_INFLIGHT = "55555555-5555-4555-8555-555555555555";
const SEND_LIVE = "66666666-6666-4666-8666-666666666666";
const SPEECH_LIVE = "11111111-1111-4111-8111-111111111111";
const SPEECH_EXPIRED = "22222222-2222-4222-8222-222222222222";
const MEDIA_LIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_EXPIRED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STICKER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function fixture() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const orm = business.orm;

  const insertEvent = (
    key: string,
    input: {
      peerId?: string;
      kind?: "group" | "private";
      occurredAtSeconds?: number;
    } = {},
  ) => {
    orm
      .insert(schema.qqEvents)
      .values({
        eventKey: key,
        accountId: "10001",
        conversationKind: input.kind ?? "group",
        peerId: input.peerId ?? "30003",
        agentId: AGENT,
        messageId: key,
        occurredAtSeconds: input.occurredAtSeconds ?? 1_700_000_000,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: nowIso(),
      })
      .run();
  };
  const insertObservation = (
    key: string,
    expiresAt: string,
    input: { peerId?: string; kind?: "group" | "private"; occurredAtSeconds?: number } = {},
  ) => {
    insertEvent(key, input);
    orm
      .insert(schema.qqObservationText)
      .values({
        eventKey: key,
        body: `正文 ${key}`,
        occurredAtSeconds: input.occurredAtSeconds ?? 1_700_000_000,
        expiresAt,
        recordedAt: nowIso(),
      })
      .run();
  };

  insertObservation("obs-live", FUTURE, { occurredAtSeconds: 1_700_000_100 });
  insertObservation("obs-expired", PAST, { occurredAtSeconds: 1_700_000_090 });
  insertObservation("obs-unicode", PAST, {
    peerId: UNICODE_PEER,
    occurredAtSeconds: 1_700_000_080,
  });
  insertObservation("obs-private", PAST, {
    kind: "private",
    peerId: "20001",
    occurredAtSeconds: 1_700_000_070,
  });
  // Same clock on purpose: the second sort key (id desc) has to make the order deterministic.
  insertObservation("obs-tie-a", PAST, { occurredAtSeconds: 1_700_000_060 });
  insertObservation("obs-tie-b", PAST, { occurredAtSeconds: 1_700_000_060 });

  // Media rows carry an upstream reference and a description; neither may leave the surface.
  orm
    .insert(schema.qqMediaNotes)
    .values({
      id: MEDIA_LIVE,
      eventKey: "obs-live",
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: "upstream-live",
      note: null,
      noteModel: null,
      attempts: 0,
      addressed: 0,
      expiresAt: FUTURE,
      recordedAt: "2026-09-29T10:00:00.000000Z",
      updatedAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.qqMediaNotes)
    .values({
      id: MEDIA_EXPIRED,
      eventKey: "obs-expired",
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: "media-secret-ref-xyz",
      note: "媒体说明正文",
      noteModel: "fixture-vision",
      attempts: 1,
      addressed: 1,
      expiresAt: PAST,
      recordedAt: "2026-09-29T10:00:01.000000Z",
      updatedAt: nowIso(),
    })
    .run();

  for (const [id, expiresAt, spokeAtSeconds] of [
    [SPEECH_LIVE, FUTURE, 1_700_000_100],
    [SPEECH_EXPIRED, PAST, 1_699_999_000],
  ] as const) {
    orm
      .insert(schema.qqSpeechLog)
      .values({
        id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: AGENT,
        kind: "chiming_in",
        spokeAtSeconds,
        expiresAt,
        recordedAt: nowIso(),
      })
      .run();
    orm
      .insert(schema.qqSpeechText)
      .values({
        speechId: id,
        body: `说过的话 ${id}`,
        spokeAtSeconds,
        expiresAt,
        recordedAt: nowIso(),
      })
      .run();
  }

  for (const [id, outcome, sentAtSeconds, expiresAt, deliveryMessageId] of [
    [SEND_PLAIN, "sent", 1_700_000_050, PAST, "m-plain"],
    [SEND_UNKNOWN, "unknown", 1_700_000_100, PAST, null],
    [SEND_INFLIGHT, "sent", 1_700_000_200, PAST, "m-inflight"],
    [SEND_LIVE, "sent", 1_700_000_300, FUTURE, "m-live"],
  ] as const) {
    orm
      .insert(schema.qqSendLog)
      .values({
        id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: AGENT,
        kind: "direct_reply",
        outcome,
        deliveryMessageId,
        sentAtSeconds,
        expiresAt,
        recordedAt: nowIso(),
      })
      .run();
  }
  // The in-flight send is still held by an outbound intent (status `delivering`): expired, but
  // its ledger entry must survive until the delivery is settled.
  orm
    .insert(schema.conversations)
    .values({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      channel: "onebot11",
      topology: "direct",
      sourceId: "qq:10001:group:30003",
      agentId: AGENT,
      userId: DEFAULT_USER_ID,
      bindingEpoch: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.agentRuns)
    .values({
      runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      specId: "qq-reply",
      specVersion: "1",
      ownerKind: "conversation",
      ownerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      userId: DEFAULT_USER_ID,
      agentId: AGENT,
      status: "generating",
      startedAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.outboundIntents)
    .values({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      conversationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      outputOrdinal: 0,
      target: JSON.stringify({
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: AGENT,
      }),
      speechKind: "direct_reply",
      sourceThroughSeq: 1,
      deliverBy: FUTURE,
      status: "delivering",
      createdAt: nowIso(),
      expiresAt: FUTURE,
      legacySendId: SEND_INFLIGHT,
    })
    .run();

  for (const [userId, lastSeenAtSeconds, expiresAt] of [
    ["20001", 1_700_000_100, FUTURE],
    ["20002", 1_700_000_000, PAST],
  ] as const) {
    orm
      .insert(schema.qqMembers)
      .values({
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        userId,
        nickname: `昵称${userId}`,
        firstSeenAtSeconds: 1_699_000_000,
        lastSeenAtSeconds,
        expiresAt,
      })
      .run();
  }

  // Material is deliberately NOT part of the cleanup surface; the fixture holds one asset so
  // every test can assert it survives untouched.
  const collection = createQqStickerCollection(orm, { name: "日常" });
  importQqSticker(orm, {
    id: STICKER,
    name: "问好",
    copy: { fileName: `${STICKER}.png`, byteSize: 1024, mediaType: "image" },
    width: 8,
    height: 8,
    collectionIds: [collection.id],
  });

  return { business, app: createApp({ business }) };
}

type Handle = ReturnType<typeof fixture>;

const countOf = (h: Handle, table: string) => {
  const row = h.business.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n ?? 0);
};

const idsOf = (h: Handle, table: string, column: string) =>
  (
    h.business.db.query(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`).all() as {
      id: string;
    }[]
  ).map((row) => row.id);

const putSettings = (h: Handle, body: unknown) =>
  h.app.request("/qq/storage/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const postCleanup = (h: Handle, dryRun: boolean, body: unknown) =>
  h.app.request(`/qq/storage/cleanup${dryRun ? "/preview" : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const items = async (h: Handle, query = "") =>
  QqStorageItemsResponseSchema.parse(
    await (await h.app.request(`/qq/storage/items${query === "" ? "" : `?${query}`}`)).json(),
  );

describe("QQ storage settings", () => {
  it("reads the seeded window and swaps it on the shared revision (CAS)", async () => {
    const h = fixture();
    try {
      const initialResponse = await h.app.request("/qq/storage/settings");
      expect(initialResponse.status).toBe(200);
      expect(initialResponse.headers.get("cache-control")).toBe("no-store");
      const initial = QqStorageSettingsResponseSchema.parse(await initialResponse.json());
      expect(initial).toMatchObject({ retention_days: 14, cleanup_mode: "manual" });

      const saved = await putSettings(h, {
        retention_days: 30,
        expected_revision: initial.revision,
      });
      expect(saved.status).toBe(200);
      const after = QqStorageSettingsResponseSchema.parse(await saved.json());
      expect(after.retention_days).toBe(30);
      expect(after.revision).toBe(initial.revision + 1);

      // The summary reports the stored window, not the build-time default.
      const usage = (await (await h.app.request("/qq/storage")).json()) as {
        retention: { days: number };
      };
      expect(usage.retention.days).toBe(30);

      // A stale revision is a conflict, never a silent overwrite.
      const stale = await putSettings(h, {
        retention_days: 60,
        expected_revision: initial.revision,
      });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
        "MEMORY_STATE_CONFLICT",
      );

      // Saving the same value changes nothing, including the revision.
      const noop = await putSettings(h, { retention_days: 30, expected_revision: after.revision });
      expect(noop.status).toBe(200);
      expect((await noop.json()).revision).toBe(after.revision);
    } finally {
      h.business.close();
    }
  });

  it("rejects out-of-range or malformed saves with 422", async () => {
    const h = fixture();
    try {
      const revision = (
        QqStorageSettingsResponseSchema.parse(
          await (await h.app.request("/qq/storage/settings")).json(),
        ) as { revision: number }
      ).revision;
      for (const body of [
        { retention_days: 0, expected_revision: revision },
        { retention_days: 3651, expected_revision: revision },
        { retention_days: 14.5, expected_revision: revision },
        { retention_days: "30", expected_revision: revision },
        { retention_days: 30, expected_revision: 0 },
        { retention_days: 30 },
        { retention_days: 30, expected_revision: revision, cleanup_mode: "auto" },
      ]) {
        expect((await putSettings(h, body)).status).toBe(422);
      }
    } finally {
      h.business.close();
    }
  });
});

describe("QQ storage items", () => {
  it("lists metadata only, newest first, with a stable cursor and filters", async () => {
    const h = fixture();
    try {
      const first = await items(h);
      expect(first.total).toBe(6);
      expect(first.items.map((item) => item.id)).toEqual([
        "obs-live",
        "obs-expired",
        "obs-unicode",
        "obs-private",
        "obs-tie-b",
        "obs-tie-a",
      ]);
      expect(first.next_cursor).toBeNull();
      expect(first.items[0]).toEqual({
        id: "obs-live",
        category: "observation_text",
        account_id: "10001",
        kind: "group",
        peer_id: "30003",
        agent_id: AGENT,
        created_at: expect.any(String),
        expires_at: FUTURE,
        expired: false,
        protected: false,
      });
      // No message body, no upstream reference, no description may appear anywhere.
      const raw = JSON.stringify(first);
      expect(raw).not.toContain("正文");
      expect(raw).not.toContain("media-secret-ref-xyz");
      expect(raw).not.toContain("媒体说明正文");

      // Keyset paging with limit=1 walks every row exactly once, in the same order.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 6; page += 1) {
        const query = cursor === null ? "limit=1" : `limit=1&cursor=${encodeURIComponent(cursor)}`;
        const answer = await items(h, query);
        expect(answer.items).toHaveLength(1);
        expect(answer.total).toBe(6);
        seen.push(answer.items[0].id);
        cursor = answer.next_cursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual([
        "obs-live",
        "obs-expired",
        "obs-unicode",
        "obs-private",
        "obs-tie-b",
        "obs-tie-a",
      ]);
      expect(cursor).toBeNull();

      // Status and conversation filters.
      expect((await items(h, "status=expired")).total).toBe(5);
      expect((await items(h, "status=live")).items.map((item) => item.id)).toEqual(["obs-live"]);
      expect((await items(h, `peer_id=${encodeURIComponent(UNICODE_PEER)}`)).items[0].id).toBe(
        "obs-unicode",
      );
      expect((await items(h, "kind=private")).items[0].id).toBe("obs-private");

      // Invalid filters and cursors are 422; a cursor never falls back to page one.
      for (const query of [
        "status=maybe",
        "category=bogus",
        "kind=room",
        "limit=101",
        "limit=0",
        "limit=abc",
        "cursor=nope",
        `cursor=${encodeURIComponent(JSON.stringify([1, 2]))}`,
        `cursor=${encodeURIComponent(JSON.stringify({ clock: 1.5, id: "x" }))}`,
        "now=2000-01-01T00:00:00Z",
      ]) {
        expect((await h.app.request(`/qq/storage/items?${query}`)).status).toBe(422);
      }
    } finally {
      h.business.close();
    }
  });

  it("reports each category with its own clock, ids and protection flags", async () => {
    const h = fixture();
    try {
      const media = await items(h, "category=media_notes");
      expect(media.items.map((item) => item.id)).toEqual([MEDIA_EXPIRED, MEDIA_LIVE]);
      expect(media.items[0]).toMatchObject({
        category: "media_notes",
        account_id: "10001",
        kind: "group",
        peer_id: "30003",
        agent_id: AGENT,
        created_at: "2026-09-29T10:00:01.000000Z",
        expires_at: PAST,
        expired: true,
        protected: false,
      });
      expect(JSON.stringify(media)).not.toContain("media-secret-ref-xyz");

      const speech = await items(h, "category=speech");
      expect(speech.items.map((item) => item.id)).toEqual([SPEECH_LIVE, SPEECH_EXPIRED]);
      expect(speech.items[0].expires_at).toBe(FUTURE);

      const sends = await items(h, "category=sends");
      expect(sends.items.map((item) => item.id)).toEqual([
        SEND_LIVE,
        SEND_INFLIGHT,
        SEND_UNKNOWN,
        SEND_PLAIN,
      ]);
      expect(sends.items.map((item) => item.protected)).toEqual([false, true, true, false]);

      const nicknames = await items(h, "category=nicknames");
      // Nicknames have no single-column key: the exported id is the composite, stable identity.
      expect(nicknames.items.map((item) => item.id)).toEqual([
        "10001:group:30003:20001",
        "10001:group:30003:20002",
      ]);
      expect(nicknames.items[0]).toMatchObject({
        category: "nicknames",
        kind: "group",
        peer_id: "30003",
        agent_id: null,
        expires_at: FUTURE,
        expired: false,
      });
      expect(nicknames.items[1]).toMatchObject({ expires_at: PAST, expired: true });
    } finally {
      h.business.close();
    }
  });
});

describe("QQ storage cleanup", () => {
  it("previews with zero writes, then removes only expired rows in the category", async () => {
    const h = fixture();
    try {
      const preview = await postCleanup(h, true, { category: "observation_text" });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toEqual({
        category: "observation_text",
        matched: 6,
        expired: 5,
        protected: 0,
        removable: 5,
        removed: 0,
      });
      // Zero writes: the same rows are still listed and still expired.
      const afterPreview = await items(h);
      expect(afterPreview.total).toBe(6);
      expect(afterPreview.items.filter((item) => item.expired)).toHaveLength(5);

      const exec = await postCleanup(h, false, { category: "observation_text" });
      expect(await exec.json()).toEqual({
        category: "observation_text",
        matched: 6,
        expired: 5,
        protected: 0,
        removable: 5,
        removed: 5,
      });
      const after = await items(h);
      expect(after.total).toBe(1);
      expect(after.items[0].id).toBe("obs-live");

      // Identity (qq_events) survives its text being cleaned; material is never touched.
      expect(countOf(h, "qq_events")).toBe(6);
      const usage = (await (await h.app.request("/qq/storage")).json()) as {
        stickers: {
          collections: number;
          assets: number;
          enabled: number;
          bytes: number;
        };
      };
      expect(usage.stickers).toEqual({ collections: 1, assets: 1, enabled: 0, bytes: 1024 });

      // A second run has nothing left to remove.
      const again = await postCleanup(h, false, { category: "observation_text" });
      expect((await again.json()).removed).toBe(0);

      // Media: one expired note goes, the live position stays.
      const mediaExec = await postCleanup(h, false, { category: "media_notes" });
      expect(await mediaExec.json()).toEqual({
        category: "media_notes",
        matched: 2,
        expired: 1,
        protected: 0,
        removable: 1,
        removed: 1,
      });
      const mediaAfter = await items(h, "category=media_notes");
      expect(mediaAfter.items.map((item) => item.id)).toEqual([MEDIA_LIVE]);
    } finally {
      h.business.close();
    }
  });

  it("cleans only the selected rows and protects unresolved sends", async () => {
    const h = fixture();
    try {
      // The whole category: one settled row is removable, two are protected.
      const preview = await postCleanup(h, true, { category: "sends" });
      expect(await preview.json()).toEqual({
        category: "sends",
        matched: 4,
        expired: 3,
        protected: 2,
        removable: 1,
        removed: 0,
      });

      // Selection touches exactly the named row.
      const one = await postCleanup(h, false, { category: "sends", ids: [SEND_PLAIN] });
      expect(await one.json()).toEqual({
        category: "sends",
        matched: 1,
        expired: 1,
        protected: 0,
        removable: 1,
        removed: 1,
      });
      expect(idsOf(h, "qq_send_log", "id")).toEqual([SEND_UNKNOWN, SEND_INFLIGHT, SEND_LIVE]);

      // Whole category again: the protected rows must survive the sweep.
      const rest = await postCleanup(h, false, { category: "sends" });
      expect(await rest.json()).toEqual({
        category: "sends",
        matched: 3,
        expired: 2,
        protected: 2,
        removable: 0,
        removed: 0,
      });
      expect(idsOf(h, "qq_send_log", "id")).toEqual([SEND_UNKNOWN, SEND_INFLIGHT, SEND_LIVE]);

      // An unknown id selects nothing; an empty array is a 422 and never "all".
      const unknown = await postCleanup(h, false, { category: "sends", ids: ["does-not-exist"] });
      expect(await unknown.json()).toEqual({
        category: "sends",
        matched: 0,
        expired: 0,
        protected: 0,
        removable: 0,
        removed: 0,
      });
      expect((await postCleanup(h, false, { category: "sends", ids: [] })).status).toBe(422);
      expect((await postCleanup(h, true, { category: "sends", ids: [] })).status).toBe(422);
      expect(countOf(h, "qq_send_log")).toBe(3);

      // Nicknames are addressed by the composite id the list exported, and nothing else moves.
      const nicknameRun = await postCleanup(h, false, {
        category: "nicknames",
        ids: ["10001:group:30003:20002"],
      });
      expect(QqStorageCleanupSelectionResponseSchema.parse(await nicknameRun.json())).toEqual({
        category: "nicknames",
        matched: 1,
        expired: 1,
        protected: 0,
        removable: 1,
        removed: 1,
      });
      expect(idsOf(h, "qq_members", "user_id")).toEqual(["20001"]);

      // Speech: the expired record goes and its body row cascades with it.
      const speechRun = await postCleanup(h, false, { category: "speech" });
      expect((await speechRun.json()).removed).toBe(1);
      expect(idsOf(h, "qq_speech_log", "id")).toEqual([SPEECH_LIVE]);
      expect(countOf(h, "qq_speech_text")).toBe(1);
    } finally {
      h.business.close();
    }
  });

  it("keeps the legacy five-count cleanup for an empty body", async () => {
    const h = fixture();
    try {
      // The legacy sweep must share the sends rule with the by-category path (see
      // `sendProtected`), so pin both sides of it: an expired attempt an outbound intent still
      // holds (`planned`) survives, and one its intent released (`confirmed`) is deleted.
      // `SEND_UNKNOWN`/`SEND_INFLIGHT` already cover the `unknown` outcome and `delivering`.
      const SEND_PENDING = "77777777-7777-4777-8777-777777777777";
      const SEND_SETTLED = "88888888-8888-4888-8888-888888888888";
      for (const [id, deliveryMessageId, sentAtSeconds] of [
        [SEND_PENDING, "m-pending", 1_700_000_400],
        [SEND_SETTLED, "m-settled", 1_700_000_500],
      ] as const) {
        h.business.orm
          .insert(schema.qqSendLog)
          .values({
            id,
            accountId: "10001",
            conversationKind: "group",
            peerId: "30003",
            agentId: AGENT,
            kind: "direct_reply",
            outcome: "sent",
            deliveryMessageId,
            sentAtSeconds,
            expiresAt: PAST,
            recordedAt: nowIso(),
          })
          .run();
      }
      for (const [id, status, outputOrdinal, legacySendId] of [
        ["aaaaaaaa-0000-4000-8000-000000000001", "planned", 1, SEND_PENDING],
        ["aaaaaaaa-0000-4000-8000-000000000002", "confirmed", 2, SEND_SETTLED],
      ] as const) {
        h.business.orm
          .insert(schema.outboundIntents)
          .values({
            id,
            runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            conversationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            outputOrdinal,
            target: JSON.stringify({
              accountId: "10001",
              conversationKind: "group",
              peerId: "30003",
              agentId: AGENT,
            }),
            speechKind: "direct_reply",
            sourceThroughSeq: 1,
            deliverBy: FUTURE,
            status,
            createdAt: nowIso(),
            expiresAt: FUTURE,
            legacySendId,
          })
          .run();
      }
      // One part rides on the settled send: it must cascade with it and never be counted as a
      // removed send.
      h.business.orm
        .insert(schema.qqSendPart)
        .values({ sendId: SEND_SETTLED, partIndex: 0, partKind: "text", result: "not_sent" })
        .run();
      expect(countOf(h, "qq_send_part")).toBe(1);

      const legacy = await h.app.request("/qq/storage/cleanup", { method: "POST" });
      expect(legacy.status).toBe(200);
      expect(await legacy.json()).toEqual({
        observation_text: 5,
        media_notes: 1,
        speech: 1,
        sends: 2,
        nicknames: 1,
      });
      // Only the unprotected rows went. `sends` counts the removed log rows themselves (2), not
      // the part their foreign key removed with them; every outbound intent stays in place.
      expect(idsOf(h, "qq_send_log", "id")).toEqual([
        SEND_UNKNOWN,
        SEND_INFLIGHT,
        SEND_LIVE,
        SEND_PENDING,
      ]);
      expect(countOf(h, "qq_send_part")).toBe(0);
      expect(countOf(h, "outbound_intents")).toBe(3);
      // Identity rows survive the legacy sweep too.
      expect(countOf(h, "qq_events")).toBe(6);
      // Preview has no legacy form: an empty body selects nothing, so it is a 422.
      expect((await h.app.request("/qq/storage/cleanup/preview", { method: "POST" })).status).toBe(
        422,
      );
    } finally {
      h.business.close();
    }
  });

  it("guards the storage management surface", async () => {
    const h = fixture();
    try {
      const list = await h.app.request("/qq/storage/items");
      expect(list.status).toBe(200);
      expect(list.headers.get("cache-control")).toBe("no-store");
      expect(
        (await h.app.request("/qq/storage", { headers: { origin: "https://evil.example" } }))
          .status,
      ).toBe(403);
      expect(
        (
          await h.app.request("/qq/storage/items", {
            headers: { "sec-fetch-site": "cross-site" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await h.app.request("/qq/storage/settings", {
            headers: { origin: "https://evil.example" },
          })
        ).status,
      ).toBe(403);
      // Writes must be JSON; other content types are refused by the same guard.
      expect(
        (
          await h.app.request("/qq/storage/cleanup/preview", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: JSON.stringify({ category: "sends" }),
          })
        ).status,
      ).toBe(422);
    } finally {
      h.business.close();
    }
  });
});
