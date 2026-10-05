// T14：媒体 note 到期清理的持有保护（media notes retention protection）。
//
// 到期即不可读的语义在读取面已经成立（sourceAccess 对过期行返回 expired）；物理删除
// 只延迟到没有任何持有者：真实读取任务仍在 running（级联会抹掉 claim token 与已消耗
// 的 attempt）、非终态 run 的 exact 快照按精确 kind/id 引用、或 agent task 未安全
// （非终态 OR 持 running/waiting_approval/unknown 调用，与 TASK_PROTECTION_SQL 同口径）
// 时，purge 与存储管理面的 media_notes 类别都必须保全。管理面 preview 必须零写，
// 计数只报主表真实删除行（DELETE..RETURNING），不计级联任务行。
//
// 负例口径：typed 任务状态是账本真实记录——本测试不伪造 unknown 调用状态，unknown
// 走真实 interrupt 通路；没有精确 kind/id 匹配的 run/task 不能保护任何行。
// 时间线：note 先在窗口内创建/领取任务，随后同一 note 的 expires_at 落到清理时点之前
// （与"媒体在读中途窗口到期"的真实场景一致），再对 `now > expires_at` 跑 purge。

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { textMessage } from "../../src/server/agent/context-engine";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  mediaNoteProtected,
  mediaNoteRow,
  purgeExpiredMediaNotes,
} from "../../src/server/db/qq-media-repository";
import {
  attemptMediaReadTask,
  recordMediaReadTask,
} from "../../src/server/db/qq-media-task-repository";
import {
  qqStorageCleanupExecute,
  qqStorageCleanupPreview,
  qqStorageItemsPage,
} from "../../src/server/db/qq-storage-repository";
import {
  DEFAULT_AGENT_ID,
  ensureDefaults,
  nowIso,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const AGENT = DEFAULT_AGENT_ID;
const now = nowIso();
const later = "2030-01-01T00:00:00.000000Z";
const past = "2020-01-01T00:00:00.000000Z";
/** 清理时点：任何 note 把 expires_at 拨到它之前即视为到期。 */
const sweepAt = "2026-01-01T00:00:00.000000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

/** agent_tasks.conversation_id 有外键：每个用例先建真实绑定 + 会话，返回 conversationId。 */
function bind(h: ReturnType<typeof setup>, bindingId: string): string {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
    )
    .run(bindingId, "10001", "group", "20001", AGENT, now, now);
  const conversation = new ConversationEventRepository(h.db).ensureOneBot(bindingId);
  if (!conversation) throw new Error("binding conversation missing");
  return conversation.id;
}

function seedNote(orm: Orm, id: string, eventKey: string, expiresAt: string = later): void {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey,
      accountId: "10001",
      conversationKind: "group",
      peerId: "20001",
      agentId: AGENT,
      messageId: eventKey,
      occurredAtSeconds: 1_000,
      speakerKind: "member",
      speakerId: "30001",
      recordedAt: now,
    })
    .run();
  orm
    .insert(schema.qqMediaNotes)
    .values({
      id,
      eventKey,
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: `ref-${id}`,
      note: "旧描述",
      noteModel: "fixture-vision",
      attempts: 1,
      addressed: 1,
      expiresAt,
      recordedAt: now,
      updatedAt: now,
    })
    .run();
}

/** 让一条已建好任务的 note 真实到期（模拟在读中途窗口到期）。 */
function expire(orm: Orm, id: string): void {
  orm
    .update(schema.qqMediaNotes)
    .set({ expiresAt: past })
    .where(eq(schema.qqMediaNotes.id, id))
    .run();
}

async function claimRunning(orm: Orm, noteId: string): Promise<string> {
  recordMediaReadTask(orm, {
    mediaNoteId: noteId,
    contentSha256: shaOfMedia("noteId"),
    purpose: "baseline",
    policy: "baseline",
    expiresAt: later,
    at: now,
  });
  const claim = await attemptMediaReadTask(orm, {
    mediaNoteId: noteId,
    contentSha256: shaOfMedia("noteId"),
    purpose: "baseline",
    policy: "baseline",
    assertCurrent: () => {},
    at: now,
  });
  return claim.claimToken;
}

/** Per-media deterministic controlled-bytes sha: distinct media rows are distinct
 * content identities; the same row keeps the same identity across claims. */
const shaOfMedia = (id: string): string =>
  Array.from(id)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

describe("media note retention protection", () => {
  it("keeps an expired note while a real read task is running, keeping attempt and token, then releases it", async () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-run", "ev-run");
      const claim = await claimRunning(h.orm, "mn-run");
      expect(claim).toBeTruthy();
      expire(h.orm, "mn-run");
      const beforeTask = h.db
        .query("SELECT * FROM qq_media_read_tasks WHERE media_note_id='mn-run'")
        .get() as Record<string, unknown>;

      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(0);

      // note 与任务整行原样在：claim token 依赖的 revision 与已消耗 attempt 都未被抹。
      expect(mediaNoteRow(h.orm, "ev-run", 0)).not.toBeNull();
      const afterTask = h.db
        .query("SELECT * FROM qq_media_read_tasks WHERE media_note_id='mn-run'")
        .get() as Record<string, unknown>;
      for (const key of Object.keys(beforeTask)) expect(afterTask[key]).toBe(beforeTask[key]);

      // 任务离开 running（真实失败通路）后，同一行照常清理。
      h.db
        .query("UPDATE qq_media_read_tasks SET status='failed' WHERE media_note_id='mn-run'")
        .run();
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(1);
      expect(mediaNoteRow(h.orm, "ev-run", 0)).toBeNull();
      // 载体列 SET NULL：note 走后任务账本存活（identity/attempts/状态保留，预算不丢）——
      // 但计数只报主表 1 行（任务行不是 media_notes 类别的主行）。
      const ledgerAfter = h.db
        .query("SELECT media_note_id, attempts, status FROM qq_media_read_tasks")
        .get() as { media_note_id: string | null; attempts: number; status: string } | undefined;
      expect(ledgerAfter).toMatchObject({ media_note_id: null, attempts: 1, status: "failed" });
    } finally {
      h.close();
    }
  });

  it("keeps the note while a nonterminal run's exact snapshot references it by exact kind/id", () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-snap", "ev-snap");
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-mn-snap",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: "conv-mn-snap" },
        at: now,
      });
      const ref: SourceRef = { kind: "qq_media", id: "mn-snap", revision: "1", expiresAt: later };
      runs.startStep({
        runId: "run-mn-snap",
        stepId: "step-mn-snap",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "描述这张图")],
        sources: [ref],
      });
      expire(h.orm, "mn-snap");

      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(0);
      expect(mediaNoteRow(h.orm, "ev-snap", 0)).not.toBeNull();

      // run 终态后引用不再在用：照常删除。
      runs.setStatus("run-mn-snap", "completed", now);
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(1);
      expect(mediaNoteRow(h.orm, "ev-snap", 0)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the note through a qq_media_read_task ref joined back to the exact row", () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-taskref", "ev-taskref");
      const created = recordMediaReadTask(h.orm, {
        mediaNoteId: "mn-taskref",
        contentSha256: shaOfMedia("mn-taskref"),
        purpose: "baseline",
        policy: "baseline",
        expiresAt: later,
        at: now,
      });
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-mn-taskref",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: "conv-mn-taskref" },
        at: now,
      });
      runs.startStep({
        runId: "run-mn-taskref",
        stepId: "step-mn-taskref",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "任务结果引用")],
        sources: [
          {
            kind: "qq_media_read_task",
            id: created.task.id,
            revision: "1",
            expiresAt: later,
          },
        ],
      });
      expire(h.orm, "mn-taskref");

      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(0);
      expect(mediaNoteRow(h.orm, "ev-taskref", 0)).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("does not let a run holding no exact reference protect the row", () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-noref", "ev-noref");
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-mn-noref",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: "conv-mn-noref" },
        at: now,
      });
      // 非终态 run 的快照引用另一条 id：精确 kind/id 不匹配，不得保护；
      // 也覆盖"未知的 kind"与"伪造 typed id 不回流"两个负例面。
      runs.startStep({
        runId: "run-mn-noref",
        stepId: "step-mn-noref",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "无关引用")],
        sources: [
          { kind: "qq_media", id: "mn-other", revision: "1", expiresAt: later },
          { kind: "something_else", id: "mn-noref", revision: "1", expiresAt: later },
        ],
      });
      expire(h.orm, "mn-noref");
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(1);
      expect(mediaNoteRow(h.orm, "ev-noref", 0)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the note while an unsafe agent task's sources reference it, releases on settle", () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-task", "ev-task");
      const conversationId = bind(h, "bd-mn-task");
      const tasks = new AgentTaskRepository(h.db);
      const task = tasks.enqueue({
        conversationId,
        agentId: AGENT,
        dedupeKey: "task-mn-task",
        sources: [{ kind: "qq_media_note", id: "mn-task", revision: "1", expiresAt: later }],
        at: now,
        expiresAt: later,
        calls: [],
      });
      expire(h.orm, "mn-task");
      // 非终态任务即不安全。
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(0);
      expect(mediaNoteRow(h.orm, "ev-task", 0)).not.toBeNull();

      // 终态且无 running/waiting_approval/unknown 调用 → 不再保全。
      tasks.settle(task.id, "completed", now);
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(1);
      expect(mediaNoteRow(h.orm, "ev-task", 0)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the note while a terminal task still holds an unknown call (real interrupt path)", () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-unknown", "ev-unknown");
      const conversationId = bind(h, "bd-mn-unknown");
      const tasks = new AgentTaskRepository(h.db);
      const task = tasks.enqueue({
        conversationId,
        agentId: AGENT,
        dedupeKey: "task-mn-unknown",
        sources: [{ kind: "qq_media", id: "mn-unknown", revision: "1", expiresAt: later }],
        at: now,
        expiresAt: later,
        calls: [{ name: "fixture.write", revision: "1", effect: "write", arguments: {} }],
      });
      const claimed = tasks.claim(now, 60000);
      if (!claimed || claimed.id !== task.id || !claimed.leaseToken)
        throw new Error("task not claimed");
      tasks.beginCall(task.id, claimed.leaseToken, 0, now);
      tasks.interrupt(task.id, now, "failed", "TASK_OUTCOME_UNKNOWN");
      tasks.interrupt(task.id, now, "failed", "TASK_EXPIRED");
      const settled = tasks.get(task.id);
      expect(settled?.status).toBe("failed");
      expect(settled?.calls[0]?.status).toBe("unknown");
      expire(h.orm, "mn-unknown");

      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(0);
      expect(mediaNoteRow(h.orm, "ev-unknown", 0)).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("deletes an unrelated expired note while a protected note survives beside it", async () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-held", "ev-held");
      seedNote(h.orm, "mn-free", "ev-free");
      await claimRunning(h.orm, "mn-held");
      expire(h.orm, "mn-held");
      expire(h.orm, "mn-free");
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(1);
      expect(mediaNoteRow(h.orm, "ev-held", 0)).not.toBeNull();
      expect(mediaNoteRow(h.orm, "ev-free", 0)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("counts 0 on an empty sweep and returns each row exactly once", () => {
    const h = setup();
    try {
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(0);
      seedNote(h.orm, "mn-once", "ev-once", past);
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(1);
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("the storage management media_notes category shares the same predicate: protected flag, preview zero-writes, removable == removed", async () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-protected", "ev-protected");
      seedNote(h.orm, "mn-loose", "ev-loose");
      await claimRunning(h.orm, "mn-protected");
      expire(h.orm, "mn-protected");
      expire(h.orm, "mn-loose");

      // preview 零写基线：物理行快照。
      const beforeRows = h.db.query("SELECT * FROM qq_media_notes ORDER BY id").all();
      const beforeTasks = h.db.query("SELECT * FROM qq_media_read_tasks ORDER BY id").all();

      // 谓词纯函数：同一事实在任意别名下答案一致（列表 t / 删除表名 / 任意 q）。
      const heldList = h.db
        .query(
          `SELECT CASE WHEN ${mediaNoteProtected("t")} THEN 1 ELSE 0 END AS p
           FROM qq_media_notes t WHERE t.id='mn-protected'`,
        )
        .get() as { p: number };
      const heldTable = h.db
        .query(
          `SELECT CASE WHEN ${mediaNoteProtected("qq_media_notes")} THEN 1 ELSE 0 END AS p
           FROM qq_media_notes WHERE id='mn-protected'`,
        )
        .get() as { p: number };
      const loose = h.db
        .query(
          `SELECT CASE WHEN ${mediaNoteProtected("t")} THEN 1 ELSE 0 END AS p
           FROM qq_media_notes t WHERE t.id='mn-loose'`,
        )
        .get() as { p: number };
      expect(heldList.p).toBe(1);
      expect(heldTable.p).toBe(1);
      expect(loose.p).toBe(0);

      const preview = qqStorageCleanupPreview(h.orm, { category: "media_notes" }, sweepAt);
      // 脸 = 两条 note + 一条 read-task（任务窗口跟随载体 later，未到清理时点 → 不进
      // expired/protected 计数）；两条 note 里 protected 的是 held 行。
      expect(preview.matched).toBe(3);
      expect(preview.expired).toBe(2);
      expect(preview.protected).toBe(1);
      expect(preview.removable).toBe(1);

      // preview 零写：物理行与快照完全一致。
      expect(h.db.query("SELECT * FROM qq_media_notes ORDER BY id").all()).toEqual(beforeRows);
      expect(h.db.query("SELECT * FROM qq_media_read_tasks ORDER BY id").all()).toEqual(
        beforeTasks,
      );

      // 执行走同一谓词的主行计数（RETURNING）：removable == removed == 1，级联任务行不进计数。
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(1);
      expect(mediaNoteRow(h.orm, "ev-protected", 0)).not.toBeNull();
      expect(mediaNoteRow(h.orm, "ev-loose", 0)).toBeNull();
      expect(
        (h.db.query("SELECT COUNT(*) AS n FROM qq_media_read_tasks").get() as { n: number }).n,
      ).toBe(1);
    } finally {
      h.close();
    }
  });

  it("protected expired notes stay unreadable: the row is present but its window has passed", async () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-unread", "ev-unread");
      await claimRunning(h.orm, "mn-unread");
      expire(h.orm, "mn-unread");
      expect(purgeExpiredMediaNotes(h.orm, sweepAt)).toBe(0);
      // 保护不复活读取：行在，但 expires_at 已过（读取面对该行返回 expired，不是 available）。
      const row = mediaNoteRow(h.orm, "ev-unread", 0);
      expect(row).not.toBeNull();
      expect(row ? row.expiresAt <= sweepAt : false).toBe(true);
    } finally {
      h.close();
    }
  });

  it("lists expired media notes with the protected flag true only for the held row, in both status filters", async () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-list-held", "ev-list-held");
      seedNote(h.orm, "mn-list-free", "ev-list-free");
      await claimRunning(h.orm, "mn-list-held");
      expire(h.orm, "mn-list-held");
      expire(h.orm, "mn-list-free");

      // expired 过滤：任务窗口跟随载体（2030，未到期）→ 只有两条 note；all 过滤：三条。
      const expiredPage = qqStorageItemsPage(
        h.orm,
        { category: "media_notes", status: "expired", limit: 100 },
        sweepAt,
      );
      expect(expiredPage.total).toBe(2);
      const allPage = qqStorageItemsPage(
        h.orm,
        { category: "media_notes", status: "all", limit: 100 },
        sweepAt,
      );
      expect(allPage.total).toBe(3);
      const flags = Object.fromEntries(allPage.items.map((item) => [item.id, item.protected]));
      expect(flags["mn-list-held"]).toBe(true);
      expect(flags["mn-list-free"]).toBe(false);
      expect(Object.keys(flags).some((id) => id.startsWith("read-task:"))).toBe(true);
      expect(Object.keys(flags)).toHaveLength(3);
      // live 过滤：两条 note 已到期不出现；read-task 行窗口跟随载体（2030）→ live 1 条。
      expect(
        qqStorageItemsPage(h.orm, { category: "media_notes", status: "live", limit: 100 }, sweepAt)
          .total,
      ).toBe(1);
    } finally {
      h.close();
    }
  });

  it("the category execute keeps the protected note and removes exactly the removable one, with fixture rows untouched", async () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-exe-held", "ev-exe-held");
      seedNote(h.orm, "mn-exe-free", "ev-exe-free");
      await claimRunning(h.orm, "mn-exe-held");
      expire(h.orm, "mn-exe-held");
      expire(h.orm, "mn-exe-free");
      const beforeTask = h.db
        .query("SELECT * FROM qq_media_read_tasks WHERE media_note_id='mn-exe-held'")
        .get() as Record<string, unknown>;

      const preview = qqStorageCleanupPreview(h.orm, { category: "media_notes" }, sweepAt);
      // 脸 = 两条 note + 一条 read-task；任务窗口跟随载体（2030）不进 expired 计数。
      expect(preview).toEqual({
        matched: 3,
        expired: 2,
        protected: 1,
        removable: 1,
      });
      expect(h.db.query("SELECT * FROM qq_media_notes ORDER BY id").all()).toHaveLength(2);

      const execution = qqStorageCleanupExecute(h.orm, { category: "media_notes" }, sweepAt);
      expect(execution.removed).toBe(1);
      expect(execution.counts.removable).toBe(1);
      expect(execution.counts.protected).toBe(1);

      // 保护行与它的任务整行原值不变（note/task/token/attempt/revision 都在）。
      expect(mediaNoteRow(h.orm, "ev-exe-held", 0)).not.toBeNull();
      const afterTask = h.db
        .query("SELECT * FROM qq_media_read_tasks WHERE media_note_id='mn-exe-held'")
        .get() as Record<string, unknown>;
      expect(afterTask).toEqual(beforeTask);
      // 无关行真实删除。
      expect(mediaNoteRow(h.orm, "ev-exe-free", 0)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("execute by ids: protected-only removes nothing, unprotected-only removes one, empty ids match nothing, unknown id removes nothing", async () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-id-held", "ev-id-held");
      seedNote(h.orm, "mn-id-free", "ev-id-free");
      await claimRunning(h.orm, "mn-id-held");
      expire(h.orm, "mn-id-held");
      expire(h.orm, "mn-id-free");

      const beforeRows = () => h.db.query("SELECT * FROM qq_media_notes ORDER BY id").all();
      const baseline = beforeRows();

      // 仅选中保护行：removed 0，两行原样在。
      const protectedOnly = qqStorageCleanupExecute(
        h.orm,
        { category: "media_notes", ids: ["mn-id-held"] },
        sweepAt,
      );
      expect(protectedOnly.counts.removable).toBe(0);
      expect(protectedOnly.removed).toBe(0);
      expect(beforeRows()).toEqual(baseline);

      // 仅选中未保护行：删 1。
      const freeOnly = qqStorageCleanupExecute(
        h.orm,
        { category: "media_notes", ids: ["mn-id-free"] },
        sweepAt,
      );
      expect(freeOnly.counts.removable).toBe(1);
      expect(freeOnly.removed).toBe(1);
      expect(mediaNoteRow(h.orm, "ev-id-free", 0)).toBeNull();
      expect(mediaNoteRow(h.orm, "ev-id-held", 0)).not.toBeNull();

      // 空数组 fail-closed：matched 0 / removable 0 / removed 0，剩余行不动。
      const emptyIds = qqStorageCleanupExecute(
        h.orm,
        { category: "media_notes", ids: [] },
        sweepAt,
      );
      expect(emptyIds.counts.matched).toBe(0);
      expect(emptyIds.counts.removable).toBe(0);
      expect(emptyIds.removed).toBe(0);
      const afterEmpty = beforeRows();
      expect(afterEmpty).toHaveLength(1);
      expect(afterEmpty).toEqual(beforeRows());

      // 未知 id：matched 0，removed 0，剩余行不动。
      const unknownId = qqStorageCleanupExecute(
        h.orm,
        { category: "media_notes", ids: ["mn-nope"] },
        sweepAt,
      );
      expect(unknownId.counts.matched).toBe(0);
      expect(unknownId.removed).toBe(0);
      expect(beforeRows()).toEqual(afterEmpty);
    } finally {
      h.close();
    }
  });

  it("after the running task releases, the category execute removes the main row once and does not count its cascaded task", async () => {
    const h = setup();
    try {
      seedNote(h.orm, "mn-exe-run", "ev-exe-run");
      await claimRunning(h.orm, "mn-exe-run");
      expire(h.orm, "mn-exe-run");

      // running 时 execute 不删（同谓词）。
      expect(qqStorageCleanupExecute(h.orm, { category: "media_notes" }, sweepAt).removed).toBe(0);
      expect(mediaNoteRow(h.orm, "ev-exe-run", 0)).not.toBeNull();

      // 真实失败通路释放 running，execute 删主行恰好 1 次。
      h.db
        .query("UPDATE qq_media_read_tasks SET status='failed' WHERE media_note_id='mn-exe-run'")
        .run();
      const execution = qqStorageCleanupExecute(h.orm, { category: "media_notes" }, sweepAt);
      expect(execution.counts.removable).toBe(1);
      expect(execution.removed).toBe(1);
      expect(mediaNoteRow(h.orm, "ev-exe-run", 0)).toBeNull();
      // 载体列 SET NULL：主行走后任务账本存活（预算不随载体清理消失）。
      const ledgerRow = h.db.query("SELECT media_note_id, status FROM qq_media_read_tasks").get() as
        | { media_note_id: string | null; status: string }
        | undefined;
      expect(ledgerRow).toMatchObject({ media_note_id: null, status: "failed" });
      expect(qqStorageCleanupExecute(h.orm, { category: "media_notes" }, sweepAt).removed).toBe(0);
    } finally {
      h.close();
    }
  });
});
