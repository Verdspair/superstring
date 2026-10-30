import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateAgentRequestSchema } from "../../src/shared/contracts";
import { AgentKnowledgeReadConfigSchema } from "../../src/shared/contracts/knowledge";
import { ApiError, api } from "../../src/web/api";
import { knowledgeReadDirty } from "../../src/web/features/knowledge/types";
import { useSuperstringStore as store } from "../../src/web/store";
import { openSpace } from "../../src/web/workspace/navigation";
import { A, agent, setupLibrary } from "./helpers/library-fixture";

const global = { revision: 1, context_budget: 4096, auto_enabled: true, model_name: null };
const reading = { revision: 1, config: AgentKnowledgeReadConfigSchema.parse({}) };
afterEach(() => vi.restoreAllMocks());
describe("knowledge read API ownership", () => {
  it("organization leases share one request and an inactive retained release cannot cancel active subscribers", async () => {
    let signal!: AbortSignal;
    let finish!: (value: Awaited<ReturnType<typeof api.getOrganizationSettings>>) => void;
    const getOrganizationSettings = vi.fn((input?: AbortSignal) => {
      signal = input!;
      return new Promise<Awaited<ReturnType<typeof api.getOrganizationSettings>>>((resolve) => {
        finish = resolve;
      });
    });
    store.getState().resetForTests({ ...api, getOrganizationSettings });
    const firstOwner = {},
      secondOwner = {},
      inactiveOwner = {};
    const first = store.getState().acquireOrganizationRead(firstOwner);
    const repeat = store.getState().acquireOrganizationRead(firstOwner);
    const second = store.getState().acquireOrganizationRead(secondOwner);
    await vi.waitFor(() => expect(getOrganizationSettings).toHaveBeenCalledTimes(1));
    store.getState().releaseOrganizationRead(inactiveOwner);
    expect(signal.aborted).toBe(false);
    store.getState().releaseOrganizationRead(firstOwner);
    expect(signal.aborted).toBe(false);
    finish({
      revision: 1,
      model_name: "shared",
      vision_model_name: null,
      transcription_model_name: null,
    });
    await Promise.all([first, repeat, second]);
    expect(store.getState().organizationEditor?.source.model_name).toBe("shared");
    store.getState().releaseOrganizationRead(secondOwner);
  });
  it("organization final hidden lease cancels transport, settles waiters and resumes once with dirty fields", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    let signal!: AbortSignal;
    const base = {
      revision: 1,
      model_name: "saved",
      vision_model_name: null,
      transcription_model_name: null,
    };
    const getOrganizationSettings = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockImplementationOnce((input?: AbortSignal) => {
        signal = input!;
        return new Promise(() => {});
      })
      .mockResolvedValueOnce({ ...base, revision: 2 });
    store.getState().resetForTests({ ...api, getOrganizationSettings });
    const owner = {};
    await store.getState().acquireOrganizationRead(owner);
    store.getState().patchOrganization("dirty");
    const refreshing = store.getState().loadOrganization(true);
    await vi.waitFor(() => expect(signal).toBeDefined());
    hidden = true;
    store.getState().releaseOrganizationRead(owner);
    expect(signal.aborted).toBe(true);
    await refreshing;
    hidden = false;
    await store.getState().acquireOrganizationRead(owner);
    expect(getOrganizationSettings).toHaveBeenCalledTimes(3);
    expect(store.getState().organizationEditor?.modelName).toBe("dirty");
    expect(store.getState().organizationEditor?.source.revision).toBe(2);
    store.getState().releaseOrganizationRead(owner);
  });
  it("organization old API lease releases cannot abort a new API subscriber and explicit cancel still clears all", async () => {
    let oldSignal!: AbortSignal, newSignal!: AbortSignal;
    const oldClient = {
      ...api,
      getOrganizationSettings: vi.fn((input?: AbortSignal) => {
        oldSignal = input!;
        return new Promise<Awaited<ReturnType<typeof api.getOrganizationSettings>>>(() => {});
      }),
    };
    store.getState().resetForTests(oldClient);
    const oldOwner = {},
      newOwner = {};
    const oldRead = store.getState().acquireOrganizationRead(oldOwner);
    await vi.waitFor(() => expect(oldSignal).toBeDefined());
    const newClient = {
      ...api,
      getOrganizationSettings: vi.fn((input?: AbortSignal) => {
        newSignal = input!;
        return new Promise<Awaited<ReturnType<typeof api.getOrganizationSettings>>>(() => {});
      }),
    };
    store.setState({ apiClient: newClient });
    const newRead = store.getState().acquireOrganizationRead(newOwner);
    await vi.waitFor(() => expect(newSignal).toBeDefined());
    expect(oldSignal.aborted).toBe(true);
    await oldRead;
    store.getState().releaseOrganizationRead(oldOwner);
    expect(newSignal.aborted).toBe(false);
    store.getState().cancelOrganizationRead();
    expect(newSignal.aborted).toBe(true);
    await newRead;
    expect(store.getState().organizationLoading).toBe(false);
  });
  it("shares the pending organization request and both callers settle only after its saved source is ready", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.getOrganizationSettings>>) => void;
    const getOrganizationSettings = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof api.getOrganizationSettings>>>((resolve) => {
          finish = resolve;
        }),
    );
    store.getState().resetForTests({ ...api, getOrganizationSettings });
    const first = store.getState().loadOrganization();
    const second = store.getState().loadOrganization();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await vi.waitFor(() => expect(getOrganizationSettings).toHaveBeenCalledTimes(1));
    expect(secondSettled).toBe(false);
    finish({
      model_name: "shared",
      vision_model_name: null,
      transcription_model_name: null,
      revision: 2,
    });
    await Promise.all([first, second]);
    expect(store.getState().organizationEditor?.source.model_name).toBe("shared");
    expect(store.getState().organizationLoading).toBe(false);
  });
  it("suspends the actual organization transport and resumes with its dirty fields and updated saved revision", async () => {
    const first = {
      revision: 1,
      model_name: "base",
      vision_model_name: null,
      transcription_model_name: null,
    };
    let signal!: AbortSignal;
    const getOrganizationSettings = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce((input?: AbortSignal) => {
        signal = input!;
        return new Promise(() => {});
      })
      .mockResolvedValueOnce({ ...first, revision: 3, model_name: "remote" });
    store.getState().resetForTests({ ...api, getOrganizationSettings });
    await store.getState().loadOrganization();
    store.getState().patchOrganization("local draft");
    const pending = store.getState().loadOrganization(true);
    await vi.waitFor(() => expect(signal).toBeDefined());
    store.getState().cancelOrganizationRead();
    expect(signal.aborted).toBe(true);
    expect(store.getState().organizationLoading).toBe(false);
    await store.getState().loadOrganization(true);
    expect(store.getState().organizationEditor?.source.revision).toBe(3);
    expect(store.getState().organizationEditor?.modelName).toBe("local draft");
    await pending;
  });

  it("takes over a pending organization read after API replacement, aborts old transport and clears the new loading owner", async () => {
    let finishOld!: (value: {
      revision: number;
      model_name: string;
      vision_model_name: null;
      transcription_model_name: null;
    }) => void;
    let oldSignal!: AbortSignal;
    const value = {
      revision: 1,
      model_name: "old",
      vision_model_name: null,
      transcription_model_name: null,
    };
    const oldClient = {
      ...api,
      getOrganizationSettings: (signal?: AbortSignal) => {
        oldSignal = signal!;
        return new Promise<typeof value>((done) => {
          finishOld = done;
        });
      },
    };
    store.getState().resetForTests(oldClient);
    const oldRead = store.getState().loadOrganization();
    await vi.waitFor(() => expect(oldSignal).toBeDefined());
    const getOrganizationSettings = vi.fn(async () => ({
      ...value,
      revision: 2,
      model_name: "new",
    }));
    store.setState({ apiClient: { ...api, getOrganizationSettings } });
    await store.getState().loadOrganization();
    expect(oldSignal.aborted).toBe(true);
    expect(store.getState().organizationEditor?.source.model_name).toBe("new");
    expect(store.getState().organizationLoading).toBe(false);
    finishOld(value);
    await oldRead;
    expect(store.getState().organizationEditor?.source.model_name).toBe("new");
  });
  it("does not merge a loaded old API organization draft into a new API baseline", async () => {
    const value = {
      revision: 1,
      model_name: "old",
      vision_model_name: null,
      transcription_model_name: null,
    };
    store.getState().resetForTests({ ...api, getOrganizationSettings: async () => value });
    await store.getState().loadOrganization();
    store.getState().patchOrganization("old private draft");
    store.setState({
      apiClient: {
        ...api,
        getOrganizationSettings: async () => ({ ...value, revision: 9, model_name: "new" }),
      },
    });
    await store.getState().loadOrganization();
    expect(store.getState().organizationEditor?.modelName).toBe("new");
    expect(store.getState().organizationEditor?.source.revision).toBe(9);
  });

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
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
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
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    store.getState().resetForTests({
      ...api,
      getKnowledgeSettings: () =>
        new Promise((done) => {
          resolveNew = done;
        }),
    });
    const newRead = store.getState().loadKnowledgeModel();
    await vi.waitFor(() => expect(resolveNew).toBeTypeOf("function"));
    resolveOld(global);
    await oldRead;
    expect(store.getState().knowledgeModelLoading).toBe(true);
    resolveNew(global);
    await newRead;
    expect(store.getState().knowledgeModelLoading).toBe(false);
  });
});

describe("materials partial-save workspace departure", () => {
  async function partialMaterials() {
    const updateAgent = vi.fn(async (_id: string, body: unknown) => ({
      ...agent,
      ...UpdateAgentRequestSchema.parse(body),
      config_version: 2,
    }));
    const remote = { revision: 2, config: { ...reading.config, enabled: false } };
    const getAgentKnowledgeRead = vi.fn().mockResolvedValueOnce(reading).mockResolvedValue(remote);
    const saveAgentKnowledgeRead = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict"))
      .mockImplementation(
        async (_id: string, body: Parameters<typeof api.saveAgentKnowledgeRead>[1]) => ({
          revision: 3,
          config: body.config,
        }),
      );
    setupLibrary({ updateAgent, getAgentKnowledgeRead, saveAgentKnowledgeRead });
    store.setState({ settingsRoute: "memory-tools" });
    await store.getState().loadKnowledgeRead();
    const bytes = (agent.p5_config.memory_read?.max_bytes ?? 8192) + 1;
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...agent.p5_config, memory_read: { enabled: true, max_bytes: bytes } },
    });
    store.getState().patchKnowledgeRead({ context_budget: 1025 });
    expect(await store.getState().saveSettingsTask("materials")).toBe(false);
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(saveAgentKnowledgeRead).toHaveBeenCalledTimes(1);
    expect(store.getState().pageEditor?.agent.p5_config.memory_read?.max_bytes).toBe(bytes);
    expect(knowledgeReadDirty(store.getState().knowledgeReadEditor)).toBe(true);
    openSpace("capabilities");
    expect(store.getState()).toMatchObject({
      settingsRoute: "memory-tools",
      navigationConfirmOpen: true,
      pendingNavigation: { kind: "page", settingsRoute: "system-capabilities" },
    });
    return { updateAgent, saveAgentKnowledgeRead, bytes };
  }

  it("cancel retains the failed knowledge draft and the already committed memory baseline", async () => {
    const { updateAgent, saveAgentKnowledgeRead, bytes } = await partialMaterials();
    store.getState().cancelPendingNavigation();
    expect(store.getState().settingsRoute).toBe("memory-tools");
    expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBe(1025);
    expect(store.getState().pageEditor?.agent.p5_config.memory_read?.max_bytes).toBe(bytes);
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(saveAgentKnowledgeRead).toHaveBeenCalledTimes(1);
  });

  it("refresh then save-and-continue retries only failed knowledge with its latest revision", async () => {
    const { updateAgent, saveAgentKnowledgeRead, bytes } = await partialMaterials();
    await store.getState().refreshKnowledgeRead();
    expect(store.getState().knowledgeReadEditor?.source.revision).toBe(2);
    expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBe(1025);
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().settingsRoute).toBe("system-capabilities");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(saveAgentKnowledgeRead).toHaveBeenLastCalledWith(A, {
      expected_revision: 2,
      config: { ...reading.config, enabled: false, context_budget: 1025 },
    });
    expect(saveAgentKnowledgeRead).toHaveBeenCalledTimes(2);
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(store.getState().pageEditor?.agent.p5_config.memory_read?.max_bytes).toBe(bytes);
    expect(knowledgeReadDirty(store.getState().knowledgeReadEditor)).toBe(false);
  });

  it("discard-and-continue removes only unsaved knowledge and never rolls back committed memory", async () => {
    const { updateAgent, saveAgentKnowledgeRead, bytes } = await partialMaterials();
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().settingsRoute).toBe("system-capabilities");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(knowledgeReadDirty(store.getState().knowledgeReadEditor)).toBe(false);
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(bytes);
    expect(store.getState().pageEditor?.agent.p5_config.memory_read?.max_bytes).toBe(bytes);
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(saveAgentKnowledgeRead).toHaveBeenCalledTimes(1);
  });
});

it("global knowledge and organization drafts use the same settings-route save/discard continuation", async () => {
  const saveKnowledgeSettings = vi.fn(
    async (body: Parameters<typeof api.saveKnowledgeSettings>[0]) => ({
      revision: 2,
      auto_enabled: body.auto_enabled,
      model_name: body.model_name,
      context_budget: body.context_budget,
    }),
  );
  const saveOrganizationSettings = vi.fn(
    async (body: Parameters<typeof api.saveOrganizationSettings>[0]) => ({
      revision: 2,
      model_name: body.model_name ?? null,
      vision_model_name: body.vision_model_name ?? null,
      transcription_model_name: body.transcription_model_name ?? null,
    }),
  );
  setupLibrary({ saveKnowledgeSettings, saveOrganizationSettings });
  store.setState({ settingsRoute: "knowledge-config" });
  await store.getState().loadKnowledgeModel();
  await store.getState().loadOrganization();
  store.getState().patchKnowledgeGlobal({ contextBudget: 8192 });
  store.getState().patchOrganization("new organizer");
  openSpace("capabilities");
  expect(store.getState().navigationConfirmOpen).toBe(true);
  await store.getState().confirmSaveAndContinue();
  expect(saveKnowledgeSettings).toHaveBeenCalledTimes(1);
  expect(saveOrganizationSettings).toHaveBeenCalledTimes(1);
  expect(store.getState().settingsRoute).toBe("system-capabilities");
  store.getState().patchKnowledgeGlobal({ contextBudget: 9000 });
  store.getState().patchOrganization("discard organizer");
  openSpace("connections");
  await store.getState().confirmDiscardAndContinue();
  expect(store.getState().settingsRoute).toBe("mcp-servers");
  expect(saveKnowledgeSettings).toHaveBeenCalledTimes(1);
  expect(saveOrganizationSettings).toHaveBeenCalledTimes(1);
  expect(store.getState().knowledgeModelEditor).toBeNull();
  expect(store.getState().organizationEditor).toBeNull();
});

it.each(["save", "discard"] as const)(
  "knowledge content %s does not touch unselected Agent drafts",
  async (choice) => {
    const createKnowledgeCategory = vi.fn().mockResolvedValue({
      id: "new-category",
      name: "content draft",
      revision: 1,
      document_count: 0,
    });
    const updateAgent = vi.fn();
    setupLibrary({ createKnowledgeCategory, updateAgent });
    store.getState().patchPageAgent("basic", { name: "unselected Agent" });
    store.setState({
      settingsRoute: "knowledge-config",
      knowledgeEditor: { kind: "category-new", name: "content draft" },
      knowledgeDirty: true,
    });
    store.getState().requestKnowledgeEditor({ kind: "none" });
    expect(store.getState().pendingNavigation?.kind).toBe("knowledge");
    if (choice === "save") await store.getState().confirmSaveAndContinue();
    else await store.getState().confirmDiscardAndContinue();
    expect(store.getState().pageEditor?.draft.name).toBe("unselected Agent");
    expect(updateAgent).not.toHaveBeenCalled();
    expect(createKnowledgeCategory).toHaveBeenCalledTimes(choice === "save" ? 1 : 0);
    expect(store.getState().knowledgeDirty).toBe(false);
  },
);

describe("materials refresh single-owner orchestration", () => {
  it("keeps a committed memory baseline out of a failed refresh retry", async () => {
    const getAgent = vi.fn().mockResolvedValue({ ...agent, config_version: 3 });
    const updateAgent = vi.fn().mockResolvedValue({ ...agent, config_version: 2 });
    const getAgentKnowledgeRead = vi
      .fn()
      .mockResolvedValueOnce(reading)
      .mockResolvedValueOnce({ revision: 2, config: { ...reading.config, enabled: false } });
    const saveAgentKnowledgeRead = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict"))
      .mockResolvedValueOnce({
        revision: 3,
        config: { ...reading.config, enabled: false, context_budget: 1025 },
      });
    setupLibrary({ getAgent, updateAgent, getAgentKnowledgeRead, saveAgentKnowledgeRead });
    store.setState({ settingsRoute: "memory-tools" });
    await store.getState().loadKnowledgeRead();
    store.getState().patchKnowledgeRead({ context_budget: 1025 });
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...agent.p5_config, memory_read: { enabled: true, max_bytes: 1500 } },
    });
    expect(await store.getState().saveSettingsTask("materials")).toBe(false);
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(saveAgentKnowledgeRead).toHaveBeenCalledTimes(1);
    await store.getState().refreshKnowledgeRead();
    expect(getAgentKnowledgeRead).toHaveBeenCalledTimes(2);
    expect(saveAgentKnowledgeRead).toHaveBeenCalledTimes(1);
    expect(await store.getState().saveSettingsTask("materials")).toBe(true);
    expect(saveAgentKnowledgeRead).toHaveBeenCalledTimes(2);
    expect(updateAgent).toHaveBeenCalledTimes(1);
  });
});
