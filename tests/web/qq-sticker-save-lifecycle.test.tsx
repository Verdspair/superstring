import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QqStickerAssetResponse } from "../../src/shared/contracts/qq";
import { ApiError } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";
import { D, S, setupLibrary, sticker } from "./helpers/library-fixture";

const S2 = "66666666-6666-4666-8666-666666666666";
const sticker2: QqStickerAssetResponse = {
  ...sticker,
  id: S2,
  name: "Laugh",
  description: "A loud laugh",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QQ sticker save lifecycle and identity guards", () => {
  it("closing the editor while save is in-flight must not resurrect the closed editor", async () => {
    let resolveUpdate!: (val: unknown) => void;
    const delayedUpdate = new Promise((resolve) => {
      resolveUpdate = resolve;
    });

    setupLibrary({
      updateQqStickerAsset: vi.fn().mockImplementation(() => delayedUpdate),
      setQqStickerCollections: vi.fn().mockImplementation(async (_id: string, _body: unknown) => ({
        ...sticker,
        name: "Renamed Smile",
      })),
      getQqStickerImpact: vi
        .fn()
        .mockResolvedValue({ asset_id: S, collection_ids: [D], schemes: [], bindings: [] }),
    });
    store.setState({
      qqStickerAssets: [sticker, sticker2],
    });

    store.getState().openQqStickerEditor(S);
    expect(store.getState().qqStickerEditor?.source.id).toBe(S);

    store.getState().patchQqStickerEditor({ name: "Renamed Smile" });
    let savePromise: Promise<boolean>;
    act(() => {
      savePromise = store.getState().saveQqStickerEditor();
    });

    expect(store.getState().qqStickerSaving).toBe(true);

    store.getState().closeQqStickerEditor();
    expect(store.getState().qqStickerEditor).toBeNull();

    await act(async () => {
      resolveUpdate({ ...sticker, name: "Renamed Smile" });
      await savePromise;
    });

    const updatedInList = store.getState().qqStickerAssets.find((a) => a.id === S);
    expect(updatedInList?.name).toBe("Renamed Smile");
    expect(store.getState().qqStickerEditor).toBeNull();
    expect(store.getState().qqStickerSaving).toBe(false);
  });

  it("switching from A to B while save of A is in-flight must not overwrite editor B", async () => {
    let resolveUpdate!: (val: unknown) => void;
    const delayedUpdate = new Promise((resolve) => {
      resolveUpdate = resolve;
    });

    setupLibrary({
      updateQqStickerAsset: vi.fn().mockImplementation(() => delayedUpdate),
      setQqStickerCollections: vi.fn().mockImplementation(async (_id: string, _body: unknown) => ({
        ...sticker,
        name: "Updated A",
      })),
      getQqStickerImpact: vi
        .fn()
        .mockResolvedValue({ asset_id: S, collection_ids: [D], schemes: [], bindings: [] }),
    });
    store.setState({
      qqStickerAssets: [sticker, sticker2],
    });

    store.getState().openQqStickerEditor(S);
    expect(store.getState().qqStickerEditor?.source.id).toBe(S);

    store.getState().patchQqStickerEditor({ name: "Updated A" });
    let savePromise: Promise<boolean>;
    act(() => {
      savePromise = store.getState().saveQqStickerEditor();
    });

    store.getState().openQqStickerEditor(S2);
    expect(store.getState().qqStickerEditor?.source.id).toBe(S2);

    await act(async () => {
      resolveUpdate({ ...sticker, name: "Updated A" });
      await savePromise;
    });

    expect(store.getState().qqStickerEditor?.source.id).toBe(S2);
    expect(store.getState().qqStickerSaving).toBe(false);
  });

  it("reopening the same asset creates a distinct session that late responses do not overwrite", async () => {
    let resolveUpdate!: (val: unknown) => void;
    const delayedUpdate = new Promise((resolve) => {
      resolveUpdate = resolve;
    });

    setupLibrary({
      updateQqStickerAsset: vi.fn().mockImplementation(() => delayedUpdate),
      setQqStickerCollections: vi.fn().mockImplementation(async (_id: string, _body: unknown) => ({
        ...sticker,
        name: "First Edit",
      })),
      getQqStickerImpact: vi
        .fn()
        .mockResolvedValue({ asset_id: S, collection_ids: [D], schemes: [], bindings: [] }),
    });
    store.setState({
      qqStickerAssets: [sticker, sticker2],
    });

    store.getState().openQqStickerEditor(S);
    store.getState().patchQqStickerEditor({ name: "First Edit" });
    let firstSavePromise: Promise<boolean>;
    act(() => {
      firstSavePromise = store.getState().saveQqStickerEditor();
    });

    // Reopening the same asset establishes a fresh editor reference
    store.getState().openQqStickerEditor(S);
    store.getState().patchQqStickerEditor({ name: "Second Session Newer Draft" });
    expect(store.getState().qqStickerEditor?.name).toBe("Second Session Newer Draft");

    await act(async () => {
      resolveUpdate({ ...sticker, name: "First Edit" });
      await firstSavePromise;
    });

    // Directory row received the update, but the new editor session retains its active draft
    const updatedInList = store.getState().qqStickerAssets.find((a) => a.id === S);
    expect(updatedInList?.name).toBe("First Edit");
    expect(store.getState().qqStickerEditor?.name).toBe("Second Session Newer Draft");
    expect(store.getState().qqStickerSaving).toBe(false);
  });

  it("pending impact query does not hold save resolution or saving lock", async () => {
    const neverEndingImpact = new Promise<never>(() => {});

    setupLibrary({
      updateQqStickerAsset: vi.fn().mockResolvedValue({ ...sticker, name: "Saved Fast" }),
      setQqStickerCollections: vi.fn().mockResolvedValue({ ...sticker, name: "Saved Fast" }),
      getQqStickerImpact: vi.fn().mockImplementation(() => neverEndingImpact),
    });
    store.setState({
      qqStickerAssets: [sticker, sticker2],
    });

    store.getState().openQqStickerEditor(S);
    store.getState().patchQqStickerEditor({ name: "Saved Fast" });

    // Save must settle even while impact read is completely hanging/pending
    const ok = await store.getState().saveQqStickerEditor();
    expect(ok).toBe(true);

    // Saving flag is released without waiting for informational impact query
    expect(store.getState().qqStickerSaving).toBe(false);
    expect(store.getState().feedback).toBe("已保存素材整理");
  });

  it("normal save applies updated content, reports feedback and releases saving state", async () => {
    setupLibrary({
      updateQqStickerAsset: vi.fn().mockResolvedValue({ ...sticker, name: "Finished Save" }),
      setQqStickerCollections: vi.fn().mockImplementation(async (_id: string, _body: unknown) => ({
        ...sticker,
        name: "Finished Save",
      })),
      getQqStickerImpact: vi
        .fn()
        .mockResolvedValue({ asset_id: S, collection_ids: [D], schemes: [], bindings: [] }),
    });
    store.setState({
      qqStickerAssets: [sticker, sticker2],
    });

    store.getState().openQqStickerEditor(S);
    store.getState().patchQqStickerEditor({ name: "Finished Save" });

    const ok = await store.getState().saveQqStickerEditor();
    expect(ok).toBe(true);

    expect(store.getState().qqStickerSaving).toBe(false);
    expect(store.getState().feedback).toBe("已保存素材整理");
    expect(store.getState().qqStickerEditor?.name).toBe("Finished Save");
    expect(store.getState().qqStickerAssets.find((a) => a.id === S)?.name).toBe("Finished Save");
  });

  it("http failure preserves the active draft and releases saving state", async () => {
    setupLibrary({
      updateQqStickerAsset: vi
        .fn()
        .mockRejectedValue(new ApiError(500, "INTERNAL_ERROR", "服务端保存失败")),
    });
    store.setState({
      qqStickerAssets: [sticker, sticker2],
    });

    store.getState().openQqStickerEditor(S);
    store.getState().patchQqStickerEditor({ name: "Draft Before Failure" });

    const ok = await store.getState().saveQqStickerEditor();
    expect(ok).toBe(false);

    expect(store.getState().qqStickerSaving).toBe(false);
    expect(store.getState().error).toBe("服务端保存失败");
    expect(store.getState().qqStickerEditor?.name).toBe("Draft Before Failure");
  });
});
