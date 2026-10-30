import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  type ActionContext,
  type BuiltInAction,
  createBuiltInActions,
  type EvidenceCatalogEntry,
  type EvidenceQueryModule,
} from "../../src/server/agent/built-in-actions";
import { ContextEngine, inputUnits, textMessage } from "../../src/server/agent/context-engine";
import { fail } from "../../src/server/errors";
import type { EvidenceTextPage } from "../../src/server/modules/contracts";
import type { Evidence, SourceRef } from "../../src/shared/contracts/evidence";

type Options = Parameters<typeof createBuiltInActions>[1];
type Observation = Awaited<ReturnType<BuiltInAction["execute"]>>;
interface Catalog {
  status: "ok" | "unavailable";
  code?: string;
  items: EvidenceCatalogEntry[];
  nextCursor?: string | null;
}
interface TextResult {
  status: "ok" | "unavailable";
  code?: string;
  items: { id: string; bodyRef: string; text: string; offset: number; nextOffset: number | null }[];
}
const controllers: AbortController[] = [];
function context(runId = "run", owner: Partial<ActionContext["owner"]> = {}) {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    controller,
    owner: { kind: "test", id: "turn", userId: "user", agentId: "agent", ...owner },
    runId,
    signal: controller.signal,
  };
}
function evidence(id: string, text = `body ${id}`): Evidence {
  return {
    id,
    text,
    preview: { title: `title ${id}`, summary: `summary ${id}` },
    sources: [{ kind: "test_evidence", id, revision: "1" }],
  };
}
function tools(modules: Record<string, EvidenceQueryModule>, options: Partial<Options> = {}) {
  const actions = createBuiltInActions(modules, {
    assertSources: () => {},
    fit: async () => () => true,
    ...options,
  });
  return {
    actions,
    execute(name: string, input: Record<string, unknown>, ctx: ActionContext) {
      const action = actions.find((entry) => entry.description.name === name);
      if (!action) throw new Error(`Missing action ${name}`);
      return action.execute(input, ctx);
    },
    release(ctx: Pick<ActionContext, "owner" | "runId">) {
      for (const action of actions) action.release?.(ctx);
    },
  };
}
function catalog(observation: Observation): Catalog {
  return observation.value as Catalog;
}
function bodyRef(observation: Observation): string {
  const ref = catalog(observation).items[0]?.bodyRef;
  expect(ref).toBeString();
  if (!ref) throw new Error("No disclosed reference");
  return ref;
}
function cursor(observation: Observation): string {
  const next = catalog(observation).nextCursor;
  expect(next).toBeString();
  if (!next) throw new Error("No continuation");
  return next;
}
function textResult(observation: Observation): TextResult {
  return observation.value as TextResult;
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// The host renders this complete data-only observation, not just its items or text.
function observationUnits(
  name: string,
  arguments_: Record<string, unknown>,
  value: unknown,
  sources: readonly SourceRef[],
) {
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
const budgetFailure = { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED", items: [] };
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
});

describe("run-scoped evidence tool pages", () => {
  it("preserves memory origin through catalog continuation and fresh Unicode read pages without changing other domains", async () => {
    const sample = { ...evidence("one", ""), metadata: { content_origin: "derived" as const } };
    const corrected = {
      ...evidence("two", ""),
      metadata: { content_origin: "manual_correction" as const },
    };
    const text = "甲𠮷乙";
    const tool = tools({
      memory: {
        query: async () => [sample, corrected],
        read: async ({ offset, limit }) => {
          const points = [...text];
          const end = Math.min(points.length, offset + limit);
          return {
            text: points.slice(offset, end).join(""),
            offset,
            total: points.length,
            nextOffset: end < points.length ? end : null,
            metadata: { content_origin: "manual_correction" as const },
          };
        },
      },
      history: { query: async () => [evidence("history")] },
    });
    const ctx = context();
    const first = await tool.execute("memory.query", { query: "", limit: 1 }, ctx);
    expect(catalog(first).items).toMatchObject([
      { id: "one", metadata: { content_origin: "derived" } },
    ]);
    const second = await tool.execute(
      "memory.query",
      {
        query: "",
        limit: 1,
        cursor: cursor(first),
      },
      ctx,
    );
    expect(catalog(second).items).toMatchObject([
      { id: "two", metadata: { content_origin: "manual_correction" } },
    ]);
    expect(catalog(second).nextCursor).toBeNull();
    const ref = bodyRef(first);
    const one = await tool.execute("memory.read", { bodyRef: ref, offset: 0, limit: 2 }, ctx);
    expect(textResult(one).items[0]).toMatchObject({
      text: "甲𠮷",
      offset: 0,
      nextOffset: 2,
      metadata: { content_origin: "manual_correction" },
    });
    const two = await tool.execute("memory.read", { bodyRef: ref, offset: 2, limit: 2 }, ctx);
    expect(textResult(two).items[0]).toMatchObject({
      text: "乙",
      offset: 2,
      nextOffset: null,
      metadata: { content_origin: "manual_correction" },
    });
    const history = await tool.execute("history.query", { query: "" }, ctx);
    expect(Object.keys(catalog(history).items[0]).sort()).toEqual([
      "bodyRef",
      "id",
      "summary",
      "title",
    ]);
    const historyRead = await tool.execute("history.read", { bodyRef: bodyRef(history) }, ctx);
    expect(Object.keys(textResult(historyRead).items[0]).sort()).toEqual([
      "bodyRef",
      "id",
      "nextOffset",
      "offset",
      "text",
    ]);
    const opaque = tools({ unknown: { query: async () => [sample] } });
    const unknown = await opaque.execute("unknown.query", { query: "" }, context("unknown"));
    expect(Object.keys(catalog(unknown).items[0]).sort()).toEqual([
      "bodyRef",
      "id",
      "summary",
      "title",
    ]);
  });

  it("charges optional memory origin in the actual model observation rather than admitting it for free", async () => {
    const sample = {
      ...evidence("origin-fee", "body"),
      sources: [{ kind: "memory_access", id: "internal", revision: "r".repeat(4096) }],
      metadata: { content_origin: "derived" as const },
    };
    const expected = {
      status: "ok",
      items: [
        {
          id: sample.id,
          title: "title origin-fee",
          summary: "summary origin-fee",
          bodyRef: "0".repeat(36),
          metadata: sample.metadata,
        },
      ],
      nextCursor: null,
    };
    const engine = new ContextEngine();
    const spec = {
      id: "origin-price",
      context: "conversation" as const,
      availableActions: [],
      limits: { steps: 16 },
    };
    const emptyUnits = engine.render(spec, {}, [], []).units;
    const units = (value: unknown) =>
      engine.render(
        spec,
        {},
        [
          {
            id: "00000000-0000-0000-0000-000000000000",
            name: "memory.query",
            arguments: { query: "" },
            value,
            sources: sample.sources,
          },
        ],
        [],
      ).units - emptyUnits;
    const allowance = units(expected);
    const oldItem = {
      id: expected.items[0].id,
      title: expected.items[0].title,
      summary: expected.items[0].summary,
      bodyRef: expected.items[0].bodyRef,
    };
    expect(allowance).toBeGreaterThan(units({ ...expected, items: [oldItem] }));
    const tool = tools({ memory: { query: async () => [sample] } }, { budget: () => allowance });
    const ctx = context();
    const result = await tool.execute("memory.query", { query: "" }, ctx);
    expect(catalog(result).items[0]).toMatchObject({ metadata: sample.metadata });
    expect(units(result.value)).toBe(allowance);
    expect((await tool.execute("memory.query", { query: "" }, ctx)).value).toEqual(budgetFailure);
    expect(result.sources).toEqual(sample.sources);
  });

  it("binds refs to the complete owner, run and domain without replacing earlier query refs", async () => {
    const module: EvidenceQueryModule = { query: async ({ query }) => [evidence(query)] };
    const tool = tools({ memory: module, knowledge: module });
    const parent = context("parent");
    const ref = bodyRef(await tool.execute("memory.query", { query: "first" }, parent));
    const next = bodyRef(await tool.execute("memory.query", { query: "second" }, parent));
    expect(ref).not.toBe(next);
    for (const ctx of [
      context("child"),
      context("parent", { kind: "other" }),
      context("parent", { id: "other" }),
      context("parent", { userId: "other" }),
      context("parent", { agentId: "other" }),
    ]) {
      await expect(tool.execute("memory.read", { bodyRef: ref }, ctx)).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
    }
    await expect(tool.execute("knowledge.read", { bodyRef: ref }, parent)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    expect(
      textResult(await tool.execute("memory.read", { bodyRef: ref }, parent)).items[0].text,
    ).toBe("body first");
  });

  it("isolates unnamed calls from production runs and other owners", async () => {
    const tool = tools({ memory: { query: async () => [evidence("one")] } });
    const named = context();
    const unnamed: ActionContext = { owner: named.owner, signal: named.signal };
    const ref = bodyRef(await tool.execute("memory.query", { query: "" }, unnamed));
    await expect(tool.execute("memory.read", { bodyRef: ref }, named)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    await expect(
      tool.execute(
        "memory.read",
        { bodyRef: ref },
        { ...unnamed, owner: { kind: "test", id: "else" } },
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    expect(
      textResult(await tool.execute("memory.read", { bodyRef: ref }, { ...unnamed })).status,
    ).toBe("ok");
    const namedRef = bodyRef(await tool.execute("memory.query", { query: "" }, named));
    await expect(tool.execute("memory.read", { bodyRef: namedRef }, unnamed)).rejects.toMatchObject(
      {
        code: "CONTEXT_INVALID_SELECTION",
      },
    );
  });

  it("generates opaque random refs, even for identical evidence and separate factories", async () => {
    const module: EvidenceQueryModule = { query: async () => [evidence("predictable")] };
    const tool = tools({ memory: module });
    const other = tools({ memory: module });
    const ctx = context();
    const first = bodyRef(await tool.execute("memory.query", { query: "" }, ctx));
    const second = bodyRef(await tool.execute("memory.query", { query: "" }, ctx));
    const third = bodyRef(await other.execute("memory.query", { query: "" }, ctx));
    expect(new Set([first, second, third]).size).toBe(3);
    expect(first).not.toContain("predictable");
    await expect(other.execute("memory.read", { bodyRef: first }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
  });

  it("wraps backend cursors and binds query, domain, factory, owner and run while allowing new limits", async () => {
    const seen: { query: string; cursor?: string; limit?: number }[] = [];
    const module: EvidenceQueryModule = {
      async query(input) {
        seen.push(input);
        return input.cursor
          ? { status: "ok", items: [evidence("second")] }
          : { status: "ok", items: [evidence("first")], nextCursor: "backend-offset-1" };
      },
    };
    const tool = tools({ memory: module, knowledge: module });
    const ctx = context();
    const first = await tool.execute("memory.query", { query: "same", limit: 1 }, ctx);
    const next = cursor(first);
    expect(next).not.toBe("backend-offset-1");
    expect(JSON.stringify(first)).not.toContain("backend-offset-1");
    for (const [name, input, otherContext] of [
      ["memory.query", { query: "changed", cursor: next }, ctx],
      ["knowledge.query", { query: "same", cursor: next }, ctx],
      ["memory.query", { query: "same", cursor: "backend-offset-1" }, ctx],
      ["memory.query", { query: "same", cursor: next }, context("child")],
      ["memory.query", { query: "same", cursor: next }, context("run", { id: "other" })],
    ] as const) {
      await expect(tool.execute(name, input, otherContext)).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
    }
    await expect(
      tools({ memory: module }).execute("memory.query", { query: "same", cursor: next }, ctx),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    expect(seen).toHaveLength(1);
    for (const limit of [2, 3]) {
      const page = catalog(
        await tool.execute("memory.query", { query: "same", cursor: next, limit }, ctx),
      );
      expect(page.items.map((item) => item.id)).toEqual(["second"]);
      expect(page.nextCursor ?? null).toBeNull();
      expect(seen.at(-1)).toEqual({ query: "same", cursor: "backend-offset-1", limit });
    }
  });

  it("keeps concurrent query data and cursors independent when completion order is reversed", async () => {
    const slow = deferred<void>();
    const started = deferred<void>();
    const tool = tools({
      memory: {
        async query(input) {
          if (input.query === "slow" && !input.cursor) {
            started.resolve();
            await slow.promise;
          }
          return {
            status: "ok",
            items: [evidence(`${input.query}-${input.cursor ? "two" : "one"}`)],
            nextCursor: input.cursor ? null : `${input.query}-backend`,
          };
        },
      },
    });
    const ctx = context();
    const pending = tool.execute("memory.query", { query: "slow" }, ctx);
    await started.promise;
    const fast = await tool.execute("memory.query", { query: "fast" }, ctx);
    slow.resolve();
    const first = await pending;
    for (const [query, page] of [
      ["slow", first],
      ["fast", fast],
    ] as const) {
      expect(
        textResult(await tool.execute("memory.read", { bodyRef: bodyRef(page) }, ctx)).items[0]
          .text,
      ).toBe(`body ${query}-one`);
      const next = await tool.execute("memory.query", { query, cursor: cursor(page) }, ctx);
      expect(catalog(next).items[0].id).toBe(`${query}-two`);
    }
  });

  it("continues undisclosed candidates before advancing the backend and permits replay", async () => {
    const calls: (string | undefined)[] = [];
    const tool = tools(
      {
        memory: {
          async query(input) {
            calls.push(input.cursor);
            return input.cursor
              ? { status: "ok", items: [evidence("e")] }
              : {
                  status: "ok",
                  items: ["a", "b", "c", "d"].map((id) => evidence(id)),
                  nextCursor: "next",
                };
          },
        },
      },
      { fit: async () => (value) => (value as Catalog).items.length <= 2 },
    );
    const ctx = context();
    const first = await tool.execute("memory.query", { query: "", limit: 4 }, ctx);
    expect(catalog(first).items.map((item) => item.id)).toEqual(["a", "b"]);
    const next = cursor(first);
    const second = await tool.execute("memory.query", { query: "", cursor: next, limit: 4 }, ctx);
    expect(catalog(second).items.map((item) => item.id)).toEqual(["c", "d"]);
    const replay = await tool.execute("memory.query", { query: "", cursor: next, limit: 4 }, ctx);
    expect(catalog(replay).items.map((item) => item.id)).toEqual(["c", "d"]);
    expect(calls).toEqual([undefined]);
    const third = await tool.execute("memory.query", { query: "", cursor: cursor(second) }, ctx);
    expect(catalog(third).items.map((item) => item.id)).toEqual(["e"]);
    expect(calls).toEqual([undefined, "next"]);
    expect(
      textResult(await tool.execute("memory.read", { bodyRef: bodyRef(first) }, ctx)).items[0].text,
    ).toBe("body a");
  });

  it("pages finite external arrays and arbitrary named read-only domains through the same actions", async () => {
    const tool = tools({
      history: { query: async () => [evidence("a"), evidence("b"), evidence("c")] },
    });
    expect(tool.actions.map((action) => action.description.name)).toEqual([
      "history.query",
      "history.read",
    ]);
    expect(tool.actions.every((action) => action.description.effect === "read")).toBe(true);
    const ctx = context();
    const found: string[] = [];
    let next: string | undefined;
    do {
      const page = catalog(
        await tool.execute(
          "history.query",
          { query: "", limit: 1, ...(next ? { cursor: next } : {}) },
          ctx,
        ),
      );
      expect(page.status).toBe("ok");
      found.push(...page.items.map((item) => item.id));
      next = page.nextCursor ?? undefined;
    } while (next && found.length < 5);
    expect(found).toEqual(["a", "b", "c"]);
    expect(next).toBeUndefined();
  });

  it("validates safe bounded inputs and rejects authority selectors", async () => {
    let calls = 0;
    const tool = tools({
      memory: {
        async query() {
          calls++;
          return [];
        },
      },
    });
    const ctx = context();
    for (const extra of [
      { agentId: "other" },
      { session: "other" },
      { sessionId: "other" },
      { scopes: [] },
      { runId: "other" },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { cursor: "x".repeat(4097) },
      { query: "x".repeat(4097) },
    ]) {
      await expect(tool.execute("memory.query", { query: "", ...extra }, ctx)).rejects.toThrow();
    }
    expect(calls).toBe(0);
    for (const query of ["", "x".repeat(4096)])
      expect(catalog(await tool.execute("memory.query", { query, limit: 100 }, ctx)).status).toBe(
        "ok",
      );
    const schema = tool.actions[0].description.parameters as {
      additionalProperties: boolean;
      properties: Record<string, { maximum?: number; maxLength?: number }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.query.maxLength).toBe(4096);
    expect(schema.properties.limit.maximum).toBe(100);
    expect(schema.properties.cursor.maxLength).toBe(4096);
  });

  it("uses lazy Unicode text pages, preserves their sources and rejects invalid offsets", async () => {
    const text = "甲\u{20000}e\u0301乙";
    const reads: { offset: number; limit: number; evidence: Evidence }[] = [];
    const tool = tools({
      summary: {
        query: async () => [evidence("lazy", "must not use this cached text")],
        async read(input): Promise<EvidenceTextPage> {
          reads.push(input);
          const points = [...text];
          if (input.offset > points.length) fail("CONTEXT_INVALID_SELECTION", "offset");
          const end = Math.min(points.length, input.offset + input.limit);
          return {
            text: points.slice(input.offset, end).join(""),
            offset: input.offset,
            total: points.length,
            nextOffset: end < points.length ? end : null,
          };
        },
      },
    });
    const ctx = context();
    const queried = await tool.execute("summary.query", { query: "" }, ctx);
    const ref = bodyRef(queried);
    const chunks: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await tool.execute("summary.read", { bodyRef: ref, offset, limit: 2 }, ctx);
      expect(result.sources).toEqual(evidence("lazy").sources);
      const page = textResult(result).items[0];
      expect(page.offset).toBe(offset);
      expect([...page.text].length).toBeLessThanOrEqual(2);
      chunks.push(page.text);
      offset = page.nextOffset;
    }
    expect(chunks).toEqual(["甲\u{20000}", "e\u0301", "乙"]);
    expect(chunks.join("")).toBe(text);
    expect(reads.every((input) => input.evidence.text === "")).toBe(true);
    expect(
      textResult(await tool.execute("summary.read", { bodyRef: ref, offset: 5 }, ctx)).items[0],
    ).toMatchObject({ text: "", offset: 5, nextOffset: null });
    await expect(
      tool.execute("summary.read", { bodyRef: ref, offset: 6 }, ctx),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    for (const input of [
      { limit: 4097 },
      { limit: 0 },
      { offset: -1 },
      { offset: 0.5 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(tool.execute("summary.read", { bodyRef: ref, ...input }, ctx)).rejects.toThrow();
    }
  });

  it("reads external Unicode bodies beyond 4096 characters and handles empty and terminal pages", async () => {
    const tool = tools({
      memory: {
        query: async ({ query }) => [evidence(query, query ? "\u{20000}".repeat(4100) : "")],
      },
    });
    const ctx = context();
    const ref = bodyRef(await tool.execute("memory.query", { query: "long" }, ctx));
    const first = textResult(await tool.execute("memory.read", { bodyRef: ref, limit: 4096 }, ctx))
      .items[0];
    expect([...first.text]).toHaveLength(4096);
    expect(first.nextOffset).toBe(4096);
    const last = textResult(await tool.execute("memory.read", { bodyRef: ref, offset: 4096 }, ctx))
      .items[0];
    expect([...last.text]).toHaveLength(4);
    expect(last.nextOffset).toBeNull();
    expect(
      textResult(await tool.execute("memory.read", { bodyRef: ref, offset: 4100 }, ctx)).items[0]
        .text,
    ).toBe("");
    await expect(
      tool.execute("memory.read", { bodyRef: ref, offset: 4101 }, ctx),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    const empty = bodyRef(await tool.execute("memory.query", { query: "" }, ctx));
    expect(
      textResult(await tool.execute("memory.read", { bodyRef: empty }, ctx)).items[0],
    ).toMatchObject({ text: "", offset: 0, nextOffset: null });
  });

  it("shrinks lazy text pages by Unicode points without losing the continuation", async () => {
    const text = "甲\u{20000}乙丙";
    const tool = tools(
      {
        memory: {
          query: async () => [evidence("a", "")],
          async read({ offset, limit }) {
            const points = [...text];
            const end = Math.min(points.length, offset + limit);
            return {
              text: points.slice(offset, end).join(""),
              offset,
              total: points.length,
              nextOffset: end < points.length ? end : null,
            };
          },
        },
      },
      {
        fit: async (name) => (value) =>
          name.endsWith("query") || [...(value as TextResult).items[0].text].length <= 2,
      },
    );
    const ctx = context();
    const ref = bodyRef(await tool.execute("memory.query", { query: "" }, ctx));
    const first = textResult(await tool.execute("memory.read", { bodyRef: ref, limit: 4 }, ctx))
      .items[0];
    expect(first).toMatchObject({ text: "甲\u{20000}", nextOffset: 2 });
    expect(
      textResult(await tool.execute("memory.read", { bodyRef: ref, offset: 2, limit: 4 }, ctx))
        .items[0],
    ).toMatchObject({ text: "乙丙", nextOffset: null });
  });

  it("rejects inconsistent lazy pages instead of publishing corrupt offsets or empty progress", async () => {
    for (const page of [
      { text: "a", offset: 1, total: 2, nextOffset: null },
      { text: "", offset: 0, total: 2, nextOffset: 0 },
      { text: "ab", offset: 0, total: 1, nextOffset: null },
      { text: "a", offset: 0, total: 2, nextOffset: null },
      { text: "abc", offset: 0, total: 3, nextOffset: null },
    ]) {
      const tool = tools({
        memory: { query: async () => [evidence("a")], read: async () => page },
      });
      const ctx = context();
      const ref = bodyRef(await tool.execute("memory.query", { query: "" }, ctx));
      await expect(
        tool.execute("memory.read", { bodyRef: ref, limit: 2 }, ctx),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    }
  });

  it("fits complete catalog and text envelopes, including all refs and nextCursor", async () => {
    const accepted: unknown[] = [];
    const tool = tools(
      { memory: { query: async () => [evidence("a"), evidence("b")] } },
      {
        fit: async (name, args) => (value, sources) => {
          if (name.endsWith("query")) {
            const page = value as Catalog;
            expect(page.nextCursor === null || typeof page.nextCursor === "string").toBe(true);
            expect(page.items.every((item) => typeof item.bodyRef === "string")).toBe(true);
          }
          expect(observationUnits(name, args, value, sources)).toBeGreaterThan(
            JSON.stringify(value).length,
          );
          accepted.push(structuredClone(value));
          return true;
        },
      },
    );
    const ctx = context();
    const query = await tool.execute("memory.query", { query: "", limit: 1 }, ctx);
    expect(accepted.at(-1)).toEqual(query.value);
    const read = await tool.execute("memory.read", { bodyRef: bodyRef(query) }, ctx);
    expect(accepted.at(-1)).toEqual(read.value);
    expect(JSON.stringify(query.value)).not.toContain("body a");
  });

  it("returns unavailable for insufficient budgets, including empty queries and empty bodies", async () => {
    const tool = tools({ memory: { query: async () => [] } }, { fit: async () => () => false });
    expect((await tool.execute("memory.query", { query: "" }, context())).value).toEqual(
      budgetFailure,
    );
    const empty = tools(
      { memory: { query: async () => [evidence("empty", "")] } },
      { fit: async (name) => () => name.endsWith("query") },
    );
    const ctx = context();
    const ref = bodyRef(await empty.execute("memory.query", { query: "" }, ctx));
    expect((await empty.execute("memory.read", { bodyRef: ref }, ctx)).value).toEqual(
      budgetFailure,
    );
  });

  it("does not publish refs or cursors for backend unavailable results", async () => {
    const tool = tools({
      memory: {
        query: async () => ({
          status: "unavailable",
          code: "CONTEXT_BUDGET_EXCEEDED",
          items: [evidence("secret")],
          nextCursor: "hidden",
        }),
      },
    });
    const result = await tool.execute("memory.query", { query: "" }, context());
    expect(result.value).toEqual(budgetFailure);
    expect(result.sources).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result.value)).not.toContain("hidden");
  });

  it("hard-fails revocation before and after lazy reads and while preparing a fit", async () => {
    let revoked = false;
    let reads = 0;
    let revokeDuringRead = false;
    let revokeDuringFit = false;
    let checked = 0;
    const tool = tools(
      {
        memory: {
          query: async () => [evidence("private")],
          async read() {
            reads++;
            revoked = revokeDuringRead;
            return { text: "secret", offset: 0, total: 6, nextOffset: null };
          },
        },
      },
      {
        assertSources(sources) {
          if (sources.length) checked++;
          if (revoked) fail("CONTEXT_SOURCE_INVALID", "revoked");
        },
        fit: async () => {
          if (revokeDuringFit) revoked = true;
          return () => true;
        },
      },
    );
    const ctx = context();
    const ref = bodyRef(await tool.execute("memory.query", { query: "" }, ctx));
    revoked = true;
    await expect(tool.execute("memory.read", { bodyRef: ref }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    expect(reads).toBe(0);
    revoked = false;
    revokeDuringRead = true;
    await expect(tool.execute("memory.read", { bodyRef: ref }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    expect(reads).toBe(1);
    revoked = false;
    revokeDuringFit = true;
    await expect(tool.execute("memory.query", { query: "" }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("rechecks retained continuation sources and the fitter's final checkpoint", async () => {
    let revoked = false;
    let revokeInFit = false;
    const tool = tools(
      { memory: { query: async () => [evidence("a"), evidence("b")] } },
      {
        assertSources: (sources) => {
          if (revoked && sources.length) fail("CONTEXT_SOURCE_INVALID", "revoked");
        },
        fit: async () => () => {
          if (revokeInFit) revoked = true;
          return true;
        },
      },
    );
    const ctx = context();
    const first = await tool.execute("memory.query", { query: "", limit: 1 }, ctx);
    revoked = true;
    await expect(
      tool.execute("memory.query", { query: "", cursor: cursor(first) }, ctx),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    revoked = false;
    revokeInFit = true;
    await expect(tool.execute("memory.query", { query: "" }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it("cancels in-flight queries and reads without publishing data", async () => {
    for (const operation of ["query", "read"] as const) {
      const wait = deferred<void>();
      const entered = deferred<void>();
      const tool = tools({
        memory: {
          async query() {
            if (operation === "query") {
              entered.resolve();
              await wait.promise;
            }
            return [evidence("a")];
          },
          async read() {
            entered.resolve();
            await wait.promise;
            return { text: "secret", offset: 0, total: 6, nextOffset: null };
          },
        },
      });
      const ctx = context();
      const input =
        operation === "query"
          ? { query: "" }
          : { bodyRef: bodyRef(await tool.execute("memory.query", { query: "" }, ctx)) };
      const pending = tool.execute(`memory.${operation}`, input, ctx);
      await entered.promise;
      ctx.controller.abort(new Error("cancelled"));
      wait.resolve();
      await expect(pending).rejects.toThrow("cancelled");
    }
  });

  it("releases a run on abort, keeps other runs intact and installs only one same-signal listener", async () => {
    const tool = tools({ memory: { query: async () => [evidence("a"), evidence("b")] } });
    const ctx = context();
    const listener = spyOn(ctx.signal, "addEventListener");
    const first = await tool.execute("memory.query", { query: "", limit: 1 }, ctx);
    const ref = bodyRef(first);
    const other = context("other");
    const otherRef = bodyRef(await tool.execute("memory.query", { query: "" }, other));
    for (let i = 0; i < 8; i++) await tool.execute("memory.read", { bodyRef: ref }, ctx);
    expect(listener.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    listener.mockRestore();
    ctx.controller.abort();
    const restarted = context();
    await expect(tool.execute("memory.read", { bodyRef: ref }, restarted)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    await expect(
      tool.execute("memory.query", { query: "", cursor: cursor(first) }, restarted),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    expect(textResult(await tool.execute("memory.read", { bodyRef: otherRef }, other)).status).toBe(
      "ok",
    );
  });

  it("releases refs immediately when a later action signal aborts and removes transient listeners", async () => {
    const wait = deferred<void>();
    const entered = deferred<void>();
    const tool = tools({
      memory: {
        query: async () => [evidence("a"), evidence("b")],
        async read() {
          entered.resolve();
          await wait.promise;
          return { text: "secret", offset: 0, total: 6, nextOffset: null };
        },
      },
    });
    const root = context();
    const first = await tool.execute("memory.query", { query: "", limit: 1 }, root);
    const step = context();
    const add = spyOn(step.signal, "addEventListener");
    const remove = spyOn(step.signal, "removeEventListener");
    const reading = tool.execute("memory.read", { bodyRef: bodyRef(first) }, step);
    await entered.promise;
    step.controller.abort(new Error("step cancelled"));
    try {
      await expect(
        tool.execute("memory.query", { query: "", cursor: cursor(first) }, root),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    } finally {
      wait.resolve();
      await expect(reading).rejects.toThrow("step cancelled");
    }
    expect(add.mock.calls.filter(([event]) => event === "abort")).toHaveLength(1);
    expect(remove.mock.calls.filter(([event]) => event === "abort")).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });

  it("rejects cancellation queued at publication instead of returning a late result", async () => {
    const ctx = context();
    const tool = tools(
      { memory: { query: async () => [evidence("a")] } },
      {
        fit: async () => () => {
          queueMicrotask(() => ctx.controller.abort(new Error("publication cancelled")));
          return true;
        },
      },
    );
    await expect(tool.execute("memory.query", { query: "" }, ctx)).rejects.toThrow(
      "publication cancelled",
    );
  });

  it("atomically charges cumulative same-domain query budgets using real envelopes", async () => {
    const sample = evidence("a");
    const value = {
      status: "ok",
      items: [{ id: sample.id, title: "title a", summary: "summary a", bodyRef: "0".repeat(36) }],
      nextCursor: null,
    };
    const allowance = observationUnits("memory.query", { query: "" }, value, sample.sources);
    const gate = deferred<void>();
    let started = 0;
    const entered = deferred<void>();
    const tool = tools(
      {
        memory: {
          async query() {
            if (++started === 2) entered.resolve();
            await gate.promise;
            return [sample];
          },
        },
      },
      { budget: () => allowance },
    );
    const ctx = context();
    const pending = [
      tool.execute("memory.query", { query: "" }, ctx),
      tool.execute("memory.query", { query: "" }, ctx),
    ];
    await entered.promise;
    gate.resolve();
    const results = await Promise.all(pending);
    expect(results.filter((item) => catalog(item).status === "ok")).toHaveLength(1);
    expect(results.filter((item) => catalog(item).status === "unavailable")[0]?.value).toEqual(
      budgetFailure,
    );
    const success = results.find((item) => catalog(item).status === "ok");
    if (!success) throw new Error("No successful query");
    expect(observationUnits("memory.query", { query: "" }, success.value, success.sources)).toBe(
      allowance,
    );
    expect((await tool.execute("memory.read", { bodyRef: bodyRef(success) }, ctx)).value).toEqual(
      budgetFailure,
    );
    expect(
      catalog(await tool.execute("memory.query", { query: "" }, context("other"))).status,
    ).toBe("ok");
  });

  it("charges query and concurrent text pages to the same domain, independently of other domains", async () => {
    let allowance = 100_000;
    const sample = evidence("a", "甲\u{20000}");
    const module: EvidenceQueryModule = { query: async () => [sample] };
    const kinds: string[] = [];
    const tool = tools(
      { memory: module, knowledge: module },
      {
        budget: (kind) => {
          kinds.push(kind);
          return allowance;
        },
      },
    );
    const ctx = context();
    const query = await tool.execute("memory.query", { query: "" }, ctx);
    const ref = bodyRef(query);
    const args = { bodyRef: ref, limit: 2 };
    const readValue = {
      status: "ok",
      items: [{ id: "a", bodyRef: ref, text: sample.text, offset: 0, nextOffset: null }],
    };
    allowance =
      observationUnits("memory.query", { query: "" }, query.value, query.sources) +
      observationUnits("memory.read", args, readValue, sample.sources);
    const pages = await Promise.all([
      tool.execute("memory.read", args, ctx),
      tool.execute("memory.read", args, ctx),
    ]);
    expect(pages.filter((page) => textResult(page).status === "ok")).toHaveLength(1);
    expect(pages.filter((page) => textResult(page).status === "unavailable")[0]?.value).toEqual(
      budgetFailure,
    );
    expect(catalog(await tool.execute("knowledge.query", { query: "" }, ctx)).status).toBe("ok");
    expect(kinds).toContain("knowledge");
  });

  it("does not disclose a pending candidate revoked inside the fitter or invalidate its valid prefix", async () => {
    let revoked = false;
    const tool = tools(
      { memory: { query: async () => [evidence("a"), evidence("b")] } },
      {
        assertSources(sources) {
          if (revoked && sources.some((source) => source.id === "b"))
            fail("CONTEXT_SOURCE_INVALID", "revoked pending source");
        },
        fit: async () => () => {
          revoked = true;
          return true;
        },
      },
    );
    const ctx = context();
    const first = await tool.execute("memory.query", { query: "", limit: 1 }, ctx);
    expect(first.sources).toEqual(evidence("a").sources);
    expect(catalog(first).items.map((item) => item.id)).toEqual(["a"]);
    expect(
      textResult(await tool.execute("memory.read", { bodyRef: bodyRef(first) }, ctx)).items[0].text,
    ).toBe("body a");
    const next = await tool.execute("memory.query", { query: "", cursor: cursor(first) }, ctx);
    expect(next).toEqual({
      value: { status: "unavailable", code: "CONTEXT_SOURCE_INVALID", items: [], nextCursor: null },
      sources: [],
    });
  });

  it("keeps an undisclosed candidate revoked during asynchronous fit preparation from blocking a valid prefix", async () => {
    let revoked = false;
    const tool = tools(
      { memory: { query: async () => [evidence("a"), evidence("b")] } },
      {
        assertSources(sources) {
          if (revoked && sources.some((source) => source.id === "b"))
            fail("CONTEXT_SOURCE_INVALID", "revoked pending source");
        },
        fit: async () => {
          await Promise.resolve();
          revoked = true;
          return () => true;
        },
      },
    );
    const first = await tool.execute("memory.query", { query: "", limit: 1 }, context());
    expect(catalog(first).items.map((item) => item.id)).toEqual(["a"]);
    expect(first.sources).toEqual(evidence("a").sources);
  });

  it("isolates revoked or expired undisclosed batches and preserves a safe backend continuation", async () => {
    for (const hasBackend of [false, true]) {
      for (const invalidation of ["revoked", "expired"] as const) {
        const revoked = new Set<string>();
        const pending = evidence("b");
        pending.sources[0].expiresAt = "2000-01-01T00:00:01.000Z";
        let now = Date.parse("2000-01-01T00:00:00.000Z");
        const calls: (string | undefined)[] = [];
        const tool = tools(
          {
            knowledge: {
              async query(input) {
                calls.push(input.cursor);
                return input.cursor
                  ? { status: "ok", items: [evidence("c")] }
                  : {
                      status: "ok",
                      items: [evidence("a"), pending],
                      nextCursor: hasBackend ? "private-backend-cursor" : null,
                    };
              },
            },
          },
          {
            fit: async () => (value) => (value as Catalog).items.length <= 1,
            assertSources(sources) {
              if (
                sources.some(
                  (source) =>
                    revoked.has(source.id) ||
                    (source.expiresAt && Date.parse(source.expiresAt) <= now),
                )
              )
                fail("CONTEXT_SOURCE_INVALID", "synthetic private diagnostic");
            },
          },
        );
        const ctx = context();
        const first = await tool.execute("knowledge.query", { query: "", limit: 2 }, ctx);
        expect(catalog(first).items.map((item) => item.id)).toEqual(["a"]);
        expect(first.sources).toEqual(evidence("a").sources);
        if (invalidation === "revoked") revoked.add("b");
        else now += 2000;
        const ref = bodyRef(first);
        expect(textResult(await tool.execute("knowledge.read", { bodyRef: ref }, ctx)).status).toBe(
          "ok",
        );
        const next = await tool.execute(
          "knowledge.query",
          { query: "", cursor: cursor(first) },
          ctx,
        );
        expect(catalog(next)).toMatchObject({
          status: "unavailable",
          code: "CONTEXT_SOURCE_INVALID",
          items: [],
        });
        expect(next.sources).toEqual([]);
        expect(JSON.stringify(next)).not.toContain("private");
        expect(calls).toEqual([undefined]);
        if (hasBackend) {
          const last = await tool.execute(
            "knowledge.query",
            { query: "", cursor: cursor(next) },
            ctx,
          );
          expect(catalog(last).items.map((item) => item.id)).toEqual(["c"]);
          expect(last.sources).toEqual(evidence("c").sources);
          expect(calls).toEqual([undefined, "private-backend-cursor"]);
          revoked.add("a");
          await expect(
            tool.execute("knowledge.query", { query: "", cursor: cursor(next) }, ctx),
          ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
          await expect(tool.execute("knowledge.read", { bodyRef: ref }, ctx)).rejects.toMatchObject(
            {
              code: "CONTEXT_SOURCE_INVALID",
            },
          );
        } else expect(catalog(next).nextCursor).toBeNull();
      }
    }
  });

  it("never converts a host checkpoint or an unknown candidate error into an empty page", async () => {
    for (const mode of ["host", "authority", "unknown"] as const) {
      let continuing = false;
      let hostInvalid = false;
      const unknown = new Error("synthetic candidate failure");
      const tool = tools(
        { memory: { query: async () => [evidence("a"), evidence("b")] } },
        {
          assertSources(sources) {
            if (hostInvalid && mode === "host") fail("CONTEXT_SOURCE_INVALID", "host invalid");
            if (continuing && sources.some((source) => source.id === "b")) {
              if (mode === "unknown") throw unknown;
              hostInvalid = true;
              fail("CONTEXT_SOURCE_INVALID", "candidate or host invalid");
            }
          },
        },
      );
      const ctx = {
        ...context(),
        assertAuthority() {
          if (hostInvalid && mode === "authority")
            fail("CONTEXT_SOURCE_INVALID", "authority invalid");
        },
      };
      const first = await tool.execute("memory.query", { query: "", limit: 1 }, ctx);
      continuing = true;
      const result = tool.execute("memory.query", { query: "", cursor: cursor(first) }, ctx);
      if (mode === "unknown") await expect(result).rejects.toBe(unknown);
      else await expect(result).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    }
  });

  it("releases successful batch-signal contexts explicitly, idempotently and by complete owner/run", async () => {
    const module: EvidenceQueryModule = { query: async () => [evidence("a"), evidence("b")] };
    const tool = tools({ memory: module, knowledge: module });
    const root = context();
    const batch = { ...root, signal: AbortSignal.any([root.signal, context("batch").signal]) };
    const remove = spyOn(batch.signal, "removeEventListener");
    const first = await tool.execute("memory.query", { query: "", limit: 1 }, batch);
    const knowledgeRef = bodyRef(await tool.execute("knowledge.query", { query: "" }, batch));
    const survivors: { ctx: ActionContext; ref: string }[] = [];
    for (const ctx of [
      context("other"),
      context("run", { id: "other" }),
      { owner: root.owner, signal: root.signal },
    ])
      survivors.push({ ctx, ref: bodyRef(await tool.execute("memory.query", { query: "" }, ctx)) });
    const scope = { owner: root.owner, runId: root.runId };
    tool.release(scope);
    tool.release(scope);
    expect(root.signal.aborted).toBe(false);
    expect(batch.signal.aborted).toBe(false);
    expect(remove.mock.calls.filter(([event]) => event === "abort")).toHaveLength(1);
    remove.mockRestore();
    for (const [name, input] of [
      ["memory.read", { bodyRef: bodyRef(first) }],
      ["knowledge.read", { bodyRef: knowledgeRef }],
      ["memory.query", { query: "", cursor: cursor(first) }],
    ] as const)
      await expect(tool.execute(name, input, root)).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
    for (const { ctx, ref } of survivors)
      expect(textResult(await tool.execute("memory.read", { bodyRef: ref }, ctx)).status).toBe(
        "ok",
      );
    const unnamed = survivors[2];
    tool.release({ owner: unnamed.ctx.owner });
    await expect(
      tool.execute("memory.read", { bodyRef: unnamed.ref }, unnamed.ctx),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
  });

  it("does not resurrect in-flight queries or reads after explicit release", async () => {
    for (const operation of ["query", "read"] as const) {
      const gate = deferred<void>();
      const entered = deferred<void>();
      const tool = tools({
        memory: {
          async query() {
            if (operation === "query") {
              entered.resolve();
              await gate.promise;
            }
            return [evidence("a")];
          },
          async read() {
            entered.resolve();
            await gate.promise;
            return { text: "secret", offset: 0, total: 6, nextOffset: null };
          },
        },
      });
      const ctx = context();
      const input =
        operation === "query"
          ? { query: "" }
          : { bodyRef: bodyRef(await tool.execute("memory.query", { query: "" }, ctx)) };
      const result = tool.execute(`memory.${operation}`, input, ctx);
      await entered.promise;
      tool.release({ owner: ctx.owner, runId: ctx.runId });
      gate.resolve();
      await expect(result).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
      expect(ctx.signal.aborted).toBe(false);
    }
  });

  it("bounds metadata and backend cursor retention as well as body text", async () => {
    const large = "x".repeat(2 * 1024 * 1024 + 1);
    for (const field of ["preview", "revision", "cursor"] as const) {
      const item = evidence("a", "");
      if (field === "preview") item.preview = { title: large, summary: "" };
      if (field === "revision") item.sources[0].revision = large;
      const tool = tools({
        memory: {
          query: async () => ({
            status: "ok",
            items: [item],
            nextCursor: field === "cursor" ? large : null,
          }),
        },
      });
      expect((await tool.execute("memory.query", { query: "" }, context())).value).toEqual(
        budgetFailure,
      );
    }
  });

  it("revalidates cursor sources after fetching a backend continuation", async () => {
    let revoked = false;
    const tool = tools(
      {
        memory: {
          async query(input) {
            if (input.cursor) {
              revoked = true;
              return { status: "ok", items: [evidence("b")] };
            }
            return { status: "ok", items: [evidence("a")], nextCursor: "backend" };
          },
        },
      },
      {
        assertSources(sources) {
          if (revoked && sources.some((source) => source.id === "a"))
            fail("CONTEXT_SOURCE_INVALID", "cursor source revoked");
        },
      },
    );
    const ctx = context();
    const next = cursor(await tool.execute("memory.query", { query: "" }, ctx));
    await expect(
      tool.execute("memory.query", { query: "", cursor: next }, ctx),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
  });

  it("does not authorize provisional refs after fit errors or cancellations", async () => {
    for (const mode of ["error", "cancel"] as const) {
      let provisional: Catalog | undefined;
      let reject = true;
      const ctx = context();
      const tool = tools(
        { memory: { query: async () => [evidence("a"), evidence("b")] } },
        {
          fit: async () => (value) => {
            provisional = value as Catalog;
            if (reject) {
              if (mode === "cancel") ctx.controller.abort(new Error("cancelled in fit"));
              else throw new Error("fit failed");
            }
            return true;
          },
        },
      );
      await expect(tool.execute("memory.query", { query: "", limit: 1 }, ctx)).rejects.toThrow();
      const attempted = provisional;
      if (!attempted) throw new Error("Missing provisional envelope");
      reject = false;
      const live = mode === "cancel" ? context() : ctx;
      await expect(
        tool.execute("memory.read", { bodyRef: attempted.items[0].bodyRef }, live),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
      await expect(
        tool.execute("memory.query", { query: "", cursor: attempted.nextCursor }, live),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    }
  });

  it("atomically bounds retained pending candidates for concurrent queries", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let fitCount = 0;
    const tool = tools(
      {
        memory: {
          query: async () => Array.from({ length: 300 }, (_, index) => evidence(String(index))),
        },
      },
      {
        fit: async () => {
          if (++fitCount === 2) entered.resolve();
          await release.promise;
          return () => true;
        },
      },
    );
    const ctx = context();
    const pending = [
      tool.execute("memory.query", { query: "a", limit: 100 }, ctx),
      tool.execute("memory.query", { query: "b", limit: 100 }, ctx),
    ];
    await entered.promise;
    release.resolve();
    const results = await Promise.all(pending);
    expect(results.filter((result) => catalog(result).status === "ok")).toHaveLength(1);
    expect(results.filter((result) => catalog(result).status === "unavailable")[0]?.value).toEqual(
      budgetFailure,
    );
  });

  it("bounds retained refs and cursor-only pages and never caches unbounded external bodies", async () => {
    const ctx = context();
    const tool = tools({ memory: { query: async () => [evidence("a")] } });
    for (let i = 0; i < 512; i++)
      expect(catalog(await tool.execute("memory.query", { query: "" }, ctx)).status).toBe("ok");
    expect((await tool.execute("memory.query", { query: "" }, ctx)).value).toEqual(budgetFailure);
    const cursorTool = tools({
      memory: { query: async () => ({ status: "ok", items: [], nextCursor: "next" }) },
    });
    const pages = context("pages");
    let next: string | undefined;
    for (let i = 0; i < 512; i++)
      next = cursor(
        await cursorTool.execute(
          "memory.query",
          { query: "", ...(next ? { cursor: next } : {}) },
          pages,
        ),
      );
    expect(
      (await cursorTool.execute("memory.query", { query: "", cursor: next }, pages)).value,
    ).toEqual(budgetFailure);
    const huge = tools({
      memory: { query: async () => [evidence("huge", "x".repeat(9 * 1024 * 1024))] },
    });
    expect((await huge.execute("memory.query", { query: "" }, context("huge"))).value).toEqual(
      budgetFailure,
    );
  });

  it("prices actual projected memory observations under the unchanged cumulative 4096 allowance", async () => {
    const authority = { kind: "memory_access", id: "owned-entry", revision: "a".repeat(4096) };
    const business = { kind: "future_business_source", id: "entry", revision: "content-1" };
    const sample = { ...evidence("entry", "证"), sources: [authority, business] };
    const original = structuredClone(sample);
    const checked: SourceRef[][] = [];
    const tool = tools(
      { memory: { query: async () => [sample] } },
      {
        budget: () => 4096,
        assertSources: (sources) => {
          checked.push(structuredClone([...sources]));
        },
        fit: async () => (_value, sources) => {
          expect(sources).toContainEqual(authority);
          expect(sources).toContainEqual(business);
          return true;
        },
      },
    );
    const engine = new ContextEngine();
    const pricingSpec = {
      id: "memory-pages",
      context: "conversation" as const,
      availableActions: tool.actions.map((action) => action.description),
      limits: { steps: 16 },
    };
    const emptyUnits = engine.render(pricingSpec, {}, [], []).units;
    const units = (name: string, args: Record<string, unknown>, result: Observation) =>
      engine.render(
        pricingSpec,
        {},
        [
          {
            ...result,
            id: "00000000-0000-0000-0000-000000000000",
            name,
            arguments: args,
          },
        ],
        [],
      ).units - emptyUnits;
    const ctx = context();
    const args = { query: "entry" };
    const query = await tool.execute("memory.query", args, ctx);
    expect(catalog(query).status).toBe("ok");
    const queryUnits = units("memory.query", args, query);
    expect(queryUnits).toBeLessThan(4096);
    expect(observationUnits("memory.query", args, query.value, query.sources)).toBeGreaterThan(
      4096,
    );
    expect(query.sources).toEqual(sample.sources);
    const readArgs = { bodyRef: bodyRef(query) };
    const firstRead = await tool.execute("memory.read", readArgs, ctx);
    expect(textResult(firstRead).items[0]?.text).toBe(sample.text);
    const readUnits = units("memory.read", readArgs, firstRead);
    const remainingReads = Math.floor((4096 - queryUnits - readUnits) / readUnits);
    for (let index = 0; index < remainingReads; index++) {
      expect((await tool.execute("memory.read", readArgs, ctx)).value).toEqual(firstRead.value);
    }
    expect((await tool.execute("memory.read", readArgs, ctx)).value).toEqual(budgetFailure);
    expect(
      checked.some((sources) => JSON.stringify(sources) === JSON.stringify(sample.sources)),
    ).toBe(true);
    expect(sample).toEqual(original);
    const rendered = engine.render(
      pricingSpec,
      {},
      [
        {
          ...query,
          id: "00000000-0000-0000-0000-000000000000",
          name: "memory.query",
          arguments: args,
        },
      ],
      [],
    );
    expect(rendered.sources).toEqual(sample.sources);
    const message = rendered.messages.at(-1)?.content[0];
    if (message?.kind !== "text") throw new Error("missing actual observation message");
    expect(JSON.parse(message.text).value.sources).toEqual([business]);
    tool.release(ctx);
    await expect(tool.execute("memory.read", readArgs, ctx)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
  });

  it("retains the full authority footprint cap and cancellation after model projection", async () => {
    const sample = evidence("oversized-internal", "body");
    sample.sources = [
      { kind: "memory_access", id: "entry", revision: "a".repeat(2 * 1024 * 1024 + 1) },
    ];
    const retained = tools({ memory: { query: async () => [sample] } });
    expect((await retained.execute("memory.query", { query: "entry" }, context())).value).toEqual(
      budgetFailure,
    );
    const pending = deferred<Evidence[]>();
    const cancelled = tools({ memory: { query: () => pending.promise } });
    const ctx = context("cancelled-authority");
    const query = cancelled.execute("memory.query", { query: "entry" }, ctx);
    ctx.controller.abort(new Error("cancel authority result"));
    pending.resolve([
      { ...evidence("small"), sources: [{ kind: "memory_access", id: "entry", revision: "1" }] },
    ]);
    await expect(query).rejects.toThrow("cancel authority result");
  });
});
