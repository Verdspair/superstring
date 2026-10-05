// T08 稳定任务身份与过期（spec §8.1，resume-t08-identity）。强负测（主控三条不变量收敛版）：
//  * 生产读取必须有可用字节派生 identity：live asset 命中零 fetch；无 asset 走 adapter
//    受控 fetchBytes（同一下载链）；两者皆缺 → 明确拒（identity_unavailable），绝不静默
//    退回行级身份；NULL identity 只允许历史真正不可识别行。
//  * 同 scope 同内容（同 sha）不同 URL/载体行：沿同一任务预算，绝不新建/重置；
//    旧任务 2 次耗尽后新载体行不重获；不同 scope 同 bytes 独立预算。
//  * legacy：不回填网络；本次受控获得同 carrier/同 source_ref 字节时同事务关联既有
//    NULL 任务（attempts 不减）；多历史行合并累计饱和 min(2, sum)；NULL legacy 旧 2
//    耗尽后同 source/同 bytes 新载体不重获。
//  * 首载体 purge：identity/attempts/status 账本存活（FK SET NULL），预算不丢。
//  * expired succeeded：不服务旧正文，claim 只花剩余次数（1→2）、revision 推进使旧
//    ref 失效、过期槽不是 503。窗口按当前授权重新推导（载体帽+宿主帽）。
//  * cross-carrier live-succeeded：服务真实缓存命中（source:"cache"，账本 taskId），
//    不假成功、不静默拒。
// 夹具只走合成库；新文件不 import artifacts（发布排除）。
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { purgeExpiredMediaNotes } from "../../src/server/db/qq-media-repository";
import {
  associateLegacyMediaReadTask,
  attemptMediaReadTask,
  failMediaReadTask,
  MediaReadTaskRejectedError,
  type MediaTaskSourceGuard,
  recordMediaReadTaskResult,
} from "../../src/server/db/qq-media-task-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_USER_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { qqMediaReadTasks } from "../../src/server/db/schema";
import {
  BUSINESS_MIGRATION_FILES,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import type {
  QqMediaReadAdapter,
  QqMediaTaskReadInput,
} from "../../src/server/services/qq-media-reader";
import { readQqMediaTaskOnce } from "../../src/server/services/qq-media-reader";
import { cloneBusinessDb } from "../harness/business-db";

const AGENT = "00000000-0000-0000-0000-000000000001";
const AGENT2 = "00000000-0000-0000-0000-000000000002";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const VERSIONS_DIR = path.join(import.meta.dir, "../../migrations/versions");
const NOW = new Date().toISOString().replace("Z", "000Z").slice(0, 26);
const EXPIRES = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  .toISOString()
  .replace("Z", "000Z")
  .slice(0, 26);
const PAST = "2020-01-01T00:00:00.000000Z";

const guard: MediaTaskSourceGuard = () => {};
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** 合成库：一个绑定 + 可造任意 scope/URL 的媒体载体行。 */
function identityFixture() {
  const h = cloneBusinessDb();
  h.db.exec(`INSERT INTO users VALUES ('u1', 'synthetic', '${NOW}')`);
  h.db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
      p5_config, model_name, memory_consolidation_prompt,
      memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
    VALUES ('${AGENT}', 'synthetic', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
  h.db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
      p5_config, model_name, memory_consolidation_prompt,
      memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
    VALUES ('${AGENT2}', 'synthetic-2', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
  h.db.exec(
    `INSERT INTO qq_schemes (id, name, created_at, updated_at) VALUES ('sch-1', 'synthetic', '${NOW}', '${NOW}')`,
  );
  h.db.exec(
    `INSERT INTO qq_bindings (id, account_id, conversation_kind, peer_id, agent_id, scheme_id,
      paused, share_web_memory, revision, authority_revision, created_at, updated_at)
     VALUES ('${BINDING_ID}', '10001', 'group', '20001', '${AGENT}', 'sch-1', 0, 0, 1, 1, '${NOW}', '${NOW}')`,
  );
  let seq = 0;
  const seed = (
    opts: { peerId?: string; agentId?: string; sourceRef?: string; expiresAt?: string } = {},
  ) => {
    seq += 1;
    const peer = opts.peerId ?? "20001";
    const agent = opts.agentId ?? AGENT;
    const id = `mn-${seq}`;
    const eventKey = `ev-${seq}`;
    h.db
      .query(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES (?, '10001', 'group', ?, ?, 'm-' || ?, 1000, 'member', '30001', ?)`,
      )
      .run(eventKey, peer, agent, String(seq), NOW);
    h.db
      .query(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES (?, ?, 0, 'image', ?, 0, ?, ?, ?)`,
      )
      .run(id, eventKey, opts.sourceRef ?? `ref-${seq}`, opts.expiresAt ?? EXPIRES, NOW, NOW);
    return id;
  };
  return { h, seed };
}

type Handle = ReturnType<typeof identityFixture>["h"];

async function claimReason(
  orm: Parameters<typeof attemptMediaReadTask>[0],
  input: Parameters<typeof attemptMediaReadTask>[1],
) {
  try {
    const claim = await attemptMediaReadTask(orm, input);
    return { claimed: claim as Awaited<ReturnType<typeof attemptMediaReadTask>> };
  } catch (error) {
    return {
      reason:
        error instanceof MediaReadTaskRejectedError
          ? error.reason
          : `other:${(error as Error)?.message ?? "?"}`,
    };
  }
}

async function claimAndSucceed(
  h: Handle,
  mediaNoteId: string,
  contentSha256: string,
  note = "橘猫在沙发上",
) {
  const claim = await attemptMediaReadTask(h.orm, {
    mediaNoteId,
    purpose: "baseline",
    modelName: "vision-a",
    policy: "p1",
    relatedSupplementArrived: false,
    assertCurrent: guard,
    contentSha256,
  });
  recordMediaReadTaskResult(h.orm, {
    mediaNoteId,
    purpose: "baseline",
    note,
    modelName: "vision-a",
    expectedAttempts: claim.attempt,
    claimToken: claim.claimToken,
    assertCurrent: guard,
  });
  return claim;
}

describe("typed media read task identity: schema contract", () => {
  it("identity_key + scope columns + partial unique index + nullable FKs (SET NULL both)", () => {
    const { h } = identityFixture();
    try {
      const cols = h.db.query("PRAGMA table_info(qq_media_read_tasks)").all() as {
        name: string;
        notnull: number;
      }[];
      const names = cols.map((c) => c.name);
      for (const name of [
        "identity_key",
        "account_id",
        "conversation_kind",
        "peer_id",
        "agent_id",
      ]) {
        expect(names).toContain(name);
      }
      for (const name of ["account_id", "conversation_kind", "peer_id", "agent_id"]) {
        expect(cols.find((c) => c.name === name)?.notnull).toBe(1);
      }
      expect(cols.find((c) => c.name === "media_note_id")?.notnull).toBe(0);
      const indexes = h.db.query("PRAGMA index_list(qq_media_read_tasks)").all() as {
        name: string;
        unique: number;
      }[];
      expect(
        indexes.some((i) => i.name === "uq_qq_media_read_task_identity" && i.unique === 1),
      ).toBe(true);
      const fks = h.db.query("PRAGMA foreign_key_list(qq_media_read_tasks)").all() as {
        table: string;
        from: string;
        on_delete: string;
      }[];
      expect(
        fks.find((f) => f.table === "qq_media_notes" && f.from === "media_note_id")?.on_delete,
      ).toBe("SET NULL");
      expect(
        fks.find((f) => f.table === "qq_media_asset_sources" && f.from === "asset_source_id")
          ?.on_delete,
      ).toBe("SET NULL");
    } finally {
      h.close();
    }
  });
});

describe("typed media read task identity: budget semantics", () => {
  it("same scope same sha different URL row carries the budget (no reset, no new row)", async () => {
    const { h, seed } = identityFixture();
    try {
      const first = seed({ sourceRef: "url-a" });
      const claim = await attemptMediaReadTask(h.orm, {
        mediaNoteId: first,
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        relatedSupplementArrived: false,
        assertCurrent: guard,
        contentSha256: SHA_A,
      });
      failMediaReadTask(h.orm, {
        mediaNoteId: first,
        purpose: "baseline",
        expectedAttempt: claim.attempt,
        revisionAtClaim: claim.task.revision,
        claimToken: claim.claimToken,
        assertCurrent: guard,
      });
      // 同内容不同 URL/载体：账本按 identity 命中同一行——1 次已耗，补充门挡第二轮。
      const second = seed({ sourceRef: "url-b" });
      const outcome = await claimReason(h.orm, {
        mediaNoteId: second,
        purpose: "baseline",
        modelName: "vision-b",
        policy: "p2",
        relatedSupplementArrived: true,
        assertCurrent: guard,
        contentSha256: SHA_A,
      });
      expect("reason" in outcome && outcome.reason).toBe("awaiting_supplement");
      const rows = h.orm.select().from(qqMediaReadTasks).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attempts).toBe(1);
      // 被拒的 claim 不写任何状态（原子性）：载体重指只发生在成功 claim 的 CAS 里。
      expect(rows[0]?.mediaNoteId).toBe(first);
      expect(rows[0]?.identityKey).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("a twice-exhausted identity cannot regain budget on a new carrier row", async () => {
    const { h, seed } = identityFixture();
    try {
      const first = seed({ sourceRef: "url-a" });
      for (const attempt of [1, 2]) {
        const claim = await attemptMediaReadTask(h.orm, {
          mediaNoteId: first,
          purpose: "baseline",
          modelName: "vision-a",
          policy: "p1",
          relatedSupplementArrived: attempt === 2,
          proveSupplementLaterThan: attempt === 2 ? () => true : undefined,
          assertCurrent: guard,
          contentSha256: SHA_A,
        });
        failMediaReadTask(h.orm, {
          mediaNoteId: first,
          purpose: "baseline",
          expectedAttempt: claim.attempt,
          revisionAtClaim: claim.task.revision,
          claimToken: claim.claimToken,
          assertCurrent: guard,
        });
      }
      const second = seed({ sourceRef: "url-c" });
      const outcome = await claimReason(h.orm, {
        mediaNoteId: second,
        purpose: "baseline",
        modelName: "vision-c",
        policy: "p3",
        relatedSupplementArrived: true,
        proveSupplementLaterThan: () => true,
        assertCurrent: guard,
        contentSha256: SHA_A,
      });
      expect("reason" in outcome && outcome.reason).toBe("attempts_exhausted");
      expect(h.orm.select().from(qqMediaReadTasks).all()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("different scopes do not share budget for the same bytes", async () => {
    const { h, seed } = identityFixture();
    try {
      const a = seed({ sourceRef: "same-url", peerId: "20001" });
      const b = seed({ sourceRef: "same-url", peerId: "20002" });
      const c1 = await attemptMediaReadTask(h.orm, {
        mediaNoteId: a,
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        relatedSupplementArrived: false,
        assertCurrent: guard,
        contentSha256: SHA_A,
      });
      failMediaReadTask(h.orm, {
        mediaNoteId: a,
        purpose: "baseline",
        expectedAttempt: c1.attempt,
        revisionAtClaim: c1.task.revision,
        claimToken: c1.claimToken,
        assertCurrent: guard,
      });
      // scope B 未花过尝试：第一次 claim 合法（不借 scope A 的账，也不被 A 的失败挡）。
      const c2 = await attemptMediaReadTask(h.orm, {
        mediaNoteId: b,
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        relatedSupplementArrived: false,
        assertCurrent: guard,
        contentSha256: SHA_A,
      });
      expect(c2.attempt).toBe(1);
      expect(h.orm.select().from(qqMediaReadTasks).all()).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("first carrier purge keeps the identity ledger (budget survives, FK SET NULL)", async () => {
    const { h, seed } = identityFixture();
    try {
      const noteId = seed({ sourceRef: "url-a" });
      await claimAndSucceed(h, noteId, SHA_A);
      h.db.query("UPDATE qq_media_notes SET expires_at=? WHERE id=?").run(PAST, noteId);
      h.db
        .query("UPDATE qq_media_read_tasks SET expires_at=? WHERE media_note_id=?")
        .run(PAST, noteId);
      expect(purgeExpiredMediaNotes(h.orm, "2020-01-01T00:00:01.000000Z")).toBe(1);
      // 载体没了：账本存活，identity/attempts/status 原样（预算不丢、正文随载体去）。
      const ledger = h.orm.select().from(qqMediaReadTasks).all();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.mediaNoteId).toBeNull();
      expect(ledger[0]?.attempts).toBe(1);
      expect(ledger[0]?.status).toBe("succeeded");
      expect(ledger[0]?.identityKey).not.toBeNull();
      // scope 四列仍在账本行上：管理面/诊断可归属。
      expect(ledger[0]?.accountId).toBe("10001");
      expect(ledger[0]?.peerId).toBe("20001");
      expect(ledger[0]?.agentId).toBe(AGENT);
    } finally {
      h.close();
    }
  });

  it("expired succeeded: old body not served, re-claim spends the remaining attempt, old ref invalidated, no 503", async () => {
    const { h, seed } = identityFixture();
    try {
      const noteId = seed({ sourceRef: "url-a" });
      const first = await claimAndSucceed(h, noteId, SHA_A);
      const revisionBefore = first.task.revision;
      h.db
        .query("UPDATE qq_media_read_tasks SET expires_at=? WHERE media_note_id=?")
        .run(PAST, noteId);
      h.db.query("UPDATE qq_media_notes SET expires_at=? WHERE id=?").run(PAST, noteId);
      const second = seed({ sourceRef: "url-b" });
      // 过期槽再 claim：不是 503，花剩余次数 1→2，绝不重置。
      const reclaimed = await attemptMediaReadTask(h.orm, {
        mediaNoteId: second,
        purpose: "baseline",
        modelName: "vision-b",
        policy: "p2",
        relatedSupplementArrived: false,
        assertCurrent: guard,
        contentSha256: SHA_A,
      });
      expect(reclaimed.attempt).toBe(2);
      expect(reclaimed.task.revision).toBeGreaterThan(revisionBefore);
      expect(reclaimed.task.status).toBe("running");
      // 成功的 re-claim 把账本载体重指到本次真实载体（§8.1：账本跟随被消费的载体）。
      expect(reclaimed.task.mediaNoteId).toBe(second);
      // 旧载体行已死窗：账本窗口按当前授权重新推导（载体帽+宿主帽），不回落旧死值。
      expect(Date.parse(reclaimed.task.expiresAt)).toBeGreaterThan(Date.parse(nowIso()));
    } finally {
      h.close();
    }
  });
});

describe("typed media read task identity: legacy association (no network backfill)", () => {
  function legacyFixtureDb() {
    const db = new (require("bun:sqlite").Database)(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of BUSINESS_MIGRATION_FILES.slice(0, 51)) {
      db.exec(readFileSync(path.join(VERSIONS_DIR, name), "utf8"));
    }
    db.exec("PRAGMA user_version = 51");
    db.exec(`INSERT INTO users VALUES ('u1', 'synthetic', '${NOW}')`);
    db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
        p5_config, model_name, memory_consolidation_prompt,
        memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
      VALUES ('${AGENT}', 'synthetic', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
    return db;
  }

  it("legacy attempts stay and identity_key stays NULL until controlled bytes associate in-transaction", () => {
    const db = legacyFixtureDb();
    try {
      db.exec(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES ('ev-lg', '10001', 'group', '20001', '${AGENT}', 'm1', 10, 'member', '30001', '${NOW}')`,
      );
      db.exec(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES ('mn-lg', 'ev-lg', 0, 'image', 'ref-lg', 2, '${EXPIRES}', '${NOW}', '${NOW}')`,
      );
      ensureBusinessSchema(db);
      const row = db
        .query(
          "SELECT attempts, status, identity_key FROM qq_media_read_tasks WHERE media_note_id='mn-lg'",
        )
        .get() as { attempts: number; status: string; identity_key: string | null };
      expect(row).toMatchObject({ attempts: 2, status: "failed", identity_key: null });
    } finally {
      db.close();
    }
  });

  it("same source legacy failure is inherited: associated identity keeps the spent attempts (no regain)", async () => {
    const { h, seed } = identityFixture();
    try {
      // 直接造一行 legacy 形态账本（identity NULL、attempts 2、同 source_ref）。
      const legacy = seed({ sourceRef: "shared-ref" });
      h.db
        .query(
          `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, policy,
            attempts, status, revision, expires_at, recorded_at, account_id, conversation_kind, peer_id, agent_id)
           VALUES ('legacy-x', ?, 'baseline', NULL, 'legacy', 2, 'failed', 1, ?, ?, '10001', 'group', '20001', ?)`,
        )
        .run(legacy, EXPIRES, NOW, AGENT);
      // 受控字节确认同内容（新载体同 source_ref）：关联既有账本（attempts 不减）→ 2 已耗尽。
      const fresh = seed({ sourceRef: "shared-ref" });
      const associated = associateLegacyMediaReadTask(h.orm, {
        mediaNoteId: fresh,
        mediaSegmentKind: "image",
        mediaSourceRef: "shared-ref",
        accountId: "10001",
        conversationKind: "group",
        peerId: "20001",
        agentId: AGENT,
        purpose: "baseline",
        contentSha256: SHA_B,
      });
      expect(associated).not.toBeNull();
      expect(associated?.attempts).toBe(2);
      expect(associated?.identityKey).not.toBeNull();
      expect(associated?.mediaNoteId).toBe(fresh);
      const outcome = await claimReason(h.orm, {
        mediaNoteId: fresh,
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        relatedSupplementArrived: false,
        assertCurrent: guard,
        contentSha256: SHA_B,
      });
      expect("reason" in outcome && outcome.reason).toBe("attempts_exhausted");
      const rows = h.orm.select().from(qqMediaReadTasks).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attempts).toBe(2);
    } finally {
      h.close();
    }
  });

  it("multiple legacy history rows merge saturating min(2, sum of attempts)", async () => {
    const { h, seed } = identityFixture();
    try {
      const l1 = seed({ sourceRef: "shared-ref" });
      const l2 = seed({ sourceRef: "shared-ref" });
      const insertLegacy = (id: string, noteId: string, attempts: number) =>
        h.db
          .query(
            `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, policy,
              attempts, status, revision, expires_at, recorded_at, account_id, conversation_kind, peer_id, agent_id)
             VALUES (?, ?, 'baseline', NULL, 'legacy', ?, 'failed', 1, ?, ?, '10001', 'group', '20001', ?)`,
          )
          .run(id, noteId, attempts, EXPIRES, NOW, AGENT);
      insertLegacy("legacy-1", l1, 1);
      insertLegacy("legacy-2", l2, 1);
      expect(h.orm.select().from(qqMediaReadTasks).all()).toHaveLength(2);
      // 受控字节经同一 source_ref 到达（可证关联的唯一受控身份）：两行历史合并为一条
      // identity 账本，attempts = min(2, 1+1) = 2，不是 max(1,1)=1（那会吞掉一次历史消耗）。
      const fresh = seed({ sourceRef: "shared-ref" });
      const associated = associateLegacyMediaReadTask(h.orm, {
        mediaNoteId: fresh,
        mediaSegmentKind: "image",
        mediaSourceRef: "shared-ref",
        accountId: "10001",
        conversationKind: "group",
        peerId: "20001",
        agentId: AGENT,
        purpose: "baseline",
        contentSha256: SHA_B,
      });
      expect(associated).not.toBeNull();
      expect(associated?.attempts).toBe(2);
      const merged = h.orm.select().from(qqMediaReadTasks).all();
      const identityRows = merged.filter((r) => r.identityKey !== null);
      expect(identityRows).toHaveLength(1);
      expect(identityRows[0]?.attempts).toBe(2);
      // 合并后的预算真实生效：新 claim 立即 exhausted。
      const outcome = await claimReason(h.orm, {
        mediaNoteId: fresh,
        purpose: "baseline",
        modelName: "vision-a",
        policy: "p1",
        relatedSupplementArrived: false,
        assertCurrent: guard,
        contentSha256: SHA_B,
      });
      expect("reason" in outcome && outcome.reason).toBe("attempts_exhausted");
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Reader-level identity bytes discipline (production path).
// ---------------------------------------------------------------------------
const READER_BINDING = "11111111-1111-4111-8111-111111111111";

function readerSetup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "media-task-identity-test" });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: READER_BINDING,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: AGENT,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  new ConversationEventRepository(h.db).ensureOneBot(READER_BINDING);
  let messageId = 700;
  const receiveImage = (sourceRef: string) => {
    messageId += 1;
    const observation = normalizeOneBotMessage(
      {
        time: Math.floor(Date.now() / 1000),
        self_id: 10001,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: messageId,
        user_id: 20002,
        group_id: 30003,
        sender: { nickname: "阿林" },
        message: [{ type: "image", data: { file: sourceRef } }],
      },
      "10001",
    );
    if (observation.kind !== "message") throw new Error("message expected");
    recordObservation(h.orm, observation.observation, AGENT);
    new ConversationEventRepository(h.db).ingestOneBotEvent(
      observation.observation.eventKey,
      READER_BINDING,
    );
    return observation.observation.eventKey;
  };
  return { h, receiveImage };
}

const readerInput = (eventKey: string) =>
  ({
    eventKey,
    segmentIndex: 0,
    purpose: "baseline",
    policy: "test-policy-1",
    modelConfig: { visionModelName: "vision-local", transcriptionModelName: null },
    owner: {
      kind: "qq_binding" as const,
      id: READER_BINDING,
      userId: DEFAULT_USER_ID,
      agentId: AGENT,
    },
    addressedToAssistant: true,
    relatedSupplementArrived: false,
    assertCurrent: () => {},
  }) satisfies QqMediaTaskReadInput;

/** A minimal real PNG (signature + IHDR) the controlled fetch delivers. */
const PNG_STUB_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00,
]);

describe("typed media read task identity: reader bytes discipline", () => {
  it("no live asset and no adapter fetchBytes is an explicit refusal — no task, no attempt", async () => {
    const { h, receiveImage } = readerSetup();
    try {
      const eventKey = receiveImage("upstream-ref-1");
      let readCalls = 0;
      const result = await readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            readCalls += 1;
            return "不该被调到";
          },
        },
        readerInput(eventKey),
      );
      expect(result).toEqual({ kind: "unreadable", reason: "identity_unavailable" });
      expect(readCalls).toBe(0);
      expect(h.orm.select().from(qqMediaReadTasks).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("same bytes different URL rows share one budget through the reader; live asset short-circuits fetch", async () => {
    const { h, receiveImage } = readerSetup();
    try {
      const eventA = receiveImage("url-a");
      const eventB = receiveImage("url-b");
      const fetched: string[] = [];
      const adapter: QqMediaReadAdapter = {
        capabilities: ["image"] as const,
        fetchBytes: async ({ sourceRef }) => {
          fetched.push(sourceRef);
          // A real readable image header (minimal PNG): the reader's header
          // discipline reads the true format/mime from the controlled bytes.
          return { bytes: PNG_STUB_BYTES };
        },
        read: async ({ bytes }) => {
          if (bytes?.join(",") !== PNG_STUB_BYTES.join(","))
            throw new Error("expected prefetched bytes");
          return "橘猫在沙发上";
        },
      };
      const first = await readQqMediaTaskOnce(h.orm, adapter, readerInput(eventA));
      expect(first).toMatchObject({ kind: "described", source: "task", attempt: 1 });
      // 一次下载同时供 sha 与读取。
      expect(fetched).toEqual(["url-a"]);
      const second = await readQqMediaTaskOnce(h.orm, adapter, readerInput(eventB));
      // cross-carrier live-succeeded：服务真实缓存命中（不假成功、不烧尝试）。
      // 第二行（新载体）为确认同内容身份再受控下载一次（防循环的固有代价，
      // recovery design §1.4），随后命中账本缓存不再调视觉。
      expect(second).toMatchObject({ kind: "described", source: "cache", attempt: 1 });
      expect(fetched).toEqual(["url-a", "url-b"]);
      if (second.kind === "described" && first.kind === "described") {
        expect(second.taskId).toBe(first.taskId);
      }
      const rows = h.orm.select().from(qqMediaReadTasks).all();
      expect(rows).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});
