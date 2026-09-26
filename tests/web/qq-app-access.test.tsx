// 第三方App接入 (§11.1, P5q).
//
// The page's promises: it never displays the saved token, it reports the transport's own state
// rather than inferring one, it lists what the intake saw plus what was bound by number (a
// manually bound conversation has no observation yet, and the row says so), and it binds through
// compare-and-swap. Each of those is a way this surface could lie to the user, so each one is
// asserted here.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqBindingResponse, QqSettingsResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { ConnectionWorkspace } from "../../src/web/screens/connections/ConnectionWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SILENT_BINDING_ID = "33333333-3333-4333-8333-333333333333";

const settings: QqSettingsResponse = {
  enabled: false,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: "ws://127.0.0.1:3000/", has_token: true },
  revision: 3,
};

const binding: QqBindingResponse = {
  id: BINDING_ID,
  account_id: "10001",
  kind: "group",
  peer_id: "30003",
  agent_id: AGENT_ID,
  scheme_id: SCHEME_ID,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  attention: { mode: "off", members: [] },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 1,
  authority_revision: 1,
};

async function renderPage(
  options: {
    bound?: boolean;
    enabled?: boolean;
    silentBinding?: boolean;
    /** 记忆整理 (2026-09-25): the bound conversation's batch size and its waiting observations. */
    memory?: { batchSize: number | null; pending: number };
  } = {},
) {
  // A binding whose conversation has never spoken: it has no observation row to appear from, so
  // the page has to list it from the bindings themselves (2026-09-25).
  const silentBinding: QqBindingResponse = {
    ...binding,
    id: SILENT_BINDING_ID,
    peer_id: "40004",
  };
  const boundBinding: QqBindingResponse = {
    ...binding,
    memory_batch_size: options.memory?.batchSize ?? binding.memory_batch_size,
    pending_observations: options.memory?.pending ?? binding.pending_observations,
  };
  const fake = {
    ...api,
    getQqSettings: vi
      .fn()
      .mockResolvedValue({ ...settings, enabled: options.enabled ?? settings.enabled }),
    getQqOwner: vi
      .fn()
      .mockResolvedValue({ configured: false, account_id: null, peer_id: null, revision: null }),
    getQqStatus: vi.fn().mockResolvedValue({ connection: { phase: "ready", reason: null } }),
    listQqConversations: vi.fn().mockResolvedValue([
      {
        account_id: "10001",
        kind: "group",
        peer_id: "30003",
        messages: 12,
        last_at_seconds: 2_000_000_000,
        binding_id: options.bound ? BINDING_ID : null,
      },
      {
        account_id: "10001",
        kind: "private",
        peer_id: "20002",
        messages: 3,
        last_at_seconds: 2_000_000_100,
        binding_id: null,
      },
    ]),
    listQqBindings: vi
      .fn()
      .mockResolvedValue([
        ...(options.bound ? [boundBinding] : []),
        ...(options.silentBinding ? [silentBinding] : []),
      ]),
    organiseQqMemory: vi
      .fn()
      .mockResolvedValue({ status: "nothing_to_organise", job_id: null, pending: 0 }),
    updateQqSettings: vi.fn().mockImplementation(async (body: { enabled?: boolean }) => ({
      ...settings,
      enabled: body.enabled ?? settings.enabled,
      revision: 4,
    })),
    updateQqTransport: vi.fn().mockImplementation(async (body: { endpoint?: string }) => ({
      ...settings,
      transport: { endpoint: body.endpoint ?? settings.transport.endpoint, has_token: true },
      revision: 4,
    })),
    createQqBinding: vi.fn().mockResolvedValue(binding),
    updateQqBinding: vi.fn().mockResolvedValue(binding),
    listQqSchemes: vi.fn().mockResolvedValue([
      {
        id: SCHEME_ID,
        name: "本地检查方案",
        description: null,
        triggers: { direct_reply: false, follow_up: false, chiming_in: false, idle_topic: false },
        rhythm: {
          merge_window_seconds: 30,
          reply_cooldown_seconds: 10,
          hourly_speech_limit: 200,
          initiative_min_score: 6,
          idle_quiet_minutes: 15,
          active_hours_enabled: false,
          active_hours_start_minutes: 0,
          active_hours_end_minutes: 1439,
          max_recompute_count: 1,
          max_sticker_count: 1,
          media_supplement_window_minutes: 10,
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
          scene: "",
          judge: "",
          reply: "",
          review: "",
          sticker: "",
          media: "",
        },
        revision: 2,
        created_at: "2026-09-24T00:00:00.000000Z",
        updated_at: "2026-09-24T00:00:00.000000Z",
      },
    ]),
  } as unknown as typeof api;
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "basic",
    agents: [
      {
        id: AGENT_ID,
        name: "本地助手",
        description: "",
        additional_instructions: "",
        model_name: "qwen/qwen3-4b-2507",
        temperature: 0.7,
        memory_consolidation_model_name: null,
        memory_consolidation_prompt: "",
        memory_consolidation_additional_instructions: "",
        memory_retrieval_model_name: null,
        memory_retrieval_prompt: "",
        context_compression_model_name: null,
        p5_config: {},
        is_active: true,
        config_version: 1,
        persona_intensity: 50,
        created_at: "2026-09-24T00:00:00.000000Z",
        updated_at: "2026-09-24T00:00:00.000000Z",
      } as never,
    ],
  });
  render(<ConnectionWorkspace />);
  await act(async () => {});
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("Connection workspace", () => {
  const manage = async () => userEvent.click(screen.getAllByRole("button", { name: "管理" })[0]);
  it("shows transport facts and opens write-only credentials separately", async () => {
    await renderPage();
    expect(screen.getByText("已连接")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "连接设置" }));
    const token = screen.getByLabelText("访问令牌") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.value).toBe("");
  });
  it("preserves bindings with no observed messages and searches their numbers", async () => {
    await renderPage({ silentBinding: true });
    expect(screen.getByText("40004")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索会话绑定"), { target: { value: "40004" } });
    expect(screen.queryByText("30003")).toBeNull();
    expect(screen.getByText("还没有观察到消息")).toBeTruthy();
  });
  it("binds an observed conversation using selected Agent and scheme", async () => {
    const fake = await renderPage();
    await manage();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "绑定" })));
    expect(fake.createQqBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "group",
        peer_id: "30003",
        agent_id: AGENT_ID,
        scheme_id: SCHEME_ID,
      }),
    );
  });
  it("can manually bind before any message arrives", async () => {
    const fake = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "绑定会话" }));
    fireEvent.change(screen.getByLabelText("号码"), { target: { value: "50005" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "绑定这个号码" })));
    expect(fake.createQqBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "10001",
        peer_id: "50005",
        agent_id: AGENT_ID,
        scheme_id: SCHEME_ID,
      }),
    );
  });
  it("uses source revision for pause and tri-state trigger overrides", async () => {
    const fake = await renderPage({ bound: true });
    await manage();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "暂停发言" })));
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      paused: true,
      expected_revision: 1,
    });
    fireEvent.change(screen.getByLabelText("直接回应 的开关"), { target: { value: "off" } });
    await act(async () => {});
    expect(fake.updateQqBinding).toHaveBeenLastCalledWith(BINDING_ID, {
      expected_revision: 1,
      triggers: { ...binding.triggers, direct_reply: false },
    });
  });
  it("replaces the attention list as one revisioned value", async () => {
    const fake = await renderPage({ bound: true });
    await manage();
    await userEvent.click(screen.getByRole("tab", { name: "重要的人" }));
    fireEvent.change(screen.getByLabelText("重要的人模式"), { target: { value: "hard" } });
    fireEvent.change(screen.getByLabelText("重要的人名单"), { target: { value: "123, 456" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存名单" })));
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      attention: { mode: "hard", members: ["123", "456"] },
      expected_revision: 1,
    });
  });
  it("saves transport edits with the read revision", async () => {
    const fake = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "连接设置" }));
    fireEvent.change(screen.getByLabelText("WebSocket 地址"), {
      target: { value: "ws://example.test:3000/" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存接入设置" })));
    expect(fake.updateQqTransport).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "ws://example.test:3000/", expected_revision: 4 }),
    );
  });
});
