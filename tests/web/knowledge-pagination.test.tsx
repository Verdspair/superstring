// 资料列表的服务端分页专测：过滤进 store、键集翻页、迟到/被顶替响应不写回、
// 失败保列表可重试、翻页后批量快照只含显式勾选，以及两个跨页入口的 outline/default 层级。
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeDocumentDetail,
  KnowledgeDocumentsPage,
} from "../../src/shared/contracts/knowledge";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, document as base, D, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

const zhText = zh as Record<string, string>;
/** 本地键可能晚于 locales 文件落地：缺失时 i18next 原样返回 key。 */
const label = (key: string) => zhText[key] ?? key;
const phrase = (key: string, ...args: string[]) =>
  args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), label(key));

const docA = { ...base, id: D, name: "Alpha", revision: 1 };
const docB = { ...base, id: "66666666-6666-4666-8666-666666666666", name: "Beta", revision: 2 };
const docC = { ...base, id: "77777777-7777-4777-8777-777777777777", name: "Gamma", revision: 3 };
const docD = { ...base, id: "88888888-8888-4888-8888-888888888888", name: "Delta", revision: 4 };

const page = (
  items: (typeof docA)[],
  next_cursor: string | null = null,
): KnowledgeDocumentsPage => ({
  items,
  next_cursor,
  total: items.length,
});

const searchInput = () =>
  screen.getByLabelText(label("library.search.documents")) as HTMLInputElement;
const nextButton = () =>
  screen.getByRole("button", { name: label("library.next.page") }) as HTMLButtonElement;
const prevButton = () =>
  screen.getByRole("button", { name: label("library.previous.page") }) as HTMLButtonElement;
const retryButton = () =>
  screen.getByRole("button", { name: label("capabilities.retry") }) as HTMLButtonElement;
const rowCheckbox = (name: string) =>
  screen.getByRole("checkbox", { name: phrase("library.select.value", name) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("资料列表的服务端分页", () => {
  it.each(["next", "prev"] as const)(
    "待应用搜索时立即 %s 翻页保留已应用查询并恢复搜索框，不再触发延迟请求",
    async (direction) => {
      vi.useFakeTimers();
      const client = setupLibrary({
        listKnowledgeDocuments: vi
          .fn()
          .mockResolvedValueOnce(page([docA], "initial-next"))
          .mockResolvedValueOnce(page([docA], "alpha-next"))
          .mockResolvedValueOnce(page([docC], "alpha-later"))
          .mockResolvedValueOnce(page([docA], "alpha-next")),
      });
      await act(async () => render(<KnowledgeLibrary />));
      await act(async () => {
        fireEvent.change(searchInput(), { target: { value: "Alpha" } });
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(store.getState().knowledgeFilters.search).toBe("Alpha");
      expect(searchInput().value).toBe("Alpha");
      expect(store.getState().knowledgeCursors).toEqual([null]);
      if (direction === "prev") {
        await act(async () => fireEvent.click(nextButton()));
        expect(store.getState().knowledgeCursors).toEqual([null, "alpha-next"]);
      }
      const callsBeforePaging = vi.mocked(client.listKnowledgeDocuments).mock.calls.length;
      await act(async () => fireEvent.change(searchInput(), { target: { value: "Beta" } }));
      expect(searchInput().value).toBe("Beta");
      expect(store.getState().knowledgeFilters.search).toBe("Alpha");
      await act(async () => fireEvent.click(direction === "next" ? nextButton() : prevButton()));
      expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
        direction === "next"
          ? { search: "Alpha", limit: 50, cursor: "alpha-next" }
          : { search: "Alpha", limit: 50 },
        expect.any(AbortSignal),
      );
      expect(client.listKnowledgeDocuments).toHaveBeenCalledTimes(callsBeforePaging + 1);
      expect(store.getState().knowledgeCursors).toEqual(
        direction === "next" ? [null, "alpha-next"] : [null],
      );
      const searchAfterPaging = searchInput().value;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(client.listKnowledgeDocuments).toHaveBeenCalledTimes(callsBeforePaging + 1);
      expect(store.getState().knowledgeFilters.search).toBe("Alpha");
      expect(searchAfterPaging).toBe("Alpha");
      expect(searchInput().value).toBe("Alpha");
    },
  );

  it("首页请求带默认 50 上限，next/prev 使用服务端游标栈", async () => {
    const client = setupLibrary({
      listKnowledgeDocuments: vi
        .fn()
        .mockResolvedValueOnce(page([docA], "c1"))
        .mockResolvedValueOnce({ items: [docB], next_cursor: null, total: 2 })
        .mockResolvedValueOnce({ items: [docA], next_cursor: "c1", total: 2 }),
    });
    await act(async () => render(<KnowledgeLibrary />));
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
      { limit: 50 },
      expect.any(AbortSignal),
    );
    expect(screen.getByText(docA.name)).toBeTruthy();

    await act(async () => fireEvent.click(nextButton()));
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
      { limit: 50, cursor: "c1" },
      expect.any(AbortSignal),
    );
    expect(screen.getByText(docB.name)).toBeTruthy();
    expect(screen.queryByText(docA.name)).toBeNull();
    expect(screen.getByText(phrase("library.value.entries.page.value", "2", "2"))).toBeTruthy();

    await act(async () => fireEvent.click(prevButton()));
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
      { limit: 50 },
      expect.any(AbortSignal),
    );
    expect(screen.getByText(docA.name)).toBeTruthy();
    expect(screen.getByText(phrase("library.value.entries.page.value", "2", "1"))).toBeTruthy();
  });

  it("搜索/分类/状态合并进服务端请求并重置回第一页", async () => {
    vi.useFakeTimers();
    const client = setupLibrary({
      listKnowledgeDocuments: vi
        .fn()
        .mockResolvedValueOnce(page([docA], "c1"))
        .mockResolvedValueOnce({ items: [docB], next_cursor: null, total: 2 })
        .mockResolvedValueOnce(page([docC]))
        .mockResolvedValueOnce(page([docD]))
        .mockResolvedValueOnce(page([docB]))
        .mockResolvedValueOnce(page([docA])),
    });
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => fireEvent.click(nextButton()));
    expect(store.getState().knowledgeCursors).toEqual([null, "c1"]);

    await act(async () => {
      fireEvent.change(searchInput(), { target: { value: "笔记" } });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
      { search: "笔记", limit: 50 },
      expect.any(AbortSignal),
    );
    expect(store.getState().knowledgeCursors).toEqual([null]);

    await act(async () => {
      fireEvent.change(screen.getByLabelText(label("library.filter.categories")), {
        target: { value: "default" },
      });
    });
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
      { search: "笔记", category: "default", limit: 50 },
      expect.any(AbortSignal),
    );

    await act(async () => {
      fireEvent.change(screen.getByLabelText(label("library.organization.status")), {
        target: { value: "failed" },
      });
    });
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
      { search: "笔记", category: "default", status: "failed", limit: 50 },
      expect.any(AbortSignal),
    );

    // 清空搜索即回到不带 search 的请求，其余过滤保留。
    await act(async () => {
      fireEvent.change(searchInput(), { target: { value: "" } });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
      { category: "default", status: "failed", limit: 50 },
      expect.any(AbortSignal),
    );
  });

  it("迟到的旧请求不覆盖已经落页的新结果", async () => {
    vi.useFakeTimers();
    let resolveSlow!: (value: KnowledgeDocumentsPage) => void;
    const slow = new Promise<KnowledgeDocumentsPage>((resolve) => {
      resolveSlow = resolve;
    });
    setupLibrary({
      listKnowledgeDocuments: vi
        .fn()
        .mockReturnValueOnce(slow)
        .mockResolvedValueOnce(page([docC])),
    });
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => {
      fireEvent.change(searchInput(), { target: { value: "b" } });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(store.getState().knowledgeDocuments.map((doc) => doc.id)).toEqual([docC.id]);
    await act(async () => {
      resolveSlow({ items: [docA], next_cursor: "c1", total: 9 });
    });
    expect(store.getState().knowledgeDocuments.map((doc) => doc.id)).toEqual([docC.id]);
    expect(store.getState().knowledgeTotal).toBe(1);
    expect(store.getState().knowledgeNextCursor).toBeNull();
    expect(screen.getByText(docC.name)).toBeTruthy();
  });

  it("翻页失败保留当前页与游标，错误可见且可重试", async () => {
    const client = setupLibrary({
      listKnowledgeDocuments: vi
        .fn()
        .mockResolvedValueOnce(page([docA], "c1"))
        .mockRejectedValueOnce(new Error("服务端不可达"))
        .mockResolvedValueOnce(page([docB])),
    });
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => fireEvent.click(nextButton()));
    expect(store.getState().knowledgeLibraryError).toContain("服务端不可达");
    expect(screen.getByRole("alert").textContent).toContain("服务端不可达");
    expect(store.getState().knowledgeDocuments.map((doc) => doc.id)).toEqual([docA.id]);
    expect(store.getState().knowledgeLoading).toBe(false);
    expect(store.getState().knowledgeNextCursor).toBe("c1");
    expect(screen.getByText(docA.name)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("服务端不可达");
    expect(nextButton().disabled).toBe(false);

    await act(async () => fireEvent.click(retryButton()));
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
      { limit: 50 },
      expect.any(AbortSignal),
    );
    expect(store.getState().error).toBeNull();
    expect(screen.getByText(docB.name)).toBeTruthy();
  });

  it("翻页成功落页才清选择，批量快照与提交只含本页显式勾选项", async () => {
    const client = setupLibrary({
      listKnowledgeDocuments: vi
        .fn()
        .mockResolvedValueOnce({ items: [docA, docB], next_cursor: "c1", total: 4 })
        .mockRejectedValueOnce(new Error("翻页失败"))
        .mockResolvedValueOnce({ items: [docC, docD], next_cursor: null, total: 4 })
        .mockResolvedValueOnce({ items: [docA, docB], next_cursor: "c1", total: 4 }),
    });
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => fireEvent.click(rowCheckbox(docA.name)));
    expect(screen.getByText(phrase("library.value.selected", "1"))).toBeTruthy();

    // 失败的翻页保留原页与既有选择。
    await act(async () => fireEvent.click(nextButton()));
    expect(screen.getByText(phrase("library.value.selected", "1"))).toBeTruthy();
    expect(screen.getByText(docA.name)).toBeTruthy();

    // 成功落页后清选择，旧页的勾选不会跟着走到新页。
    await act(async () => fireEvent.click(nextButton()));
    expect(screen.queryByText(phrase("library.value.selected", "1"))).toBeNull();
    await act(async () => fireEvent.click(rowCheckbox(docC.name)));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: label("library.batch.access") })),
    );
    const editor = store.getState().knowledgeEditor;
    if (editor?.kind !== "batch") throw new Error("Missing batch editor");
    expect(editor.documents.map((doc) => doc.id)).toEqual([docC.id]);

    await act(async () => {
      expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    });
    expect(client.batchKnowledgeGrants).toHaveBeenCalledWith({
      agent_id: A,
      granted: true,
      documents: [{ id: docC.id, expected_revision: docC.revision }],
    });
  });

  it("模式保存只提交模式字段，成功后带过滤回第一页取真实总数", async () => {
    vi.useFakeTimers();
    const client = setupLibrary({
      listKnowledgeDocuments: vi
        .fn()
        .mockResolvedValueOnce(page([docA], "c1"))
        .mockResolvedValueOnce(page([docA], "c2"))
        .mockResolvedValueOnce({ items: [docB], next_cursor: null, total: 3 })
        .mockResolvedValueOnce({ items: [docA, docB], next_cursor: "c2", total: 3 }),
    });
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => {
      fireEvent.change(searchInput(), { target: { value: "标签" } });
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => fireEvent.click(nextButton()));
    expect(store.getState().knowledgeCursors).toEqual([null, "c2"]);

    await act(async () => {
      expect(await store.getState().setKnowledgeMode(docB.id, "original")).toBe(true);
    });
    expect(client.updateKnowledgeDocument).toHaveBeenCalledWith(docB.id, {
      expected_revision: docB.revision,
      content_mode: "original",
    });
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(
      { search: "标签", limit: 50 },
      expect.any(AbortSignal),
    );
    expect(store.getState().knowledgeCursors).toEqual([null]);
    expect(store.getState().knowledgeTotal).toBe(3);
  });

  it("详情按 ID 独立打开，不依赖该文档是否在当前页", async () => {
    setupLibrary({
      listKnowledgeDocuments: vi.fn().mockResolvedValue(page([docC])),
    });
    await act(async () => render(<KnowledgeLibrary />));
    expect(screen.queryByText(docA.name)).toBeNull();
    await act(async () => {
      expect(await store.getState().openKnowledgeEditor({ kind: "document", id: docA.id })).toBe(
        true,
      );
    });
    expect(store.getState().knowledgeEditor).toMatchObject({
      kind: "document",
      source: { id: docA.id },
    });
  });

  it("有未保存草稿时改过滤不丢原稿也不发列表请求", async () => {
    const list = vi.fn().mockResolvedValue(page([docA]));
    setupLibrary({ listKnowledgeDocuments: list });
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => {
      await store.getState().openKnowledgeEditor({ kind: "document", id: docA.id });
    });
    const editor = store.getState().knowledgeEditor;
    if (editor?.kind !== "document") throw new Error("Missing document editor");
    await act(async () =>
      store.getState().updateKnowledgeEditor({ ...editor, name: "未保存的改名" }),
    );
    const calls = list.mock.calls.length;

    await act(async () => {
      expect(await store.getState().loadKnowledge({ search: "x" })).toBe(false);
    });
    expect(store.getState().knowledgeFilters.search).toBe("");
    expect(store.getState().knowledgeEditor).toMatchObject({ name: "未保存的改名" });
    expect(store.getState().knowledgeDirty).toBe(true);
    expect(list.mock.calls.length).toBe(calls);
  });

  it("跨页两个入口是 outline 默认尺寸可换行，局部重命名/删除保持 ghost", async () => {
    setupLibrary();
    await act(async () => render(<KnowledgeLibrary />));
    const tools = screen.getByRole("button", {
      name: label("capabilities.resources.openKnowledgeTools"),
    });
    expect(tools.getAttribute("data-variant")).toBe("outline");
    expect(tools.getAttribute("data-size")).toBe("default");
    expect(tools.className).toContain("min-h-8");
    expect(tools.querySelector("svg")).not.toBeNull();
    const organisation = screen.getByRole("button", {
      name: label("library.organization.workspace.budget"),
    });
    expect(organisation.getAttribute("data-variant")).toBe("outline");
    expect(organisation.getAttribute("data-size")).toBe("default");
    expect(organisation.className).toContain("min-h-8");

    await act(async () => {
      fireEvent.change(screen.getByLabelText(label("library.filter.categories")), {
        target: { value: "default" },
      });
    });
    expect(
      screen
        .getByRole("button", { name: label("library.rename.category") })
        .getAttribute("data-variant"),
    ).toBe("ghost");
    expect(
      screen
        .getByRole("button", { name: label("library.delete.category") })
        .getAttribute("data-variant"),
    ).toBe("ghost");
  });
});

describe("knowledge editor hidden resume CAS", () => {
  function concurrent() {
    let remote: KnowledgeDocumentDetail = { ...base, revision: 1 };
    const updateKnowledgeDocument = vi.fn(
      async (
        _id: string,
        body: { expected_revision: number; original_text?: string; name?: string },
      ) => {
        if (body.expected_revision !== remote.revision)
          throw new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict");
        remote = { ...remote, ...body, revision: remote.revision + 1 };
        return remote;
      },
    );
    const saveKnowledgeGrants = vi.fn(
      async (_id: string, revision: number, ids: string[], visibility?: "private" | "public") => {
        if (revision !== remote.revision)
          throw new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict");
        remote = {
          ...remote,
          revision: remote.revision + 1,
          agent_ids: ids,
          ...(visibility ? { visibility } : {}),
        };
        return remote;
      },
    );
    const client = setupLibrary({
      getKnowledgeDocument: vi.fn(async () => remote),
      updateKnowledgeDocument,
      saveKnowledgeGrants,
    });
    return { client, remote: () => remote };
  }
  it.each(["document", "grants"] as const)(
    "keeps %s edit revision on same-field remote changes and submits a real failing old CAS",
    async (kind) => {
      const f = concurrent();
      await store.getState().openKnowledgeEditor({ kind, id: D });
      const editor = store.getState().knowledgeEditor!;
      if (editor.kind === "document")
        store.getState().updateKnowledgeEditor({ ...editor, original_text: "A local text" });
      else if (editor.kind === "grants")
        store.getState().updateKnowledgeEditor({ ...editor, agent_ids: [A, docB.id] });
      store.getState().cancelKnowledgeLibraryRead();
      if (kind === "document")
        await f.client.updateKnowledgeDocument(D, {
          expected_revision: 1,
          original_text: "B remote text",
        });
      else await f.client.saveKnowledgeGrants(D, 1, [A, docC.id]);
      const dirty = store.getState().knowledgeEditor;
      await store.getState().resumeKnowledgeLibraryRead();
      expect(store.getState().knowledgeEditor).toBe(dirty);
      expect(store.getState().knowledgeEditor).toMatchObject({ source: { revision: 1 } });
      expect(store.getState().knowledgeLibraryError).toBeTruthy();
      expect(store.getState().knowledgeDirty).toBe(true);
      expect(await store.getState().saveKnowledgeEditor()).toBe(false);
      expect(store.getState().knowledgeEditor).toBe(dirty);
      expect(store.getState().knowledgeDirty).toBe(true);
      expect(f.remote()).toMatchObject(
        kind === "document"
          ? { revision: 2, original_text: "B remote text" }
          : { revision: 2, agent_ids: [A, docC.id] },
      );
      expect(
        kind === "document" ? f.client.updateKnowledgeDocument : f.client.saveKnowledgeGrants,
      ).toHaveBeenCalledTimes(2);
      store.getState().requestKnowledgeEditor({ kind, id: D });
      store.getState().cancelPendingNavigation();
      expect(store.getState().knowledgeEditor).toBe(dirty);
      store.getState().requestKnowledgeEditor({ kind, id: D });
      await store.getState().confirmDiscardAndContinue();
      expect(store.getState().knowledgeEditor).toMatchObject({ source: { revision: 2 } });
      expect(store.getState().knowledgeDirty).toBe(false);
    },
  );
  it("adopts untouched remote grants when only visibility is locally edited, and preserves remote visibility when only grants are edited", async () => {
    const f = concurrent();
    await store.getState().openKnowledgeEditor({ kind: "grants", id: D });
    let editor = store.getState().knowledgeEditor;
    if (editor?.kind !== "grants") throw new Error("grants missing");
    store.getState().updateKnowledgeEditor({ ...editor, visibility: "public" });
    store.getState().cancelKnowledgeLibraryRead();
    await f.client.saveKnowledgeGrants(D, 1, [docC.id]);
    await store.getState().resumeKnowledgeLibraryRead();
    expect(store.getState().knowledgeEditor).toMatchObject({
      source: { revision: 2 },
      agent_ids: [docC.id],
      visibility: "public",
    });
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(f.client.saveKnowledgeGrants).toHaveBeenLastCalledWith(D, 2, [docC.id], "public");
    await store.getState().openKnowledgeEditor({ kind: "grants", id: D });
    editor = store.getState().knowledgeEditor;
    if (editor?.kind !== "grants") throw new Error("grants missing");
    store.getState().updateKnowledgeEditor({ ...editor, agent_ids: [A] });
    store.getState().cancelKnowledgeLibraryRead();
    await f.client.saveKnowledgeGrants(D, 3, [docC.id], "private");
    await store.getState().resumeKnowledgeLibraryRead();
    expect(store.getState().knowledgeEditor).toMatchObject({
      source: { revision: 4 },
      agent_ids: [A],
      visibility: "private",
    });
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(f.client.saveKnowledgeGrants).toHaveBeenLastCalledWith(D, 4, [A], "private");
  });
  it("merges an untouched remote document name while preserving local original text", async () => {
    const f = concurrent();
    await store.getState().openKnowledgeEditor({ kind: "document", id: D });
    const editor = store.getState().knowledgeEditor;
    if (editor?.kind !== "document") throw new Error("document missing");
    store.getState().updateKnowledgeEditor({ ...editor, original_text: "local original" });
    store.getState().cancelKnowledgeLibraryRead();
    await f.client.updateKnowledgeDocument(D, { expected_revision: 1, name: "remote name" });
    await store.getState().resumeKnowledgeLibraryRead();
    expect(store.getState().knowledgeEditor).toMatchObject({
      name: "remote name",
      original_text: "local original",
      source: { revision: 2 },
    });
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(f.remote()).toMatchObject({
      name: "remote name",
      original_text: "local original",
      revision: 3,
    });
  });
});

it("offers in-sheet explicit refresh, cancels without losing the draft, and accepts latest values only after discard", async () => {
  let remote = { ...base, revision: 1 };
  const client = setupLibrary({ getKnowledgeDocument: vi.fn(async () => remote) });
  await act(async () => render(<KnowledgeLibrary />));
  await act(async () => store.getState().openKnowledgeEditor({ kind: "document", id: D }));
  const editor = store.getState().knowledgeEditor;
  if (editor?.kind !== "document") throw new Error("editor missing");
  act(() => store.getState().updateKnowledgeEditor({ ...editor, original_text: "local draft" }));
  remote = { ...remote, revision: 2, original_text: "remote text" };
  const dialog = screen.getByRole("dialog");
  const refresh = Array.from(dialog.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label("library.refresh"),
  );
  if (!refresh) throw new Error("editor refresh missing");
  fireEvent.click(refresh);
  expect(store.getState().pendingNavigation).toEqual({
    kind: "knowledge",
    target: { kind: "document", id: D },
  });
  act(() => store.getState().cancelPendingNavigation());
  expect(store.getState().knowledgeEditor).toMatchObject({
    original_text: "local draft",
    source: { revision: 1 },
  });
  fireEvent.click(refresh);
  await act(async () => store.getState().confirmDiscardAndContinue());
  expect(store.getState().knowledgeEditor).toMatchObject({
    original_text: "remote text",
    source: { revision: 2 },
  });
  expect(client.updateKnowledgeDocument).not.toHaveBeenCalled();
});

it("ignores a cancelled or old-API dirty resume without writes or draft loss", async () => {
  let finish!: (value: KnowledgeDocumentDetail) => void;
  const getKnowledgeDocument = vi
    .fn<SuperstringApi["getKnowledgeDocument"]>()
    .mockResolvedValueOnce(base)
    .mockImplementationOnce(
      () =>
        new Promise<KnowledgeDocumentDetail>((resolve) => {
          finish = resolve;
        }),
    );
  const client = setupLibrary({ getKnowledgeDocument });
  await store.getState().openKnowledgeEditor({ kind: "document", id: D });
  const editor = store.getState().knowledgeEditor;
  if (editor?.kind !== "document") throw new Error("editor missing");
  store.getState().updateKnowledgeEditor({ ...editor, original_text: "private local draft" });
  store.getState().cancelKnowledgeLibraryRead();
  const resume = store.getState().resumeKnowledgeLibraryRead();
  await act(async () => {});
  const signal = getKnowledgeDocument.mock.calls[1]![1] as AbortSignal;
  store.getState().cancelKnowledgeLibraryRead();
  expect(signal.aborted).toBe(true);
  const draft = store.getState().knowledgeEditor;
  const replacement = {
    ...client,
    getKnowledgeDocument: vi.fn().mockResolvedValue({ ...base, revision: 9 }),
  };
  store.setState({ apiClient: replacement, knowledgeLibraryError: "new owner notice" });
  finish({ ...base, revision: 2, original_text: "old API remote" });
  await resume;
  expect(store.getState().knowledgeEditor).toBe(draft);
  expect(store.getState().knowledgeLibraryError).toBe("new owner notice");
  expect(client.updateKnowledgeDocument).not.toHaveBeenCalled();
  expect(replacement.updateKnowledgeDocument).not.toHaveBeenCalled();
});
