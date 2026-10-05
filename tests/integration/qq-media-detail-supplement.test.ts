//
// T15 P5 detail 第二次尝试的补充证明闭包（space-detail-supplement-fix）。
//
// 钉的是 detail purpose 的 attempt-2 闸与同一把宿主时钟：
//  * detail 分支必须接线 proveSupplementLaterThan，且基准取**本 detail 行**
//    （purpose=detail + 本 questionKey）的 claim CAS 打点 lastAttemptAt——不是 baseline 行，
//    也不是创建时的内存快照。
//  * 更早／等时刻／无关联的补充一律拒（零消耗、零视觉）；严格更晚且同 scope 的真实补充
//    才解锁，精确花 attempt 2。
//  * 同一把宿主时钟贯穿工具侧与 reader 侧：过期、资产打点、claim/结果/失败发布与 journal
//    比较共用它；比较不再跨两套刻度各自成立。
//  * detail 与 baseline 是两条独立预算；同内容跨 carrier 共享同一条 identity 预算，
//    换模型/换策略/换载体都不重置已消耗的尝试（max 2）。
//
// 真链路：生产 createQqMediaTools mount + 真实 journal 事件 + 真实失败 claim（adapter.read
// 抛错走生产 fail 路径），不手工改任务行状态、不用 boolean shim 冒充补充证据。
// 红线：不 import artifacts；不触真实数据/网络/服务。

import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { ActionContext } from "../../src/server/agent/built-in-actions";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readBindingByConversation } from "../../src/server/db/qq-binding-repository";
import {
  linkMediaAssetSource,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import { mediaNoteRow, recordMediaSegment } from "../../src/server/db/qq-media-repository";
import { normalizeQuestionKey } from "../../src/server/db/qq-media-task-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import {
  createQqMediaTools,
  type QqMediaQuestionAnchor,
} from "../../src/server/services/qq-media-tools";

const ACCOUNT = "10001";
const PEER = "30003";
const AGENT = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const POLICY = "baseline/v1/detail-supplement";
/** 夹具刻度：宿主时钟（工具与 reader 共用这一把），远晚于默认 Date.now 以便区分两套刻度。 */
const HOST_NOW = "2033-05-05T06:07:08.000Z";
/** 宿主时钟的「早」刻度：仍在真实墙钟与资产窗口之内，用于先做出一个成功结果。 */
const EARLY_NOW = "2026-06-01T00:00:00.000Z";
/** 资产/来源链的到期：晚于真实 Date.now（2026 域），早于 HOST_NOW（2033 域）。 */
const ASSET_EXPIRES = "2027-01-01T00:00:00.000Z";
const QUESTION_BODY = "这张图里猫在干嘛";
const QUESTION_KEY = normalizeQuestionKey(QUESTION_BODY);
/** 真实 PNG 字节：reader 的 header 闸只认真图片头，文本冒充会被明确拒绝。 */
const imageBytes = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);

afterEach(() => {});

type DescribeValue =
  | { status: "described"; described: true; attempt: number }
  | { status: "failed"; described: false; attempt: number; awaitSupplement: boolean }
  | { status: "unavailable"; code: string };

interface TaskRow {
  id: string;
  media_note_id: string | null;
  purpose: string;
  question_key: string | null;
  attempts: number;
  status: string;
  note: string | null;
  last_attempt_at: string | null;
}

function nonNull<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture missing: ${label}`);
  return value;
}

function open() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "qq-media-detail-supplement" });
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
      createdAt: HOST_NOW,
      updatedAt: HOST_NOW,
    })
    .run();
  const binding = nonNull(
    readBindingByConversation(h.orm, { accountId: ACCOUNT, kind: "group", peerId: PEER }),
    "binding",
  );
  const journal = new ConversationEventRepository(h.db);
  const conversation = nonNull(journal.ensureOneBot(binding.id), "conversation");
  const baseSeconds = Math.floor(Date.parse(HOST_NOW) / 1000);

  /** 一条 @ 到本助手、带图与真实原文的消息：进 qq_events + observation text + journal。 */
  function imageMessage(
    eventKey: string,
    input: { at?: number; addressed?: boolean; sourceRef?: string } = {},
  ): string {
    const at = input.at ?? baseSeconds;
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        messageId: eventKey,
        occurredAtSeconds: at,
        speakerKind: "member",
        speakerId: "20002",
        addressed: input.addressed === false ? 0 : 1,
        recordedAt: HOST_NOW,
      })
      .run();
    if (eventKey === "q-detail-1") {
      h.orm
        .insert(schema.qqObservationText)
        .values({
          eventKey,
          body: QUESTION_BODY,
          occurredAtSeconds: at,
          expiresAt: "2099-01-01T00:00:00.000Z",
          recordedAt: HOST_NOW,
        })
        .run();
    }
    recordMediaSegment(h.orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef: input.sourceRef ?? `ref-${eventKey}`,
      occurredAtSeconds: at,
      addressed: input.addressed !== false,
    });
    h.orm
      .update(schema.qqMediaNotes)
      .set({ expiresAt: "2099-01-01T00:00:00.000Z" })
      .where(eq(schema.qqMediaNotes.eventKey, eventKey))
      .run();
    journal.ingestOneBotEvent(
      eventKey,
      binding.id,
      input.addressed === false
        ? { reasons: [], mentionIds: [] }
        : { reasons: ["mention"], mentionIds: [] },
    );
    return nonNull(mediaNoteRow(h.orm, eventKey, 0), "media note").id;
  }

  /** 一条 @ 到本助手的补充消息（不带图），时刻可受控。 */
  function supplementMessage(eventKey: string, at: number, addressed = true): void {
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        messageId: eventKey,
        occurredAtSeconds: at,
        speakerKind: "member",
        speakerId: "20002",
        addressed: addressed ? 1 : 0,
        recordedAt: HOST_NOW,
      })
      .run();
    journal.ingestOneBotEvent(
      eventKey,
      binding.id,
      addressed ? { reasons: ["mention"], mentionIds: [] } : { reasons: [], mentionIds: [] },
    );
  }

  /** 给载体挂活资产：真实内容字节 ⇒ 真实 sha256（身份键的真源）。 */
  function withAsset(
    mediaNoteId: string,
    bytes: Uint8Array,
    expiresAt = "2099-01-01T00:00:00.000Z",
  ): void {
    const { asset } = recordMediaAsset(h.orm, {
      scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
      bytes,
      mimeType: "image/png",
      expiresAt,
      at: EARLY_NOW,
    });
    linkMediaAssetSource(h.orm, {
      assetId: asset.id,
      mediaNoteId,
      scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
      expiresAt,
      at: EARLY_NOW,
    });
  }

  function taskRows(): TaskRow[] {
    return h.db
      .query(
        "SELECT id,media_note_id AS media_note_id,purpose,question_key AS question_key,attempts,status,note,last_attempt_at AS last_attempt_at FROM qq_media_read_tasks ORDER BY purpose",
      )
      .all() as TaskRow[];
  }

  const anchor = (): QqMediaQuestionAnchor => ({
    questionKey: QUESTION_KEY,
    eventKey: "q-detail-1",
    bodyRevision: "rev-1",
    source: { kind: "qq_message_fact", id: "q-detail-1", revision: "rev-1" },
    assertQuestionCurrent: () => {},
  });

  function mount(input: { read?: () => Promise<string>; now?: () => string } = {}) {
    const stats = { calls: 0, fetched: 0 };
    const actions = createQqMediaTools({
      db: h.db,
      orm: h.orm,
      conversationId: conversation.id,
      binding,
      adapter: {
        capabilities: ["image"] as const,
        fetchBytes: async () => {
          stats.fetched += 1;
          return { bytes: imageBytes };
        },
        read: async () => {
          stats.calls += 1;
          return input.read ? input.read() : "描述";
        },
      },
      modelConfig: { visionModelName: "vision-local", transcriptionModelName: null },
      supplementWindowMinutes: 60,
      policyRevision: POLICY,
      now: input.now ?? (() => HOST_NOW),
      assertCurrent: () => {},
      fit: async () => () => true,
      evidence: { db: h.db, orm: h.orm },
      resolveQuestion: () => anchor(),
    });
    const named = (name: string) =>
      nonNull(
        actions.find((entry) => entry.description.name === name),
        `action ${name}`,
      );
    const context = (runId: string): ActionContext => ({
      owner: {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: AGENT,
      },
      runId,
      signal: new AbortController().signal,
    });
    return {
      stats,
      /** 一次新的 run：先 media.list 授权这条消息，再 describe（真实工具边界顺序）。 */
      async describe(
        id: string,
        runId: string,
        questionMessageId?: string,
      ): Promise<DescribeValue> {
        const ctx = context(runId);
        await named("media.list").execute({}, ctx);
        const result = await named("media.describe").execute(
          questionMessageId === undefined ? { id } : { id, questionMessageId },
          ctx,
        );
        return result.value as DescribeValue;
      },
    };
  }

  return { h, baseSeconds, imageMessage, supplementMessage, withAsset, taskRows, mount, db: h.db };
}

describe("QQ media detail supplement closure (attempt-2 gate on the detail row)", () => {
  it("[detail-proof] 更早／等时刻／无关联的补充一律拒；严格更晚才解锁精确 attempt 2", async () => {
    const f = open();
    const img = f.imageMessage("q-detail-1");
    f.withAsset(img, imageBytes);
    const tool = f.mount({
      read: async () => {
        throw new Error("synthetic vision failure");
      },
    });
    // 第一次 detail 读取：真实失败 claim，烧 attempt 1。
    expect(await tool.describe(img, "run-1", "q-detail-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      awaitSupplement: true,
    });
    const first = f.taskRows().find((row) => row.purpose === "detail");
    expect(first).toMatchObject({ attempts: 1, status: "failed", question_key: QUESTION_KEY });
    // 基准必须是宿主时钟刻度下的 claim CAS 打点（不是 Date.now 的 2026 域）。
    expect(nonNull(first?.last_attempt_at, "last_attempt_at")).toBe(HOST_NOW);

    // 更早的补充：拒，零消耗、零视觉。
    f.supplementMessage("supp-earlier", f.baseSeconds - 30);
    expect(await tool.describe(img, "run-2", "q-detail-1")).toEqual({
      status: "unavailable",
      code: "awaiting_supplement",
    });
    expect(tool.stats.calls).toBe(1);

    // 等时刻的补充：拒（要求严格更晚）。
    f.supplementMessage("supp-equal", f.baseSeconds);
    expect(await tool.describe(img, "run-3", "q-detail-1")).toEqual({
      status: "unavailable",
      code: "awaiting_supplement",
    });
    expect(tool.stats.calls).toBe(1);

    // 无关联（非 @、非 reply_to_agent）的更晚消息：拒。
    f.supplementMessage("supp-unrelated", f.baseSeconds + 60, false);
    expect(await tool.describe(img, "run-4", "q-detail-1")).toEqual({
      status: "unavailable",
      code: "awaiting_supplement",
    });
    expect(tool.stats.calls).toBe(1);
    expect(f.taskRows().find((row) => row.purpose === "detail")).toMatchObject({ attempts: 1 });

    // 严格更晚且同 scope 的真实补充：解锁，精确花 attempt 2。
    f.supplementMessage("supp-fresh", f.baseSeconds + 120);
    expect(await tool.describe(img, "run-5", "q-detail-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 2,
      awaitSupplement: false,
    });
    expect(tool.stats.calls).toBe(2);
    const second = f.taskRows().find((row) => row.purpose === "detail");
    expect(second).toMatchObject({ attempts: 2, status: "failed" });

    // 预算到顶：再多的更晚补充也不再解锁（不因模型/策略/载体重置）。
    f.supplementMessage("supp-fresh-2", f.baseSeconds + 240);
    expect(await tool.describe(img, "run-6", "q-detail-1")).toEqual({
      status: "unavailable",
      code: "attempts_exhausted",
    });
    expect(tool.stats.calls).toBe(2);
    expect(f.taskRows().find((row) => row.purpose === "detail")).toMatchObject({ attempts: 2 });
  });

  it("[detail-baseline] detail 与 baseline 独立预算：baseline 的补充不替 detail 解锁", async () => {
    const f = open();
    const img = f.imageMessage("q-detail-1");
    f.withAsset(img, imageBytes);
    const tool = f.mount({
      read: async () => {
        throw new Error("synthetic vision failure");
      },
    });
    // baseline 先烧 attempt 1。
    expect(await tool.describe(img, "b-run-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      awaitSupplement: true,
    });
    // detail 独立首次读取，attempt 1。
    expect(await tool.describe(img, "d-run-1", "q-detail-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      awaitSupplement: true,
    });
    const rows = f.taskRows();
    expect(rows.filter((row) => row.purpose === "baseline")).toMatchObject([{ attempts: 1 }]);
    expect(rows.filter((row) => row.purpose === "detail")).toMatchObject([{ attempts: 1 }]);

    // 一条严格更晚的补充：baseline 解锁到 attempt 2；detail 自己的基准也是更晚，
    // 因此同样解锁——但两条预算各自独立计数，互不合并。
    f.supplementMessage("supp-both", f.baseSeconds + 300);
    expect(await tool.describe(img, "b-run-2")).toEqual({
      status: "failed",
      described: false,
      attempt: 2,
      awaitSupplement: false,
    });
    expect(await tool.describe(img, "d-run-2", "q-detail-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 2,
      awaitSupplement: false,
    });
    const after = f.taskRows();
    expect(after.find((row) => row.purpose === "baseline")).toMatchObject({ attempts: 2 });
    expect(after.find((row) => row.purpose === "detail")).toMatchObject({ attempts: 2 });
    expect(tool.stats.calls).toBe(4);
  });

  it("[cross-carrier] 同内容跨载体共享 identity 预算：detail 的已消耗尝试不因换载体重置", async () => {
    const f = open();
    const first = f.imageMessage("q-detail-1");
    f.withAsset(first, imageBytes);
    const tool = f.mount({
      read: async () => {
        throw new Error("synthetic vision failure");
      },
    });
    expect(await tool.describe(first, "c-run-1", "q-detail-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      awaitSupplement: true,
    });
    // 另一条载体投递同一内容（同一 sha256 ⇒ 同一 identity 预算行）。
    const second = f.imageMessage("carrier-2", { at: f.baseSeconds + 30 });
    f.withAsset(second, imageBytes);
    // 无补充 → 仍拒，且不重置预算。
    expect(await tool.describe(second, "c-run-2", "q-detail-1")).toEqual({
      status: "unavailable",
      code: "awaiting_supplement",
    });
    const detailRows = f.taskRows().filter((row) => row.purpose === "detail");
    expect(detailRows).toHaveLength(1);
    expect(detailRows[0]).toMatchObject({ attempts: 1 });
    // 严格更晚补充后仍是那一行到 attempt 2（新载体不重开预算）。
    f.supplementMessage("supp-cross", f.baseSeconds + 600);
    expect(await tool.describe(second, "c-run-3", "q-detail-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 2,
      awaitSupplement: false,
    });
    const after = f.taskRows().filter((row) => row.purpose === "detail");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ attempts: 2 });
  });

  it("[same-clock] 任务行的 claim 打点与过期判断都用宿主时钟，不跨刻度各自成立", async () => {
    const f = open();
    const img = f.imageMessage("q-detail-1");
    f.withAsset(img, imageBytes);
    // 宿主时钟给一个真实墙钟**之后**的时刻：真实 Date.now（2026 域）比它早，
    // 若某处仍用 Date.now 打点，这行 last_attempt_at 会落在 2026 域。
    const tool = f.mount({
      now: () => HOST_NOW,
      read: async () => "描述",
    });
    expect(await tool.describe(img, "s-run-1", "q-detail-1")).toEqual({
      status: "described",
      described: true,
      attempt: 1,
    });
    const row = f.taskRows().find((entry) => entry.purpose === "detail");
    expect(row).toMatchObject({ attempts: 1, status: "succeeded" });
    expect(nonNull(row?.last_attempt_at, "last_attempt_at")).toBe(HOST_NOW);
    expect(Date.parse(nonNull(row?.last_attempt_at, "t"))).toBeGreaterThan(Date.now());
  });

  it("[cache-clock] 缓存命中分支与新读分支同一把宿主时钟：窗口判定不再跨刻度", async () => {
    const f = open();
    const img = f.imageMessage("q-detail-1");
    // 资产/来源链的窗口刻意夹在两套刻度之间：真实墙钟（2026 域）看它是活的，
    // 宿主时钟（2033 域）看它是死的。媒体行本身仍是 2099，两条分支都活着。
    f.withAsset(img, imageBytes, ASSET_EXPIRES);
    // 第一步：用早刻度（真实域内）真实读一次，做出账本上的成功结果——公共
    // createQqMediaTools ＋ readQqMediaTaskOnce 的真实路径，不手写任务行状态。
    const early = f.mount({ now: () => EARLY_NOW, read: async () => "第一次描述" });
    expect(await early.describe(img, "cache-run-1")).toEqual({
      status: "described",
      described: true,
      attempt: 1,
    });
    const seeded = f.taskRows().find((row) => row.purpose === "baseline");
    expect(seeded).toMatchObject({ attempts: 1, status: "succeeded", note: "第一次描述" });

    // 第二步：同一 run 内重复 describe 走 cachePath（缓存命中分支）。宿主时钟在
    // 2033 域：reader 的资产查找必须按宿主刻度判窗口——资产链已过期 → 不能拿它当
    // 同内容证明，须走受控 fetchBytes 取身份，再命中账本里那条同身份结果。
    // 若该分支仍用 reader 默认墙钟，资产会被当成活链，走不到这条判定。
    const late = f.mount({ now: () => HOST_NOW, read: async () => "不该被调用" });
    expect(await late.describe(img, "cache-run-2")).toEqual({
      status: "described",
      described: true,
      attempt: 1,
    });
    // 缓存命中零预算消耗：仍是那一次尝试，视觉没有被调用。
    expect(late.stats.calls).toBe(0);
    expect(late.stats.fetched).toBeGreaterThan(0);
    const after = f.taskRows().find((row) => row.purpose === "baseline");
    expect(after).toMatchObject({ attempts: 1, status: "succeeded", note: "第一次描述" });
  });
});
