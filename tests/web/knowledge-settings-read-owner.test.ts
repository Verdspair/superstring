import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSettings } from "../../src/shared/contracts/knowledge";
import type { SuperstringApi } from "../../src/web/api";
import { ApiError } from "../../src/web/api";
import {
  acceptKnowledgeSettings,
  readKnowledgeSettings,
} from "../../src/web/features/knowledge/settings-read";
import { useSuperstringStore as store } from "../../src/web/store";

const settings = (revision: number): KnowledgeSettings => ({
  revision,
  auto_enabled: true,
  model_name: null,
  context_budget: 2048,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe("knowledge settings raw read owner", () => {
  it("last hidden knowledge model subscriber aborts while another live subscriber is protected and resumes its dirty model once", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    let signal!: AbortSignal;
    const getKnowledgeSettings = vi
      .fn()
      .mockResolvedValueOnce(settings(1))
      .mockImplementationOnce((input?: AbortSignal) => {
        signal = input!;
        return new Promise(() => {});
      })
      .mockResolvedValueOnce(settings(2));
    store.getState().resetForTests({ getKnowledgeSettings } as unknown as SuperstringApi);
    const firstOwner = {},
      secondOwner = {};
    await store.getState().acquireKnowledgeModelRead(firstOwner);
    await store.getState().acquireKnowledgeModelRead(secondOwner);
    store.getState().patchKnowledgeModel("local dirty");
    const refresh = store.getState().loadKnowledgeModel(true);
    await vi.waitFor(() => expect(signal).toBeDefined());
    hidden = true;
    store.getState().releaseKnowledgeModelRead(firstOwner);
    expect(signal.aborted).toBe(false);
    store.getState().releaseKnowledgeModelRead(secondOwner);
    expect(signal.aborted).toBe(true);
    await refresh;
    hidden = false;
    await store.getState().acquireKnowledgeModelRead(firstOwner);
    expect(getKnowledgeSettings).toHaveBeenCalledTimes(3);
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(2);
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("local dirty");
    store.getState().releaseKnowledgeModelRead(firstOwner);
  });
  it("knowledge model consumer leases ignore retained inactive cleanup and only the last acquired owner aborts", async () => {
    const pending = deferred<KnowledgeSettings>();
    let signal!: AbortSignal;
    const getKnowledgeSettings = vi.fn((input?: AbortSignal) => {
      signal = input!;
      return pending.promise;
    });
    store.getState().resetForTests({ getKnowledgeSettings } as unknown as SuperstringApi);
    const ownerA = {},
      ownerB = {},
      inactive = {};
    const first = store.getState().acquireKnowledgeModelRead(ownerA);
    const repeat = store.getState().acquireKnowledgeModelRead(ownerA);
    const second = store.getState().acquireKnowledgeModelRead(ownerB);
    await vi.waitFor(() => expect(getKnowledgeSettings).toHaveBeenCalledTimes(1));
    store.getState().releaseKnowledgeModelRead(inactive);
    expect(signal.aborted).toBe(false);
    store.getState().releaseKnowledgeModelRead(ownerA);
    expect(signal.aborted).toBe(false);
    pending.resolve(settings(4));
    await Promise.all([first, repeat, second]);
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(4);
    store.getState().releaseKnowledgeModelRead(ownerB);
  });
  it("knowledge model API replacement isolates old leases and explicit full cancellation still aborts", async () => {
    let oldSignal!: AbortSignal, newSignal!: AbortSignal;
    const oldClient = {
      getKnowledgeSettings: vi.fn((input?: AbortSignal) => {
        oldSignal = input!;
        return new Promise<KnowledgeSettings>(() => {});
      }),
    } as unknown as SuperstringApi;
    store.getState().resetForTests(oldClient);
    const oldOwner = {},
      nextOwner = {};
    const oldRead = store.getState().acquireKnowledgeModelRead(oldOwner);
    await vi.waitFor(() => expect(oldSignal).toBeDefined());
    const replacement = {
      getKnowledgeSettings: vi.fn((input?: AbortSignal) => {
        newSignal = input!;
        return new Promise<KnowledgeSettings>(() => {});
      }),
    } as unknown as SuperstringApi;
    store.setState({ apiClient: replacement });
    const nextRead = store.getState().acquireKnowledgeModelRead(nextOwner);
    await vi.waitFor(() => expect(newSignal).toBeDefined());
    expect(oldSignal.aborted).toBe(true);
    await oldRead;
    store.getState().releaseKnowledgeModelRead(oldOwner);
    expect(newSignal.aborted).toBe(false);
    store.getState().cancelKnowledgeModelRead();
    expect(newSignal.aborted).toBe(true);
    await nextRead;
    expect(store.getState().knowledgeModelLoading).toBe(false);
  });
  it("visible tab departure and return do not reread a dirty Agent baseline or lose its draft", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const config = { enabled: true, context_budget: 2048, scope: "all" as const, document_ids: [] };
    const getAgentKnowledgeRead = vi.fn(async () => ({ revision: 1, config }));
    const listAgentKnowledge = vi.fn(async () => []);
    store.getState().resetForTests({
      getAgentKnowledgeRead,
      listAgentKnowledge,
      getKnowledgeSettings: vi.fn(async () => settings(3)),
    } as unknown as SuperstringApi);
    store.setState({ editorAgentId: "A" });
    await store.getState().loadKnowledgeRead();
    store.getState().patchKnowledgeRead({ context_budget: 900 });
    store.getState().cancelKnowledgeRead();
    await store.getState().loadKnowledgeRead();
    expect(getAgentKnowledgeRead).toHaveBeenCalledTimes(1);
    expect(listAgentKnowledge).toHaveBeenCalledTimes(2);
    expect(store.getState().knowledgeReadEditor?.source.revision).toBe(1);
    expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBe(900);
  });
  it("a truly hidden Agent read retains conflicting CAS until explicit refresh then merges untouched fields", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    const first = { enabled: true, context_budget: 2048, scope: "all", document_ids: [] };
    const fresh = { ...first, enabled: false, context_budget: 1024 };
    const getAgentKnowledgeRead = vi
      .fn()
      .mockResolvedValueOnce({ revision: 1, config: first })
      .mockResolvedValue({ revision: 2, config: fresh });
    const client = {
      getAgentKnowledgeRead,
      listAgentKnowledge: vi.fn(async () => []),
      getKnowledgeSettings: vi.fn(async () => settings(3)),
    } as unknown as SuperstringApi;
    store.getState().resetForTests(client);
    store.setState({ editorAgentId: "A" });
    await store.getState().loadKnowledgeRead();
    store.getState().patchKnowledgeRead({ context_budget: 900 });
    hidden = true;
    store.getState().cancelKnowledgeRead();
    hidden = false;
    await store.getState().loadKnowledgeRead();
    expect(getAgentKnowledgeRead).toHaveBeenCalledTimes(2);
    expect(store.getState().knowledgeReadEditor?.source.revision).toBe(1);
    expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBe(900);
    expect(store.getState().knowledgeReadError).toBeTruthy();
    await store.getState().refreshKnowledgeRead();
    expect(getAgentKnowledgeRead).toHaveBeenCalledTimes(3);
    expect(store.getState().knowledgeReadEditor?.source.revision).toBe(2);
    expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBe(900);
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(false);
  });
  it("coalesces cold Agent, model and library consumers into one raw settings read", async () => {
    const pending = deferred<KnowledgeSettings>();
    const getKnowledgeSettings = vi.fn(() => pending.promise);
    const config = { enabled: true, context_budget: null, scope: "all", document_ids: [] };
    const client = {
      getKnowledgeSettings,
      getAgentKnowledgeRead: vi.fn(async () => ({ revision: 1, config })),
      listAgentKnowledge: vi.fn(async () => []),
      listKnowledgeDocuments: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      listKnowledgeCategories: vi.fn(async () => []),
    } as unknown as SuperstringApi;
    store.getState().resetForTests(client);
    store.setState({ editorAgentId: "A" });
    const reads = [
      store.getState().loadKnowledgeRead(),
      store.getState().loadKnowledgeModel(),
      store.getState().loadKnowledge(),
    ];
    await vi.waitFor(() => expect(getKnowledgeSettings).toHaveBeenCalledTimes(1));
    pending.resolve(settings(3));
    await Promise.all(reads);
    expect(getKnowledgeSettings).toHaveBeenCalledTimes(1);
    expect(store.getState().knowledgeReadEditor?.globalBudget).toBe(2048);
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(3);
    expect(store.getState().knowledgeSettings?.revision).toBe(3);
  });

  it("API replacement aborts old transport and never publishes its result into the next owner", async () => {
    const pending = deferred<KnowledgeSettings>();
    let signal!: AbortSignal;
    const oldClient = {
      getKnowledgeSettings: vi.fn((input: AbortSignal) => {
        signal = input;
        return pending.promise;
      }),
    } as unknown as SuperstringApi;
    store.getState().resetForTests(oldClient);
    const oldRead = readKnowledgeSettings(store.getState).catch(() => null);
    await vi.waitFor(() => expect(oldClient.getKnowledgeSettings).toHaveBeenCalledTimes(1));
    store.getState().resetForTests({
      getKnowledgeSettings: vi.fn(async () => settings(2)),
    } as unknown as SuperstringApi);
    expect(signal.aborted).toBe(true);
    expect(await oldRead).toBeNull();
    expect(await readKnowledgeSettings(store.getState)).toEqual(settings(2));
    pending.resolve(settings(1));
  });
  it("shares concurrent consumers without caching settled results", async () => {
    const pending = deferred<KnowledgeSettings>();
    const getKnowledgeSettings = vi.fn(() => pending.promise);
    store.getState().resetForTests({ getKnowledgeSettings } as unknown as SuperstringApi);
    const a = readKnowledgeSettings(store.getState),
      b = readKnowledgeSettings(store.getState);
    await vi.waitFor(() => expect(getKnowledgeSettings).toHaveBeenCalledTimes(1));
    pending.resolve(settings(1));
    expect(await a).toEqual(settings(1));
    expect(await b).toEqual(settings(1));
    const next = readKnowledgeSettings(store.getState);
    await next;
    expect(getKnowledgeSettings).toHaveBeenCalledTimes(2);
  });
  it("refresh supersedes transport once and existing subscribers follow the new revision", async () => {
    const old = deferred<KnowledgeSettings>(),
      fresh = deferred<KnowledgeSettings>();
    const getKnowledgeSettings = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => fresh.promise);
    store.getState().resetForTests({ getKnowledgeSettings } as unknown as SuperstringApi);
    const a = readKnowledgeSettings(store.getState);
    await vi.waitFor(() => expect(getKnowledgeSettings).toHaveBeenCalledTimes(1));
    const b = readKnowledgeSettings(store.getState, { force: true });
    await vi.waitFor(() => expect(getKnowledgeSettings).toHaveBeenCalledTimes(2));
    fresh.resolve(settings(3));
    expect(await a).toEqual(settings(3));
    expect(await b).toEqual(settings(3));
    old.resolve(settings(1));
  });
  it("aborting one lease does not abort another, last lease aborts real transport", async () => {
    const pending = deferred<KnowledgeSettings>();
    let signal!: AbortSignal;
    const getKnowledgeSettings = vi.fn((input: AbortSignal) => {
      signal = input;
      return pending.promise;
    });
    store.getState().resetForTests({ getKnowledgeSettings } as unknown as SuperstringApi);
    const first = new AbortController(),
      second = new AbortController();
    const a = readKnowledgeSettings(store.getState, { signal: first.signal }).catch(() => null);
    const b = readKnowledgeSettings(store.getState, { signal: second.signal }).catch(() => null);
    await vi.waitFor(() => expect(getKnowledgeSettings).toHaveBeenCalledTimes(1));
    first.abort();
    expect(await a).toBeNull();
    expect(signal.aborted).toBe(false);
    second.abort();
    expect(await b).toBeNull();
    expect(signal.aborted).toBe(true);
  });
  it("a committed revision wins an older in-flight read without a second cache", async () => {
    const pending = deferred<KnowledgeSettings>();
    const client = {
      getKnowledgeSettings: vi.fn(() => pending.promise),
    } as unknown as SuperstringApi;
    store.getState().resetForTests(client);
    const read = readKnowledgeSettings(store.getState);
    await vi.waitFor(() => expect(client.getKnowledgeSettings).toHaveBeenCalledTimes(1));
    acceptKnowledgeSettings(store.getState, client, settings(5));
    expect(await read).toEqual(settings(5));
    pending.resolve(settings(1));
  });
});

describe("knowledge settings automatic resume conflicts", () => {
  it.each(["budget", "model"] as const)(
    "keeps old revision for a dirty %s conflict, fails CAS, then explicitly refreshes before retry",
    async (scope) => {
      let hidden = false;
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
        hidden ? "hidden" : "visible",
      );
      let remote: KnowledgeSettings = { ...settings(1), model_name: "M1" };
      const getKnowledgeSettings = vi.fn(async () => remote);
      const saveKnowledgeSettings = vi.fn(
        async (body: Parameters<SuperstringApi["saveKnowledgeSettings"]>[0]) => {
          if (body.expected_revision !== remote.revision)
            throw new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict");
          remote = { ...body, revision: remote.revision + 1 };
          return remote;
        },
      );
      store.getState().resetForTests({
        getKnowledgeSettings,
        saveKnowledgeSettings,
      } as unknown as SuperstringApi);
      const owner = {};
      await store.getState().acquireKnowledgeModelRead(owner);
      if (scope === "budget") store.getState().patchKnowledgeGlobal({ contextBudget: 200 });
      else store.getState().patchKnowledgeModel("M2");
      hidden = true;
      store.getState().releaseKnowledgeModelRead(owner);
      remote = {
        ...remote,
        revision: 2,
        ...(scope === "budget" ? { context_budget: 300 } : { model_name: "M3" }),
      };
      hidden = false;
      await store.getState().acquireKnowledgeModelRead(owner);
      expect(store.getState().knowledgeModelEditor?.source.revision).toBe(1);
      expect(store.getState().knowledgeModelError[scope]).toBeTruthy();
      expect(await store.getState().saveKnowledgeModel(scope)).toBe(false);
      expect(saveKnowledgeSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ expected_revision: 1 }),
      );
      expect(remote.revision).toBe(2);
      expect(store.getState().knowledgeModelEditor?.source.revision).toBe(1);
      await store.getState().loadKnowledgeModel(true);
      expect(store.getState().knowledgeModelEditor?.source.revision).toBe(2);
      expect(
        store.getState().knowledgeModelEditor?.[scope === "budget" ? "contextBudget" : "modelName"],
      ).toBe(scope === "budget" ? 200 : "M2");
      expect(await store.getState().saveKnowledgeModel(scope)).toBe(true);
      expect(saveKnowledgeSettings).toHaveBeenCalledTimes(2);
      store.getState().releaseKnowledgeModelRead(owner);
    },
  );
  it("preserves unrelated remote budget and a local model draft on automatic resume", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    let remote = { ...settings(1), model_name: "M1" };
    store.getState().resetForTests({
      getKnowledgeSettings: vi.fn(async () => remote),
    } as unknown as SuperstringApi);
    const owner = {};
    await store.getState().acquireKnowledgeModelRead(owner);
    store.getState().patchKnowledgeModel("M2");
    hidden = true;
    store.getState().releaseKnowledgeModelRead(owner);
    remote = { ...remote, revision: 2, context_budget: 3000 };
    hidden = false;
    await store.getState().acquireKnowledgeModelRead(owner);
    expect(store.getState().knowledgeModelEditor).toMatchObject({
      source: { revision: 2, context_budget: 3000 },
      modelName: "M2",
      contextBudget: 3000,
    });
    expect(store.getState().knowledgeModelError).toEqual({
      model: null,
      budget: null,
      shared: null,
    });
    store.getState().releaseKnowledgeModelRead(owner);
  });
  it("does not approve a conflicting private model draft when auto-only settings saves against a newer shared baseline", async () => {
    let remote: KnowledgeSettings = { ...settings(1), model_name: "M1" };
    const saveKnowledgeSettings = vi.fn(
      async (body: Parameters<SuperstringApi["saveKnowledgeSettings"]>[0]) => {
        if (body.expected_revision !== remote.revision)
          throw new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict");
        remote = { ...body, revision: remote.revision + 1 };
        return remote;
      },
    );
    store.getState().resetForTests({
      getKnowledgeSettings: vi.fn(async () => remote),
      saveKnowledgeSettings,
      listKnowledgeDocuments: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      listKnowledgeCategories: vi.fn(async () => []),
    } as unknown as SuperstringApi);
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("M2");
    await store.getState().openKnowledgeEditor({ kind: "settings" });
    const editor = store.getState().knowledgeEditor;
    if (editor?.kind !== "settings") throw new Error("settings missing");
    store.getState().updateKnowledgeEditor({ ...editor, auto_enabled: false });
    remote = { ...remote, revision: 2, model_name: "M3" };
    store.setState({ knowledgeSettings: remote });
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 2,
      auto_enabled: false,
      model_name: "M3",
      context_budget: 2048,
    });
    expect(store.getState().knowledgeSettings?.revision).toBe(3);
    expect(store.getState().knowledgeModelEditor).toMatchObject({
      source: { revision: 1, model_name: "M1" },
      modelName: "M2",
    });
    expect(store.getState().knowledgeModelError.model).toBeTruthy();
    expect(await store.getState().saveKnowledgeModel("model")).toBe(false);
    expect(remote.model_name).toBe("M3");
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("M2");
  });
});

it("converges a locally changed auto boolean with the same remote value and preserves a remote model", async () => {
  const first = { ...settings(1), auto_enabled: false, model_name: "M1" };
  let remote = first;
  store.getState().resetForTests({
    getKnowledgeSettings: vi.fn(async () => remote),
  } as unknown as SuperstringApi);
  await store.getState().openKnowledgeEditor({ kind: "settings" });
  const editor = store.getState().knowledgeEditor;
  if (editor?.kind !== "settings") throw new Error("settings missing");
  store.getState().updateKnowledgeEditor({ ...editor, auto_enabled: true });
  store.getState().cancelKnowledgeLibraryRead();
  remote = { ...first, revision: 2, auto_enabled: true, model_name: "M3" };
  await store.getState().resumeKnowledgeLibraryRead();
  expect(store.getState().knowledgeEditor).toMatchObject({
    source: { revision: 2, model_name: "M3" },
    auto_enabled: true,
  });
  expect(store.getState().knowledgeLibraryError).toBeNull();
});
