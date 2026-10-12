import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import { QqBindingResponseSchema, type QqSchemeResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { BindingEditor } from "../../src/web/screens/connections/binding-editor";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-10-12T00:00:00.000Z";
const SCHEME = "22222222-2222-4222-8222-222222222222";
const BINDING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: SCHEME,
  name: "Default",
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
    scene: "scene",
    judge: "judge",
    reply: "reply",
    review: "review",
    sticker: "sticker",
    media: "media",
    compress: "compress",
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
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: true, burst_min_messages: 3, burst_window_seconds: 3 },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});
const binding = QqBindingResponseSchema.parse({
  id: BINDING,
  account_id: "10001",
  kind: "group",
  peer_id: "30003",
  agent_id: AGENT,
  scheme_id: SCHEME,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 1,
  authority_revision: 1,
  attention: { mode: "off", members: [] },
  task_limits: { mention_task_limit: null, ordinary_task_limit: null },
  input_anti_spam: { enabled: null, burst_min_messages: null, burst_window_seconds: null },
});
const agent = AgentResponseSchema.parse({
  id: AGENT,
  name: "Assistant",
  model_name: "model",
  config_version: 1,
  persona_intensity: 60,
  created_at: NOW,
  updated_at: NOW,
  p5_config: { recent_turns: 12 },
});
const conversation = {
  account_id: "10001",
  kind: "group" as const,
  peer_id: "30003",
  messages: 1,
  last_at_seconds: 0,
  binding_id: BINDING,
};
function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME, bindings: 0 }),
    listQqStickerCollections: vi.fn().mockResolvedValue([]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    updateQqScheme: vi
      .fn()
      .mockImplementation(async (_id: string, body: object) => scheme({ ...body, revision: 4 })),
    updateQqBinding: vi.fn().mockImplementation(async (_id: string, body: object) => ({
      ...binding,
      ...body,
      revision: 2,
    })),
    ...overrides,
  } as unknown as typeof api;
}
async function renderStudio(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
  });
  render(<SchemeStudio />);
  await act(async () => {});
  return fake;
}
async function renderBinding(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
    qqSchemes: [scheme()],
    qqBindings: [binding],
    agents: [agent],
  });
  render(<BindingEditor conversation={conversation} binding={binding} onClose={vi.fn()} />);
  await act(async () => {});
  return fake;
}
beforeEach(() => selectLocale("zh-CN"));
afterEach(() => cleanup());

describe("QQ anti-spam threshold inputs", () => {
  it("saves scheme threshold fields in the existing input_anti_spam group", async () => {
    const fake = await renderStudio();
    fireEvent.change(screen.getByLabelText("纯图片消息最少条数"), { target: { value: "4" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      SCHEME,
      expect.objectContaining({
        input_anti_spam: { enabled: true, burst_min_messages: 4, burst_window_seconds: 3 },
        rhythm: scheme().rhythm,
        context: scheme().context,
        media_input: scheme().media_input,
        expected_revision: 3,
      }),
    );
  });
  it("blocks a scheme save when either raw threshold is invalid", async () => {
    const fake = await renderStudio();
    fireEvent.change(screen.getByLabelText("纯图片消息最少条数"), { target: { value: "1" } });
    fireEvent.blur(screen.getByLabelText("纯图片消息最少条数"));
    fireEvent.change(screen.getByLabelText("首尾时间窗（秒）"), { target: { value: "31" } });
    fireEvent.blur(screen.getByLabelText("首尾时间窗（秒）"));
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "保存方案" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });
  it("saves one binding override while keeping the other threshold following the scheme", async () => {
    const fake = await renderBinding();
    fireEvent.change(screen.getByLabelText("会话纯图片消息最少条数"), { target: { value: "7" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存改绑" })));
    expect(fake.updateQqBinding).toHaveBeenCalledWith(
      BINDING,
      expect.objectContaining({
        input_anti_spam: { enabled: null, burst_min_messages: 7, burst_window_seconds: null },
        expected_revision: 1,
      }),
    );
  });
  it("shows invalid binding raw values and blocks saving them", async () => {
    const fake = await renderBinding();
    const minimum = screen.getByLabelText("会话纯图片消息最少条数") as HTMLInputElement;
    const window = screen.getByLabelText("会话首尾时间窗（秒）") as HTMLInputElement;
    fireEvent.change(minimum, { target: { value: "1" } });
    fireEvent.change(window, { target: { value: "31.5" } });
    expect(minimum.value).toBe("1");
    expect(window.value).toBe("31.5");
    expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(2);
    expect((screen.getByRole("button", { name: "保存改绑" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(fake.updateQqBinding).not.toHaveBeenCalled();
    fireEvent.change(minimum, { target: { value: "8" } });
    fireEvent.change(window, { target: { value: "10" } });
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存改绑" })));
    expect(fake.updateQqBinding).toHaveBeenCalledWith(
      BINDING,
      expect.objectContaining({
        input_anti_spam: { enabled: null, burst_min_messages: 8, burst_window_seconds: 10 },
      }),
    );
  });
  it("allows each binding threshold to independently follow the scheme", async () => {
    const fake = await renderBinding();
    fireEvent.change(screen.getByLabelText("会话纯图片消息最少条数"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("会话首尾时间窗（秒）"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("会话纯图片消息最少条数"), { target: { value: "" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存改绑" })));
    expect(fake.updateQqBinding).toHaveBeenCalledWith(
      BINDING,
      expect.objectContaining({
        input_anti_spam: { enabled: null, burst_min_messages: null, burst_window_seconds: 9 },
        expected_revision: 1,
      }),
    );
  });
});
