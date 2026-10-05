// 全局知识库预算的归属专测：预算只在「系统能力 → 知识查询」页保存与丢弃，
// 与模型/自动整理、资料设置、读取规则各自持稿互不夹带；CAS 冲突保稿，刷新后按新修订重试。
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeSettings,
  KnowledgeSettingsUpdate,
} from "../../src/shared/contracts/knowledge";
import { ApiError, type api } from "../../src/web/api";
import { knowledgeModelDirty } from "../../src/web/features/knowledge/types";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import { KnowledgeToolSettings } from "../../src/web/screens/assistants/ResourceRules";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { B, setupLibrary } from "./helpers/library-fixture";

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
    ...overrides,
  };
}

const budgetInput = () =>
  screen.getByLabelText(label("library.workspace.knowledge.budget.tokens")) as HTMLInputElement;
const budgetSave = () =>
  screen.getByRole("button", { name: label("library.save.knowledge.budget") }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("知识查询页的全局默认预算", () => {
  it("预算保存只提交预算字段：模型/自动整理草稿与读取、维护保存都不受牵动", async () => {
    const client = setupLibrary(settingsMocks());
    await act(async () => render(<KnowledgeToolSettings />));
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
    expect(store.getState().knowledgeReadEditor?.globalBudget).toBe(4096);
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
    await act(async () => render(<KnowledgeToolSettings />));
    fireEvent.change(budgetInput(), { target: { value: "3000" } });
    await act(async () => fireEvent.click(budgetSave()));
    // 冲突：草稿保留，提示就地可见，基线未被推进。
    expect(screen.getByRole("alert").textContent).toContain("冲突后请核对最新值再保存");
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
        screen.getByRole("button", { name: label("capabilities.resources.refreshBaseline") }),
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
    await store.getState().loadKnowledgeModel();
    await store.getState().openKnowledgeEditor({ kind: "settings" });
    const sheet = store.getState().knowledgeEditor;
    if (sheet?.kind !== "settings") throw new Error("Missing settings editor");
    store.getState().updateKnowledgeEditor({ ...sheet, auto_enabled: false });
    expect(await store.getState().saveKnowledgeEditor()).toBe(false);
    // 冲突后草稿仍在，重试按同一修订成功并关闭。
    expect(store.getState().error).not.toBeNull();
    const kept = store.getState().knowledgeEditor;
    expect(kept?.kind).toBe("settings");
    expect(kept?.kind === "settings" ? kept.auto_enabled : true).toBe(false);
    expect(store.getState().knowledgeDirty).toBe(true);
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 1,
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
    await act(async () => render(<KnowledgeToolSettings />));
    act(() => store.getState().patchKnowledgeModel("draft-model"));
    fireEvent.change(budgetInput(), { target: { value: "7777" } });
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(7777);
    fireEvent.click(
      screen.getByRole("button", { name: label("library.discard.knowledge.budget") }),
    );
    const editor = store.getState().knowledgeModelEditor;
    expect(editor).not.toBeNull();
    expect(editor?.contextBudget).toBe(editor?.source.context_budget);
    expect(editor?.modelName).toBe("draft-model");
    expect(budgetInput().value).toBe("2048");
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
  });

  it("资料设置面板里预算只读显示已存上限，直达知识查询页不改草稿", async () => {
    const client = setupLibrary({ saveKnowledgeSettings: vi.fn() });
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: label("library.organization.workspace.budget") }),
      ),
    );
    const sheet = document.querySelector('[data-slot="sheet-content"]');
    if (!(sheet instanceof HTMLElement)) throw new Error("Missing settings sheet");
    // 预算不再由资料设置持有编辑：只读显示已存上限。
    const budget = within(sheet).getByLabelText(
      label("library.workspace.knowledge.budget.tokens"),
    ) as HTMLInputElement;
    expect(budget.disabled).toBe(true);
    expect(budget.value).toBe("2048");
    // 直达知识查询页：不隐式保存，草稿安全。
    fireEvent.click(
      within(sheet).getByRole("button", {
        name: label("capabilities.resources.openKnowledgeTools"),
      }),
    );
    expect(store.getState().settingsRoute).toBe("knowledge-tools");
    expect(store.getState().knowledgeEditor?.kind).toBe("settings");
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
  });
});
