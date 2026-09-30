import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QqSchemeResponse,
  QqSettingsResponse,
  QqStorageUsageResponse,
} from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { selectLocale, translate } from "../../src/web/i18n";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

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
    scene: "",
    judge: "",
    reply: "",
    review: "",
    sticker: "",
    media: "",
    compress: "",
  },
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

const removed = {
  observation_text: 3,
  media_notes: 0,
  speech: 1,
  sends: 2,
  nicknames: 1,
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
    runQqStorageCleanup: vi.fn().mockResolvedValue(removed),
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
  settingsRoute: "qq-app-schemes" | "qq-connection" | "qq-storage" | "basic",
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

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("QQ app management shell", () => {
  it("keeps the three tasks on one app page and filters the directory to QQ only", async () => {
    const fake = await renderApp("qq-app-schemes");
    expect(screen.getAllByRole("tab").map((node) => node.textContent)).toEqual([
      translate("workspace.schemes"),
      translate("connections.transportPage.tab"),
      translate("connections.dataRetention"),
    ]);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      translate("workspace.schemes"),
    );
    const tablist = screen.getByRole("tablist");
    expect(tablist.className).toContain("flex-wrap");
    expect(tablist.className).toContain("[&_[role=tab]]:flex-none");
    expect(tablist.className).toContain("[&_[role=tab]]:whitespace-normal");
    // 复用的目录组件只留 QQ：应用筛选不再出现，方案行与新建入口仍在。
    expect(screen.queryByLabelText(translate("schemes.appFilter"))).toBeNull();
    expect(screen.getByText("默认方案")).toBeTruthy();
    expect(screen.getByRole("button", { name: translate("connections.newScheme") })).toBeTruthy();
    // 作用域提示只服务连接与数据；方案目录不显示，也不假装在管理连接。
    expect(screen.queryByText(translate("schemes.qq.scopeNote"))).toBeNull();
    expect(fake.getQqStatus).not.toHaveBeenCalled();
    expect(fake.getQqSettings).not.toHaveBeenCalled();
  });

  it("switches between the three tasks by route and shows the scope note there", async () => {
    await renderApp("qq-app-schemes");
    await userEvent.click(
      screen.getByRole("tab", { name: translate("connections.transportPage.tab") }),
    );
    await act(async () => {});
    expect(store.getState().settingsRoute).toBe("qq-connection");
    expect(screen.getByText(translate("schemes.qq.scopeNote"))).toBeTruthy();
    expect(screen.getByLabelText(translate("connections.websocketAddress"))).toBeTruthy();
    await userEvent.click(
      screen.getByRole("tab", { name: translate("connections.dataRetention") }),
    );
    await act(async () => {});
    expect(store.getState().settingsRoute).toBe("qq-storage");
    expect(screen.getByText(translate("schemes.qq.scopeNote"))).toBeTruthy();
    expect(screen.getByText(translate("connections.storage.title"))).toBeTruthy();
  });

  it("returns to the shared scheme catalog from the app header", async () => {
    await renderApp("qq-connection");
    fireEvent.click(screen.getByRole("button", { name: translate("schemes.backToCatalog") }));
    await act(async () => {});
    expect(store.getState().settingsRoute).toBe("scheme-library");
    expect(screen.getByRole("heading", { name: translate("workspace.schemes") })).toBeTruthy();
  });

  it("recognises the legacy operating-mode state instead of rendering an empty page", async () => {
    await renderApp("basic", "operating-mode");
    // 旧别名落到连接页：表单可见、连接 Tab 选中，且不是死空。
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      translate("connections.transportPage.tab"),
    );
    expect(screen.getByLabelText(translate("connections.websocketAddress"))).toBeTruthy();
  });

  it("disables the header navigation while a save is in flight", async () => {
    await renderApp("qq-connection");
    act(() => {
      store.setState({ qqAccessSaving: true });
    });
    expect(
      (
        screen.getByRole("button", {
          name: translate("schemes.backToCatalog"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    for (const name of ["workspace.schemes", "connections.dataRetention"]) {
      expect(
        (screen.getByRole("tab", { name: translate(name) }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
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
    expect(screen.getByText(/消息正文保留 14 天/)).toBeTruthy();
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

  it("cleans expired content only after a confirmation that names the target", async () => {
    const pending = Promise.withResolvers<typeof removed>();
    const cleanup = vi.fn(() => pending.promise);
    const fake = await renderApp("qq-storage", "workspace", {
      runQqStorageCleanup: cleanup as unknown as typeof api.runQqStorageCleanup,
    });
    // 打开页面不自动清理。
    expect(cleanup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: translate("connections.storage.clean") }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("方案、会话绑定与表情素材不会被删除");
    expect(dialog.textContent).toContain("过期的消息正文");
    // 取消不调用清理。
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.cancel") }),
    );
    expect(cleanup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: translate("connections.storage.clean") }));
    const confirm = within(screen.getByRole("alertdialog")).getByRole("button", {
      name: translate("connections.storage.clean"),
    }) as HTMLButtonElement;
    await userEvent.click(confirm);
    expect(cleanup).toHaveBeenCalledTimes(1);
    // 保存中按钮禁用，完成后对话框关闭并重读清单、保留原返回报告。
    expect(confirm.disabled).toBe(true);
    await act(async () => pending.resolve(removed));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fake.getQqStorage).toHaveBeenCalledTimes(2);
    expect(screen.getByText(translate("connections.storage.cleaned"))).toBeTruthy();
  });
});
