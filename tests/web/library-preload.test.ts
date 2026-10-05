import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocument } from "../../src/shared/contracts/knowledge";
import { api } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";

const categories = [{ id: "default", name: "资料", revision: 1, document_count: 1 }];
const settings = { revision: 1, auto_enabled: true, model_name: null, context_budget: 2048 };
const document: KnowledgeDocument = {
  id: "33333333-3333-4333-8333-333333333333",
  category_id: "default",
  name: "预热资料",
  import_type: "md",
  content_mode: "draft",
  content_version: 1,
  revision: 2,
  created_at: "2026-10-05T00:00:00Z",
  updated_at: "2026-10-05T00:00:00Z",
  agent_ids: [],
  summary: "",
  tags: [],
  organization_status: "queued",
  error_code: null,
};
const page = { items: [document], next_cursor: null, total: 1 };

beforeEach(() => {
  store.getState().resetForTests({
    ...api,
    listKnowledgeDocuments: vi.fn().mockResolvedValue(page),
    listKnowledgeCategories: vi.fn().mockResolvedValue(categories),
    getKnowledgeSettings: vi.fn().mockResolvedValue(settings),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("library first-page warm", () => {
  it("background warm loads the first page once and marks the list ready", async () => {
    const done = await store.getState().loadKnowledge(undefined, { background: true });
    expect(done).toBe(true);
    const s = store.getState();
    expect(s.knowledgeLoaded).toBe(true);
    expect(s.knowledgeDocuments).toEqual([document]);
    expect(s.knowledgeTotal).toBe(1);
    expect(s.knowledgeCategories).toEqual(categories);
    expect(s.knowledgeNextCursor).toBeNull();
    expect(s.error).toBeNull();
    expect(s.apiClient.listKnowledgeDocuments).toHaveBeenCalledTimes(1);
  });

  it("background warm failure degrades silently without touching global error", async () => {
    vi.mocked(store.getState().apiClient.listKnowledgeDocuments).mockRejectedValueOnce(
      new Error("warm failed"),
    );
    const done = await store.getState().loadKnowledge(undefined, { background: true });
    expect(done).toBe(false);
    const s = store.getState();
    expect(s.error).toBeNull();
    expect(s.knowledgeLoaded).toBe(false);
    expect(s.knowledgeLoading).toBe(false);
  });

  it("concurrent background warms share one in-flight first-page read", async () => {
    const first = store.getState().loadKnowledge(undefined, { background: true });
    const second = store.getState().loadKnowledge(undefined, { background: true });
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(store.getState().apiClient.listKnowledgeDocuments).toHaveBeenCalledTimes(1);
  });

  it("ready list is reused by later warm, foreground load still refreshes", async () => {
    expect(await store.getState().loadKnowledge(undefined, { background: true })).toBe(true);
    expect(await store.getState().loadKnowledge(undefined, { background: true })).toBe(true);
    expect(store.getState().apiClient.listKnowledgeDocuments).toHaveBeenCalledTimes(1);
    expect(await store.getState().loadKnowledge()).toBe(true);
    expect(store.getState().apiClient.listKnowledgeDocuments).toHaveBeenCalledTimes(2);
  });

  it("foreground read joins an in-flight warm instead of resending or aborting it", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(store.getState().apiClient.listKnowledgeDocuments).mockImplementationOnce(
      async () => {
        await gate;
        return page;
      },
    );
    const warm = store.getState().loadKnowledge(undefined, { background: true });
    const fore = store.getState().loadKnowledge();
    let foreSettled = false;
    void fore.then(() => {
      foreSettled = true;
    });
    await Promise.resolve();
    expect(foreSettled).toBe(false);
    const call = store.getState().apiClient.listKnowledgeDocuments as ReturnType<typeof vi.fn>;
    expect(call).toHaveBeenCalledTimes(1);
    const signal = call.mock.calls[0]?.[1] as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);
    release?.();
    expect(await warm).toBe(true);
    expect(await fore).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    const s = store.getState();
    expect(s.knowledgeLoaded).toBe(true);
    expect(s.knowledgeDocuments).toEqual([document]);
    expect(s.knowledgeLoading).toBe(false);
  });

  it("ready warm makes the mount read a quiet authority refresh and keeps an unrelated error", async () => {
    expect(await store.getState().loadKnowledge(undefined, { background: true })).toBe(true);
    store.setState({ error: "其它分区的旧提示" });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(store.getState().apiClient.listKnowledgeDocuments).mockImplementationOnce(
      async () => {
        await gate;
        return page;
      },
    );
    const fore = store.getState().loadKnowledge(undefined, { quiet: true });
    await Promise.resolve();
    // 静默刷新不打断当前列表，也不改用户的过滤与光标。
    expect(store.getState().knowledgeLoading).toBe(false);
    expect(store.getState().knowledgeDocuments).toEqual([document]);
    expect(store.getState().knowledgeCursors).toEqual([null]);
    release?.();
    expect(await fore).toBe(true);
    const s = store.getState();
    expect(s.error).toBe("其它分区的旧提示");
    expect(s.knowledgeLoaded).toBe(true);
    expect(s.apiClient.listKnowledgeDocuments).toHaveBeenCalledTimes(2);
  });
});
