import { afterEach, describe, expect, it } from "bun:test";
import {
  type ActionContext,
  type BuiltInAction,
  createEvidenceActionSet,
  type EvidenceCatalogEntry,
  type EvidenceQueryModule,
} from "../../src/server/agent/built-in-actions";
import { fail } from "../../src/server/errors";
import type { Evidence } from "../../src/shared/contracts/evidence";

type Options = Parameters<typeof createEvidenceActionSet>[1];
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
/** Synthetic generic module: proves the registry mechanism, not any QQ authorization. */
function historyModule(item: Evidence): EvidenceQueryModule {
  return { query: async () => ({ status: "ok", items: [item] }) };
}
function context(
  runId = "run1",
  owner: Partial<ActionContext["owner"]> = {},
): ActionContext & {
  controller: AbortController;
} {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    controller,
    owner: { kind: "qq_binding", id: "binding1", userId: "user", agentId: "agent", ...owner },
    runId,
    signal: controller.signal,
  };
}
function evidence(id: string, text = `body ${id}`): Evidence {
  return {
    id,
    text,
    preview: { title: `title ${id}`, summary: `summary ${id}` },
    sources: [{ kind: "synthetic-source", id, revision: "1" }],
  };
}
/** Merge caller options with the safe defaults required by every factory call. */
function withDefaults(options: Partial<Options> = {}): Options {
  return {
    assertSources: () => {},
    fit: async () => () => true,
    ...options,
  };
}
function textResult(observation: Observation): TextResult {
  return observation.value as TextResult;
}
function readAction(set: { actions: BuiltInAction[] }, kind = "history"): BuiltInAction {
  const action = set.actions.find((entry) => entry.description.name === `${kind}.read`);
  if (!action) throw new Error(`${kind}.read not advertised`);
  return action;
}
const budgetFailure = { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED", items: [] };
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
});

describe("host-seeded evidence registry", () => {
  it("seeds a scoped read reference without a fake query", async () => {
    const text = "这是一条足够长的合成原文，不含真实消息。";
    const quotedEvidence: Evidence = {
      id: "synthetic-quoted-message",
      text,
      sources: [{ kind: "synthetic-source", id: "message1", revision: "1" }],
    };
    const context: ActionContext = {
      owner: {
        kind: "qq_binding",
        id: "binding1",
        userId: "synthetic-user",
        agentId: "synthetic-agent",
      },
      runId: "run1",
      signal: new AbortController().signal,
    };
    const set = createEvidenceActionSet(
      { history: historyModule(evidence("q")) },
      withDefaults({
        assertSources: (refs) => expect(refs).toEqual(quotedEvidence.sources),
        fit: async () => () => true,
      }),
    );
    const ref = set.registerEvidence("history", quotedEvidence, context);
    expect(typeof ref).toBe("string");
    const action = readAction(set);
    expect(
      (await action.execute({ bodyRef: ref, offset: 0, limit: 5 }, context)).value,
    ).toMatchObject({
      status: "ok",
      items: [{ bodyRef: ref, text: "这是一条足", offset: 0, nextOffset: 5 }],
    });
    await expect(
      action.execute({ bodyRef: ref }, { ...context, runId: "other-run" }),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
  });

  it("exposes the same actions as createBuiltInActions from one factory without a second registry", () => {
    const set = createEvidenceActionSet({ history: historyModule(evidence("q")) }, withDefaults());
    expect(set.actions.map((action) => action.description.name)).toEqual([
      "history.query",
      "history.read",
    ]);
    expect(set.actions.every((action) => action.description.effect === "read")).toBe(true);
  });

  it("registers opaque random refs even for identical evidence, other domains and separate factories", () => {
    const item = evidence("predictable");
    const set = createEvidenceActionSet({ history: historyModule(evidence("q")) }, withDefaults());
    const ctx = context();
    const first = set.registerEvidence("history", item, ctx);
    const second = set.registerEvidence("history", item, ctx);
    const otherDomain = createEvidenceActionSet(
      { history: historyModule(evidence("q")) },
      withDefaults(),
    );
    const otherKind = otherDomain.registerEvidence("history", item, ctx);
    expect(new Set([first, second, otherKind]).size).toBe(3);
    expect(first).not.toContain("predictable");
    expect(first).not.toBe(item.id);
  });

  it("rejects cross-owner, cross-domain, cross-factory and forged refs on read", async () => {
    const item = evidence("scoped");
    const set = createEvidenceActionSet({ history: historyModule(evidence("q")) }, withDefaults());
    const other = createEvidenceActionSet(
      { history: historyModule(evidence("q")) },
      withDefaults(),
    );
    const ctx = context();
    const ref = set.registerEvidence("history", item, ctx);
    const action = readAction(set);
    for (const otherContext of [
      context("other-run"),
      context("run1", { kind: "other" }),
      context("run1", { id: "other" }),
      context("run1", { userId: "other" }),
      context("run1", { agentId: "other" }),
    ] as ActionContext[]) {
      await expect(action.execute({ bodyRef: ref }, otherContext)).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
    }
    await expect(readAction(other).execute({ bodyRef: ref }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    expect(() => set.registerEvidence("knowledge", item, ctx)).toThrow();
    await expect(action.execute({ bodyRef: "forged-random-uuid" }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    await expect(action.execute({ bodyRef: item.id }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
  });

  it("refuses seeding through an unnamed namespace instead of leaking an undefined runId", () => {
    const set = createEvidenceActionSet({ history: historyModule(evidence("q")) }, withDefaults());
    const named = context();
    const unnamed: ActionContext = { owner: named.owner, signal: named.signal };
    expect(() => set.registerEvidence("history", evidence("a"), unnamed)).toThrow();
  });

  it("shares the 512 ref and 2MiB retained caps between seed and query, with real counts", async () => {
    const set = createEvidenceActionSet({ history: historyModule(evidence("q")) }, withDefaults());
    const ctx = context();
    const refs: string[] = [];
    for (let i = 0; i < 512; i++)
      refs.push(set.registerEvidence("history", evidence(`seed-${i}`), ctx));
    const action = readAction(set);
    // Seeded reads still succeed; the ref cap only blocks new registrations.
    expect(textResult(await action.execute({ bodyRef: refs[0] }, ctx)).status).toBe("ok");
    const queryAction = set.actions.find((entry) => entry.description.name === "history.query");
    if (!queryAction) throw new Error("history.query not advertised");
    // At the 512 ref cap, any new query registration is refused with a real count.
    expect((await queryAction.execute({ query: "" }, ctx)).value).toEqual(budgetFailure);
  });

  it("rejects a seed when the source validation fails and registers nothing", async () => {
    let revocations = 0;
    let revoked = false;
    const set = createEvidenceActionSet(
      { history: historyModule(evidence("q")) },
      withDefaults({
        assertSources() {
          if (revoked) {
            revocations++;
            fail("CONTEXT_SOURCE_INVALID", "revoked");
          }
        },
      }),
    );
    const ctx = context();
    revoked = true;
    expect(() => set.registerEvidence("history", evidence("blocked"), ctx)).toThrow(
      /CONTEXT_SOURCE_INVALID|revoked/,
    );
    revoked = false;
    const action = readAction(set);
    await expect(action.execute({ bodyRef: "blocked" }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    expect(revocations).toBe(1);
    // A healthy seed still works afterwards: the failed one did not poison the run.
    const ref = set.registerEvidence("history", evidence("after"), ctx);
    expect(textResult(await action.execute({ bodyRef: ref }, ctx)).status).toBe("ok");
  });

  it("keeps caller mutations of the registered evidence from changing retained state", async () => {
    const set = createEvidenceActionSet({ history: historyModule(evidence("q")) }, withDefaults());
    const ctx = context();
    const item = evidence("mutable");
    const ref = set.registerEvidence("history", item, ctx);
    item.text = "mutated";
    item.sources[0].revision = "mutated";
    if (item.preview) item.preview.title = "mutated";
    const action = readAction(set);
    const result = textResult(await action.execute({ bodyRef: ref, limit: 4096 }, ctx));
    expect(result.items[0].text).toBe("body mutable");
    const controller = new AbortController();
    const sources = await action.execute(
      { bodyRef: ref },
      {
        ...ctx,
        signal: controller.signal,
      },
    );
    expect(sources.sources).toEqual([{ kind: "synthetic-source", id: "mutable", revision: "1" }]);
  });

  it("reads a lazily described body through module.read with the original body object", async () => {
    const text = "甲\u{20000}e\u0301乙";
    const reads: { offset: number; limit: number; evidence: Evidence }[] = [];
    const set = createEvidenceActionSet(
      {
        history: {
          query: async () => [evidence("lazy", "must not use cached text")],
          async read(
            input,
          ): Promise<import("../../src/server/modules/contracts").EvidenceTextPage> {
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
      },
      withDefaults({ fit: async () => () => true }),
    );
    const ctx = context();
    const ref = set.registerEvidence("history", evidence("lazy", "cached text never used"), ctx);
    const action = readAction(set);
    const chunks: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await action.execute({ bodyRef: ref, offset, limit: 2 }, ctx);
      const page = textResult(result).items[0];
      expect(page.offset).toBe(offset);
      chunks.push(page.text);
      offset = page.nextOffset;
    }
    expect(chunks).toEqual(["甲\u{20000}", "e\u0301", "乙"]);
    expect(chunks.join("")).toBe(text);
    // Lazy modules keep query and seed symmetric: like the query path, the seeded
    // registration strips text so the module only receives a source-bound descriptor
    // (id/preview/sources retained, never the seeded full text). The rendered page
    // comes only from the module's own body object, paged by Unicode points.
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((input) => input.evidence.id === "lazy")).toBe(true);
    expect(reads.every((input) => input.evidence.text === "")).toBe(true);
    expect(
      reads.every(
        (input) =>
          input.evidence.sources.length === 1 &&
          input.evidence.sources[0].kind === "synthetic-source" &&
          input.evidence.sources[0].id === "lazy" &&
          input.evidence.sources[0].revision === "1",
      ),
    ).toBe(true);
  });

  it("charges seeded reads to the same domain budget and permits mixed seed/query refs", async () => {
    const sample = evidence("mixed", "甲\u{20000}");
    const set = createEvidenceActionSet(
      { history: { query: async () => [sample] } },
      withDefaults({ fit: async () => () => true }),
    );
    const ctx = context();
    const seededRef = set.registerEvidence("history", sample, ctx);
    const queryAction = set.actions.find((entry) => entry.description.name === "history.query");
    if (!queryAction) throw new Error("history.query not advertised");
    const queryResult = await queryAction.execute({ query: "" }, ctx);
    const queryValue = queryResult.value as Catalog;
    if (queryValue.status !== "ok") throw new Error("query failed");
    const queryRef = queryValue.items[0].bodyRef;
    const action = readAction(set);
    // Seeded body keeps its original text at Unicode-point offsets...
    expect(textResult(await action.execute({ bodyRef: seededRef }, ctx)).items[0].text).toBe(
      "甲𠀀",
    );
    // ...while the queried ref resolves the same registered body object.
    expect(textResult(await action.execute({ bodyRef: queryRef }, ctx)).items[0].text).toBe("甲𠀀");
    // Old query bodyRefs stay valid after a seed.
    expect(textResult(await action.execute({ bodyRef: queryRef }, ctx)).status).toBe("ok");
  });

  it("rejects seeded reads after release or cancel, like query refs", async () => {
    const set = createEvidenceActionSet({ history: historyModule(evidence("q")) }, withDefaults());
    const ctx = context();
    const ref = set.registerEvidence("history", evidence("released"), ctx);
    const action = readAction(set);
    expect(textResult(await action.execute({ bodyRef: ref }, ctx)).status).toBe("ok");
    for (const entry of set.actions) entry.release?.({ owner: ctx.owner, runId: ctx.runId });
    await expect(action.execute({ bodyRef: ref }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    const cancelCtx = context();
    const cancelRef = set.registerEvidence("history", evidence("cancelled"), cancelCtx);
    cancelCtx.controller.abort(new Error("cancelled"));
    await expect(action.execute({ bodyRef: cancelRef }, cancelCtx)).rejects.toThrow("cancelled");
    // Same factory, a new run can still seed and read.
    const fresh = context("fresh");
    const freshRef = set.registerEvidence("history", evidence("fresh"), fresh);
    expect(textResult(await action.execute({ bodyRef: freshRef }, fresh)).status).toBe("ok");
  });

  it("rejects stale or revoked sources on read after registration", async () => {
    let revoked = false;
    const set = createEvidenceActionSet(
      { history: historyModule(evidence("q")) },
      withDefaults({
        assertSources() {
          if (revoked) fail("CONTEXT_SOURCE_INVALID", "revoked");
        },
      }),
    );
    const ctx = context();
    const ref = set.registerEvidence("history", evidence("stale"), ctx);
    const action = readAction(set);
    expect(textResult(await action.execute({ bodyRef: ref }, ctx)).status).toBe("ok");
    revoked = true;
    await expect(action.execute({ bodyRef: ref }, ctx)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it("keeps seeded and queried refs inside the same 512-cap with a mixed count", async () => {
    const set = createEvidenceActionSet(
      { history: { query: async () => Array.from({ length: 100 }, (_, i) => evidence(`q${i}`)) } },
      withDefaults(),
    );
    const ctx = context();
    const half = 256;
    for (let i = 0; i < half; i++) set.registerEvidence("history", evidence(`s-${i}`), ctx);
    const queryAction = set.actions.find((entry) => entry.description.name === "history.query");
    if (!queryAction) throw new Error("history.query not advertised");
    const page = await queryAction.execute({ query: "", limit: 100 }, ctx);
    expect((page.value as Catalog).items).toHaveLength(100);
    for (let i = 0; i < 155; i++) set.registerEvidence("history", evidence(`s2-${i}`), ctx);
    expect((await queryAction.execute({ query: "", limit: 100 }, ctx)).value).toEqual(
      budgetFailure,
    );
  });

  it("keeps seeding free of observation units regardless of module.read presence", async () => {
    const budget = 0;
    const set = createEvidenceActionSet(
      {
        history: {
          query: async () => [evidence("q")],
          async read(
            input,
          ): Promise<import("../../src/server/modules/contracts").EvidenceTextPage> {
            return {
              text: input.evidence.text.slice(input.offset, input.offset + input.limit),
              offset: input.offset,
              total: input.evidence.text.length,
              nextOffset:
                input.offset + input.limit < input.evidence.text.length
                  ? input.offset + input.limit
                  : null,
            };
          },
        },
      },
      withDefaults({ budget: () => budget }),
    );
    const ctx = context();
    // Zero budget: seeding itself must not be an observation and must stay permitted.
    const ref = set.registerEvidence("history", evidence("seeded"), ctx);
    const action = readAction(set);
    // A seeded read is an observation: with zero budget it is refused even at size 1.
    expect((await action.execute({ bodyRef: ref, limit: 1 }, ctx)).value).toEqual(budgetFailure);
  });

  it("refuses or shrinks a seeded read against a small real budget", async () => {
    const set = createEvidenceActionSet(
      {
        history: {
          query: async () => [evidence("q")],
          async read(
            input,
          ): Promise<import("../../src/server/modules/contracts").EvidenceTextPage> {
            const points = [...input.evidence.text];
            const end = Math.min(points.length, input.offset + input.limit);
            return {
              text: points.slice(input.offset, end).join(""),
              offset: input.offset,
              total: points.length,
              nextOffset: end < points.length ? end : null,
            };
          },
        },
      },
      withDefaults({ budget: () => 0 }),
    );
    const ctx = context();
    // Seed with zero budget is still allowed (seeding is not an observation).
    const ref = set.registerEvidence("history", evidence("budgeted", "零一二三四五六七八"), ctx);
    const action = readAction(set);
    // With zero budget every read size is refused, all the way down to a single point.
    expect((await action.execute({ bodyRef: ref, limit: 2048 }, ctx)).value).toEqual(budgetFailure);
    expect((await action.execute({ bodyRef: ref, limit: 1 }, ctx)).value).toEqual(budgetFailure);
  });
});
