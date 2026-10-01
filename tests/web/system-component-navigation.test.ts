import { beforeEach, expect, it } from "vitest";
import { api } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";

beforeEach(() => store.getState().resetForTests(api));

it("opens a component in its owning directory", () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
  });
  store.getState().openSystemComponent({ kind: "tool", id: "memory.query" });
  expect(store.getState()).toMatchObject({
    settingsRoute: "tool-grants",
    componentTarget: { kind: "tool", id: "memory.query" },
  });
});

it("ordinary directory navigation clears stale component focus", () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "tool-grants",
    componentTarget: { kind: "tool", id: "web.fetch" },
  });
  store.getState().openSettingsRoute("skill-catalog");
  expect(store.getState()).toMatchObject({ settingsRoute: "skill-catalog", componentTarget: null });
});

it("does not change component focus until guarded navigation lands", async () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
    qqInputs: { ...store.getState().qqInputs, manualPeer: "30003" },
  });
  store.getState().openSystemComponent({ kind: "skill", id: "system-evidence-reading" });
  expect(store.getState().navigationConfirmOpen).toBe(true);
  expect(store.getState().componentTarget).toBeNull();
  store.getState().cancelPendingNavigation();
  expect(store.getState()).toMatchObject({
    settingsRoute: "system-capabilities",
    componentTarget: null,
  });
});

it("carries the component focus through discard-and-continue", async () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
    qqInputs: { ...store.getState().qqInputs, manualPeer: "30003" },
  });
  store.getState().openSystemComponent({ kind: "tool", id: "web.fetch" });
  await store.getState().confirmDiscardAndContinue();
  expect(store.getState()).toMatchObject({
    settingsRoute: "tool-grants",
    componentTarget: { kind: "tool", id: "web.fetch" },
    navigationConfirmOpen: false,
  });
});

it("preserves the pending component when save-and-continue is rejected", async () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
    qqInputs: {
      ...store.getState().qqInputs,
      storage: {
        source: { cleanup_mode: "manual", retention_days: 14, revision: 1 },
        days: "",
      },
    },
  });
  store.getState().openSystemComponent({ kind: "tool", id: "memory.read" });
  await store.getState().confirmSaveAndContinue();
  expect(store.getState()).toMatchObject({
    settingsRoute: "system-capabilities",
    componentTarget: null,
    pendingNavigation: {
      kind: "page",
      settingsRoute: "tool-grants",
      componentTarget: { kind: "tool", id: "memory.read" },
    },
    navigationConfirmOpen: true,
  });
});

it("does not change component focus while a configuration write is active", () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
    permissionSaving: true,
  });
  store.getState().openSystemComponent({ kind: "mcp", id: "local-service" });
  expect(store.getState()).toMatchObject({
    settingsRoute: "system-capabilities",
    componentTarget: null,
  });
});
