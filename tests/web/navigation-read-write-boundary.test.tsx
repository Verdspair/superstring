import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";
import { navigationBusy } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B, persona } from "./helpers/library-fixture";

afterEach(() => vi.restoreAllMocks());
function pendingAgent() {
  let resolve!: (value: typeof agent) => void;
  const promise = new Promise<typeof agent>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("navigation read and write ownership", () => {
  it("allows leaving pending Agent reads without installing the old editor on another page", async () => {
    const pending = pendingAgent();
    store
      .getState()
      .resetForTests({ ...api, getAgent: () => pending.promise, getPersona: async () => persona });
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "long-memory",
      editorAgentId: A,
      agents: [agent],
    });
    const selecting = store.getState().editAgent(B);
    store.getState().openSettingsRoute("scheme-library");
    const landed = store.getState().settingsRoute;
    pending.resolve({ ...agent, id: B });
    await selecting;
    expect(landed).toBe("scheme-library");
    expect(store.getState().pageEditor).toBeNull();
    expect(store.getState().editorLoading).toBe(false);
  });
  it("does not let an old API install its Agent response after reset", async () => {
    const pending = pendingAgent();
    store
      .getState()
      .resetForTests({ ...api, getAgent: () => pending.promise, getPersona: async () => persona });
    const selecting = store.getState().editAgent(A);
    store.getState().resetForTests({ ...api });
    pending.resolve(agent);
    await selecting;
    expect(store.getState().pageEditor).toBeNull();
  });
  it("does not treat read-only loading flags as global write locks", () => {
    store.getState().resetForTests({ ...api });
    store.setState({
      editorLoading: true,
      knowledgeReadLoading: true,
      knowledgeModelLoading: true,
    });
    expect(navigationBusy(store.getState())).toBe(false);
  });
  it("retains global navigation protection for each real write operation", () => {
    const flags = [
      "settingsSaving",
      "permissionSaving",
      "qqSchemeSaving",
      "memoryCorrectionSaving",
      "qqMemoryBatchSaving",
      "knowledgeBusy",
      "webAccessSaving",
    ] as const;
    for (const flag of flags) {
      store.getState().resetForTests({ ...api });
      store.setState({ [flag]: true });
      expect(navigationBusy(store.getState())).toBe(true);
    }
  });
});
