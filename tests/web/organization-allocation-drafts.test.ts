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
        ...state.organizationEditor?.source,
        ...("model_name" in body ? { model_name: body.model_name } : {}),
        ...("vision_model_name" in body ? { vision_model_name: body.vision_model_name } : {}),
        ...("transcription_model_name" in body
          ? { transcription_model_name: body.transcription_model_name }
          : {}),
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

  it("saves selected role overlaying baseline while unselected role draft stays preserved", async () => {
    const sourceWithBoth: OrganizationSettings = {
      ...baseSource,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed", input_limit: 1000 },
        qq_sticker_annotate: { mode: "fixed", input_limit: 500 },
      },
      revision: 1,
    };
    const { state, actions } = harness(sourceWithBoth, {
      auxiliaryAllocation: {
        knowledge_organize: { mode: "auto", input_limit: 2000 },
        qq_sticker_annotate: { mode: "auto", input_limit: 999 },
      },
    });

    // 仅保存 knowledge_organize
    expect(await actions.saveOrganization("allocation", ["knowledge_organize"])).toBe(true);

    // 载荷中只有 knowledge_organize 叠加了草稿，qq_sticker_annotate 严格保持 baseline
    expect(state.apiClient.saveOrganizationSettings).toHaveBeenCalledWith({
      auxiliary_allocation: {
        knowledge_organize: { mode: "auto", input_limit: 2000 },
        qq_sticker_annotate: { mode: "fixed", input_limit: 500 },
      },
      expected_revision: 1,
    });

    const editor = state.organizationEditor!;
    // revision 推进到 2
    expect(editor.source.revision).toBe(2);
    // knowledge_organize 接受已保存值，qq_sticker_annotate 未选草稿依然保留
    expect(editor.auxiliaryAllocation?.knowledge_organize).toEqual({
      mode: "auto",
      input_limit: 2000,
    });
    expect(editor.auxiliaryAllocation?.qq_sticker_annotate).toEqual({
      mode: "auto",
      input_limit: 999,
    });

    // dirty 状态隔离
    expect(organizationDirty(editor, "allocation", ["knowledge_organize"])).toBe(false);
    expect(organizationDirty(editor, "allocation", ["qq_sticker_annotate"])).toBe(true);
  });

  it("deletes a cleared role from payload instead of passing null", async () => {
    const sourceWithRole: OrganizationSettings = {
      ...baseSource,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed" },
        qq_sticker_annotate: { mode: "fixed" },
      },
      revision: 1,
    };
    const { state, actions } = harness(sourceWithRole, {
      auxiliaryAllocation: {
        // knowledge_organize 被清空/删除，未出现在对象中
        qq_sticker_annotate: { mode: "auto" },
      },
    });

    expect(await actions.saveOrganization("allocation", ["knowledge_organize"])).toBe(true);

    // 载荷中从对象 delete 该 role，绝非传递 null
    expect(state.apiClient.saveOrganizationSettings).toHaveBeenCalledWith({
      auxiliary_allocation: {
        qq_sticker_annotate: { mode: "fixed" },
      },
      expected_revision: 1,
    });

    const editor = state.organizationEditor!;
    expect(editor.auxiliaryAllocation?.knowledge_organize).toBeUndefined();
    expect(organizationDirty(editor, "allocation", ["knowledge_organize"])).toBe(false);
  });

  it("allows saving selected role when unselected role has invalid input, but blocks when selected role is invalid", async () => {
    const { state, actions } = harness(baseSource, {
      auxiliaryAllocation: {
        knowledge_organize: { mode: "auto" },
        qq_sticker_annotate: { mode: "fixed" },
      },
    });

    // 存在未选角色 qq_sticker_annotate 的非法输入 (真实 host key 格式带下划线)
    state.allocationInvalidInputs = {
      "global:aux:qq_sticker_annotate_input_limit": "abc-invalid",
    };

    // 保存 knowledge_organize 不受未选角色非法输入阻塞
    expect(await actions.saveOrganization("allocation", ["knowledge_organize"])).toBe(true);
    expect(state.error).toBeNull();
    // 未选角色的非法输入依然保留
    expect(state.allocationInvalidInputs["global:aux:qq_sticker_annotate_input_limit"]).toBe(
      "abc-invalid",
    );

    // 尝试保存包含非法输入的目标角色，被立即拦截
    expect(await actions.saveOrganization("allocation", ["qq_sticker_annotate"])).toBe(false);
    expect(state.error).toBe("请先修正方案中的无效数字，再保存。");
  });

  it("advances revision on same editor allowing sequential saves without 409", async () => {
    const { state, actions } = harness(baseSource, {
      auxiliaryAllocation: {
        knowledge_organize: { mode: "auto" },
        qq_sticker_annotate: { mode: "fixed" },
      },
    });

    // 第一次保存 knowledge_organize，期望 revision=1
    expect(await actions.saveOrganization("allocation", ["knowledge_organize"])).toBe(true);
    expect(state.organizationEditor?.source.revision).toBe(2);

    // 修改另一个角色草稿
    actions.patchOrganizationAllocation({
      ...state.organizationEditor!.auxiliaryAllocation!,
      qq_sticker_annotate: { mode: "auto" },
    });

    // 第二次在同一个编辑器会话中保存 qq_sticker_annotate，必须自动带入新 expected_revision=2
    expect(await actions.saveOrganization("allocation", ["qq_sticker_annotate"])).toBe(true);
    expect(state.apiClient.saveOrganizationSettings).toHaveBeenLastCalledWith({
      auxiliary_allocation: {
        knowledge_organize: { mode: "auto" },
        qq_sticker_annotate: { mode: "auto" },
      },
      expected_revision: 2,
    });
    expect(state.organizationEditor?.source.revision).toBe(3);
  });

  it("discards selected role alone and cleans only selected role invalid inputs", () => {
    const sourceWithBoth: OrganizationSettings = {
      ...baseSource,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed", input_limit: 100 },
        qq_sticker_annotate: { mode: "fixed", input_limit: 200 },
      },
      revision: 1,
    };
    const { state, actions } = harness(sourceWithBoth, {
      auxiliaryAllocation: {
        knowledge_organize: { mode: "auto", input_limit: 999 },
        qq_sticker_annotate: { mode: "auto", input_limit: 888 },
      },
    });

    // 真实 key 格式：global:aux:${role}_input_limit / output_reserved
    state.allocationInvalidInputs = {
      "global:aux:knowledge_organize_input_limit": "bad-1",
      "global:aux:qq_sticker_annotate_input_limit": "bad-2",
    };

    // 仅放弃 knowledge_organize
    actions.discardOrganization("allocation", ["knowledge_organize"]);

    const editor = state.organizationEditor!;
    // knowledge_organize 还原为基线
    expect(editor.auxiliaryAllocation?.knowledge_organize).toEqual({
      mode: "fixed",
      input_limit: 100,
    });
    // qq_sticker_annotate 依然保留未放弃的草稿
    expect(editor.auxiliaryAllocation?.qq_sticker_annotate).toEqual({
      mode: "auto",
      input_limit: 888,
    });

    // 只清理了 knowledge_organize 的非法输入，qq_sticker_annotate 的非法输入保留
    expect(
      state.allocationInvalidInputs["global:aux:knowledge_organize_input_limit"],
    ).toBeUndefined();
    expect(state.allocationInvalidInputs["global:aux:qq_sticker_annotate_input_limit"]).toBe(
      "bad-2",
    );
  });

  it("keeps selected role draft on CAS conflict error", async () => {
    const { state, actions } = harness(baseSource, {
      auxiliaryAllocation: {
        knowledge_organize: { mode: "auto" },
      },
    });
    state.apiClient.saveOrganizationSettings.mockRejectedValueOnce(new Error("CAS 409 conflict"));

    expect(await actions.saveOrganization("allocation", ["knowledge_organize"])).toBe(false);
    expect(state.error).toBe("CAS 409 conflict");
    // 草稿与版本未变
    expect(state.organizationEditor?.auxiliaryAllocation?.knowledge_organize).toEqual({
      mode: "auto",
    });
    expect(state.organizationEditor?.source.revision).toBe(1);
  });

  it("discards error when apiClient identity changes during save failure", async () => {
    const { state, actions } = harness(baseSource, {
      auxiliaryAllocation: {
        knowledge_organize: { mode: "auto" },
      },
    });
    state.apiClient.saveOrganizationSettings.mockImplementationOnce(async () => {
      // 模拟 API Client 身份在请求途中发生改变（如切账号或重连）
      state.apiClient = { ...state.apiClient };
      throw new Error("network failed after client changed");
    });

    expect(await actions.saveOrganization("allocation", ["knowledge_organize"])).toBe(false);
    // 因为 apiClient 身份已失效，错误不得写入当前 state
    expect(state.error).toBeNull();
  });

  it("saves organization-model scope submitting model_name alone while QQ models draft stays unsubmitted", async () => {
    const { state, actions } = harness(baseSource, {
      modelName: "new-shared-model",
      visionModelName: "new-vision-model",
      transcriptionModelName: "new-transcription-model",
      auxiliaryAllocation: { knowledge_organize: { mode: "auto" } },
    });

    expect(await actions.saveOrganization("organization-model")).toBe(true);

    // 载荷中只有 model_name，未选的 QQ 模型字段与分配均被 omitted
    expect(state.apiClient.saveOrganizationSettings).toHaveBeenCalledWith({
      model_name: "new-shared-model",
      expected_revision: 1,
    });

    const editor = state.organizationEditor!;
    // revision 推进到 2
    expect(editor.source.revision).toBe(2);
    // modelName 接受已保存值
    expect(editor.modelName).toBe("new-shared-model");
    // 未选模型草稿与分配草稿依然完整保留
    expect(editor.visionModelName).toBe("new-vision-model");
    expect(editor.transcriptionModelName).toBe("new-transcription-model");
    expect(editor.auxiliaryAllocation?.knowledge_organize).toEqual({ mode: "auto" });

    // 脏态隔离验证
    expect(organizationDirty(editor, "organization-model")).toBe(false);
    expect(organizationDirty(editor, "qq-models")).toBe(true);
    expect(organizationDirty(editor, "allocation")).toBe(true);
  });

  it("saves qq-models scope submitting vision and transcription models alone while organization model draft stays unsubmitted", async () => {
    const { state, actions } = harness(baseSource, {
      modelName: "dirty-shared-model",
      visionModelName: "new-vision-model",
      transcriptionModelName: "new-transcription-model",
    });

    expect(await actions.saveOrganization("qq-models")).toBe(true);

    // 载荷中只有 vision 与 transcription 模型，model_name 被 omitted
    expect(state.apiClient.saveOrganizationSettings).toHaveBeenCalledWith({
      vision_model_name: "new-vision-model",
      transcription_model_name: "new-transcription-model",
      expected_revision: 1,
    });

    const editor = state.organizationEditor!;
    expect(editor.source.revision).toBe(2);
    expect(editor.visionModelName).toBe("new-vision-model");
    expect(editor.transcriptionModelName).toBe("new-transcription-model");
    expect(editor.modelName).toBe("dirty-shared-model");

    expect(organizationDirty(editor, "qq-models")).toBe(false);
    expect(organizationDirty(editor, "organization-model")).toBe(true);
  });

  it("advances revision allowing sequential saves across organization-model and qq-models without 409", async () => {
    const { state, actions } = harness(baseSource, {
      modelName: "new-shared-model",
      visionModelName: "new-vision-model",
    });

    // 第一次保存 organization-model，带 expected_revision=1
    expect(await actions.saveOrganization("organization-model")).toBe(true);
    expect(state.organizationEditor?.source.revision).toBe(2);

    // 第二次在同一 editor 会话保存 qq-models，自动使用新 expected_revision=2
    expect(await actions.saveOrganization("qq-models")).toBe(true);
    expect(state.apiClient.saveOrganizationSettings).toHaveBeenLastCalledWith({
      vision_model_name: "new-vision-model",
      transcription_model_name: null,
      expected_revision: 2,
    });
    expect(state.organizationEditor?.source.revision).toBe(3);
    expect(organizationDirty(state.organizationEditor!, "models")).toBe(false);
  });

  it("preserves model drafts on CAS conflict error for model scopes", async () => {
    const { state, actions } = harness(baseSource, {
      modelName: "new-shared-model",
    });
    state.apiClient.saveOrganizationSettings.mockRejectedValueOnce(
      new Error("revision conflict 409"),
    );

    expect(await actions.saveOrganization("organization-model")).toBe(false);
    expect(state.error).toBe("revision conflict 409");
    expect(state.organizationEditor?.modelName).toBe("new-shared-model");
    expect(state.organizationEditor?.source.revision).toBe(1);
  });

  it("discards organization-model scope reverting only modelName while preserving QQ models and allocation drafts", () => {
    const { state, actions } = harness(baseSource, {
      modelName: "dirty-shared",
      visionModelName: "dirty-vision",
      auxiliaryAllocation: { knowledge_organize: { mode: "auto" } },
    });

    actions.discardOrganization("organization-model");

    const editor = state.organizationEditor!;
    expect(editor.modelName).toBe(baseSource.model_name);
    // 未选模型与分配草稿依然保留
    expect(editor.visionModelName).toBe("dirty-vision");
    expect(editor.auxiliaryAllocation).toEqual({ knowledge_organize: { mode: "auto" } });
  });

  it("discards qq-models scope reverting only vision and transcription models while preserving modelName and allocation drafts", () => {
    const { state, actions } = harness(baseSource, {
      modelName: "dirty-shared",
      visionModelName: "dirty-vision",
      transcriptionModelName: "dirty-transcription",
      auxiliaryAllocation: { knowledge_organize: { mode: "auto" } },
    });

    actions.discardOrganization("qq-models");

    const editor = state.organizationEditor!;
    expect(editor.visionModelName).toBe(baseSource.vision_model_name);
    expect(editor.transcriptionModelName).toBe(baseSource.transcription_model_name);
    // modelName 与分配草稿依然保留
    expect(editor.modelName).toBe("dirty-shared");
    expect(editor.auxiliaryAllocation).toEqual({ knowledge_organize: { mode: "auto" } });
  });
});
