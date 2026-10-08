import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKnowledgeReadConfigSchema } from "../../src/shared/contracts/knowledge";
import { api } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";

const global = { revision: 1, context_budget: 4096, auto_enabled: true, model_name: null };
const reading = { revision: 1, config: AgentKnowledgeReadConfigSchema.parse({}) };
afterEach(() => vi.restoreAllMocks());
describe("knowledge read API ownership", () => {
  it("rejects an old global model read after changing API", async () => {
    let resolve!: (value: typeof global) => void;
    store.getState().resetForTests({
      ...api,
      getKnowledgeSettings: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const loading = store.getState().loadKnowledgeModel();
    store.getState().resetForTests({ ...api });
    resolve(global);
    await loading;
    expect(store.getState().knowledgeModelEditor).toBeNull();
  });
  it("rejects an old Agent knowledge read after changing API", async () => {
    let resolve!: (value: typeof reading) => void;
    store.getState().resetForTests({
      ...api,
      getAgentKnowledgeRead: () =>
        new Promise((done) => {
          resolve = done;
        }),
      listAgentKnowledge: async () => [],
      getKnowledgeSettings: async () => global,
    });
    store.setState({ editorAgentId: "Agent-A" });
    const loading = store.getState().loadKnowledgeRead();
    store.getState().resetForTests({ ...api });
    store.setState({ editorAgentId: "Agent-A" });
    resolve(reading);
    await loading;
    expect(store.getState().knowledgeReadEditor).toBeNull();
  });
  it("does not let an old completion clear a new API's pending read", async () => {
    let resolveOld!: (value: typeof global) => void;
    let resolveNew!: (value: typeof global) => void;
    store.getState().resetForTests({
      ...api,
      getKnowledgeSettings: () =>
        new Promise((done) => {
          resolveOld = done;
        }),
    });
    const oldRead = store.getState().loadKnowledgeModel();
    store.getState().resetForTests({
      ...api,
      getKnowledgeSettings: () =>
        new Promise((done) => {
          resolveNew = done;
        }),
    });
    const newRead = store.getState().loadKnowledgeModel();
    resolveOld(global);
    await oldRead;
    expect(store.getState().knowledgeModelLoading).toBe(true);
    resolveNew(global);
    await newRead;
    expect(store.getState().knowledgeModelLoading).toBe(false);
  });
});
