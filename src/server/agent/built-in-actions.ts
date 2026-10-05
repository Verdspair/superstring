import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  EvidenceQuerySchema,
  EvidenceReadSchema,
  evidenceToolDescriptions,
} from "../../shared/contracts/agent-action-descriptions";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { Evidence, SourceRef } from "../../shared/contracts/evidence";
import type { PermissionRequirement } from "../../shared/contracts/permissions";
import { AppError, fail } from "../errors";
import {
  type EvidenceQueryPage,
  type EvidenceQueryResponse,
  type EvidenceTextPage,
  evidenceQueryPage,
} from "../modules/contracts";
import { estimateTokens } from "../services/token-estimate";
import type { ActionDescription } from "./agent-specs";
import { type ActionObservation, inputUnits, textMessage, uniqueSources } from "./context-engine";

export interface ActionContext {
  owner: RunOwner;
  signal: AbortSignal;
  runId?: string;
  requestId?: string;
  sources?: readonly SourceRef[];
  assertAuthority?: () => void;
}
export interface BuiltInAction {
  description: ActionDescription;
  /**
   * 是否允许程序化工具调用（P6 §2.3.1）把这个动作绑进沙箱。默认＝只读工具；显式 `false` 可以
   * 再关掉个别只读工具（例如需要人工确认的查询）。不写进提示词——沙箱的边界由运行时的绑定表强制。
   */
  sandboxCallable?: boolean;
  permission?: PermissionRequirement;
  assertAvailable?(): void;
  // Idempotent run cleanup must neither abort caller signals nor allow late results to revive state.
  release?(scope: Pick<ActionContext, "owner" | "runId">): void;
  execute(
    arguments_: Record<string, unknown>,
    context: ActionContext,
  ): Promise<Omit<ActionObservation, "id" | "name">>;
}
export type EvidenceQueryResult = EvidenceQueryPage;
export interface EvidenceQueryModule {
  query(
    input: { query: string; limit?: number; cursor?: string },
    context: ActionContext,
  ): Promise<EvidenceQueryResponse>;
  read?(
    input: { evidence: Evidence; offset: number; limit: number },
    context: ActionContext,
  ): Promise<EvidenceTextPage>;
}
export interface EvidenceCatalogEntry {
  id: string;
  title: string;
  summary: string;
  bodyRef: string;
}
/** A catalog projection alone does not register or authorize its random reference. */
export function evidenceCatalogEntry(_kind: string, item: Evidence): EvidenceCatalogEntry {
  return {
    id: item.id,
    title: item.preview?.title ?? item.id,
    summary: item.preview?.summary ?? "",
    bodyRef: randomUUID(),
  };
}
export type EvidenceResultFitter = (value: unknown, sources: readonly SourceRef[]) => boolean;
interface EvidenceActionOptions {
  assertSources(sources: readonly SourceRef[]): void;
  fit(
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<EvidenceResultFitter>;
  /** Cumulative per-run, per-domain allowance in rendered observation units. */
  budget?: (kind: string) => number;
}
const DEFAULT_QUERY_LIMIT = 20;
const MAX_REFS = 512;
const MAX_CURSORS = 512;
const MAX_RETAINED_BYTES = 2 * 1024 * 1024;
const unavailable = () => ({
  value: { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED", items: [] },
  sources: [],
});

interface QueryCursor {
  query: string;
  pending: readonly Evidence[];
  backendCursor?: string;
  sources: readonly SourceRef[];
}
interface DomainState {
  bodies: Map<string, Evidence>;
  cursors: Map<string, QueryCursor>;
  spent: number;
}
interface RunState {
  key: string;
  signal: AbortSignal;
  active: boolean;
  domains: Map<string, DomainState>;
  refs: number;
  cursors: number;
  evidenceCount: number;
  retainedBytes: number;
  release(): void;
}
function contextKey(context: Pick<ActionContext, "owner" | "runId">): string {
  const { kind, id, userId, agentId } = context.owner;
  // null is the explicit unnamed namespace, never a production run ID.
  return JSON.stringify([context.runId ?? null, kind, id, userId ?? null, agentId ?? null]);
}
function observationUnits(
  name: string,
  arguments_: Record<string, unknown>,
  value: unknown,
  sources: readonly SourceRef[],
): number {
  return (
    inputUnits([
      textMessage(
        "user",
        JSON.stringify({
          kind: "action_observation",
          trust: "data_only",
          value: {
            id: "00000000-0000-0000-0000-000000000000",
            name,
            arguments: arguments_,
            value,
            sources,
          },
        }),
      ),
    ]) - inputUnits([])
  );
}
function externalTextPage(text: string, offset: number, limit: number): EvidenceTextPage {
  let total = 0;
  let part = "";
  for (const point of text) {
    if (total >= offset && total - offset < limit) part += point;
    total++;
  }
  if (offset > total) fail("CONTEXT_INVALID_SELECTION", "正文分页位置超出范围");
  const end = Math.min(offset + limit, total);
  return { text: part, offset, total, nextOffset: end < total ? end : null };
}
function textPoints(page: EvidenceTextPage, offset: number, limit: number): string[] {
  if (
    typeof page.text !== "string" ||
    page.text.length > limit * 2 ||
    page.offset !== offset ||
    !Number.isSafeInteger(page.total) ||
    page.total < offset
  )
    fail("CONTEXT_INVALID_SELECTION", "正文分页结果无效");
  const points = [...page.text];
  const end = offset + points.length;
  if (
    points.length > limit ||
    end > page.total ||
    (end < page.total && !points.length) ||
    page.nextOffset !== (end < page.total ? end : null)
  )
    fail("CONTEXT_INVALID_SELECTION", "正文分页结果无效");
  return points;
}

/**
 * Named read-only evidence domains share paging, authority and accounting semantics.
 * The host may additionally seed (register) evidence directly for the current run via
 * `registerEvidence` — e.g. a quoted message located by trusted host logic — reusing the
 * same refs/retained-byte caps, budget accounting, release/cancel semantics and paging
 * as query-disclosed refs. A seeded read never requires a fabricated query call.
 */
export function createEvidenceActionSet(
  modules: Record<string, EvidenceQueryModule | undefined>,
  options: EvidenceActionOptions,
): {
  actions: BuiltInAction[];
  registerEvidence(kind: string, evidence: Evidence, context: ActionContext): string;
} {
  const runs = new Map<string, RunState>();
  /** 释放某个 (owner, runId) 下的全部运行态；对不存在的范围是空操作。 */
  function releaseRun(scope: Pick<ActionContext, "owner" | "runId">): void {
    runs.get(contextKey(scope))?.release();
  }
  function runState(context: ActionContext, create: boolean): RunState {
    context.signal.throwIfAborted();
    const key = contextKey(context);
    const existing = runs.get(key);
    if (existing) return existing;
    if (!create) fail("CONTEXT_INVALID_SELECTION", "引用不属于本轮已授权查询");
    const state: RunState = {
      key,
      signal: context.signal,
      active: true,
      domains: new Map(),
      refs: 0,
      cursors: 0,
      evidenceCount: 0,
      retainedBytes: 0,
      release() {
        state.active = false;
        for (const domain of state.domains.values()) {
          domain.bodies.clear();
          domain.cursors.clear();
        }
        state.domains.clear();
        if (runs.get(key) === state) runs.delete(key);
        state.signal.removeEventListener("abort", state.release);
      },
    };
    runs.set(key, state);
    // Keep one run-linked signal. Different executor batch signals are observed only
    // while their calls are in flight, then their transient listeners are removed.
    state.signal.addEventListener("abort", state.release, { once: true });
    return state;
  }
  function scopedExecute<T>(
    schema: z.ZodType<T>,
    create: (input: T) => boolean,
    execute: (
      input: T,
      arguments_: Record<string, unknown>,
      context: ActionContext,
      state: RunState,
    ) => ReturnType<BuiltInAction["execute"]>,
  ): BuiltInAction["execute"] {
    return async (arguments_, context) => {
      context.signal.throwIfAborted();
      const input = schema.parse(arguments_);
      const state = runState(context, create(input));
      const transient = state.signal !== context.signal;
      const release = () => state.release();
      if (transient) context.signal.addEventListener("abort", release, { once: true });
      try {
        const result = await execute(input, arguments_, context, state);
        try {
          check(state, context, result.sources);
        } catch (error) {
          state.release();
          throw error;
        }
        return result;
      } finally {
        if (transient) context.signal.removeEventListener("abort", release);
      }
    };
  }
  function check(state: RunState, context: ActionContext, sources: readonly SourceRef[]) {
    if (context.signal.aborted) state.release();
    context.signal.throwIfAborted();
    state.signal.throwIfAborted();
    if (!state.active || state.key !== contextKey(context))
      fail("CONTEXT_INVALID_SELECTION", "引用不属于本轮已授权查询");
    context.assertAuthority?.();
    options.assertSources(sources);
    context.signal.throwIfAborted();
    state.signal.throwIfAborted();
  }

  const actions = Object.entries(modules).flatMap(([kind, module]): BuiltInAction[] => {
    if (!module) return [];
    function domainState(state: RunState): DomainState {
      let domain = state.domains.get(kind);
      if (!domain) {
        domain = { bodies: new Map(), cursors: new Map(), spent: 0 };
        state.domains.set(kind, domain);
      }
      return domain;
    }
    function publish(
      state: RunState,
      domain: DomainState,
      context: ActionContext,
      name: string,
      arguments_: Record<string, unknown>,
      fits: EvidenceResultFitter,
      value: unknown,
      sources: readonly SourceRef[],
      register: () => void = () => {},
      checkedSources: readonly SourceRef[] = sources,
    ): boolean {
      check(state, context, checkedSources);
      const units = observationUnits(name, arguments_, value, sources);
      const budget = options.budget?.(kind);
      if (
        budget !== undefined &&
        (!Number.isFinite(budget) || budget < 0 || domain.spent + units > budget)
      )
        return false;
      const accepted = fits(value, sources);
      check(state, context, checkedSources);
      if (!accepted) return false;
      // No await between checking the allowance, host reservation, charge and registration.
      domain.spent += units;
      register();
      return true;
    }
    const queryDescriptions = evidenceToolDescriptions(kind);
    const query: BuiltInAction = {
      description: queryDescriptions.query,
      release: releaseRun,
      execute: scopedExecute(
        EvidenceQuerySchema,
        (input) => input.cursor === undefined,
        async (input, arguments_, context, state) => {
          const domain = domainState(state);
          const previous =
            input.cursor === undefined ? undefined : domain.cursors.get(input.cursor);
          if (input.cursor !== undefined && (!previous || previous.query !== input.query))
            fail("CONTEXT_INVALID_SELECTION", "查询游标不属于本轮同一查询");
          // 游标链上**已披露**的来源：撤权/失效必须硬失败。pending 里未披露的候选不在其中，
          // 它们失效时只跳过自己，既不能牵连有效前缀，也不能留在续读记录里当"已授权来源"。
          const disclosed = previous?.sources ?? [];
          check(state, context, disclosed);
          const limit = input.limit ?? DEFAULT_QUERY_LIMIT;
          let candidates: readonly Evidence[] = previous?.pending ?? [];
          let backendCursor = previous?.backendCursor;
          let retainedBytes = 0;
          let evidenceCount = 0;
          let failed = false;
          let failureCode: string | undefined;
          if (previous && candidates.length) {
            // 消费未披露候选前先复验：只跳过已确定 revoked/expired（CONTEXT_SOURCE_INVALID）
            // 的候选；未知错误照旧抛出。
            const survived: Evidence[] = [];
            for (const candidate of candidates) {
              try {
                options.assertSources(candidate.sources);
              } catch (error) {
                if (error instanceof AppError && error.code === "CONTEXT_SOURCE_INVALID") continue;
                throw error;
              }
              survived.push(candidate);
            }
            if (!survived.length) {
              // 这一页没有可披露的候选：不前进后端，只交还一个安全的后台续读游标。
              const hasNext = backendCursor !== undefined;
              const nextRef = randomUUID();
              let cursorBytes = 0;
              if (hasNext) {
                if (state.cursors >= MAX_CURSORS) return unavailable();
                cursorBytes = estimateTokens(
                  JSON.stringify([nextRef, input.query, backendCursor, disclosed]),
                );
                if (state.retainedBytes + cursorBytes > MAX_RETAINED_BYTES) return unavailable();
              }
              const fits = await options.fit(`${kind}.query`, arguments_, context.signal);
              const value = {
                status: "unavailable",
                code: "CONTEXT_SOURCE_INVALID",
                items: [],
                nextCursor: hasNext ? nextRef : null,
              };
              return publish(
                state,
                domain,
                context,
                `${kind}.query`,
                arguments_,
                fits,
                value,
                [],
                () => {
                  if (!hasNext) return;
                  domain.cursors.set(nextRef, {
                    query: input.query,
                    pending: [],
                    backendCursor,
                    sources: disclosed,
                  });
                  state.cursors += 1;
                  state.retainedBytes += cursorBytes;
                },
                disclosed,
              )
                ? { value, sources: [] }
                : unavailable();
            }
            candidates = survived;
          }
          if (!previous || !candidates.length) {
            const result = evidenceQueryPage(
              await module.query(
                {
                  query: input.query,
                  limit,
                  ...(backendCursor !== undefined ? { cursor: backendCursor } : {}),
                },
                context,
              ),
            );
            failed = result.status !== "ok";
            failureCode = result.code;
            if (!failed) {
              if (state.evidenceCount + result.items.length > MAX_REFS) return unavailable();
              const snapshots: Evidence[] = [];
              for (const entry of result.items) {
                // Lazy backends keep only a source-bound descriptor; finite external arrays
                // may retain text, but never beyond the same run-wide byte/count caps.
                const text = module.read ? "" : entry.text;
                if (text.length > MAX_RETAINED_BYTES) return unavailable();
                const snapshot = structuredClone({ ...entry, text });
                retainedBytes += estimateTokens(JSON.stringify(snapshot));
                if (state.retainedBytes + retainedBytes > MAX_RETAINED_BYTES) return unavailable();
                snapshots.push(snapshot);
              }
              candidates = snapshots;
              evidenceCount = snapshots.length;
              backendCursor = result.nextCursor ?? undefined;
            }
          }
          const fits = await options.fit(`${kind}.query`, arguments_, context.signal);
          check(state, context, disclosed);
          if (failed) {
            const value = {
              status: "unavailable",
              ...(failureCode ? { code: failureCode } : {}),
              items: [],
            };
            return publish(
              state,
              domain,
              context,
              `${kind}.query`,
              arguments_,
              fits,
              value,
              [],
              () => {},
              disclosed,
            )
              ? { value, sources: [] }
              : unavailable();
          }
          if (state.evidenceCount + evidenceCount > MAX_REFS) return unavailable();
          const entries = candidates
            .slice(0, limit)
            .map((item) => evidenceCatalogEntry(kind, item));
          const nextRef = randomUUID();
          // Try ordered prefixes, never skip a candidate that did not fit. Pending evidence
          // is immutable and shared by continuation records, so replay does not consume it.
          for (let count = Math.min(entries.length, MAX_REFS - state.refs); count >= 0; count--) {
            if (!count && candidates.length) break;
            const hasNext = count < candidates.length || backendCursor !== undefined;
            if (hasNext && state.cursors >= MAX_CURSORS) return unavailable();
            const items = entries.slice(0, count);
            const selectedSources = uniqueSources(
              candidates.slice(0, count).flatMap((item) => item.sources),
            );
            const next: QueryCursor | undefined = hasNext
              ? {
                  query: input.query,
                  pending: candidates.slice(count),
                  backendCursor,
                  sources: uniqueSources([...disclosed, ...selectedSources]),
                }
              : undefined;
            const cursorBytes = next
              ? estimateTokens(
                  JSON.stringify([nextRef, input.query, backendCursor, next.sources]),
                ) +
                next.pending.length * 8
              : 0;
            const refsBytes = count * 36;
            if (state.retainedBytes + retainedBytes + cursorBytes + refsBytes > MAX_RETAINED_BYTES)
              continue;
            const value = { status: "ok", items, nextCursor: hasNext ? nextRef : null };
            if (
              publish(
                state,
                domain,
                context,
                `${kind}.query`,
                arguments_,
                fits,
                value,
                selectedSources,
                () => {
                  for (let index = 0; index < count; index++)
                    domain.bodies.set(items[index].bodyRef, candidates[index]);
                  if (next) domain.cursors.set(nextRef, next);
                  state.refs += count;
                  state.cursors += next ? 1 : 0;
                  state.evidenceCount += evidenceCount;
                  state.retainedBytes += retainedBytes + cursorBytes + refsBytes;
                },
                uniqueSources([...disclosed, ...selectedSources]),
              )
            )
              return { value, sources: selectedSources };
          }
          return unavailable();
        },
      ),
    };
    return [
      query,
      {
        description: queryDescriptions.read,
        release: releaseRun,
        execute: scopedExecute(
          EvidenceReadSchema,
          () => false,
          async (input, arguments_, context, state) => {
            const domain = domainState(state);
            const evidence = domain.bodies.get(input.bodyRef);
            if (!evidence) fail("CONTEXT_INVALID_SELECTION", "正文引用不属于本轮已授权查询");
            check(state, context, evidence.sources);
            const offset = input.offset ?? 0;
            const limit = input.limit ?? 2048;
            const page = module.read
              ? await module.read({ evidence: structuredClone(evidence), offset, limit }, context)
              : externalTextPage(evidence.text, offset, limit);
            check(state, context, evidence.sources);
            const points = textPoints(page, offset, limit);
            const fits = await options.fit(`${kind}.read`, arguments_, context.signal);
            check(state, context, evidence.sources);
            let length = points.length;
            while (true) {
              const value = {
                status: "ok",
                items: [
                  {
                    id: evidence.id,
                    bodyRef: input.bodyRef,
                    text: points.slice(0, length).join(""),
                    offset,
                    nextOffset: offset + length < page.total ? offset + length : null,
                  },
                ],
              };
              if (
                publish(
                  state,
                  domain,
                  context,
                  `${kind}.read`,
                  arguments_,
                  fits,
                  value,
                  evidence.sources,
                )
              )
                return { value, sources: evidence.sources };
              if (length <= 1) return unavailable();
              length = Math.floor(length / 2);
            }
          },
        ),
      },
    ];
  });
  return {
    actions,
    registerEvidence(kind, evidence, context) {
      const module = modules[kind];
      if (!module) fail("CONTEXT_INVALID_SELECTION", "未声明的证据域");
      // Seeding requires a real run namespace: the unnamed (null) namespace is a
      // synthetic fallback, never a production owner scope for retained refs.
      if (context.runId === undefined) fail("CONTEXT_INVALID_SELECTION", "缺少本轮运行命名空间");
      const state = runState(context, true);
      let domain = state.domains.get(kind);
      if (!domain) {
        domain = { bodies: new Map(), cursors: new Map(), spent: 0 };
        state.domains.set(kind, domain);
      }
      // Validate authority, sources and signal with the same check as disclosure; a
      // rejected seed registers nothing and does not consume run-wide caps.
      check(state, context, evidence.sources);
      // Lazy backends strip text at seed time exactly like the query path: retained
      // state (and its byte accounting) holds a source-bound descriptor, and reads
      // resolve the real body through module.read. Non-lazy domains keep full text.
      const text = module.read ? "" : evidence.text;
      const snapshot = structuredClone({ ...evidence, text });
      const bytes = estimateTokens(JSON.stringify(snapshot)) + 36;
      if (state.refs >= MAX_REFS || state.retainedBytes + bytes > MAX_RETAINED_BYTES)
        fail("CONTEXT_BUDGET_EXCEEDED", "本轮引用或保留容量已达上限");
      state.refs += 1;
      state.retainedBytes += bytes;
      state.evidenceCount += 1;
      const ref = randomUUID();
      domain.bodies.set(ref, snapshot);
      return ref;
    },
  };
}

/** Existing entry point: the same factory, actions only. */
export function createBuiltInActions(
  modules: Record<string, EvidenceQueryModule | undefined>,
  options: EvidenceActionOptions,
): BuiltInAction[] {
  return createEvidenceActionSet(modules, options).actions;
}
