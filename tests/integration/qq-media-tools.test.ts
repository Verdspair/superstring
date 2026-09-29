// 0.4.0 P5 媒体工具（ADR0019 §8.11）的宿主边界测试：合成库＋合成网关，零隐式视觉。
//
// 这里断言的全部是宿主事实：list/note.read 不碰模型、每 run 引用披露（未披露/跨会话拒绝）、
// 过期逐次复验、取消不写、describe 只回元信息、重试至多两次且只认"更晚、在窗口内、晚于上一次
// 尝试"的补充事实。

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import type { ActionContext, BuiltInAction } from "../../src/server/agent/built-in-actions";
import { assertContextSources } from "../../src/server/agent/context-access";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readBindingByConversation } from "../../src/server/db/qq-binding-repository";
import { mediaNoteRow, recordMediaSegment } from "../../src/server/db/qq-media-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_USER_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqBinding } from "../../src/server/services/qq-binding-contract";
import {
  createQqMediaTools,
  mediaNoteRevision,
  type QqMediaToolsOptions,
} from "../../src/server/services/qq-media-tools";
import type { ConversationAddressing } from "../../src/shared/contracts/conversation";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const ACCOUNT = "10001";
const PEER = "30003";
const AGENT = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";

type Reason = ConversationAddressing["reasons"][number];

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

const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
});

function expectOkPage(value: unknown): { items: MediaListItem[]; nextCursor: string | null } {
  const page = value as ListValue;
  if (page.status !== "ok") throw new Error(`expected an ok list, got ${JSON.stringify(page)}`);
  return page;
}
function expectNoteText(value: unknown): Extract<NoteReadValue, { status: "ok" }> {
  const read = value as NoteReadValue;
  if (read.status !== "ok") throw new Error(`expected a note, got ${JSON.stringify(read)}`);
  return read;
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

/** 把工具交出的引用按宿主消费路径（context-access）复验一遍。 */
function expectSourcesValid(f: ReturnType<typeof open>, sources: readonly SourceRef[]): void {
  assertContextSources({
    db: f.h.db,
    sources,
    owner: {
      kind: "conversation",
      id: f.conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: AGENT,
    },
    now: nowIso(),
    memoryRevisions: () => new Map(),
    messages: { memory: "memory changed", other: "source changed" },
  });
}
function expectSourcesRevoked(f: ReturnType<typeof open>, sources: readonly SourceRef[]): void {
  try {
    expectSourcesValid(f, sources);
  } catch (error) {
    expect((error as { code?: string }).code).toBe("CONTEXT_SOURCE_INVALID");
    return;
  }
  throw new Error("expected the sources to be revoked");
}

function open() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "qq-media-tools-test" });
  const insertBinding = (id: string, peerId: string) =>
    h.orm
      .insert(schema.qqBindings)
      .values({
        id,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId,
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
  insertBinding(BINDING_ID, PEER);
  const found = readBindingByConversation(h.orm, {
    accountId: ACCOUNT,
    kind: "group",
    peerId: PEER,
  });
  if (!found) throw new Error("binding fixture missing");
  const binding: QqBinding = found;
  const journal = new ConversationEventRepository(h.db);
  const foundConversation = journal.ensureOneBot(binding.id);
  if (!foundConversation) throw new Error("conversation fixture missing");
  const conversation = foundConversation;
  const baseSeconds = Math.floor(Date.now() / 1000);

  /** 落一条 qq_events 行（媒体行的外键先决条件），不碰 journal。 */
  function recordEvent(eventKey: string, at?: number): void {
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        messageId: `message-${eventKey}`,
        occurredAtSeconds: at ?? baseSeconds,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: nowIso(),
      })
      .run();
  }

  /** 一条已进 journal 的群消息；补充事实也只从这条通道进入。 */
  function message(
    eventKey: string,
    input: { at?: number; reasons?: readonly Reason[] } = {},
  ): void {
    recordEvent(eventKey, input.at);
    const reasons: Reason[] = input.reasons ? [...input.reasons] : ["mention"];
    journal.ingestOneBotEvent(eventKey, binding.id, { reasons, mentionIds: [] });
  }

  /** 一条带图片的消息：默认进 journal（可披露）；hidden 用于"有行但从未披露"。 */
  function image(
    eventKey: string,
    input: { at?: number; sourceRef?: string; hidden?: boolean } = {},
  ): NonNullable<ReturnType<typeof mediaNoteRow>> {
    if (input.hidden) recordEvent(eventKey, input.at);
    else message(eventKey, { at: input.at });
    recordMediaSegment(h.orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef: input.sourceRef ?? `ref-${eventKey}`,
      occurredAtSeconds: input.at ?? baseSeconds,
      addressed: true,
    });
    const row = mediaNoteRow(h.orm, eventKey, 0);
    if (!row) throw new Error("media fixture missing");
    return row;
  }

  function secondConversation(): { binding: QqBinding; conversationId: string } {
    insertBinding("22222222-2222-4222-8222-222222222222", "30004");
    const other = readBindingByConversation(h.orm, {
      accountId: ACCOUNT,
      kind: "group",
      peerId: "30004",
    });
    if (!other) throw new Error("second binding fixture missing");
    const otherConversation = journal.ensureOneBot(other.id);
    if (!otherConversation) throw new Error("second conversation fixture missing");
    return { binding: other, conversationId: otherConversation.id };
  }

  function mount(
    input: {
      read?: (input: { kind: string; sourceRef: string }) => Promise<string>;
      fit?: QqMediaToolsOptions["fit"];
      modelConfig?: QqMediaToolsOptions["modelConfig"];
      conversationId?: string;
      binding?: QqBinding;
    } = {},
  ) {
    const stats = { calls: 0, described: [] as string[] };
    const actions = createQqMediaTools({
      db: h.db,
      orm: h.orm,
      conversationId: input.conversationId ?? conversation.id,
      binding: input.binding ?? binding,
      adapter: {
        capabilities: ["image"] as const,
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
      assertCurrent: () => {},
      fit: input.fit ?? (async () => () => true),
      onDescribed: (eventKey) => {
        stats.described.push(eventKey);
      },
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
    secondConversation,
    mount,
    context,
  };
}

describe("run-scoped QQ media tools", () => {
  it("lists bounded image metadata without touching the model", async () => {
    const f = open();
    try {
      const first = f.image("img-1", { at: f.baseSeconds });
      const second = f.image("img-2", { at: f.baseSeconds + 1 });
      // 同一消息里的文件片段：不是图片，绝不出现在列表里。
      recordMediaSegment(f.h.orm, {
        eventKey: "img-1",
        segmentIndex: 1,
        kind: "file",
        sourceRef: "ref-file",
        occurredAtSeconds: f.baseSeconds,
        addressed: true,
      });
      const tool = f.mount({
        read: async () => {
          throw new Error("must not run");
        },
      });
      const { ctx } = f.context();
      const page1 = expectOkPage((await tool.execute("media.list", { limit: 1 }, ctx)).value);
      expect(page1.items).toEqual([
        {
          id: second.id,
          eventKey: "img-2",
          index: 0,
          kind: "image",
          described: false,
          attempts: 0,
        },
      ]);
      // 元数据里没有取流引用或正文。
      expect(JSON.stringify(page1)).not.toContain("ref-img-2");
      expect(page1.nextCursor).toBeString();
      if (page1.nextCursor === null) throw new Error("missing cursor");
      const page2 = expectOkPage(
        (await tool.execute("media.list", { limit: 1, cursor: page1.nextCursor }, ctx)).value,
      );
      expect(page2.items).toEqual([
        {
          id: first.id,
          eventKey: "img-1",
          index: 0,
          kind: "image",
          described: false,
          attempts: 0,
        },
      ]);
      expect(page2.nextCursor).toBeNull();
      const read = await tool.execute("media.note.read", { id: first.id }, ctx);
      expect(read.value).toEqual({ status: "undescribed", id: first.id, attempts: 0 });
      expect(read.sources).toEqual([]);
      expect(tool.stats.calls).toBe(0);
      expect(tool.stats.described).toEqual([]);
    } finally {
      f.h.close();
    }
  });

  it("describes once, then reads the stored note by code points with its model", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount({ read: async () => "甲乙丙丁" });
      const { ctx } = f.context();
      await tool.execute("media.list", {}, ctx);
      const described = await tool.execute("media.describe", { id: img.id }, ctx);
      expect(described.value).toEqual({ status: "described", described: true, attempt: 1 });
      // 成功正文带两种引用：qq_media 管删除与 attempts，qq_media_note 管正文修订（稳定哈希）。
      const expectedRevision = createHash("sha256")
        .update(JSON.stringify(["甲乙丙丁", "vision-local", 1, "img-1"]))
        .digest("hex");
      expect(described.sources).toHaveLength(2);
      expect(described.sources[0]).toMatchObject({ kind: "qq_media", id: img.id, revision: "1" });
      expect(described.sources[1]).toMatchObject({
        kind: "qq_media_note",
        id: img.id,
        revision: expectedRevision,
      });
      const storedRow = mediaNoteRow(f.h.orm, "img-1", 0);
      if (!storedRow) throw new Error("media fixture missing");
      expect(mediaNoteRevision(storedRow)).toBe(expectedRevision);
      expectSourcesValid(f, described.sources);
      // describe 只回元信息：正文不在它的值里。
      expect(JSON.stringify(described.value)).not.toContain("甲乙丙丁");
      expect(tool.stats.calls).toBe(1);
      expect(tool.stats.described).toEqual(["img-1"]);
      const headObservation = await tool.execute("media.note.read", { id: img.id, limit: 2 }, ctx);
      expect(expectNoteText(headObservation.value)).toEqual({
        status: "ok",
        id: img.id,
        model: "vision-local",
        text: "甲乙",
        offset: 0,
        nextOffset: 2,
      });
      expect(headObservation.sources).toHaveLength(2);
      expectSourcesValid(f, headObservation.sources);
      const tail = expectNoteText(
        (await tool.execute("media.note.read", { id: img.id, offset: 2, limit: 2 }, ctx)).value,
      );
      expect(tail).toMatchObject({ text: "丙丁", offset: 2, nextOffset: null });
      expect(tool.stats.calls).toBe(1);
      // 同一 attempts 内的正文改写：qq_media 看不见（attempts 未变），qq_media_note 能检出。
      f.h.orm.update(schema.qqMediaNotes).set({ note: "被改写的描述" }).run();
      expectSourcesValid(f, [described.sources[0]]);
      expectSourcesRevoked(f, [described.sources[1]]);
    } finally {
      f.h.close();
    }
  });

  it("reuses one description for the same reference without a second call", async () => {
    const f = open();
    try {
      const first = f.image("img-a", { sourceRef: "shared-ref" });
      const second = f.image("img-b", { at: f.baseSeconds + 1, sourceRef: "shared-ref" });
      const tool = f.mount({ read: async () => "橘猫" });
      const { ctx } = f.context();
      await tool.execute("media.list", {}, ctx);
      expect((await tool.execute("media.describe", { id: first.id }, ctx)).value).toEqual({
        status: "described",
        described: true,
        attempt: 1,
      });
      expect((await tool.execute("media.describe", { id: second.id }, ctx)).value).toEqual({
        status: "described",
        described: true,
        attempt: 0,
      });
      expect(tool.stats.calls).toBe(1);
      expect(mediaNoteRow(f.h.orm, "img-b", 0)).toMatchObject({
        note: "橘猫",
        noteModel: "vision-local",
        attempts: 0,
      });
      expect(tool.stats.described).toEqual(["img-a", "img-b"]);
    } finally {
      f.h.close();
    }
  });

  it("refuses ids this run never disclosed and never accepts model-supplied authorisation", async () => {
    const f = open();
    try {
      const visible = f.image("img-1");
      const hidden = f.image("img-hidden", { hidden: true });
      const tool = f.mount();
      const { ctx } = f.context();
      await tool.execute("media.list", {}, ctx);
      await expect(tool.execute("media.describe", { id: hidden.id }, ctx)).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
      await expect(tool.execute("media.note.read", { id: hidden.id }, ctx)).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
      // 模型的授权布尔不能进参数：schema 是 strict 的。
      await expect(
        tool.execute("media.describe", { id: visible.id, addressedToAssistant: true }, ctx),
      ).rejects.toThrow();
      expect(tool.stats.calls).toBe(0);
      expect(mediaNoteRow(f.h.orm, "img-hidden", 0)?.attempts).toBe(0);
      expect(mediaNoteRow(f.h.orm, "img-1", 0)?.attempts).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("refuses an id disclosed in another conversation even in the same run context", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount();
      const { ctx } = f.context();
      await tool.execute("media.list", {}, ctx);
      const elsewhere = f.secondConversation();
      const other = f.mount({
        conversationId: elsewhere.conversationId,
        binding: elsewhere.binding,
      });
      const elsewhereCtx = f.context("run-1", {
        kind: "conversation",
        id: elsewhere.conversationId,
      });
      await other.execute("media.list", {}, elsewhereCtx.ctx);
      await expect(
        other.execute("media.describe", { id: img.id }, elsewhereCtx.ctx),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
      expect(other.stats.calls).toBe(0);
      expect(mediaNoteRow(f.h.orm, "img-1", 0)?.attempts).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("refuses a segment that expired after it was listed", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount();
      const { ctx } = f.context();
      const page = expectOkPage((await tool.execute("media.list", {}, ctx)).value);
      expect(page.items).toHaveLength(1);
      f.h.orm.update(schema.qqMediaNotes).set({ expiresAt: "2000-01-01T00:00:00.000Z" }).run();
      expect((await tool.execute("media.describe", { id: img.id }, ctx)).value).toEqual({
        status: "unavailable",
        code: "segment_expired",
      });
      expect((await tool.execute("media.note.read", { id: img.id }, ctx)).value).toEqual({
        status: "unavailable",
        code: "segment_expired",
      });
      expect(tool.stats.calls).toBe(0);
      expect(mediaNoteRow(f.h.orm, "img-1", 0)?.note).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("never spends an attempt without a configured vision model", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount({
        modelConfig: { visionModelName: null, transcriptionModelName: null },
      });
      const { ctx } = f.context();
      await tool.execute("media.list", {}, ctx);
      expect((await tool.execute("media.describe", { id: img.id }, ctx)).value).toEqual({
        status: "unavailable",
        code: "model_not_configured",
      });
      expect(tool.stats.calls).toBe(0);
      expect(mediaNoteRow(f.h.orm, "img-1", 0)?.attempts).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("cancels a describe without claiming or writing anything", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount({ read: async () => "迟到" });
      const { controller, ctx } = f.context();
      await tool.execute("media.list", {}, ctx);
      controller.abort();
      const error = await rejection(tool.execute("media.describe", { id: img.id }, ctx));
      expect((error as { name?: string }).name).toBe("AbortError");
      expect(tool.stats.calls).toBe(0);
      expect(mediaNoteRow(f.h.orm, "img-1", 0)).toMatchObject({ attempts: 0, note: null });
    } finally {
      f.h.close();
    }
  });

  it("rejects a cancelled in-flight describe instead of recording success or failure", async () => {
    const f = open();
    try {
      const { controller, ctx } = f.context();
      const img = f.image("img-1");
      const tool = f.mount({
        read: async () => {
          controller.abort();
          return "迟到的描述";
        },
      });
      await tool.execute("media.list", {}, ctx);
      const error = await rejection(tool.execute("media.describe", { id: img.id }, ctx));
      expect((error as { name?: string }).name).toBe("AbortError");
      const row = mediaNoteRow(f.h.orm, "img-1", 0);
      expect(row?.note).toBeNull();
      // 尝试在取流前已认领：取消不写回，但这一次尝试不被取消"复活"。
      expect(row?.attempts).toBe(1);
    } finally {
      f.h.close();
    }
  });

  it("answers a too-large result with the standard budget refusal, not a truncated one", async () => {
    const f = open();
    try {
      f.image("img-1");
      const tool = f.mount({ fit: async () => () => false });
      const { ctx } = f.context();
      const denied = await tool.execute("media.list", {}, ctx);
      expect(denied.value).toEqual({ status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" });
      expect(denied.sources).toEqual([]);
    } finally {
      f.h.close();
    }
  });

  it("degrades a list page to what fits without losing entries", async () => {
    const f = open();
    try {
      const a = f.image("img-a", { at: f.baseSeconds });
      const b = f.image("img-b", { at: f.baseSeconds + 1 });
      const c = f.image("img-c", { at: f.baseSeconds + 2 });
      const tool = f.mount({
        fit: async () => (value) => {
          const items = (value as { items?: unknown[] }).items;
          return Array.isArray(items) && items.length <= 1;
        },
      });
      const { ctx } = f.context();
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 3; page++) {
        const arguments_ = cursor === null ? { limit: 3 } : { limit: 3, cursor };
        const result = expectOkPage((await tool.execute("media.list", arguments_, ctx)).value);
        expect(result.items).toHaveLength(1);
        ids.push(...result.items.map((item) => item.id));
        cursor = result.nextCursor;
      }
      expect(ids).toEqual([c.id, b.id, a.id]);
    } finally {
      f.h.close();
    }
  });

  it("burns at most two attempts and only for a later, in-window supplement newer than the last one", async () => {
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
      const first = {
        status: "failed",
        described: false,
        attempt: 1,
        awaitSupplement: true,
      };
      expect((await tool.execute("media.describe", { id: img.id }, run1.ctx)).value).toEqual(first);
      expect(tool.stats.calls).toBe(1);
      // 同 run 重复 describe 不烧第二次，即使这一轮已具备重试资格。
      expect((await tool.execute("media.describe", { id: img.id }, run1.ctx)).value).toEqual(first);
      expect(tool.stats.calls).toBe(1);

      // 更晚、在窗口内，但早于"上一次尝试"的补充不是新事实。
      f.message("stale-supp", { at: f.baseSeconds - 60, reasons: ["mention"] });
      const run2 = f.context("run-2");
      await tool.execute("media.list", {}, run2.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run2.ctx)).value).toEqual({
        status: "unavailable",
        code: "awaiting_supplement",
      });
      expect(tool.stats.calls).toBe(1);

      // 有效补充：晚于原图、在窗口内、晚于上一次尝试、群成员的 @。
      f.message("fresh-supp", { at: f.baseSeconds + 90, reasons: ["mention"] });
      const run3 = f.context("run-3");
      await tool.execute("media.list", {}, run3.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run3.ctx)).value).toEqual({
        status: "failed",
        described: false,
        attempt: 2,
        awaitSupplement: false,
      });
      expect(tool.stats.calls).toBe(2);

      // 两次用尽之后，再有补充也不再尝试，且模型无从传递授权。
      f.message("late-supp", { at: f.baseSeconds + 150, reasons: ["mention"] });
      const run4 = f.context("run-4");
      await tool.execute("media.list", {}, run4.ctx);
      expect((await tool.execute("media.describe", { id: img.id }, run4.ctx)).value).toEqual({
        status: "unavailable",
        code: "attempts_exhausted",
      });
      expect(tool.stats.calls).toBe(2);
      expect(mediaNoteRow(f.h.orm, "img-1", 0)).toMatchObject({ attempts: 2, note: null });
    } finally {
      f.h.close();
    }
  });

  it("releases run state idempotently and keeps describe out of sandbox callables", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount();
      const { ctx } = f.context();
      expect(tool.named("media.describe").sandboxCallable).toBe(false);
      expect(tool.named("media.describe").description.effect).toBe("write");
      expect(tool.named("media.list").description.effect).toBe("read");
      expect(tool.named("media.note.read").description.effect).toBe("read");
      await tool.execute("media.list", {}, ctx);
      // 运行态挂着一张表的 abort 监听；release 必须把它连表一起回收。
      expect(getEventListeners(ctx.signal, "abort")).toHaveLength(1);
      tool.release(ctx);
      expect(getEventListeners(ctx.signal, "abort")).toHaveLength(0);
      tool.release(ctx);
      await expect(tool.execute("media.describe", { id: img.id }, ctx)).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
      expect(tool.stats.calls).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("serves only the wired owners and rejects every other owner shape on the same factory", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount();
      const wired = f.context("run-owner");
      const page = expectOkPage((await tool.execute("media.list", {}, wired.ctx)).value);
      expect(page.items).toHaveLength(1);
      // 同一绑定的 qq_binding owner 也是合法形状（独立披露命名空间）。
      const bound = f.context("run-owner", { kind: "qq_binding", id: BINDING_ID });
      const boundPage = expectOkPage((await tool.execute("media.list", {}, bound.ctx)).value);
      expect(boundPage.items).toHaveLength(1);

      const elsewhere = f.secondConversation();
      const wrongOwners: Partial<ActionContext["owner"]>[] = [
        { userId: "user-1" },
        { agentId: "00000000-0000-0000-0000-0000000000ff" },
        { id: elsewhere.conversationId },
        { kind: "qq_binding", id: elsewhere.binding.id },
        { kind: "test", id: "turn" },
      ];
      for (const owner of wrongOwners) {
        const wrong = f.context("run-owner", owner);
        for (const name of ["media.list", "media.note.read", "media.describe"]) {
          await expect(
            tool.execute(name, { id: img.id }, wrong.ctx),
            `${name} with ${JSON.stringify(owner)}`,
          ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
        }
      }
      // 接线内的调用照常，且这些失败没有留下任何运行态或视觉花费。
      expect((await tool.execute("media.describe", { id: img.id }, wired.ctx)).value).toEqual({
        status: "described",
        described: true,
        attempt: 1,
      });
      expect(tool.stats.calls).toBe(1);
    } finally {
      f.h.close();
    }
  });

  it("keeps cursors opaque and per-run: forged, cross-run and released tokens are refused", async () => {
    const f = open();
    try {
      const first = f.image("img-a", { at: f.baseSeconds });
      f.image("img-b", { at: f.baseSeconds + 1 });
      const tool = f.mount();
      const { ctx } = f.context("run-cursor");
      const page = expectOkPage((await tool.execute("media.list", { limit: 1 }, ctx)).value);
      expect(page.items[0]?.eventKey).toBe("img-b");
      const cursor = page.nextCursor;
      if (cursor === null) throw new Error("missing cursor");

      const tampered = cursor.slice(0, -1) + (cursor.endsWith("0") ? "1" : "0");
      await expect(
        tool.execute("media.list", { limit: 1, cursor: tampered }, ctx),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
      await expect(
        tool.execute("media.list", { limit: 1, cursor: "forged-token" }, ctx),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });

      // 别的 run 里没有这张表：续页不自动建表，跨 run 的游标不成立。
      const other = f.context("run-other");
      await expect(
        tool.execute("media.list", { limit: 1, cursor }, other.ctx),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });

      // 本 run 自己的续页照常。
      const page2 = expectOkPage(
        (await tool.execute("media.list", { limit: 1, cursor }, ctx)).value,
      );
      expect(page2.items[0]?.id).toBe(first.id);
      expect(page2.nextCursor).toBeNull();

      // release 之后同一 token 也拒绝：游标不跨运行态生命周期。
      tool.release(ctx);
      await expect(tool.execute("media.list", { limit: 1, cursor }, ctx)).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
    } finally {
      f.h.close();
    }
  });

  it("recycles run state when its own signal aborts and ignores foreign signals", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      const tool = f.mount();
      const own = f.context("run-abort");
      await tool.execute("media.list", {}, own.ctx);

      // 外部信号（不是建立这张表的那个）中止：只让在飞调用失败，不回收运行态。
      const foreign = f.context("run-abort");
      foreign.controller.abort();
      await expect(
        tool.execute("media.describe", { id: img.id }, foreign.ctx),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(tool.stats.calls).toBe(0);
      const again = f.context("run-abort");
      expect((await tool.execute("media.describe", { id: img.id }, again.ctx)).value).toEqual({
        status: "described",
        described: true,
        attempt: 1,
      });
      expect(tool.stats.calls).toBe(1);

      // 建立这张表的信号中止＝回收：新信号也不能再消费旧披露，监听器被回收。
      expect(getEventListeners(own.ctx.signal, "abort")).toHaveLength(1);
      own.controller.abort();
      expect(getEventListeners(own.ctx.signal, "abort")).toHaveLength(0);
      const after = f.context("run-abort");
      await expect(
        tool.execute("media.note.read", { id: img.id }, after.ctx),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
      // 已回收的状态上再次 release 是幂等空操作。
      tool.release(own.ctx);
      tool.release(own.ctx);
      expect(tool.stats.calls).toBe(1);
    } finally {
      f.h.close();
    }
  });

  it("never returns a note changed, revoked or deleted while the result waited for fit", async () => {
    const f = open();
    try {
      // (a) 等待 fit 期间正文被改写（attempts 不变）：不给旧正文，也不给引用。
      const first = f.image("img-1");
      const changed = f.mount({
        fit: async (name) => {
          let fired = false;
          return () => {
            if (name === "media.note.read" && !fired) {
              fired = true;
              f.h.orm.update(schema.qqMediaNotes).set({ note: "改写后的描述" }).run();
            }
            return true;
          };
        },
      });
      const runA = f.context("run-fit-a");
      await changed.execute("media.list", {}, runA.ctx);
      await changed.execute("media.describe", { id: first.id }, runA.ctx);
      const stale = await changed.execute("media.note.read", { id: first.id }, runA.ctx);
      expect(stale.value).toEqual({ status: "unavailable", code: "segment_changed" });
      expect(stale.sources).toEqual([]);
      expect(JSON.stringify(stale.value)).not.toContain("橘猫");

      // (b) 等待 fit 期间行被删除：列表不披露已失效的元数据，也不假装披露过。
      const third = f.image("img-3");
      const swept = f.mount({
        fit: async (name) => {
          let fired = false;
          return () => {
            if (name === "media.list" && !fired) {
              fired = true;
              f.h.db.query("DELETE FROM qq_media_notes WHERE id=?").run(third.id);
            }
            return true;
          };
        },
      });
      const runB = f.context("run-fit-b");
      const refused = await swept.execute("media.list", {}, runB.ctx);
      expect(refused.value).toEqual({ status: "unavailable", code: "segment_missing" });
      expect(refused.sources).toEqual([]);
      await expect(
        swept.execute("media.describe", { id: third.id }, runB.ctx),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });

      // (c) 等待 fit 期间绑定被暂停（撤权）：同样拒绝，绝不交出正文或引用。
      const second = f.image("img-2");
      const revoked = f.mount({
        fit: async (name) => {
          let fired = false;
          return () => {
            if (name === "media.note.read" && !fired) {
              fired = true;
              f.h.orm.update(schema.qqBindings).set({ paused: 1 }).run();
            }
            return true;
          };
        },
      });
      const runC = f.context("run-fit-c");
      await revoked.execute("media.list", {}, runC.ctx);
      await revoked.execute("media.describe", { id: second.id }, runC.ctx);
      const denied = await revoked.execute("media.note.read", { id: second.id }, runC.ctx);
      expect(denied.value).toEqual({ status: "unavailable", code: "binding_changed" });
      expect(denied.sources).toEqual([]);
    } finally {
      f.h.close();
    }
  });

  it("spends no attempt and no model call when the description envelope cannot fit", async () => {
    const f = open();
    try {
      const img = f.image("img-1");
      let allowed = false;
      const tool = f.mount({
        fit: async (name) => (name === "media.describe" ? () => allowed : () => true),
      });
      const { ctx } = f.context("run-budget");
      await tool.execute("media.list", {}, ctx);
      const denied = await tool.execute("media.describe", { id: img.id }, ctx);
      expect(denied.value).toEqual({ status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" });
      expect(denied.sources).toEqual([]);
      expect(tool.stats.calls).toBe(0);
      expect(mediaNoteRow(f.h.orm, "img-1", 0)).toMatchObject({ attempts: 0, note: null });

      // 预算拒绝不写结果缓存：放开预算后同一 run 的第二次调用真的去读。
      allowed = true;
      const described = await tool.execute("media.describe", { id: img.id }, ctx);
      expect(described.value).toEqual({ status: "described", described: true, attempt: 1 });
      expect(tool.stats.calls).toBe(1);
      expect(mediaNoteRow(f.h.orm, "img-1", 0)).toMatchObject({
        attempts: 1,
        note: "橘猫",
        noteModel: "vision-local",
      });
    } finally {
      f.h.close();
    }
  });

  it("answers the per-run disclosure cap with the standard budget refusal, not an exception", async () => {
    const f = open();
    try {
      const total = 600;
      for (let index = 0; index < total; index++)
        f.image(`cap-${String(index).padStart(4, "0")}`, { at: f.baseSeconds + index });
      const tool = f.mount();
      const { ctx } = f.context("run-cap");
      let cursor: string | null = null;
      let disclosed = 0;
      let refused: ListValue | null = null;
      for (let call = 0; call < 32; call++) {
        const value = (
          await tool.execute(
            "media.list",
            cursor === null ? { limit: 50 } : { limit: 50, cursor },
            ctx,
          )
        ).value as ListValue;
        if (value.status === "unavailable") {
          refused = value;
          break;
        }
        disclosed += value.items.length;
        cursor = value.nextCursor;
        if (cursor === null) break;
      }
      // 上限恰好在 512 处兑现：先降级到剩余额度，之后只回安全拒绝值。
      expect(disclosed).toBe(512);
      expect(refused).toEqual({ status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" });
    } finally {
      f.h.close();
    }
  });

  it("caps per-run cursors: replaying one cursor cannot grow the token map without bound", async () => {
    const f = open();
    try {
      f.image("img-a", { at: f.baseSeconds });
      f.image("img-b", { at: f.baseSeconds + 1 });
      f.image("img-c", { at: f.baseSeconds + 2 });
      const tool = f.mount();
      const { ctx } = f.context("run-cursor-cap");
      const first = expectOkPage((await tool.execute("media.list", { limit: 1 }, ctx)).value);
      expect(first.nextCursor).toBeString();
      if (first.nextCursor === null) throw new Error("missing cursor");
      // 用同一个游标反复续页：每次都发新 token（同一页尾位置），披露不增长。
      let ok = 0;
      let refused: ListValue | null = null;
      for (let call = 0; call < 600; call++) {
        const value = (
          await tool.execute("media.list", { limit: 1, cursor: first.nextCursor }, ctx)
        ).value as ListValue;
        if (value.status === "unavailable") {
          refused = value;
          break;
        }
        expect(value.items.map((item) => item.eventKey)).toEqual(["img-b"]);
        ok++;
      }
      // 表里已有 1 个游标，另有 511 次续页各存 1 个；第 512 个游标起只回安全拒绝值。
      expect(ok).toBe(511);
      expect(refused).toEqual({ status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" });
    } finally {
      f.h.close();
    }
  });
});
