import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectLocale } from "../../src/web/i18n";
import { StickerLibrary } from "../../src/web/screens/library/StickerLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { D, S, setupLibrary, sticker } from "./helpers/library-fixture";

beforeEach(() => {
  setupLibrary();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function page() {
  await act(async () => render(<StickerLibrary />));
}
async function detail() {
  await page();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开 Smile" })));
}
describe("fresh asset library", () => {
  it("uses a static first frame in the index and full preview in the workbench", async () => {
    await page();
    expect(screen.getByAltText("Smile").getAttribute("src")).toContain("still=1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开 Smile" })));
    expect(
      within(screen.getByRole("dialog")).getByAltText("Smile").getAttribute("src"),
    ).not.toContain("still=1");
  });
  it("saving descriptions does not enable an asset", async () => {
    const client = setupLibrary();
    await detail();
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "Updated description" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存说明" })));
    expect(client.updateQqStickerAsset).toHaveBeenCalledWith(
      S,
      expect.objectContaining({ description: "Updated description" }),
    );
    expect(client.setQqStickerEnabled).not.toHaveBeenCalled();
  });
  it("save-and-enable is explicit and sets membership", async () => {
    const client = setupLibrary();
    await detail();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存并启用" })));
    expect(client.setQqStickerEnabled).toHaveBeenCalledWith(S, true);
    expect(client.setQqStickerCollections).toHaveBeenCalledWith(S, { collection_ids: [D] });
  });
  it("closing protects unsaved asset content and can save before continuing", async () => {
    await detail();
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByDisplayValue("Draft")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存并继续" })));
    expect(store.getState().qqStickerEditor).toBeNull();
  });
  it("imports bytes and reports the specific rejection", async () => {
    const client = setupLibrary({
      importQqStickerFile: vi
        .fn()
        .mockResolvedValue({ kind: "rejected", reason: "unsupported_format" }),
    });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "导入素材" }));
    const file = new File(["bad"], "bad.txt");
    await act(async () =>
      fireEvent.change(screen.getByLabelText("选择图片文件"), { target: { files: [file] } }),
    );
    expect(client.importQqStickerFile).toHaveBeenCalledWith(file);
    expect(store.getState().qqStickerImportNotice).toEqual({
      kind: "rejected",
      reason: "unsupported_format",
    });
    expect(store.getState().qqStickerAssets).toHaveLength(1);
  });
  it("new imports open disabled and preserve review before use", async () => {
    const client = setupLibrary({
      importQqStickerFile: vi
        .fn()
        .mockResolvedValue({ kind: "imported", asset: { ...sticker, id: "new", name: "New" } }),
    });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "导入素材" }));
    await act(async () =>
      fireEvent.change(screen.getByLabelText("选择图片文件"), {
        target: { files: [new File(["image"], "new.png", { type: "image/png" })] },
      }),
    );
    expect(store.getState().qqStickerEditor?.source.enabled).toBe(false);
    expect(client.setQqStickerEnabled).not.toHaveBeenCalled();
  });
  it("annotation is a reviewable draft, never silently saved", async () => {
    const client = setupLibrary({
      annotateQqSticker: vi.fn().mockResolvedValue({
        kind: "annotated",
        asset: { ...sticker, description_draft: "Suggested", tags_draft: ["cheerful"] },
      }),
    });
    await detail();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "生成说明和标签" })));
    expect((screen.getByLabelText("说明") as HTMLTextAreaElement).value).toBe(sticker.description);
    fireEvent.click(screen.getByRole("button", { name: "采用草稿" }));
    expect((screen.getByLabelText("说明") as HTMLTextAreaElement).value).toBe("Suggested");
    expect(client.updateQqStickerAsset).not.toHaveBeenCalled();
  });
  it("annotation refusal stays visible", async () => {
    setupLibrary({
      annotateQqSticker: vi.fn().mockResolvedValue({ kind: "rejected", reason: "model_error" }),
    });
    await detail();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "生成说明和标签" })));
    expect(screen.getByRole("status").textContent).toContain("模型调用失败");
  });
  it("batch changes include only selected assets and retain selection", async () => {
    const bulk = vi.fn().mockResolvedValue({ assets: [{ ...sticker, enabled: true }] });
    setupLibrary({ bulkUpdateQqStickers: bulk });
    await page();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Smile" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /批量编辑 · 1/ })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "启用所选" })));
    expect(bulk).toHaveBeenCalledWith({ asset_ids: [S], enabled: true });
    expect(store.getState().qqStickerSelection).toEqual([S]);
  });
  it("collection creation and rename keep server revisions", async () => {
    const create = vi.fn().mockResolvedValue({
        id: "new",
        name: "New collection",
        description: null,
        revision: 1,
        asset_count: 0,
      }),
      rename = vi.fn().mockResolvedValue({
        id: D,
        name: "Renamed",
        description: "Everyday reactions",
        revision: 2,
        asset_count: 1,
      });
    setupLibrary({
      listQqStickerCollections: vi.fn().mockResolvedValue([
        {
          id: D,
          name: "Reactions",
          description: "Everyday reactions",
          revision: 1,
          asset_count: 1,
        },
      ]),
      createQqStickerCollection: create,
      updateQqStickerCollection: rename,
    });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    expect(screen.getByText("Everyday reactions")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("集合名称"), { target: { value: "New collection" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "新建" })));
    expect(create).toHaveBeenCalledWith({ name: "New collection", description: null });
    fireEvent.click(screen.getAllByRole("button", { name: "重命名" })[0]);
    fireEvent.change(screen.getByLabelText("重命名集合"), { target: { value: "Renamed" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
    // 只改名字：未修改的简介按已存值原样发回，不会意外清空。
    expect(rename).toHaveBeenCalledWith(D, {
      name: "Renamed",
      description: "Everyday reactions",
      expected_revision: 1,
    });
  });
  it("creates a collection with its description", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "new",
      name: "New collection",
      description: "Short intro",
      revision: 1,
      asset_count: 0,
    });
    setupLibrary({ createQqStickerCollection: create });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    fireEvent.change(screen.getByLabelText("集合名称"), { target: { value: "New collection" } });
    fireEvent.change(screen.getByLabelText("简介"), { target: { value: "Short intro" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "新建" })));
    expect(create).toHaveBeenCalledWith({ name: "New collection", description: "Short intro" });
    // 成功后草稿清空，等下一次输入。
    expect((screen.getByLabelText("简介") as HTMLTextAreaElement).value).toBe("");
  });
  it("a description-only rename reuses the stored name and revision", async () => {
    const update = vi.fn().mockResolvedValue({
      id: D,
      name: "Reactions",
      description: "Fresh intro",
      revision: 2,
      asset_count: 1,
    });
    setupLibrary({
      listQqStickerCollections: vi.fn().mockResolvedValue([
        {
          id: D,
          name: "Reactions",
          description: "Everyday reactions",
          revision: 1,
          asset_count: 1,
        },
      ]),
      updateQqStickerCollection: update,
    });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getAllByLabelText("简介")[1], { target: { value: "Fresh intro" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
    // 名字没动：仍按原名字与原 revision 提交，CAS 比较的是读到的值。
    expect(update).toHaveBeenCalledWith(D, {
      name: "Reactions",
      description: "Fresh intro",
      expected_revision: 1,
    });
  });
  it("an emptied description clears to null", async () => {
    const update = vi.fn().mockResolvedValue({
      id: D,
      name: "Reactions",
      description: null,
      revision: 2,
      asset_count: 1,
    });
    setupLibrary({
      listQqStickerCollections: vi.fn().mockResolvedValue([
        {
          id: D,
          name: "Reactions",
          description: "Everyday reactions",
          revision: 1,
          asset_count: 1,
        },
      ]),
      updateQqStickerCollection: update,
    });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getAllByLabelText("简介")[1], { target: { value: "" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
    expect(update).toHaveBeenCalledWith(D, {
      name: "Reactions",
      description: null,
      expected_revision: 1,
    });
  });
  it("a description-only collection draft survives a remount and completes once named", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "new",
      name: "Draft collection",
      description: "Short intro",
      revision: 1,
      asset_count: 0,
    });
    setupLibrary({ createQqStickerCollection: create });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    // 只有说明、没有名称：说明已作为草稿进入 store，提交按钮仍因缺名禁用。
    fireEvent.change(screen.getByLabelText("简介"), { target: { value: "Short intro" } });
    expect(store.getState().qqInputs.stickerNewCollectionDescription).toBe("Short intro");
    expect((screen.getByRole("button", { name: "新建" }) as HTMLButtonElement).disabled).toBe(true);
    // 卸载重挂载：组件内不留输入，重开对话框后说明从 store 草稿恢复。
    cleanup();
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    expect((screen.getByLabelText("简介") as HTMLTextAreaElement).value).toBe("Short intro");
    expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe("");
    // 显式补上名称后才能提交；POST 带上说明，回读的假数据落进集合列表。
    fireEvent.change(screen.getByLabelText("集合名称"), { target: { value: "Draft collection" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "新建" })));
    expect(create).toHaveBeenCalledWith({ name: "Draft collection", description: "Short intro" });
    expect(screen.getByText("Short intro")).toBeTruthy();
    // 成功后名称与说明一起清空。
    expect((screen.getByLabelText("简介") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe("");
  });
  it("a description-only rename survives a remount and clears after saving", async () => {
    const update = vi.fn().mockResolvedValue({
      id: D,
      name: "Reactions",
      description: "Fresh intro",
      revision: 2,
      asset_count: 1,
    });
    const client = setupLibrary({
      listQqStickerCollections: vi.fn().mockResolvedValue([
        {
          id: D,
          name: "Reactions",
          description: "Everyday reactions",
          revision: 1,
          asset_count: 1,
        },
      ]),
      updateQqStickerCollection: update,
    });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    // 只动说明、名字不改：整份重命名草稿存在 store.qqInputs.stickerRenaming。
    fireEvent.change(screen.getAllByLabelText("简介")[1], { target: { value: "Fresh intro" } });
    expect(store.getState().qqInputs.stickerRenaming).toMatchObject({
      id: D,
      name: "Reactions",
      revision: 1,
      description: "Fresh intro",
    });
    // 卸载重挂载后重新打开集合对话框：说明经 store 草稿恢复，名字保持读取值。
    cleanup();
    await page();
    expect(store.getState().qqInputs.stickerRenaming?.description).toBe("Fresh intro");
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    expect((screen.getAllByLabelText("简介")[1] as HTMLTextAreaElement).value).toBe("Fresh intro");
    expect((screen.getByLabelText("重命名集合") as HTMLInputElement).value).toBe("Reactions");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
    // 提交只有说明变了：名字与 CAS 修订号沿用读取基线；不触碰素材本身或授权。
    expect(update).toHaveBeenCalledWith(D, {
      name: "Reactions",
      description: "Fresh intro",
      expected_revision: 1,
    });
    expect(client.updateQqStickerAsset).not.toHaveBeenCalled();
    expect(client.setQqStickerCollections).not.toHaveBeenCalled();
    expect(client.setQqStickerEnabled).not.toHaveBeenCalled();
    // 成功后重命名草稿整体清空，编辑器退出。
    expect(store.getState().qqInputs.stickerRenaming).toBeNull();
    expect(screen.queryByLabelText("重命名集合")).toBeNull();
  });
  it("a conflicted save keeps the draft and an explicit refresh does not rewrite it", async () => {
    const update = vi.fn().mockRejectedValue(new Error("集合已变化，请重新加载后保存"));
    setupLibrary({
      listQqStickerCollections: vi.fn().mockResolvedValue([
        {
          id: D,
          name: "Reactions",
          description: "Everyday reactions",
          revision: 1,
          asset_count: 1,
        },
      ]),
      updateQqStickerCollection: update,
    });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("重命名集合"), { target: { value: "Renamed draft" } });
    fireEvent.change(screen.getAllByLabelText("简介")[1], { target: { value: "Draft intro" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
    expect(screen.getByRole("alert").textContent).toContain("集合已变化");
    expect((screen.getByLabelText("重命名集合") as HTMLInputElement).value).toBe("Renamed draft");
    expect((screen.getAllByLabelText("简介")[1] as HTMLTextAreaElement).value).toBe("Draft intro");
    // 显式刷新（页面「刷新」重读集合并换新基线）后草稿保留：不自动改写、也不自动重试保存。
    await act(async () => {
      await store.getState().loadQqStickers();
    });
    expect((screen.getByLabelText("重命名集合") as HTMLInputElement).value).toBe("Renamed draft");
    expect((screen.getAllByLabelText("简介")[1] as HTMLTextAreaElement).value).toBe("Draft intro");
    expect(update).toHaveBeenCalledTimes(1);
  });
  it("collection management adds no delete affordance and touches no asset authorisation", async () => {
    const client = setupLibrary({
      createQqStickerCollection: vi.fn().mockResolvedValue({
        id: "new",
        name: "New collection",
        description: null,
        revision: 1,
        asset_count: 0,
      }),
    });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /删除/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("集合名称"), { target: { value: "New collection" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "新建" })));
    expect(within(dialog).queryByRole("button", { name: /删除/ })).toBeNull();
    // 集合的新建/重命名不触碰素材本身或素材的所属集合（授权）；U11 的删除禁令不变。
    expect(client.setQqStickerCollections).not.toHaveBeenCalled();
    expect(client.updateQqStickerAsset).not.toHaveBeenCalled();
  });
  it("the media and collection entries carry the management weight", async () => {
    setupLibrary();
    await page();
    const media = screen.getByRole("button", { name: "前往媒体与表情" });
    expect(media.getAttribute("data-variant")).toBe("outline");
    expect(media.getAttribute("data-size")).toBe("default");
    expect(media.className).toContain("min-h-8");
    expect(media.className).toContain("h-auto");
    expect(media.querySelector("svg")).toBeTruthy();
    const manage = screen.getByRole("button", { name: "管理集合" });
    expect(manage.getAttribute("data-variant")).toBe("outline");
    expect(manage.getAttribute("data-size")).toBe("default");
    expect(manage.querySelector("svg")).toBeTruthy();
  });
  it("English controls preserve user asset names", async () => {
    selectLocale("en");
    await page();
    expect(screen.getByRole("button", { name: "Open Smile" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[\u3400-\u9fff]/);
  });
});
