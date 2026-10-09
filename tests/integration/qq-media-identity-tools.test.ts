// T08 跨 carrier 身份复用 + detail 问题指针的宿主边界（resume-media-tools-bridge）。
//
// 这里钉的是「工具面」这一层的边界；账本、reader、来源签发的实体判据各有其主：
//  * 跨 carrier 同内容：identity 账本只有一行预算。工具只消费受控的只读结果，绝不复制
//    任务行、绝不自己 claim，也绝不签那个旧 carrier 自己的裸任务引用——两证据
//    （identity 结果 ref + 本 carrier 媒体 ref）缺一就不给正文。
//  * 三处判据同源：list 的 described/attempts、note.read 的正文、describe 的缓存出口，
//    绝不允许出现「list 说未描述而 note.read 拿得到」。
//  * detail 指针：模型只给消息 id，宿主复验后才成为问题身份；问题不合法 ⇒ 零任务消耗，
//    且绝不退化成 baseline（否则新问题会被当成首次读取）。
//  * 缺省行为：新宿主依赖不注入时，四个工具的形状与既有行为逐字不变。

import type { Database } from "bun:sqlite";
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
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_USER_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import {
  createQqMediaTools,
  type QqMediaQuestionAnchor,
  type QqMediaToolsOptions,
} from "../../src/server/services/qq-media-tools";
import { QQ_MEDIA_TOOL_DESCRIPTIONS } from "../../src/shared/contracts/agent-action-descriptions";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const ACCOUNT = "10001";
const PEER = "30003";
const AGENT = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const POLICY = "baseline/v1/test-policy";

const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
});

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

/** 按宿主消费路径（context-access）复验一个引用，返回它的可见状态。 */
function sourceState(
  f: { h: { db: Database }; conversationId: string },
  source: SourceRef,
): "available" | "expired" | "revoked" {
  try {
    assertContextSources({
      db: f.h.db,
      sources: [source],
      owner: {
        kind: "conversation",
        id: f.conversationId,
        userId: DEFAULT_USER_ID,
        agentId: AGENT,
      },
      now: nowIso(),
      memoryRevisions: () => new Map(),
      messages: { memory: "memory changed", other: "source changed" },
    });
    return "available";
  } catch {
    return "revoked";
  }
}

function open() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "qq-media-identity-tools-test" });
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
  const wired = binding;
  const journal = new ConversationEventRepository(h.db);
  const opened = journal.ensureOneBot(wired.id);
  if (!opened) throw new Error("conversation fixture missing");
  const conversation = opened;
  const baseSeconds = Math.floor(Date.now() / 1000);

  /** 一条带图片的消息：进 journal 且时间线携带 qq_media 引用（可披露）。 */
  function image(eventKey: string, sourceRef = `ref-${eventKey}`): string {
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        messageId: `message-${eventKey}`,
        occurredAtSeconds: baseSeconds,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: nowIso(),
      })
      .run();
    recordMediaSegment(h.orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef,
      occurredAtSeconds: baseSeconds,
      addressed: true,
    });
    journal.ingestOneBotEvent(eventKey, wired.id, { reasons: ["mention"], mentionIds: [] });
    const row = mediaNoteRow(h.orm, eventKey, 0);
    if (!row) throw new Error("media fixture missing");
    return row.id;
  }

  const scope = {
    accountId: ACCOUNT,
    conversationKind: "group" as const,
    peerId: PEER,
    agentId: AGENT,
  };
  /**
   * 受控合法 PNG 字节：按 sha(kind+ref) 生成真实 RGBA 像素——同一 ref 永远同字节
   * （身份稳定），不同 ref 字节不同（绝不误判同内容）。头部经真实 readQqImageHeader 校验。
   */
  function pngBytesFor(kind: string, ref: string): Uint8Array {
    const seed = createHash("sha256").update(`test-bytes:${kind}:${ref}`).digest();
    const pixels = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = seed[i % seed.length] ?? 0;
    return encodeQqFramePng(pixels, 2, 2);
  }

  /** 给一个载体挂上活资产（真实内容字节 ⇒ 真实 sha256），身份键才能证明同内容。 */
  function withAsset(mediaNoteId: string, content: string): void {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const asset = recordMediaAsset(h.orm, {
      scope,
      bytes: pngBytesFor("image", content),
      mimeType: "image/png",
      expiresAt,
    });
    linkMediaAssetSource(h.orm, { assetId: asset.asset.id, mediaNoteId, scope, expiresAt });
  }

  interface MountInput {
    readonly read?: (input: { sourceRef: string }) => Promise<string>;
    readonly resolveQuestion?: QqMediaToolsOptions["resolveQuestion"];
    readonly servableDescription?: QqMediaToolsOptions["servableDescription"];
    readonly readImage?: QqMediaToolsOptions["readImage"];
    /** 不注入即记录不到通知（用于断言「未交付就不通知」）。 */
    readonly onDescribed?: boolean;
  }
  function mount(input: MountInput = {}) {
    const stats = {
      calls: 0,
      servable: 0,
      readImage: [] as { mediaNoteId: string; questionKey?: string }[],
      described: [] as { eventKey: string; taskId: string }[],
    };
    const actions = createQqMediaTools({
      db: h.db,
      orm: h.orm,
      conversationId: conversation.id,
      binding: wired,
      adapter: {
        capabilities: ["image"] as const,
        read: async (request) => {
          stats.calls++;
          return (input.read ?? (async () => "橘猫"))(request);
        },
        // 身份键需要受控字节的 sha256：测试宿主按 sourceRef 的稳定内容给出，
        // 不走网络（同一 sourceRef＝同一身份，另一条消息＝另一 carrier）。
        fetchBytes: async ({ kind, sourceRef }) => ({
          bytes: pngBytesFor(kind, sourceRef),
        }),
      },
      modelConfig: { visionModelName: "vision-local", transcriptionModelName: null },
      supplementWindowMinutes: 30,
      policyRevision: "test-policy",
      assertCurrent: () => {},
      fit: async () => () => true,
      evidence: { db: h.db, orm: h.orm },
      ...(input.onDescribed === true
        ? {
            onDescribed: (eventKey: string, taskId: string) => {
              stats.described.push({ eventKey, taskId });
            },
          }
        : {}),
      ...(input.resolveQuestion === undefined ? {} : { resolveQuestion: input.resolveQuestion }),
      ...(input.servableDescription === undefined
        ? {}
        : {
            servableDescription: (request) => {
              stats.servable++;
              return input.servableDescription?.(request) ?? null;
            },
          }),
      ...(input.readImage === undefined
        ? {}
        : {
            readImage: async (request) => {
              stats.readImage.push({
                mediaNoteId: request.mediaNoteId,
                ...(request.questionKey === undefined ? {} : { questionKey: request.questionKey }),
              });
              return (
                (await input.readImage?.(request)) ?? { category: "ordinary" as const, images: [] }
              );
            },
          }),
    });
    const named = (name: string): BuiltInAction => {
      const action = actions.find((entry) => entry.description.name === name);
      if (!action) throw new Error(`missing action ${name}`);
      return action;
    };
    return {
      stats,
      named,
      execute: (name: string, arguments_: Record<string, unknown>, ctx: ActionContext) =>
        named(name).execute(arguments_, ctx),
    };
  }

  function context(runId = "run-1") {
    const controller = new AbortController();
    controllers.push(controller);
    return {
      controller,
      ctx: {
        owner: {
          kind: "conversation" as const,
          id: conversation.id,
          userId: DEFAULT_USER_ID,
          agentId: AGENT,
        },
        runId,
        signal: controller.signal,
      } satisfies ActionContext,
    };
  }

  const mediaSourceRef = (mediaNoteId: string): SourceRef => ({
    kind: "qq_media_source",
    id: mediaNoteId,
    revision: `rev-${mediaNoteId}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const taskResultRef = (taskId: string): SourceRef => ({
    kind: "qq_media_read_task",
    id: taskId,
    revision: `rev-${taskId}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  function listedItems(observation: { value: unknown }): MediaListItem[] {
    const page = observation.value as ListValue;
    if (page.status !== "ok") throw new Error(`expected an ok list: ${JSON.stringify(page)}`);
    return page.items;
  }
  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected the call to reject");
  }
  const taskRows = () => h.orm.select().from(schema.qqMediaReadTasks).all();

  return {
    h,
    conversationId: conversation.id,
    image,
    withAsset,
    mount,
    context,
    listedItems,
    rejection,
    mediaSourceRef,
    taskResultRef,
    taskRows,
  };
}

describe("T08 media tools: identity reuse and the detail question pointer", () => {
  it("serves the second carrier of the same bytes from the real identity ledger", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "同一张图的字节");
    const tool = f.mount();
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    expect((await tool.execute("media.describe", { id: first }, ctx)).value).toMatchObject({
      status: "described",
      attempt: 1,
    });
    // 第二个载体：只读命中唯一预算行，零新视觉、零新任务行、attempts 不重置。
    const reused = await tool.execute("media.describe", { id: second }, ctx);
    expect(reused.value).toMatchObject({ status: "described", attempt: 1 });
    expect(tool.stats.calls).toBe(1);
    expect(f.taskRows()).toHaveLength(1);
    expect(f.taskRows()[0]?.attempts).toBe(1);
    // 两证据：identity 结果 ref（那唯一一行）+ 本 carrier 的媒体 ref。
    expect(reused.sources.map((source) => source.kind)).toEqual([
      "qq_media_read_task",
      "qq_media_source",
    ]);
    expect(reused.sources[0]?.id).toBe(f.taskRows()[0]?.id);
    expect(reused.sources[1]?.id).toBe(second);
    // 三处判据同源：list 与 note.read 交出同一份正文。
    expect(
      f.listedItems(await tool.execute("media.list", {}, ctx)).find((i) => i.id === second),
    ).toMatchObject({
      described: true,
      attempts: 1,
    });
    const note = await tool.execute("media.note.read", { id: second }, ctx);
    expect(note.value).toMatchObject({ status: "ok", text: "橘猫" });
    expect(note.sources.map((source) => source.kind)).toEqual([
      "qq_media_read_task",
      "qq_media_source",
    ]);
    expect(note.sources[1]?.id).toBe(second);
    expect(tool.stats.calls).toBe(1);
  });

  it("revokes the reused result once the ledger row's own note is rewritten", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "同一张图的字节");
    const tool = f.mount();
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: first }, ctx);
    const before = await tool.execute("media.note.read", { id: second }, ctx);
    expect(before.value).toMatchObject({ status: "ok", text: "橘猫" });
    // identity 行的正文被改写：媒体引用看不出差别，只有结果引用（冻结 note 修订）能撤。
    f.h.db.query("UPDATE qq_media_read_tasks SET note='被改写'").run();
    // 结果引用冻结了 note 修订 ⇒ 被撤；媒体引用只证明本 carrier 的行，仍然有效。
    expect(sourceState(f, before.sources[0] as SourceRef)).toBe("revoked");
    expect(sourceState(f, before.sources[1] as SourceRef)).toBe("available");
    // 再次交付按现值签发，正文与引用逐字相符——绝不拿改写前的引用交改写后的正文。
    const after = await tool.execute("media.note.read", { id: second }, ctx);
    expect(after.value).toMatchObject({ status: "ok", text: "被改写" });
    expect(after.sources[0]?.revision).not.toBe(before.sources[0]?.revision);
  });

  it("keeps different bytes in separate budgets", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "另一张图的字节");
    const tool = f.mount();
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: first }, ctx);
    // 不同字节＝不同身份：第二载体仍要自己花一次预算。
    expect((await tool.execute("media.describe", { id: second }, ctx)).value).toMatchObject({
      status: "described",
      attempt: 1,
    });
    expect(tool.stats.calls).toBe(2);
    expect(f.taskRows()).toHaveLength(2);
  });

  it("never trusts a host result that carries only one evidence ref", async () => {
    const f = open();
    const second = f.image("img-b");
    const tool = f.mount({
      servableDescription: (request) =>
        request.mediaNoteId === second
          ? {
              note: "同一张图",
              modelName: "vision-local",
              policy: POLICY,
              attempts: 1,
              taskId: "task-identity",
              // 只有本 carrier 的媒体引用：正文被改写无法撤销，绝不交付。
              sources: [f.mediaSourceRef(second)],
            }
          : null,
    });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    const read = await tool.execute("media.note.read", { id: second }, ctx);
    expect(read.value).toMatchObject({ status: "undescribed" });
    expect(read.sources).toEqual([]);
  });

  it("never trusts a host result whose model or policy no longer matches", async () => {
    const f = open();
    const second = f.image("img-b");
    const tool = f.mount({
      servableDescription: (request) =>
        request.mediaNoteId === second
          ? {
              note: "同一张图",
              modelName: "另一个模型",
              policy: POLICY,
              attempts: 1,
              taskId: "task-identity",
              sources: [f.taskResultRef("task-identity"), f.mediaSourceRef(second)],
            }
          : null,
    });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    const read = await tool.execute("media.note.read", { id: second }, ctx);
    expect(read.value).toMatchObject({ status: "undescribed" });
    expect(read.sources).toEqual([]);
  });

  it("keeps the per-carrier row as the single source of truth when it already serves", async () => {
    const f = open();
    const first = f.image("img-a");
    const tool = f.mount({
      servableDescription: () => ({
        note: "不该出现",
        modelName: "vision-local",
        policy: POLICY,
        attempts: 9,
        taskId: "task-identity",
        sources: [f.taskResultRef("task-identity"), f.mediaSourceRef(first)],
      }),
    });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    expect((await tool.execute("media.describe", { id: first }, ctx)).value).toMatchObject({
      status: "described",
      attempt: 1,
    });
    expect(tool.stats.calls).toBe(1);
  });

  it("returns correctable feedback for an invalid question selection without spending an attempt", async () => {
    const f = open();
    const img = f.image("img-a");
    const tool = f.mount({ resolveQuestion: () => null });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    const observation = await tool.execute(
      "media.describe",
      { id: img, questionMessageId: "message-forged" },
      ctx,
    );
    expect(observation.value).toEqual({
      status: "unavailable",
      code: "CONTEXT_INVALID_SELECTION",
      recoverable: true,
    });
    expect(observation.sources).toEqual([]);
    expect(tool.stats.calls).toBe(0);
    expect(f.taskRows()).toHaveLength(0);
  });

  it("refuses a question pointer when the host resolver is not wired at all", async () => {
    const f = open();
    const img = f.image("img-a");
    const tool = f.mount({ readImage: async () => ({ category: "ordinary", images: [] }) });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    expect(
      await f.rejection(
        tool.execute("media.read", { id: img, questionMessageId: "message-1" }, ctx),
      ),
    ).toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    expect(f.taskRows()).toHaveLength(0);
  });

  it("reads a first detail through the host-frozen question key, not model wording", async () => {
    const f = open();
    const img = f.image("img-a");
    let asserted = 0;
    const tool = f.mount({
      resolveQuestion: () => ({
        questionKey: "这张图里猫在干嘛",
        eventKey: "q-1",
        bodyRevision: "body-1",
        source: { kind: "qq_message_fact", id: "q-1", revision: "body-1" },
        assertQuestionCurrent: () => {
          asserted++;
        },
      }),
    });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    const detail = await tool.execute(
      "media.describe",
      { id: img, questionMessageId: "message-q" },
      ctx,
    );
    expect(detail.value).toMatchObject({ status: "described", described: true });
    const rows = f.taskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe("detail");
    expect(rows[0]?.questionKey).toBe("这张图里猫在干嘛");
    // 问题锚在 claim 事务里真的被复验过。
    expect(asserted).toBeGreaterThan(0);
  });

  it("reuses the spent attempt for the same frozen question instead of rewording", async () => {
    const f = open();
    const img = f.image("img-a");
    const tool = f.mount({
      resolveQuestion: () => ({
        questionKey: "猫在干嘛",
        eventKey: "q-1",
        bodyRevision: "body-1",
        source: { kind: "qq_message_fact", id: "q-1", revision: "body-1" },
        assertQuestionCurrent: () => {},
      }),
    });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    expect(
      (await tool.execute("media.describe", { id: img, questionMessageId: "message-q" }, ctx))
        .value,
    ).toMatchObject({ status: "described", attempt: 1 });
    expect(
      (await tool.execute("media.describe", { id: img, questionMessageId: "message-q" }, ctx))
        .value,
    ).toMatchObject({ status: "described", attempt: 1 });
    // 同一个问题＝同一行、同一已花尝试，绝不新开任务、绝不再花一次视觉。
    expect(f.taskRows()).toHaveLength(1);
    expect(tool.stats.calls).toBe(1);
  });

  it("refuses model wording as a question parameter outright", async () => {
    const f = open();
    const img = f.image("img-a");
    const tool = f.mount({
      resolveQuestion: (): QqMediaQuestionAnchor => ({
        questionKey: "细节问题",
        eventKey: "q-1",
        bodyRevision: "body-1",
        source: { kind: "qq_message_fact", id: "q-1", revision: "body-1" },
        assertQuestionCurrent: () => {},
      }),
    });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    // 措辞不是参数：模型无法用自己的话开一个新任务键。
    expect(
      tool.execute("media.describe", { id: img, question: "换个问法" }, ctx),
    ).rejects.toThrow();
    expect(f.taskRows()).toHaveLength(0);
    expect(tool.stats.calls).toBe(0);
  });

  it("keeps a detail task separate from the baseline task for the same image", async () => {
    const f = open();
    const img = f.image("img-a");
    const tool = f.mount({
      resolveQuestion: () => ({
        questionKey: "细节问题",
        eventKey: "q-1",
        bodyRevision: "body-1",
        source: { kind: "qq_message_fact", id: "q-1", revision: "body-1" },
        assertQuestionCurrent: () => {},
      }),
    });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: img }, ctx);
    await tool.execute("media.describe", { id: img, questionMessageId: "message-q" }, ctx);
    expect(
      f
        .taskRows()
        .map((row) => row.purpose)
        .sort(),
    ).toEqual(["baseline", "detail"]);
  });

  it("passes the frozen question to the picture service and hands over the anchor guard", async () => {
    const f = open();
    const img = f.image("img-a");
    let guard: unknown;
    const tool = f.mount({
      resolveQuestion: () => ({
        questionKey: "细节问题",
        eventKey: "q-1",
        bodyRevision: "body-1",
        source: { kind: "qq_message_fact", id: "q-1", revision: "body-1" },
        assertQuestionCurrent: () => {},
      }),
      readImage: async (request) => {
        guard = request.question?.assertQuestionCurrent;
        return { category: "ordinary", images: [] };
      },
    });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    const read = await tool.execute("media.read", { id: img, questionMessageId: "message-q" }, ctx);
    expect(read.value).toMatchObject({ status: "ok", mediaId: img });
    expect(tool.stats.readImage).toEqual([{ mediaNoteId: img, questionKey: "细节问题" }]);
    // 锚的复验函数交到图片服务手里，由它在授权事务里跑（工具不越界跑别人的事务）。
    expect(typeof guard).toBe("function");
  });

  it("projects the optional question pointer from the single shared declaration", () => {
    // tool-definitions 投影的是同一份描述对象，strict 形状不允许出现措辞类参数。
    for (const name of ["media.describe", "media.read"] as const) {
      const parameters = QQ_MEDIA_TOOL_DESCRIPTIONS[name].parameters as {
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: unknown;
      };
      expect(Object.keys(parameters.properties).sort()).toEqual(["id", "questionMessageId"]);
      expect(parameters.required).toEqual(["id"]);
      expect(parameters.additionalProperties).toBe(false);
    }
  });

  it("leaves the first read shape unchanged when no question pointer is passed", async () => {
    const f = open();
    const img = f.image("img-a");
    const tool = f.mount({ readImage: async () => ({ category: "ordinary", images: [] }) });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.read", { id: img }, ctx);
    expect(tool.stats.readImage).toEqual([{ mediaNoteId: img }]);
    expect(f.taskRows()).toHaveLength(0);
  });

  it("notifies the host when a cross-carrier reuse succeeds, without spending budget", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "同一张图的字节");
    const tool = f.mount({ onDescribed: true });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: first }, ctx);
    const before = f.taskRows().map((row) => ({ id: row.id, attempts: row.attempts }));
    const reused = await tool.execute("media.describe", { id: second }, ctx);
    expect(reused.value).toMatchObject({ status: "described", attempt: 1 });
    // 复用成功＝本 carrier 本 run 拿到可服务结果，按同规则通知，报主账本行。
    expect(tool.stats.described).toEqual([
      { eventKey: "img-a", taskId: before[0]?.id },
      { eventKey: "img-b", taskId: before[0]?.id },
    ]);
    // 通知不等于新建任务：账本仍是那一行，attempts 不变，零新视觉。
    expect(f.taskRows().map((row) => ({ id: row.id, attempts: row.attempts }))).toEqual(before);
    expect(tool.stats.calls).toBe(1);
  });

  it("notifies the host on a cross-carrier detail reuse too", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "同一张图的字节");
    const tool = f.mount({
      onDescribed: true,
      resolveQuestion: () => ({
        questionKey: "细节问题",
        eventKey: "q-1",
        bodyRevision: "body-1",
        source: { kind: "qq_message_fact", id: "q-1", revision: "body-1" },
        assertQuestionCurrent: () => {},
      }),
    });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: first, questionMessageId: "message-q" }, ctx);
    const detailRow = f.taskRows().find((row) => row.purpose === "detail");
    expect(detailRow).toBeDefined();
    // fixture 守卫（非产品断言）：detail 行必须存在，否则后面的 taskId 无从取起。
    // `toBeDefined` 单独用不会 narrow 索引访问，所以这里显式收窄类型。
    if (detailRow === undefined) throw new Error("detail task fixture missing");
    const reused = await tool.execute(
      "media.describe",
      { id: second, questionMessageId: "message-q" },
      ctx,
    );
    expect(reused.value).toMatchObject({ status: "described", attempt: 1 });
    expect(tool.stats.described).toEqual([
      { eventKey: "img-a", taskId: detailRow.id },
      { eventKey: "img-b", taskId: detailRow.id },
    ]);
    // detail 与 baseline 仍是两条独立预算行，复用不合并。
    expect(f.taskRows().filter((row) => row.purpose === "detail")).toHaveLength(1);
  });

  it("refuses the cross-carrier body and stays silent once the host authority is revoked", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "同一张图的字节");
    const tool = f.mount({ onDescribed: true });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: first }, ctx);
    const before = f.taskRows().map((row) => ({ id: row.id, attempts: row.attempts }));
    // 撤权：绑定 authority revision 变化 ⇒ 授权闸在任何交付之前就失败。
    f.h.db
      .query("UPDATE qq_bindings SET authority_revision=authority_revision+1, revision=revision+1")
      .run();
    // 不交付：授权失效在范围/边界层就给出安全拒绝值（不是正文），因此**不通知**。
    const refused = await tool.execute("media.describe", { id: second }, ctx);
    expect(refused.value).toMatchObject({ status: "unavailable" });
    expect(refused.sources).toEqual([]);
    expect(tool.stats.described).toEqual([{ eventKey: "img-a", taskId: before[0]?.id }]);
    // 预算与尝试数一动不动。
    expect(f.taskRows().map((row) => ({ id: row.id, attempts: row.attempts }))).toEqual(before);
  });

  it("reports the task it actually settled when the bytes are not the same content", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "另一张图的字节");
    const tool = f.mount({ onDescribed: true });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: first }, ctx);
    const firstTask = f.taskRows()[0]?.id;
    // 不同内容＝不同身份：第二载体自己花一次预算，通知报的是它**真正结清**的那一行，
    // 不是复用来的那一行。
    expect((await tool.execute("media.describe", { id: second }, ctx)).value).toMatchObject({
      status: "described",
      attempt: 1,
    });
    const rows = f.taskRows();
    expect(rows).toHaveLength(2);
    expect(tool.stats.described).toEqual([
      { eventKey: "img-a", taskId: firstTask },
      { eventKey: "img-b", taskId: rows[1]?.id },
    ]);
  });

  it("does not notify for a plain note read", async () => {
    const f = open();
    const img = f.image("img-a");
    const tool = f.mount({ onDescribed: true });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: img }, ctx);
    const seen = tool.stats.described.length;
    const read = await tool.execute("media.note.read", { id: img }, ctx);
    expect(read.value).toMatchObject({ status: "ok" });
    // note.read 没有任务结清语义：证据走 sources，不发结清通知。
    expect(tool.stats.described).toHaveLength(seen);
  });

  it("never marks described once the host authorization moved", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "同一张图的字节");
    const tool = f.mount();
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: first }, ctx);
    // 未撤权前：跨 carrier 复用确实可服务。
    expect(
      f.listedItems(await tool.execute("media.list", {}, ctx)).find((i) => i.id === second),
    ).toMatchObject({
      described: true,
      attempts: 1,
    });
    // 撤权（绑定 authority revision 变化）＝宿主边界纪元失效：标记必须立刻收回。
    f.h.db
      .query("UPDATE qq_bindings SET authority_revision=authority_revision+1, revision=revision+1")
      .run();
    const callsBefore = tool.stats.calls;
    const after = (await tool.execute("media.list", {}, ctx)).value as ListValue;
    // 撤权后列表本身按边界拒绝（binding_changed），不披露任何 described 标记。
    expect(after.status).toBe("unavailable");
    // 零新增 fetch、零视觉：撤权只影响可见性与标记，不产生任何读取。
    expect(tool.stats.calls).toBe(callsBefore);
  });

  it("never marks described once the current carrier expired", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "同一张图的字节");
    const tool = f.mount();
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: first }, ctx);
    // 本 carrier 的窗口到期：活资产链接死 ⇒ 无同内容证明 ⇒ 标记收回。
    f.h.db
      .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE media_note_id=?")
      .run(new Date(Date.now() - 1000).toISOString(), second);
    const callsBefore = tool.stats.calls;
    const after = f.listedItems(await tool.execute("media.list", {}, ctx));
    expect(after.find((i) => i.id === second)?.described).toBe(false);
    expect(tool.stats.calls).toBe(callsBefore);
  });

  it("never marks described for a malformed detail question", async () => {
    const f = open();
    const img = f.image("img-a");
    // 宿主解析不出真实问题（正文已过期／不在本轮问题集合／图不在其范围）⇒ 零任务。
    const tool = f.mount({ resolveQuestion: () => null });
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    const listed = f.listedItems(await tool.execute("media.list", {}, ctx));
    expect(listed.find((i) => i.id === img)?.described).toBe(false);
    expect(f.taskRows()).toHaveLength(0);
    expect(tool.stats.calls).toBe(0);
  });

  it("never marks described once the group media capability epoch moves", async () => {
    const f = open();
    const first = f.image("img-a");
    const second = f.image("img-b");
    f.withAsset(first, "同一张图的字节");
    f.withAsset(second, "同一张图的字节");
    const tool = f.mount();
    const { ctx } = f.context();
    await tool.execute("media.list", {}, ctx);
    await tool.execute("media.describe", { id: first }, ctx);
    expect(
      f.listedItems(await tool.execute("media.list", {}, ctx)).find((i) => i.id === second),
    ).toMatchObject({ described: true, attempts: 1 });
    // 全局 media 开关纪元（qq_settings.revision）变化：described 的授权复验与正文交付
    // 走同一条闸，所以纪元一动标记就再也给不出——按本文件既有纪律，authority 失败
    // 原样穿透（不吞成 unavailable、不降级成一个假的「未描述」）。
    f.h.db.query("UPDATE qq_settings SET revision=revision+1").run();
    const callsBefore = tool.stats.calls;
    const error = await f.rejection(tool.execute("media.list", {}, ctx));
    expect(error).toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    // 撤权只影响可见性：不新增 fetch、不花视觉、不写账本。
    expect(tool.stats.calls).toBe(callsBefore);
    expect(f.taskRows()).toHaveLength(1);
  });
});
