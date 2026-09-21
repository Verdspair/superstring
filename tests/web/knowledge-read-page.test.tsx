import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import {
  AgentKnowledgeReadConfigSchema,
  type AgentKnowledgeReadSettings,
} from "../../src/shared/contracts/knowledge";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { SettingsWorkspace } from "../../src/web/app/SettingsWorkspace";
import { knowledgeReadDirty } from "../../src/web/features/knowledge/types";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const DOC = "11111111-1111-4111-8111-111111111111";
const LOST = "22222222-2222-4222-8222-222222222222";
const agent = (id: string) =>
  AgentResponseSchema.parse({
    id,
    name: id,
    model_name: "model",
    config_version: 1,
    persona_intensity: 60,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
  });
const persona = (id: string) =>
  PersonaResponseSchema.parse({
    id,
    agent_id: id,
    core_identity: "",
    communication_style: "",
    interaction_boundaries: "",
    example_dialogues: "",
    advanced_instructions: "",
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
  });
let client: SuperstringApi;
let saved: AgentKnowledgeReadSettings;
const state = () => store.getState();
const dirty = () => knowledgeReadDirty(state().knowledgeReadEditor);
beforeEach(async () => {
  selectLocale("zh-CN");
  saved = { revision: 1, config: AgentKnowledgeReadConfigSchema.parse({}) };
  client = {
    getAgent: vi.fn(async (id) => agent(id)),
    getPersona: vi.fn(async (id) => persona(id)),
    getPolicy: vi.fn(async () => ({
      auto_enabled: true,
      every_turns: 20,
      target_chars: 300,
      version: 1,
    })),
    listMemorySessions: vi.fn(async () => []),
    listMemoryJobs: vi.fn(async () => []),
    getAgentKnowledgeRead: vi.fn(async () => structuredClone(saved)),
    saveAgentKnowledgeRead: vi.fn(async (_id, body) => {
      saved = { revision: body.expected_revision + 1, config: body.config };
      return structuredClone(saved);
    }),
    listAgentKnowledge: vi.fn(async () => [
      {
        id: DOC,
        name: "Reference",
        summary: "",
        tags: [],
        content_mode: "original",
        organization_status: "disabled",
      },
    ]),
    getKnowledgeSettings: vi.fn(async () => ({
      revision: 1,
      context_budget: 4096,
      auto_enabled: true,
      model_name: null,
    })),
    saveKnowledgeSettings: vi.fn(),
    updateAgent: vi.fn(),
    savePersona: vi.fn(),
  } as unknown as SuperstringApi;
  state().resetForTests(client);
  store.setState({
    agents: [agent("A"), agent("B")],
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "knowledge-config",
  });
  await state().editAgent("A");
  await state().loadKnowledgeRead();
});
afterEach(() => {
  cleanup();
  selectLocale("zh-CN");
});

describe("S3知识库读取页面", () => {
  it("默认值真实读取且同值改回不误报dirty", () => {
    expect(state().knowledgeReadEditor?.draft).toEqual(saved.config);
    state().patchKnowledgeRead({ enabled: false });
    expect(dirty()).toBe(true);
    state().patchKnowledgeRead({ enabled: true });
    expect(dirty()).toBe(false);
  });
  it("按页保存只提交助手读取设置，不夹带模型或其他页", async () => {
    await state().loadKnowledgeModel();
    state().patchKnowledgeModel("unsaved-global");
    state().patchPageAgent("basic", { name: "unsaved-name" });
    state().patchKnowledgeRead({
      enabled: false,
      context_budget: 8192,
      scope: "selected",
      document_ids: [DOC],
    });
    expect(await state().saveKnowledgeRead()).toBe(true);
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledWith("A", {
      expected_revision: 1,
      config: { enabled: false, context_budget: 8192, scope: "selected", document_ids: [DOC] },
    });
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(state().knowledgeModelEditor?.modelName).toBe("unsaved-global");
    expect(state().pageEditor?.draft.name).toBe("unsaved-name");
    expect(dirty()).toBe(false);
  });
  it("全部范围清空指定清单，再选指定为空，不扩大权限", async () => {
    state().patchKnowledgeRead({ scope: "selected", document_ids: [DOC] });
    state().patchKnowledgeRead({ scope: "all" });
    expect(state().knowledgeReadEditor?.draft.document_ids).toEqual([]);
    state().patchKnowledgeRead({ scope: "selected" });
    await state().saveKnowledgeRead();
    expect(saved.config.document_ids).toEqual([]);
    expect(saved.config.scope).toBe("selected");
  });
  it.each([0, -1, 1.5, Number.NaN])("非法预算%s保留草稿且不发请求", async (budget) => {
    state().patchKnowledgeRead({ context_budget: budget });
    expect(await state().saveKnowledgeRead()).toBe(false);
    expect(client.saveAgentKnowledgeRead).not.toHaveBeenCalled();
    expect(dirty()).toBe(true);
  });
  it("恢复继承存null且独立修订推进", async () => {
    state().patchKnowledgeRead({ context_budget: 8192 });
    await state().saveKnowledgeRead();
    state().patchKnowledgeRead({ context_budget: null });
    await state().saveKnowledgeRead();
    expect(saved).toMatchObject({ revision: 3, config: { context_budget: null } });
  });
  it("跨页及通用页保稿，离开统一提醒，取消保留输入", () => {
    state().patchKnowledgeRead({ enabled: false });
    state().openSettingsRoute("basic");
    state().requestPageNavigation("settings", "general");
    expect(state().navigationConfirmOpen).toBe(false);
    expect(dirty()).toBe(true);
    state().openChat();
    expect(state().navigationConfirmOpen).toBe(true);
    state().cancelPendingNavigation();
    expect(state().page).toBe("settings");
    expect(dirty()).toBe(true);
  });
  it("换助手失败不丢稿，成功放弃后新助手不继承草稿，全局留稿", async () => {
    await state().loadKnowledgeModel();
    state().patchKnowledgeModel("global-draft");
    state().patchKnowledgeRead({ enabled: false });
    vi.mocked(client.getAgent).mockRejectedValueOnce(new Error("cannot read B"));
    state().requestAgentNavigation("B");
    await state().confirmDiscardAndContinue();
    expect(state().editorAgentId).toBe("A");
    expect(dirty()).toBe(true);
    await state().confirmDiscardAndContinue();
    await state().loadKnowledgeRead();
    expect(state().editorAgentId).toBe("B");
    expect(state().knowledgeReadEditor?.draft.enabled).toBe(true);
    expect(state().knowledgeModelEditor?.modelName).toBe("global-draft");
  });
  it("放弃并离开不会复活读取草稿", async () => {
    state().patchKnowledgeRead({ enabled: false });
    state().openChat();
    await state().confirmDiscardAndContinue();
    expect(state().knowledgeReadEditor).toBeNull();
    expect(state().page).toBe("chat");
    await state().editAgent("A");
    await state().loadKnowledgeRead();
    expect(dirty()).toBe(false);
  });
  it("导航保存失败保持原位置，重试只提交读取配置", async () => {
    state().patchKnowledgeRead({ enabled: false });
    state().openChat();
    vi.mocked(client.saveAgentKnowledgeRead).mockRejectedValueOnce(new Error("save failed"));
    await state().confirmSaveAndContinue();
    expect(state().page).toBe("settings");
    expect(dirty()).toBe(true);
    await state().confirmSaveAndContinue();
    expect(state().page).toBe("chat");
    expect(dirty()).toBe(false);
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
  it("修订冲突不自动刷新覆盖，显式刷新保留草稿并推进基线", async () => {
    state().patchKnowledgeRead({ enabled: false });
    saved = { revision: 5, config: { ...saved.config, context_budget: 8000 } };
    vi.mocked(client.saveAgentKnowledgeRead).mockRejectedValueOnce(
      new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict"),
    );
    expect(await state().saveKnowledgeRead()).toBe(false);
    expect(state().knowledgeReadEditor?.source.revision).toBe(1);
    await state().refreshKnowledgeRead();
    expect(state().knowledgeReadEditor?.source.revision).toBe(5);
    expect(state().knowledgeReadEditor?.draft.enabled).toBe(false);
    await state().saveKnowledgeRead();
    expect(saved.revision).toBe(6);
  });
  it("撤权失败刷新候选但保留失效ID，移除后仍是selected空集", async () => {
    state().patchKnowledgeRead({ scope: "selected", document_ids: [DOC] });
    vi.mocked(client.saveAgentKnowledgeRead).mockRejectedValueOnce(
      new ApiError(404, "KNOWLEDGE_NOT_FOUND", "revoked"),
    );
    vi.mocked(client.listAgentKnowledge).mockResolvedValue([]);
    expect(await state().saveKnowledgeRead()).toBe(false);
    expect(state().knowledgeReadEditor?.draft.document_ids).toEqual([DOC]);
    expect(state().knowledgeReadEditor?.documents).toEqual([]);
    state().patchKnowledgeRead({ document_ids: [] });
    await state().saveKnowledgeRead();
    expect(saved.config.scope).toBe("selected");
  });
  it("迟到读取不能覆盖换助手后的编辑器", async () => {
    let resolve!: (v: AgentKnowledgeReadSettings) => void;
    vi.mocked(client.getAgentKnowledgeRead).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const old = state().refreshKnowledgeRead();
    await state().editAgent("B");
    await state().loadKnowledgeRead();
    resolve({ revision: 99, config: { ...saved.config, enabled: false } });
    await old;
    expect(state().knowledgeReadEditor).toMatchObject({ agentId: "B", source: { revision: 1 } });
    expect(state().knowledgeReadLoading).toBe(false);
  });
  it("保存锁阻止重复提交和修改，晚到保存不写入另一个编辑器", async () => {
    let resolve!: (v: AgentKnowledgeReadSettings) => void;
    vi.mocked(client.saveAgentKnowledgeRead).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    state().patchKnowledgeRead({ enabled: false });
    const saving = state().saveKnowledgeRead();
    state().patchKnowledgeRead({ enabled: true });
    state().requestAgentNavigation("B");
    state().openChat();
    expect(await state().saveKnowledgeRead()).toBe(false);
    expect(state().knowledgeReadEditor?.draft.enabled).toBe(false);
    expect(state().editorAgentId).toBe("A");
    store.setState({ knowledgeReadEditor: null });
    resolve(saved);
    expect(await saving).toBe(false);
    expect(state().knowledgeReadEditor).toBeNull();
  });
  it("页面平铺三组和锚点，关闭保留预算与范围，五策略无控件", async () => {
    await act(async () => {
      render(<SettingsWorkspace />);
    });
    expect(document.querySelectorAll(".settings-workspace .workspace-anchors a")).toHaveLength(3);
    expect(document.querySelector(".knowledge-read-page .workspace-anchors")).toBeNull();
    expect(document.querySelectorAll(".knowledge-read-page section")).toHaveLength(3);
    expect(document.querySelector("details")).toBeNull();
    fireEvent.change(screen.getByLabelText("预算来源"), { target: { value: "assistant" } });
    fireEvent.change(screen.getByLabelText("助手读取预算"), { target: { value: "8192" } });
    fireEvent.change(screen.getByLabelText("资料范围"), { target: { value: "selected" } });
    fireEvent.click(screen.getByLabelText("Reference"));
    fireEvent.click(screen.getByLabelText("允许当前助手读取知识库"));
    expect(state().knowledgeReadEditor?.draft).toMatchObject({
      enabled: false,
      context_budget: 8192,
      document_ids: [DOC],
    });
    expect(document.querySelector(".knowledge-planned")?.textContent).toContain("尚未开放");
    expect(
      document.querySelector(".knowledge-planned input, .knowledge-planned select"),
    ).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("保存助手读取配置"));
    });
    expect(dirty()).toBe(false);
  });
  it("失效ID不借用全局资料名称，可直接取消选择", async () => {
    state().patchKnowledgeRead({ scope: "selected", document_ids: [LOST] });
    await act(async () => {
      render(<SettingsWorkspace />);
    });
    expect(screen.getByLabelText(`已失效资料：${LOST}`)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`已失效资料：${LOST}`));
    expect(state().knowledgeReadEditor?.draft.document_ids).toEqual([]);
  });
  it("统一保存先成功的页面不回滚，读取失败重试不重复提交成功页", async () => {
    vi.mocked(client.updateAgent).mockImplementation(async (id, body) => ({
      ...agent(id),
      ...(body as Record<string, unknown>),
      config_version: 2,
    }));
    state().patchPageAgent("basic", { name: "saved-first" });
    state().patchKnowledgeRead({ enabled: false });
    vi.mocked(client.saveAgentKnowledgeRead).mockRejectedValueOnce(new Error("read save failed"));
    state().openChat();
    await state().confirmSaveAndContinue();
    expect(state().page).toBe("settings");
    expect(state().pageEditor?.agent.name).toBe("saved-first");
    expect(dirty()).toBe(true);
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    await state().confirmSaveAndContinue();
    expect(state().page).toBe("chat");
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledTimes(2);
  });
  it("初始读取失败不伪造默认配置，重试才开放编辑", async () => {
    state().discardKnowledgeRead();
    vi.mocked(client.getAgentKnowledgeRead).mockRejectedValueOnce(new Error("read failed"));
    await state().loadKnowledgeRead();
    expect(state().knowledgeReadEditor).toBeNull();
    expect(state().knowledgeReadLoading).toBe(false);
    await state().loadKnowledgeRead();
    expect(state().knowledgeReadEditor?.source.revision).toBe(1);
  });
  it("英文控件提示没有中文残留", async () => {
    selectLocale("en");
    await act(async () => {
      render(<SettingsWorkspace />);
    });
    fireEvent.change(screen.getByLabelText("Budget source"), { target: { value: "assistant" } });
    fireEvent.change(screen.getByLabelText("Document scope"), { target: { value: "selected" } });
    expect(document.body.textContent).not.toMatch(/[\u3400-\u9fff]/);
  });
});
