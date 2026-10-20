import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QqSchemeResponseSchema } from "../../src/shared/contracts/qq";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 分区保留容器与滚动节点可以是同一节点，也可以是嵌套两层；两者都按契约断言。 */
const retained = (name: string) => {
  const node = document.querySelector<HTMLElement>(`[data-qq-retained-scroll="${name}"]`);
  if (!node) return null;
  const scroll = node.matches("[data-workspace-scroll]")
    ? node
    : node.querySelector<HTMLElement>("[data-workspace-scroll]");
  return { node, scroll };
};
const hiddenAway = (node: HTMLElement) =>
  node.hasAttribute("hidden") || node.closest("[hidden]") !== null;

describe("workspace sections remain mounted once visited", () => {
  it("retains the schemes and bindings DOM, query state, and scroll nodes while inactive", async () => {
    const scheme = QqSchemeResponseSchema.parse({
      id: "33333333-3333-4333-8333-333333333333",
      name: "滚动保留方案",
      description: null,
      triggers: {
        direct_reply: true,
        follow_up: false,
        chiming_in: true,
        idle_topic: false,
      },
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
      compression: {
        watermark_trigger: 200,
        package_limit: 8,
        headroom_ratio: 0.05,
      },
      output_reserve: {
        judgement_output_reserved: 512,
        reply_output_reserved: 2048,
      },
      stickers: {
        sticker_min_repeat_minutes: 10,
        sticker_recent_avoid_count: 5,
        frequency: "medium",
      },
      sticker_collections: {
        collection_ids: [],
      },
      prompts: {
        scene: "场景",
        judge: "判断",
        reply: "回复",
        review: "复核",
        sticker: "表情",
        media: "媒体",
        compress: "压缩",
      },
      reply: {
        split_by_speaker: true,
      },
      message_settings: {
        reply_mode: "one_then_on_demand",
        reply_depth: 2,
        time_display: "hybrid",
        timezone: "Asia/Shanghai",
      },
      media_input: {
        mode: "native",
        stages: {
          decision: true,
          evaluation: true,
          generation: true,
        },
        max_images: 8,
        ordinary_still_max_dimension: null,
      },
      task_limits: {
        mention_task_limit: 4,
        ordinary_task_limit: 1,
      },
      input_anti_spam: {
        enabled: false,
        burst_min_messages: 3,
        burst_window_seconds: 3,
      },
      revision: 3,
      created_at: "2026-10-18T00:00:00.000Z",
      updated_at: "2026-10-18T00:00:00.000Z",
    });
    setupLibrary({ listQqSchemes: vi.fn().mockResolvedValue([scheme]) });
    const view = render(<SchemesWorkspace />);
    await act(async () => {
      store.setState({ settingsRoute: "qq-app-schemes" });
    });

    const schemes = retained("schemes");
    expect(schemes?.scroll).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索方案"), { target: { value: "保留检索" } });
    schemes!.scroll!.scrollTop = 73;

    await act(async () => store.getState().openSettingsRoute("qq-app-groups"));
    const bindings = retained("groups");
    expect(bindings?.scroll).toBeTruthy();
    // 绑定目录起载是 settings/conversations/bindings/schemes 四读 fail-closed：
    // 看板在读完成前停在读取态，等真实读取落地后再交互。
    await screen.findByLabelText("搜索会话绑定");
    fireEvent.change(screen.getByLabelText("搜索会话绑定"), {
      target: { value: "保留绑定检索" },
    });
    bindings!.scroll!.scrollTop = 41;

    await act(async () => store.getState().openSettingsRoute("qq-connection"));
    expect(hiddenAway(schemes!.node)).toBe(true);
    expect(hiddenAway(bindings!.node)).toBe(true);
    expect(schemes!.node.contains(schemes!.scroll!)).toBe(true);
    expect(bindings!.node.contains(bindings!.scroll!)).toBe(true);
    expect(schemes!.scroll!.scrollTop).toBe(73);
    expect(bindings!.scroll!.scrollTop).toBe(41);
    expect((screen.getByLabelText("搜索方案") as HTMLInputElement).value).toBe("保留检索");
    expect((screen.getByLabelText("搜索会话绑定") as HTMLInputElement).value).toBe("保留绑定检索");

    await act(async () => store.getState().openSettingsRoute("qq-app-schemes"));
    expect(hiddenAway(schemes!.node)).toBe(false);
    expect(schemes!.scroll!.scrollTop).toBe(73);
    view.unmount();
  });

  it("does not mount unvisited section panes until selected", async () => {
    setupLibrary();
    // 初始路由即连接分区：真实根列表此时未访问，合法地不挂载。
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-connection",
    });
    render(<SchemesWorkspace />);
    await act(async () => {});
    expect(document.querySelector('[data-qq-retained-scroll="schemes"]')).toBeNull();
    expect(document.querySelector('[data-qq-retained-scroll="groups"]')).toBeNull();
    await act(async () => store.getState().openSettingsRoute("qq-app-schemes"));
    expect(document.querySelector('[data-qq-retained-scroll="schemes"]')).toBeTruthy();
    expect(document.querySelector('[data-qq-retained-scroll="groups"]')).toBeNull();
  });
});
