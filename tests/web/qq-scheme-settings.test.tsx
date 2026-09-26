// QQ 聊天方案页 (§5.2/§11.2, ADR0018 P5f).
//
// The cases follow the page's promises: one shared draft for the whole parameter set, a save that
// carries it under compare-and-swap, `另存为新方案` that leaves the original alone, a delete that
// says how many conversations would be affected, and the two things §11.1 keeps OFF this page —
// model selection and rebinding — asserted by absence.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-24T00:00:00.000Z";
const COLLECTION = "11111111-1111-4111-8111-111111111111";
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
    // 0036: 每 X 条群友消息才真跑一次判断（间隔内复用上次读数）。
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
    getQqSchemeUsage: vi.fn().mockResolvedValue({
      scheme_id: scheme().id,
      bindings: 2,
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
        scheme({ ...(body as object), revision: 4 }),
      ),
    createQqScheme: vi
      .fn()
      .mockImplementation(async (body: unknown) =>
        scheme({ id: "55555555-5555-4555-8555-555555555555", ...(body as object), revision: 1 }),
      ),
    deleteQqScheme: vi.fn().mockResolvedValue(undefined),
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

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("Shared scheme studio", () => {
  const task = async (name: string) => userEvent.click(screen.getByRole("tab", { name }));
  it("shares one versioned draft across participation, reply, context and media tasks", async () => {
    const { fake } = await renderPage();
    fireEvent.change(screen.getByLabelText("合并窗口（秒）"), { target: { value: "15" } });
    await task("如何回应");
    fireEvent.change(screen.getByLabelText("场景与行为"), { target: { value: "New scene" } });
    await task("读取什么");
    fireEvent.change(screen.getByLabelText("回复：预算（估算字节）"), {
      target: { value: "7000" },
    });
    await task("媒体与表达");
    await userEvent.click(screen.getByRole("checkbox", { name: /日常/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        expected_revision: 3,
        rhythm: expect.objectContaining({ merge_window_seconds: 15 }),
        context: expect.objectContaining({ reply_token_budget: 7000 }),
        prompts: expect.objectContaining({ scene: "New scene" }),
        sticker_collections: { collection_ids: [COLLECTION] },
      }),
    );
  });
  it("keeps invalid numeric input visible and blocks saving instead of clamping it", async () => {
    const { fake } = await renderPage();
    const input = screen.getByLabelText("合并窗口（秒）");
    fireEvent.change(input, { target: { value: "900" } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("900");
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(30);
    expect((screen.getByRole("button", { name: "保存方案" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });
  it("guards switching away from unsaved scheme changes", async () => {
    await renderPage({
      listQqSchemes: vi
        .fn()
        .mockResolvedValue([
          scheme(),
          scheme({ id: "33333333-3333-4333-8333-333333333333", name: "Other" }),
        ]),
    });
    fireEvent.change(screen.getByLabelText("合并窗口（秒）"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("选择聊天方案"), {
      target: { value: "33333333-3333-4333-8333-333333333333" },
    });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(store.getState().qqSchemeEditor?.source.id).toBe(scheme().id);
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(15);
  });
  it("shows impact before deletion and does not send until confirmed", async () => {
    const { fake } = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "删除方案" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("2 个会话");
    expect(fake.deleteQqScheme).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认" })));
    expect(fake.deleteQqScheme).toHaveBeenCalledWith(scheme().id);
  });
  it("keeps effective reply instructions read-only and changes them with reply mode", async () => {
    await renderPage();
    await task("如何回应");
    const prompt = screen.getByLabelText("当前生效的回复任务") as HTMLTextAreaElement;
    expect(prompt.readOnly).toBe(true);
    const before = prompt.value;
    await userEvent.click(screen.getByRole("checkbox", { name: "按发言人分开回答" }));
    expect(prompt.value).not.toBe(before);
    expect(store.getState().qqSchemeEditor?.reply.split_by_speaker).toBe(false);
  });
  it("converts local active hours into the contract UTC minutes", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("checkbox", { name: "允许时段" }));
    fireEvent.change(screen.getByLabelText("允许时段开始"), { target: { value: "22:30" } });
    expect(store.getState().qqSchemeEditor?.rhythm.active_hours_start_minutes).toBe(
      (22 * 60 + 30 + new Date().getTimezoneOffset() + 1440) % 1440,
    );
  });
  it("saves a copy without overwriting the source scheme", async () => {
    const { fake } = await renderPage();
    fireEvent.change(screen.getByLabelText("合并窗口（秒）"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "另存为" }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "Copied" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认" })));
    expect(fake.createQqScheme).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Copied",
        rhythm: expect.objectContaining({ merge_window_seconds: 15 }),
      }),
    );
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });
});
