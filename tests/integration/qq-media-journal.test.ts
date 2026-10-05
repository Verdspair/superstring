import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  linkMediaAssetSource,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { DEFAULT_AGENT_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { createQqMediaSourceRef } from "../../src/server/services/qq-media-sources";
import type { ConversationEvent } from "../../src/shared/contracts/conversation";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function bind(h: ReturnType<typeof setup>, id = "binding", peerId = "30003", kind = "group") {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
    )
    .run(id, "90001", kind, peerId, DEFAULT_AGENT_ID, now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(id)!;
  return { journal, conversation };
}

/** 真实 wire 路径：一条群图片消息（image 带 file 引用，无文本 = media-only）。 */
function imageObservation(messageId: number, file = `ref-${messageId}`, peerId = 30003) {
  const result = normalizeOneBotMessage(
    {
      time: at,
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: messageId,
      user_id: 10001,
      group_id: peerId,
      sender: { nickname: "阿林" },
      message: [{ type: "image", data: { file } }],
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

describe("production ingest carries precise media refs in the inbound journal", () => {
  it("a media-only message ingests with real qq_media refs in sources: mint works, no url/path/bytes leak", () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h);
      const observation = imageObservation(-201);
      // 生产 intake（同事务 media 先 journal）：recordObservation 落媒体行。
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      // 生产 journal 派生：不再手工 append 额外 inbound 事件。
      const event = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      expect(event).toBeDefined();
      // 主 source 仍是永久 qq_event 身份；body 正常 source 不变。
      expect(event.source).toEqual({
        kind: "qq_event",
        id: observation.eventKey,
        revision: expect.any(String),
      });
      expect(
        event.sources.some((s) => s.kind === "qq_event" && s.id === observation.eventKey),
      ).toBe(true);
      const media = event.sources.filter((s) => s.kind === "qq_media");
      expect(media).toHaveLength(1);
      const row = h.orm
        .select()
        .from(schema.qqMediaNotes)
        .where(eq(schema.qqMediaNotes.eventKey, observation.eventKey))
        .get()!;
      expect(media[0]).toEqual({
        kind: "qq_media",
        id: row.id,
        revision: String(row.attempts),
        expiresAt: row.expiresAt,
      });
      // 不携带 source_ref/url/path/bytes/note 正文。
      expect(JSON.stringify(event.sources)).not.toContain(`ref--201`);
      expect(JSON.stringify(event.sources)).not.toContain("url");
      expect(JSON.stringify(event.sources)).not.toContain("path");
      expect(JSON.stringify(event.sources)).not.toContain("bytes");
      // seq 只推进一次：该 event 是这条媒体消息唯一的 journal 行。
      const rows = h.db
        .query("SELECT seq,event_key FROM conversation_events WHERE conversation_id=?")
        .all(conversation.id) as { seq: number; event_key: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.seq).toBe(1);
      expect(rows[0]!.event_key).toBe(`onebot:${observation.eventKey}`);
      // 媒体行真实进 timeline 后，真实 mint 口可用（不再需要夹具手工补 inbound）。
      // mint 语义还要求本行有同 scope live 资产 link（qq-media-sources 的既定门槛），
      // 按真实仓储挂接后再 mint。
      const asset = recordMediaAsset(h.orm, {
        scope: {
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
        },
        bytes: new Uint8Array([137, 80, 78, 71, 1]),
        mimeType: "image/png",
        expiresAt: row.expiresAt,
      });
      linkMediaAssetSource(h.orm, {
        assetId: asset.asset.id,
        mediaNoteId: row.id,
        scope: {
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
        },
        expiresAt: row.expiresAt,
      });
      const scope = {
        conversationId: conversation.id,
        accountId: "90001",
        conversationKind: "group" as const,
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        bindingId: "binding",
        bindingEpoch: conversation.bindingEpoch,
        authorityRevision: 1,
      };
      expect(createQqMediaSourceRef(h, scope, row.id, nowIso())).toEqual({
        kind: "qq_media_source",
        id: row.id,
        revision: expect.any(String),
        expiresAt: expect.any(String),
      });
    } finally {
      h.close();
    }
  });

  it("multi-segment media rows are appended in stable segment_index order with their own caps", () => {
    const h = setup();
    try {
      const { journal } = bind(h);
      const observation = (() => {
        const result = normalizeOneBotMessage(
          {
            time: at,
            self_id: 90001,
            post_type: "message",
            message_type: "group",
            sub_type: "normal",
            message_id: -202,
            user_id: 10001,
            group_id: 30003,
            sender: { nickname: "阿林" },
            message: [
              { type: "image", data: { file: "ref-b" } },
              { type: "text", data: { text: "两张图" } },
              { type: "image", data: { file: "ref-a" } },
            ],
          },
          "90001",
        );
        if (result.kind !== "message") throw new Error("message expected");
        return result.observation;
      })();
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      const event = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      const media = event.sources.filter((s) => s.kind === "qq_media");
      expect(media).toHaveLength(2);
      const rows = h.orm
        .select()
        .from(schema.qqMediaNotes)
        .where(eq(schema.qqMediaNotes.eventKey, observation.eventKey))
        .orderBy(schema.qqMediaNotes.segmentIndex)
        .all();
      expect(media.map((m) => m.id)).toEqual(rows.map((r) => r.id));
      expect(media.map((m) => m.expiresAt)).toEqual(rows.map((r) => r.expiresAt));
      expect(media.every((m) => m.revision === "0")).toBe(true);
      // sources 里媒体引用在 body 的 qq_observation 之后（scope 顺序稳定、可核对）。
      expect(event.sources.map((s) => s.kind)).toEqual([
        "qq_event",
        "qq_observation",
        "qq_media",
        "qq_media",
      ]);
    } finally {
      h.close();
    }
  });

  it("duplicate ingest of the same event returns the same row: no seq advance, no cap refresh, no source mutation", () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h);
      const observation = imageObservation(-203);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      const first = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      const capsBefore = h.db
        .query(
          "SELECT next_seq,source_watermark,consumed_seq,closed_at,updated_at FROM conversations WHERE id=?",
        )
        .get(conversation.id) as Record<string, unknown>;
      const rowBefore = h.db
        .query("SELECT * FROM conversation_events WHERE conversation_id=? AND seq=?")
        .get(conversation.id, first.seq) as Record<string, unknown>;
      const second = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      expect(second.seq).toBe(first.seq);
      expect(second.recordedAt).toBe(first.recordedAt);
      expect(second.occurredAt).toBe(first.occurredAt);
      expect(second.sources).toEqual(first.sources);
      const capsAfter = h.db
        .query(
          "SELECT next_seq,source_watermark,consumed_seq,closed_at,updated_at FROM conversations WHERE id=?",
        )
        .get(conversation.id) as Record<string, unknown>;
      expect(capsAfter).toEqual(capsBefore);
      const rowAfter = h.db
        .query("SELECT * FROM conversation_events WHERE conversation_id=? AND seq=?")
        .get(conversation.id, first.seq) as Record<string, unknown>;
      expect(rowAfter).toEqual(rowBefore);
      expect(
        (
          h.db
            .query("SELECT count(*) AS n FROM conversation_events WHERE conversation_id=?")
            .get(conversation.id) as { n: number }
        ).n,
      ).toBe(1);
    } finally {
      h.close();
    }
  });

  it("historical journal-first then real media row later: same ingest backfills ONLY the missing precise refs, seq unchanged, old refs kept", () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h);
      const observation = imageObservation(-204);
      // 历史：journal 先 append（此时媒体行还不存在——先 body 后补媒体的真实形状）。
      // 这里用 recordObservation 之外的顺序：先插 qq_events + 正文，再 ingest，
      // 之后才补真实媒体行（row 同 event）。
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: observation.eventKey,
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
          messageId: observation.messageId,
          occurredAtSeconds: at,
          speakerKind: "member",
          speakerId: "10001",
          recordedAt: now,
        })
        .run();
      h.orm
        .insert(schema.qqObservationText)
        .values({
          eventKey: observation.eventKey,
          body: "有图",
          occurredAtSeconds: at,
          expiresAt: "2099-01-01T00:00:00.000Z",
          recordedAt: now,
        })
        .run();
      const first = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      expect(first.sources.every((s) => s.kind !== "qq_media")).toBe(true);
      // 同一 event 补上真实媒体行。
      h.orm
        .insert(schema.qqMediaNotes)
        .values({
          id: crypto.randomUUID(),
          eventKey: observation.eventKey,
          segmentIndex: 0,
          segmentKind: "image",
          sourceRef: "ref-late",
          note: null,
          noteModel: null,
          attempts: 0,
          addressed: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          recordedAt: now,
          updatedAt: now,
        })
        .run();
      const before = h.db
        .query("SELECT next_seq,updated_at FROM conversations WHERE id=?")
        .get(conversation.id) as Record<string, unknown>;
      const second = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      // seq/时间戳不重置；sources 补上精确 media 引用；旧 refs 不被覆盖。
      expect(second.seq).toBe(first.seq);
      expect(second.occurredAt).toBe(first.occurredAt);
      expect(second.recordedAt).toBe(first.recordedAt);
      expect(second.sources.slice(0, 2)).toEqual(first.sources);
      const media = second.sources.filter((s) => s.kind === "qq_media");
      expect(media).toHaveLength(1);
      const row = h.orm
        .select()
        .from(schema.qqMediaNotes)
        .where(eq(schema.qqMediaNotes.eventKey, observation.eventKey))
        .get()!;
      expect(media[0]).toEqual({
        kind: "qq_media",
        id: row.id,
        revision: String(row.attempts),
        expiresAt: row.expiresAt,
      });
      const after = h.db
        .query("SELECT next_seq,updated_at FROM conversations WHERE id=?")
        .get(conversation.id) as Record<string, unknown>;
      expect(after).toEqual(before);
      expect(
        (
          h.db
            .query("SELECT count(*) AS n FROM conversation_events WHERE conversation_id=?")
            .get(conversation.id) as { n: number }
        ).n,
      ).toBe(1);
    } finally {
      h.close();
    }
  });

  it("cross-group media row is not carried into another group's ingest (scope isolation)", () => {
    const h = setup();
    try {
      const { journal } = bind(h, "binding", "30003");
      const other = bind(h, "binding-other", "30009");
      // 同一媒体行挂在 group 30003 的 event 下；对 30009 的 ingest 不可见。
      const observation = imageObservation(-205, "ref-cross", 30003);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      // 30009 的 event：journal ingest 不应携带任何 qq_media 引用。
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "evt-other-group",
          accountId: "90001",
          conversationKind: "group",
          peerId: "30009",
          agentId: DEFAULT_AGENT_ID,
          messageId: "msg-other",
          occurredAtSeconds: at,
          speakerKind: "member",
          speakerId: "10001",
          recordedAt: now,
        })
        .run();
      h.orm
        .insert(schema.qqObservationText)
        .values({
          eventKey: "evt-other-group",
          body: "别的群的图",
          occurredAtSeconds: at,
          expiresAt: "2099-01-01T00:00:00.000Z",
          recordedAt: now,
        })
        .run();
      const event = other.journal.ingestOneBotEvent("evt-other-group", "binding-other")!;
      expect(event.sources.every((s) => s.kind !== "qq_media")).toBe(true);
      // 30003 自己的 event 正常携带。
      const own = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      expect(own.sources.some((s) => s.kind === "qq_media")).toBe(true);
    } finally {
      h.close();
    }
  });

  it("agent rebind / closed conversation: ingest returns null and does not resurrect the closed journal", () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h);
      const observation = imageObservation(-206);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      const first = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      expect(first.sources.some((s) => s.kind === "qq_media")).toBe(true);
      // 换绑到另一助手：旧 epoch 会话被 sealed。
      h.db
        .query(
          "INSERT INTO agents SELECT 'agent-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?",
        )
        .run(DEFAULT_AGENT_ID);
      h.db.query("UPDATE qq_bindings SET agent_id='agent-b' WHERE id='binding'").run();
      // 新 epoch 会话 ingest 同一 event：旧 epoch 的媒体引用不自动迁移给新 Agent/epoch。
      const rebound = journal.ingestOneBotEvent(observation.eventKey, "binding");
      expect(rebound).toBeNull();
      // 旧 journal 行未被改写（sources 仍为首次 ingest 形状）。
      const kept = h.db
        .query("SELECT sources FROM conversation_events WHERE conversation_id=? AND seq=?")
        .get(conversation.id, first.seq) as { sources: string } | null;
      expect(kept).not.toBeNull();
      expect(JSON.parse(kept!.sources)).toEqual(first.sources);
      // 关闭会话行照旧 sealed：ensureOneBot 给新 epoch，不复活旧行。
      const reopened = journal.ensureOneBot("binding")!;
      expect(reopened.bindingEpoch).toBe(conversation.bindingEpoch + 1);
      expect(journal.ingestOneBotEvent(observation.eventKey, "binding")).toBeNull();
    } finally {
      h.close();
    }
  });

  it("merge reaches a scope-closed conversation row and returns it unchanged (closed branch)", () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h);
      const observation = imageObservation(-207);
      // journal 先 append（无媒体行），之后再补同 event 的真实媒体行。
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: observation.eventKey,
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
          messageId: observation.messageId,
          occurredAtSeconds: at,
          speakerKind: "member",
          speakerId: "10001",
          recordedAt: now,
        })
        .run();
      const first = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      expect(first.sources.every((s) => s.kind !== "qq_media")).toBe(true);
      h.orm
        .insert(schema.qqMediaNotes)
        .values({
          id: crypto.randomUUID(),
          eventKey: observation.eventKey,
          segmentIndex: 0,
          segmentKind: "image",
          sourceRef: "ref-closed",
          note: null,
          noteModel: null,
          attempts: 0,
          addressed: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          recordedAt: now,
          updatedAt: now,
        })
        .run();
      // 直接关闭该会话（绕过 ensure 的换绑路径）：这里模拟的 scope 是 closed 会话本身。
      h.db.query("UPDATE conversations SET closed_at=? WHERE id=?").run(now, conversation.id);
      // closed 分支不触达生产入口（ensure 新 epoch 早拒），经 Reflect 单测本分支行为。
      const merge = Reflect.get(journal, "mergeMissingMediaSources") as (
        this: ConversationEventRepository,
        conversationId: string,
        eventKey: string,
        mediaRefs: SourceRef[],
      ) => ConversationEvent | null;
      const result = Reflect.apply(merge, journal, [
        conversation.id,
        `onebot:${observation.eventKey}`,
        [
          {
            kind: "qq_media",
            id: "nonexistent-media-id",
            revision: "0",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
      ]);
      // closed 行只读返回：sources 不被合并改写。
      const row = h.db
        .query("SELECT sources FROM conversation_events WHERE conversation_id=? AND seq=?")
        .get(conversation.id, first.seq) as { sources: string };
      expect(JSON.parse(row.sources)).toEqual(first.sources);
      expect(result).toMatchObject({ sources: first.sources });
    } finally {
      h.close();
    }
  });

  it("returns the actual row when a trigger skips the source merge update", () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h);
      const observation = imageObservation(-208);
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: observation.eventKey,
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
          messageId: observation.messageId,
          occurredAtSeconds: at,
          speakerKind: "member",
          speakerId: "10001",
          recordedAt: now,
        })
        .run();
      const first = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      expect(first.sources.every((s) => s.kind !== "qq_media")).toBe(true);
      h.orm
        .insert(schema.qqMediaNotes)
        .values({
          id: crypto.randomUUID(),
          eventKey: observation.eventKey,
          segmentIndex: 0,
          segmentKind: "image",
          sourceRef: "ref-cas",
          note: null,
          noteModel: null,
          attempts: 0,
          addressed: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          recordedAt: now,
          updatedAt: now,
        })
        .run();
      // trigger 写入竞争值 + RAISE(IGNORE) 静默跳过 merge 的 UPDATE；只证返回真实行
      //（return fidelity，不归因 CAS 守卫）。trigger 体不能绑参，SQL 文本由
      // JSON.stringify 生成并仅转义单引号，值为本测试 synthetic UUID。
      const raced: SourceRef[] = [
        { kind: "qq_event", id: observation.eventKey, revision: "raced" },
      ];
      const racedSql = JSON.stringify(raced).replace(/'/g, "''");
      h.db
        .query(
          `CREATE TRIGGER cas_race BEFORE UPDATE OF sources ON conversation_events
         BEGIN
           UPDATE conversation_events SET sources='${racedSql}'
             WHERE rowid=NEW.rowid;
           SELECT RAISE(IGNORE);
         END`,
        )
        .run();
      const second = journal.ingestOneBotEvent(observation.eventKey, "binding");
      // 返回与 DB 均为真实行；reread 可空（trigger 侧 delete 则为 null），都强断言。
      const reRead = h.db
        .query("SELECT sources FROM conversation_events WHERE conversation_id=? AND seq=?")
        .get(conversation.id, first.seq) as { sources: string } | null;
      if (!second) throw new Error("ingest returned null under trigger skip");
      expect(second.sources).toEqual(raced);
      expect(JSON.parse(reRead!.sources)).toEqual(raced);
      // DROP 触发器后重放：正常合并缺失引用（只证 return fidelity，非合并能力损坏）。
      h.db.query("DROP TRIGGER cas_race").run();
      const third = journal.ingestOneBotEvent(observation.eventKey, "binding")!;
      expect(third.sources).toEqual([
        ...second.sources,
        expect.objectContaining({ kind: "qq_media" }),
      ]);
    } finally {
      h.close();
    }
  });

  it("trigger-side delete of the journal row: ingest returns null instead of a stale snapshot, next_seq unchanged", () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h);
      const observation = imageObservation(-209);
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: observation.eventKey,
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
          messageId: observation.messageId,
          occurredAtSeconds: at,
          speakerKind: "member",
          speakerId: "10001",
          recordedAt: now,
        })
        .run();
      const first = journal.ingestOneBotEvent(observation.eventKey, "binding");
      expect(first).not.toBeNull();
      expect((first as ConversationEvent).sources.every((s) => s.kind !== "qq_media")).toBe(true);
      h.orm
        .insert(schema.qqMediaNotes)
        .values({
          id: crypto.randomUUID(),
          eventKey: observation.eventKey,
          segmentIndex: 0,
          segmentKind: "image",
          sourceRef: "ref-delete",
          note: null,
          noteModel: null,
          attempts: 0,
          addressed: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          recordedAt: now,
          updatedAt: now,
        })
        .run();
      // 真实 trigger：merge 的 UPDATE 之前先删掉本行再 RAISE(IGNORE)，合并无行可写可读。
      h.db
        .query(
          `CREATE TRIGGER journal_row_delete BEFORE UPDATE OF sources ON conversation_events
         BEGIN
           DELETE FROM conversation_events WHERE rowid=NEW.rowid;
           SELECT RAISE(IGNORE);
         END`,
        )
        .run();
      const nextSeq = () =>
        (
          h.db.query("SELECT next_seq FROM conversations WHERE id=?").get(conversation.id) as {
            next_seq: number;
          }
        ).next_seq;
      const nextSeqBefore = nextSeq();
      const second = journal.ingestOneBotEvent(observation.eventKey, "binding");
      expect(second).toBeNull();
      const remaining = h.db
        .query(
          "SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id=? AND event_key=?",
        )
        .get(conversation.id, `onebot:${observation.eventKey}`) as { n: number };
      expect(remaining.n).toBe(0);
      expect(nextSeq()).toBe(nextSeqBefore);
    } finally {
      h.close();
    }
  });
});
