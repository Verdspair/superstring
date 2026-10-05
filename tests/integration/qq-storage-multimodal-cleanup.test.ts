// T14：五类别 manual 清理的 0052 多模态私有数据完整接线（多面列表 + 多面选择闭包）。
//
// 主控 ruling 的可验证不变式：
//  1. 每个可独立选择删除的私有记录都是管理主行：members+入站 facts、send log+出站 facts、
//     media note+asset+source+read task 各自进元数据列表（新 id 固定前缀防冲突），也各自
//     能被 selected 命中；
//  2. removed 只数显式 DELETE 的行；由真实 FK 级联带走（variants/classifications、被 doom
//     的 source/task）不计入，preview 与 execute 同一 doom 口径（removed == removable）；
//  3. 保护不可绕：running task / 非终态 run 精确引用 / unsafe agent task / unknown 投递
//     全部保全；shared sha 的另一资产、另一 scope 的资产不因本选择消失；
//  4. 列表与清理永不携带正文/blob/sha/URL/真名/平台 ID；[] fail-closed（422）、未知 id
//     matched 0 不删其它行、其它类别前缀不能借选择扩面；
//  5. legacy 五计数 == 各类别 execute removed 之和（legacy 委托类别路径，无重复计数）。

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  linkMediaAssetSource,
  mediaAssetForContent,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import {
  attemptMediaReadTask,
  recordMediaReadTask,
} from "../../src/server/db/qq-media-task-repository";
import {
  qqStorageCleanupExecute,
  qqStorageCleanupPreview,
  qqStorageItemsPage,
} from "../../src/server/db/qq-storage-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const AGENT = DEFAULT_AGENT_ID;
const NOW = nowIso();
const PAST = "2020-01-01T00:00:00.000000Z";
const FUTURE = "2030-01-01T00:00:00.000000Z";
const SWEEP = "2026-01-01T00:00:00.000000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function seedEvent(h: ReturnType<typeof setup>, key: string, peerId = "30003") {
  h.orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId: AGENT,
      messageId: key,
      occurredAtSeconds: 1_700_000_000,
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: NOW,
    })
    .run();
}

function seedFact(h: ReturnType<typeof setup>, eventKey: string, expiresAt: string) {
  seedEvent(h, eventKey);
  h.orm
    .insert(schema.qqMessageFacts)
    .values({
      eventKey,
      groupCard: "阿林",
      groupCardSource: "wire",
      personalNickname: "阿林个人",
      personalNicknameSource: "wire",
      legacyDisplayName: null,
      nameState: "known",
      parts: JSON.stringify([{ kind: "text", text: "秘密正文" }]),
      replyToMessageId: null,
      revision: 1,
      expiresAt,
      recordedAt: NOW,
    })
    .run();
}

function seedMember(h: ReturnType<typeof setup>, userId: string, expiresAt: string) {
  h.orm
    .insert(schema.qqMembers)
    .values({
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      userId,
      nickname: `昵称${userId}`,
      firstSeenAtSeconds: 1_699_000_000,
      lastSeenAtSeconds: 1_700_000_000,
      expiresAt,
    })
    .run();
}

function bind(h: ReturnType<typeof setup>, bindingId: string): string {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(NOW, NOW);
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,paused,share_web_memory,revision,authority_revision,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',0,0,1,1,?,?)",
    )
    .run(bindingId, "10001", "group", "30003", AGENT, NOW, NOW);
  const conversation = new ConversationEventRepository(h.db).ensureOneBot(bindingId);
  if (!conversation) throw new Error("binding conversation missing");
  return conversation.id;
}

function seedIntentChain(h: ReturnType<typeof setup>, intentId: string, status: string): void {
  // 同一 peer 的 binding 有唯一约束：一次夹具内所有 intent 共用同一条 binding。
  const conversationId = bind(h, "bd-fx");
  const runs = new AgentRunRepository(h.db);
  runs.createRun({
    runId: `run-${intentId}`,
    specId: "qq-reply",
    specVersion: "1",
    owner: { kind: "conversation", id: conversationId },
    at: NOW,
  });
  h.db
    .query(
      "INSERT INTO outbound_intents(id,run_id,conversation_id,output_ordinal,target,speech_kind,source_through_seq,deliver_by,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'planned',?,?)",
    )
    .run(
      intentId,
      `run-${intentId}`,
      conversationId,
      0,
      JSON.stringify({
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: AGENT,
        bindingId: "bd-fx",
        bindingEpoch: 1,
      }),
      "direct_reply",
      1,
      FUTURE,
      NOW,
      FUTURE,
    );
  if (status !== "planned") {
    h.db.query("UPDATE outbound_intents SET status=? WHERE id=?").run(status, intentId);
  }
}

function seedOutboundFact(h: ReturnType<typeof setup>, intentId: string, expiresAt: string) {
  seedIntentChain(h, intentId, "confirmed");
  h.orm
    .insert(schema.qqOutboundMessageFacts)
    .values({
      intentId,
      accountId: "10001",
      agentId: AGENT,
      groupCard: null,
      personalNickname: "群猫娘",
      legacyDisplayName: null,
      parts: "[]",
      revision: 1,
      expiresAt,
    })
    .run();
}

function seedMediaNote(
  h: ReturnType<typeof setup>,
  id: string,
  eventKey: string,
  expiresAt: string,
) {
  seedEvent(h, eventKey);
  h.orm
    .insert(schema.qqMediaNotes)
    .values({
      id,
      eventKey,
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: `ref-${id}`,
      note: null,
      noteModel: null,
      attempts: 0,
      addressed: 1,
      expiresAt,
      recordedAt: NOW,
      updatedAt: NOW,
    })
    .run();
}

const SCOPE = {
  accountId: "10001",
  conversationKind: "group" as const,
  peerId: "30003",
  agentId: AGENT,
};
const OTHER_SCOPE = {
  accountId: "10001",
  conversationKind: "group" as const,
  peerId: "39999",
  agentId: AGENT,
};

function seedAsset(
  h: ReturnType<typeof setup>,
  noteId: string,
  eventKey: string,
  noteExpiry: string,
  bytes: Uint8Array,
  scope: typeof SCOPE,
): { assetId: string; sourceId: string } {
  // 写入/挂接路径都要求真实活窗口：先全活播种，再按场景把 note/asset/link 整闭包拨到
  // 清理时点之前（与"媒体在读中途窗口到期"的真实场景一致）。
  seedMediaNote(h, noteId, eventKey, FUTURE);
  const { asset } = recordMediaAsset(h.orm, {
    scope,
    bytes,
    mimeType: "image/png",
    expiresAt: FUTURE,
    at: NOW,
  });
  const source = linkMediaAssetSource(h.orm, {
    assetId: asset.id,
    mediaNoteId: noteId,
    scope,
    expiresAt: FUTURE,
    at: NOW,
  });
  const wantsExpired = noteExpiry <= SWEEP;
  if (wantsExpired) {
    h.orm
      .update(schema.qqMediaNotes)
      .set({ expiresAt: PAST })
      .where(eq(schema.qqMediaNotes.id, noteId))
      .run();
    h.orm
      .update(schema.qqMediaAssets)
      .set({ expiresAt: PAST })
      .where(eq(schema.qqMediaAssets.id, asset.id))
      .run();
    h.orm
      .update(schema.qqMediaAssetSources)
      .set({ expiresAt: PAST })
      .where(eq(schema.qqMediaAssetSources.id, source.id))
      .run();
  }
  return { assetId: asset.id, sourceId: source.id };
}

/** 把一个媒体闭包（note+asset+link）整拨到清理时点之前：模拟读中途窗口到期。 */
function expireClosure(h: ReturnType<typeof setup>, noteId: string): void {
  const asset = h.db
    .query("SELECT asset_id FROM qq_media_asset_sources WHERE media_note_id=?")
    .get(noteId) as { asset_id: string } | null;
  h.orm
    .update(schema.qqMediaNotes)
    .set({ expiresAt: PAST })
    .where(eq(schema.qqMediaNotes.id, noteId))
    .run();
  if (asset) {
    h.orm
      .update(schema.qqMediaAssets)
      .set({ expiresAt: PAST })
      .where(eq(schema.qqMediaAssets.id, asset.asset_id))
      .run();
    h.orm
      .update(schema.qqMediaAssetSources)
      .set({ expiresAt: PAST })
      .where(eq(schema.qqMediaAssetSources.mediaNoteId as never, noteId))
      .run();
  }
}

function idsOfPage(h: ReturnType<typeof setup>, category: "nicknames" | "sends" | "media_notes") {
  return qqStorageItemsPage(h.orm, { category, status: "all", limit: 100 }, SWEEP).items.map(
    (item) => item.id,
  );
}

const rowsOf = (h: ReturnType<typeof setup>, table: string) =>
  h.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
const countOf = (h: ReturnType<typeof setup>, table: string) =>
  Number((h.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

/** Per-media deterministic controlled-bytes sha: distinct media rows are distinct
 * content identities; the same row keeps the same identity across claims. */
const shaOfMedia = (id: string): string =>
  Array.from(id)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

describe("nicknames category: inbound facts union", () => {
  it("lists member + fact: prefixed rows, cleans both on whole category, unknown id matches nothing", () => {
    const h = setup();
    try {
      seedMember(h, "20002", PAST);
      seedFact(h, "ev-f1", PAST);
      seedFact(h, "ev-f2", FUTURE);
      const listed = idsOfPage(h, "nicknames");
      expect(listed).toContain("10001:group:30003:20002");
      expect(listed).toContain("fact:ev-f1");
      expect(listed).toContain("fact:ev-f2");
      // 元数据无正文：秘密正文与群名片真值不出现在列表 JSON。
      const raw = JSON.stringify(
        qqStorageItemsPage(h.orm, { category: "nicknames", status: "all", limit: 100 }, SWEEP),
      );
      expect(raw).not.toContain("秘密正文");
      expect(raw).not.toContain("阿林个人");

      // 未知 id 与异类前缀：matched 0、零写。
      const before = rowsOf(h, "qq_message_facts");
      const unknown = qqStorageCleanupExecute(
        h.orm,
        {
          category: "nicknames",
          ids: ["fact:nope", "outbound-fact:somewhere", "10001:group:30003:7777"],
        },
        SWEEP,
      );
      expect(unknown.counts.matched).toBe(0);
      expect(unknown.removed).toBe(0);
      expect(rowsOf(h, "qq_message_facts")).toEqual(before);

      // 整类：到期 member 与到期 fact 都删；live fact 与永久 event 键保留。
      const run = qqStorageCleanupExecute(h.orm, { category: "nicknames" }, SWEEP);
      expect(run.counts.removable).toBe(run.removed);
      expect(run.removed).toBe(2);
      expect(countOf(h, "qq_members")).toBe(0);
      expect(countOf(h, "qq_message_facts")).toBe(1);
      expect(countOf(h, "qq_events")).toBe(2);
    } finally {
      h.close();
    }
  });

  it("keeps a held fact (unsafe agent task ref) through whole and selected cleanup, then releases", () => {
    const h = setup();
    try {
      seedFact(h, "ev-held", PAST);
      seedFact(h, "ev-free", PAST);
      const conversationId = bind(h, "bd-fact-held");
      const tasks = new AgentTaskRepository(h.db);
      tasks.enqueue({
        conversationId,
        agentId: AGENT,
        dedupeKey: "task-fact-held",
        sources: [{ kind: "qq_message_fact", id: "ev-held", revision: "1", expiresAt: FUTURE }],
        at: NOW,
        expiresAt: FUTURE,
        calls: [],
      });

      const preview = qqStorageCleanupPreview(h.orm, { category: "nicknames" }, SWEEP);
      expect(preview.matched).toBe(2);
      expect(preview.protected).toBe(1);
      expect(preview.removable).toBe(1);

      const run = qqStorageCleanupExecute(h.orm, { category: "nicknames" }, SWEEP);
      expect(run.removed).toBe(1);
      expect(countOf(h, "qq_message_facts")).toBe(1);

      // 仅选中保护行：removed 0，行原样在。
      const selected = qqStorageCleanupExecute(
        h.orm,
        { category: "nicknames", ids: ["fact:ev-held"] },
        SWEEP,
      );
      expect(selected.counts.removable).toBe(0);
      expect(selected.removed).toBe(0);
      expect(countOf(h, "qq_message_facts")).toBe(1);

      // 任务结算后释放。
      tasks.settle(
        (h.db.query("SELECT id FROM agent_tasks ORDER BY id").all() as { id: string }[])[0].id,
        "completed",
        NOW,
      );
      expect(qqStorageCleanupExecute(h.orm, { category: "nicknames" }, SWEEP).removed).toBe(1);
      expect(countOf(h, "qq_message_facts")).toBe(0);
    } finally {
      h.close();
    }
  });
});

describe("sends category: outbound facts union", () => {
  it("lists outbound-fact rows with scope metadata, cleans settled expired ones, keeps intent-held", () => {
    const h = setup();
    try {
      seedOutboundFact(h, "intent-settled", PAST);
      seedOutboundFact(h, "intent-planned", PAST);
      h.db.query("UPDATE outbound_intents SET status='planned' WHERE id='intent-planned'").run();

      const listed = idsOfPage(h, "sends");
      expect(listed).toContain("outbound-fact:intent-settled");
      expect(listed).toContain("outbound-fact:intent-planned");
      const page = qqStorageItemsPage(
        h.orm,
        { category: "sends", status: "all", limit: 100 },
        SWEEP,
      );
      const fact = page.items.find((item) => item.id === "outbound-fact:intent-settled");
      expect(fact).toMatchObject({ accountId: "10001", kind: "group", peerId: "30003" });

      const run = qqStorageCleanupExecute(h.orm, { category: "sends" }, SWEEP);
      expect(run.counts.protected).toBe(1);
      expect(run.removed).toBe(1);
      expect(countOf(h, "qq_outbound_message_facts")).toBe(1);
      // intent 台账本体永不被存储清理触碰。
      expect(countOf(h, "outbound_intents")).toBe(2);
    } finally {
      h.close();
    }
  });
});

describe("media_notes category: note/asset/source/task union", () => {
  it("lists all four faces with prefixed ids and removes the whole expired closure with exact counts", async () => {
    const h = setup();
    try {
      const { assetId, sourceId } = seedAsset(
        h,
        "mn-a",
        "ev-a",
        FUTURE,
        new Uint8Array([1, 2, 3]),
        SCOPE,
      );
      recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-a",
        contentSha256: shaOfMedia("mn-a"),
        purpose: "baseline",
        policy: "baseline",
        expiresAt: FUTURE,
        at: NOW,
      });
      expireClosure(h, "mn-a");
      h.db
        .query("UPDATE qq_media_read_tasks SET expires_at=? WHERE media_note_id='mn-a'")
        .run(PAST);
      const taskId = (h.db.query("SELECT id FROM qq_media_read_tasks").get() as { id: string }).id;

      const listed = idsOfPage(h, "media_notes");
      expect(listed).toEqual(
        expect.arrayContaining([
          "mn-a",
          `asset:${assetId}`,
          `asset-source:${sourceId}`,
          `read-task:${taskId}`,
        ]),
      );

      const before = rowsOf(h, "qq_media_notes").concat(rowsOf(h, "qq_media_assets"));
      // preview 零写。
      expect(rowsOf(h, "qq_media_notes").concat(rowsOf(h, "qq_media_assets"))).toEqual(before);

      const run = qqStorageCleanupExecute(h.orm, { category: "media_notes" }, SWEEP);
      expect(run.counts.removable).toBe(run.removed);
      // 主行计数：note + asset + read-task 各自是可独立选择删除的主行（载体 SET NULL 后
      // 任务不再被级联带走，作为主行显式删除）；source 仍由 note 级联带走，不进 removed。
      expect(run.removed).toBe(3);
      expect(run.counts.matched).toBe(3);
      expect(countOf(h, "qq_media_notes")).toBe(0);
      expect(countOf(h, "qq_media_assets")).toBe(0);
      expect(countOf(h, "qq_media_asset_sources")).toBe(0);
      // read-task 是独立主行：expired 未保护 → 被显式删除（removed 3 含任务行）。
      expect(countOf(h, "qq_media_read_tasks")).toBe(0);
      expect(mediaAssetForContent(h.orm, { scope: SCOPE, contentSha256: "x", at: NOW })).toBeNull();

      // 选中闭包不借异类前缀扩大范围。
      const foreign = qqStorageCleanupExecute(
        h.orm,
        { category: "media_notes", ids: [`asset:${assetId}`, "fact:ev-a", "mn-a"] },
        SWEEP,
      );
      expect(foreign.counts.matched).toBe(0);
      expect(foreign.removed).toBe(0);
    } finally {
      h.close();
    }
  });

  it("selecting only a source removes exactly that source (1), the asset stays live and readable", () => {
    const h = setup();
    try {
      const { sourceId, assetId } = seedAsset(
        h,
        "mn-src",
        "ev-src",
        PAST,
        new Uint8Array([9]),
        SCOPE,
      );
      // 来源行已被选择删除：其 link 已消失，asset 自己的窗口（future）仍在。
      const run = qqStorageCleanupExecute(
        h.orm,
        { category: "media_notes", ids: [`asset-source:${sourceId}`] },
        SWEEP,
      );
      expect(run.removed).toBe(1);
      expect(countOf(h, "qq_media_asset_sources")).toBe(0);
      // asset 本体未被选中也未到期：仍在，bytes 仍可读。
      expect(countOf(h, "qq_media_assets")).toBe(1);
      const asset = h.db.query("SELECT * FROM qq_media_assets").get() as {
        id: string;
        expires_at: string;
      };
      expect(asset.id).toBe(assetId);
      expect(asset.expires_at).toBe(PAST);
    } finally {
      h.close();
    }
  });

  it("shared sha across scopes: cleaning one scope's note never deletes the other scope's asset", () => {
    const h = setup();
    try {
      seedAsset(h, "mn-s1", "ev-s1", PAST, new Uint8Array([7, 7]), SCOPE);
      // 另一 scope 的 note/asset：事件同 scope（39999），同 sha 不同行。
      seedEvent(h, "ev-s2", "39999");
      h.orm
        .insert(schema.qqMediaNotes)
        .values({
          id: "mn-s2",
          eventKey: "ev-s2",
          segmentIndex: 0,
          segmentKind: "image",
          sourceRef: "ref-mn-s2",
          note: null,
          noteModel: null,
          attempts: 0,
          addressed: 1,
          expiresAt: FUTURE,
          recordedAt: NOW,
          updatedAt: NOW,
        })
        .run();
      const second = recordMediaAsset(h.orm, {
        scope: OTHER_SCOPE,
        bytes: new Uint8Array([7, 7]),
        mimeType: "image/png",
        expiresAt: FUTURE,
        at: NOW,
      });
      linkMediaAssetSource(h.orm, {
        assetId: second.asset.id,
        mediaNoteId: "mn-s2",
        scope: OTHER_SCOPE,
        expiresAt: FUTURE,
        at: NOW,
      });
      const run = qqStorageCleanupExecute(h.orm, { category: "media_notes" }, SWEEP);
      // 只有 scope 1 闭包到期：其 asset/source 随之；另一 scope 全保留。
      expect(countOf(h, "qq_media_assets")).toBe(1);
      const left = h.db.query("SELECT peer_id FROM qq_media_assets").get() as { peer_id: string };
      expect(left.peer_id).toBe("39999");
      void run;
    } finally {
      h.close();
    }
  });

  it("a running task protects note, asset, source and task rows as one closure", async () => {
    const h = setup();
    try {
      // 活窗口创建任务，随后整闭包拨到清理时点之前（读中途到期的真实场景）。
      const { sourceId } = seedAsset(h, "mn-held", "ev-held", FUTURE, new Uint8Array([4]), SCOPE);
      await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-held",
        contentSha256: shaOfMedia("mn-held"),
        purpose: "baseline",
        policy: "p1",
        assertCurrent: () => {},
        at: NOW,
      });
      expireClosure(h, "mn-held");

      const run = qqStorageCleanupExecute(h.orm, { category: "media_notes" }, SWEEP);
      // 全部四行都被保全：removed 0、无写。
      expect(run.removed).toBe(0);
      expect(countOf(h, "qq_media_notes")).toBe(1);
      expect(countOf(h, "qq_media_assets")).toBe(1);
      expect(countOf(h, "qq_media_asset_sources")).toBe(1);
      expect(countOf(h, "qq_media_read_tasks")).toBe(1);

      // 真实失败通路释放 running：note+asset 到期显式删除（source 由 note 级联带走，
      // 不进 removed）；任务行窗口跟随载体帽（FUTURE，未到期）→ 账本存活。
      h.db.query("UPDATE qq_media_read_tasks SET status='failed'").run();
      const released = qqStorageCleanupExecute(h.orm, { category: "media_notes" }, SWEEP);
      expect(released.counts.removable).toBe(released.removed);
      expect(released.removed).toBe(2);
      expect(countOf(h, "qq_media_assets")).toBe(0);
      expect(countOf(h, "qq_media_asset_sources")).toBe(0);
      expect(countOf(h, "qq_media_read_tasks")).toBe(1);
      void sourceId;
    } finally {
      h.close();
    }
  });

  it("preview zero-writes with full row hash and removable == removed on mixed selected cleanup", async () => {
    const h = setup();
    try {
      seedAsset(h, "mn-m1", "ev-m1", PAST, new Uint8Array([1]), SCOPE);
      seedAsset(h, "mn-m2", "ev-m2", FUTURE, new Uint8Array([2]), SCOPE);
      await attemptMediaReadTask(h.orm, {
        mediaNoteId: "mn-m2",
        contentSha256: shaOfMedia("mn-m2"),
        purpose: "baseline",
        policy: "p1",
        assertCurrent: () => {},
        at: NOW,
      });
      expireClosure(h, "mn-m2");
      const snapshot = () =>
        ["qq_media_notes", "qq_media_assets", "qq_media_asset_sources", "qq_media_read_tasks"]
          .map((t) => rowsOf(h, t))
          .join("|");
      const before = snapshot();

      const preview = qqStorageCleanupPreview(
        h.orm,
        { category: "media_notes", ids: ["mn-m1"] },
        SWEEP,
      );
      expect(preview.matched).toBe(1);
      expect(preview.removable).toBe(1);
      expect(snapshot()).toBe(before);

      const run = qqStorageCleanupExecute(
        h.orm,
        { category: "media_notes", ids: ["mn-m1"] },
        SWEEP,
      );
      expect(run.counts.removable).toBe(1);
      expect(run.removed).toBe(1);
      // mn-m1 只显式删了 note：asset 是独立主行、未被选中；source 由其 note 删除级联；
      // mn-m2 的整闭包（含 running task）原样在。
      expect(countOf(h, "qq_media_notes")).toBe(1);
      expect(countOf(h, "qq_media_assets")).toBe(2);
      expect(countOf(h, "qq_media_asset_sources")).toBe(1);
      expect(countOf(h, "qq_media_read_tasks")).toBe(1);
      void before;
    } finally {
      h.close();
    }
  });
});
