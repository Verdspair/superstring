import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqBindingResponse, QqSettingsResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SCHEME_ID = "22222222-2222-4222-8222-222222222223";
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

const scheme = {
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
};
const otherScheme = { ...scheme, id: OTHER_SCHEME_ID, name: "备用方案" };

const agent = {
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
} as never;

function client(
  options: {
    bound?: boolean;
    enabled?: boolean;
    silentBinding?: boolean;
    /** 记忆整理（语义保留）：绑定会话的批大小与等待观察数。 */
    memory?: { batchSize: number | null; pending: number };
    /** 本人身份卡：机器人账号未设置时给原因说明（账号决定可编辑性）。 */
    accountSet?: boolean;
  } = {},
  overrides: Partial<typeof api> = {},
) {
  // 从未发言过的绑定：没有观察行可显示，绑定板必须从绑定本身列出它。
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
  return {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue({
      ...settings,
      enabled: options.enabled ?? settings.enabled,
      account_id: (options.accountSet ?? true) ? settings.account_id : null,
    }),
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
    listQqSchemes: vi.fn().mockResolvedValue([scheme, otherScheme]),
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
    ...overrides,
  } as unknown as typeof api;
}

async function renderBindings(
  options: Parameters<typeof client>[0] = {},
  overrides: Partial<typeof api> = {},
) {
  const fake = client(options, overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "scheme-bindings",
    agents: [agent],
  });
  render(<SchemesWorkspace />);
  await act(async () => {});
  return fake;
}

const openManage = async () => {
  await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "管理" })[0]));
};

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("scheme bindings (详情「使用会话」与全局「会话绑定」共用视图)", () => {
  it("keeps a binding with no observed messages and scopes the board by the chosen scheme", async () => {
    await renderBindings({ silentBinding: true });
    expect(screen.getByText("40004")).toBeTruthy();
    expect(screen.getByText("还没有观察到消息")).toBeTruthy();
    // 绑定板只列绑定，不把观察目录整表搬来。
    expect(screen.queryByText("30003")).toBeNull();
    // 原「按号码搜索」控件已随接入页移除；列表过滤由视图上真实存在的方案选择器承接。
    const picker = screen.getByLabelText(i18n.t("schemes.bindings.chooseScheme"));
    fireEvent.change(picker, { target: { value: OTHER_SCHEME_ID } });
    expect(screen.queryByText("40004")).toBeNull();
    fireEvent.change(picker, { target: { value: SCHEME_ID } });
    expect(screen.getByText("40004")).toBeTruthy();
  });

  it("binds an observed conversation with an explicitly selected Agent and scheme", async () => {
    const fake = await renderBindings();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("schemes.bindings.add") }));
    const dialog = () => within(screen.getByRole("dialog"));
    fireEvent.change(dialog().getByLabelText(i18n.t("schemes.bindings.pickConversation")), {
      target: { value: "10001:group:30003" },
    });
    // 绑定 Agent 与方案必需：Agent 未显式选择前不可提交，方案默认当前方案。
    const bind = () => dialog().getByRole("button", { name: "绑定" }) as HTMLButtonElement;
    expect(bind().disabled).toBe(true);
    expect((dialog().getByLabelText("方案") as HTMLSelectElement).value).toBe(SCHEME_ID);
    fireEvent.change(dialog().getByLabelText("Agent"), { target: { value: AGENT_ID } });
    expect(bind().disabled).toBe(false);
    await act(async () => fireEvent.click(bind()));
    expect(fake.createQqBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "group",
        peer_id: "30003",
        agent_id: AGENT_ID,
        scheme_id: SCHEME_ID,
      }),
    );
  });

  it("can manually bind a number that has never been observed", async () => {
    const fake = await renderBindings();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("schemes.bindings.add") }));
    const dialog = () => within(screen.getByRole("dialog"));
    fireEvent.change(dialog().getByLabelText("号码"), { target: { value: "50005" } });
    fireEvent.change(dialog().getByLabelText("Agent"), { target: { value: AGENT_ID } });
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: "绑定" })));
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
    const fake = await renderBindings({ bound: true });
    await openManage();
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
    const fake = await renderBindings({ bound: true });
    await openManage();
    // 四组平铺后无内层 Tab：重要人物卡直出。
    fireEvent.change(screen.getByLabelText("重要的人模式"), { target: { value: "hard" } });
    fireEvent.change(screen.getByLabelText("重要的人名单"), { target: { value: "123, 456" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存名单" })));
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      attention: { mode: "hard", members: ["123", "456"] },
      expected_revision: 1,
    });
  });

  it("keeps the binding memory controls on the editor's memory tab", async () => {
    await renderBindings({ bound: true });
    await openManage();
    // 四组平铺后无内层 Tab：记忆整理卡直出。
    expect(screen.getByText("待整理 0 条")).toBeTruthy();
    expect(screen.getByLabelText("自动整理批次（留空关闭）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存批次" })).toBeTruthy();
  });
});

describe("QQ connection page (本人身份依赖机器人账号)", () => {
  const renderConnection = async (
    options: Parameters<typeof client>[0] = {},
    overrides: Partial<typeof api> = {},
  ) => {
    const fake = client(options, overrides);
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-connection",
    });
    render(<SchemesWorkspace />);
    await act(async () => {});
    return fake;
  };

  it("explains why the owner identity cannot be edited until the bot account is set", async () => {
    await renderConnection({ accountSet: false });
    // locale 键必须真实存在（缺键时 i18n.t 回显键名，不算通过）。
    const reason = i18n.t("connections.owner.accountRequired");
    expect(reason).not.toBe("connections.owner.accountRequired");
    expect(screen.getByText(reason)).toBeTruthy();
    const input = screen.getByLabelText(i18n.t("connections.owner.title")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    // 原因与用法提示都挂到输入框的可访问描述上（aria-describedby 真实关联）。
    const described = (input.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain(i18n.t("connections.owner.hint"));
    expect(described).toContain(i18n.t("connections.owner.accountRequired"));
  });

  it("groups the immediate switch, the explicit access save and the independent owner card", async () => {
    await renderConnection({ accountSet: true });
    // 即时参与开关自成一卡：开关与它的标题同卡，不与显式保存组混在一起。
    const enabled = screen.getByRole("checkbox", { name: i18n.t("connections.enableQq") });
    const switchCard = enabled.closest('[data-slot="card"]');
    expect(switchCard?.textContent).toContain(i18n.t("connections.participateInExternalChats"));
    expect(switchCard?.textContent).not.toContain(i18n.t("connections.saveAccessSettings"));
    // 账号/端点/令牌与「保存接入设置」同卡：显式保存域收尾于本组。
    const accessCard = screen
      .getByLabelText(i18n.t("connections.assistantAccount"))
      .closest('[data-slot="card"]');
    expect(accessCard?.textContent).toContain(i18n.t("connections.websocketAddress"));
    expect(accessCard?.textContent).toContain(i18n.t("connections.accessToken"));
    expect(
      within(accessCard as HTMLElement).getByRole("button", {
        name: i18n.t("connections.saveAccessSettings"),
      }),
    ).toBeTruthy();
    // 本人身份是独立保存卡：保存本人身份不在接入卡里。
    const ownerCard = screen
      .getByLabelText(i18n.t("connections.owner.title"))
      .closest('[data-slot="card"]');
    expect(ownerCard).not.toBe(accessCard);
    expect(
      within(ownerCard as HTMLElement).getByRole("button", {
        name: i18n.t("connections.owner.save"),
      }),
    ).toBeTruthy();
  });

  it("keeps the owner identity editable once the bot account is set", async () => {
    await renderConnection({ accountSet: true });
    const reason = i18n.t("connections.owner.accountRequired");
    expect(reason).not.toBe("connections.owner.accountRequired");
    expect(screen.queryByText(reason)).toBeNull();
    const input = screen.getByLabelText(i18n.t("connections.owner.title")) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    // 账号已设：只挂用法提示，不挂原因。
    const described = (input.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain(i18n.t("connections.owner.hint"));
    expect(described).not.toContain(i18n.t("connections.owner.accountRequired"));
  });
});
