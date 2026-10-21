// QQ 方案原地创建（forBinding）回归测试
//
// 「添加会话」草稿缺方案时，本页直接建一个并选中它，不跳页、不丢当前方案草稿。
// 覆盖四条边界：成功保留草稿并选中新方案；写失败全部保留；等待期间目标草稿被改过时不抢选中；
// 普通创建仍然打开新方案编辑器。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { emptyQqInputs } from "../../src/web/features/qq/draft-state";
import { type QqSchemeEditor, qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-10-20T00:00:00.000Z";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_ID = "55555555-5555-4555-8555-555555555555";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: DRAFT_ID,
  name: "默认方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
  reply: { split_by_speaker: true },
  rhythm: {
    participation_timing: "resource_window",
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
    media_frame_count: 3,
    media_max_dimension: 512,
    initiative_batch_target_count: 15,
    initiative_batch_jitter_count: 5,
    initiative_queue_on_busy: true,
    initiative_time_window_enabled: true,
    initiative_time_target_seconds: 60,
    initiative_time_jitter_seconds: 20,
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
  stickers: { sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 5, frequency: "medium" },
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
  message_settings: {
    reply_mode: "one_then_on_demand",
    reply_depth: 2,
    time_display: "hybrid",
    timezone: "Asia/Shanghai",
  },
  media_input: {
    mode: "native",
    stages: { decision: true, evaluation: true, generation: true },
    max_images: 8,
    ordinary_still_max_dimension: null,
  },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
  ...overrides,
});

const createdRow = () => scheme({ id: CREATED_ID, name: "绑定用方案", revision: 1 });

function resetForScheme(
  create: (body: { name: string; description: null }) => Promise<QqSchemeResponse> = async (body) =>
    scheme({ id: CREATED_ID, ...body, revision: 1 }),
) {
  const row = scheme();
  const fake = {
    listQqSchemes: vi.fn(async () => [row]),
    getQqSchemeUsage: vi.fn(async (id: string) => ({ scheme_id: id, bindings: 0 })),
    createQqScheme: vi.fn(create),
  };
  store.getState().resetForTests(fake as never);
  store.setState({ qqSchemes: [row], qqSchemeEditor: qqSchemeEditorFrom(row) });
  return fake;
}

/** 「添加会话」草稿：已选私聊目标与 Agent，方案还是旧值；当前方案编辑器有未保存名。 */
function seedBindingDraft(): QqSchemeEditor {
  const editor: QqSchemeEditor = {
    ...qqSchemeEditorFrom(scheme()),
    name: "未保存的方案草稿",
  };
  store.setState({
    qqSchemeEditor: editor,
    qqInputs: {
      ...emptyQqInputs(),
      schemeTexts: { "rhythm.merge_window_seconds": "45" },
      manualKind: "private",
      manualPeer: "10001",
      manualPicked: "",
      manualAgentId: AGENT_ID,
      manualSchemeId: DRAFT_ID,
    },
  });
  return editor;
}

describe("QQ 方案原地创建 (forBinding)", () => {
  beforeEach(() => {
    store.getState().resetForTests();
  });

  it("创建成功：保留当前方案草稿与手动绑定目标，并选中刚建的方案", async () => {
    const fake = resetForScheme();
    const editor = seedBindingDraft();

    expect(await store.getState().createQqScheme("绑定用方案", { forBinding: true })).toBe(true);

    expect(fake.createQqScheme).toHaveBeenCalledWith({ name: "绑定用方案", description: null });
    const after = store.getState();
    expect(after.qqInputs.manualSchemeId).toBe(CREATED_ID);
    expect(after.qqInputs.manualKind).toBe("private");
    expect(after.qqInputs.manualPeer).toBe("10001");
    expect(after.qqInputs.manualAgentId).toBe(AGENT_ID);
    // 不打开新方案：未保存的方案名与原文都留在原处。
    expect(after.qqSchemeEditor).toBe(editor);
    expect(after.qqInputs.schemeTexts).toEqual({ "rhythm.merge_window_seconds": "45" });
    expect(after.qqSchemes.map((row) => row.id)).toContain(CREATED_ID);
    expect(after.qqSchemeSaving).toBe(false);
  });

  it("创建失败：手头一切原样保留，由错误提示说明原因", async () => {
    const fake = resetForScheme(async () => {
      throw new Error("网络错误");
    });
    const editor = seedBindingDraft();
    const inputs = store.getState().qqInputs;

    expect(await store.getState().createQqScheme("绑定用方案", { forBinding: true })).toBe(false);

    expect(fake.createQqScheme).toHaveBeenCalledTimes(1);
    const after = store.getState();
    expect(after.qqInputs).toEqual(inputs);
    expect(after.qqSchemeEditor).toBe(editor);
    expect(after.qqSchemes.map((row) => row.id)).toEqual([DRAFT_ID]);
    expect(after.error).toContain("网络错误");
    expect(after.qqSchemeSaving).toBe(false);
  });

  it("等待响应期间目标草稿被改过：迟到的响应不得改写手动选中", async () => {
    let release!: (row: QqSchemeResponse) => void;
    resetForScheme(
      () =>
        new Promise<QqSchemeResponse>((resolve) => {
          release = resolve;
        }),
    );
    const editor = seedBindingDraft();

    const pending = store.getState().createQqScheme("绑定用方案", { forBinding: true });
    expect(store.getState().qqSchemeSaving).toBe(true);

    // 用户在等待期间换了目标会话：创建结果仍进目录，但不再代表手动选中的方案。
    store.setState((state) => ({
      qqInputs: { ...state.qqInputs, manualPicked: "acct:private:20002", manualPeer: "" },
    }));
    release(createdRow());

    await expect(pending).resolves.toBe(true);
    const after = store.getState();
    expect(after.qqInputs.manualPicked).toBe("acct:private:20002");
    expect(after.qqInputs.manualSchemeId).toBe(DRAFT_ID);
    expect(after.qqSchemeEditor).toBe(editor);
    expect(after.qqSchemes.map((row) => row.id)).toContain(CREATED_ID);
  });

  it("普通创建行为不变：新方案成为当前编辑器，手动绑定草稿不动", async () => {
    resetForScheme();
    seedBindingDraft();

    expect(await store.getState().createQqScheme("普通新方案")).toBe(true);

    const after = store.getState();
    expect(after.qqSchemeEditor?.source.id).toBe(CREATED_ID);
    expect(after.qqSchemeEditor?.name).toBe("普通新方案");
    expect(after.qqInputs.schemeTexts).toEqual({});
    expect(after.qqInputs.manualSchemeId).toBe(DRAFT_ID);
  });
});
