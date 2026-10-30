import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentResponseSchema,
  PersonaResponseSchema,
  SavePersonaRequestSchema,
  UpdateAgentRequestSchema,
} from "../../src/shared/contracts";
import { AgentKnowledgeReadConfigSchema } from "../../src/shared/contracts/knowledge";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { dirtyPages, newPageEditor } from "../../src/web/features/agents/page-drafts";
import { useSuperstringStore as store } from "../../src/web/store";

const agent = () =>
  AgentResponseSchema.parse({
    id: "A",
    name: "A",
    model_name: "old-model",
    config_version: 1,
    persona_intensity: 60,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
  });
const persona = () =>
  PersonaResponseSchema.parse({
    id: "P",
    agent_id: "A",
    core_identity: "",
    communication_style: "",
    interaction_boundaries: "",
    example_dialogues: "",
    advanced_instructions: "",
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
  });
let current: ReturnType<typeof agent>, currentPersona: ReturnType<typeof persona>;
let client: SuperstringApi;
const state = () => store.getState();
beforeEach(() => {
  current = agent();
  currentPersona = persona();
  client = {
    updateAgent: vi.fn(async (_id, patch) => {
      current = {
        ...current,
        ...UpdateAgentRequestSchema.parse(patch),
        config_version: current.config_version + 1,
      };
      return current;
    }),
    savePersona: vi.fn(async (_id, patch) => {
      currentPersona = { ...currentPersona, ...SavePersonaRequestSchema.parse(patch) };
      return currentPersona;
    }),
    getModelCapacity: vi.fn(async () => ({ context_length: 65536 })),
    listAgentKnowledge: vi.fn(async () => []),
    saveAgentKnowledgeRead: vi.fn(async (_id, body) => ({
      revision: body.expected_revision + 1,
      config: body.config,
    })),
  } as unknown as SuperstringApi;
  state().resetForTests(client);
  store.setState({
    editorAgentId: "A",
    pageEditor: newPageEditor(current, currentPersona),
    agents: [current],
    knowledgeReadEditor: {
      token: {},
      agentId: "A",
      source: { revision: 1, config: AgentKnowledgeReadConfigSchema.parse({}) },
      draft: AgentKnowledgeReadConfigSchema.parse({}),
      documents: [],
      globalBudget: 16384,
    },
  });
});
describe("Agent task save", () => {
  it("tools task saves only this Agent overrides and keeps base/other Agent drafts", async () => {
    const snapshot = {
      revision: "r1",
      policy: {
        version: 1 as const,
        grants: [
          {
            resource: "web",
            approved: true,
            revision: "w1",
            directories: [],
            agentIds: ["A", "B"],
            agentOverrides: { B: { enabled: false, approved: false, directories: [] } },
          },
        ],
      },
      resources: [
        {
          name: "web.search",
          resource: "web",
          description: "",
          effect: "read" as const,
          revision: "w1",
          approvalRequired: true,
          directories: [],
        },
      ],
    };
    const getPermissions = vi.fn(async () => snapshot);
    const savePermissions = vi.fn(
      async (body: Parameters<SuperstringApi["savePermissions"]>[0]) => ({
        ...snapshot,
        revision: "r2",
        policy: body.policy,
      }),
    );
    store.setState({ apiClient: { ...client, getPermissions, savePermissions } });
    await state().loadPermissionSettings();
    state().patchToolGrant("web", {
      approved: false,
      agentOverrides: {
        A: { enabled: false, approved: false, directories: [] },
        B: { enabled: true, approved: true, revision: "w1", directories: [] },
      },
    });
    expect(state().settingsTaskDirty("tools")).toBe(true);
    expect(await state().saveSettingsTask("tools")).toBe(true);
    const policy = savePermissions.mock.calls[0][0].policy;
    expect(policy.grants[0].approved).toBe(true);
    expect(policy.grants[0].agentOverrides?.A?.enabled).toBe(false);
    expect(policy.grants[0].agentOverrides?.B?.enabled).toBe(false);
    expect(state().permissionEditor?.grants.web.agentOverrides?.B.enabled).toBe(true);
    expect(state().settingsTaskDirty("tools")).toBe(false);
    expect(client.updateAgent).not.toHaveBeenCalled();
  });

  it("keeps basic success after persona failure and retries only remaining work", async () => {
    state().patchPageAgent("basic", { name: "renamed" });
    state().patchPagePersona("identity", { core_identity: "identity" });
    vi.mocked(client.savePersona).mockRejectedValueOnce(new Error("persona failure"));
    expect(await state().saveSettingsTask("identity")).toBe(false);
    expect(dirtyPages(state().pageEditor)).toContain("identity");
    expect(dirtyPages(state().pageEditor)).not.toContain("basic");
    expect(await state().saveSettingsTask("identity")).toBe(true);
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    expect(client.savePersona).toHaveBeenCalledTimes(2);
  });
  it("keeps identity success and retries expression without resending identity draft", async () => {
    state().patchPagePersona("identity", { core_identity: "identity" });
    state().patchPagePersona("expression", { communication_style: "style" });
    vi.mocked(client.savePersona).mockImplementationOnce(async (_id, value) => ({
      ...currentPersona,
      ...SavePersonaRequestSchema.parse(value),
    }));
    vi.mocked(client.savePersona).mockRejectedValueOnce(new Error("expression"));
    expect(await state().saveSettingsTask("identity")).toBe(false);
    expect(dirtyPages(state().pageEditor)).not.toContain("identity");
    expect(dirtyPages(state().pageEditor)).toContain("expression");
  });
  it("checks target model capacity before writing either conversation page", async () => {
    state().patchPageAgent("models", { model_name: "new-model" });
    state().patchPageAgent("context", {
      p5_config: { ...state().pageEditor!.draft.p5_config, context_window: 8192 },
    });
    vi.mocked(client.getModelCapacity).mockResolvedValueOnce({ context_length: 1000 } as never);
    expect(await state().saveSettingsTask("conversation")).toBe(false);
    expect(client.getModelCapacity).toHaveBeenCalledWith("new-model");
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
  it("keeps models baseline after context conflict and retries only context", async () => {
    state().patchPageAgent("models", { model_name: "new-model" });
    state().patchPageAgent("context", {
      p5_config: { ...state().pageEditor!.draft.p5_config, context_window: 8192 },
    });
    vi.mocked(client.updateAgent).mockImplementationOnce(async (_id, patch) => {
      current = { ...current, ...UpdateAgentRequestSchema.parse(patch), config_version: 2 };
      return current;
    });
    vi.mocked(client.updateAgent).mockRejectedValueOnce(
      new ApiError(409, "CONFIG_VERSION_CONFLICT", "conflict"),
    );
    expect(await state().saveSettingsTask("conversation")).toBe(false);
    expect(dirtyPages(state().pageEditor)).not.toContain("models");
    expect(dirtyPages(state().pageEditor)).toContain("context");
    expect(await state().saveSettingsTask("conversation")).toBe(true);
    expect(client.updateAgent).toHaveBeenCalledTimes(3);
  });
  it("keeps memory success and knowledge failure for retry without unrelated basic write", async () => {
    state().patchPageAgent("memory-tools", {
      p5_config: {
        ...state().pageEditor!.draft.p5_config,
        memory_read: { enabled: false, max_bytes: 1024 },
      },
    });
    state().patchPageAgent("basic", { name: "unrelated" });
    state().patchKnowledgeRead({ enabled: false });
    vi.mocked(client.saveAgentKnowledgeRead).mockRejectedValueOnce(
      new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict"),
    );
    expect(await state().saveSettingsTask("materials")).toBe(false);
    expect(state().error).toContain("读取配置已被其他操作修改");
    expect(dirtyPages(state().pageEditor)).not.toContain("memory-tools");
    expect(dirtyPages(state().pageEditor)).toContain("basic");
    expect(await state().saveSettingsTask("materials")).toBe(true);
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledTimes(2);
  });
  it("refreshes missing knowledge choices while keeping the selected draft", async () => {
    const doc = "11111111-1111-4111-8111-111111111111";
    state().patchKnowledgeRead({ scope: "selected", document_ids: [doc] });
    vi.mocked(client.saveAgentKnowledgeRead).mockRejectedValueOnce(
      new ApiError(404, "KNOWLEDGE_NOT_FOUND", "missing"),
    );
    expect(await state().saveSettingsTask("materials")).toBe(false);
    expect(client.listAgentKnowledge).toHaveBeenCalledTimes(1);
    expect(state().knowledgeReadEditor?.draft.document_ids).toEqual([doc]);
    expect(state().knowledgeReadEditor?.draft.scope).toBe("selected");
    expect(state().error).toContain("部分指定资料已失效");
  });
  it("does not count a different Agent's stale knowledge draft as current task dirty", () => {
    const editor = state().knowledgeReadEditor!;
    store.setState({
      knowledgeReadEditor: { ...editor, agentId: "B", draft: { ...editor.draft, enabled: false } },
    });
    expect(state().settingsTaskDirty("materials")).toBe(false);
  });
  it("rejects invalid target input before any write", async () => {
    state().patchPageAgent("basic", { name: "" });
    state().patchPagePersona("identity", { core_identity: "valid" });
    expect(await state().saveSettingsTask("identity")).toBe(false);
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(client.savePersona).not.toHaveBeenCalled();
  });
  it("stops remaining steps and leaves new editor untouched after API replacement", async () => {
    let resolve!: (value: ReturnType<typeof agent>) => void;
    vi.mocked(client.updateAgent).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    state().patchPageAgent("basic", { name: "pending" });
    state().patchPagePersona("identity", { core_identity: "old" });
    const pending = state().saveSettingsTask("identity");
    const replacement = { ...client } as SuperstringApi;
    store.setState({ apiClient: replacement, pageEditor: newPageEditor(agent(), persona()) });
    resolve({ ...agent(), name: "pending", config_version: 2 });
    expect(await pending).toBe(false);
    expect(client.savePersona).not.toHaveBeenCalled();
    expect(state().pageEditor?.draft.name).toBe("A");
    expect(state().settingsSaving).toBe(false);
  });
});
