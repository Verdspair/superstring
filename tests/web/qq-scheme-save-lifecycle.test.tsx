// QQ 方案保存生命周期与导航锁复现测试 (qq-scheme-save-lifecycle.test.tsx)
//
// 验证方案保存的生命周期：

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { ApiError, api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { navigationBusy } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-10-07T00:00:00.000Z";
const COLLECTION = "11111111-1111-4111-8111-111111111111";
const createFixtureScheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: "22222222-2222-4222-8222-222222222222",
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
    initiative_batch_target_count: 15,
    initiative_batch_jitter_count: 5,
    initiative_queue_on_busy: true,
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
    expression_max_dimension: 512,
    expression_frame_count: 3,
    expression_frame_max_dimension: 512,
  },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

function createMockClient(overrides: Partial<typeof api> = {}) {
  const defaultScheme = createFixtureScheme();
  return {
    ...api,
    listQqSchemes: vi.fn().mockResolvedValue([defaultScheme]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({
      scheme_id: defaultScheme.id,
      bindings: 1,
    }),
    listQqStickerCollections: vi.fn().mockResolvedValue([
      {
        id: COLLECTION,
        name: "日常",
        description: null,
        revision: 1,
        asset_count: 1,
      },
    ]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    updateQqScheme: vi
      .fn()
      .mockImplementation(async (_id: string, body: unknown) =>
        createFixtureScheme({ ...(body as object), revision: 4 }),
      ),
    createQqScheme: vi.fn().mockImplementation(async (body: unknown) =>
      createFixtureScheme({
        id: "55555555-5555-4555-8555-555555555555",
        ...(body as object),
        revision: 1,
      }),
    ),
    deleteQqScheme: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as typeof api;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("QQ scheme save lifecycle and navigation locking", () => {
  it("clears saving state and unlocks inputs and navigation on successful update", async () => {
    const fake = createMockClient();
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-scheme-config",
    });

    render(<SchemeStudio />);
    await act(async () => {});

    // Initial state: not saving, navigation not busy
    expect(store.getState().qqSchemeSaving).toBe(false);
    expect(navigationBusy(store.getState())).toBe(false);

    // Make a change to create a dirty draft
    const input = screen.getByLabelText("合并窗口（秒）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "15" } });
    expect(input.value).toBe("15");

    // Click save button
    const saveButton = screen.getByRole("button", { name: "保存方案" });
    expect(saveButton.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(saveButton);
    });

    // After save resolves:
    // 1. API was called with expected parameters
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      createFixtureScheme().id,
      expect.objectContaining({
        rhythm: expect.objectContaining({ merge_window_seconds: 15 }),
        expected_revision: 3,
      }),
    );

    // 2. qqSchemeSaving is cleared
    expect(store.getState().qqSchemeSaving).toBe(false);

    // 3. Navigation is no longer blocked
    expect(navigationBusy(store.getState())).toBe(false);

    // 4. Fields are still enabled (not disabled/greyed out)
    expect(input.disabled).toBe(false);
  });

  it("releases saving state and retains editable fields upon conflict error", async () => {
    const conflictError = new ApiError(409, "SCHEME_CONFLICT", "方案版本冲突，已被其他会话更新");
    const fake = createMockClient({
      updateQqScheme: vi.fn().mockRejectedValue(conflictError),
    });
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-scheme-config",
    });

    render(<SchemeStudio />);
    await act(async () => {});

    // Dirty change
    const input = screen.getByLabelText("合并窗口（秒）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "25" } });

    // Trigger save
    const saveButton = screen.getByRole("button", { name: "保存方案" });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    // Verify rejection handled gracefully
    expect(fake.updateQqScheme).toHaveBeenCalled();
    // Error recorded
    expect(store.getState().error).toBe("方案版本冲突，已被其他会话更新");
    // Crucial: qqSchemeSaving MUST be unlocked!
    expect(store.getState().qqSchemeSaving).toBe(false);
    expect(navigationBusy(store.getState())).toBe(false);
    // Fields remain editable for retry/correction
    expect(input.disabled).toBe(false);
  });

  it("holds busy and navigation guards during in-flight request and releases on resolution", async () => {
    let resolveSave!: (value: QqSchemeResponse) => void;
    const savePromise = new Promise<QqSchemeResponse>((resolve) => {
      resolveSave = resolve;
    });

    const fake = createMockClient({
      updateQqScheme: vi.fn().mockImplementation(() => savePromise),
    });
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-scheme-config",
    });

    render(<SchemeStudio />);
    await act(async () => {});

    const input = screen.getByLabelText("合并窗口（秒）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "45" } });

    // Start saving (unresolved promise)
    let saveResultPromise: Promise<boolean>;
    act(() => {
      saveResultPromise = store.getState().saveQqScheme();
    });

    // During in-flight pending:
    // qqSchemeSaving MUST be true
    expect(store.getState().qqSchemeSaving).toBe(true);
    // Navigation MUST be blocked
    expect(navigationBusy(store.getState())).toBe(true);
    act(() => store.getState().openSettingsRoute("scheme-library"));
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");

    // Now complete the server response
    await act(async () => {
      resolveSave(
        createFixtureScheme({
          rhythm: { ...createFixtureScheme().rhythm, merge_window_seconds: 45 },
          revision: 4,
        }),
      );
      await saveResultPromise;
    });

    // After completion:
    expect(store.getState().qqSchemeSaving).toBe(false);
    expect(navigationBusy(store.getState())).toBe(false);
    expect(input.disabled).toBe(false);
    act(() => store.getState().openSettingsRoute("scheme-library"));
    expect(store.getState().settingsRoute).toBe("scheme-library");
  });

  it("increments numeric operation token safely across sequential saves", async () => {
    const fake = createMockClient();
    store.getState().resetForTests(fake);

    // Initial check on store state
    expect(store.getState().qqSchemeOperationId).toBe(0);
    expect(store.getState().qqSchemeSaving).toBe(false);
    expect(Number.isNaN(store.getState().qqSchemeOperationId)).toBe(false);

    // Load schemes to set editor
    await store.getState().loadQqSchemes();
    expect(store.getState().qqSchemeEditor).not.toBeNull();

    // Patch to dirty
    store.getState().patchQqSchemeGroup("rhythm", { merge_window_seconds: 12 });

    // Run first save
    const ok1 = await store.getState().saveQqScheme();
    expect(ok1).toBe(true);
    expect(store.getState().qqSchemeSaving).toBe(false);
    expect(store.getState().qqSchemeOperationId).toBe(1);

    // Patch and run second save
    store.getState().patchQqSchemeGroup("rhythm", { merge_window_seconds: 18 });
    const ok2 = await store.getState().saveQqScheme();
    expect(ok2).toBe(true);
    expect(store.getState().qqSchemeSaving).toBe(false);
    expect(store.getState().qqSchemeOperationId).toBe(2);
  });
});
