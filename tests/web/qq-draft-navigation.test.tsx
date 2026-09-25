import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QqSettingsResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { NavigationConfirm } from "../../src/web/app/NavigationConfirm";
import { qqDraftChanges, settingsHaveDrafts } from "../../src/web/features/qq/draft-state";
import { QqAppAccess } from "../../src/web/features/qq/QqAppAccess";
import { qqSchemeDirty, qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { useSuperstringStore as store } from "../../src/web/store";
import { qqSchemeFixture } from "./helpers/qq-fixture";

const settings: QqSettingsResponse = {
  enabled: true,
  account_id: "100",
  judgement_model_name: null,
  transport: { endpoint: "ws://localhost:3000", has_token: true },
  revision: 3,
};
const connection = (token = "") => ({
  source: settings,
  endpoint: "ws://localhost:4000",
  accountId: "100",
  token,
});
beforeEach(() => {
  store.getState().resetForTests({
    ...api,
    getQqSettings: async () => settings,
    getQqStatus: async () => ({ connection: null }) as never,
    listQqConversations: async () => [],
    listQqBindings: async () => [],
    listQqSchemes: async () => [qqSchemeFixture()],
    getQqSchemeUsage: async () => ({ scheme_id: qqSchemeFixture().id, bindings: 0 }),
  });
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
    qqSchemeEditor: qqSchemeEditorFrom(qqSchemeFixture()),
    qqSettings: settings,
  });
});
afterEach(cleanup);

it("raw invalid scheme input survives cancelled navigation and cannot save the old valid number", async () => {
  const update = vi.fn();
  store.setState({
    apiClient: { ...store.getState().apiClient, updateQqScheme: update },
    qqInputs: { ...store.getState().qqInputs, schemeTexts: { "rhythm.hourly_speech_limit": "-" } },
  });
  store.getState().openSettingsRoute("qq-stickers");
  expect(store.getState().navigationConfirmOpen).toBe(true);
  expect(store.getState().settingsRoute).toBe("qq-scheme-config");
  await store.getState().confirmSaveAndContinue();
  expect(update).not.toHaveBeenCalled();
  expect(store.getState().navigationConfirmOpen).toBe(true);
  store.getState().cancelPendingNavigation();
  expect(store.getState().qqInputs.schemeTexts["rhythm.hourly_speech_limit"]).toBe("-");
  store.getState().openSettingsRoute("qq-stickers");
  await store.getState().confirmDiscardAndContinue();
  expect(store.getState().settingsRoute).toBe("qq-stickers");
  expect(store.getState().qqInputs.schemeTexts).toEqual({});
});

it("connection draft survives remount and server refresh while retaining its original revision", async () => {
  store.setState({
    qqInputs: { ...store.getState().qqInputs, connection: connection("replacement-secret") },
  });
  const view = render(<QqAppAccess />);
  await act(async () => {});
  expect((screen.getByLabelText("WebSocket 地址") as HTMLInputElement).value).toBe(
    "ws://localhost:4000",
  );
  view.unmount();
  store.setState({
    apiClient: {
      ...store.getState().apiClient,
      getQqSettings: async () => ({
        ...settings,
        revision: 8,
        transport: { endpoint: "ws://elsewhere", has_token: true },
      }),
    },
  });
  render(<QqAppAccess />);
  await act(async () => {});
  expect((screen.getByLabelText("WebSocket 地址") as HTMLInputElement).value).toBe(
    "ws://localhost:4000",
  );
  expect(store.getState().qqInputs.connection?.source.revision).toBe(3);
  expect(settingsHaveDrafts(store.getState())).toBe(true);
});

it("navigation change preview never exposes the replacement token", () => {
  store.setState({
    qqInputs: { ...store.getState().qqInputs, connection: connection("replacement-secret") },
  });
  store.getState().openChat();
  render(<NavigationConfirm />);
  expect(screen.getByRole("alertdialog").textContent).not.toContain("replacement-secret");
  expect(screen.getByText("访问令牌将被替换（不显示内容）")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消离开" }));
  expect(store.getState().qqInputs.connection?.token).toBe("replacement-secret");
});

it("partial save preserves completed scheme changes and retains the failed connection draft", async () => {
  const update = vi.fn(async (_id, body) => ({ ...qqSchemeFixture(), ...body, revision: 4 }));
  const failed = vi.fn().mockRejectedValue(new Error("connection conflict"));
  store.setState({
    apiClient: { ...store.getState().apiClient, updateQqScheme: update, updateQqSettings: failed },
    qqInputs: { ...store.getState().qqInputs, connection: connection() },
  });
  store.getState().patchQqScheme({ name: "新方案名" });
  store.getState().openChat();
  await store.getState().confirmSaveAndContinue();
  expect(update).toHaveBeenCalledOnce();
  expect(qqSchemeDirty(store.getState().qqSchemeEditor)).toBe(false);
  expect(store.getState().qqSchemeEditor?.name).toBe("新方案名");
  expect(store.getState().page).toBe("settings");
  expect(qqDraftChanges(store.getState()).map((row) => row.resource)).toEqual(["连接"]);
  await store.getState().confirmSaveAndContinue();
  expect(update).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledTimes(2);
});

it("connection save uses the draft revision and carries forward a successful first request", async () => {
  const update = vi.fn(async () => ({ ...settings, account_id: "101", revision: 4 }));
  const transport = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ...settings, account_id: "101", revision: 6 });
  store.setState({
    qqSettings: { ...settings, revision: 9 },
    apiClient: {
      ...store.getState().apiClient,
      updateQqSettings: update,
      updateQqTransport: transport,
    },
    qqInputs: { ...store.getState().qqInputs, connection: { ...connection(), accountId: "101" } },
  });
  expect(await store.getState().saveQqDrafts()).toBe(false);
  expect(update).toHaveBeenCalledWith({ account_id: "101", expected_revision: 3 });
  expect(store.getState().qqInputs.connection?.source.revision).toBe(4);
  expect(store.getState().qqSettings?.account_id).toBe("101");
});

it("QQ automatic organization drafts participate in the same unload decision", () => {
  expect(settingsHaveDrafts(store.getState())).toBe(false);
  store.getState().patchQqMemoryBatchDraft("binding", { value: "", revision: 2 });
  expect(settingsHaveDrafts(store.getState())).toBe(true);
});
