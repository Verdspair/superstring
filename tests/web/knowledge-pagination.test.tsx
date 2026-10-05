// 资料列表的服务端分页专测：过滤进 store、键集翻页、迟到/被顶替响应不写回、
// 失败保列表可重试、翻页后批量快照只含显式勾选，以及两个跨页入口的 outline/default 层级。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentsPage } from "../../src/shared/contracts/knowledge";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, document as base, D, setupLibrary } from "./helpers/library-fixture";

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
    expect(store.getState().error).toContain("服务端不可达");
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
