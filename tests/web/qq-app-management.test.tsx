import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QqSchemeResponse,
  QqSettingsResponse,
  QqStickerCollectionResponse,
  QqStorageUsageResponse,
} from "../../src/shared/contracts/qq";
import type { QqStorageSettingsResponse } from "../../src/shared/contracts/qq-storage";
import { api } from "../../src/web/api";
import { qqDraftChanges } from "../../src/web/features/qq/draft-state";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { selectLocale, translate } from "../../src/web/i18n";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { NavigationGuard } from "../../src/web/workspace/NavigationGuard";
import { render } from "./helpers/render-with-providers";

const NOW = "2026-09-24T00:00:00.000Z";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";

const settings: QqSettingsResponse = {
  enabled: true,
  account_id: "100",
  judgement_model_name: null,
  transport: { endpoint: "ws://localhost:3000", has_token: true },
  revision: 3,
};

const scheme: QqSchemeResponse = {
  id: SCHEME_ID,
  name: "默认方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
  reply: { split_by_speaker: true },
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
  stickers: { sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 5, frequency: "medium" },
  sticker_collections: { collection_ids: [] },
  prompts: {
    scene: "",
    judge: "",
    reply: "",
    review: "",
    sticker: "",
    media: "",
    compress: "",
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
  },
  // 0059：两组响应必填；夹具代表既有已保存方案，防抖按旧列默认显式关（新建默认开）。
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
  revision: 2,
  created_at: NOW,
  updated_at: NOW,
};

const usage: QqStorageUsageResponse = {
  observations: { messages: 12, text: 11, expired_text: 3 },
  speech: { records: 4, text: 3 },
  sends: { attempts: 7, parts: 9 },
  nicknames: { current: 2, expired: 1 },
  stickers: { collections: 2, assets: 5, enabled: 3, bytes: 2048 },
  dispatch: { candidates: 1, ready_now: 0, lease_held: false },
  media: { segments: 6, described: 4, pending: 1 },
  sweep: {
    tracked: 2,
    last_swept_at_seconds: 2_000_000_000,
    entries: [
      {
        kind: "group",
        peer_id: "30003",
        outcome: "skipped",
        reason: "not_quiet_yet",
        observed_at_seconds: 1_999_999_760,
        ready_at_seconds: 2_000_000_600,
        decided_at_seconds: 1_999_999_970,
      },
    ],
  },
  retention: { days: 14 },
};

const storageSettings: QqStorageSettingsResponse = {
  revision: 3,
  retention_days: 14,
  cleanup_mode: "manual",
};

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue(settings),
    getQqOwner: vi
      .fn()
      .mockResolvedValue({ configured: false, account_id: null, peer_id: null, revision: null }),
    getQqStatus: vi.fn().mockResolvedValue({ connection: { phase: "ready", reason: null } }),
    listQqConversations: vi.fn().mockResolvedValue([]),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqSchemes: vi.fn().mockResolvedValue([scheme]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_ID, bindings: 0 }),
    getQqStorage: vi.fn().mockResolvedValue(usage),
    getQqStorageSettings: vi.fn().mockResolvedValue(storageSettings),
    updateQqStorageSettings: vi
      .fn()
      .mockImplementation(async (body: { retention_days: number; expected_revision: number }) => ({
        ...storageSettings,
        retention_days: body.retention_days,
        revision: body.expected_revision + 1,
      })),
    listQqStorageItems: vi.fn().mockResolvedValue({ items: [], next_cursor: null, total: 0 }),
    previewQqStorageCleanup: vi.fn(),
    runQqStorageSelectionCleanup: vi.fn(),
    updateQqScheme: vi.fn(),
    updateQqSettings: vi.fn().mockImplementation(
      async (body: { account_id?: string | null; expected_revision: number }) =>
        ({
          ...settings,
          account_id: body.account_id === undefined ? settings.account_id : body.account_id,
          revision: body.expected_revision + 1,
        }) as QqSettingsResponse,
    ),
    updateQqTransport: vi.fn().mockImplementation(
      async (body: { endpoint?: string | null; expected_revision: number }) =>
        ({
          ...settings,
          transport: {
            endpoint: body.endpoint === undefined ? settings.transport.endpoint : body.endpoint,
            has_token: true,
          },
          revision: body.expected_revision + 1,
        }) as QqSettingsResponse,
    ),
    ...overrides,
  } as unknown as typeof api;
}

async function renderApp(
  settingsRoute:
    | "qq-app-schemes"
    | "qq-connection"
    | "qq-events"
    | "qq-runtime"
    | "qq-storage"
    | "basic",
  settingsView: "workspace" | "operating-mode" = "workspace",
  overrides: Partial<typeof api> = {},
  prepare?: () => void,
) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView, settingsRoute });
  prepare?.();
  render(<SchemesWorkspace />);
  await act(async () => {});
  return fake;
}

/** 数据页 + 三选导航守卫：跨 Tab 的草稿流只在带守卫的工作区外壳里发生。 */
async function renderGuarded(overrides: Partial<typeof api> = {}, prepare?: () => void) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "qq-storage" });
  prepare?.();
  render(
    <>
      <SchemesWorkspace />
      <NavigationGuard />
    </>,
  );
  await act(async () => {});
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

const taskActions = {
  loadQqAccess: store.getState().loadQqAccess,
  setQqManagedEventsActive: store.getState().setQqManagedEventsActive,
  clearQqManagedQr: store.getState().clearQqManagedQr,
  loadQqManaged: store.getState().loadQqManaged,
  loadQqManagedResources: store.getState().loadQqManagedResources,
  loadQqManagedAccounts: store.getState().loadQqManagedAccounts,
  loadOrganization: store.getState().loadOrganization,
};

afterEach(() => {
  cleanup();
  store.setState(taskActions);
});

describe("unified workspace QQ tasks", () => {
  it("presents connection settings as named sections while retaining the independent business toggle", async () => {
    await renderApp("qq-connection");
    expect(
      screen.getByRole("heading", { name: translate("connections.onebotConnection"), level: 2 }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: translate("connections.managed.title"), level: 2 }),
    ).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: translate("connections.enableQq") })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: translate("connections.managed.enable") }),
    ).toBeTruthy();
    expect(screen.getByLabelText(translate("connections.websocketAddress"))).toBeTruthy();
  });

  it("root shows three equally visible tasks and maps the app alias to the shared directory", async () => {
    const fake = await renderApp("qq-app-schemes");
    expect(
      screen.queryByRole("tablist", { name: translate("schemes.workspace.navigation") }),
    ).toBeNull();
    for (const key of [
      "schemes.workspace.bindings",
      "schemes.qq.connectionTitle",
      "connections.dataRetention",
    ]) {
      expect(screen.getByRole("button", { name: translate(key) })).toBeTruthy();
    }
    expect(screen.getByText("默认方案")).toBeTruthy();
    expect(screen.getByRole("button", { name: translate("connections.newScheme") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "本群配置" })).toBeNull();
    expect(fake.getQqStatus).not.toHaveBeenCalled();
    expect(fake.getQqSettings).not.toHaveBeenCalled();
  });

  it("uses route-backed connection, events and runtime tasks, with storage separate", async () => {
    await renderApp("qq-app-schemes");
    await userEvent.click(
      screen.getByRole("button", { name: translate("schemes.workspace.bindings") }),
    );
    expect(store.getState().settingsRoute).toBe("scheme-bindings");
    await userEvent.click(screen.getByRole("button", { name: translate("schemes.backToCatalog") }));
    await userEvent.click(
      screen.getByRole("button", { name: translate("schemes.qq.connectionTitle") }),
    );
    expect(store.getState().settingsRoute).toBe("qq-connection");
    expect(screen.getByLabelText(translate("connections.websocketAddress"))).toBeTruthy();
    for (const [key, route] of [
      ["schemes.qq.eventsTitle", "qq-events"],
      ["schemes.qq.runtimeTitle", "qq-runtime"],
    ]) {
      await userEvent.click(screen.getByRole("tab", { name: translate(key) }));
      expect(store.getState().settingsRoute).toBe(route);
    }
    expect(screen.queryByRole("tab", { name: translate("connections.dataRetention") })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: translate("schemes.backToCatalog") }));
    await userEvent.click(
      screen.getByRole("button", { name: translate("connections.dataRetention") }),
    );
    expect(store.getState().settingsRoute).toBe("qq-storage");
  });

  it("returns through the single back action", async () => {
    await renderApp("qq-connection");
    expect(
      screen.getAllByRole("button", { name: translate("schemes.backToCatalog") }),
    ).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: translate("schemes.backToCatalog") }));
    expect(store.getState().settingsRoute).toBe("scheme-library");
    expect(screen.getByRole("heading", { name: translate("workspace.schemes") })).toBeTruthy();
  });

  it("recognises the legacy operating-mode state", async () => {
    await renderApp("basic", "operating-mode");
    expect(
      screen.getByRole("heading", { name: translate("schemes.qq.connectionTitle") }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: translate("connections.transportPage.tab") })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByLabelText(translate("connections.websocketAddress"))).toBeTruthy();
  });

  it("disables back and subtask navigation while a save is in flight", async () => {
    await renderApp("qq-connection");
    act(() => store.setState({ qqAccessSaving: true }));
    expect(
      (
        screen.getByRole("button", {
          name: translate("schemes.backToCatalog"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    for (const key of [
      "connections.transportPage.tab",
      "schemes.qq.eventsTitle",
      "schemes.qq.runtimeTitle",
    ]) {
      expect(
        (screen.getByRole("tab", { name: translate(key) }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
  });
});

describe("QQ connection task lifecycle", () => {
  it("events alone owns the stream; switching tasks clears QR and does not start a second stream", async () => {
    const fake = client();
    store.getState().resetForTests(fake);
    const eventsActive = vi.fn();
    const qrClear = vi.fn(() => store.setState({ qqManagedQrPayload: null }));
    const managedRead = vi.fn().mockResolvedValue(true);
    const resourcesRead = vi.fn().mockResolvedValue(true);
    const accountsRead = vi.fn().mockResolvedValue(true);
    const organizationRead = vi.fn().mockResolvedValue(true);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-connection",
      qqSettings: settings,
      setQqManagedEventsActive: eventsActive,
      clearQqManagedQr: qrClear,
      loadQqManaged: managedRead,
      loadQqManagedResources: resourcesRead,
      loadQqManagedAccounts: accountsRead,
      loadOrganization: organizationRead,
    });
    const rendered = render(<SchemesWorkspace />);
    await act(async () => {});
    expect(eventsActive).not.toHaveBeenCalledWith(true);
    expect(managedRead).toHaveBeenCalledTimes(1);
    expect(organizationRead).not.toHaveBeenCalled();
    act(() => store.setState({ qqManagedQrPayload: "hidden-qr" }));
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    fireEvent(document, new Event("visibilitychange"));
    expect(store.getState().qqManagedQrPayload).toBeNull();
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else Reflect.deleteProperty(document, "hidden");
    act(() => store.setState({ qqManagedQrPayload: "transient-qr" }));
    await userEvent.click(screen.getByRole("tab", { name: translate("schemes.qq.eventsTitle") }));
    expect(store.getState().settingsRoute).toBe("qq-events");
    expect(store.getState().qqManagedQrPayload).toBeNull();
    expect(eventsActive.mock.calls.filter(([active]) => active === true)).toHaveLength(1);
    expect(screen.queryByLabelText(translate("connections.websocketAddress"))).toBeNull();
    expect(screen.getByRole("checkbox", { name: translate("connections.enableQq") })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: translate("schemes.qq.runtimeTitle") }));
    expect(store.getState().settingsRoute).toBe("qq-runtime");
    expect(eventsActive.mock.lastCall).toEqual([false]);
    expect(organizationRead).toHaveBeenCalledTimes(1);
    expect(managedRead).toHaveBeenCalledTimes(1);
    rendered.rerender(<SchemesWorkspace active={false} />);
    await act(async () => {});
    expect(eventsActive.mock.lastCall).toEqual([false]);
    expect(store.getState().qqManagedQrPayload).toBeNull();
  });

  it("shared access reads once across subtasks, but revalidates on API, lifecycle, visibility and active changes", async () => {
    const fake = await renderApp("qq-connection");
    expect(fake.getQqSettings).toHaveBeenCalledTimes(1);
    expect(fake.getQqStatus).toHaveBeenCalledTimes(1);
    for (const key of [
      "schemes.qq.eventsTitle",
      "schemes.qq.runtimeTitle",
      "schemes.qq.eventsTitle",
    ]) {
      await userEvent.click(screen.getByRole("tab", { name: translate(key) }));
    }
    expect(fake.getQqSettings).toHaveBeenCalledTimes(1);
    expect(fake.getQqStatus).toHaveBeenCalledTimes(1);
    expect(fake.listQqConversations).toHaveBeenCalledTimes(1);
    expect(fake.listQqBindings).toHaveBeenCalledTimes(1);
    expect(fake.listQqSchemes).toHaveBeenCalledTimes(1);
    const replacement = client();
    await act(async () => store.setState({ apiClient: replacement }));
    expect(replacement.getQqSettings).toHaveBeenCalledTimes(1);
    await act(async () =>
      store.setState({ qqManagedLifecycleId: store.getState().qqManagedLifecycleId + 1 }),
    );
    expect(replacement.getQqSettings).toHaveBeenCalledTimes(2);
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    fireEvent(document, new Event("visibilitychange"));
    expect(replacement.getQqSettings).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => fireEvent(document, new Event("visibilitychange")));
    expect(replacement.getQqSettings).toHaveBeenCalledTimes(3);
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else Reflect.deleteProperty(document, "hidden");
    await userEvent.click(screen.getByRole("button", { name: translate("schemes.backToCatalog") }));
    await userEvent.click(
      screen.getByRole("button", { name: translate("schemes.qq.connectionTitle") }),
    );
    expect(replacement.getQqSettings).toHaveBeenCalledTimes(4);
    await userEvent.click(
      screen.getByRole("button", { name: translate("connections.refreshState") }),
    );
    expect(replacement.getQqSettings).toHaveBeenCalledTimes(5);
  });

  it("API replacement during a shared-access read starts the new owner once and rejects the old response", async () => {
    let resolveOld!: (value: QqSettingsResponse) => void;
    let resolveNew!: (value: QqSettingsResponse) => void;
    const oldSettings = new Promise<QqSettingsResponse>((resolve) => {
      resolveOld = resolve;
    });
    const newSettings = new Promise<QqSettingsResponse>((resolve) => {
      resolveNew = resolve;
    });
    const old = await renderApp("qq-connection", "workspace", {
      getQqSettings: vi.fn().mockReturnValue(oldSettings),
    });
    const replacement = client({
      getQqSettings: vi.fn().mockReturnValue(newSettings),
      listQqSchemes: vi.fn().mockResolvedValue([{ ...scheme, name: "新来源方案" }]),
    });
    await act(async () => store.setState({ apiClient: replacement }));
    void store.getState().loadQqAccess();
    expect(old.getQqSettings).toHaveBeenCalledTimes(1);
    expect(replacement.getQqSettings).toHaveBeenCalledTimes(1);
    expect(replacement.listQqBindings).toHaveBeenCalledTimes(1);
    expect(replacement.listQqSchemes).toHaveBeenCalledTimes(1);
    await act(async () => resolveOld({ ...settings, account_id: "old-account" }));
    expect(old.getQqStatus).not.toHaveBeenCalled();
    expect(replacement.getQqStatus).not.toHaveBeenCalled();
    expect(store.getState().qqAccessLoading).toBe(true);
    expect(store.getState().qqSettings).toBeNull();
    await act(async () => resolveNew({ ...settings, account_id: "200", revision: 8 }));
    expect(replacement.getQqSettings).toHaveBeenCalledTimes(1);
    expect(replacement.listQqConversations).toHaveBeenCalledTimes(1);
    expect(replacement.listQqBindings).toHaveBeenCalledTimes(1);
    expect(replacement.listQqSchemes).toHaveBeenCalledTimes(1);
    expect(replacement.getQqStatus).toHaveBeenCalledTimes(1);
    expect(store.getState().qqSettings?.account_id).toBe("200");
    expect(store.getState().qqSchemes[0]?.name).toBe("新来源方案");
    expect(store.getState().qqAccessLoading).toBe(false);
  });

  it("a late status from the previous API cannot overwrite the replacement connection", async () => {
    let resolveOldStatus!: (value: Awaited<ReturnType<typeof api.getQqStatus>>) => void;
    const oldStatus = new Promise<Awaited<ReturnType<typeof api.getQqStatus>>>((resolve) => {
      resolveOldStatus = resolve;
    });
    const old = await renderApp("qq-connection", "workspace", {
      getQqStatus: vi.fn().mockReturnValue(oldStatus),
    });
    expect(old.getQqStatus).toHaveBeenCalledTimes(1);
    const replacement = client({
      getQqStatus: vi
        .fn()
        .mockResolvedValue({ connection: { phase: "ready", reason: "replacement" } }),
    });
    await act(async () => store.setState({ apiClient: replacement }));
    expect(replacement.getQqStatus).toHaveBeenCalledTimes(1);
    expect(store.getState().qqConnection?.reason).toBe("replacement");
    await act(async () =>
      resolveOldStatus({ connection: { phase: "closed", reason: "old-owner" } } as Awaited<
        ReturnType<typeof api.getQqStatus>
      >),
    );
    expect(store.getState().qqConnection?.reason).toBe("replacement");
    expect(store.getState().qqAccessLoading).toBe(false);
  });

  it.each([false, true])(
    "quick login only saves the necessary account CAS and keeps other drafts; CAS failure=%s",
    async (failCas) => {
      const ready = {
        apply: "ready" as const,
        process: "running" as const,
        ownership: "owned" as const,
        phase: "waiting_scan" as const,
        core_ready: false,
        network_apply: "pending" as const,
        transport_phase: "idle" as const,
        diagnostic_code: null,
      };
      const managedConfig = {
        config: { version: 1 as const, enabled: false },
        revision: "managed-1",
      };
      const resources = {
        revision: "resources-1",
        status: "ready" as const,
        root: "C:/runtime",
        diagnostic_code: null,
      };
      const updateSettings = failCas
        ? vi.fn().mockRejectedValue(new Error("ACCOUNT_CAS_CONFLICT"))
        : vi.fn().mockImplementation(async (body: { account_id: string }) => ({
            ...settings,
            account_id: body.account_id,
            revision: 4,
          }));
      const quickLogin = vi.fn().mockResolvedValue(ready);
      const managedSave = vi.fn();
      const resourceSave = vi.fn();
      const transportSave = vi.fn();
      const schemeSave = vi.fn();
      const fake = await renderApp("qq-connection", "workspace", {
        getQqManagedStatus: vi.fn().mockResolvedValue(ready),
        getQqManagedConfig: vi.fn().mockResolvedValue(managedConfig),
        getQqManagedResources: vi.fn().mockResolvedValue(resources),
        listQqManagedAccounts: vi
          .fn()
          .mockResolvedValue({ accounts: [{ account_id: "200", display_name: null }] }),
        updateQqSettings: updateSettings,
        updateQqTransport: transportSave,
        updateQqManagedConfig: managedSave,
        updateQqManagedResources: resourceSave,
        updateQqScheme: schemeSave,
        quickLoginQqManaged: quickLogin,
      });
      const schemeDraft = qqSchemeEditorFrom(scheme);
      schemeDraft.name = "仍未保存的方案";
      await act(async () =>
        store.setState({
          qqSchemeEditor: schemeDraft,
          qqInputs: {
            ...store.getState().qqInputs,
            managed: { source: managedConfig, enabled: true },
            managedResources: { source: resources, root: "C:/other-draft" },
            connection: {
              source: settings,
              endpoint: "ws://unsaved-endpoint",
              accountId: "200",
              token: "unsaved-token",
            },
          },
        }),
      );
      const beforeInputs = store.getState().qqInputs;
      await userEvent.click(
        screen.getByRole("button", {
          name: translate("connections.managed.quickLogin.loginButton"),
        }),
      );
      expect(fake.updateQqSettings).toHaveBeenCalledTimes(1);
      expect(fake.updateQqSettings).toHaveBeenCalledWith({
        account_id: "200",
        expected_revision: 3,
      });
      expect(transportSave).not.toHaveBeenCalled();
      expect(managedSave).not.toHaveBeenCalled();
      expect(resourceSave).not.toHaveBeenCalled();
      expect(schemeSave).not.toHaveBeenCalled();
      expect(store.getState().qqInputs.managed).toBe(beforeInputs.managed);
      expect(store.getState().qqInputs.managedResources).toBe(beforeInputs.managedResources);
      expect(store.getState().qqSchemeEditor).toBe(schemeDraft);
      expect(store.getState().qqInputs.connection?.endpoint).toBe("ws://unsaved-endpoint");
      expect(store.getState().qqInputs.connection?.token).toBe("unsaved-token");
      if (failCas) {
        expect(quickLogin).not.toHaveBeenCalled();
        expect(store.getState().qqInputs.connection?.source.revision).toBe(3);
      } else {
        expect(quickLogin).toHaveBeenCalledTimes(1);
        expect(quickLogin).toHaveBeenCalledWith({
          account_id: "200",
          expected_settings_revision: 4,
        });
        expect(store.getState().qqInputs.connection?.source.revision).toBe(4);
      }
    },
  );

  it("dirty subtask change stays on the original route until the existing guard is resolved", async () => {
    await renderApp("qq-connection");
    fireEvent.change(screen.getByLabelText(translate("connections.websocketAddress")), {
      target: { value: "ws://edited:3000" },
    });
    await userEvent.click(screen.getByRole("tab", { name: translate("schemes.qq.eventsTitle") }));
    expect(store.getState()).toMatchObject({
      settingsRoute: "qq-connection",
      navigationConfirmOpen: true,
      pendingNavigation: { kind: "page", settingsRoute: "qq-events" },
    });
    act(() => store.getState().cancelPendingNavigation());
    expect(store.getState().settingsRoute).toBe("qq-connection");
    expect(store.getState().qqInputs.connection?.endpoint).toBe("ws://edited:3000");
  });
});

describe("QQ app connection", () => {
  it("keeps the saved token write-only and saves transport edits with the read revision", async () => {
    const fake = await renderApp("qq-connection");
    // 令牌“存在”这件事只显示为状态徽章；输入框永远从空开始，不回显已保存的令牌。
    expect(screen.getByText(translate("connections.tokenSaved"))).toBeTruthy();
    expect(screen.getByText(translate("connections.connected"))).toBeTruthy();
    const token = screen.getByLabelText(translate("connections.accessToken")) as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.value).toBe("");
    // 连接保存只带连接字段：页面上其他来源的方案草稿不跟着走。
    act(() => {
      const editor = qqSchemeEditorFrom(scheme);
      editor.name = "改过的名字";
      store.setState({ qqSchemeEditor: editor });
    });
    fireEvent.change(screen.getByLabelText(translate("connections.websocketAddress")), {
      target: { value: "ws://example.test:3000/" },
    });
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: translate("connections.saveAccessSettings") }),
      ),
    );
    expect(fake.updateQqTransport).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "ws://example.test:3000/", expected_revision: 4 }),
    );
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });

  it("reads settings and status on entry without advancing the connection draft baseline", async () => {
    const fresh: QqSettingsResponse = {
      ...settings,
      revision: 8,
      transport: { endpoint: "ws://elsewhere", has_token: true },
    };
    const fake = await renderApp(
      "qq-connection",
      "workspace",
      { getQqSettings: vi.fn().mockResolvedValue(fresh) },
      () =>
        store.setState({
          qqSettings: settings,
          qqInputs: {
            ...store.getState().qqInputs,
            connection: {
              source: settings,
              endpoint: "ws://localhost:4000",
              accountId: "100",
              token: "",
            },
          },
        }),
    );
    expect(fake.getQqStatus).toHaveBeenCalledTimes(1);
    // 隐式起载只读服务器值：已改字段与草稿 revision 都不动。
    expect(
      (screen.getByLabelText(translate("connections.websocketAddress")) as HTMLInputElement).value,
    ).toBe("ws://localhost:4000");
    expect(store.getState().qqInputs.connection?.source.revision).toBe(3);
    // 显式刷新重读设置与状态：保留已改字段、未改字段跟随新基线并推进 revision。
    fireEvent.click(screen.getByRole("button", { name: translate("connections.refreshState") }));
    await act(async () => {});
    expect(fake.getQqStatus).toHaveBeenCalledTimes(2);
    expect(
      (screen.getByLabelText(translate("connections.websocketAddress")) as HTMLInputElement).value,
    ).toBe("ws://localhost:4000");
    expect(store.getState().qqInputs.connection?.source.revision).toBe(8);
  });

  it("retries after a failed read instead of staying in loading forever", async () => {
    const getSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("settings down"))
      .mockResolvedValue(settings);
    await renderApp("qq-connection", "workspace", { getQqSettings: getSettings });
    expect(
      screen
        .getAllByRole("alert")
        .some((node) => node.textContent?.includes(translate("connections.accessStateFailed"))),
    ).toBe(true);
    expect(screen.queryByText(translate("connections.readingTheAccessState"))).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: translate("capabilities.retry") }));
    await act(async () => {});
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(translate("connections.websocketAddress"))).toBeTruthy();
  });

  it("shows a save failure once on the screen and keeps the draft", async () => {
    const save = vi
      .fn()
      .mockRejectedValue(
        new Error("TRANSPORT_TEST_FAILURE"),
      ) as unknown as typeof api.updateQqSettings;
    await renderApp("qq-connection", "workspace", { updateQqSettings: save });
    fireEvent.change(screen.getByLabelText(translate("connections.websocketAddress")), {
      target: { value: "ws://localhost:4000" },
    });
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: translate("connections.saveAccessSettings") }),
      ),
    );
    expect(
      screen
        .getAllByRole("alert")
        .filter((node) => node.textContent?.includes("TRANSPORT_TEST_FAILURE")).length,
    ).toBe(1);
    expect(
      (screen.getByLabelText(translate("connections.websocketAddress")) as HTMLInputElement).value,
    ).toBe("ws://localhost:4000");
  });
});

describe("QQ app data & retention", () => {
  it("keeps the inventory, scheduling verdicts, retention and one run-observability entry", async () => {
    const fake = await renderApp("qq-storage");
    expect(fake.getQqStorage).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: translate("connections.dataRetention"), level: 1 }),
    ).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          translate("connections.storage.manage.retentionDays"),
        ) as HTMLInputElement
      ).value,
    ).toBe("14");
    expect(screen.getByText(translate("schemes.qq.scopeNote"))).toBeTruthy();
    const pageHeader = screen
      .getByRole("heading", { name: translate("connections.dataRetention"), level: 1 })
      .closest("header") as HTMLElement;
    const help = within(pageHeader).getByRole("button", {
      name: translate("hints.field.learnAbout", translate("connections.dataRetention")),
    });
    await userEvent.click(help);
    expect(screen.getByRole("tooltip").textContent).toContain(
      translate("connections.storage.retention", "14"),
    );
    fireEvent.keyDown(help, { key: "Escape" });
    expect(screen.getByText("群 30003")).toBeTruthy();
    expect(screen.getByText("尚未冷场")).toBeTruthy();
    // 深链只在运行观测里：这里仅一个入口，不复制追踪详情。
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: translate("connections.storage.viewTraces") }),
      ),
    );
    expect(store.getState()).toMatchObject({
      page: "chat",
      conversationView: "activity",
      conversationScope: "global",
    });
  });

  it("keeps a dirty retention draft through the three-choice guard and saves it on continue", async () => {
    const fake = await renderGuarded();
    const input = screen.getByLabelText(
      translate("connections.storage.manage.retentionDays"),
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "30" } });
    // 切到方案分区：共享 revision 链上的保留草稿触发三选确认，明细如实列出改动。
    await userEvent.click(screen.getByRole("button", { name: translate("schemes.backToCatalog") }));
    await act(async () => {});
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("数据与保留");
    expect(dialog.textContent).toContain("保留天数: 14 → 30");
    expect(store.getState().settingsRoute).toBe("qq-storage");
    // 取消＝留在原页，草稿原样保留、零写入。
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("workspace.stay_here") }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(store.getState().settingsRoute).toBe("qq-storage");
    expect(input.value).toBe("30");
    expect(fake.updateQqStorageSettings).not.toHaveBeenCalled();
    // 保存并继续：独立 storage PUT 成功后清草稿，才切到方案分区。
    await userEvent.click(screen.getByRole("button", { name: translate("schemes.backToCatalog") }));
    await act(async () => {});
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: translate("workspace.save_and_continue"),
      }),
    );
    await act(async () => {});
    expect(fake.updateQqStorageSettings).toHaveBeenCalledWith({
      retention_days: 30,
      expected_revision: 3,
    });
    expect(store.getState().settingsRoute).toBe("scheme-library");
    expect(store.getState().qqInputs.storage).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("discards the retention draft when the guard's discard branch is chosen", async () => {
    const fake = await renderGuarded();
    fireEvent.change(screen.getByLabelText(translate("connections.storage.manage.retentionDays")), {
      target: { value: "25" },
    });
    await userEvent.click(screen.getByRole("button", { name: translate("schemes.backToCatalog") }));
    await act(async () => {});
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: translate("workspace.discard_and_continue"),
      }),
    );
    await act(async () => {});
    expect(fake.updateQqStorageSettings).not.toHaveBeenCalled();
    expect(store.getState().qqInputs.storage).toBeNull();
    expect(store.getState().settingsRoute).toBe("scheme-library");
  });

  it("blocks section navigation while the storage surface is saving", async () => {
    await renderApp("qq-storage");
    act(() => {
      store.setState({ qqStorageSaving: true });
    });
    expect(
      (
        screen.getByRole("button", {
          name: translate("schemes.backToCatalog"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // 路由请求同样被 navigationBusy 拦住，位置不变（统一判忙链路 requestPageNavigation）。
    store.getState().requestPageNavigation("settings", "hub");
    expect(store.getState().settingsRoute).toBe("qq-storage");
    expect(store.getState().settingsView).toBe("workspace");
  });

  it("openSettingsRoute itself is blocked while the storage surface is saving (busy-list regression)", async () => {
    await renderApp("qq-storage");
    act(() => {
      store.setState({ qqStorageSaving: true });
    });
    // 回归：内联判忙名单漏掉 qqStorageSaving 时，requestPageNavigation 静默拒绝后
    // else-if 分支仍会直写 settingsRoute——存储保存中任何 openSettingsRoute 必须零导航。
    act(() => {
      store.getState().openSettingsRoute("qq-connection");
    });
    expect(store.getState().settingsRoute).toBe("qq-storage");
    expect(store.getState().settingsView).toBe("workspace");
    expect(store.getState().page).toBe("settings");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().pendingNavigation).toBeNull();
  });
});

describe("QQ collection description drafts", () => {
  const collection: QqStickerCollectionResponse = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "旧集合",
    description: "旧简介",
    revision: 2,
    asset_count: 0,
  };
  const otherCollection: QqStickerCollectionResponse = {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    name: "另一个集合",
    description: null,
    revision: 5,
    asset_count: 0,
  };

  it("keeps a description-only rename as a draft and clears it after saving", async () => {
    const update = vi.fn().mockResolvedValue({ ...collection, description: "新简介", revision: 3 });
    const fake = client({ updateQqStickerCollection: update });
    store.getState().resetForTests(fake);
    store.setState({
      qqStickerCollections: [collection],
      qqInputs: {
        ...store.getState().qqInputs,
        stickerRenaming: {
          id: collection.id,
          name: collection.name,
          revision: 2,
          description: "新简介",
        },
      },
    });
    const row = qqDraftChanges(store.getState()).find(
      (entry) => entry.id === `collection:${collection.id}`,
    );
    expect(row?.changes).toEqual(["简介: 旧简介 → 新简介"]);
    expect(await store.getState().saveQqDrafts()).toBe(true);
    expect(update).toHaveBeenCalledWith(collection.id, {
      name: "旧集合",
      description: "新简介",
      expected_revision: 2,
    });
    expect(store.getState().qqInputs.stickerRenaming).toBeNull();
  });

  it("omits an unchanged description and refuses a description without a name", async () => {
    const update = vi.fn();
    const create = vi.fn();
    const fake = client({ updateQqStickerCollection: update, createQqStickerCollection: create });
    store.getState().resetForTests(fake);
    store.setState({
      qqStickerCollections: [collection],
      qqInputs: {
        ...store.getState().qqInputs,
        stickerRenaming: { id: collection.id, name: collection.name, revision: 2 },
      },
    });
    // 缺省 description＝本次不改动：名称也没改就没有草稿，保存不发请求。
    expect(
      qqDraftChanges(store.getState()).some((entry) => entry.id.startsWith("collection:")),
    ).toBe(false);
    expect(await store.getState().saveQqDrafts()).toBe(true);
    expect(update).not.toHaveBeenCalled();

    // 只有简介没有名称：草稿成立，但保存被显式拒绝。
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        stickerNewCollection: "",
        stickerNewCollectionDescription: "只有简介",
      },
    });
    expect(qqDraftChanges(store.getState()).some((entry) => entry.id === "new-collection")).toBe(
      true,
    );
    expect(await store.getState().saveQqDrafts()).toBe(false);
    expect(store.getState().error).toBe("请填写集合名称，再保存。");
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a collection from the name and description draft in one request", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      name: "新集合",
      description: "新简介",
      revision: 1,
      asset_count: 0,
    });
    const fake = client({ createQqStickerCollection: create });
    store.getState().resetForTests(fake);
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        stickerNewCollection: "新集合",
        stickerNewCollectionDescription: "新简介",
      },
    });
    expect(qqDraftChanges(store.getState()).some((entry) => entry.id === "new-collection")).toBe(
      true,
    );
    expect(await store.getState().saveQqDrafts()).toBe(true);
    expect(create).toHaveBeenCalledWith({ name: "新集合", description: "新简介" });
    expect(store.getState().qqInputs.stickerNewCollection).toBe("");
    expect(store.getState().qqInputs.stickerNewCollectionDescription).toBe("");
  });

  it("clears a description through an explicit null while keeping the name", async () => {
    const update = vi.fn().mockResolvedValue({ ...collection, description: null, revision: 3 });
    const fake = client({ updateQqStickerCollection: update });
    store.getState().resetForTests(fake);
    store.setState({
      qqStickerCollections: [collection],
      qqInputs: {
        ...store.getState().qqInputs,
        stickerRenaming: { id: collection.id, name: "旧集合", revision: 2, description: null },
      },
    });
    expect(
      qqDraftChanges(store.getState()).find((entry) => entry.id === `collection:${collection.id}`)
        ?.changes,
    ).toEqual(["简介: 旧简介 → "]);
    expect(await store.getState().saveQqDrafts()).toBe(true);
    expect(update).toHaveBeenCalledWith(collection.id, {
      name: "旧集合",
      description: null,
      expected_revision: 2,
    });
  });

  it("carries a description-only rename through the unload guard and saves it when leaving", async () => {
    const update = vi.fn().mockResolvedValue({ ...collection, description: "新简介", revision: 3 });
    const fake = client({ updateQqStickerCollection: update });
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-app-schemes",
      qqStickerCollections: [collection, otherCollection],
      qqInputs: {
        ...store.getState().qqInputs,
        stickerRenaming: {
          id: collection.id,
          name: collection.name,
          revision: 2,
          description: "新简介",
        },
      },
    });
    render(<NavigationGuard />);
    act(() => {
      store.getState().openChat();
    });
    // 只改简介也算草稿：openChat 被三选守卫拦下，位置不动、明细如实列出简介改动。
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().page).toBe("settings");
    expect(store.getState().settingsRoute).toBe("qq-app-schemes");
    expect(screen.getByText("简介: 旧简介 → 新简介")).toBeTruthy();
    // 取消＝留在原页，草稿原样保留、零写入。
    act(() => {
      store.getState().cancelPendingNavigation();
    });
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().qqInputs.stickerRenaming?.description).toBe("新简介");
    expect(update).not.toHaveBeenCalled();
    // 保存并继续：简介随名称一次提交，落地聊天页，另一个集合不动。
    await act(async () => {
      store.getState().openChat();
      await store.getState().confirmSaveAndContinue();
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(collection.id, {
      name: "旧集合",
      description: "新简介",
      expected_revision: 2,
    });
    expect(store.getState().page).toBe("chat");
    expect(store.getState().qqInputs.stickerRenaming).toBeNull();
    expect(store.getState().qqStickerCollections).toEqual([
      { ...collection, description: "新简介", revision: 3 },
      otherCollection,
    ]);
  });

  it("keeps the collection directory server-true when the guard's discard branch drops the draft", async () => {
    const update = vi.fn();
    const fake = client({ updateQqStickerCollection: update });
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-app-schemes",
      qqStickerCollections: [collection, otherCollection],
      qqInputs: {
        ...store.getState().qqInputs,
        stickerRenaming: {
          id: collection.id,
          name: collection.name,
          revision: 2,
          description: "新简介",
        },
      },
    });
    render(<NavigationGuard />);
    act(() => {
      store.getState().openChat();
    });
    expect(store.getState().navigationConfirmOpen).toBe(true);
    await act(async () => {
      await store.getState().confirmDiscardAndContinue();
    });
    // 丢弃＝零写入：草稿清空、落地聊天页，目录保持服务端值（另一个集合也原样）。
    expect(update).not.toHaveBeenCalled();
    expect(store.getState().qqInputs.stickerRenaming).toBeNull();
    expect(store.getState().qqStickerCollections).toEqual([collection, otherCollection]);
    expect(store.getState().page).toBe("chat");
  });
});
