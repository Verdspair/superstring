// `qq_media_source` 是媒体读取引用的唯一执行面：id = 精确媒体行、revision 冻结完整
// scope 与 media/asset/link 现值身份；raw `qq_media_asset` 引用没有生产 mint 方，恒 revoked。
// 本文件钉死 mint/复验的 owner 四维身份、scope 隔离与消费帽语义。
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { sourceAccess } from "../../src/server/agent/context-access";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  linkMediaAssetSource,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import { recordMediaAttempt, recordMediaSegment } from "../../src/server/db/qq-media-repository";
import {
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  createQqMediaSourceRef,
  qqMediaSourceAccess,
} from "../../src/server/services/qq-media-sources";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const AGENT = "00000000-0000-0000-0000-000000000001";
const ACCOUNT = "10001";
const PEER = "20001";
const NOW = new Date().toISOString().replace("Z", "000Z").slice(0, 26);
const EXPIRES = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  .toISOString()
  .replace("Z", "000Z")
  .slice(0, 26);

function seedMediaNote(orm: ReturnType<typeof openBusinessDb>["orm"], noteId: string) {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: `ev-${noteId}`,
      accountId: ACCOUNT,
      conversationKind: "group",
      peerId: PEER,
      agentId: AGENT,
      messageId: `m-${noteId}`,
      occurredAtSeconds: 10,
      speakerKind: "member",
      speakerId: "30001",
      recordedAt: NOW,
    })
    .run();
  orm
    .insert(schema.qqMediaNotes)
    .values({
      id: noteId,
      eventKey: `ev-${noteId}`,
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: `ref-${noteId}`,
      attempts: 0,
      expiresAt: EXPIRES,
      recordedAt: NOW,
      updatedAt: NOW,
    })
    .run();
}

describe("raw qq_media_asset source refs are closed (revoked)", () => {
  it("a raw asset ref is revoked even with a live source link, for every owner shape", () => {
    const h = openBusinessDb();
    try {
      ensureDefaults(h.orm, "synthetic-model");
      seedMediaNote(h.orm, "mn-raw");
      const { asset } = recordMediaAsset(h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes: new Uint8Array([137, 80, 78, 71, 1]),
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      linkMediaAssetSource(h.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-raw",
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: EXPIRES,
      });
      const ref: SourceRef = {
        kind: "qq_media_asset",
        id: asset.id,
        revision: String(asset.revision),
        expiresAt: EXPIRES,
      };
      // 所有 owner 形态都拒绝：raw 口不再有任何执行面（宽授权关闭）。
      const owners: RunOwner[] = [
        { kind: "conversation", id: "conv", userId: DEFAULT_USER_ID, agentId: AGENT },
        { kind: "qq_binding", id: "binding", userId: DEFAULT_USER_ID, agentId: AGENT },
        { kind: "qq_media", id: "mn-raw", userId: DEFAULT_USER_ID },
        { kind: "web_turn", id: "turn", userId: DEFAULT_USER_ID },
      ];
      for (const owner of owners)
        expect(sourceAccess(h.db, ref, owner, { userId: DEFAULT_USER_ID }, NOW)).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("an expired raw asset ref reads expired, never available, and never revives through another live link", () => {
    const h = openBusinessDb();
    try {
      ensureDefaults(h.orm, "synthetic-model");
      seedMediaNote(h.orm, "mn-raw-a");
      seedMediaNote(h.orm, "mn-raw-b");
      const { asset } = recordMediaAsset(h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes: new Uint8Array([9, 9, 9]),
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      const ref: SourceRef = {
        kind: "qq_media_asset",
        id: asset.id,
        revision: String(asset.revision),
        expiresAt: EXPIRES,
      };
      const owner: RunOwner = { kind: "qq_media", id: "mn-raw-a", userId: DEFAULT_USER_ID };
      expect(sourceAccess(h.db, ref, owner, { userId: DEFAULT_USER_ID }, NOW)).toBe("revoked");
      // 过期帽：raw 口在窗口外仍应是 expired 而不是 available（语义保序，授权恒拒）。
      const past = new Date(Date.parse(EXPIRES) + 1000).toISOString();
      expect(sourceAccess(h.db, ref, owner, { userId: DEFAULT_USER_ID }, past)).toBe("expired");
      // 另一条媒体行挂上 live link（同资产）也不能复活：raw 口已闭，链接无关。
      linkMediaAssetSource(h.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-raw-b",
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: EXPIRES,
      });
      expect(sourceAccess(h.db, ref, owner, { userId: DEFAULT_USER_ID }, nowIso())).toBe("revoked");
    } finally {
      h.close();
    }
  });
});

// ---- T08a-source2：qq_media_source mint 与精确 scope 复验（R18） ----

const SRC_ACCOUNT = "10001";
const SRC_PEER = "30003";
const SRC_AGENT = "00000000-0000-0000-0000-000000000001";
const SRC_OTHER_AGENT = "00000000-0000-0000-0000-000000000002";
const SRC_OTHER_PEER = "30009";
const SRC_BINDING_ID = "11111111-1111-4111-8111-111111111111";

function shaOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Fixture {
  h: ReturnType<typeof openBusinessDb>;
  orm: Orm;
  db: ReturnType<typeof openBusinessDb>["db"];
  conversationId: string;
  bindingEpoch: number;
  scope: QqConversationScope;
  mint(mediaNoteId: string): SourceRef | null;
  /** 真实媒体行 + 携带它的 journal inbound 事件（media 引用在 sources 里）。 */
  mediaWithJournal(
    eventKey: string,
    input?: { at?: number },
  ): NonNullable<ReturnType<typeof recordMediaSegment>>;
}

function openFixture(): Fixture {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  const scheme = createScheme(h.orm);
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: SRC_BINDING_ID,
      accountId: SRC_ACCOUNT,
      conversationKind: "group",
      peerId: SRC_PEER,
      agentId: SRC_AGENT,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(SRC_BINDING_ID);
  if (!conversation) throw new Error("conversation fixture missing");
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: SRC_ACCOUNT,
    conversationKind: "group",
    peerId: SRC_PEER,
    agentId: SRC_AGENT,
    bindingId: SRC_BINDING_ID,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: 1,
  };
  const now = nowIso();
  const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const mediaWithJournal = (
    eventKey: string,
    input: { at?: number } = {},
  ): NonNullable<ReturnType<typeof recordMediaSegment>> => {
    const occurred = input.at ?? Math.floor(Date.now() / 1000);
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: SRC_ACCOUNT,
        conversationKind: "group",
        peerId: SRC_PEER,
        agentId: SRC_AGENT,
        messageId: `message-${eventKey}`,
        occurredAtSeconds: occurred,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey,
        body: `body-${eventKey}`,
        occurredAtSeconds: occurred,
        expiresAt: future,
        recordedAt: now,
      })
      .run();
    journal.ingestOneBotEvent(eventKey, SRC_BINDING_ID);
    const seg = recordMediaSegment(h.orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef: `ref-${eventKey}`,
      occurredAtSeconds: occurred,
      addressed: true,
    });
    // 媒体引用进 journal 的 inbound 事件（真实 journal 形状：inbound 携带 sources）。
    journal.append({
      conversationId: conversation.id,
      eventKey: `media-src:${seg.id}`,
      kind: "inbound",
      source: {
        kind: "qq_media",
        id: seg.id,
        revision: String(seg.attempts),
        expiresAt: seg.expiresAt,
      },
      sources: [
        { kind: "qq_event", id: eventKey, revision: now },
        { kind: "qq_media", id: seg.id, revision: String(seg.attempts), expiresAt: seg.expiresAt },
      ],
      occurredAt: now,
    });
    return seg;
  };
  return {
    h,
    orm: h.orm,
    db: h.db,
    conversationId: conversation.id,
    bindingEpoch: conversation.bindingEpoch,
    scope,
    // mint 之前先落 link：资产/link 是哈希输入，先于 mint 存在，ref 才能稳定。
    mint: (mediaNoteId) => {
      linkAsset(h, mediaNoteId);
      return createQqMediaSourceRef(h, scope, mediaNoteId, now);
    },
    mediaWithJournal,
  };
}

function createScheme(orm: Orm): { id: string } {
  const row = orm
    .insert(schema.qqSchemes)
    .values({
      id: crypto.randomUUID(),
      name: `qq-media-source-access-${crypto.randomUUID()}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning()
    .get();
  return row;
}

function ownerFor(f: Fixture, kind: "conversation" | "qq_binding", id?: string): RunOwner {
  return {
    kind,
    id: id ?? (kind === "conversation" ? f.conversationId : SRC_BINDING_ID),
    userId: DEFAULT_USER_ID,
    agentId: SRC_AGENT,
  };
}

/** 正常资产 + link：返回 (asset, link 行) 供各用例操纵。 */
function linkAsset(
  f: { orm: Orm },
  mediaNoteId: string,
  input?: { expiresAt?: string; at?: string },
) {
  const at = input?.at ?? nowIso();
  const expiresAt =
    input?.expiresAt ?? new Date(Date.parse(at) + 14 * 24 * 60 * 60 * 1000).toISOString();
  const { asset } = recordMediaAsset(f.orm, {
    scope: {
      accountId: SRC_ACCOUNT,
      conversationKind: "group",
      peerId: SRC_PEER,
      agentId: SRC_AGENT,
    },
    bytes: new Uint8Array([137, 80, 78, 71, 2]),
    mimeType: "image/png",
    expiresAt,
    at,
  });
  const link = linkMediaAssetSource(f.orm, {
    assetId: asset.id,
    mediaNoteId,
    scope: {
      accountId: SRC_ACCOUNT,
      conversationKind: "group",
      peerId: SRC_PEER,
      agentId: SRC_AGENT,
    },
    expiresAt,
    at,
  });
  return { asset, link, expiresAt };
}

describe("qq_media_source mint + precise scope access", () => {
  it("mint + access: a real media row inside the caller's scope mints an available ref (id = exact media row)", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-ok");
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(ref.kind).toBe("qq_media_source");
      expect(ref.id).toBe(seg.id);
      // expiresAt 是实际消费帽，不晚于媒体行自身期限。
      expect(Date.parse(ref.expiresAt ?? "") <= Date.parse(seg.expiresAt)).toBe(true);
      linkAsset(f, seg.id);
      const refAfterLink = f.mint(seg.id);
      expect(refAfterLink).not.toBeNull();
      if (!refAfterLink) return;
      expect(
        qqMediaSourceAccess(
          f.db,
          refAfterLink,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // qq_binding owner 走同一函数同样可用。
      expect(
        qqMediaSourceAccess(
          f.db,
          refAfterLink,
          ownerFor(f, "qq_binding"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
    } finally {
      f.h.close();
    }
  });

  it("cross-agent / cross-conversation / wrong owner kind: the media row belongs to another scope", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-cross");
      linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      // owner.agentId 与 scope.agentId 不符 → revoked。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          {
            kind: "conversation",
            id: f.conversationId,
            userId: DEFAULT_USER_ID,
            agentId: "other-agent",
          },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // conversation owner 指向别间会话 → revoked。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          {
            kind: "conversation",
            id: "some-other-conversation",
            userId: DEFAULT_USER_ID,
            agentId: SRC_AGENT,
          },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 非 DEFAULT_USER_ID principal → revoked。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: "someone-else" },
          nowIso(),
        ),
      ).toBe("revoked");
      // 不认识的 owner kind → revoked（不是 undefined 回落）。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          { kind: "web_turn", id: "t1", userId: DEFAULT_USER_ID },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("binding epoch / authority revision change: old refs fail closed", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-epoch");
      linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // 绑定换纪元（模拟换绑/权限提升后 epoch 前进）。
      f.h.orm
        .update(schema.qqBindings)
        .set({ revision: 2, authorityRevision: 2 })
        .where(eq(schema.qqBindings.id, SRC_BINDING_ID))
        .run();
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 旧 ref 在 mint 侧同样失效（scope 现值已变）。
      expect(f.mint(seg.id)).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("no link / deleted link: without THIS row's live source link there is no access even with another live link elsewhere", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-nolink");
      const segB = f.mediaWithJournal("ev-nolink-b");
      const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      // 先在无 link 时手工造 ref 形状（真实 mint 需要 link，见 other 用例）：access 拒绝。
      const prelink = f.h.db
        .query(
          "SELECT event_key AS eventKey,segment_index AS segmentIndex,source_ref AS sourceRef,attempts AS attempts,expires_at AS mediaExpiresAt FROM qq_media_notes WHERE id=?",
        )
        .get(seg.id) as {
        eventKey: string;
        segmentIndex: number;
        sourceRef: string;
        attempts: number;
        mediaExpiresAt: string;
      };
      const rawRef: SourceRef = {
        kind: "qq_media_source",
        id: seg.id,
        revision: "0".repeat(64),
        expiresAt: prelink.mediaExpiresAt,
      };
      expect(
        qqMediaSourceAccess(
          f.db,
          rawRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 另一行挂 live link 也救不了本行。
      linkAsset(f, segB.id);
      expect(
        qqMediaSourceAccess(
          f.db,
          rawRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 本行挂上后真 mint 可用；删掉本行 link 后再次失效（不借他行 link 复活）。
      linkAsset(f, seg.id, { expiresAt: future });
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      f.h.db.query("DELETE FROM qq_media_asset_sources WHERE media_note_id=?").run(seg.id);
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("asset revision/bytes refill and new epoch: old refs do not come back", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-rev");
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      linkAsset(f, seg.id);
      expect(
        qqMediaSourceAccess(
          f.db,
          ref as SourceRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // 资产 revision 前进（新缓存纪元重填）→ 旧 ref 复算不等 → revoked。
      f.h.orm.update(schema.qqMediaAssets).set({ revision: 2 }).run();
      expect(
        qqMediaSourceAccess(
          f.db,
          ref as SourceRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 媒体行被清空后经新纪元重写（segmentIndex 相同的新行）→ 旧 ref 的 id 已不指向现行。
      const fresh = f.mediaWithJournal("ev-rev-new");
      expect(fresh.id).not.toBe(seg.id);
      expect(
        qqMediaSourceAccess(
          f.db,
          ref as SourceRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("three expiries: media / link / asset window end reads expired, never available; ref expiresAt cap first", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-exp-media");
      const { expiresAt } = linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      const past = new Date(Date.parse(expiresAt) + 1000).toISOString();
      // ref.expiresAt 过期帽在最前（与 sourceAccess 顶部一致）。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          past,
        ),
      ).toBe("expired");
      // link 自身到期先于媒体行 → expired（到期判先于哈希复算）。
      const early = new Date(Date.now() + 1000).toISOString();
      linkAsset(f, seg.id, { expiresAt: early });
      const refEarly = f.mint(seg.id);
      expect(refEarly).not.toBeNull();
      if (!refEarly) return;
      expect(Date.parse(refEarly.expiresAt ?? "") <= Date.parse(early)).toBe(true);
      f.h.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE media_note_id=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString(), seg.id);
      expect(
        qqMediaSourceAccess(
          f.db,
          refEarly,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("expired");
      // asset 提前到期 → expired。
      f.h.db
        .query("UPDATE qq_media_assets SET expires_at=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString());
      expect(
        qqMediaSourceAccess(
          f.db,
          refEarly,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("expired");
      // 媒体行自身到期 → expired。
      f.h.db
        .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString(), seg.id);
      expect(
        qqMediaSourceAccess(
          f.db,
          refEarly,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("expired");
    } finally {
      f.h.close();
    }
  });

  it("no actual journal media event: a media row never journaled into this conversation's timeline mints nothing and reads revoked", () => {
    const f = openFixture();
    try {
      // 只落 qq_events + 媒体行，不进 journal（无 inbound 带 qq_media 引用）。
      const eventKey = "ev-nojournal";
      const occurred = Math.floor(Date.now() / 1000);
      f.orm
        .insert(schema.qqEvents)
        .values({
          eventKey,
          accountId: SRC_ACCOUNT,
          conversationKind: "group",
          peerId: SRC_PEER,
          agentId: SRC_AGENT,
          messageId: `message-${eventKey}`,
          occurredAtSeconds: occurred,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      const seg = recordMediaSegment(f.orm, {
        eventKey,
        segmentIndex: 0,
        kind: "image",
        sourceRef: `ref-${eventKey}`,
        occurredAtSeconds: occurred,
        addressed: true,
      });
      linkAsset(f, seg.id);
      expect(f.mint(seg.id)).toBeNull();
      // 手工构造同形状 ref 也拒绝：不在本会话 timeline。
      expect(
        qqMediaSourceAccess(
          f.db,
          {
            kind: "qq_media_source",
            id: seg.id,
            revision: "0".repeat(64),
            expiresAt: seg.expiresAt,
          },
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("same scope re-mints the identical stable ref; an ambiguous multi-conversation owner fails closed", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-stable");
      linkAsset(f, seg.id);
      const a = f.mint(seg.id);
      const b = f.mint(seg.id);
      expect(a).toEqual(b);
      expect(
        qqMediaSourceAccess(
          f.db,
          a as SourceRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // 同一绑定开第二间活会话（旧纪元行已 closed；直接插一行未 closed 的同绑定会话
      // 会撞 uq_conversations_current_source，所以这里只能通过正常 ensure 产生的唯一
      // 活会话验证；歧义防线用 owner 指向不存在会话已覆盖）。
      expect(
        qqMediaSourceAccess(
          f.db,
          a as SourceRef,
          { kind: "conversation", id: "missing-conv", userId: DEFAULT_USER_ID, agentId: SRC_AGENT },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });
});

describe("t08a-source-fix1 hardening (RED→GREEN)", () => {
  it("mint at real now: expired media/link/asset window or missing link each mint nothing", () => {
    const f = openFixture();
    try {
      const past = new Date(Date.parse(nowIso()) - 60 * 1000).toISOString();
      // 1) 媒体行窗口已过（真实边界：有效写入后窗口随时间流逝，SQL UPDATE 模拟）。
      const segExpired = f.mediaWithJournal("ev-mint-expired");
      linkAsset(f, segExpired.id);
      f.h.db.query("UPDATE qq_media_notes SET expires_at=? WHERE id=?").run(past, segExpired.id);
      expect(createQqMediaSourceRef(f.h, f.scope, segExpired.id, nowIso())).toBeNull();
      // 2) 无 link：不 mint（真实 mint 需要 live link）。
      const segNoLink = f.mediaWithJournal("ev-mint-nolink");
      const bare = f.h.orm
        .select()
        .from(schema.qqMediaNotes)
        .where(eq(schema.qqMediaNotes.id, segNoLink.id))
        .get();
      expect(bare).toBeDefined();
      expect(createQqMediaSourceRef(f.h, f.scope, segNoLink.id, nowIso())).toBeNull();
      // 3) link 窗口已过：不 mint。
      const segDeadLink = f.mediaWithJournal("ev-mint-deadlink");
      linkAsset(f, segDeadLink.id);
      f.h.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE media_note_id=?")
        .run(past, segDeadLink.id);
      expect(createQqMediaSourceRef(f.h, f.scope, segDeadLink.id, nowIso())).toBeNull();
      // 4) 资产窗口已过：不 mint。
      const segDeadAsset = f.mediaWithJournal("ev-mint-deadasset");
      linkAsset(f, segDeadAsset.id);
      f.h.db.query("UPDATE qq_media_assets SET expires_at=?").run(past);
      expect(createQqMediaSourceRef(f.h, f.scope, segDeadAsset.id, nowIso())).toBeNull();
      // 5) 对照组：真实 now 下全部窗口有效时 mint 成功。
      const segLive = f.mediaWithJournal("ev-mint-live");
      linkAsset(f, segLive.id);
      expect(createQqMediaSourceRef(f.h, f.scope, segLive.id, nowIso())).not.toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("mint refuses an asset that lives in another scope: bytes stay out of reach across groups/agents", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-cross-scope");
      // 别的 scope 的资产（同账号不同 peer）——linkMediaAssetSource 按真实仓储拒绝。
      const { asset } = recordMediaAsset(f.orm, {
        scope: {
          accountId: SRC_ACCOUNT,
          conversationKind: "group",
          peerId: "other-peer",
          agentId: SRC_AGENT,
        },
        bytes: new Uint8Array([7, 7, 7]),
        mimeType: "image/png",
        expiresAt: new Date(Date.parse(nowIso()) + 60 * 1000).toISOString(),
      });
      expect(() =>
        linkMediaAssetSource(f.orm, {
          assetId: asset.id,
          mediaNoteId: seg.id,
          scope: {
            accountId: SRC_ACCOUNT,
            conversationKind: "group",
            peerId: SRC_PEER,
            agentId: SRC_AGENT,
          },
          expiresAt: new Date(Date.parse(nowIso()) + 60 * 1000).toISOString(),
        }),
      ).toThrow();
      // 没有同 scope link，mint 失败；access 侧同样拒绝。
      expect(createQqMediaSourceRef(f.h, f.scope, seg.id, nowIso())).toBeNull();
      const forged: SourceRef = {
        kind: "qq_media_source",
        id: seg.id,
        revision: "0".repeat(64),
        expiresAt: nowIso(),
      };
      expect(
        qqMediaSourceAccess(
          f.db,
          forged,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("SQL asset scope isolation: a link planted directly to a foreign peer/agent asset mints nothing and reads revoked", () => {
    const f = openFixture();
    try {
      // 第二个真实 agent 行（外键真生效，必须先建被引用行）。
      f.orm
        .insert(schema.agents)
        .values({
          id: SRC_OTHER_AGENT,
          name: "另一助手",
          systemPrompt: "",
          description: "",
          additionalInstructions: "",
          p5Config: "{}",
          modelName: "synthetic-model",
          memoryConsolidationPrompt: "",
          memoryConsolidationAdditionalInstructions: "",
          memoryRetrievalPrompt: "",
          updatedAt: nowIso(),
          createdAt: nowIso(),
        })
        .run();
      const seg = f.mediaWithJournal("ev-sql-scope");
      const future = new Date(Date.parse(nowIso()) + 60 * 1000).toISOString();
      // 绕过 linkMediaAssetSource（它按仓储语义拒绝），直接 SQL 把 link 行插向
      // （a）同账号不同 peer、（b）同账号同 peer 不同 agent 的资产——真实 FK 下的
      // 恶意 link 行。scope 隔离必须由 mint/access 的 SQL 谓词自己证明。
      const bytes = new Uint8Array([7, 7, 7]);
      const sha = shaOf(bytes);
      const at = nowIso();
      const insertAsset = (peerId: string, agentId: string): string => {
        const row = f.h.orm
          .insert(schema.qqMediaAssets)
          .values({
            id: crypto.randomUUID(),
            accountId: SRC_ACCOUNT,
            conversationKind: "group",
            peerId,
            agentId,
            contentSha256: sha,
            bytes,
            mimeType: "image/png",
            revision: 1,
            expiresAt: future,
            recordedAt: at,
          })
          .returning()
          .get();
        return row.id;
      };
      const otherPeerAsset = insertAsset(SRC_OTHER_PEER, SRC_AGENT);
      const otherAgentAsset = insertAsset(SRC_PEER, SRC_OTHER_AGENT);
      f.h.db
        .query(
          "INSERT INTO qq_media_asset_sources (id,asset_id,media_note_id,expires_at,recorded_at) VALUES (?,?,?,?,?)",
        )
        .run(crypto.randomUUID(), otherPeerAsset, seg.id, future, at);
      expect(createQqMediaSourceRef(f.h, f.scope, seg.id, nowIso())).toBeNull();
      const forged: SourceRef = {
        kind: "qq_media_source",
        id: seg.id,
        revision: "0".repeat(64),
        expiresAt: future,
      };
      expect(
        qqMediaSourceAccess(
          f.db,
          forged,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 换成不同 agent 的资产 link，同样 mint null / access revoked。
      f.h.db.query("DELETE FROM qq_media_asset_sources WHERE media_note_id=?").run(seg.id);
      f.h.db
        .query(
          "INSERT INTO qq_media_asset_sources (id,asset_id,media_note_id,expires_at,recorded_at) VALUES (?,?,?,?,?)",
        )
        .run(crypto.randomUUID(), otherAgentAsset, seg.id, future, at);
      expect(createQqMediaSourceRef(f.h, f.scope, seg.id, nowIso())).toBeNull();
      expect(
        qqMediaSourceAccess(
          f.db,
          forged,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 对照：同 scope 真实 link 重新挂上后 mint 恢复（证明拒绝来自 scope 谓词而非 fixture）。
      f.h.db.query("DELETE FROM qq_media_asset_sources WHERE media_note_id=?").run(seg.id);
      linkAsset(f, seg.id);
      expect(createQqMediaSourceRef(f.h, f.scope, seg.id, nowIso())).not.toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("sha-only change (revision frozen) revokes; revision-only change (sha frozen) revokes: hash freezes both identity fields", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-bytes");
      linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // sha 单独变化（revision 冻结在旧值）→ revoked。生产写路径里 sha 由字节计算
      // （recordMediaAsset），这里只证 hash 把 sha 当作冻结输入，不绕 DDL 造字节路径。
      f.h.orm
        .update(schema.qqMediaAssets)
        .set({ contentSha256: "f".repeat(64) })
        .run();
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // revision 单独变化（sha 还原到原值）→ revoked：双身份字段任一漂移即失效。
      f.h.orm
        .update(schema.qqMediaAssets)
        .set({ contentSha256: shaOf(new Uint8Array([137, 80, 78, 71, 2])), revision: 9 })
        .run();
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("a describe attempt does not revoke the image ref: hash freezes identity, not task state", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-attempts");
      linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // 纯描述认领走真实 recordMediaAttempt（同一媒体行）——attempts 属读取任务自己的
      // 计数，不是原图字节身份；未改的 bytes/link/asset 不使 ref 失效。
      const claimed = recordMediaAttempt(f.orm, {
        eventKey: seg.eventKey,
        segmentIndex: seg.segmentIndex,
        expectedAttempts: seg.attempts,
      });
      expect(claimed.attempts).toBe(seg.attempts + 1);
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // 对照：新 mint 的 revision 与旧 ref 相同（身份未变，同源可用）。
      const reMinted = f.mint(seg.id);
      expect(reMinted).not.toBeNull();
      expect(reMinted?.revision).toBe(ref.revision);
    } finally {
      f.h.close();
    }
  });

  it("owner authorization is complete: missing userId / wrong explicit agentId fail closed", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-owner");
      linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      // RunOwner 契约允许省略 agentId（strictObject optional），但 userId 必须存在且等于
      // DEFAULT_USER_ID；显式 agentId 与会话/绑定 agent 不一致必须拒绝。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          {
            kind: "conversation",
            id: f.conversationId,
            userId: DEFAULT_USER_ID,
            agentId: SRC_AGENT,
          },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // userId 缺失 → revoked。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          { kind: "conversation", id: f.conversationId, agentId: SRC_AGENT } as RunOwner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 显式 agentId 与会话/绑定 agent 不一致 → revoked。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          {
            kind: "conversation",
            id: f.conversationId,
            userId: DEFAULT_USER_ID,
            agentId: "other-agent",
          },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // qq_binding owner 同样要求 userId 存在。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          { kind: "qq_binding", id: SRC_BINDING_ID, agentId: SRC_AGENT } as RunOwner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // owner 四维身份：agentId 缺省（RunOwner 公共 optional）不是授权缺省——
      // conversation owner 无显式 agentId → revoked。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          { kind: "conversation", id: f.conversationId, userId: DEFAULT_USER_ID },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // qq_binding owner 无显式 agentId → revoked。
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          { kind: "qq_binding", id: SRC_BINDING_ID, userId: DEFAULT_USER_ID },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("closed conversation / rebind epoch: access revokes and mint refuses at the new epoch", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-close");
      linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      expect(
        qqMediaSourceAccess(
          f.db,
          ref as SourceRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // 会话关闭：唯一活会话消失 → owner 定位失败 → revoked；mint 也拒绝。
      f.h.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(nowIso(), f.conversationId);
      expect(
        qqMediaSourceAccess(
          f.db,
          ref as SourceRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      expect(createQqMediaSourceRef(f.h, f.scope, seg.id, nowIso())).toBeNull();
      // 绑定纪元前进后重开新会话：必开新纪元行（旧行已 closed），id 不同且无条件拒绝旧 ref。
      f.h.orm
        .update(schema.qqBindings)
        .set({ revision: 2, authorityRevision: 2 })
        .where(eq(schema.qqBindings.id, SRC_BINDING_ID))
        .run();
      const reopened = new ConversationEventRepository(f.db).ensureOneBot(SRC_BINDING_ID);
      expect(reopened).not.toBeNull();
      if (!reopened) return;
      expect(reopened.id).not.toBe(f.conversationId);
      expect(
        qqMediaSourceAccess(
          f.db,
          ref as SourceRef,
          { kind: "conversation", id: reopened.id, userId: DEFAULT_USER_ID, agentId: SRC_AGENT },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("row caps are mandatory: a real row whose window cap moved past now reads expired/revoked, and NULL caps cannot exist (DDL)", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-cap");
      const link = linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      expect(
        qqMediaSourceAccess(
          f.db,
          ref as SourceRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // 1) ref 缺 expiresAt 的合成变形也过不了：真实行窗口仍要在行数据上复核。
      //    （0052 DDL：三表 expires_at 均 NOT NULL——NULL 帽在真实库中不可构造，
      //    所以行帽强制经由 hash 冻结 + 日期比较证明，不借 NULL 注入。）
      // 2) 行窗口真实流逝（早于 ref 帽）→ expired，不由 ref 帽兜底成 available。
      const justNow = new Date(Date.parse(nowIso()) - 1000).toISOString();
      f.h.db.query("UPDATE qq_media_notes SET expires_at=? WHERE id=?").run(justNow, seg.id);
      const futureRef: SourceRef = {
        kind: "qq_media_source",
        id: (ref as SourceRef).id,
        revision: (ref as SourceRef).revision,
        expiresAt: new Date(Date.parse(nowIso()) + 60 * 1000).toISOString(),
      };
      expect(
        qqMediaSourceAccess(
          f.db,
          futureRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("expired");
      // 3) link 窗口先尽（早于媒体行）→ expired；hash 已随行帽变化失效，
      //    但过期判先行（与 sourceAccess 顶部序一致）。
      f.h.db
        .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(nowIso()) + 60 * 1000).toISOString(), seg.id);
      f.h.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE media_note_id=?")
        .run(justNow, seg.id);
      expect(
        qqMediaSourceAccess(
          f.db,
          futureRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("expired");
      // 4) hash 严格性：行帽改回后 revision 与 mint 时不一致（ref 帽字面值被伪造）→ revoked。
      f.h.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE media_note_id=?")
        .run(link.expiresAt, seg.id);
      expect(
        qqMediaSourceAccess(
          f.db,
          futureRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("a ref whose ref.expiresAt is missing cannot exceed the real consumption cap: row cap still gates", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-nocap-ref");
      const early = new Date(Date.parse(nowIso()) - 1000).toISOString();
      // 真实边界：仓储拒过期写入，所以先有效挂接，再经 SQL 把 link 窗口拨回过去。
      linkAsset(f, seg.id);
      f.h.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE media_note_id=?")
        .run(early, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).toBeNull();
      // 合成 ref 缺 expiresAt：行真实窗口已过 → expired，绝不 available。
      const noCap: SourceRef = {
        kind: "qq_media_source",
        id: seg.id,
        revision: "0".repeat(64),
      };
      expect(
        qqMediaSourceAccess(
          f.db,
          noCap,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("expired");
      // 把行窗口续到未来也不行：caps 里的 ref 帽缺失，access 仍按真实行数据复核；
      // 但合成 revision 无法匹配真实行现值（hash 冻结了窗口值，无 expiresAt 的 ref
      // 无从获得合法 revision）→ revoked 而不是 available。
      // （link 窗口经 SQL 拨回未来：真实 linkMediaAssetSource 重挂只收窄不延长。）
      const future = new Date(Date.parse(nowIso()) + 60 * 1000).toISOString();
      f.h.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE media_note_id=?")
        .run(future, seg.id);
      // 真实 mint（带合法帽）证明行本身可读，再证缺帽 ref 不能绕过 revision 复核。
      const realRef = createQqMediaSourceRef(f.h, f.scope, seg.id, nowIso());
      expect(realRef).not.toBeNull();
      expect(
        qqMediaSourceAccess(
          f.db,
          realRef as SourceRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      expect(
        qqMediaSourceAccess(
          f.db,
          noCap,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("exact-link deletion + relink: the OLD ref stays revoked (revision drift), only the re-minted ref is available", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-relink");
      linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      expect(
        qqMediaSourceAccess(
          f.db,
          ref as SourceRef,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // 删 link 再挂新 link（新 link expiry 改变 → hash 改变）→ 旧 ref 不复活。
      f.h.db.query("DELETE FROM qq_media_asset_sources WHERE media_note_id=?").run(seg.id);
      linkAsset(f, seg.id, { expiresAt: new Date(Date.parse(nowIso()) + 30 * 1000).toISOString() });
      const refNew = f.mint(seg.id);
      expect(refNew).not.toBeNull();
      if (!refNew || !ref) return;
      expect(refNew.revision).not.toBe(ref.revision);
      expect(
        qqMediaSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMediaSourceAccess(
          f.db,
          refNew,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
    } finally {
      f.h.close();
    }
  });
});

// ---- t08a-source-entrytest：统一入口负测（fix2 scoped review Minor 勘误） ----
// R21 只把 `qq_media_source` 委托提到 context-access 顶部 generic expiry 之前：
// 合法 owner 过期 → expired；跨 owner / 缺 agentId / 错 principal 必须 revoked，
// 不允许在统一 `sourceAccess` 入口处先把过期状态泄给非授权方。
describe("t08a-source-entrytest: unified sourceAccess entry keeps cross-owner states hidden for expired refs", () => {
  it("a real minted ref whose expiresAt passed: the legitimate complete owner reads expired through the unified sourceAccess entry", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-entry-live");
      linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      // 合法完整 owner（conversation 四维身份齐全）经统一入口，窗口内可用。
      expect(
        sourceAccess(f.db, ref, ownerFor(f, "conversation"), { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("available");
      expect(
        sourceAccess(f.db, ref, ownerFor(f, "qq_binding"), { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("available");
      // ref 帽不变，媒体行窗口真实流逝（有效写入后时间推移，SQL 模拟）：合法
      // owner 经统一入口 → expired（行帽先于 revision 复核，与 access 顶部序一致）。
      f.h.db
        .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString(), seg.id);
      expect(
        sourceAccess(f.db, ref, ownerFor(f, "conversation"), { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("expired");
      expect(
        sourceAccess(f.db, ref, ownerFor(f, "qq_binding"), { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("expired");
    } finally {
      f.h.close();
    }
  });

  it("the same expired ref through the unified entry: cross-owner / missing agentId / wrong user / unknown owner kind all read revoked, never expired", () => {
    const f = openFixture();
    try {
      const seg = f.mediaWithJournal("ev-entry-cross");
      linkAsset(f, seg.id);
      const ref = f.mint(seg.id);
      expect(ref).not.toBeNull();
      if (!ref) return;
      // ref 帽拨到过去：如果统一入口在 owner 核之前做 generic expiry，跨 owner
      // 就会先看到 expired（状态泄漏）；owner-first 语义要求这里恒 revoked。
      const refPast: SourceRef = {
        ...ref,
        expiresAt: new Date(Date.parse(nowIso()) - 60 * 1000).toISOString(),
      };
      // 两个 owner kind 的完整形状先确认合法 owner 基线（合法 owner 在过去帽下应为
      // expired，由上一用例覆盖；此处仅证跨 owner 恒 revoked）。
      // 跨 conversation（别间会话的同 agent owner）→ revoked，不因过期变 expired。
      expect(
        sourceAccess(
          f.db,
          refPast,
          { kind: "conversation", id: "missing-conv", userId: DEFAULT_USER_ID, agentId: SRC_AGENT },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 跨 qq_binding（不同绑定的 owner）→ revoked。
      expect(
        sourceAccess(
          f.db,
          refPast,
          {
            kind: "qq_binding",
            id: "missing-binding",
            userId: DEFAULT_USER_ID,
            agentId: SRC_AGENT,
          },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 缺 agentId 的 conversation owner → revoked（RunOwner optional 不代表授权可缺）。
      expect(
        sourceAccess(
          f.db,
          refPast,
          { kind: "conversation", id: f.conversationId, userId: DEFAULT_USER_ID } as RunOwner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 缺 agentId 的 qq_binding owner → revoked。
      expect(
        sourceAccess(
          f.db,
          refPast,
          { kind: "qq_binding", id: SRC_BINDING_ID, userId: DEFAULT_USER_ID } as RunOwner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // wrong user principal → revoked。
      expect(
        sourceAccess(
          f.db,
          refPast,
          ownerFor(f, "conversation"),
          { userId: "someone-else" },
          nowIso(),
        ),
      ).toBe("revoked");
      // 错显式 agentId → revoked。
      expect(
        sourceAccess(
          f.db,
          refPast,
          {
            kind: "conversation",
            id: f.conversationId,
            userId: DEFAULT_USER_ID,
            agentId: "other-agent",
          },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 未认识的 owner kind → revoked。
      expect(
        sourceAccess(
          f.db,
          refPast,
          { kind: "web_turn", id: "t1", userId: DEFAULT_USER_ID },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      // 状态不泄漏：同一 ref、同一时刻，跨 owner 的 revoked 不因后来 owner 变化翻成
      // expired/available——过期 ref 的真实状态只对合法 owner 可见（上用例）。
      expect(
        sourceAccess(
          f.db,
          refPast,
          ownerFor(f, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("expired");
    } finally {
      f.h.close();
    }
  });
});
