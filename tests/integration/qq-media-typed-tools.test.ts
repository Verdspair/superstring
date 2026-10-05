// T08 typed 媒体工具闭环（t08-typed-tools-finish2）：typed 账本是描述元数据的唯一真值。
//
// 这里钉的是 typed 语义的宿主边界：
//  * list 的 described/attempts 只来自 typed baseline 任务按"当前有效结果"的匹配
//    （当前 adapter 实际会选的模型 + 冻结策略串；legacy 迁移任务按其已验规则只认同
//    模型），不读 legacy note/旧 attempts 作真值；legacy 任务缺失但旧计数 >0 时绝不
//    显示重置（attempts 保留旧账兜底，不冒充 0）。
//  * describe 的两个缓存出口走已验 readQqMediaTaskOnce 权威 cache 路径：prior run
//    memo 不能把换模型/换策略后的缓存不匹配变成成功；fit 期间 source/任务被改也要
//    末验拒绝。
//  * note.read 只出示当前有效的结果：匹配当前 model/policy 的正文（legacy 已验规则）
//    才给，且 typed 来源真实 mint。
//  * 第二次尝试的补充证明基准＝claim 事务里现读的任务 lastAttemptAt（真实"第 N 次
//    已消耗尝试"时刻）：早于/等于尝试时刻的补充拒、真正更晚的允许 exact attempt 2、
//    lastAttemptAt NULL/NaN 的已消耗任务 fail closed。
//  * policyRevision 是真实策略修订：宿主传入的实际形状串进入 typed 任务的 policy 匹配，
//    换参数后旧缓存不匹配但已消耗的尝试不重置（任务身份不含模型/策略）。

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { ActionContext, BuiltInAction } from "../../src/server/agent/built-in-actions";
import { assertContextSources } from "../../src/server/agent/context-access";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readBindingByConversation } from "../../src/server/db/qq-binding-repository";
import {
  linkMediaAssetSource,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import { mediaNoteRow, recordMediaSegment } from "../../src/server/db/qq-media-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { readQqSettings, updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_USER_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { fail } from "../../src/server/errors";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import {
  createQqMediaTools,
  type QqMediaToolsOptions,
} from "../../src/server/services/qq-media-tools";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const ACCOUNT = "10001";
const PEER = "30003";
const AGENT = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const POLICY = "baseline/v1/test-policy";

/**
 * 受控合法 PNG 字节：按 sha(kind+sourceRef) 生成真实 RGBA 像素——同一 ref 永远同字节
 * （身份稳定），不同 ref 字节不同（绝不误判同内容）。头部经真实 readQqImageHeader 校验。
 */
function pngBytesFor(kind: string, sourceRef: string): Uint8Array {
  const seed = createHash("sha256").update(`test-bytes:${kind}:${sourceRef}`).digest();
  const pixels = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = seed[i % seed.length] ?? 0;
  return encodeQqFramePng(pixels, 2, 2);
}

const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
});

function expectOkPage(value: unknown): { items: MediaListItem[]; nextCursor: string | null } {
  const page = value as ListValue;
  if (page.status !== "ok") throw new Error(`expected an ok list, got ${JSON.stringify(page)}`);
  return page;
}
interface MediaListItem {
  id: string;
  eventKey: string;
  index: number;
  kind: "image";
  described: boolean;
  attempts: number;
}
type ListValue =
  | { status: "ok"; items: MediaListItem[]; nextCursor: string | null }
  | { status: "unavailable"; code: string };
type NoteReadValue =
  | {
      status: "ok";
      id: string;
      model: string;
      text: string;
      offset: number;
      nextOffset: number | null;
    }
  | { status: "undescribed"; id: string; attempts: number }
  | { status: "unavailable"; code: string };
type DescribeValue =
  | { status: "described"; described: true; attempt: number }
  | { status: "failed"; described: false; attempt: number; awaitSupplement: boolean }
  | { status: "unavailable"; code: string };

/** 把工具交出的引用按宿主消费路径（context-access）复验一遍。 */
function expectSourcesValid(
  h: ReturnType<typeof openBusinessDb>,
  conversationId: string,
  sources: readonly SourceRef[],
): void {
  assertContextSources({
    db: h.db,
    sources,
    owner: {
      kind: "conversation",
      id: conversationId,
      userId: DEFAULT_USER_ID,
      agentId: AGENT,
    },
    now: nowIso(),
    memoryRevisions: () => new Map(),
    messages: { memory: "memory changed", other: "source changed" },
  });
}

function open() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "qq-media-typed-tools-test" });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: BINDING_ID,
      accountId: ACCOUNT,
      conversationKind: "group",
      peerId: PEER,
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
  const binding = readBindingByConversation(h.orm, {
    accountId: ACCOUNT,
    kind: "group",
    peerId: PEER,
  });
  if (!binding) throw new Error("binding fixture missing");
  // 夹具外的函数体（message/image/mount/context）不继承这里的 throw 收窄，所以把
  // 已收窄的值另存为 const 供闭包引用（与 qq-media-identity-tools 的夹具同形状）。
  const wired = binding;
  const journal = new ConversationEventRepository(h.db);
  const opened = journal.ensureOneBot(wired.id);
  if (!opened) throw new Error("conversation fixture missing");
  const conversation = opened;
  const baseSeconds = Math.floor(Date.now() / 1000);

  /** 一条已进 journal 的群消息（可披露；默认 @）。 */
  function message(
    eventKey: string,
    input: { at?: number; reasons?: readonly ("mention" | "reply_to_agent")[] } = {},
  ): void {
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        messageId: `message-${eventKey}`,
        occurredAtSeconds: input.at ?? baseSeconds,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: nowIso(),
      })
      .run();
    const reasons = input.reasons ?? ["mention"];
    // 传给 ingest 的是可变数组：fixture 的入参标注是 readonly（类型层复制，不改业务值）。
    journal.ingestOneBotEvent(eventKey, wired.id, { reasons: [...reasons], mentionIds: [] });
  }

  /** 一条带图片的消息：默认进 journal 且时间线携带 qq_media 引用（可披露）。 */
  function image(
    eventKey: string,
    input: { at?: number; sourceRef?: string; hidden?: boolean } = {},
  ): NonNullable<ReturnType<typeof mediaNoteRow>> {
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        messageId: `message-${eventKey}`,
        occurredAtSeconds: input.at ?? baseSeconds,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: nowIso(),
      })
      .run();
    recordMediaSegment(h.orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef: input.sourceRef ?? `ref-${eventKey}`,
      occurredAtSeconds: input.at ?? baseSeconds,
      addressed: true,
    });
    // 与生产 observation-intake 同序：媒体行先落库，journal 摄入时把 qq_media 引用写进
    // 时间线（typed 来源复验依赖这条事实）。
    if (!input.hidden)
      journal.ingestOneBotEvent(eventKey, wired.id, { reasons: ["mention"], mentionIds: [] });
    const row = mediaNoteRow(h.orm, eventKey, 0);
    if (!row) throw new Error("media fixture missing");
    return row;
  }

  function mount(
    input: {
      read?: (input: { kind: string; sourceRef: string }) => Promise<string>;
      fit?: QqMediaToolsOptions["fit"];
      modelConfig?: QqMediaToolsOptions["modelConfig"];
      policyRevision?: string;
      resolveQuestion?: QqMediaToolsOptions["resolveQuestion"];
    } = {},
  ) {
    const stats = { calls: 0, described: [] as { eventKey: string; taskId: string }[] };
    const actions = createQqMediaTools({
      db: h.db,
      orm: h.orm,
      conversationId: conversation.id,
      binding: wired,
      adapter: {
        capabilities: ["image"] as const,
        // The reader's identity discipline needs controlled bytes: the test
        // adapter derives them deterministically from the source ref (same
        // ref = same bytes = same identity), exactly one download per read.
        fetchBytes: async (request) => ({
          bytes: pngBytesFor(request.kind, request.sourceRef),
        }),
        read: async (request) => {
          stats.calls++;
          return (input.read ?? (async () => "橘猫"))(request);
        },
      },
      modelConfig: input.modelConfig ?? {
        visionModelName: "vision-local",
        transcriptionModelName: null,
      },
      supplementWindowMinutes: 30,
      // 冻结进任务的完整策略串＝形状前缀 + 宿主修订；POLICY 断言的是冻结后的整串。
      policyRevision: input.policyRevision ?? "test-policy",
      assertCurrent: () => {},
      fit: input.fit ?? (async () => () => true),
      evidence: { db: h.db, orm: h.orm },
      onDescribed: (eventKey, actualTaskId) => {
        stats.described.push({ eventKey, taskId: actualTaskId });
      },
      ...(input.resolveQuestion === undefined ? {} : { resolveQuestion: input.resolveQuestion }),
    });
    const named = (name: string): BuiltInAction => {
      const action = actions.find((entry) => entry.description.name === name);
      if (!action) throw new Error(`missing action ${name}`);
      return action;
    };
    return {
      actions,
      stats,
      named,
      execute: (name: string, arguments_: Record<string, unknown>, ctx: ActionContext) =>
        named(name).execute(arguments_, ctx),
      release: (ctx: Pick<ActionContext, "owner" | "runId">) => {
        for (const action of actions) action.release?.(ctx);
      },
    };
  }

  function context(runId = "run-1", owner: Partial<ActionContext["owner"]> = {}) {
    const controller = new AbortController();
    controllers.push(controller);
    const ctx: ActionContext = {
      owner: {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: AGENT,
        ...owner,
      },
      runId,
      signal: controller.signal,
    };
    return { controller, ctx };
  }

  return {
    h,
    binding,
    conversation,
    baseSeconds,
    message,
    image,
    journal,
    mount,
    context,
  };
}

describe("typed QQ media tools (t08 finish2)", () => {
  it("list metadata comes from the typed task, not the legacy note", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount({ read: async () => "橘猫" });
      const { ctx } = f.context();
      const before = expectOkPage((await tool.execute("media.list", {}, ctx)).value);
      expect(before.items).toEqual([
        {
          id: img.id,
          eventKey: "img-1",
          index: 0,
          kind: "image",
          described: false,
          attempts: 0,
        },
      ]);
      await tool.execute("media.describe", { id: img.id }, ctx);
      const after = expectOkPage((await tool.execute("media.list", {}, ctx)).value);
      expect(after.items[0]).toMatchObject({ described: true, attempts: 1 });
      // typed 成功不回写 legacy note：媒体行旧账保持 note=null/attempts=0——
      // described:true 只可能来自 typed 任务真值。
      expect(mediaNoteRow(f.h.orm, "img-1", 0)).toMatchObject({ note: null, attempts: 0 });
      expectSourcesValid(f.h, f.conversation.id, []);
      expect(tool.stats.described).toEqual([{ eventKey: "img-1", taskId: expect.any(String) }]);
      const taskId = tool.stats.described[0]?.taskId ?? "";
      const task = f.h.db.query("SELECT * FROM qq_media_read_tasks WHERE id=?").get(taskId) as {
        policy: string;
        model_name: string;
        attempts: number;
      };
      expect(task).toMatchObject({ policy: POLICY, model_name: "vision-local", attempts: 1 });
    } finally {
      f.h.close();
    }
  });

  it("list never displays a reset when the baseline task is missing but legacy attempts exist", async () => {
    const f = open();
    try {
      // 0052 之外的真实形态：旧账本消耗过但没有 baseline 任务（账本被改）。
      const img = f.image("img-1");
      f.h.orm
        .update(schema.qqMediaNotes)
        .set({ attempts: 2 })
        .where(eq_(schema.qqMediaNotes.id, img.id))
        .run();
      const tool = f.mount();
      const { ctx } = f.context();
      const page = expectOkPage((await tool.execute("media.list", {}, ctx)).value);
      // 绝不显示 attempts:0（那会伪装成还能再来两次的重置）。
      expect(page.items[0]).toMatchObject({ described: false, attempts: 2 });
      expect(tool.stats.calls).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("a prior run memo cannot turn a model/policy cache mismatch into success", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount({ read: async () => "橘猫" });
      const run1 = f.context("run-memo");
      await tool.execute("media.list", {}, run1.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run1.ctx)).value).toEqual({
        status: "described",
        described: true,
        attempt: 1,
      });
      // 新 run、换策略：任务身份不含策略，尝试保留；缓存对当前策略不匹配＝不可服务，
      // 绝不因任何 prior memo 显示成功，也绝不为不匹配再烧尝试。
      const run2 = f.context("run-after-policy");
      const tool2 = f.mount({
        policyRevision: "baseline/v1/other-shape",
        read: async () => "新猫",
      });
      // 披露表 per 工具实例：换实例后必须先由本实例 list 披露，describe 才进缓存判定。
      await tool2.execute("media.list", {}, run2.ctx);
      const result = (await tool2.execute("media.describe", { id: img.id }, run2.ctx))
        .value as DescribeValue;
      expect(result).toEqual({ status: "unavailable", code: "cache_mismatch" });
      expect(tool2.stats.calls).toBe(0);
      const task = f.h.db
        .query("SELECT attempts,status FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(img.id) as { attempts: number; status: string };
      expect(task).toMatchObject({ attempts: 1, status: "succeeded" });
    } finally {
      f.h.close();
    }
  });

  it("note.read serves only the currently valid result and mints real typed sources", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount({ read: async () => "甲乙丙丁" });
      const { ctx } = f.context();
      await tool.execute("media.list", {}, ctx);
      await tool.execute("media.describe", { id: img.id }, ctx);
      const read = (await tool.execute("media.note.read", { id: img.id }, ctx))
        .value as NoteReadValue;
      expect(read).toMatchObject({
        status: "ok",
        id: img.id,
        model: "vision-local",
        text: "甲乙丙丁",
        offset: 0,
        nextOffset: null,
      });
      const sources = (await tool.execute("media.note.read", { id: img.id }, ctx))
        .sources as SourceRef[];
      expect(sources).toHaveLength(1);
      // 传入副本断言：toMatchObject + expect.any 会原地改写 received（id 被写成 {}），
      // 后续按宿主路径复验必须拿原始引用。
      expect({ ...sources[0] }).toMatchObject({
        kind: "qq_media_read_task",
        id: expect.any(String),
      });
      expectSourcesValid(f.h, f.conversation.id, sources);
      // 换模型后旧结果对当前配置不可服务：明确拒绝，不给旧正文、不归零尝试。
      // （新实例先自己 list 披露，再走 note.read 的缓存判定。）
      const other = f.mount({
        modelConfig: { visionModelName: "vision-other", transcriptionModelName: null },
      });
      await other.execute("media.list", {}, ctx);
      const mismatch = (await other.execute("media.note.read", { id: img.id }, ctx))
        .value as NoteReadValue;
      expect(mismatch).toEqual({ status: "unavailable", code: "cache_mismatch" });
      expect(other.stats.calls).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("supplement proof: equal-or-earlier refuses, genuinely later allows exact attempt 2", async () => {
    const f = open();
    try {
      const img = f.image("img-1", { at: f.baseSeconds - 120 });
      const tool = f.mount({
        read: async () => {
          throw new Error("synthetic vision failure");
        },
      });
      const run1 = f.context("run-1");
      await tool.execute("media.list", {}, run1.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run1.ctx)).value).toEqual({
        status: "failed",
        described: false,
        attempt: 1,
        awaitSupplement: true,
      });
      const claimedAt = (
        f.h.db
          .query("SELECT last_attempt_at FROM qq_media_read_tasks WHERE media_note_id=?")
          .get(img.id) as { last_attempt_at: string }
      ).last_attempt_at;
      expect(claimedAt).toBeString();

      // 补充等于尝试时刻（严格 > 才算更晚）：拒。
      const claimedSeconds = Math.floor(Date.parse(claimedAt) / 1000);
      f.message("supp-equal", { at: claimedSeconds, reasons: ["mention"] });
      const run2 = f.context("run-2");
      await tool.execute("media.list", {}, run2.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run2.ctx)).value).toEqual({
        status: "unavailable",
        code: "awaiting_supplement",
      });
      expect(tool.stats.calls).toBe(1);

      // 创建早于尝试的"补充"（在 claim 之前的旧消息）：拒——创建与 claim 之间的漂移
      // 不得让旧消息授权新尝试。
      f.message("supp-stale", { at: f.baseSeconds - 60, reasons: ["mention"] });
      const run3 = f.context("run-3");
      await tool.execute("media.list", {}, run3.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run3.ctx)).value).toEqual({
        status: "unavailable",
        code: "awaiting_supplement",
      });
      expect(tool.stats.calls).toBe(1);

      // 真正更晚、在窗口内的 @ 补充：允许 exact attempt 2。
      f.message("supp-fresh", { at: f.baseSeconds + 120, reasons: ["mention"] });
      const run4 = f.context("run-4");
      await tool.execute("media.list", {}, run4.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run4.ctx)).value).toEqual({
        status: "failed",
        described: false,
        attempt: 2,
        awaitSupplement: false,
      });
      expect(tool.stats.calls).toBe(2);
      const task = f.h.db
        .query(
          "SELECT attempts,status,last_attempt_at FROM qq_media_read_tasks WHERE media_note_id=?",
        )
        .get(img.id) as { attempts: number; status: string; last_attempt_at: string };
      expect(task).toMatchObject({ attempts: 2, status: "failed" });
      expect(Date.parse(task.last_attempt_at)).toBeGreaterThan(Date.parse(claimedAt));
    } finally {
      f.h.close();
    }
  });

  it("a consumed task with a NULL lastAttemptAt stays fail closed", async () => {
    const f = open();
    try {
      const img = f.image("img-1", { at: f.baseSeconds - 120 });
      const tool = f.mount({
        read: async () => {
          throw new Error("synthetic vision failure");
        },
      });
      const run1 = f.context("run-1");
      await tool.execute("media.list", {}, run1.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run1.ctx)).value).toMatchObject({
        status: "failed",
        attempt: 1,
      });
      // 直接抹掉 lastAttemptAt：claim 打点不可信＝证明基准缺失，fail closed。
      f.h.db
        .query("UPDATE qq_media_read_tasks SET last_attempt_at=NULL WHERE media_note_id=?")
        .run(img.id);
      f.message("supp-later", { at: f.baseSeconds + 120, reasons: ["mention"] });
      const run2 = f.context("run-2");
      await tool.execute("media.list", {}, run2.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run2.ctx)).value).toEqual({
        status: "unavailable",
        code: "awaiting_supplement",
      });
      expect(tool.stats.calls).toBe(1);
    } finally {
      f.h.close();
    }
  });

  it("budget exhaustion before the claim spends nothing and a same-run failure does not immediately retry", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      let allowed = false;
      const tool = f.mount({
        read: async () => {
          throw new Error("synthetic vision failure");
        },
        fit: async (name) => (name === "media.describe" ? () => allowed : () => true),
      });
      const { ctx } = f.context("run-budget");
      await tool.execute("media.list", {}, ctx);
      const denied = (await tool.execute("media.describe", { id: img.id }, ctx)).value;
      expect(denied).toEqual({ status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" });
      expect(tool.stats.calls).toBe(0);
      expect(
        f.h.db.query("SELECT attempts FROM qq_media_read_tasks WHERE media_note_id=?").get(img.id),
      ).toBeNull();
      // 放开预算后第一次尝试真的失败；同 run 重复 describe 不立即再花。
      allowed = true;
      expect((await tool.execute("media.describe", { id: img.id }, ctx)).value).toMatchObject({
        status: "failed",
        attempt: 1,
        awaitSupplement: true,
      });
      expect((await tool.execute("media.describe", { id: img.id }, ctx)).value).toMatchObject({
        status: "failed",
        attempt: 1,
      });
      expect(tool.stats.calls).toBe(1);
    } finally {
      f.h.close();
    }
  });

  it("note.read pointer serves the succeeded same-question detail; id-only stays baseline", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      let reads = 0;
      const tool = f.mount({
        read: async () => {
          reads += 1;
          return reads === 1 ? "基线概述" : "细节正文";
        },
        resolveQuestion: (request) => {
          // 真实性边界：只有本轮真实问题消息的指针能冻结锚，其余一律 null。
          if (request.questionMessageId !== "message-real") return null;
          return {
            questionKey: "细节问题",
            eventKey: "q-1",
            bodyRevision: "body-1",
            source: { kind: "qq_message_fact", id: "q-1", revision: "body-1" },
            assertQuestionCurrent: () => {},
          };
        },
      });
      const { ctx } = f.context();
      await tool.execute("media.list", {}, ctx);
      // detail 未描述：指针只读已成功任务——不触发视觉、不花尝试、不写任务行、
      // 也绝不把 baseline 概述冒充 detail 正文退回来。
      const undescribed = (
        await tool.execute(
          "media.note.read",
          { id: img.id, questionMessageId: "message-real" },
          ctx,
        )
      ).value as NoteReadValue;
      expect(undescribed).toEqual({ status: "undescribed", id: img.id, attempts: 0 });
      expect(tool.stats.calls).toBe(0);
      expect(f.h.db.query("SELECT COUNT(*) AS n FROM qq_media_read_tasks").get()).toMatchObject({
        n: 0,
      });
      // 真实 describe 问锚先成功：baseline 与 detail 是两条独立预算、两次真实读取。
      await tool.execute("media.describe", { id: img.id }, ctx);
      expect(
        (
          await tool.execute(
            "media.describe",
            { id: img.id, questionMessageId: "message-real" },
            ctx,
          )
        ).value,
      ).toMatchObject({ status: "described", described: true, attempt: 1 });
      // 同指针 note.read 读 detail 正文（来源真实可复验）；id-only 仍是 baseline。
      const detailRead = await tool.execute(
        "media.note.read",
        { id: img.id, questionMessageId: "message-real" },
        ctx,
      );
      expect(detailRead.value).toMatchObject({
        status: "ok",
        id: img.id,
        model: "vision-local",
        text: "细节正文",
      });
      expectSourcesValid(f.h, f.conversation.id, detailRead.sources as SourceRef[]);
      expect((await tool.execute("media.note.read", { id: img.id }, ctx)).value).toMatchObject({
        status: "ok",
        id: img.id,
        text: "基线概述",
      });
      const purposes = (
        f.h.db.query("SELECT purpose FROM qq_media_read_tasks ORDER BY purpose").all() as {
          purpose: string;
        }[]
      ).map((row) => row.purpose);
      expect(purposes).toEqual(["baseline", "detail"]);
    } finally {
      f.h.close();
    }
  });

  it("pointer rejections: forged question, fit-time question drift, revoked capability, expired segment", async () => {
    const f = open();
    try {
      const img = f.image("img-1", { at: f.baseSeconds - 120 });
      const second = f.image("img-2", { at: f.baseSeconds - 120 });
      const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
        try {
          await promise;
        } catch (error) {
          return error;
        }
        throw new Error("expected the call to reject");
      };
      // 两条 carrier 挂同一内容字节的活资产（受控合法 PNG，非借 asset 路径绕头闸）：
      // identity 账本才能跨 carrier 证明同内容。
      const assetScope = {
        accountId: ACCOUNT,
        conversationKind: "group" as const,
        peerId: PEER,
        agentId: AGENT,
      };
      const withAsset = (mediaNoteId: string): void => {
        const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
        const asset = recordMediaAsset(f.h.orm, {
          scope: assetScope,
          bytes: pngBytesFor("image", "asset-shared-bytes"),
          mimeType: "image/png",
          expiresAt,
        });
        linkMediaAssetSource(f.h.orm, {
          assetId: asset.asset.id,
          mediaNoteId,
          scope: assetScope,
          expiresAt,
        });
      };
      withAsset(img.id);
      withAsset(second.id);
      const resolveReal: QqMediaToolsOptions["resolveQuestion"] = (request) => {
        // 真实性边界：只有本轮真实问题消息的指针能冻结锚，其余一律 null。
        if (request.questionMessageId !== "message-real") return null;
        return {
          questionKey: "细节问题",
          eventKey: "q-1",
          bodyRevision: "body-1",
          source: { kind: "qq_message_fact", id: "q-1", revision: "body-1" },
          assertQuestionCurrent: () => {},
        };
      };
      const tool = f.mount({ read: async () => "细节正文", resolveQuestion: resolveReal });
      const { ctx } = f.context();
      await tool.execute("media.list", {}, ctx);
      // 伪造指针：宿主解析不出锚 ⇒ 按原 reason 穿透拒绝，零任务消耗。
      expect(
        await rejection(
          tool.execute("media.note.read", { id: img.id, questionMessageId: "message-forged" }, ctx),
        ),
      ).toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
      expect(tool.stats.calls).toBe(0);
      expect(f.h.db.query("SELECT COUNT(*) AS n FROM qq_media_read_tasks").get()).toMatchObject({
        n: 0,
      });
      // 真实 describe 问锚：detail 任务成功、真实消耗一次。
      expect(
        (
          await tool.execute(
            "media.describe",
            { id: img.id, questionMessageId: "message-real" },
            ctx,
          )
        ).value,
      ).toMatchObject({ status: "described", described: true, attempt: 1 });
      expect(tool.stats.calls).toBe(1);
      // fit 期间问题正文改写：fit 末的锚复验按原 reason 穿透，账本原样。
      let bodyRevision = "body-1";
      let allowSecond = false;
      const driftTool = f.mount({
        read: async () => "细节正文",
        resolveQuestion: () => ({
          questionKey: "细节问题",
          eventKey: "q-1",
          bodyRevision,
          source: { kind: "qq_message_fact", id: "q-1", revision: bodyRevision },
          assertQuestionCurrent: () => {
            if (bodyRevision !== "body-1") fail("CONTEXT_SOURCE_INVALID", "问题正文已改写");
          },
        }),
        fit: async (name) => {
          if (name !== "media.note.read") return () => true;
          return () => {
            if (!allowSecond) {
              allowSecond = true;
              bodyRevision = "body-2";
              return false;
            }
            return true;
          };
        },
      });
      const drift = f.context("run-drift");
      await driftTool.execute("media.list", {}, drift.ctx);
      expect(
        await rejection(
          driftTool.execute(
            "media.note.read",
            { id: img.id, questionMessageId: "message-real" },
            drift.ctx,
          ),
        ),
      ).toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      const detailRow = f.h.db
        .query("SELECT attempts, status FROM qq_media_read_tasks WHERE purpose='detail'")
        .get() as { attempts: number; status: string };
      expect(detailRow).toMatchObject({ attempts: 1, status: "succeeded" });
      // 能力撤权（qq_settings.revision 移动）：跨 carrier 的受控消费按宿主授权已变化拒绝。
      const settings = readQqSettings(f.h.orm);
      updateQqSettings(f.h.orm, {
        accountId: ACCOUNT,
        enabled: true,
        ...(settings.judgementModelName === null
          ? { judgementModelName: "revoked-probe" as string | null }
          : { judgementModelName: null }),
        expectedRevision: settings.revision,
      });
      const cap = f.context("run-cap");
      await tool.execute("media.list", {}, cap.ctx);
      expect(
        await rejection(
          tool.execute(
            "media.note.read",
            { id: second.id, questionMessageId: "message-real" },
            cap.ctx,
          ),
        ),
      ).toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      // 过期：行窗口死亡后指针读取只回安全拒绝值，任务账本原样。
      const expiring = f.context("run-expired");
      await tool.execute("media.list", {}, expiring.ctx);
      f.h.orm
        .update(schema.qqMediaNotes)
        .set({ expiresAt: new Date(Date.parse(nowIso()) - 1_000).toISOString() })
        .where(eq_(schema.qqMediaNotes.id, second.id))
        .run();
      const expired = (
        await tool.execute(
          "media.note.read",
          { id: second.id, questionMessageId: "message-real" },
          expiring.ctx,
        )
      ).value as NoteReadValue;
      expect(expired).toEqual({ status: "unavailable", code: "segment_expired" });
      expect(tool.stats.calls).toBe(1);
      expect(detailRow).toMatchObject({ attempts: 1, status: "succeeded" });
    } finally {
      f.h.close();
    }
  });

  it("media.read stays metadata-only and tool-definitions projects it from the single source", async () => {
    const f = open();
    try {
      const { SYSTEM_TOOL_DEFINITIONS } = await import("../../src/server/modules/tool-definitions");
      const read = SYSTEM_TOOL_DEFINITIONS.filter(
        (definition) => definition.description.name === "media.read",
      );
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({
        functionId: "media-stickers",
      });
      expect(read[0]?.sandboxCallable).toBeUndefined();
      expect(read[0]?.description.effect).toBe("read");
      expect(read[0]?.description.capability).toBe("media.read");
      // 工具目录单源：media.read 的描述与工具本身同源（capabilities/effect 一致）。
      const f2 = f.mount();
      expect(f2.named("media.describe").sandboxCallable).toBe(false);
    } finally {
      f.h.close();
    }
  });
});

// 局部 drizzle eq 避免顶部未用导入告警（夹具里只有这一处动态 UPDATE）。
import { eq as eq_ } from "drizzle-orm";
