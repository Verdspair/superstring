// 全局知识库预算的归属专测（授权搬迁后）：预算编辑器已移到统一上下文分配页的「资料读取」用途，
// 旧知识查询页只保留只读摘要与跳转。保存/丢弃/CAS 冲突保稿仍按同一 knowledgeModelEditor 真源，
// 与模型/自动整理、资料设置、读取规则各自持稿互不夹带；刷新保存基线后按新修订重试。
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeSettings,
  KnowledgeSettingsUpdate,
} from "../../src/shared/contracts/knowledge";
import { ApiError, type api } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";

const resetContextAllocationTarget = () =>
  store.setState({
    contextAllocationTarget: {
      purpose: "assistant",
      agentId: null,
      schemeId: null,
      bindingId: null,
      returnRoute: null,
      returnLabel: null,
    },
  });
const setContextAllocationTarget = (
  target: Partial<import("../../src/web/features/context-allocation").ContextAllocationTarget>,
) =>
  store.setState((state) => ({
    contextAllocationTarget: { ...state.contextAllocationTarget, ...target },
  }));

import { knowledgeModelDirty } from "../../src/web/features/knowledge/types";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import { AgentMaterials } from "../../src/web/screens/assistants/AgentMaterials";

import { ModelPurposes } from "../../src/web/screens/environment/ModelPurposes";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { B, setupLibrary } from "./helpers/library-fixture";

/** 显式 tooltip（保存按钮/字段帮助）必须挂在真实 DesignSystemProvider 下渲染。 */
const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

const zhText = zh as Record<string, string>;
/** 本地键可能晚于 locales 文件落地：缺失时 i18next 原样返回 key。 */
const label = (key: string) => zhText[key] ?? key;

/** 服务端替身：接受提交字段并推进修订，模拟共享基线前进。 */
function settingsMocks(overrides: Partial<typeof api> = {}) {
  return {
    saveKnowledgeSettings: vi.fn(
      async (body: KnowledgeSettingsUpdate): Promise<KnowledgeSettings> => {
        const { expected_revision, ...rest } = body;
        return { ...rest, revision: expected_revision + 1 };
      },
    ),
    saveAgentKnowledgeRead: vi.fn(),
    updateAgent: vi.fn(),
    updatePolicy: vi.fn(),
    // 统一页会读模型总容量：替身保证不产生任何真实请求。
    getModelCapacity: vi.fn().mockResolvedValue({
      model: "model-a",
      status: "loaded",
      context_length: 128000,
    }),
    ...overrides,
  };
}

// 搬迁后的统一页入口：进入「资料读取」用途后渲染统一工作区，预算编辑只在这里发生。
async function renderAllocationReading() {
  setContextAllocationTarget({ purpose: "reading", agentId: B });
  await act(async () => render(<ModelPurposes active={true} />));
}
const budgetInput = () =>
  screen.getByTestId("reading-knowledge-global-budget-input") as HTMLInputElement;
const budgetSave = () =>
  screen.getByRole("button", {
    name: label("schemes.allocation.reading.saveKnowledgeGlobal"),
  }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetContextAllocationTarget();
});

describe("知识设置关闭守卫", () => {
  async function openSettings(overrides: Partial<typeof api> = {}) {
    const client = setupLibrary(settingsMocks(overrides));
    await store.getState().openKnowledgeEditor({ kind: "settings" });
    await store.getState().loadKnowledgeModel();
    await store.getState().loadOrganization();
    return client;
  }

  it("取消保留子草稿；放弃只清知识设置，不清其他模型与QQ无效稿", async () => {
    const client = await openSettings();
    store.getState().patchKnowledgeModel("draft-model");
    store.getState().patchKnowledgeGlobal({ contextBudget: 4096 });
    store.getState().patchOrganization("unrelated-default");
    store.setState({
      knowledgeModelError: {
        model: "model failure",
        budget: "budget failure",
        shared: "read failure",
      },
      allocationInvalidInputs: {
        "global:knowledge": "bad",
        "global:aux:qq_media_describe_input_limit": "qq-bad",
      },
    });
    store.getState().requestKnowledgeEditor({ kind: "none" });
    expect(store.getState().navigationConfirmOpen).toBe(true);
    store.getState().cancelPendingNavigation();
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("draft-model");
    expect(store.getState().allocationInvalidInputs["global:knowledge"]).toBe("bad");
    store.getState().requestKnowledgeEditor({ kind: "none" });
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().knowledgeEditor).toBeNull();
    expect(store.getState().knowledgeModelEditor?.modelName).toBeNull();
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(2048);
    expect(store.getState().knowledgeModelError).toEqual({
      model: null,
      budget: null,
      shared: "read failure",
    });
    expect(store.getState().organizationEditor?.modelName).toBe("unrelated-default");
    expect(store.getState().allocationInvalidInputs).toEqual({
      "global:aux:qq_media_describe_input_limit": "qq-bad",
    });
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
  });

  it("关闭前保存按知识作用域推进CAS，不写无关模型或QQ草稿", async () => {
    const saveOrg = vi.fn(async (body) => ({
      revision: body.expected_revision + 1,
      model_name: "default-model",
      vision_model_name: null,
      transcription_model_name: null,
      auxiliary_allocation: body.auxiliary_allocation,
    }));
    const client = await openSettings({ saveOrganizationSettings: saveOrg });
    store.getState().patchKnowledgeModel("draft-model");
    store.getState().patchKnowledgeGlobal({ contextBudget: 4096 });
    store.getState().patchOrganization("unrelated-default");
    store.getState().patchOrganizationAllocation({
      knowledge_organize: { mode: "auto", input_limit: 8000, output_reserved: 2048 },
    });
    store.setState({
      allocationInvalidInputs: { "global:aux:qq_media_describe_input_limit": "qq-bad" },
    });
    store.getState().requestKnowledgeEditor({ kind: "none" });
    await store.getState().confirmSaveAndContinue();
    expect(client.saveKnowledgeSettings).toHaveBeenNthCalledWith(1, {
      expected_revision: 1,
      auto_enabled: true,
      model_name: "draft-model",
      context_budget: 2048,
    });
    expect(client.saveKnowledgeSettings).toHaveBeenNthCalledWith(2, {
      expected_revision: 2,
      auto_enabled: true,
      model_name: "draft-model",
      context_budget: 4096,
    });
    expect(saveOrg).toHaveBeenCalledExactlyOnceWith({
      expected_revision: 1,
      auxiliary_allocation: {
        knowledge_organize: { mode: "auto", input_limit: 8000, output_reserved: 2048 },
      },
    });
    expect(store.getState().organizationEditor?.modelName).toBe("unrelated-default");
    expect(
      store.getState().allocationInvalidInputs["global:aux:qq_media_describe_input_limit"],
    ).toBe("qq-bad");
    expect(store.getState().knowledgeEditor).toBeNull();
    expect(store.getState().navigationConfirmOpen).toBe(false);
  });

  it("部分保存失败保留未成功预算、弹窗和已成功模型基线", async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({
        revision: 2,
        auto_enabled: true,
        model_name: "draft-model",
        context_budget: 2048,
      })
      .mockRejectedValueOnce(new ApiError(409, "KNOWLEDGE_SETTINGS_CONFLICT", "conflict"));
    await openSettings({ saveKnowledgeSettings: save });
    store.getState().patchKnowledgeModel("draft-model");
    store.getState().patchKnowledgeGlobal({ contextBudget: 4096 });
    store.getState().requestKnowledgeEditor({ kind: "none" });
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().knowledgeEditor?.kind).toBe("settings");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(2);
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "model")).toBe(false);
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "budget")).toBe(true);
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(4096);
    expect(save).toHaveBeenCalledTimes(2);
    save.mockResolvedValueOnce({
      revision: 3,
      auto_enabled: true,
      model_name: "draft-model",
      context_budget: 4096,
    });
    await store.getState().confirmSaveAndContinue();
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenLastCalledWith({
      expected_revision: 2,
      auto_enabled: true,
      model_name: "draft-model",
      context_budget: 4096,
    });
    expect(store.getState().knowledgeEditor).toBeNull();
  });

  it("自动整理单独保存后，仍有子预算草稿则保持面板打开", async () => {
    const client = await openSettings();
    store.getState().patchKnowledgeGlobal({ contextBudget: 4096 });
    const editor = store.getState().knowledgeEditor;
    if (editor?.kind !== "settings") throw new Error("Missing settings editor");
    store.getState().updateKnowledgeEditor({ ...editor, auto_enabled: false });
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenCalledExactlyOnceWith({
      expected_revision: 1,
      auto_enabled: false,
      model_name: null,
      context_budget: 2048,
    });
    expect(store.getState().knowledgeEditor?.kind).toBe("settings");
    expect(store.getState().knowledgeDirty).toBe(false);
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(4096);
    store.getState().requestKnowledgeEditor({ kind: "none" });
    expect(store.getState().navigationConfirmOpen).toBe(true);
  });

  it("无效知识预算阻止保存和关闭且保留原始文本", async () => {
    const client = await openSettings();
    store.setState({ allocationInvalidInputs: { "global:knowledge": "bad" } });
    store.getState().requestKnowledgeEditor({ kind: "none" });
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().knowledgeEditor?.kind).toBe("settings");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().allocationInvalidInputs["global:knowledge"]).toBe("bad");
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
  });
});

describe("知识查询页的全局默认预算", () => {
  it("预算保存只提交预算字段：模型/自动整理草稿与读取、维护保存都不受牵动", async () => {
    const client = setupLibrary(settingsMocks());
    await renderAllocationReading();
    // 预置默认模型页与整理规则页的草稿：不归本页预算保存所有。
    act(() => {
      store.getState().patchKnowledgeModel("draft-model");
      store.getState().patchKnowledgeGlobal({ autoEnabled: false });
    });
    expect(budgetInput().value).toBe("2048");
    expect(budgetSave().disabled).toBe(true);
    fireEvent.change(budgetInput(), { target: { value: "4096" } });
    expect(budgetSave().disabled).toBe(false);
    await act(async () => fireEvent.click(budgetSave()));
    // 只提交预算：模型名与自动整理取已存基线，不夹带各自草稿。
    expect(client.saveKnowledgeSettings).toHaveBeenCalledTimes(1);
    expect(client.saveKnowledgeSettings).toHaveBeenCalledWith({
      expected_revision: 1,
      auto_enabled: true,
      model_name: null,
      context_budget: 4096,
    });
    // 接受基线只推进预算：模型与自动整理草稿留在编辑器里，等各自页面保存。
    const editor = store.getState().knowledgeModelEditor;
    expect(editor?.contextBudget).toBe(4096);
    expect(editor?.modelName).toBe("draft-model");
    expect(editor?.autoEnabled).toBe(false);
    expect(knowledgeModelDirty(editor, "budget")).toBe(false);
    expect(knowledgeModelDirty(editor, "model")).toBe(true);
    expect(knowledgeModelDirty(editor, "rules")).toBe(true);
    // 读取规则未保存；资料维护（agent/policy）也未被牵动。
    expect(client.saveAgentKnowledgeRead).not.toHaveBeenCalled();
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(client.updatePolicy).not.toHaveBeenCalled();
    // 本页只编辑共享知识基线；读取编辑器未加载时不隐式创建或改写读取草稿。
    expect(store.getState().knowledgeReadEditor).toBeNull();
    // 再改预算草稿：模型页保存（scope model）只提交模型，不带预算草稿。
    fireEvent.change(budgetInput(), { target: { value: "8192" } });
    expect(await store.getState().saveKnowledgeModel("model")).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 2,
      auto_enabled: true,
      model_name: "draft-model",
      context_budget: 4096,
    });
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(8192);
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "budget")).toBe(true);
    expect(budgetInput().value).toBe("8192");
  });

  it("预算 409 保留草稿；刷新保存基线后按新修订重试推进", async () => {
    const client = setupLibrary({
      ...settingsMocks(),
      saveKnowledgeSettings: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "revision conflict"),
        )
        .mockImplementation(async (body: KnowledgeSettingsUpdate): Promise<KnowledgeSettings> => {
          const { expected_revision, ...rest } = body;
          return { ...rest, revision: expected_revision + 1 };
        }),
    });
    await renderAllocationReading();
    fireEvent.change(budgetInput(), { target: { value: "3000" } });
    await act(async () => fireEvent.click(budgetSave()));
    // 冲突：草稿保留，提示就地可见，基线未被推进。
    expect(screen.getByRole("alert").textContent).toContain("冲突后请核对最新值再保存");
    expect(store.getState().knowledgeModelError.budget).toBeTruthy();
    expect(budgetInput().value).toBe("3000");
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "budget")).toBe(true);
    expect(store.getState().knowledgeSettings?.revision).toBe(1);
    // 刷新保存基线：接受新修订，预算草稿不被提交也不被回退。
    vi.mocked(client.getKnowledgeSettings).mockResolvedValue({
      revision: 5,
      auto_enabled: true,
      model_name: null,
      context_budget: 5000,
    });
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId("reading-section-knowledge-global")).getByRole("button", {
          name: label("capabilities.resources.refreshBaseline"),
        }),
      ),
    );
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(5);
    expect(budgetInput().value).toBe("3000");
    // 重试：按 revision 5 提交草稿并接受基线。
    await act(async () => fireEvent.click(budgetSave()));
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 5,
      auto_enabled: true,
      model_name: null,
      context_budget: 3000,
    });
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(6);
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "budget")).toBe(false);
  });

  it("分步保存按同一共享修订推进：预算→模型→预算，各步只提交自己的字段", async () => {
    const client = setupLibrary(settingsMocks());
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeGlobal({ contextBudget: 4096 });
    expect(await store.getState().saveKnowledgeModel("budget")).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 1,
      auto_enabled: true,
      model_name: null,
      context_budget: 4096,
    });
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor)).toBe(false);
    store.getState().patchKnowledgeModel("next-model");
    expect(await store.getState().saveKnowledgeModel("model")).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 2,
      auto_enabled: true,
      model_name: "next-model",
      context_budget: 4096,
    });
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "model")).toBe(false);
    store.getState().patchKnowledgeGlobal({ contextBudget: 8192 });
    expect(await store.getState().saveKnowledgeModel("budget")).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 3,
      auto_enabled: true,
      model_name: "next-model",
      context_budget: 8192,
    });
    const editor = store.getState().knowledgeModelEditor;
    expect(editor?.source.revision).toBe(4);
    expect(knowledgeModelDirty(editor)).toBe(false);
  });

  it("跨助手切换保留全局预算草稿，保存仍按共享基线提交", async () => {
    const client = setupLibrary(settingsMocks());
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeGlobal({ contextBudget: 9999 });
    await store.getState().editAgent(B);
    // 全局预算跟页不跟人：切换助手不清空、不回落。
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(9999);
    expect(store.getState().editorAgentId).toBe(B);
    expect(await store.getState().saveKnowledgeModel("budget")).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 1,
      auto_enabled: true,
      model_name: null,
      context_budget: 9999,
    });
  });
});

describe("整组及规则保存的错误归属", () => {
  it.each(["all", "rules"] as const)("%s 成功只清本次提交范围，保留其他草稿", async (scope) => {
    const client = setupLibrary(settingsMocks());
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("draft-model");
    store.getState().patchKnowledgeGlobal({ contextBudget: 4096, autoEnabled: false });
    store.setState({
      knowledgeModelError: {
        model: "model failure",
        budget: "budget failure",
        shared: "read failure",
      },
    });
    expect(await store.getState().saveKnowledgeModel(scope)).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenCalledExactlyOnceWith({
      expected_revision: 1,
      model_name: scope === "all" ? "draft-model" : null,
      auto_enabled: false,
      context_budget: 4096,
    });
    expect(store.getState().knowledgeModelError).toEqual({
      model: scope === "all" ? null : "model failure",
      budget: null,
      shared: null,
    });
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("draft-model");
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "model")).toBe(
      scope === "rules",
    );
  });
});

describe("资料设置页对全局预算只读与合并保存", () => {
  it("保存从最新共享基线合并预算与模型，不提交陈旧副本，也不夹带模型草稿", async () => {
    const client = setupLibrary(settingsMocks());
    await store.getState().loadKnowledgeModel();
    // 资料设置拿到自己的副本（rev1/2048）。
    await store.getState().openKnowledgeEditor({ kind: "settings" });
    store.getState().patchKnowledgeModel("draft-model");
    // 另一处刚保存了新预算：共享基线推进到 rev2/4096，副本里的 2048 已是陈旧值。
    store.getState().patchKnowledgeGlobal({ contextBudget: 4096 });
    expect(await store.getState().saveKnowledgeModel("budget")).toBe(true);
    const sheet = store.getState().knowledgeEditor;
    if (sheet?.kind !== "settings") throw new Error("Missing settings editor");
    store.getState().updateKnowledgeEditor({ ...sheet, auto_enabled: false });
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenCalledTimes(2);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 2,
      auto_enabled: false,
      model_name: null,
      context_budget: 4096,
    });
    // 模型草稿既不被设置保存提交，也不被清空。
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("draft-model");
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "model")).toBe(true);
  });

  it("资料设置保存 409 保留草稿，重试成功后才关闭", async () => {
    const client = setupLibrary({
      ...settingsMocks(),
      saveKnowledgeSettings: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "revision conflict"),
        )
        .mockImplementation(async (body: KnowledgeSettingsUpdate): Promise<KnowledgeSettings> => {
          const { expected_revision, ...rest } = body;
          return { ...rest, revision: expected_revision + 1 };
        }),
    });
    await act(async () => render(<KnowledgeLibrary />));
    await store.getState().loadKnowledgeModel();
    await act(async () => {
      await store.getState().openKnowledgeEditor({ kind: "settings" });
    });
    const sheet = store.getState().knowledgeEditor;
    if (sheet?.kind !== "settings") throw new Error("Missing settings editor");
    act(() => store.getState().updateKnowledgeEditor({ ...sheet, auto_enabled: false }));
    await act(async () => {
      expect(await store.getState().saveKnowledgeEditor()).toBe(false);
    });
    // 冲突保留资料草稿；显示本地化提示，显式刷新后再使用新修订重试。
    const sheetDialog = screen.getByRole("dialog");
    expect(within(sheetDialog).getByRole("alert").textContent).toBe(
      store.getState().knowledgeLibraryError,
    );
    expect(store.getState().knowledgeLibraryError).toContain("请刷新并核对后重试");
    const kept = store.getState().knowledgeEditor;
    expect(kept?.kind).toBe("settings");
    expect(kept?.kind === "settings" ? kept.auto_enabled : true).toBe(false);
    expect(store.getState().knowledgeDirty).toBe(true);
    vi.mocked(client.getKnowledgeSettings).mockResolvedValue({
      revision: 5,
      auto_enabled: true,
      model_name: null,
      context_budget: 2048,
    });
    await act(async () => {
      await store.getState().loadKnowledgeModel(true);
    });
    await act(async () => {
      expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    });
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 5,
      auto_enabled: false,
      model_name: null,
      context_budget: 2048,
    });
    expect(store.getState().knowledgeEditor).toBeNull();
    expect(store.getState().knowledgeDirty).toBe(false);
  });
});

describe("预算分组的独立丢弃与资料面板只读入口", () => {
  it("预算丢弃只还原预算字段，不清空编辑器，模型草稿保留", async () => {
    const client = setupLibrary(settingsMocks());
    await renderAllocationReading();
    act(() => store.getState().patchKnowledgeModel("draft-model"));
    fireEvent.change(budgetInput(), { target: { value: "7777" } });
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(7777);
    fireEvent.click(
      within(screen.getByTestId("reading-section-knowledge-global")).getByRole("button", {
        name: label("library.discard.knowledge.budget"),
      }),
    );
    const editor = store.getState().knowledgeModelEditor;
    expect(editor).not.toBeNull();
    expect(editor?.contextBudget).toBe(editor?.source.context_budget);
    expect(editor?.modelName).toBe("draft-model");
    expect(budgetInput().value).toBe("2048");
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
  });

  it("知识设置内联编辑全局预算，不隐式保存其他分组", async () => {
    const client = setupLibrary(settingsMocks());
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: label("library.organization.workspace.budget") }),
      ),
    );
    const sheet = screen.getByRole("dialog");
    const budget = within(sheet).getByTestId(
      "reading-knowledge-global-budget-input",
    ) as HTMLInputElement;
    expect(budget.disabled).toBe(false);
    expect(budget.value).toBe("2048");
    fireEvent.change(budget, { target: { value: "4096" } });
    expect(within(sheet).getByText(label("library.unsaved.changes"))).toBeTruthy();
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(
        within(sheet).getByRole("button", {
          name: label("schemes.allocation.reading.saveKnowledgeGlobal"),
        }),
      ),
    );
    expect(client.saveKnowledgeSettings).toHaveBeenCalledExactlyOnceWith({
      expected_revision: 1,
      auto_enabled: true,
      model_name: null,
      context_budget: 4096,
    });
    expect(store.getState().knowledgeEditor?.kind).toBe("settings");
  });

  it("模型和预算各自失败时保留各自错误，单独成功不清另一项", async () => {
    const client = setupLibrary(
      settingsMocks({
        saveKnowledgeSettings: vi
          .fn()
          .mockRejectedValueOnce(new Error("model failure"))
          .mockRejectedValueOnce(new Error("budget failure"))
          .mockImplementation(async (body: KnowledgeSettingsUpdate) => ({
            revision: body.expected_revision + 1,
            auto_enabled: body.auto_enabled,
            model_name: body.model_name,
            context_budget: body.context_budget,
          })),
      }),
    );
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("draft-model");
    store.getState().patchKnowledgeGlobal({ contextBudget: 3000 });
    expect(await store.getState().saveKnowledgeModel("model")).toBe(false);
    expect(await store.getState().saveKnowledgeModel("budget")).toBe(false);
    expect(store.getState().knowledgeModelError.model).toContain("model failure");
    expect(store.getState().knowledgeModelError.budget).toContain("budget failure");
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: label("library.organization.workspace.budget") }),
      );
    });
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("model failure").getAttribute("role")).toBe("alert");
    expect(within(sheet).getByText("budget failure").getAttribute("role")).toBe("alert");
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("draft-model");
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(3000);
    expect(await store.getState().saveKnowledgeModel("budget")).toBe(true);
    expect(store.getState().knowledgeModelError.model).toContain("model failure");
    expect(store.getState().knowledgeModelError.budget).toBeNull();
    expect(client.saveKnowledgeSettings).toHaveBeenCalledTimes(3);
  });

  it("放弃预算只清预算错误，切换 API 后旧错误不进入新客户端", async () => {
    setupLibrary(settingsMocks());
    await store.getState().loadKnowledgeModel();
    store.setState({
      knowledgeModelError: { model: "old model", budget: "old budget", shared: "old read" },
    });
    store.getState().discardKnowledgeModel("budget");
    expect(store.getState().knowledgeModelError).toEqual({
      model: "old model",
      budget: null,
      shared: "old read",
    });
    const oldApi = store.getState().apiClient;
    store.setState({
      apiClient: {
        ...oldApi,
        getKnowledgeSettings: vi.fn().mockResolvedValue({
          revision: 7,
          auto_enabled: true,
          model_name: null,
          context_budget: 2048,
        }),
      },
    });
    await store.getState().loadKnowledgeModel();
    expect(store.getState().knowledgeModelError).toEqual({
      model: null,
      budget: null,
      shared: null,
    });
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(7);
  });

  it("知识设置中共享读取失败只公告一次且保留各组错误", async () => {
    setupLibrary(settingsMocks());
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: label("library.organization.workspace.budget") }),
      );
    });
    act(() =>
      store.setState({
        knowledgeModelError: {
          model: "model failure",
          budget: "budget failure",
          shared: "read failure",
        },
      }),
    );
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("model failure").getAttribute("role")).toBe("alert");
    expect(within(sheet).getByText("budget failure").getAttribute("role")).toBe("alert");
    expect(within(sheet).getByText("read failure").getAttribute("role")).toBe("alert");
  });

  it("模型保存冲突只显示在模型分组，并保留预算草稿", async () => {
    const client = setupLibrary(
      settingsMocks({
        saveKnowledgeSettings: vi
          .fn()
          .mockRejectedValueOnce(
            new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "revision conflict"),
          ),
      }),
    );
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: label("library.organization.workspace.budget") }),
      );
    });
    const sheet = screen.getByRole("dialog");
    act(() => {
      store.getState().patchKnowledgeGlobal({ contextBudget: 3000 });
      store.getState().patchKnowledgeModel("draft-model");
    });
    await act(async () => {
      fireEvent.click(
        within(sheet).getByRole("button", { name: label("models.saveKnowledgeModel") }),
      );
    });
    expect(within(sheet).getByRole("alert").textContent).toContain("冲突后请核对最新值再保存");
    expect(store.getState().knowledgeModelError.model).toBeTruthy();
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(3000);
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("draft-model");
    expect(client.saveKnowledgeSettings).toHaveBeenCalledTimes(1);
  });

  it("知识设置中的预算冲突可见且保稿，刷新后按新版本重试", async () => {
    const client = setupLibrary(
      settingsMocks({
        saveKnowledgeSettings: vi
          .fn()
          .mockRejectedValueOnce(
            new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "revision conflict"),
          )
          .mockImplementation(async (body: KnowledgeSettingsUpdate) => ({
            revision: body.expected_revision + 1,
            auto_enabled: body.auto_enabled,
            model_name: body.model_name,
            context_budget: body.context_budget,
          })),
      }),
    );
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: label("library.organization.workspace.budget") }),
      ),
    );
    const sheet = screen.getByRole("dialog");
    const budget = within(sheet).getByTestId(
      "reading-knowledge-global-budget-input",
    ) as HTMLInputElement;
    fireEvent.change(budget, { target: { value: "3000" } });
    await act(async () =>
      fireEvent.click(
        within(sheet).getByRole("button", {
          name: label("schemes.allocation.reading.saveKnowledgeGlobal"),
        }),
      ),
    );
    expect(within(sheet).getByRole("alert").textContent).toContain("冲突后请核对最新值再保存");
    expect(store.getState().knowledgeModelError.budget).toBeTruthy();
    expect(budget.value).toBe("3000");
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(1);
    vi.mocked(client.getKnowledgeSettings).mockResolvedValue({
      revision: 5,
      auto_enabled: true,
      model_name: null,
      context_budget: 5000,
    });
    await act(async () =>
      fireEvent.click(
        within(sheet).getByRole("button", {
          name: label("capabilities.resources.refreshBaseline"),
        }),
      ),
    );
    expect(budget.value).toBe("3000");
    await act(async () =>
      fireEvent.click(
        within(sheet).getByRole("button", {
          name: label("schemes.allocation.reading.saveKnowledgeGlobal"),
        }),
      ),
    );
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 5,
      auto_enabled: true,
      model_name: null,
      context_budget: 3000,
    });
  });

  it("资料任务显示已保存全局预算，跳转编辑不隐式保存草稿", async () => {
    const client = setupLibrary(settingsMocks());
    await act(async () => render(<AgentMaterials />));
    await waitFor(() => expect(screen.getByText(/已保存的全局读取额度：2048 Bytes/)).toBeTruthy());
    expect(
      screen.queryByRole("button", { name: label("library.save.knowledge.budget") }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: label("library.discard.knowledge.budget") }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: label("library.knowledge.global.budget") }));
    await waitFor(() => expect(store.getState().settingsRoute).toBe("context-allocation"));
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
    expect(store.getState().knowledgeSettings?.context_budget).toBe(2048);
    expect(store.getState().knowledgeModelEditor).toBeNull();
  });
});
