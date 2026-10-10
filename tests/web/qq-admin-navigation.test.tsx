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
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

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

describe("QQ Admin Navigation & Integration", () => {
  beforeEach(async () => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    await selectLocale("zh-CN");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("spies scrollIntoView directly targeting administrators section from group directory", async () => {
    setupStore();
    const scrollSpy = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");

    render(<SchemesWorkspace active />);

    const adminBtn = screen.getByRole("button", { name: "管理员" });
    await userEvent.click(adminBtn);

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("群 30003")).toBeTruthy();
    expect(within(sheet).getByText("生效范围:")).toBeTruthy();
    expect(within(sheet).getByText("Agent: 本地助手")).toBeTruthy();
    expect(within(sheet).getByTestId("admin-badge-10001")).toBeTruthy();

    const targetSection = sheet.querySelector('[data-section="administrators"]');
    expect(targetSection).toBeTruthy();
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("spies scrollIntoView directly targeting administrators section from group config header", async () => {
    setupStore();
    await store.getState().selectQqGroupConfig(BINDING_ID);

    const scrollSpy = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");

    render(<SchemesWorkspace active />);

    const adminBtn = screen.getByRole("button", { name: "管理员" });
    await userEvent.click(adminBtn);

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("群 30003")).toBeTruthy();
    const targetSection = sheet.querySelector('[data-section="administrators"]');
    expect(targetSection).toBeTruthy();
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("respects prefers-reduced-motion without delayed timer drift", async () => {
    setupStore();
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const scrollSpy = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");

    render(<SchemesWorkspace active />);
    await userEvent.click(screen.getByRole("button", { name: "管理员" }));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("displays saved binding Agent as active scope, indicating pending uncommitted reassignment", async () => {
    setupStore();
    render(<SchemesWorkspace active />);
    await userEvent.click(screen.getByRole("button", { name: "管理员" }));

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("Agent: 本地助手")).toBeTruthy();

    const assistantSelect = within(sheet).getByLabelText("Agent");
    fireEvent.change(assistantSelect, { target: { value: OTHER_AGENT_ID } });

    expect(within(sheet).getByText("Agent: 本地助手")).toBeTruthy();
    expect(within(sheet).getByText(/待保存改绑至 夜间助手/)).toBeTruthy();
  });

  it("presents three clear admin modes: off, soft priority, and hard trigger allowlist", async () => {
    setupStore();
    render(<SchemesWorkspace active />);
    await userEvent.click(screen.getByRole("button", { name: "管理员" }));

    const select = screen.getByLabelText("管理员模式") as HTMLSelectElement;
    expect(select.value).toBe("soft");

    const options = Array.from(select.options).map((opt) => opt.text);
    expect(options).toContain("不启用");
    expect(options).toContain("管理员优先（软优先）");
    expect(options).toContain("仅管理员可唤醒（严格白名单）");
  });

  it("preserves draft members when switching to off, and saves empty members under off mode", async () => {
    const fake = setupStore();
    render(<SchemesWorkspace active />);
    await userEvent.click(screen.getByRole("button", { name: "管理员" }));

    const select = screen.getByLabelText("管理员模式");
    const input = screen.getByLabelText("管理员名单") as HTMLInputElement;

    fireEvent.change(select, { target: { value: "off" } });
    expect(input.value).toBe("10001 10002");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存名单" }));
    });

    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      attention: { mode: "off", members: [] },
      expected_revision: 1,
    });
  });

  it("normalizes leading zeros and saves canonical deduplicated members", async () => {
    const fake = setupStore();
    render(<SchemesWorkspace active />);
    await userEvent.click(screen.getByRole("button", { name: "管理员" }));

    const select = screen.getByLabelText("管理员模式");
    const input = screen.getByLabelText("管理员名单");

    fireEvent.change(select, { target: { value: "hard" } });
    fireEvent.change(input, { target: { value: "010001 10001 10002" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存名单" }));
    });

    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ID, {
      attention: { mode: "hard", members: ["10001", "10002"] },
      expected_revision: 1,
    });
  });

  it("disables save button and prevents submit when input contains invalid tokens", async () => {
    setupStore();
    render(<SchemesWorkspace active />);
    await userEvent.click(screen.getByRole("button", { name: "管理员" }));

    const input = screen.getByLabelText("管理员名单");
    fireEvent.change(input, { target: { value: "10001 abc" } });

    const saveBtn = screen.getByRole("button", { name: "保存名单" });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("T1: handles 409 conflict, preserves dirty attention draft upon refresh, and allows retrying with new revision", async () => {
    const initialBinding = qqBinding({ revision: 1 });
    const bumpedBinding = qqBinding({ revision: 2 });
    let calls = 0;

    const fake = setupStore({
      binding: initialBinding,
      clientOverrides: {
        updateQqBinding: vi.fn(async () => {
          calls++;
          if (calls === 1) {
            // First attempt hits 409 conflict
            throw new Error("409 Conflict: revision mismatch");
          }
          return { ...bumpedBinding, revision: 3 };
        }),
        listQqBindings: vi.fn(async () => [bumpedBinding]),
      },
    });

    render(<SchemesWorkspace active />);
    await userEvent.click(screen.getByRole("button", { name: "管理员" }));

    const input = screen.getByLabelText("管理员名单");
    fireEvent.change(input, { target: { value: "10001 10003" } });

    // First save fails due to 409
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存名单" }));
    });

    // Explicit refresh of this binding baseline preserves dirty attention draft and updates revision
    await act(async () => {
      await store.getState().loadQqBindingDirectory(BINDING_ID);
    });

    expect(store.getState().qqInputs.attention[BINDING_ID]?.members).toBe("10001 10003");

    // Second attempt commits with updated revision
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存名单" }));
    });

    expect(fake.updateQqBinding).toHaveBeenLastCalledWith(BINDING_ID, {
      attention: { mode: "soft", members: ["10001", "10003"] },
      expected_revision: 2,
    });
  });

  it("T2: advances binding revision sequentially from choice save before attention save without 409", async () => {
    const b1 = qqBinding({ revision: 1, agent_id: AGENT_ID });
    const b2 = { ...b1, revision: 2, agent_id: OTHER_AGENT_ID };
    const b3: QqBindingResponse = {
      ...b2,
      revision: 3,
      attention: { mode: "hard", members: ["10001", "10003"] },
    };

    const fake = setupStore({
      binding: b1,
      clientOverrides: {
        updateQqBinding: vi.fn(async (_id: string, patch: UpdateQqBindingRequest) => {
          if ("agent_id" in patch) {
            return b2;
          }
          if ("attention" in patch) {
            return b3;
          }
          return b2;
        }),
      },
    });

    // Stage both a choice change and an attention change in the unified draft state
    store.setState((s) => ({
      qqInputs: {
        ...s.qqInputs,
        choices: {
          [BINDING_ID]: {
            agentId: OTHER_AGENT_ID,
            schemeId: SCHEME_ID,
            source: b1,
          },
        },
        attention: {
          [BINDING_ID]: {
            mode: "hard",
            members: "10001 10003",
            source: b1,
          },
        },
      },
    }));

    // Trigger saveQqDrafts
    let ok = false;
    await act(async () => {
      ok = await store.getState().saveQqDrafts();
    });

    expect(ok).toBe(true);
    expect(fake.updateQqBinding).toHaveBeenCalledTimes(2);
    // Choice save used expected_revision: 1
    expect(fake.updateQqBinding).toHaveBeenNthCalledWith(1, BINDING_ID, {
      agent_id: OTHER_AGENT_ID,
      scheme_id: SCHEME_ID,
      expected_revision: 1,
    });
    // Attention save sequentially used expected_revision: 2 from the refreshed binding
    expect(fake.updateQqBinding).toHaveBeenNthCalledWith(2, BINDING_ID, {
      attention: { mode: "hard", members: ["10001", "10003"] },
      expected_revision: 2,
    });
  });

  it("T3: closing drawer retains draft in store, listed in global qqDraftChanges, and restored on reopen", async () => {
    setupStore();
    render(<SchemesWorkspace active />);

    await userEvent.click(screen.getByRole("button", { name: "管理员" }));
    const sheet = screen.getByRole("dialog");

    const input = within(sheet).getByLabelText("管理员名单");
    fireEvent.change(input, { target: { value: "10001 10003" } });

    // Press Escape to close drawer
    await userEvent.keyboard("{Escape}");

    // The draft remains in the store
    expect(store.getState().qqInputs.attention[BINDING_ID]?.members).toBe("10001 10003");

    // Global draft changes guard recognizes uncommitted admin changes
    const changes = qqDraftChanges(store.getState());
    const adminChange = changes.find((c) => c.id === `attention:${BINDING_ID}`);
    expect(adminChange).toBeTruthy();
    expect(adminChange?.resource).toBe("管理员 · 30003");

    // Reopening the drawer restores the draft in the input
    await userEvent.click(screen.getByRole("button", { name: "管理员" }));
    const reopenedSheet = screen.getByRole("dialog");
    const reopenedInput = within(reopenedSheet).getByLabelText("管理员名单") as HTMLInputElement;
    expect(reopenedInput.value).toBe("10001 10003");
  });
});
