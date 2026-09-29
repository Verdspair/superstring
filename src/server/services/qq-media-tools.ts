// 0.4.0 P5 媒体工具（ADR0019 §8.11）：list 列本会话已记录的图片元数据，note.read 只读已存描述，
// describe 显式花一次读取（effect=write）。addressed/relatedSupplement 等授权事实由宿主从 journal
// 得出，模型只给 id 与分页参数；note.read/describe 只认本 run 由 media.list 披露过的 id，只有成功
// 描述才带 qq_media（删除触发器）与 qq_media_note（正文修订）引用。

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { ActionContext, BuiltInAction, EvidenceResultFitter } from "../agent/built-in-actions";
import type { ActionObservation } from "../agent/context-engine";
import { readBindingByConversation } from "../db/qq-binding-repository";
import type { QqMediaNoteRow } from "../db/qq-media-repository";
import { DEFAULT_USER_ID, nowIso, type Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { fail } from "../errors";
import type { QqBinding } from "./qq-binding-contract";
import { type QqMediaReadAdapter, readQqMediaOnce } from "./qq-media-reader";

/** 列表项只有元数据：取流引用、url、路径与正文一概不出现。 */
interface MediaListItem {
  readonly id: string;
  readonly eventKey: string;
  readonly index: number;
  readonly kind: "image";
  readonly described: boolean;
  readonly attempts: number;
}
type ListValue =
  | { readonly status: "ok"; readonly items: MediaListItem[]; readonly nextCursor: string | null }
  | { readonly status: "unavailable"; readonly code: string };
type NoteReadValue =
  | {
      readonly status: "ok";
      readonly id: string;
      readonly model: string;
      readonly text: string;
      readonly offset: number;
      readonly nextOffset: number | null;
    }
  | { readonly status: "undescribed"; readonly id: string; readonly attempts: number }
  | { readonly status: "unavailable"; readonly code: string };
type DescribeValue =
  | { readonly status: "described"; readonly described: true; readonly attempt: number }
  | {
      readonly status: "failed";
      readonly described: false;
      readonly attempt: number;
      readonly awaitSupplement: boolean;
    }
  | { readonly status: "unavailable"; readonly code: string };
interface DescribeOutcome {
  readonly value: DescribeValue;
  readonly sources: SourceRef[];
}

const ListSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).optional().describe("Page size, at most 50."),
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("nextCursor from the previous page with the same limit."),
});
const NoteReadSchema = z.strictObject({
  id: z.string().min(1).max(4096).describe("An id returned by media.list in this run."),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(4096).optional().describe("Page size in Unicode characters."),
});
const DescribeSchema = z.strictObject({
  id: z.string().min(1).max(4096).describe("An image id returned by media.list in this run."),
});

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_READ_LIMIT = 2048;
/** 补充扫描的有界行数：窗口内最多看这么多条 journal 入站消息。 */
const SUPPLEMENT_SCAN_LIMIT = 200;
/** 每 run 的上限：到顶一律给安全 unavailable，绝不抛无码异常。 */
const MAX_DISCLOSED = 512;
const MAX_CURSORS = 512;

export interface QqMediaToolsOptions {
  readonly db: Database;
  readonly orm: Orm;
  readonly conversationId: string;
  readonly binding: QqBinding;
  readonly adapter: QqMediaReadAdapter;
  readonly modelConfig: {
    readonly visionModelName: string | null;
    readonly transcriptionModelName: string | null;
  };
  readonly supplementWindowMinutes: number;
  readonly assertCurrent: () => void;
  readonly fit: (
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<EvidenceResultFitter>;
  /** 宿主时钟（nowIso 形状）；省略＝真实时钟。过期与补充窗口都用它。 */
  readonly now?: () => string;
  /** 某 event 的图片已有描述时通知宿主登记 media revision；宿主必须幂等（同 run 会重复触发）。 */
  readonly onDescribed?: (eventKey: string) => void;
}

/** 与内建证据工具相同的运行态键：同一 (owner, runId) 的三个工具共享一张披露表。 */
function contextKey(context: Pick<ActionContext, "owner" | "runId">): string {
  const { kind, id, userId, agentId } = context.owner;
  return JSON.stringify([context.runId ?? null, kind, id, userId ?? null, agentId ?? null]);
}
/** 续页游标：per-run 随机 token → 页尾 keyset 位置；不可伪造、不跨 run。 */
interface ListCursor {
  readonly occurredAtSeconds: number;
  readonly eventKey: string;
  readonly segmentIndex: number;
}
interface MediaRunState {
  readonly key: string;
  /** 建立这张表的信号；只有它中止才回收整张表。 */
  readonly signal: AbortSignal;
  active: boolean;
  readonly disclosed: Set<string>;
  readonly outcomes: Map<string, DescribeOutcome>;
  readonly cursors: Map<string, ListCursor>;
  release(): void;
}

/**
 * `qq_media_note` 引用的修订：note/noteModel/attempts/eventKey 任一变化（含同一 attempt 内的
 * 正文改写）都会改变；`context-access.sourceAccess` 对同一 kind 复算同一哈希。
 */
export function mediaNoteRevision(row: QqMediaNoteRow): string {
  return createHash("sha256")
    .update(JSON.stringify([row.note, row.noteModel, row.attempts, row.eventKey]))
    .digest("hex");
}

export function createQqMediaTools(options: QqMediaToolsOptions): BuiltInAction[] {
  const binding = options.binding;
  const identity = { accountId: binding.accountId, kind: binding.kind, peerId: binding.peerId };
  const now = () => options.now?.() ?? nowIso();
  const journalKey = (eventKey: string) => `onebot:${eventKey}`;
  const unavailableValue = () => ({ status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" });

  /** 接线校验：只接受这条绑定在用的会话/绑定 owner；其余形状一律 CONTEXT_SOURCE_INVALID。 */
  function assertWired(context: ActionContext): void {
    const { kind, id, userId, agentId } = context.owner;
    const wired =
      userId === DEFAULT_USER_ID &&
      agentId === binding.agentId &&
      ((kind === "conversation" && id === options.conversationId) ||
        (kind === "qq_binding" && id === binding.id));
    if (!wired) fail("CONTEXT_SOURCE_INVALID", "媒体工具与调用方接线不一致");
  }

  const runs = new Map<string, MediaRunState>();
  /** 释放某个 (owner, runId) 下的全部运行态；对不存在的范围是空操作（幂等）。 */
  function releaseRun(scope: Pick<ActionContext, "owner" | "runId">): void {
    runs.get(contextKey(scope))?.release();
  }
  function runState(context: ActionContext, create: boolean): MediaRunState {
    context.signal.throwIfAborted();
    const key = contextKey(context);
    const existing = runs.get(key);
    if (existing) return existing;
    if (!create) fail("CONTEXT_INVALID_SELECTION", "媒体引用不属于本轮已披露的列表");
    const state: MediaRunState = {
      key,
      signal: context.signal,
      active: true,
      disclosed: new Set(),
      outcomes: new Map(),
      cursors: new Map(),
      release() {
        state.active = false;
        state.disclosed.clear();
        state.outcomes.clear();
        state.cursors.clear();
        state.signal.removeEventListener("abort", state.release);
        if (runs.get(key) === state) runs.delete(key);
      },
    };
    runs.set(key, state);
    // 只认建立这张表的信号：外部调用的信号中止只让在飞调用失败，不回收运行态。
    state.signal.addEventListener("abort", state.release, { once: true });
    return state;
  }
  /** 每个边界都复验：取消、运行态、宿主权威、宿主当前性。 */
  function boundary(state: MediaRunState, context: ActionContext): void {
    context.signal.throwIfAborted();
    if (!state.active || state.key !== contextKey(context))
      fail("CONTEXT_INVALID_SELECTION", "引用不属于本轮已披露的媒体");
    context.assertAuthority?.();
    options.assertCurrent();
  }

  interface ConversationRow {
    source_id: string;
    agent_id: string;
  }
  function conversationRow(): ConversationRow | null {
    return (
      (options.db
        .query("SELECT source_id,agent_id FROM conversations WHERE id=? AND closed_at IS NULL")
        .get(options.conversationId) as ConversationRow | null) ?? null
    );
  }
  function mediaRowById(id: string): QqMediaNoteRow | null {
    return (
      options.orm.select().from(schema.qqMediaNotes).where(eq(schema.qqMediaNotes.id, id)).get() ??
      null
    );
  }
  function eventRow(eventKey: string): typeof schema.qqEvents.$inferSelect | null {
    return (
      options.orm
        .select()
        .from(schema.qqEvents)
        .where(eq(schema.qqEvents.eventKey, eventKey))
        .get() ?? null
    );
  }
  /** 成功描述才有的删除触发器引用：note 存在 ⇒ attempts 不再变化 ⇒ revision 不漂移。 */
  function mediaRef(row: QqMediaNoteRow): SourceRef {
    return {
      kind: "qq_media",
      id: row.id,
      revision: String(row.attempts),
      expiresAt: row.expiresAt,
    };
  }
  /** 成功描述才有的完整引用：qq_media 管删除，qq_media_note 管正文修订（同 attempt 改写也失效）。 */
  function noteRefs(row: QqMediaNoteRow): SourceRef[] {
    if (row.note === null || row.noteModel === null) return [];
    return [
      mediaRef(row),
      {
        kind: "qq_media_note",
        id: row.id,
        revision: mediaNoteRevision(row),
        expiresAt: row.expiresAt,
      },
    ];
  }

  type Scope = { ok: true; reasons: readonly string[] } | { ok: false; code: string };
  /** 范围 / owner / 绑定 / 过期逐次复验。失效一律是安全拒绝值，不是异常。 */
  function scopeFor(row: QqMediaNoteRow, event: typeof schema.qqEvents.$inferSelect): Scope {
    const conversation = conversationRow();
    if (
      !conversation ||
      conversation.source_id !== binding.id ||
      conversation.agent_id !== binding.agentId
    )
      return { ok: false, code: "conversation_changed" };
    const current = readBindingByConversation(options.orm, identity);
    if (
      !current ||
      current.id !== binding.id ||
      current.agentId !== binding.agentId ||
      current.paused ||
      current.revision !== binding.revision
    )
      return { ok: false, code: "binding_changed" };
    if (
      event.accountId !== binding.accountId ||
      event.conversationKind !== binding.kind ||
      event.peerId !== binding.peerId ||
      event.agentId !== binding.agentId
    )
      return { ok: false, code: "conversation_changed" };
    const journal = options.db
      .query(
        "SELECT addressing FROM conversation_events WHERE conversation_id=? AND event_key=? AND kind='inbound'",
      )
      .get(options.conversationId, journalKey(row.eventKey)) as { addressing: string } | null;
    if (!journal) return { ok: false, code: "conversation_changed" };
    if (Date.parse(row.expiresAt) <= Date.parse(now()))
      return { ok: false, code: "segment_expired" };
    let reasons: readonly string[] = [];
    try {
      const addressing = JSON.parse(journal.addressing) as { reasons?: unknown };
      reasons = Array.isArray(addressing.reasons)
        ? addressing.reasons.filter((reason): reason is string => typeof reason === "string")
        : [];
    } catch {
      reasons = [];
    }
    return { ok: true, reasons };
  }

  /**
   * §7.1/§8.11 的补充事实，全部来自 journal：更晚、在窗口内、晚于上一次读取尝试，且是 member 的
   * @／reply_to_agent（群）或任意成员消息（私聊）。原图消息被显式排除——它不能当自己的补充。
   */
  function freshSupplement(
    row: QqMediaNoteRow,
    event: typeof schema.qqEvents.$inferSelect,
  ): boolean {
    const windowSeconds = Math.floor(options.supplementWindowMinutes * 60);
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return false;
    const from = new Date(event.occurredAtSeconds * 1000).toISOString();
    const to = new Date((event.occurredAtSeconds + windowSeconds) * 1000).toISOString();
    const lastAttemptMs = Date.parse(row.updatedAt);
    const candidates = options.orm
      .select({
        eventKey: schema.conversationEvents.eventKey,
        addressing: schema.conversationEvents.addressing,
        participant: schema.conversationEvents.participant,
        occurredAt: schema.conversationEvents.occurredAt,
      })
      .from(schema.conversationEvents)
      .where(
        and(
          eq(schema.conversationEvents.conversationId, options.conversationId),
          eq(schema.conversationEvents.kind, "inbound"),
          gt(schema.conversationEvents.occurredAt, from),
          lte(schema.conversationEvents.occurredAt, to),
        ),
      )
      .orderBy(desc(schema.conversationEvents.seq))
      .limit(SUPPLEMENT_SCAN_LIMIT)
      .all();
    return candidates.some((candidate) => {
      if (candidate.eventKey === journalKey(row.eventKey)) return false;
      if (!(Date.parse(candidate.occurredAt) > lastAttemptMs)) return false;
      let role: unknown = null;
      let reasons: unknown[] = [];
      try {
        role = candidate.participant
          ? (JSON.parse(candidate.participant) as { role?: unknown }).role
          : null;
        const addressing = JSON.parse(candidate.addressing) as { reasons?: unknown };
        reasons = Array.isArray(addressing.reasons) ? addressing.reasons : [];
      } catch {
        return false;
      }
      if (role !== "member") return false;
      return binding.kind === "private"
        ? true
        : reasons.some(
            (reason) =>
              reason === "mention" || reason === "reply_to_agent" || reason === "legacy_addressed",
          );
    });
  }

  /** fit 前后必须逐字一致的行快照：判定正文引用是否仍然成立的字段。 */
  interface RowSnapshot {
    readonly id: string;
    readonly note: string | null;
    readonly noteModel: string | null;
    readonly attempts: number;
    readonly expiresAt: string;
  }
  function snapshot(row: QqMediaNoteRow): RowSnapshot {
    return {
      id: row.id,
      note: row.note,
      noteModel: row.noteModel,
      attempts: row.attempts,
      expiresAt: row.expiresAt,
    };
  }
  /** fit 之后的末次复验：行与范围仍与快照一致，否则只回安全拒绝值。 */
  function revalidated(snap: RowSnapshot): { ok: true } | { ok: false; code: string } {
    const fresh = mediaRowById(snap.id);
    if (!fresh) return { ok: false, code: "segment_missing" };
    if (
      fresh.note !== snap.note ||
      fresh.noteModel !== snap.noteModel ||
      fresh.attempts !== snap.attempts ||
      fresh.expiresAt !== snap.expiresAt
    )
      return { ok: false, code: "segment_changed" };
    const event = eventRow(fresh.eventKey);
    if (!event) return { ok: false, code: "segment_missing" };
    const scope = scopeFor(fresh, event);
    return scope.ok ? { ok: true } : { ok: false, code: scope.code };
  }
  /** 列表候选的行内复验：身份、归属与过期逐项复核；返回失效码或 null。 */
  function listedStillValid(item: MediaListItem): string | null {
    const fresh = mediaRowById(item.id);
    if (
      !fresh ||
      fresh.eventKey !== item.eventKey ||
      fresh.segmentIndex !== item.index ||
      fresh.segmentKind !== "image"
    )
      return "segment_missing";
    const event = eventRow(fresh.eventKey);
    if (!event) return "segment_missing";
    const scope = scopeFor(fresh, event);
    return scope.ok ? null : scope.code;
  }

  /** 同一次 execute 只捕获一个 fitter：重复 fit 不重复计预留（宿主账本语义）。 */
  type FitCapture = () => Promise<EvidenceResultFitter>;
  function captureFit(
    context: ActionContext,
    name: string,
    arguments_: Record<string, unknown>,
  ): FitCapture {
    let captured: Promise<EvidenceResultFitter> | undefined;
    return () => (captured ??= options.fit(name, arguments_, context.signal));
  }
  /** 结果按完整信封拟合：装不下＝标准预算拒绝；fit 通过后还要复验行，失效就回拒绝码。 */
  async function settle(
    state: MediaRunState,
    context: ActionContext,
    fits: FitCapture,
    value: unknown,
    sources: SourceRef[],
    snap: RowSnapshot | null = null,
  ): Promise<Omit<ActionObservation, "id" | "name">> {
    boundary(state, context);
    if (!(await fits())(value, sources)) return { value: unavailableValue(), sources: [] };
    if (snap !== null) {
      boundary(state, context);
      const check = revalidated(snap);
      if (!check.ok) return refuse(state, context, fits, check.code);
    }
    boundary(state, context);
    return { value, sources };
  }
  async function refuse(
    state: MediaRunState,
    context: ActionContext,
    fits: FitCapture,
    code: string,
  ): Promise<Omit<ActionObservation, "id" | "name">> {
    const value = { status: "unavailable", code };
    boundary(state, context);
    const observation = (await fits())(value, [])
      ? { value, sources: [] }
      : { value: unavailableValue(), sources: [] };
    boundary(state, context);
    return observation;
  }

  const list: BuiltInAction = {
    description: {
      name: "media.list",
      capability: "media.read",
      effect: "read",
      description:
        "List images recorded in this conversation's journal, newest first. Returns {status, items:[{id,eventKey,index,kind,described,attempts}], nextCursor}; the fetch reference and note text are never returned. Pass nextCursor back for older pages; ids are usable only in this run by media.note.read and media.describe. ok with empty items and no nextCursor means there is nothing.",
      parameters: z.toJSONSchema(ListSchema),
    },
    release: releaseRun,
    execute: async (arguments_, context) => {
      context.signal.throwIfAborted();
      assertWired(context);
      const input = ListSchema.parse(arguments_);
      // 续页不建表：游标必须还活在本 run 的运行态里，跨 run 或伪造一律拒绝。
      const state = runState(context, input.cursor === undefined);
      const fits = captureFit(context, "media.list", arguments_);
      boundary(state, context);
      let cursor: ListCursor | null = null;
      if (input.cursor !== undefined) {
        const found = state.cursors.get(input.cursor);
        if (!found) fail("CONTEXT_INVALID_SELECTION", "媒体列表游标无效");
        cursor = found;
      }
      // 范围/绑定复验：绑定改到别处或会话关闭后，列表不再披露任何行。
      const conversation = conversationRow();
      if (
        !conversation ||
        conversation.source_id !== binding.id ||
        conversation.agent_id !== binding.agentId
      )
        return refuse(state, context, fits, "conversation_changed");
      const current = readBindingByConversation(options.orm, identity);
      if (
        !current ||
        current.id !== binding.id ||
        current.agentId !== binding.agentId ||
        current.paused ||
        current.revision !== binding.revision
      )
        return refuse(state, context, fits, "binding_changed");
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      const at = now();
      const rows = options.orm
        .select({
          id: schema.qqMediaNotes.id,
          eventKey: schema.qqMediaNotes.eventKey,
          segmentIndex: schema.qqMediaNotes.segmentIndex,
          attempts: schema.qqMediaNotes.attempts,
          described: sql<number>`CASE WHEN ${schema.qqMediaNotes.note} IS NULL THEN 0 ELSE 1 END`,
          occurredAtSeconds: schema.qqEvents.occurredAtSeconds,
        })
        .from(schema.qqMediaNotes)
        .innerJoin(schema.qqEvents, eq(schema.qqEvents.eventKey, schema.qqMediaNotes.eventKey))
        .innerJoin(
          schema.conversationEvents,
          and(
            eq(schema.conversationEvents.conversationId, options.conversationId),
            eq(schema.conversationEvents.kind, "inbound"),
            eq(
              schema.conversationEvents.eventKey,
              sql`${"onebot:"} || ${schema.qqMediaNotes.eventKey}`,
            ),
          ),
        )
        .where(
          and(
            eq(schema.qqEvents.accountId, binding.accountId),
            eq(schema.qqEvents.conversationKind, binding.kind),
            eq(schema.qqEvents.peerId, binding.peerId),
            eq(schema.qqEvents.agentId, binding.agentId),
            eq(schema.qqMediaNotes.segmentKind, "image"),
            gt(schema.qqMediaNotes.expiresAt, at),
            ...(cursor === null
              ? []
              : [
                  sql`(${schema.qqEvents.occurredAtSeconds} < ${cursor.occurredAtSeconds} OR (${schema.qqEvents.occurredAtSeconds} = ${cursor.occurredAtSeconds} AND (${schema.qqMediaNotes.eventKey} < ${cursor.eventKey} OR (${schema.qqMediaNotes.eventKey} = ${cursor.eventKey} AND ${schema.qqMediaNotes.segmentIndex} < ${cursor.segmentIndex}))))`,
                ]),
          ),
        )
        .orderBy(
          desc(schema.qqEvents.occurredAtSeconds),
          desc(schema.qqMediaNotes.eventKey),
          desc(schema.qqMediaNotes.segmentIndex),
        )
        .limit(limit + 1)
        .all();
      const page = rows.slice(0, limit).map((row) => ({
        ...row,
        index: row.segmentIndex,
        kind: "image" as const,
        described: row.described === 1,
      }));
      if (page.length === 0) {
        const value: ListValue = { status: "ok", items: [], nextCursor: null };
        return settle(state, context, fits, value, []);
      }
      // 装不下就减半重试；fit 通过的候选还要过上限与行复验，游标只落在最后披露的一行上。
      let staleCode: string | null = null;
      for (let length = page.length; length >= 1; length = Math.floor(length / 2)) {
        const items: MediaListItem[] = page.slice(0, length).map((row) => ({
          id: row.id,
          eventKey: row.eventKey,
          index: row.index,
          kind: row.kind,
          described: row.described,
          attempts: row.attempts,
        }));
        const token = length < rows.length ? randomUUID() : null;
        const value: ListValue = { status: "ok", items, nextCursor: token };
        boundary(state, context);
        if (!(await fits())(value, [])) continue;
        boundary(state, context);
        const undisclosed = items.filter((item) => !state.disclosed.has(item.id)).length;
        if (state.disclosed.size + undisclosed > MAX_DISCLOSED) continue;
        if (token !== null && state.cursors.size >= MAX_CURSORS) continue;
        let stale: string | null = null;
        for (const item of items) {
          stale = listedStillValid(item);
          if (stale !== null) break;
        }
        if (stale !== null) {
          staleCode = stale;
          continue;
        }
        if (token !== null) {
          const last = page[length - 1];
          state.cursors.set(token, {
            occurredAtSeconds: last.occurredAtSeconds,
            eventKey: last.eventKey,
            segmentIndex: last.segmentIndex,
          });
        }
        for (const item of items) state.disclosed.add(item.id);
        return { value, sources: [] };
      }
      if (staleCode !== null) return refuse(state, context, fits, staleCode);
      boundary(state, context);
      return { value: unavailableValue(), sources: [] };
    },
  };

  const noteRead: BuiltInAction = {
    description: {
      name: "media.note.read",
      capability: "media.read",
      effect: "read",
      description:
        "Read the stored description of an id returned by media.list in this run. {status:'ok', model, text, offset, nextOffset}: model names the model that wrote it; offset/limit count Unicode characters (limit <= 4096), follow nextOffset until null. {status:'undescribed', attempts} means no description exists yet — nothing is known about the picture. Read-only: never calls a model and never writes.",
      parameters: z.toJSONSchema(NoteReadSchema),
    },
    release: releaseRun,
    execute: async (arguments_, context) => {
      context.signal.throwIfAborted();
      assertWired(context);
      const input = NoteReadSchema.parse(arguments_);
      const state = runState(context, false);
      const fits = captureFit(context, "media.note.read", arguments_);
      boundary(state, context);
      if (!state.disclosed.has(input.id))
        fail("CONTEXT_INVALID_SELECTION", "媒体引用不属于本轮已披露的列表");
      const row = mediaRowById(input.id);
      if (!row) return refuse(state, context, fits, "segment_missing");
      const event = eventRow(row.eventKey);
      if (!event) return refuse(state, context, fits, "segment_missing");
      const scope = scopeFor(row, event);
      if (!scope.ok) return refuse(state, context, fits, scope.code);
      if (row.note === null || row.noteModel === null)
        return settle(
          state,
          context,
          fits,
          { status: "undescribed", id: row.id, attempts: row.attempts },
          [],
          snapshot(row),
        );
      const offset = input.offset ?? 0;
      const limit = input.limit ?? DEFAULT_READ_LIMIT;
      const points = [...row.note];
      if (offset > points.length) fail("CONTEXT_INVALID_SELECTION", "正文分页位置超出范围");
      const sources = noteRefs(row);
      const remaining = points.length - offset;
      if (remaining === 0) {
        const value: NoteReadValue = {
          status: "ok",
          id: row.id,
          model: row.noteModel,
          text: "",
          offset,
          nextOffset: null,
        };
        return settle(state, context, fits, value, sources, snapshot(row));
      }
      // fit 通过还不够：等待期间行可能被改、被删或被撤权，缩短前缀重试，复验通过才交出去。
      for (let length = Math.min(limit, remaining); length >= 1; length = Math.floor(length / 2)) {
        const end = offset + length;
        const value: NoteReadValue = {
          status: "ok",
          id: row.id,
          model: row.noteModel,
          text: points.slice(offset, end).join(""),
          offset,
          nextOffset: end < points.length ? end : null,
        };
        boundary(state, context);
        if (!(await fits())(value, sources)) continue;
        boundary(state, context);
        const check = revalidated(snapshot(row));
        if (!check.ok) return refuse(state, context, fits, check.code);
        boundary(state, context);
        return { value, sources };
      }
      return { value: unavailableValue(), sources: [] };
    },
  };

  const describe: BuiltInAction = {
    description: {
      name: "media.describe",
      capability: "media.describe",
      effect: "write",
      description:
        "Ask the configured vision model to read one listed image id (only images; only ids from media.list in this run; single-flight, reused from cache, at most two attempts ever). Returns {status,attempt,described} metadata only — read the text with media.note.read. A failed read is recorded but never announced in the conversation; a second attempt waits for a later addressed supplement. Cancels with the run.",
      parameters: z.toJSONSchema(DescribeSchema),
    },
    // 有副作用的工具不进沙箱绑定目录；串行执行，绝不与只读批并行。
    sandboxCallable: false,
    release: releaseRun,
    execute: async (arguments_, context) => {
      context.signal.throwIfAborted();
      assertWired(context);
      const input = DescribeSchema.parse(arguments_);
      const state = runState(context, false);
      const fits = captureFit(context, "media.describe", arguments_);
      boundary(state, context);
      if (!state.disclosed.has(input.id))
        fail("CONTEXT_INVALID_SELECTION", "媒体引用不属于本轮已披露的列表");
      const row = mediaRowById(input.id);
      if (!row) return refuse(state, context, fits, "segment_missing");
      const event = eventRow(row.eventKey);
      if (!event) return refuse(state, context, fits, "segment_missing");
      const scope = scopeFor(row, event);
      if (!scope.ok) return refuse(state, context, fits, scope.code);
      if (row.segmentKind !== "image") return refuse(state, context, fits, "unsupported_kind");
      // 结果缓存的键只能是已披露 id（≤ MAX_DISCLOSED），这里只是防御性复检。
      if (!state.outcomes.has(input.id) && state.outcomes.size >= MAX_DISCLOSED)
        return { value: unavailableValue(), sources: [] };

      // 同 run 重复 describe 不烧第二次：复述已有结论；若别处写好了描述就升级为 described。
      const prior = state.outcomes.get(input.id);
      if (prior) {
        const fresh = mediaRowById(input.id);
        if (fresh && fresh.note !== null && fresh.noteModel !== null) {
          const value: DescribeValue = {
            status: "described",
            described: true,
            attempt: fresh.attempts,
          };
          options.onDescribed?.(row.eventKey);
          return settle(state, context, fits, value, noteRefs(fresh), snapshot(fresh));
        }
        if (!fresh) return refuse(state, context, fits, "segment_missing");
        return settle(state, context, fits, prior.value, [], snapshot(fresh));
      }

      if (row.note !== null) {
        const value: DescribeValue = {
          status: "described",
          described: true,
          attempt: row.attempts,
        };
        const sources = noteRefs(row);
        state.outcomes.set(input.id, { value, sources });
        options.onDescribed?.(row.eventKey);
        return settle(state, context, fits, value, sources, snapshot(row));
      }

      // 先花预算、后花视觉：结果信封上界都装不下时不认领尝试、不调模型、不写缓存、不发宿主通知。
      // attempt 用上限而非预测值——不提前声明这次会是第几次尝试。
      const resultFloor: DescribeValue = {
        status: "failed",
        described: false,
        attempt: 2,
        awaitSupplement: false,
      };
      boundary(state, context);
      if (!(await fits())(resultFloor, [])) return { value: unavailableValue(), sources: [] };

      // 两把锁都从宿主事实得出：原图被叫到（journal addressing），以及"更晚且在窗口内的补充"。
      const addressedByMessage = scope.reasons.some(
        (reason) =>
          reason === "mention" ||
          reason === "reply_to_agent" ||
          reason === "private" ||
          reason === "legacy_addressed",
      );
      const supplement = row.attempts > 0 ? freshSupplement(row, event) : false;
      boundary(state, context);
      const result = await readQqMediaOnce(
        options.orm,
        options.adapter,
        {
          eventKey: row.eventKey,
          segmentIndex: row.segmentIndex,
          addressedToAssistant: addressedByMessage || supplement,
          relatedSupplementArrived: supplement,
          modelConfig: options.modelConfig,
        },
        context.signal,
      );
      boundary(state, context);
      let value: DescribeValue;
      let sources: SourceRef[] = [];
      let snap: RowSnapshot | null = null;
      if (result.kind === "described") {
        const fresh = mediaRowById(input.id);
        value = { status: "described", described: true, attempt: result.attempt };
        if (fresh) {
          sources = noteRefs(fresh);
          snap = snapshot(fresh);
        }
        options.onDescribed?.(row.eventKey);
      } else if (result.kind === "failed") {
        value = {
          status: "failed",
          described: false,
          attempt: result.attempt,
          awaitSupplement: result.awaitSupplement,
        };
      } else {
        value = { status: "unavailable", code: result.reason };
      }
      const outcome: DescribeOutcome = { value, sources };
      state.outcomes.set(input.id, outcome);
      return settle(state, context, fits, value, sources, snap);
    },
  };

  // 建立时先验一次接线：会话必须是这条绑定在用的那一间，否则三件工具都不该存在。
  const opening = conversationRow();
  if (!opening || opening.source_id !== binding.id || opening.agent_id !== binding.agentId)
    fail("CONTEXT_SOURCE_INVALID", "媒体工具与会话接线不一致");

  return [list, noteRead, describe];
}
