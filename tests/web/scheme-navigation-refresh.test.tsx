// QQ 方案切换与显式刷新 (ADR0015 刷新规则 / ADR0019 导航守卫 / ADR0018 §11.2).
//
// The cases pin the finite-state contract: scheme switching goes through the store's one guard
// (save / discard / cancel), refresh never submits drafts, a 409 has an explicit recovery path, a
// deleted scheme never silently takes the draft away, and late API answers cannot overwrite a
// newer selection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import { QqBindingResponseSchema } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { msg } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-24T00:00:00.000Z";
const FIRST = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const COPY = "55555555-5555-4555-8555-555555555555";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BINDING_TWO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: FIRST,
  name: "默认方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
  reply: { split_by_speaker: true },
  rhythm: {
    merge_window_seconds: 30,
    reply_cooldown_seconds: 10,
    hourly_speech_limit: 200,
    initiative_min_score: 6,
    judgement_interval_turns: 3,
    idle_quiet_minutes: 15,
    active_hours_enabled: false,
    active_hours_start_minutes: 0,
    active_hours_end_minutes: 1439,
    max_recompute_count: 1,
    max_sticker_count: 1,
    media_supplement_window_minutes: 10,
    media_frame_count: 3,
    media_max_dimension: 512,
  },
  context: {
    judgement_message_limit: 20,
    judgement_window_minutes: 60,
    judgement_token_budget: 2000,
    reply_message_limit: 60,
    reply_window_minutes: 360,
    reply_token_budget: 6000,
  },
  compression: { watermark_trigger: 200, package_limit: 8, headroom_ratio: 0.05 },
  output_reserve: { judgement_output_reserved: 512, reply_output_reserved: 2048 },
  stickers: { sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 5 },
  sticker_collections: { collection_ids: [] },
  prompts: {
    scene: "场景提示词",
    judge: "判断提示词",
    reply: "回复提示词",
    review: "复核提示词",
    sticker: "选图提示词",
    media: "媒体提示词",
    compress: "压缩提示词",
  },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const settings = {
  enabled: true,
  account_id: "100",
  judgement_model_name: null,
  transport: { endpoint: "ws://localhost:3000", has_token: true },
  revision: 3,
};
const bindingFixture = QqBindingResponseSchema.parse({
  id: BINDING,
  account_id: "10001",
  kind: "group",
  peer_id: "30003",
  agent_id: AGENT,
  scheme_id: FIRST,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 1,
  authority_revision: 1,
  attention: { mode: "off", members: [] },
});
const bindingFixtureTwo = QqBindingResponseSchema.parse({
  ...bindingFixture,
  id: BINDING_TWO,
  peer_id: "40004",
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function reset(overrides: Partial<typeof api> = {}) {
  const fake = {
    ...api,
    getQqSettings: async () => settings,
    listQqConversations: async () => [],
    listQqBindings: async () => [],
    listQqSchemes: async () => [scheme(), scheme({ id: OTHER, name: "其他方案" })],
    getQqSchemeUsage: async (id: string) => ({ scheme_id: id, bindings: 0 }),
    updateQqScheme: async (id: string, body: unknown) =>
      scheme({ ...(body as object), id, revision: 4 }),
    createQqScheme: async (body: unknown) => scheme({ id: COPY, ...(body as object), revision: 1 }),
    deleteQqScheme: async () => undefined,
    updateQqBinding: async (id: string, patch: unknown) => {
      const { expected_revision: _expected, ...fields } = patch as Record<string, unknown>;
      return QqBindingResponseSchema.parse({ ...bindingFixture, id, ...fields });
    },
    ...overrides,
  } as unknown as typeof api;
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
    qqSchemes: [scheme(), scheme({ id: OTHER, name: "其他方案" })],
    qqSchemeEditor: qqSchemeEditorFrom(scheme()),
  });
}

beforeEach(() => {
  reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("方案切换守卫", () => {
  it("打开当前方案也进入详情，保存方案不夹带其他资料草稿", async () => {
    reset();
    store.setState({ settingsRoute: "scheme-library" });
    store.getState().requestQqSchemeNavigation(FIRST);
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    const saveCorrection = vi.fn().mockResolvedValue(true);
    const saveKnowledge = vi.fn().mockResolvedValue(true);
    const originalCorrection = store.getState().saveMemoryCorrection;
    const originalKnowledge = store.getState().saveKnowledgeEditor;
    store.setState({
      saveMemoryCorrection: saveCorrection,
      saveKnowledgeEditor: saveKnowledge,
      memoryCorrectionDirty: true,
      knowledgeDirty: true,
    });
    try {
      store.getState().patchQqScheme({ name: "仅保存方案" });
      store.getState().requestQqSchemeNavigation(OTHER);
      await store.getState().confirmSaveAndContinue();
      expect(store.getState().qqSchemeEditor?.source.id).toBe(OTHER);
      expect(saveCorrection).not.toHaveBeenCalled();
      expect(saveKnowledge).not.toHaveBeenCalled();
      expect(store.getState().memoryCorrectionDirty).toBe(true);
      expect(store.getState().knowledgeDirty).toBe(true);
    } finally {
      store.setState({
        saveMemoryCorrection: originalCorrection,
        saveKnowledgeEditor: originalKnowledge,
      });
    }
  });

  it("取消保留原方案与草稿，不发生任何写入", async () => {
    const update = vi.fn();
    store.setState({ apiClient: { ...store.getState().apiClient, updateQqScheme: update } });
    store.getState().patchQqScheme({ name: "改过的名字" });
    store.getState().requestQqSchemeNavigation(OTHER);
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().pendingNavigation).toEqual({ kind: "scheme", id: OTHER });
    expect(store.getState().navigationConfirmMessage).toBe(
      msg("设置中有未保存页面，是否全部保存再继续？"),
    );
    store.getState().cancelPendingNavigation();
    expect(store.getState().pendingNavigation).toBeNull();
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
    expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
    expect(update).not.toHaveBeenCalled();
  });

  it("保存并继续：按原 revision 保存当前方案后切到目标并落到方案编辑路由", async () => {
    const update = vi.fn().mockResolvedValue(scheme({ name: "改过的名字", revision: 4 }));
    reset({ updateQqScheme: update });
    store.getState().patchQqScheme({ name: "改过的名字" });
    store.getState().requestQqSchemeNavigation(OTHER);
    await store.getState().confirmSaveAndContinue();
    expect(update).toHaveBeenCalledWith(
      FIRST,
      expect.objectContaining({ name: "改过的名字", expected_revision: 3 }),
    );
    expect(store.getState().qqSchemeEditor?.source.id).toBe(OTHER);
    expect(store.getState().qqSchemes.find((row) => row.id === FIRST)?.name).toBe("改过的名字");
    expect(store.getState().page).toBe("settings");
    expect(store.getState().settingsView).toBe("workspace");
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    expect(store.getState().pendingNavigation).toBeNull();
    expect(store.getState().navigationConfirmOpen).toBe(false);
  });

  it("放弃并继续：丢弃确认框列出的 QQ 草稿，但保留其他资料草稿", async () => {
    const update = vi.fn();
    reset({ updateQqScheme: update });
    store.getState().patchQqScheme({ name: "改过的名字" });
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "rhythm.hourly_speech_limit": "-" },
        stickerNewCollection: "新集合",
      },
      qqMemoryBatchDrafts: { [AGENT]: { value: "记忆草稿", revision: 1 } },
    });
    store.getState().requestQqSchemeNavigation(OTHER);
    await store.getState().confirmDiscardAndContinue();
    expect(update).not.toHaveBeenCalled();
    expect(store.getState().qqSchemeEditor?.source.id).toBe(OTHER);
    expect(store.getState().qqSchemeEditor?.name).toBe("其他方案");
    expect(store.getState().qqInputs.schemeTexts).toEqual({});
    expect(store.getState().qqInputs.stickerNewCollection).toBe("");
    expect(store.getState().qqMemoryBatchDrafts).toHaveProperty(AGENT);
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
  });

  it("从绑定打开方案时放弃未保存的改绑，不产生绑定写入", async () => {
    const updateBinding = vi.fn();
    reset({ updateQqBinding: updateBinding });
    store.setState({
      settingsRoute: "mcp-servers",
      qqInputs: {
        ...store.getState().qqInputs,
        choices: {
          [BINDING]: { agentId: AGENT, schemeId: OTHER, source: bindingFixture },
        },
      },
    });
    store.getState().requestQqSchemeNavigation(OTHER);
    expect(store.getState().navigationConfirmOpen).toBe(true);
    await store.getState().confirmDiscardAndContinue();
    expect(updateBinding).not.toHaveBeenCalled();
    expect(store.getState().qqInputs.choices).toEqual({});
    expect(store.getState().qqSchemeEditor?.source.id).toBe(OTHER);
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
  });

  it("绑定的未保存改绑也触发确认，保存成功后完成切换", async () => {
    const updateBinding = vi.fn(async (id: string, patch: unknown) => {
      const { expected_revision: _expected, ...fields } = patch as Record<string, unknown>;
      return QqBindingResponseSchema.parse({ ...bindingFixture, id, ...fields });
    });
    reset({ updateQqBinding: updateBinding });
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        choices: {
          [BINDING]: { agentId: AGENT, schemeId: OTHER, source: bindingFixture },
        },
      },
    });
    store.getState().requestQqSchemeNavigation(OTHER);
    expect(store.getState().navigationConfirmOpen).toBe(true);
    await store.getState().confirmSaveAndContinue();
    expect(updateBinding).toHaveBeenCalledWith(
      BINDING,
      expect.objectContaining({ scheme_id: OTHER, expected_revision: 1 }),
    );
    expect(store.getState().qqSchemeEditor?.source.id).toBe(OTHER);
    expect(store.getState().qqInputs.choices).toEqual({});
  });

  it("保存失败：留在原方案，弹窗保留可重试", async () => {
    reset({ updateQqScheme: vi.fn().mockRejectedValue(new Error("MEMORY_STATE_CONFLICT")) });
    store.getState().patchQqScheme({ name: "改过的名字" });
    store.getState().requestQqSchemeNavigation(OTHER);
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
    expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().error).toBe("MEMORY_STATE_CONFLICT");
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
  });

  it("目标不存在：请求即显式报错；确认时目标消失也报错并保留弹窗", async () => {
    store.getState().requestQqSchemeNavigation("99999999-9999-4999-8999-999999999999");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().error).toBe(msg("操作失败，请重试。"));
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);

    store.getState().patchQqScheme({ name: "改过的名字" });
    store.getState().requestQqSchemeNavigation(OTHER);
    store.setState({ qqSchemes: [scheme()] });
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().error).toBe(msg("操作失败，请重试。"));
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().pendingNavigation).toEqual({ kind: "scheme", id: OTHER });
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
  });
});

describe("方案详情视图（settings/bindings）", () => {
  it("同一方案在详情内切换绑定视图：不弹确认、不重建编辑器、整案草稿保留", () => {
    store.getState().patchQqScheme({ name: "改过的名字" });
    const editor = store.getState().qqSchemeEditor;
    store.getState().requestQqSchemeNavigation(FIRST, "bindings");
    expect(store.getState().qqSchemeView).toBe("bindings");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().pendingNavigation).toBeNull();
    expect(store.getState().qqSchemeEditor).toBe(editor);
    expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
    // 切回设置视图同样只换视图，不把同方案视图切换当切换对象。
    store.getState().requestQqSchemeNavigation(FIRST);
    expect(store.getState().qqSchemeView).toBe("settings");
    expect(store.getState().qqSchemeEditor).toBe(editor);
  });

  it("已删的脏方案在详情内切绑定视图：显式报错、保留草稿、不切视图", () => {
    store.getState().patchQqScheme({ name: "改过的名字" });
    store.setState({ qqSchemes: [scheme({ id: OTHER, name: "其他方案" })] });
    store.getState().requestQqSchemeNavigation(FIRST, "bindings");
    expect(store.getState().error).toBe(msg("操作失败，请重试。"));
    expect(store.getState()).toMatchObject({
      settingsRoute: "qq-scheme-config",
      qqSchemeView: "settings",
      navigationConfirmOpen: false,
      pendingNavigation: null,
    });
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
    expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
  });

  it("同方案从别页无草稿进入：不调用 selectQqScheme，编辑器引用保持", () => {
    store.setState({ settingsRoute: "scheme-library" });
    const editor = store.getState().qqSchemeEditor;
    store.getState().requestQqSchemeNavigation(FIRST, "bindings");
    expect(store.getState().qqSchemeEditor).toBe(editor);
    expect(store.getState().qqSchemeView).toBe("bindings");
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    expect(store.getState().pendingNavigation).toBeNull();
  });

  it("同方案从别页有草稿：仍走三选一守卫，确认后落指定视图且不产生写入", async () => {
    const update = vi.fn();
    reset({ updateQqScheme: update });
    store.setState({ settingsRoute: "scheme-library" });
    store.getState().patchQqScheme({ name: "改过的名字" });
    store.getState().requestQqSchemeNavigation(FIRST, "bindings");
    expect(store.getState().pendingNavigation).toEqual({
      kind: "scheme",
      id: FIRST,
      view: "bindings",
    });
    await store.getState().confirmDiscardAndContinue();
    expect(update).not.toHaveBeenCalled();
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    expect(store.getState().qqSchemeView).toBe("bindings");
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
    expect(store.getState().qqSchemeEditor?.name).toBe("默认方案");
  });

  it("同方案从别页默认视图：pending 不带 view 字段（one-arg 调用兼容）", () => {
    store.setState({ settingsRoute: "scheme-library" });
    store.getState().patchQqScheme({ name: "改过的名字" });
    store.getState().requestQqSchemeNavigation(FIRST);
    expect(store.getState().pendingNavigation).toEqual({ kind: "scheme", id: FIRST });
  });

  it("切到不同方案携带视图落地：切换对象才重建编辑器", async () => {
    store.getState().patchQqScheme({ name: "改过的名字" });
    store.getState().requestQqSchemeNavigation(OTHER, "bindings");
    expect(store.getState().pendingNavigation).toEqual({
      kind: "scheme",
      id: OTHER,
      view: "bindings",
    });
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().qqSchemeEditor?.source.id).toBe(OTHER);
    expect(store.getState().qqSchemeView).toBe("bindings");
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
  });

  it("scheme-bindings 是方案下的绑定首次发现入口：不用假方案 ID，也不创建编辑器", () => {
    store.setState({ settingsRoute: "scheme-library", qqSchemes: [], qqSchemeEditor: null });
    store.getState().openSettingsRoute("scheme-bindings");
    expect(store.getState()).toMatchObject({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "scheme-bindings",
      qqSchemeEditor: null,
      pendingNavigation: null,
      error: null,
    });
  });

  it("scheme-bindings 导航仍走 QQ 草稿守卫", async () => {
    store.getState().patchQqScheme({ name: "改过的名字" });
    store.getState().openSettingsRoute("scheme-bindings");
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    expect(store.getState().pendingNavigation).toEqual({
      kind: "page",
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "scheme-bindings",
    });
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().settingsRoute).toBe("scheme-bindings");
  });
});

describe("显式刷新与 409 恢复", () => {
  it("冲突后刷新：已改字段保留、未改字段随新基线，保存带上新 revision", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("MEMORY_STATE_CONFLICT"))
      .mockImplementation(async (_id: string, body: unknown) =>
        scheme({ ...(body as object), revision: 5 }),
      );
    reset({
      updateQqScheme: update,
      listQqSchemes: async () => [
        scheme({ description: "别处改过", revision: 4 }),
        scheme({ id: OTHER, name: "其他方案" }),
      ],
    });
    store.getState().patchQqScheme({ name: "改过的名字" });
    expect(await store.getState().saveQqScheme()).toBe(false);
    expect(store.getState().error).toBe("MEMORY_STATE_CONFLICT");
    expect(store.getState().qqSchemeEditor?.source.revision).toBe(3);

    expect(await store.getState().refreshQqScheme()).toBe(true);
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
    expect(store.getState().qqSchemeEditor?.source.revision).toBe(4);
    expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
    expect(store.getState().qqSchemeEditor?.description).toBe("别处改过");
    expect(store.getState().feedback).toBe(msg("刷新不提交草稿；冲突后请核对最新值再保存。"));

    expect(await store.getState().saveQqScheme()).toBe(true);
    expect(update).toHaveBeenLastCalledWith(
      FIRST,
      expect.objectContaining({ name: "改过的名字", expected_revision: 4 }),
    );
  });

  it("loadQqSchemes 与显式刷新同一套合并规则：读取不清草稿", async () => {
    reset({
      listQqSchemes: async () => [scheme({ revision: 7 }), scheme({ id: OTHER, name: "其他方案" })],
    });
    store.getState().patchQqScheme({ rhythm: { merge_window_seconds: 15 } as never });
    await store.getState().loadQqSchemes();
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
    expect(store.getState().qqSchemeEditor?.source.revision).toBe(7);
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(15);
  });

  it("非法原值经刷新保留，编辑器不被重置", async () => {
    reset({ listQqSchemes: async () => [scheme({ revision: 9 })] });
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "rhythm.hourly_speech_limit": "-" },
      },
    });
    expect(await store.getState().refreshQqScheme()).toBe(true);
    expect(store.getState().qqInputs.schemeTexts["rhythm.hourly_speech_limit"]).toBe("-");
    expect(store.getState().qqSchemeEditor?.source.revision).toBe(9);
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
  });

  it("当前方案被删除：有草稿保留原草稿（保存得到服务端错误），无草稿才自动选第一个", async () => {
    reset({
      listQqSchemes: async () => [scheme({ id: OTHER, name: "其他方案" })],
      updateQqScheme: vi.fn().mockRejectedValue(new Error("方案不存在")),
    });
    store.getState().patchQqScheme({ name: "删不掉的草稿" });
    expect(await store.getState().refreshQqScheme()).toBe(true);
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
    expect(store.getState().qqSchemeEditor?.name).toBe("删不掉的草稿");
    expect(store.getState().feedback).toBe(msg("刷新不提交草稿；冲突后请核对最新值再保存。"));
    expect(await store.getState().saveQqScheme()).toBe(false);
    expect(store.getState().error).toBe("方案不存在");
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);

    store.getState().discardQqSchemeChanges();
    expect(await store.getState().refreshQqScheme()).toBe(true);
    expect(store.getState().qqSchemeEditor?.source.id).toBe(OTHER);
  });

  it("晚到的保存与使用量响应不覆盖新选中的方案", async () => {
    let releaseSave: (value: QqSchemeResponse) => void = () => {};
    const pendingSave = new Promise<QqSchemeResponse>((resolve) => {
      releaseSave = resolve;
    });
    let releaseUsage: (value: { scheme_id: string; bindings: number }) => void = () => {};
    const pendingUsage = new Promise<{ scheme_id: string; bindings: number }>((resolve) => {
      releaseUsage = resolve;
    });
    reset({
      updateQqScheme: vi.fn(() => pendingSave),
      getQqSchemeUsage: vi.fn((id: string) =>
        id === FIRST ? pendingUsage : Promise.resolve({ scheme_id: id, bindings: 1 }),
      ),
    });
    store.getState().patchQqScheme({ name: "本地改名" });
    const saving = store.getState().saveQqScheme();
    store.getState().selectQqScheme(OTHER);
    await tick();
    releaseSave(scheme({ name: "服务端改名", revision: 4 }));
    await saving;
    expect(store.getState().qqSchemeEditor?.source.id).toBe(OTHER);
    expect(store.getState().qqSchemes.find((row) => row.id === FIRST)?.name).toBe("服务端改名");

    store.getState().selectQqScheme(FIRST);
    store.getState().selectQqScheme(OTHER);
    await tick();
    releaseUsage({ scheme_id: FIRST, bindings: 99 });
    await tick();
    expect(store.getState().qqSchemeUsage?.schemeId).toBe(OTHER);
    expect(store.getState().qqSchemeUsage?.bindings).toBe(1);
  });

  it("使用量读取失败留下可重试字段，刷新重读后清除", async () => {
    reset({ getQqSchemeUsage: vi.fn().mockRejectedValue(new Error("usage down")) });
    store.getState().selectQqScheme(FIRST);
    await tick();
    expect(store.getState().qqSchemeUsageError).toBe("usage down");
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqSchemeUsage: async (id: string) => ({ scheme_id: id, bindings: 2 }),
      },
    });
    expect(await store.getState().refreshQqScheme()).toBe(true);
    expect(store.getState().qqSchemeUsageError).toBeNull();
    expect(store.getState().qqSchemeUsage).toEqual({ schemeId: FIRST, bindings: 2 });
  });
});

describe("复制、删除与忙碌保护", () => {
  it("复制先校验非法原值；有效草稿的复制不带源 revision", async () => {
    const create = vi.fn(async (body: unknown) =>
      scheme({ id: COPY, ...(body as object), revision: 1 }),
    );
    reset({ createQqScheme: create });
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "rhythm.hourly_speech_limit": "=" },
      },
    });
    expect(await store.getState().duplicateQqScheme("副本")).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(store.getState().error).toBe(msg("请先修正方案中的无效数字，再保存。"));

    store.setState({ qqInputs: { ...store.getState().qqInputs, schemeTexts: {} } });
    store.getState().patchQqScheme({ name: "副本内容" });
    expect(await store.getState().duplicateQqScheme("副本")).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "副本" }));
    const payload = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("expected_revision");
    expect(store.getState().qqSchemeEditor?.source.id).toBe(COPY);
  });

  it("删除非当前方案不动编辑器，删除提示保留", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    reset({ deleteQqScheme: del });
    expect(await store.getState().deleteQqScheme(OTHER)).toBe(true);
    expect(del).toHaveBeenCalledWith(OTHER);
    expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
    expect(store.getState().qqSchemes.some((row) => row.id === OTHER)).toBe(false);
    expect(store.getState().feedback).toBe("已删除方案");
  });

  it("保存中：切换请求与补丁都被拒绝，状态不被并发覆盖", () => {
    store.setState({ qqSchemeSaving: true });
    store.getState().requestQqSchemeNavigation(OTHER);
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().pendingNavigation).toBeNull();
    store.getState().patchQqScheme({ name: "并发改名" });
    store.getState().patchQqSchemeGroup("rhythm", { merge_window_seconds: 5 });
    expect(store.getState().qqSchemeEditor?.name).toBe("默认方案");
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(30);
  });
});

describe("方案操作的状态边界（迟到响应 / reset / 换客户端）", () => {
  it("保存期间同 id 重选：迟到的保存只更新目录行，不覆盖新编辑器会话", async () => {
    let releaseSave: (value: QqSchemeResponse) => void = () => {};
    const pendingSave = new Promise<QqSchemeResponse>((resolve) => {
      releaseSave = resolve;
    });
    reset({ updateQqScheme: vi.fn(() => pendingSave) });
    store.getState().patchQqScheme({ name: "本地改名" });
    const saving = store.getState().saveQqScheme();
    // 保存进行中从目录重新选中同一个方案：换出来的是新的编辑器对象，旧保存不得覆盖它。
    store.getState().selectQqScheme(FIRST);
    expect(store.getState().qqSchemeEditor?.name).toBe("默认方案");
    releaseSave(scheme({ name: "服务端改名", revision: 4 }));
    expect(await saving).toBe(true);
    expect(store.getState().qqSchemeSaving).toBe(false);
    expect(store.getState().qqSchemeEditor?.name).toBe("默认方案");
    expect(store.getState().qqSchemes.find((row) => row.id === FIRST)?.name).toBe("服务端改名");
  });

  it("先发出的目录读取晚于保存完成：旧列表不得覆盖已保存的目录", async () => {
    let releaseList: (rows: QqSchemeResponse[]) => void = () => {};
    const pendingList = new Promise<QqSchemeResponse[]>((resolve) => {
      releaseList = resolve;
    });
    reset({ listQqSchemes: vi.fn(() => pendingList) });
    const loading = store.getState().loadQqSchemes();
    await tick();
    expect(store.getState().qqSchemesLoading).toBe(true);

    store.getState().patchQqScheme({ name: "本地改名" });
    expect(await store.getState().saveQqScheme()).toBe(true);
    expect(store.getState().qqSchemes.find((row) => row.id === FIRST)?.name).toBe("本地改名");
    // 保存开始即作废旧读取：它不再占着 loading，也不再有权写目录。
    expect(store.getState().qqSchemesLoading).toBe(false);

    releaseList([scheme(), scheme({ id: OTHER, name: "其他方案" })]);
    await loading;
    expect(store.getState().qqSchemes.find((row) => row.id === FIRST)?.name).toBe("本地改名");
    expect(store.getState().qqSchemesLoading).toBe(false);
  });

  it("保存进行中：目录读取与显式刷新直接 no-op", async () => {
    const list = vi.fn();
    reset({ listQqSchemes: list });
    store.setState({ qqSchemeSaving: true });
    await store.getState().loadQqSchemes();
    expect(await store.getState().refreshQqScheme()).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(store.getState().qqSchemesLoading).toBe(false);
  });

  it("保存中加入 reset（同一客户端）：迟到的失败不写入新状态", async () => {
    let rejectSave: (error: Error) => void = () => {};
    const pendingSave = new Promise<QqSchemeResponse>((_resolve, reject) => {
      rejectSave = reject;
    });
    const client = {
      ...api,
      getQqSettings: async () => settings,
      listQqConversations: async () => [],
      listQqBindings: async () => [],
      listQqSchemes: async () => [scheme()],
      getQqSchemeUsage: async (id: string) => ({ scheme_id: id, bindings: 0 }),
      updateQqScheme: vi.fn(() => pendingSave),
    } as unknown as typeof api;
    store.getState().resetForTests(client);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-scheme-config",
      qqSchemes: [scheme()],
      qqSchemeEditor: qqSchemeEditorFrom(scheme()),
    });
    store.getState().patchQqScheme({ name: "本地改名" });
    const saving = store.getState().saveQqScheme();
    // 同一客户端重置：API 身份不变，只有操作代次能识别「这是旧操作」。
    store.getState().resetForTests(client);
    rejectSave(new Error("旧操作的失败"));
    expect(await saving).toBe(false);
    await tick();
    expect(store.getState().error).toBeNull();
    expect(store.getState().feedback).toBe("");
    expect(store.getState().qqSchemeSaving).toBe(false);
    expect(store.getState().qqSchemes).toEqual([]);
    expect(store.getState().qqSchemeEditor).toBeNull();
  });

  it("保存中途更换 API 客户端：旧响应不落到新客户端的状态，保存标记仍能收尾", async () => {
    let releaseSave: (value: QqSchemeResponse) => void = () => {};
    const pendingSave = new Promise<QqSchemeResponse>((resolve) => {
      releaseSave = resolve;
    });
    reset({ updateQqScheme: vi.fn(() => pendingSave) });
    store.getState().patchQqScheme({ name: "本地改名" });
    const saving = store.getState().saveQqScheme();
    store.setState({ apiClient: { ...store.getState().apiClient } });
    releaseSave(scheme({ name: "服务端改名", revision: 4 }));
    expect(await saving).toBe(false);
    expect(store.getState().qqSchemes.find((row) => row.id === FIRST)?.name).toBe("默认方案");
    expect(store.getState().qqSchemeEditor?.name).toBe("本地改名");
    expect(store.getState().error).toBeNull();
    expect(store.getState().qqSchemeSaving).toBe(false);
  });

  it("使用量旧请求失败晚到：不得覆盖已成功的新计数", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    const firstUsage = new Promise<{ scheme_id: string; bindings: number }>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let calls = 0;
    reset({
      getQqSchemeUsage: vi.fn((id: string) => {
        calls += 1;
        if (calls === 1) return firstUsage;
        return Promise.resolve({ scheme_id: id, bindings: id === FIRST ? 1 : 0 });
      }),
    });
    store.getState().selectQqScheme(FIRST);
    await tick();
    store.getState().selectQqScheme(OTHER);
    await tick();
    store.getState().selectQqScheme(FIRST);
    await tick();
    expect(store.getState().qqSchemeUsage).toEqual({ schemeId: FIRST, bindings: 1 });
    rejectFirst(new Error("usage down"));
    await tick();
    expect(store.getState().qqSchemeUsage).toEqual({ schemeId: FIRST, bindings: 1 });
    expect(store.getState().qqSchemeUsageError).toBeNull();
  });

  it("刷新时使用量读取失败：旧计数清为未知，不得继续显示 0", async () => {
    const usage = vi
      .fn()
      .mockResolvedValueOnce({ scheme_id: FIRST, bindings: 0 })
      .mockRejectedValue(new Error("usage down"));
    reset({ getQqSchemeUsage: usage });
    store.getState().selectQqScheme(FIRST);
    await tick();
    expect(store.getState().qqSchemeUsage).toEqual({ schemeId: FIRST, bindings: 0 });

    // 有草稿时刷新走字段合并：使用量读取失败后旧计数必须清掉（0 会误放行删除）。
    store.getState().patchQqScheme({ name: "改过的名字" });
    expect(await store.getState().refreshQqScheme()).toBe(true);
    expect(store.getState().qqSchemeUsage).toBeNull();
    expect(store.getState().qqSchemeUsageError).toBe("usage down");
  });
});

describe("绑定读取的显式刷新", () => {
  it("显式刷新绑定：真实重读并更新计数，缓存命中不再请求", async () => {
    let release: (rows: QqBindingResponse[]) => void = () => {};
    const pending = new Promise<QqBindingResponse[]>((resolve) => {
      release = resolve;
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce([bindingFixture])
      .mockImplementationOnce(() => pending);
    reset({ listQqBindings: list });
    await store.getState().loadQqBindings();
    expect(store.getState().qqBindingsLoaded).toBe(true);
    expect(store.getState().qqBindings).toHaveLength(1);

    const refreshing = store.getState().loadQqBindings(true);
    expect(store.getState().qqBindingsLoading).toBe(true);
    // 刷新开始即视为未知：失败或进行中都不沿用旧计数。
    expect(store.getState().qqBindingsLoaded).toBe(false);
    release([bindingFixture, bindingFixtureTwo]);
    await refreshing;
    expect(store.getState().qqBindings).toHaveLength(2);
    expect(store.getState().qqBindingsLoaded).toBe(true);
    expect(store.getState().qqBindingsLoading).toBe(false);
    expect(store.getState().qqBindingsError).toBeNull();

    await store.getState().loadQqBindings();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("显式刷新绑定失败：保持未知并留下原因，不写全局错误", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([bindingFixture])
      .mockRejectedValue(new Error("bindings down"));
    reset({ listQqBindings: list });
    await store.getState().loadQqBindings();
    expect(store.getState().qqBindingsLoaded).toBe(true);
    expect(store.getState().qqBindings).toHaveLength(1);

    await store.getState().loadQqBindings(true);
    expect(store.getState().qqBindingsLoaded).toBe(false);
    expect(store.getState().qqBindingsError).toBe("bindings down");
    expect(store.getState().qqBindingsLoading).toBe(false);
    expect(store.getState().error).toBeNull();

    // 无参读失败保持安静：不覆盖显式刷新留下的原因，也不写全局错误。
    await store.getState().loadQqBindings();
    expect(store.getState().qqBindingsLoaded).toBe(false);
    expect(store.getState().qqBindingsError).toBe("bindings down");
    expect(store.getState().error).toBeNull();
  });
});
