// 管理员保存生命周期补证（真实 store + fake API）：T1 父群脏草稿 × 管理员保存推进 revision ×
// 父群保存 409 × 抽屉显式刷新三路合并重试；T2 抽屉内先改绑再单独保存名单的 409 与恢复；
// T3 关闭抽屉后全局导航守卫的行级呈现；en 渲染的可达名称。T1/T2 此前只被「统一 saveQqDrafts
// 顺序推进」的用例覆盖，这里补的是两个独立入口交互场景。全部走真实 UI click 与既有保存通路；
// 409 呈现为真实错误，不添静默重试或回退，恢复走显式「刷新保存基线」。

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QqBindingResponse,
  QqSchemeResponse,
  UpdateQqBindingRequest,
} from "../../src/shared/contracts/qq";
import type { QqGroupConfigResponse } from "../../src/shared/contracts/qq-group-config";
import { api } from "../../src/web/api";
import { qqDraftChanges } from "../../src/web/features/qq/draft-state";
import { selectLocale } from "../../src/web/i18n";
import { QqGroupConfigPage } from "../../src/web/screens/connections/group-config";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { NavigationGuard } from "../../src/web/workspace/NavigationGuard";

const NOW = "2026-09-30T00:00:00.000Z";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";

const qqScheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: SCHEME_ID,
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

const qqBinding = (overrides: Partial<QqBindingResponse> = {}): QqBindingResponse => ({
  id: BINDING_ID,
  account_id: "10001",
  kind: "group",
  peer_id: "30003",
  agent_id: AGENT_ID,
  scheme_id: SCHEME_ID,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  attention: { mode: "soft", members: ["10001", "10002"] },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 1,
  authority_revision: 1,
  ...overrides,
});

const agentResponse = (id: string, name: string) =>
  ({
    id,
    name,
    description: "",
    additional_instructions: "",
    model_name: "qwen/qwen3-4b-2507",
    temperature: 0.7,
    p5_config: {},
    is_active: true,
    config_version: 1,
    persona_intensity: 50,
    created_at: NOW,
    updated_at: NOW,
  }) as never;

const groupConfig = (binding: QqBindingResponse): QqGroupConfigResponse => {
  const base = qqScheme();
  return {
    binding,
    base_scheme: base,
    effective_scheme: base,
    overrides: {} as QqGroupConfigResponse["overrides"],
    disabled_capabilities: [],
    revision: 0,
  };
};

function setupStore(
  overrides: { binding?: QqBindingResponse; clientOverrides?: Partial<typeof api> } = {},
) {
  const currentBinding = overrides.binding ?? qqBinding();
  const fake = {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue({
      enabled: false,
      account_id: "10001",
      judgement_model_name: null,
      transport: { endpoint: "ws://127.0.0.1:3000/", has_token: true },
      revision: 3,
    }),
    listQqConversations: vi.fn().mockResolvedValue([]),
    listQqBindings: vi.fn().mockResolvedValue([currentBinding]),
    listQqSchemes: vi.fn().mockResolvedValue([qqScheme()]),
    getQqGroupConfig: vi.fn(async () => groupConfig(currentBinding)),
    getAgentKnowledgeRead: vi.fn().mockResolvedValue({
      revision: 1,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    }),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_ID, bindings: 1 }),
    updateQqBinding: vi
      .fn()
      .mockResolvedValue({ ...currentBinding, revision: currentBinding.revision + 1 }),
    ...overrides.clientOverrides,
  } as unknown as typeof api;

  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-app-groups",
    agents: [agentResponse(AGENT_ID, "本地助手"), agentResponse(OTHER_AGENT_ID, "夜间助手")],
    qqBindings: [currentBinding],
    qqBindingsLoaded: true,
    qqSchemes: [qqScheme()],
    qqSchemesLoaded: true,
  });
  return fake;
}

beforeEach(async () => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  await selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QQ admin save lifecycle", () => {
  it("T1: 父群配置脏草稿在场时，管理员直达保存成功推进 revision → 父群保存以旧绑定快照 409 且草稿原样 → 抽屉显式刷新保存基线三路合并后重试成功", async () => {
    const initialBinding = qqBinding({ revision: 1 });
    let revision = 1;
    let groupRevision = 0;

    const fake = setupStore({
      binding: initialBinding,
      clientOverrides: {
        // 管理员保存成功：服务端行 revision 推进；父群配置保存按打开时的绑定快照 CAS → 409。
        updateQqBinding: vi.fn(async (_id: string, patch: UpdateQqBindingRequest) => {
          revision += 1;
          return {
            ...initialBinding,
            revision,
            ...(patch.attention ? { attention: patch.attention } : {}),
          };
        }),
        saveQqGroupConfig: vi.fn(async (_id: string, input) => {
          if (input.expected_binding_revision !== revision)
            throw new Error("409 Conflict: group config was modified elsewhere");
          groupRevision += 1;
          return groupConfig({ ...initialBinding, revision });
        }),
        // 真实服务端：读取返回当前 revision 的绑定（管理员写已推进）。
        getQqGroupConfig: vi.fn(async () => groupConfig({ ...initialBinding, revision })),
      },
    });

    // 父群配置页先带出一份真实草稿：真实输入框钉住每小时发言上限 201。
    await store.getState().selectQqGroupConfig(BINDING_ID);
    render(<QqGroupConfigPage />);
    await act(async () => {});
    const pinInput = document.querySelector(
      'input[data-field="rhythm.hourly_speech_limit"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(pinInput, { target: { value: "201" } });
    });
    expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
      rhythm: { hourly_speech_limit: 201 },
    });

    // 管理员直达同一绑定：改名单并保存，成功推进 binding revision（1 → 2）。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "管理员" }));
    });
    const sheet = screen.getByRole("dialog");
    const input = within(sheet).getByLabelText("管理员名单") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "10001 10003" } });
      fireEvent.click(within(sheet).getByRole("button", { name: "保存名单" }));
    });
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      attention: { mode: "soft", members: ["10001", "10003"] },
      expected_revision: 1,
    });

    // 保存成功清名单草稿；父群草稿不被波及，父群编辑器基线仍是打开时的 revision 1。
    expect(store.getState().qqInputs.attention[BINDING_ID]).toBeUndefined();
    expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
      rhythm: { hourly_speech_limit: 201 },
    });
    expect(store.getState().qqGroupConfigEditor?.source.binding.revision).toBe(1);

    // 关抽屉回父群配置页，再走父群保存：真实契约按打开时的绑定快照发
    // expected_binding_revision: 1 → 服务端已在 revision 2，409。
    await userEvent.keyboard("{Escape}");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存本群配置" }));
    });
    const alerts = screen.getAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]?.textContent).toContain("409");
    expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
      rhythm: { hourly_speech_limit: 201 },
    });
    expect(store.getState().qqGroupConfigEditor?.source.binding.revision).toBe(1);

    // 真实 UI click「刷新保存基线」（本群配置页头按钮 → refreshQqGroupConfig）：
    // 三路合并保留钉住草稿，基线按最新读取推进到 revision 2。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新保存基线" }));
    });
    expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
      rhythm: { hourly_speech_limit: 201 },
    });
    expect(store.getState().qqGroupConfigEditor?.source.binding.revision).toBe(2);

    // 重试：父群保存以推进后的绑定基线（expected_binding_revision: 2）通过。
    await userEvent.keyboard("{Escape}");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存本群配置" }));
    });
    expect(fake.saveQqGroupConfig).toHaveBeenLastCalledWith(
      BINDING_ID,
      expect.objectContaining({ expected_binding_revision: 2 }),
    );
    expect(groupRevision).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("T2: 先编辑名单（draft source 冻结 R1）→ 再保存改绑成功（R2）→ 单独保存名单按旧 source R1 409 → 真实点击刷新按钮合并基线重试成功", async () => {
    const b1 = qqBinding({ revision: 1, agent_id: AGENT_ID });
    // 服务端权威行：初始 R1；只有 CAS 校验通过的写才推进 revision 并返回实际行。
    let serverBinding: QqBindingResponse = b1;
    const fake = setupStore({
      binding: b1,
      clientOverrides: {
        updateQqBinding: vi.fn(async (_id: string, patch: UpdateQqBindingRequest) => {
          if (patch.expected_revision !== serverBinding.revision)
            throw new Error("409 Conflict: binding was modified elsewhere");
          serverBinding = {
            ...serverBinding,
            revision: serverBinding.revision + 1,
            ...(patch.agent_id ? { agent_id: patch.agent_id } : {}),
            ...(patch.attention ? { attention: patch.attention } : {}),
          };
          return serverBinding;
        }),
        listQqBindings: vi.fn(async () => [serverBinding]),
      },
    });

    render(<SchemesWorkspace active />);
    await userEvent.click(screen.getByRole("button", { name: "管理员" }));
    const sheet = screen.getByRole("dialog");

    // 第一步：先编辑名单。此时名单草稿的 source 冻结为打开时的 b1（revision 1）。
    const input = within(sheet).getByLabelText("管理员名单") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "10001 10003" } });
    });
    expect(store.getState().qqInputs.attention[BINDING_ID]?.source.revision).toBe(1);
    expect(store.getState().qqInputs.attention[BINDING_ID]?.members).toBe("10001 10003");

    // 第二步：再保存 Agent 改绑。真实 CAS（expected_revision === serverBinding.revision = 1）
    // 校验通过 → 服务端推进到 R2 并返回实际行；publishSavedBinding 就地推进 store 行。
    fireEvent.change(within(sheet).getByLabelText("Agent"), {
      target: { value: OTHER_AGENT_ID },
    });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "保存改绑" }));
    });
    expect(fake.updateQqBinding).toHaveBeenNthCalledWith(1, BINDING_ID, {
      agent_id: OTHER_AGENT_ID,
      scheme_id: SCHEME_ID,
      expected_revision: 1,
    });
    expect(serverBinding.revision).toBe(2);
    expect(serverBinding.agent_id).toBe(OTHER_AGENT_ID);

    // 第三步：单独点击「保存名单」。名单草稿的 source 仍是冻结的 R1（改绑写不更新旧草稿基线），
    // 服务端已在 R2 → 真实 CAS 409，错误显示、草稿保留。
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "保存名单" }));
    });
    expect(fake.updateQqBinding).toHaveBeenNthCalledWith(2, BINDING_ID, {
      attention: { mode: "soft", members: ["10001", "10003"] },
      expected_revision: 1,
    });
    const conflictAlerts = screen.getAllByRole("alert");
    expect(conflictAlerts.some((a) => a.textContent?.includes("409"))).toBe(true);
    expect(store.getState().qqInputs.attention[BINDING_ID]?.members).toBe("10001 10003");
    expect(store.getState().qqInputs.attention[BINDING_ID]?.source.revision).toBe(1);

    // 第四步：真实 UI click 抽屉内「刷新保存基线」（loadQqBindingDirectory(binding.id) →
    // mergeExplicitBindingDraft）：fresh=R2，members 与 R1 基线不等 → 保留「10001 10003」，
    // source 推进到 R2。
    const refreshButtons = within(sheet).getAllByRole("button", { name: "刷新保存基线" });
    await act(async () => {
      fireEvent.click(refreshButtons[0] as HTMLButtonElement);
    });
    const draft = store.getState().qqInputs.attention[BINDING_ID];
    expect(draft?.members).toBe("10001 10003");
    expect(draft?.source.revision).toBe(2);
    expect(draft?.source.agent_id).toBe(OTHER_AGENT_ID);

    // 第五步：重试按新基线 R2 通过，服务端推进 R3。
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "保存名单" }));
    });
    expect(fake.updateQqBinding).toHaveBeenNthCalledWith(3, BINDING_ID, {
      attention: { mode: "soft", members: ["10001", "10003"] },
      expected_revision: 2,
    });
    expect(serverBinding.revision).toBe(3);
    expect(serverBinding.attention.members).toEqual(["10001", "10003"]);
  });

  it("T3: 关闭抽屉后未保存名单草稿进全局 qqDraftChanges，全局导航守卫把该行显示给用户", async () => {
    setupStore();
    render(<SchemesWorkspace active />);

    await userEvent.click(screen.getByRole("button", { name: "管理员" }));
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("管理员名单"), {
      target: { value: "10001 10003" },
    });

    await userEvent.keyboard("{Escape}");
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();

    const changes = qqDraftChanges(store.getState());
    expect(changes.some((row) => row.id === `attention:${BINDING_ID}`)).toBe(true);

    // 真实导航路径触发全局守卫（有未保存草稿 → navigationConfirmOpen）；
    // WorkspaceShell 才挂 NavigationGuard：重挂后守卫出现在真实渲染树。
    await act(async () => {
      store.getState().openChat();
    });
    expect(store.getState().navigationConfirmOpen).toBe(true);
    render(<NavigationGuard />);
    const confirmDialog = screen.getByRole("alertdialog");
    expect(within(confirmDialog).getByText("当前分区有未保存修改")).toBeTruthy();
    const summary = confirmDialog.querySelector("summary");
    expect(summary?.textContent).toContain("管理员 · 30003");
    expect(confirmDialog.textContent).toContain("soft → soft");
    expect(confirmDialog.textContent).toContain("10001 10002 → 10001 10003");

    // 取消留在原地，草稿不被丢弃。
    await userEvent.click(within(confirmDialog).getByRole("button", { name: "取消离开" }));
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().qqInputs.attention[BINDING_ID]?.members).toBe("10001 10003");
  });

  it("en 渲染：管理员模式与名单的可达名称是共享翻译的稳定英文，不依赖中文旧词", async () => {
    setupStore();
    await selectLocale("en");
    render(<SchemesWorkspace active />);
    await userEvent.click(screen.getByRole("button", { name: "Administrators" }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByLabelText("Administrator mode")).toBeTruthy();
    expect(within(sheet).getByLabelText("Administrator list")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Save list" })).toBeTruthy();
  });
});
