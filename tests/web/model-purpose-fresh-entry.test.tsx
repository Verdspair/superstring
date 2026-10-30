import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QqSchemeResponseSchema } from "../../src/shared/contracts/qq";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, setupLibrary } from "./helpers/library-fixture";

/** 显式 tooltip（保存按钮/字段帮助）必须挂在真实 DesignSystemProvider 下渲染。 */
const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

function coldStore(settingsRoute: "context" | "scheme-library" = "context") {
  const client = setupLibrary({
    listModelProviders: vi.fn().mockResolvedValue([]),
    getLocalModelEncodings: vi.fn().mockResolvedValue({ revision: "fixture", models: [] }),
    getModelCapacity: vi
      .fn()
      .mockResolvedValue({ model: "model-a", status: "loaded", context_length: 65536 }),
  });
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute,
    pageEditor: null,
    editorDraft: null,
    editorAgentId: "__new__",
    agents: [agent],
    qqSchemes: [],
    qqSchemesLoaded: false,
    qqBindings: [],
    qqBindingsLoaded: false,
    qqSchemeEditor: null,
    dirty: false,
  });
  return client;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("hydrates the current Agent through the assistant capability entry without a preloaded editor", async () => {
  const client = coldStore();
  store.setState({ editorAgentId: A });
  render(<AssistantWorkspace active={true} />);
  await waitFor(() => expect(store.getState().pageEditor?.agent.id).toBe(A));
  expect(screen.getByLabelText("对话模型")).toBeTruthy();
  expect(screen.getByLabelText("本助手请求上限")).toBeTruthy();
  expect(client.getAgent).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("对话模型"), { target: { value: "model-b" } });
  expect(store.getState().pageEditor?.draft.model_name).toBe("model-b");
});

it("loads QQ catalog and bindings before landing a cold QQ target in the shared scheme detail", async () => {
  const client = coldStore("scheme-library");
  const row = QqSchemeResponseSchema.parse({
    id: "10000000-0000-4000-8000-000000000001",
    name: "默认群聊方案",
    description: "标准群聊回复与参与设置",
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
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
    stickers: {
      sticker_min_repeat_minutes: 10,
      sticker_recent_avoid_count: 5,
      frequency: "medium",
    },
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
    reply: { split_by_speaker: true },
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
    input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
    allocation: { judgement: { mode: "fixed" }, reply: { mode: "fixed" } },
    revision: 3,
    created_at: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T00:00:00.000Z",
  });
  vi.mocked(client.listQqSchemes).mockResolvedValue([row]);
  vi.mocked(client.listQqBindings).mockResolvedValue([]);
  await act(async () => {
    store.getState().requestContextAllocation({
      purpose: "qq",
      schemeId: row.id,
      returnRoute: "scheme-library",
    });
  });
  await waitFor(() => expect(store.getState().settingsRoute).toBe("qq-scheme-config"));
  expect(store.getState().qqSchemeEditor?.source.id).toBe(row.id);
  expect(client.listQqSchemes).toHaveBeenCalledTimes(1);
  expect(client.listQqBindings).toHaveBeenCalledTimes(1);
  // 真实方案详情宿主：预算输入仍在消息读取任务，不落模型服务页。
  // Radix Tabs 由 mousedown 激活；jsdom 的 click 不派发 mousedown（与 qq-scheme-save-lifecycle 同口径）。
  render(<SchemeStudio />);
  const contextTab = screen.getByRole("tab", { name: "消息读取" });
  fireEvent.mouseDown(contextTab, { button: 0 });
  fireEvent.click(contextTab);
  expect(await screen.findByLabelText("判断：预算（估算字节）")).toBeTruthy();
});

it("names the reading save action for its complete Agent context scope", async () => {
  coldStore();
  await act(async () => {
    store.getState().requestContextAllocation({ purpose: "reading", agentId: A });
  });
  await waitFor(() => expect(store.getState().pageEditor?.agent.id).toBe(A));
  expect(store.getState().settingsRoute).toBe("memory-tools");
  render(<AssistantWorkspace active={true} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存 Agent" })).toBeTruthy());
  expect(screen.getByRole("tab", { name: "资料读取" }).getAttribute("data-state")).toBe("active");
});
