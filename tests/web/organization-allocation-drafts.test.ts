// 统一上下文分配（0068）组织行辅助分配草稿：局部作用域保存与脏稿保护。
// 初始 RED 只用现有导出与运行时行为：RED 来自行为差异（现实现整份提交模型字段），
// 不来自缺失导入或类型层失败。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalAuxiliaryAllocation } from "../../src/shared/contracts/context-allocation";
import type { OrganizationSettings } from "../../src/shared/contracts/organization";
import { createOrganizationActions } from "../../src/web/features/knowledge/organization-actions";
import { organizationDirty } from "../../src/web/features/knowledge/types";
import type { StoreGet, StoreSet } from "../../src/web/state/types";

type EditorState = {
  organizationEditor: {
    token: object;
    source: OrganizationSettings;
    modelName: string | null;
    visionModelName: string | null;
    transcriptionModelName: string | null;
    auxiliaryAllocation?: GlobalAuxiliaryAllocation;
  } | null;
  allocationInvalidInputs: Record<string, string>;
  settingsSaving: boolean;
  organizationLoading: boolean;
  knowledgeBusy: boolean;
  error?: string | null;
  apiClient: {
    getOrganizationSettings: ReturnType<typeof vi.fn>;
    saveOrganizationSettings: ReturnType<typeof vi.fn>;
  };
};

function harness(source: OrganizationSettings, editorPatch: Record<string, unknown> = {}) {
  const state: EditorState = {
    organizationEditor: {
      token: {},
      source,
      modelName: source.model_name,
      visionModelName: source.vision_model_name,
      transcriptionModelName: source.transcription_model_name,
      ...editorPatch,
    },
    allocationInvalidInputs: {},
    settingsSaving: false,
    organizationLoading: false,
    knowledgeBusy: false,
    error: null,
    apiClient: {
      getOrganizationSettings: vi.fn(),
      saveOrganizationSettings: vi.fn(async (body: Record<string, unknown>) => ({
        ...source,
        ...("auxiliary_allocation" in body
          ? { auxiliary_allocation: body.auxiliary_allocation }
          : {}),
        revision: (body.expected_revision as number) + 1,
      })),
    },
  };
  const set = ((patch: Partial<EditorState>) => {
    Object.assign(state, patch);
  }) as unknown as StoreSet;
  const get = (() => state) as unknown as StoreGet;
  const actions = createOrganizationActions(set, get);
  return { state, actions };
}

const baseSource: OrganizationSettings = {
  model_name: "shared",
  vision_model_name: null,
  transcription_model_name: null,
  revision: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("organization auxiliary allocation drafts", () => {
  it("exposes the allocation draft action", () => {
    const { actions } = harness(baseSource);
    expect("patchOrganizationAllocation" in actions).toBe(true);
  });

  it("saves allocation scope as payload alone while the models draft stays unsubmitted", async () => {
    // 预期接口（先行断言）：编辑器持有 auxiliaryAllocation 草稿 + 一个未保存的模型改动；
    // 作用域保存 allocation 只提交 {auxiliary_allocation, expected_revision}，模型草稿保留。
    const { state, actions } = harness(baseSource, {
      modelName: "UNSAVED",
      auxiliaryAllocation: { knowledge_organize: { mode: "auto" } },
    });
    expect(
      await (
        actions as { saveOrganization: (scope?: string) => Promise<boolean> }
      ).saveOrganization("allocation"),
    ).toBe(true);
    expect(state.apiClient.saveOrganizationSettings).toHaveBeenCalledWith({
      auxiliary_allocation: { knowledge_organize: { mode: "auto" } },
      expected_revision: 1,
    });
    // 模型草稿未被夹带，也未因分配保存被重置。
    expect(state.organizationEditor?.modelName).toBe("UNSAVED");
  });

  it("saves models scope without touching or losing the auxiliary draft", async () => {
    const { state, actions } = harness(baseSource, {
      modelName: "UNSAVED",
      auxiliaryAllocation: { knowledge_organize: { mode: "auto" } },
    });
    expect(await actions.saveOrganization("models")).toBe(true);
    // 模型作用域：整份模型载荷，不带分配组。
    expect(state.apiClient.saveOrganizationSettings).toHaveBeenCalledWith({
      model_name: "UNSAVED",
      vision_model_name: null,
      transcription_model_name: null,
      expected_revision: 1,
    });
    // 分配草稿未提交、未丢失；已存修订推进到共享基线。
    const editor = state.organizationEditor!;
    expect(editor.auxiliaryAllocation).toEqual({ knowledge_organize: { mode: "auto" } });
    expect(organizationDirty(editor, "allocation")).toBe(true);
    expect(organizationDirty(editor, "models")).toBe(false);
    expect(editor.source.revision).toBe(2);
  });

  it("keeps both drafts on a CAS conflict and does not report success", async () => {
    const { state, actions } = harness(baseSource, {
      modelName: "UNSAVED",
      auxiliaryAllocation: { knowledge_organize: { mode: "auto" } },
    });
    state.apiClient.saveOrganizationSettings.mockRejectedValueOnce(new Error("revision conflict"));
    expect(await actions.saveOrganization("all")).toBe(false);
    expect(state.apiClient.saveOrganizationSettings).toHaveBeenCalledWith({
      model_name: "UNSAVED",
      vision_model_name: null,
      transcription_model_name: null,
      auxiliary_allocation: { knowledge_organize: { mode: "auto" } },
      expected_revision: 1,
    });
    // 冲突：草稿原样保留，基线不推进，不伪装保存成功。
    const editor = state.organizationEditor!;
    expect(editor.modelName).toBe("UNSAVED");
    expect(editor.auxiliaryAllocation).toEqual({ knowledge_organize: { mode: "auto" } });
    expect(editor.source.revision).toBe(1);
    expect(state.error).toBe("revision conflict");
  });
});
