import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { Evidence, SourceRef } from "../../shared/contracts/evidence";
import type { PermissionRequirement } from "../../shared/contracts/permissions";
import { fail } from "../errors";
import type { ActionDescription } from "./agent-specs";
import { type ActionObservation, uniqueSources } from "./context-engine";

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
  execute(
    arguments_: Record<string, unknown>,
    context: ActionContext,
  ): Promise<Omit<ActionObservation, "id" | "name">>;
}
export interface EvidenceQueryResult {
  readonly status: "ok" | "unavailable";
  readonly code?: string;
  readonly items: readonly Evidence[];
}
export interface EvidenceQueryModule {
  query(
    input: { query: string; limit?: number },
    context: ActionContext,
  ): Promise<readonly Evidence[] | EvidenceQueryResult>;
}
export interface EvidenceCatalogEntry {
  id: string;
  title: string;
  summary: string;
  bodyRef: string;
}
export function evidenceCatalogEntry(kind: string, item: Evidence): EvidenceCatalogEntry {
  return {
    id: item.id,
    title: item.preview?.title ?? item.id,
    summary: item.preview?.summary ?? "",
    bodyRef: createHash("sha256")
      .update(JSON.stringify([kind, item]))
      .digest("hex"),
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
  requireAll?: (kind: string) => boolean;
}
const QuerySchema = z.strictObject({
  query: z.string(),
  limit: z.number().int().positive().optional(),
});
const ReadSchema = z.strictObject({
  bodyRef: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(4096).optional(),
});
const unavailable = { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED", items: [] };

export function createBuiltInActions(
  modules: { memory?: EvidenceQueryModule; knowledge?: EvidenceQueryModule },
  options: EvidenceActionOptions,
): BuiltInAction[] {
  return Object.entries(modules).flatMap(([kind, module]): BuiltInAction[] => {
    const bodies = new Map<string, Evidence>();
    const catalog = (item: Evidence) => evidenceCatalogEntry(kind, item);
    const query: BuiltInAction = {
      description: {
        name: `${kind}.query`,
        description: `Search authorized ${kind}. Returns {status, code?, items}. Items are {id,title,summary,bodyRef}; use ${kind}.read for paged text. ok with empty items means nothing relevant; unavailable means this read failed, not nothing found.`,
        parameters: z.toJSONSchema(QuerySchema),
        capability: `${kind}.read`,
        effect: "read",
      },
      async execute(arguments_, context) {
        context.signal.throwIfAborted();
        const input = QuerySchema.parse(arguments_);
        const result = await module.query(input, context);
        const envelope: EvidenceQueryResult = Array.isArray(result)
          ? { status: "ok", items: result }
          : (result as EvidenceQueryResult);
        context.signal.throwIfAborted();
        const sources = uniqueSources(envelope.items.flatMap((entry) => entry.sources));
        options.assertSources(sources);
        const fits = await options.fit(`${kind}.query`, arguments_, context.signal);
        context.signal.throwIfAborted();
        options.assertSources(sources);
        if (envelope.status !== "ok") return { value: envelope, sources };
        const selected: Evidence[] = [];
        const items: EvidenceCatalogEntry[] = [];
        for (const evidence of envelope.items) {
          if (
            input.limit !== undefined &&
            items.length >= input.limit &&
            !options.requireAll?.(kind)
          )
            break;
          const entry = catalog(evidence);
          const refs = uniqueSources([...selected, evidence].flatMap((item) => item.sources));
          if (!fits({ status: "ok", items: [...items, entry] }, refs)) {
            if (options.requireAll?.(kind)) return { value: unavailable, sources: [] };
            continue;
          }
          selected.push(evidence);
          items.push(entry);
        }
        for (let index = 0; index < items.length; index++)
          bodies.set(items[index].bodyRef, structuredClone(selected[index]));
        return {
          value: envelope.items.length && !items.length ? unavailable : { status: "ok", items },
          sources: uniqueSources(selected.flatMap((item) => item.sources)),
        };
      },
    };
    return [
      query,
      {
        description: {
          name: `${kind}.read`,
          description: `Read a bodyRef returned by ${kind}.query in this run. offset/limit count Unicode characters; follow nextOffset until null. References never grant authority.`,
          parameters: z.toJSONSchema(ReadSchema),
          capability: `${kind}.read`,
          effect: "read",
        },
        async execute(arguments_, context) {
          context.signal.throwIfAborted();
          const input = ReadSchema.parse(arguments_);
          const evidence = bodies.get(input.bodyRef);
          if (!evidence) fail("CONTEXT_INVALID_SELECTION", "正文引用不属于本轮已授权查询");
          options.assertSources(evidence.sources);
          const fits = await options.fit(`${kind}.read`, arguments_, context.signal);
          context.signal.throwIfAborted();
          options.assertSources(evidence.sources);
          const text = [...evidence.text];
          const offset = input.offset ?? 0;
          if (offset > text.length) fail("CONTEXT_INVALID_SELECTION", "正文分页位置超出范围");
          let length = Math.min(input.limit ?? 2048, text.length - offset);
          while (true) {
            const value = {
              status: "ok",
              items: [
                {
                  id: evidence.id,
                  bodyRef: input.bodyRef,
                  text: text.slice(offset, offset + length).join(""),
                  offset,
                  nextOffset: offset + length < text.length ? offset + length : null,
                },
              ],
            };
            if (fits(value, evidence.sources)) return { value, sources: evidence.sources };
            if (length <= 1) return { value: unavailable, sources: [] };
            length = Math.floor(length / 2);
          }
        },
      },
    ];
  });
}
