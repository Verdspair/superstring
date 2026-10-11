//
// detail 退役流闭包（§5.7 重读/重试简化；space-detail-supplement-fix 语义收编）。
//
// 补充时间窗与时间解锁已退役。本文件钉的是退役后的真实语义：
//  * baseline 首次自动读一次：失败结果记在任务账本行上复用，不等补充、不自动第二次、
//    不循环；更晚的真实 @ 消息不是自动重试授权。
//  * 普通 detail（无宿主 explicitRequest）沿用原内容身份：同内容跨载体共享同一条
//    identity 预算行，换载体/换模型/换策略都不重置已消耗的尝试。
//  * 宿主 trusted 的 explicitRequest（引用原图/明确再看，从真实请求消息/run 冻结）是
//    新的有界任务：新 requestId ⇒ 新账本行、各自预算；旧失败不挡新请求；同一请求的
//    重复 invoke/replay 落同一行去重；不继承 baseline/普通 detail 的旧累计。
//  * 同一把宿主时钟贯穿工具侧与 reader 侧：过期、资产打点、claim/结果/失败发布共用它。
//  * questionKey 仍表达 detail 语义与缓存；请求身份只能由宿主解析，模型措辞/参数不参与。
//
// 真链路：生产 createQqMediaTools mount + 真实 journal 事件 + 真实失败 claim（adapter.read
// 抛错走生产 fail 路径），不手工改任务行状态。
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
const POLICY = "baseline/v1/detail-retired-flow";
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
  | {
      status: "described";
      described: true;
      attempt: number;
      id: string;
      model: string;
      text: string;
      offset: number;
      nextOffset: number | null;
    }
  | { status: "failed"; described: false; attempt: number; giveUp: boolean }
  | { status: "unavailable"; code: string };

/** media.note.read 的返回形状（真实工具信封；只取本用例断言到的字段）。 */
type NoteReadValue =
  | {
      status: "ok";
      id: string;
      model: string;
      text: string;
      offset: number;
      nextOffset: number | null;
    }
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

  /** 一条群成员消息（时刻可受控）：退役流下它只是 journal 事实，不是重读授权。 */
  function laterMessage(eventKey: string, at: number, addressed = true): void {
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

  /** 宿主锚：默认普通 detail（无 explicitRequest）；可按需注入宿主 trusted 请求身份。 */
  const anchor = (explicitRequestId?: string): QqMediaQuestionAnchor => ({
    questionKey: QUESTION_KEY,
    eventKey: "q-detail-1",
    bodyRevision: "rev-1",
    source: { kind: "qq_message_fact", id: "q-detail-1", revision: "rev-1" },
    assertQuestionCurrent: () => {},
    ...(explicitRequestId === undefined
      ? {}
      : {
          explicitRequest: {
            requestId: explicitRequestId,
            requestEventKey: `req-event-${explicitRequestId}`,
            bindingEpoch: 1,
          },
        }),
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
      policyRevision: POLICY,
      now: input.now ?? (() => HOST_NOW),
      assertCurrent: () => {},
      fit: async () => () => true,
      evidence: { db: h.db, orm: h.orm },
      resolveQuestion: (request) => {
        // 真实性边界：只有本轮真实问题消息的指针能冻结锚。普通问题指针（真实消息）＝
        // 普通 detail，无 explicitRequest；只有指向真实"显式请求消息"的指针，宿主才
        // 从请求事件/epoch 派生并冻结 requestId（合成链：指针本身即以 req- 开头）。
        if (request.questionMessageId === undefined) return null;
        return request.questionMessageId.startsWith("req-")
          ? anchor(request.questionMessageId)
          : anchor();
      },
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
      /** 同 run 内的有界分页续读：media.note.read 按既有 offset/limit 形状续取正文。 */
      async readNote(
        id: string,
        runId: string,
        input: { offset: number; limit: number },
      ): Promise<NoteReadValue> {
        const ctx = context(runId);
        await named("media.list").execute({}, ctx);
        const result = await named("media.note.read").execute(
          { id, questionMessageId: "req-message-1", offset: input.offset, limit: input.limit },
          ctx,
        );
        return result.value as NoteReadValue;
      },
    };
  }

  return { h, baseSeconds, imageMessage, laterMessage, withAsset, taskRows, mount, db: h.db };
}

describe("QQ media detail retired-flow closure (one bounded attempt; host-resolved explicit requests)", () => {
  it("[baseline-once] baseline 与普通 detail 各自一次有界尝试：更晚的真实 @ 消息不是自动重试授权", async () => {
    const f = open();
    const img = f.imageMessage("q-detail-1");
    f.withAsset(img, imageBytes);
    const tool = f.mount({
      read: async () => {
        throw new Error("synthetic vision failure");
      },
    });
    // baseline 一次自动读：失败即结清，giveUp 置真。
    expect(await tool.describe(img, "b-run-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      giveUp: true,
    });
    // 普通 detail（无 explicitRequest）也是一次有界尝试：失败结果复用。
    expect(await tool.describe(img, "d-run-1", "q-detail-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      giveUp: true,
    });
    const rows = f.taskRows();
    expect(rows.filter((row) => row.purpose === "baseline")).toMatchObject([{ attempts: 1 }]);
    expect(rows.filter((row) => row.purpose === "detail")).toMatchObject([{ attempts: 1 }]);

    // 更早/等时刻/更晚、@ 或非 @ 的消息都不是重读授权（补充时间窗已退役）。
    f.laterMessage("msg-earlier", f.baseSeconds - 30);
    f.laterMessage("msg-equal", f.baseSeconds);
    f.laterMessage("msg-unrelated", f.baseSeconds + 60, false);
    f.laterMessage("msg-later", f.baseSeconds + 120);
    expect(await tool.describe(img, "b-run-2")).toEqual({
      status: "unavailable",
      code: "attempts_exhausted",
    });
    expect(await tool.describe(img, "d-run-2", "q-detail-1")).toEqual({
      status: "unavailable",
      code: "attempts_exhausted",
    });
    expect(tool.stats.calls).toBe(2);
    const after = f.taskRows();
    expect(after.find((row) => row.purpose === "baseline")).toMatchObject({
      attempts: 1,
      status: "failed",
    });
    expect(after.find((row) => row.purpose === "detail")).toMatchObject({
      attempts: 1,
      status: "failed",
    });
  });

  it("[explicit-request] 宿主 trusted 的新显式请求是新身份：新预算不继承旧失败；同请求 replay 去重", async () => {
    const f = open();
    const img = f.imageMessage("q-detail-1");
    f.withAsset(img, imageBytes);
    const tool = f.mount({
      read: async () => {
        throw new Error("synthetic vision failure");
      },
    });
    // 旧失败：baseline + 普通 detail 各自烧尽。
    expect(await tool.describe(img, "b-run-1")).toMatchObject({
      status: "failed",
      attempt: 1,
      giveUp: true,
    });
    expect(await tool.describe(img, "d-run-1", "q-detail-1")).toMatchObject({
      status: "failed",
      attempt: 1,
      giveUp: true,
    });
    expect(tool.stats.calls).toBe(2);

    // 真实新显式请求（宿主从请求消息冻结 requestId）：新账本行、自己的预算。
    expect(await tool.describe(img, "er-run-1", "req-message-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      giveUp: true,
    });
    expect(tool.stats.calls).toBe(3);
    const explicitRows = f.taskRows().filter((row) => row.question_key === QUESTION_KEY);
    // 普通 detail 与显式请求是两条独立预算行（显式请求带第 8 维身份）。
    expect(explicitRows).toHaveLength(2);
    expect(explicitRows.map((row) => row.attempts).sort()).toEqual([1, 1]);

    // 同一请求（同指针⇒同宿主 requestId）的重复 invoke/replay：同一行去重，零新视觉。
    expect(await tool.describe(img, "er-run-2", "req-message-1")).toEqual({
      status: "unavailable",
      code: "attempts_exhausted",
    });
    expect(tool.stats.calls).toBe(3);

    // 另一个真实显式请求：又一个新身份、新预算（旧失败不是永久门禁）。
    expect(await tool.describe(img, "er-run-3", "req-message-2")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      giveUp: true,
    });
    expect(tool.stats.calls).toBe(4);
    const allDetail = f.taskRows().filter((row) => row.purpose === "detail");
    expect(allDetail).toHaveLength(3);
    expect(allDetail.map((row) => row.attempts)).toEqual([1, 1, 1]);
  });

  it("[cross-carrier] 同内容跨载体共享 identity 预算：显式请求之外的身份不因换载体重置", async () => {
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
      giveUp: true,
    });
    // 另一条载体投递同一内容（同一 sha256 ⇒ 同一 identity 预算行）；普通 detail
    // （无 explicitRequest）不重开预算。
    const second = f.imageMessage("carrier-2", { at: f.baseSeconds + 30 });
    f.withAsset(second, imageBytes);
    expect(await tool.describe(second, "c-run-2", "q-detail-1")).toEqual({
      status: "unavailable",
      code: "attempts_exhausted",
    });
    expect(tool.stats.calls).toBe(1);
    const detailRows = f.taskRows().filter((row) => row.purpose === "detail");
    expect(detailRows).toHaveLength(1);
    expect(detailRows[0]).toMatchObject({ attempts: 1 });
    // 同一显式请求（同指针⇒同宿主 requestId）在新载体上的 replay 落同一行去重
    // （身份只看 requestId，不看载体）；零新视觉。
    expect(await tool.describe(second, "c-run-3", "q-detail-1")).toEqual({
      status: "unavailable",
      code: "attempts_exhausted",
    });
    expect(tool.stats.calls).toBe(1);
    expect(f.taskRows().filter((row) => row.purpose === "detail")).toHaveLength(1);
  });

  it("[explicit-success] 宿主显式请求的受控成功交付：新账本行两证据分页；replay 与同内容新请求零新视觉", async () => {
    const f = open();
    const img = f.imageMessage("q-detail-1");
    f.withAsset(img, imageBytes);
    // 第一步：受控失败 adapter 先烧掉旧身份——baseline 与普通 detail 各自一次有界尝试。
    const failing = f.mount({
      read: async () => {
        throw new Error("synthetic vision failure");
      },
    });
    expect(await failing.describe(img, "es-fail-b")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      giveUp: true,
    });
    expect(await failing.describe(img, "es-fail-d", "q-detail-1")).toEqual({
      status: "failed",
      described: false,
      attempt: 1,
      giveUp: true,
    });
    expect(failing.stats.calls).toBe(2);
    const SUCCESS_TEXT = `显式请求成功后交付的真实描述正文：${"猫趴在窗台上晒太阳，尾巴自然下垂。".repeat(130)}`;
    // 第二步：新 mount 的受控 reader 真实成功。显式请求 req-message-1 是新身份（第 8 维
    // requestId 入账）：新行、自己的预算，旧失败不挡；成功后按两证据交付正文分页。
    const tool = f.mount({ read: async () => SUCCESS_TEXT });
    expect(await tool.describe(img, "es-run-1", "req-message-1")).toEqual({
      status: "described",
      described: true,
      attempt: 1,
      id: img,
      model: "vision-local",
      text: SUCCESS_TEXT.slice(0, 2048),
      offset: 0,
      nextOffset: 2048,
    });
    // 数据适配器确实只被调用一次（一次真实读取）。
    expect(tool.stats.calls).toBe(1);
    // 同一受控分页：跟随指向该显式请求的问题指针读第 2 页，正文与页面边界一致。
    expect(await tool.readNote(img, "es-run-2", { offset: 2048, limit: 60 })).toEqual({
      status: "ok",
      id: img,
      model: "vision-local",
      text: SUCCESS_TEXT.slice(2048, 2108),
      offset: 2048,
      nextOffset: 2108,
    });
    // 同一请求（同指针 ⇒ 同宿主 requestId）的新 run replay：命中成功行缓存，零新视觉。
    expect(await tool.describe(img, "es-run-3", "req-message-1")).toEqual({
      status: "described",
      described: true,
      attempt: 1,
      id: img,
      model: "vision-local",
      text: SUCCESS_TEXT.slice(0, 2048),
      offset: 0,
      nextOffset: 2048,
    });
    // 另一个真实显式请求（req-message-2）：同图同问题，按已成功内容复用交付，不花新预算。
    expect(await tool.describe(img, "es-run-4", "req-message-2")).toEqual({
      status: "described",
      described: true,
      attempt: 1,
      id: img,
      model: "vision-local",
      text: SUCCESS_TEXT.slice(0, 2048),
      offset: 0,
      nextOffset: 2048,
    });
    expect(tool.stats.calls).toBe(1);
    // 账本事实：普通 detail 的失败行原样保留（request_id 恒 NULL）；显式请求只落 req1 一条
    // 成功行（req2 走内容复用，不开新预算行、不冒充）。
    const detailRows = f.taskRows().filter((row) => row.purpose === "detail");
    expect(detailRows).toHaveLength(2);
    expect(detailRows.map((row) => row.status).sort()).toEqual(["failed", "succeeded"]);
    expect(detailRows.map((row) => row.attempts)).toEqual([1, 1]);
    const requestRows = f.db
      .query(
        "SELECT request_id AS request_id,status,attempts,note FROM qq_media_read_tasks WHERE purpose='detail' AND request_id IS NOT NULL",
      )
      .all() as { request_id: string; status: string; attempts: number; note: string | null }[];
    expect(requestRows).toHaveLength(1);
    expect(requestRows[0]).toMatchObject({
      request_id: "req-message-1",
      status: "succeeded",
      attempts: 1,
      note: SUCCESS_TEXT,
    });
    const baseline = f.taskRows().find((row) => row.purpose === "baseline");
    expect(baseline).toMatchObject({ attempts: 1, status: "failed" });
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
      id: img,
      model: "vision-local",
      text: "描述",
      offset: 0,
      nextOffset: null,
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
      id: img,
      model: "vision-local",
      text: "第一次描述",
      offset: 0,
      nextOffset: null,
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
      id: img,
      model: "vision-local",
      text: "第一次描述",
      offset: 0,
      nextOffset: null,
    });
    // 缓存命中零预算消耗：仍是那一次尝试，视觉没有被调用。
    expect(late.stats.calls).toBe(0);
    expect(late.stats.fetched).toBeGreaterThan(0);
    const after = f.taskRows().find((row) => row.purpose === "baseline");
    expect(after).toMatchObject({ attempts: 1, status: "succeeded", note: "第一次描述" });
  });
});
