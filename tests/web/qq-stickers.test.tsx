import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StickerLibrary } from "../../src/web/screens/library/StickerLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { selectLocale } from "../../src/web/i18n";
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
        description: null,
        revision: 2,
        asset_count: 1,
      });
    setupLibrary({ createQqStickerCollection: create, updateQqStickerCollection: rename });
    await page();
    fireEvent.click(screen.getByRole("button", { name: "管理集合" }));
    fireEvent.change(screen.getByLabelText("集合名称"), { target: { value: "New collection" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "新建" })));
    expect(create).toHaveBeenCalledWith({ name: "New collection" });
    fireEvent.click(screen.getAllByRole("button", { name: "重命名" })[0]!);
    fireEvent.change(screen.getByLabelText("重命名集合"), { target: { value: "Renamed" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
    expect(rename).toHaveBeenCalledWith(D, { name: "Renamed", expected_revision: 1 });
  });
  it("English controls preserve user asset names", async () => {
    selectLocale("en");
    await page();
    expect(screen.getByRole("button", { name: "Open Smile" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[\u3400-\u9fff]/);
  });
});
