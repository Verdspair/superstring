import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { selectLocale, translate } from "../../src/web/i18n";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

const NOW = "2026-09-24T00:00:00.000Z";
const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: "22222222-2222-4222-8222-222222222222",
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
  },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  // 0059：两组响应必填；夹具代表既有已保存方案，防抖按旧列默认显式关（新建默认开）。
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
  ...overrides,
});

function setupStudio(usage: number | null = 0) {
  setupLibrary();
  const source = scheme();
  store.setState({
    qqSchemes: [source],
    qqSchemeEditor: qqSchemeEditorFrom(source),
    qqSchemeUsage: usage === null ? null : { schemeId: source.id, bindings: usage },
    qqStickerCollections: [],
  });
}

beforeEach(() => {
  selectLocale("zh-CN");
  setupStudio();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("scheme studio task layout", () => {
  it.each(["zh-CN", "en"])("uses the parent heading when embedded in %s", async (locale) => {
    selectLocale(locale as "zh-CN" | "en");
    render(
      <>
        <h1>Current scheme</h1>
        <SchemeStudio active={false} embedded />
      </>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Current scheme");
    expect(screen.getByRole("button", { name: translate("connections.saveScheme") })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: translate("connections.reviewChanges") }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: translate("connections.discardChanges") }),
    ).toBeTruthy();
  });

  it("places current scheme and management before six directly available tasks", () => {
    render(<SchemeStudio active={false} embedded />);
    const name = screen.getByLabelText(translate("connections.schemeName"));
    const tasks = screen.getByRole("tablist");
    expect(name.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText(translate("connections.description"))).toBeTruthy();
    const tabs = within(tasks).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("data-state"))).toEqual([
      "active",
      "inactive",
      "inactive",
      "inactive",
      "inactive",
      "inactive",
    ]);
    for (const key of [
      "connections.create",
      "connections.saveAs",
      "schemes.studio.refresh",
      "connections.deleteScheme",
    ]) {
      expect(screen.getByRole("button", { name: translate(key) })).toBeTruthy();
    }
  });

  it("keeps scheme selection and refresh on their existing guarded actions", () => {
    const navigate = vi.fn();
    const refresh = vi.fn().mockResolvedValue(true);
    const other = scheme({ id: "33333333-3333-4333-8333-333333333333", name: "Other" });
    store.setState({
      qqSchemes: [scheme(), other],
      requestQqSchemeNavigation: navigate,
      refreshQqScheme: refresh,
    });
    render(<SchemeStudio active={false} embedded />);
    fireEvent.change(
      screen.getByRole("combobox", { name: translate("connections.chooseAChatScheme") }),
      {
        target: { value: other.id },
      },
    );
    expect(navigate).toHaveBeenCalledWith(other.id);
    fireEvent.click(screen.getByRole("button", { name: translate("schemes.studio.refresh") }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows image specifications and phase switches directly, with their own stored values", async () => {
    render(<SchemeStudio active={false} embedded />);
    await userEvent.click(
      screen.getByRole("tab", { name: translate("schemes.sections.imageUnderstanding") }),
    );
    expect(
      screen.getByRole("spinbutton", { name: translate("connections.maxAutoImages") }),
    ).toBeTruthy();
    expect(
      document
        .getElementById("scheme-field-rhythm.media_frame_count")
        ?.closest('[data-state="closed"]'),
    ).toBeNull();
    expect(document.getElementById("scheme-field-rhythm.media_max_dimension")).toBeTruthy();
    expect(document.getElementById("scheme-field-mediaInput.mode")).toBeTruthy();
    for (const phase of ["Decision", "Evaluation", "Generation"]) {
      expect(
        screen.getByRole("checkbox", { name: translate(`schemes.studio.stage${phase}`) }),
      ).toBeTruthy();
    }
    expect(screen.getByLabelText(translate("connections.mediaNoteTask"))).toBeTruthy();
  });

  it("keeps deletion disabled for unknown usage and requires confirmation for a known unused scheme", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    store.setState({ qqSchemeUsage: null, deleteQqScheme: remove });
    render(<SchemeStudio active={false} embedded />);
    const deleteButton = screen.getByRole("button", {
      name: translate("connections.deleteScheme"),
    }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(screen.getByText(translate("schemes.studio.usageUnknownCannotDelete"))).toBeTruthy();
    await act(async () => {
      store.setState({ qqSchemeUsage: { schemeId: scheme().id, bindings: 0 } });
    });
    await userEvent.click(deleteButton);
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("alertdialog").textContent).toContain(scheme().name);
  });
});
