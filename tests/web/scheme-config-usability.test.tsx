// The preview speaks the page's labels but never rewrites the user's own text.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { qqSchemeChanges, qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { selectLocale, translate } from "../../src/web/i18n";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-24T00:00:00.000Z";
const COLLECTION = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_COLLECTION = "99999999-9999-4999-8999-999999999999";

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
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

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: scheme().id, bindings: 0 }),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqStickerCollections: vi
      .fn()
      .mockResolvedValue([
        { id: COLLECTION, name: "日常", description: null, revision: 1, asset_count: 1 },
      ]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    updateQqScheme: vi
      .fn()
      .mockImplementation(async (id: string, body: unknown) =>
        scheme({ id, ...(body as object), revision: 4 }),
      ),
    ...overrides,
  } as unknown as typeof api;
}

async function renderPage(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
  });
  render(<SchemeStudio />);
  await act(async () => {});
  return { fake };
}

/** The dialog row whose field cell reads exactly `label` (or the raw key for unknown fields). */
const row = (dialog: HTMLElement, label: string) =>
  within(dialog).getByText(label).closest("tr") as HTMLTableRowElement;

const previewCells = (dialog: HTMLElement, label: string) =>
  within(row(dialog, label))
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

async function expectPreviewFollowsTheForm() {
  await renderPage();
  await userEvent.click(
    screen.getByRole("tab", { name: translate("schemes.sections.historyCompression") }),
  );
  const headroom = screen.getByLabelText(
    translate("connections.assemblyHeadroomPercent"),
  ) as HTMLInputElement;
  expect(headroom.value).toBe("5");
  fireEvent.change(headroom, { target: { value: "10" } });
  expect(store.getState().qqSchemeEditor?.compression.headroom_ratio).toBe(0.1);
  await userEvent.click(
    screen.getByRole("tab", { name: translate("schemes.sections.participation") }),
  );
  await userEvent.click(
    screen.getByRole("checkbox", { name: translate("connections.allowedHours") }),
  );
  const start = screen.getByLabelText(
    translate("connections.allowedHoursStart"),
  ) as HTMLInputElement;
  const startBefore = start.value;
  fireEvent.change(start, { target: { value: "09:30" } });
  if (start.value === startBefore) fireEvent.change(start, { target: { value: "10:00" } });
  const startAfter = start.value;
  expect(startAfter).not.toBe(startBefore);
  const end = screen.getByLabelText(translate("connections.allowedHoursEnd")) as HTMLInputElement;
  const endBefore = end.value;
  fireEvent.change(end, { target: { value: "21:45" } });
  const endAfter = end.value;
  expect(endAfter).not.toBe(endBefore);
  await userEvent.click(screen.getByRole("tab", { name: translate("schemes.sections.response") }));
  fireEvent.change(screen.getByLabelText(translate("connections.sceneAndBehaviour")), {
    target: { value: "0.05/true/开/关" },
  });
  fireEvent.click(screen.getByRole("button", { name: translate("connections.reviewChanges") }));
  const dialog = screen.getByRole("dialog");
  expect(previewCells(dialog, translate("connections.assemblyHeadroomPercent"))).toEqual([
    translate("connections.assemblyHeadroomPercent"),
    "5",
    "10",
  ]);
  const startCells = previewCells(dialog, translate("connections.allowedHoursStart"));
  expect(startCells[1]).toBe(startBefore);
  expect(startCells[2]).toBe(startAfter);
  const endCells = previewCells(dialog, translate("connections.allowedHoursEnd"));
  expect(endCells[1]).toBe(endBefore);
  expect(endCells[2]).toBe(endAfter);
  const sceneCells = previewCells(dialog, translate("connections.sceneAndBehaviour"));
  expect(sceneCells[2]).toBe("0.05/true/开/关");
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("Scheme change preview usability", () => {
  it("keeps change values language-neutral at the rule level", () => {
    const editor = qqSchemeEditorFrom(scheme());
    expect(qqSchemeChanges({ ...editor, reply: { split_by_speaker: false } })).toEqual([
      { field: "reply.split_by_speaker", before: "true", after: "false" },
    ]);
  });

  it("previews changes under the page's field names instead of internal keys", async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText("合并窗口（秒）"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "更安静" } });
    fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("rhythm.merge_window_seconds")).toBeNull();
    const merge = row(dialog, "合并窗口（秒）");
    expect(within(merge).getByText("30")).toBeTruthy();
    expect(within(merge).getByText("15")).toBeTruthy();
    expect(row(dialog, "说明")).toBeTruthy();
  });

  it("labels only real switches on/off and leaves text that reads true or 开/关 untouched", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("checkbox", { name: /^直接回应/ }));
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "true" } });
    await userEvent.click(screen.getByRole("tab", { name: "回复方式" }));
    fireEvent.change(screen.getByLabelText("场景与行为"), { target: { value: "开/关/true" } });
    fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
    const dialog = screen.getByRole("dialog");
    const trigger = row(dialog, "直接回应");
    expect(within(trigger).getByText("开")).toBeTruthy();
    expect(within(trigger).getByText("关")).toBeTruthy();
    expect(within(row(dialog, "说明")).getByText("true")).toBeTruthy();
    expect(within(row(dialog, "场景与行为")).getByText("开/关/true")).toBeTruthy();
  });

  it("renders labels, switches and untouched prompt text the same in English", async () => {
    selectLocale("en");
    await renderPage();
    await userEvent.click(screen.getByRole("checkbox", { name: /^Direct replies/ }));
    await userEvent.click(screen.getByRole("tab", { name: "Reply style" }));
    fireEvent.change(screen.getByLabelText("Scene and behaviour"), { target: { value: "true" } });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("triggers.direct_reply")).toBeNull();
    expect(within(dialog).queryByText("prompts.scene")).toBeNull();
    const trigger = row(dialog, "Direct replies");
    expect(within(trigger).getByText("On")).toBeTruthy();
    expect(within(trigger).getByText("Off")).toBeTruthy();
    expect(within(row(dialog, "Scene and behaviour")).getByText("true")).toBeTruthy();
  });

  it("shows collection names for ids and keeps ids it cannot resolve", async () => {
    await renderPage({
      listQqSchemes: vi
        .fn()
        .mockResolvedValue([
          scheme({ sticker_collections: { collection_ids: [COLLECTION, UNKNOWN_COLLECTION] } }),
        ]),
    });
    await userEvent.click(screen.getByRole("tab", { name: "表情发送" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /^日常/ }));
    fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
    const dialog = screen.getByRole("dialog");
    const collections = row(dialog, "授权集合");
    expect(within(collections).getByText(`日常、${UNKNOWN_COLLECTION}`)).toBeTruthy();
    expect(within(collections).getByText(UNKNOWN_COLLECTION)).toBeTruthy();
  });

  it("falls back to the raw key for unmapped fields and never saves on a patch", async () => {
    const { fake } = await renderPage();
    fireEvent.change(screen.getByLabelText("合并窗口（秒）"), { target: { value: "15" } });
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    store.getState().patchQqSchemeGroup("rhythm", { judgement_interval_turns: 5 });
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("rhythm.judgement_interval_turns")).toBeTruthy();
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭弹窗" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        expected_revision: 3,
        rhythm: expect.objectContaining({ merge_window_seconds: 15, judgement_interval_turns: 5 }),
      }),
    );
  });

  it("previews percent and local-clock times as the form shows them, prompt text verbatim", async () => {
    await expectPreviewFollowsTheForm();
  });

  it("previews the same conversions in English", async () => {
    selectLocale("en");
    await expectPreviewFollowsTheForm();
  });

  it("keeps every prompt slot editable and carries all of them in the save payload", async () => {
    const { fake } = await renderPage();
    const slots: [string, string, string][] = [
      ["schemes.sections.participation", "connections.judgementTask", "judge-edited"],
      ["schemes.sections.response", "connections.effectiveReplyTask", "reply-edited"],
      ["schemes.sections.response", "connections.sceneAndBehaviour", "scene-edited"],
      ["schemes.sections.response", "connections.reviewTask", "review-edited"],
      [
        "schemes.sections.historyCompression",
        "connections.watermarkCompressionTask",
        "compress-edited",
      ],
      ["schemes.sections.stickerSending", "connections.stickerTask", "sticker-edited"],
      ["schemes.sections.imageUnderstanding", "connections.mediaNoteTask", "media-edited"],
    ];
    for (const [tabKey, labelKey, value] of slots) {
      await userEvent.click(screen.getByRole("tab", { name: translate(tabKey) }));
      const box = screen.getByLabelText(translate(labelKey)) as HTMLTextAreaElement;
      expect(box.readOnly).toBe(false);
      expect(box.disabled).toBe(false);
      fireEvent.change(box, { target: { value } });
    }
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        prompts: {
          scene: "scene-edited",
          judge: "judge-edited",
          reply: "reply-edited",
          review: "review-edited",
          sticker: "sticker-edited",
          media: "media-edited",
          compress: "compress-edited",
        },
      }),
    );
  });
});
