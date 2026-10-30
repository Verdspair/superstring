import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QqStickerAssetResponse } from "../../src/shared/contracts/qq";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { qqDraftChanges } from "../../src/web/features/qq/draft-state";
import { qqStickerEditorDirty } from "../../src/web/features/qq/types";
import { StickerLibrary } from "../../src/web/screens/library/StickerLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { D, S, setupLibrary, sticker } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

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

describe("mounted sticker save partial success", () => {
  it("keeps the newest saved collection impact when the opening read finishes last", async () => {
    type Impact = Awaited<ReturnType<SuperstringApi["getQqStickerImpact"]>>;
    const opening = Promise.withResolvers<Impact>();
    const refreshed = Promise.withResolvers<Impact>();
    const oldImpact: Impact = {
      asset_id: S,
      collection_ids: [D],
      schemes: [{ id: D, name: "Old collection scheme", collection_ids: [D] }],
      bindings: [
        {
          scheme_id: D,
          account_id: "10001",
          conversation_kind: "group",
          peer_id: "20002",
          paused: false,
        },
      ],
    };
    const latestImpact: Impact = { asset_id: S, collection_ids: [], schemes: [], bindings: [] };
    const impact = vi
      .fn<SuperstringApi["getQqStickerImpact"]>()
      .mockReturnValueOnce(opening.promise)
      .mockReturnValueOnce(refreshed.promise);
    const collections = vi.fn<SuperstringApi["setQqStickerCollections"]>().mockResolvedValue({
      ...sticker,
      collection_ids: [],
    });
    const client = setupLibrary({
      getQqStickerImpact: impact,
      setQqStickerCollections: collections,
    });
    await act(async () => render(<StickerLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开 Smile" })));
    expect(impact).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "Reactions" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存说明" })));
    await waitFor(() => expect(impact).toHaveBeenCalledTimes(2));
    expect(collections).toHaveBeenCalledWith(S, { collection_ids: [] });
    expect(collections).toHaveBeenCalledTimes(1);
    expect(client.updateQqStickerAsset).not.toHaveBeenCalled();
    expect(client.setQqStickerEnabled).not.toHaveBeenCalled();
    expect(store.getState().qqStickerSaving).toBe(false);
    expect(store.getState().qqStickerEditor?.source.collection_ids).toEqual([]);
    expect(
      store.getState().qqStickerAssets.find((asset) => asset.id === S)?.collection_ids,
    ).toEqual([]);
    await act(async () => refreshed.resolve(latestImpact));
    expect(store.getState().qqStickerImpact).toEqual(latestImpact);
    expect(screen.queryByText("Old collection scheme", { exact: false })).toBeNull();
    await act(async () => opening.resolve(oldImpact));
    expect(store.getState().qqStickerImpact).toEqual(latestImpact);
    expect(screen.queryByText("Old collection scheme", { exact: false })).toBeNull();
    expect(screen.queryByText("10001 / group / 20002", { exact: false })).toBeNull();
    expect(impact).toHaveBeenCalledTimes(2);
    expect(store.getState().qqStickerSaving).toBe(false);
  });

  it("keeps a refreshed impact and the current error when the opening read later rejects", async () => {
    type Impact = Awaited<ReturnType<SuperstringApi["getQqStickerImpact"]>>;
    const opening = Promise.withResolvers<Impact>();
    const refreshed = Promise.withResolvers<Impact>();
    const impact = vi
      .fn<SuperstringApi["getQqStickerImpact"]>()
      .mockReturnValueOnce(opening.promise)
      .mockReturnValueOnce(refreshed.promise);
    const collections = vi.fn<SuperstringApi["setQqStickerCollections"]>().mockResolvedValue({
      ...sticker,
      collection_ids: [],
    });
    const client = setupLibrary({
      getQqStickerImpact: impact,
      setQqStickerCollections: collections,
    });
    await act(async () => render(<StickerLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开 Smile" })));
    fireEvent.click(screen.getByRole("checkbox", { name: "Reactions" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存说明" })));
    await waitFor(() => expect(impact).toHaveBeenCalledTimes(2));
    const latest: Impact = { asset_id: S, collection_ids: [], schemes: [], bindings: [] };
    await act(async () => refreshed.resolve(latest));
    act(() => store.setState({ error: "Current operation failed" }));
    await act(async () => opening.reject(new ApiError(500, "INTERNAL_ERROR", "Old impact failed")));
    expect(store.getState().qqStickerImpact).toEqual(latest);
    expect(screen.getByRole("alert").textContent).toContain("Current operation failed");
    expect(store.getState().error).toBe("Current operation failed");
    expect(store.getState().qqStickerSaving).toBe(false);
    expect(collections).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledTimes(2);
    expect(client.updateQqStickerAsset).not.toHaveBeenCalled();
    expect(client.setQqStickerEnabled).not.toHaveBeenCalled();
  });

  it.each(["editor", "api", "route"] as const)(
    "does not report a late save failure to a replaced %s owner",
    async (replacement) => {
      const pending = Promise.withResolvers<QqStickerAssetResponse>();
      const update = vi.fn<SuperstringApi["updateQqStickerAsset"]>(() => pending.promise);
      const collections = vi.fn<SuperstringApi["setQqStickerCollections"]>();
      const client = setupLibrary({
        updateQqStickerAsset: update,
        setQqStickerCollections: collections,
      });
      store.setState({ qqStickerAssets: [sticker, sticker2] });
      store.getState().openQqStickerEditor(S);
      store.getState().patchQqStickerEditor({ description: "Old draft", collectionIds: [] });
      const saving = store.getState().saveQqStickerEditor();
      if (replacement === "editor") store.getState().openQqStickerEditor(S2);
      else if (replacement === "api")
        store.setState({ apiClient: { ...client }, qqStickerSaving: false });
      else store.setState({ settingsRoute: "long-memory" });
      store.setState({ error: "Current owner notice", feedback: "Current owner feedback" });
      pending.reject(new ApiError(500, "INTERNAL_ERROR", "Old save failed"));
      expect(await saving).toBe(false);
      expect(store.getState().error).toBe("Current owner notice");
      expect(store.getState().feedback).toBe("Current owner feedback");
      expect(store.getState().qqStickerEditor?.source.id).toBe(replacement === "editor" ? S2 : S);
      expect(collections).not.toHaveBeenCalled();
      expect(store.getState().qqStickerSaving).toBe(false);
    },
  );

  it("accepts a durable row but starts no later write after the mounted page unmounts", async () => {
    const pending = Promise.withResolvers<QqStickerAssetResponse>();
    const update = vi.fn<SuperstringApi["updateQqStickerAsset"]>(() => pending.promise);
    const collections = vi.fn<SuperstringApi["setQqStickerCollections"]>();
    setupLibrary({ updateQqStickerAsset: update, setQqStickerCollections: collections });
    await act(async () => render(<StickerLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开 Smile" })));
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "Durable content" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Reactions" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存说明" })));
    expect(update).toHaveBeenCalledTimes(1);
    cleanup();
    const saved = { ...sticker, description: "Durable content" };
    await act(async () => pending.resolve(saved));
    await waitFor(() => expect(store.getState().qqStickerSaving).toBe(false));
    expect(store.getState().qqStickerAssets.find((row) => row.id === S)).toEqual(saved);
    expect(store.getState().qqStickerEditor?.source).toEqual(saved);
    expect(collections).not.toHaveBeenCalled();
    expect(store.getState().feedback).not.toBe("已保存素材整理");
    expect(store.getState().qqStickerEditor?.collectionIds).toEqual([]);
  });

  it("does not continue closing when new edits arrive during save-and-continue", async () => {
    const pending = Promise.withResolvers<QqStickerAssetResponse>();
    setupLibrary({ updateQqStickerAsset: vi.fn(() => pending.promise) });
    await act(async () => render(<StickerLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开 Smile" })));
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "Submitted description" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存并继续" })));
    act(() => store.getState().patchQqStickerEditor({ description: "Later draft" }));
    await act(async () => pending.resolve({ ...sticker, description: "Submitted description" }));
    await waitFor(() => expect(store.getState().qqStickerSaving).toBe(false));
    expect(store.getState().qqStickerEditor?.description).toBe("Later draft");
    expect(store.getState().qqStickerEditor?.source.description).toBe("Submitted description");
    expect(qqStickerEditorDirty(store.getState().qqStickerEditor)).toBe(true);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("does not start a later write or publish an old API response after replacement", async () => {
    const pending = Promise.withResolvers<QqStickerAssetResponse>();
    const update = vi.fn<SuperstringApi["updateQqStickerAsset"]>(() => pending.promise);
    const collections = vi.fn<SuperstringApi["setQqStickerCollections"]>();
    const client = setupLibrary({
      updateQqStickerAsset: update,
      setQqStickerCollections: collections,
    });
    store.setState({ qqStickerAssets: [sticker] });
    store.getState().openQqStickerEditor(S);
    store.getState().patchQqStickerEditor({ description: "Old draft", collectionIds: [] });
    const saving = store.getState().saveQqStickerEditor();
    const currentAsset = { ...sticker, description: "Current API content" };
    store.setState({
      apiClient: { ...client },
      qqStickerAssets: [currentAsset],
      qqStickerSaving: true,
    });
    store.getState().openQqStickerEditor(S);
    pending.resolve({ ...sticker, description: "Old draft" });
    expect(await saving).toBe(false);
    expect(collections).not.toHaveBeenCalled();
    expect(store.getState().qqStickerAssets).toEqual([currentAsset]);
    expect(store.getState().qqStickerEditor?.source).toEqual(currentAsset);
    expect(store.getState().qqStickerSaving).toBe(true);
  });

  it.each(["collections", "enabled"] as const)(
    "keeps durable steps when %s fails and retries only the unfinished step",
    async (failedStep) => {
      let persisted = { ...sticker };
      const failed = Promise.withResolvers<void>();
      let failOnce = true;
      const failure = new ApiError(500, "INTERNAL_ERROR", `保存${failedStep}失败`);
      const update = vi.fn<SuperstringApi["updateQqStickerAsset"]>(async (_id, body) => {
        persisted = { ...persisted, ...body };
        return { ...persisted };
      });
      const collections = vi.fn<SuperstringApi["setQqStickerCollections"]>(async (_id, body) => {
        if (failedStep === "collections" && failOnce) {
          failOnce = false;
          await failed.promise;
        }
        persisted = { ...persisted, collection_ids: [...body.collection_ids] };
        return { ...persisted };
      });
      const enabled = vi.fn<SuperstringApi["setQqStickerEnabled"]>(async (_id, value) => {
        if (failedStep === "enabled" && failOnce) {
          failOnce = false;
          await failed.promise;
        }
        persisted = { ...persisted, enabled: value };
        return { ...persisted };
      });
      const bulk = vi.fn<SuperstringApi["bulkUpdateQqStickers"]>();
      setupLibrary({
        listQqStickerAssets: vi.fn().mockImplementation(async () => [persisted, sticker2]),
        updateQqStickerAsset: update,
        setQqStickerCollections: collections,
        setQqStickerEnabled: enabled,
        bulkUpdateQqStickers: bulk,
      });
      await act(async () => render(<StickerLibrary />));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开 Smile" })));
      fireEvent.change(screen.getByLabelText("说明"), {
        target: { value: "Saved description" },
      });
      fireEvent.click(screen.getByRole("checkbox", { name: "Reactions" }));
      act(() => store.getState().setQqStickerSelection([S2]));
      const saveLabel = failedStep === "enabled" ? "保存并启用" : "保存说明";
      await act(async () => fireEvent.click(screen.getByRole("button", { name: saveLabel })));
      await waitFor(() =>
        expect(failedStep === "enabled" ? enabled : collections).toHaveBeenCalledTimes(1),
      );
      expect(persisted.description).toBe("Saved description");
      expect(persisted.enabled).toBe(false);
      expect(store.getState().qqStickerSaving).toBe(true);
      expect((screen.getByRole("button", { name: saveLabel }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      await act(async () => failed.reject(failure));
      await waitFor(() => expect(store.getState().qqStickerSaving).toBe(false));

      expect(store.getState().qqStickerAssets.find((asset) => asset.id === S)).toEqual(persisted);
      expect(store.getState().qqStickerEditor?.source).toEqual(persisted);
      expect((screen.getByLabelText("说明") as HTMLTextAreaElement).value).toBe(
        "Saved description",
      );
      expect(store.getState().qqStickerEditor?.collectionIds).toEqual([]);
      expect(store.getState().qqStickerEditor?.source.collection_ids).toEqual(
        failedStep === "collections" ? [D] : [],
      );
      expect(qqStickerEditorDirty(store.getState().qqStickerEditor)).toBe(
        failedStep === "collections",
      );
      expect(screen.getByText(failure.message)).toBeTruthy();
      const changes = qqDraftChanges(store.getState()).find((row) => row.id === `sticker:${S}`);
      expect(changes?.changes.some((change) => change.startsWith("description:")) ?? false).toBe(
        false,
      );
      if (failedStep === "collections") {
        expect(changes?.changes.some((change) => change.startsWith("collectionIds:"))).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "关闭" }));
        expect(screen.getByRole("alertdialog")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "取消" }));
      } else {
        expect(changes).toBeUndefined();
      }

      await act(async () => fireEvent.click(screen.getByRole("button", { name: saveLabel })));
      await waitFor(() => expect(store.getState().qqStickerSaving).toBe(false));
      expect(update).toHaveBeenCalledTimes(1);
      expect(collections).toHaveBeenCalledTimes(failedStep === "collections" ? 2 : 1);
      expect(enabled).toHaveBeenCalledTimes(failedStep === "enabled" ? 2 : 0);
      expect(persisted.enabled).toBe(failedStep === "enabled");
      expect(store.getState().qqStickerEditor?.source).toEqual(persisted);
      expect(qqStickerEditorDirty(store.getState().qqStickerEditor)).toBe(false);
      expect(store.getState().qqStickerAssets.find((asset) => asset.id === S2)).toEqual(sticker2);
      expect(store.getState().qqStickerSelection).toEqual([S2]);
      expect(bulk).not.toHaveBeenCalled();
      expect(screen.queryByText(failure.message)).toBeNull();
    },
  );

  it("accepts each saved baseline without replacing edits made while the next step is pending", async () => {
    let persisted = { ...sticker };
    const collectionReady = Promise.withResolvers<void>();
    const update = vi.fn<SuperstringApi["updateQqStickerAsset"]>(async (_id, body) => {
      persisted = { ...persisted, ...body };
      return { ...persisted };
    });
    const collections = vi.fn<SuperstringApi["setQqStickerCollections"]>(async (_id, body) => {
      await collectionReady.promise;
      persisted = { ...persisted, collection_ids: [...body.collection_ids] };
      return { ...persisted };
    });
    const enabled = vi.fn<SuperstringApi["setQqStickerEnabled"]>();
    setupLibrary({
      listQqStickerAssets: vi.fn().mockImplementation(async () => [persisted]),
      updateQqStickerAsset: update,
      setQqStickerCollections: collections,
      setQqStickerEnabled: enabled,
    });
    await act(async () => render(<StickerLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开 Smile" })));
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "First description" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Reactions" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存说明" })));
    await waitFor(() => expect(collections).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "Later description" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Reactions" }));
    await act(async () => collectionReady.resolve());
    await waitFor(() => expect(store.getState().qqStickerSaving).toBe(false));

    expect(store.getState().qqStickerEditor?.source).toEqual(persisted);
    expect(store.getState().qqStickerEditor?.source.description).toBe("First description");
    expect(store.getState().qqStickerEditor?.source.collection_ids).toEqual([]);
    expect(store.getState().qqStickerEditor?.description).toBe("Later description");
    expect(store.getState().qqStickerEditor?.collectionIds).toEqual([D]);
    expect(qqStickerEditorDirty(store.getState().qqStickerEditor)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存说明" })));
    await waitFor(() => expect(store.getState().qqStickerSaving).toBe(false));
    expect(update).toHaveBeenLastCalledWith(
      S,
      expect.objectContaining({ description: "Later description" }),
    );
    expect(collections).toHaveBeenLastCalledWith(S, { collection_ids: [D] });
    expect(qqStickerEditorDirty(store.getState().qqStickerEditor)).toBe(false);
    expect(enabled).not.toHaveBeenCalled();
  });
});
