// 第三方App接入 (§11.1, P5q).
//
// The page's promises: it never displays the saved token, it reports the transport's own state
// rather than inferring one, it lists what the intake saw plus what was bound by number (a
// manually bound conversation has no observation yet, and the row says so), and it binds through
// compare-and-swap. Each of those is a way this surface could lie to the user, so each one is
// asserted here.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqBindingResponse, QqSettingsResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { QqAppAccess } from "../../src/web/features/qq/QqAppAccess";
import { selectLocale } from "../../src/web/i18n";
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
  render(<QqAppAccess />);
  await act(async () => {});
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("第三方App接入", () => {
  it("报运行中传输的状态，不显示已保存的令牌", async () => {
    await renderPage();
    expect(screen.getByText("已连接")).toBeTruthy();
    // The saved token is a fact ("已保存令牌"), never a value.
    expect(screen.getByText("已保存令牌")).toBeTruthy();
    const token = screen.getByLabelText("访问令牌") as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.type).toBe("password");
  });

  it("列出观察到的会话，未绑定的给出绑定按钮", async () => {
    await renderPage();
    expect(screen.getByText(/群 30003/)).toBeTruthy();
    expect(screen.getByText(/私聊 20002/)).toBeTruthy();
    expect(screen.getAllByText("未绑定")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "绑定" })).toHaveLength(2);
  });

  it("绑定会话时带上当前选择的助手与方案，并说明成功了", async () => {
    const fake = await renderPage();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "绑定" })[0] as HTMLButtonElement);
    });
    expect(fake.createQqBinding).toHaveBeenCalledWith({
      account_id: "10001",
      kind: "group",
      peer_id: "30003",
      agent_id: AGENT_ID,
      scheme_id: SCHEME_ID,
      paused: false,
      memory_batch_size: null,
      share_web_memory: false,
    });
    expect(await screen.findByText("已绑定会话")).toBeTruthy();
  });

  it("用号码直接绑定一个还没说过话的会话，账号取自已保存的设置", async () => {
    const fake = await renderPage();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("号码"), { target: { value: " 40004 " } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "绑定这个号码" }));
    });
    expect(fake.createQqBinding).toHaveBeenCalledWith({
      account_id: "10001",
      kind: "group",
      peer_id: "40004",
      agent_id: AGENT_ID,
      scheme_id: SCHEME_ID,
      paused: false,
      memory_batch_size: null,
      share_web_memory: false,
    });
    // The field is cleared so the next number does not have to be edited out of the last one.
    expect((screen.getByLabelText("号码") as HTMLInputElement).value).toBe("");
  });

  it("已绑定但还没说过话的会话照样列出，如实说没有观察到消息", async () => {
    await renderPage({ silentBinding: true });
    expect(screen.getByText(/群 40004/)).toBeTruthy();
    expect(screen.getByText("还没有观察到消息")).toBeTruthy();
    expect(screen.getByText("参与中")).toBeTruthy();
  });

  it("保存「重要的人」名单：整组替换，号码按常见分隔符拆开", async () => {
    const fake = await renderPage({ bound: true });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("重要的人模式"), { target: { value: "soft" } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("重要的人名单"), {
        target: { value: "20002，30003 20002" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存名单" }));
    });
    // The server deduplicates and sorts; the page never invents a member of its own.
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      attention: { mode: "soft", members: ["20002", "30003", "20002"] },
      expected_revision: 1,
    });
  });

  it("暂停与改绑带页面读到的修订号，避免覆盖别人刚保存的结果", async () => {
    const fake = await renderPage({ bound: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "暂停发言" }));
    });
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      paused: true,
      expected_revision: 1,
    });
  });

  it("记忆整理行：显示待整理条数，保存条数走比较交换", async () => {
    const fake = await renderPage({ bound: true, memory: { batchSize: 20, pending: 5 } });
    expect(screen.getByText("待整理 5 条")).toBeTruthy();
    expect((screen.getByLabelText("自动整理条数") as HTMLInputElement).value).toBe("20");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("自动整理条数"), { target: { value: "30" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存条数" }));
    });
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      memory_batch_size: 30,
      expected_revision: 1,
    });
  });

  it("清空条数并保存＝关掉自动整理（null 是一个值，不是“没改”）", async () => {
    const fake = await renderPage({ bound: true, memory: { batchSize: 20, pending: 5 } });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("自动整理条数"), { target: { value: "" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存条数" }));
    });
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      memory_batch_size: null,
      expected_revision: 1,
    });
  });

  it("立即整理把判决写在这一行，排队后重新读一遍列表", async () => {
    const fake = await renderPage({
      bound: true,
      enabled: true,
      memory: { batchSize: null, pending: 3 },
    });
    vi.mocked(fake.organiseQqMemory).mockResolvedValueOnce({
      status: "queued",
      job_id: null,
      pending: 3,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "立即整理" }));
    });
    expect(fake.organiseQqMemory).toHaveBeenCalledWith(BINDING_ID);
    expect(await screen.findByText("已交给整理任务，跑完会出现在记忆列表里。")).toBeTruthy();
    // A queued job consumes the batch at enqueue time, so the count is re-read rather than patched.
    expect(vi.mocked(fake.listQqBindings).mock.calls.length).toBeGreaterThan(1);
  });

  it("立即整理的拒绝也是一种答复，不是错误", async () => {
    const fake = await renderPage({
      bound: true,
      enabled: true,
      memory: { batchSize: null, pending: 2 },
    });
    vi.mocked(fake.organiseQqMemory).mockResolvedValueOnce({
      status: "paused",
      job_id: null,
      pending: 2,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "立即整理" }));
    });
    expect(await screen.findByText("这个会话已暂停，暂停期间不新增整理任务。")).toBeTruthy();
    // Refused: nothing was consumed, so no reload is expected from this action.
    expect(vi.mocked(fake.listQqBindings).mock.calls.length).toBe(1);
  });

  it("保存接入参数时使用页面读到的修订号", async () => {
    const fake = await renderPage();
    // 2026-09-25：总开关搬到运行模式页的模式行（这一页只配置连接与绑定），所以这里只钉参数保存。
    await act(async () => {
      fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: "new-token" } });
      fireEvent.click(screen.getByRole("button", { name: "保存接入设置" }));
    });
    expect(fake.updateQqTransport).toHaveBeenCalledWith({
      endpoint: "ws://127.0.0.1:3000/",
      token: "new-token",
      expected_revision: 4,
    });
    // The saved token is never echoed back into the field.
    expect((screen.getByLabelText("访问令牌") as HTMLInputElement).value).toBe("");
  });
});
