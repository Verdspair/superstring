import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

const NOW = "2026-10-08T00:00:00Z";
const SCHEME_A = "22222222-2222-4222-8222-222222222222";
const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: SCHEME_A,
  name: "默认方案",
  description: "群聊里的参与方式",
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
  // 0052：响应契约收紧后两组必填，夹具照完整响应形状造。
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("keeps visited task panel DOM and each task scroll position", async () => {
  setupLibrary();
  store.setState({
    qqSchemeEditor: qqSchemeEditorFrom(scheme()),
    loadQqSchemes: vi.fn().mockResolvedValue(true),
    loadQqStickers: vi.fn().mockResolvedValue(undefined),
  });
  const view = render(<SchemeStudio />);
  await act(async () => {});
  const participation = screen.getAllByRole("tab")[0];
  const response = screen.getAllByRole("tab")[1];
  const tabs = participation.closest('[data-slot="tabs"]');
  const panel = tabs?.querySelector('[data-slot="tabs-content"]');
  const viewport = tabs?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
  if (!panel || !viewport) throw new Error("Missing task panel or viewport");
  viewport.scrollTop = 83;
  fireEvent.scroll(viewport);
  fireEvent.mouseDown(response);
  await act(async () => {});
  expect(panel.isConnected).toBe(true);
  expect(panel.getAttribute("data-state")).toBe("inactive");
  viewport.scrollTop = 31;
  fireEvent.scroll(viewport);
  fireEvent.mouseDown(participation);
  await act(async () => {});
  expect(tabs?.querySelector('[data-slot="tabs-content"]')).toBe(panel);
  expect(viewport.scrollTop).toBe(83);
  fireEvent.mouseDown(response);
  await act(async () => {});
  expect(viewport.scrollTop).toBe(31);
  view.unmount();
});
