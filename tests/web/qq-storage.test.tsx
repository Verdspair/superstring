// QQ 数据与保留：真实计数、调度裁决、保留设置草稿与手动清理工作区。
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { QqSettingsResponse, QqStorageUsageResponse } from "../../src/shared/contracts/qq";
import type {
  QqStorageCleanupSelectionResponse,
  QqStorageItem,
  QqStorageSettingsResponse,
} from "../../src/shared/contracts/qq-storage";
import { api } from "../../src/web/api";
import { selectLocale, translate } from "../../src/web/i18n";
import { StorageInventory } from "../../src/web/screens/connections/storage-inventory";
import { useSuperstringStore as store } from "../../src/web/store";

const nowSeconds = Math.floor(Date.now() / 1000);

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
    last_swept_at_seconds: nowSeconds - 30,
    entries: [
      {
        kind: "group",
        peer_id: "30003",
        outcome: "skipped",
        reason: "not_quiet_yet",
        observed_at_seconds: nowSeconds - 240,
        ready_at_seconds: nowSeconds + 600,
        decided_at_seconds: nowSeconds - 30,
      },
      {
        kind: "private",
        peer_id: "20002",
        outcome: "scheduled",
        reason: null,
        observed_at_seconds: nowSeconds - 900,
        ready_at_seconds: null,
        decided_at_seconds: nowSeconds - 30,
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

const items: QqStorageItem[] = [
  {
    id: "row-1",
    category: "observation_text",
    account_id: "100",
    kind: "group",
    peer_id: "30003",
    agent_id: "agent-1",
    created_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-15T00:00:00.000Z",
    expired: true,
    protected: false,
  },
  {
    id: "row-2",
    category: "observation_text",
    account_id: "100",
    kind: "private",
    peer_id: "20002",
    agent_id: "agent-1",
    created_at: "2026-09-28T00:00:00.000Z",
    expires_at: "2026-10-12T00:00:00.000Z",
    expired: false,
    protected: false,
  },
  {
    id: "row-3",
    category: "observation_text",
    account_id: "100",
    kind: "group",
    peer_id: "40004",
    agent_id: null,
    created_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-15T00:00:00.000Z",
    expired: true,
    protected: true,
  },
  {
    id: "row-4",
    category: "observation_text",
    account_id: "100",
    kind: "private",
    peer_id: "20005",
    agent_id: null,
    created_at: "2026-09-02T00:00:00.000Z",
    expires_at: "2026-09-16T00:00:00.000Z",
    expired: true,
    protected: false,
  },
];

const firstPage = { items, next_cursor: "cursor-2", total: 120 };

const previewResponse: QqStorageCleanupSelectionResponse = {
  category: "observation_text",
  matched: 3,
  expired: 3,
  protected: 1,
  removable: 2,
  removed: 0,
};
const runResponse: QqStorageCleanupSelectionResponse = { ...previewResponse, removed: 2 };

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    getQqStorage: vi.fn().mockResolvedValue(usage),
    getQqStorageSettings: vi.fn().mockResolvedValue(storageSettings),
    updateQqStorageSettings: vi
      .fn()
      .mockImplementation(async (body: { retention_days: number; expected_revision: number }) => ({
        ...storageSettings,
        retention_days: body.retention_days,
        revision: body.expected_revision + 1,
      })),
    listQqStorageItems: vi.fn().mockResolvedValue(firstPage),
    previewQqStorageCleanup: vi.fn().mockResolvedValue(previewResponse),
    runQqStorageSelectionCleanup: vi.fn().mockResolvedValue(runResponse),
    updateQqTransport: vi.fn(),
    updateQqScheme: vi.fn(),
    ...overrides,
  } as unknown as typeof api;
}

async function renderPage(overrides: Partial<typeof api> = {}, prepare?: () => void) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "qq-storage" });
  prepare?.();
  const result = render(<StorageInventory />);
  await act(async () => {});
  return { fake, ...result };
}

const retentionInput = () =>
  screen.getByLabelText(translate("connections.storage.manage.retentionDays")) as HTMLInputElement;
const retentionSave = () =>
  screen.getByRole("button", {
    name: translate("connections.storage.manage.saveRetention"),
  }) as HTMLButtonElement;
const cleanCategory = () =>
  screen.getByRole("button", {
    name: translate("connections.storage.manage.cleanCategory"),
  }) as HTMLButtonElement;
const cleanSelected = () =>
  screen.getByRole("button", {
    name: translate("connections.storage.manage.cleanSelected"),
  }) as HTMLButtonElement;
// 用 getByText 而不是 getByRole：Radix 对话框打开时会 aria-hidden 背景，
// role 查询会看不到工作区标题，而文本查询不受影响。
const sectionOf = (heading: string) =>
  (screen.getByText(heading) as HTMLElement).closest("section") as HTMLElement;
const rowOf = (peer: string) =>
  within(sectionOf(translate("connections.storage.manage.cleanupTitle")))
    .getByText(peer)
    .closest("tr") as HTMLTableRowElement;

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("Connection storage inventory", () => {
  it("shows reported inventory and retention without inventing missing runtime counters", async () => {
    const { container } = await renderPage();
    const inventory = container.firstElementChild;
    expect(inventory?.classList.contains("px-4")).toBe(true);
    expect(inventory?.className).not.toMatch(/max-w-/);
    expect(screen.getByText("12")).toBeTruthy();
    const number = new Intl.NumberFormat("zh-CN");
    for (const [title, counts] of [
      ["收到的消息", usage.observations],
      ["发言记录", usage.speech],
      ["发送", usage.sends],
      ["昵称缓存", usage.nicknames],
      ["表情素材", usage.stickers],
      ["媒体读取", usage.media],
    ] as const) {
      const group = screen.getByRole("heading", { name: title }).closest("section");
      if (!group) throw new Error(`Missing inventory section: ${title}`);
      expect(Array.from(group.querySelectorAll("dd"), (counter) => counter.textContent)).toEqual(
        Object.values(counts).map((value) => number.format(value)),
      );
    }
    expect(screen.getByText(/消息正文保留 14 天/)).toBeTruthy();
    expect(screen.getByText("旧候选队列 1 项 · 已就绪 0 项 · 空闲")).toBeTruthy();
    expect(screen.queryByText("等待唤醒")).toBeNull();
    // 只有一个清理入口：旧的整表清理按钮不再存在，也没有旧的「本次清理结果」摘要区。
    expect(
      screen.queryByRole("button", { name: translate("connections.storage.clean") }),
    ).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    // 固定手动模式与「只影响新记录」的说明必须如实出现，页面上没有自动清理开关。
    expect(screen.getByText(translate("connections.storage.manage.manualNote"))).toBeTruthy();
    expect(screen.getByText(translate("connections.storage.manage.retentionNote"))).toBeTruthy();
    expect(screen.getByText(translate("connections.storage.manage.metaNote"))).toBeTruthy();
  });
  it("links each conversation to a dated scheduling verdict", async () => {
    await renderPage();
    const sweep = sectionOf(translate("connections.storage.sweep"));
    expect(within(sweep).getByText("群 30003")).toBeTruthy();
    expect(within(sweep).getByText("尚未冷场")).toBeTruthy();
    expect(within(sweep).getByText("私聊 20002")).toBeTruthy();
    expect(within(sweep).getByText("已排队")).toBeTruthy();
  });
  it("does not represent an empty sweep as successful checking", async () => {
    await renderPage({
      getQqStorage: vi.fn().mockResolvedValue({
        ...usage,
        sweep: { tracked: 0, last_swept_at_seconds: null, entries: [] },
      }),
    });
    expect(screen.getByText("暂时没有调度裁决")).toBeTruthy();
  });
});

describe("QQ retention settings", () => {
  it("keeps the typed draft through an explicit refresh and never advances it on entry", async () => {
    const fresh: QqStorageSettingsResponse = {
      ...storageSettings,
      retention_days: 30,
      revision: 8,
    };
    await renderPage({ getQqStorageSettings: vi.fn().mockResolvedValue(fresh) }, () =>
      store.setState({
        qqInputs: {
          ...store.getState().qqInputs,
          storage: { source: storageSettings, days: "40" },
        },
      }),
    );
    // 隐式起载只读服务器值：已改原文与草稿 revision 都不动（否则会拿 8 当基线）。
    expect(retentionInput().value).toBe("40");
    expect(store.getState().qqInputs.storage?.source.revision).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: translate("connections.common.refresh") }));
    await act(async () => {});
    // 显式刷新：未改字段与 revision 跟随新基线，已改原文保留。
    expect(retentionInput().value).toBe("40");
    expect(store.getState().qqInputs.storage?.source.revision).toBe(8);
    expect(store.getState().qqInputs.storage?.days).toBe("40");
  });

  it("saves a changed window as its own PUT without carrying other drafts", async () => {
    const { fake } = await renderPage();
    fireEvent.change(retentionInput(), { target: { value: "30" } });
    await act(async () => fireEvent.click(retentionSave()));
    expect(fake.updateQqStorageSettings).toHaveBeenCalledWith({
      retention_days: 30,
      expected_revision: 3,
    });
    // 这条 PUT 不携带方案/连接草稿。
    expect(fake.updateQqTransport).not.toHaveBeenCalled();
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(store.getState().qqInputs.storage).toBeNull();
    expect(retentionInput().value).toBe("30");
  });

  it("advances the shared revision on the retention draft after a connection save without touching its number", async () => {
    const settings: QqSettingsResponse = {
      enabled: true,
      account_id: null,
      judgement_model_name: null,
      transport: { endpoint: null, has_token: false },
      revision: 3,
    };
    const { fake } = await renderPage({
      updateQqSettings: vi.fn().mockResolvedValue({ ...settings, account_id: "100", revision: 4 }),
    });
    store.setState({
      qqSettings: settings,
      qqInputs: {
        ...store.getState().qqInputs,
        storage: { source: storageSettings, days: "30" },
        connection: {
          source: settings,
          endpoint: "ws://localhost:4000",
          accountId: "100",
          token: "",
        },
      },
    });
    await act(async () => {
      expect(await store.getState().saveQqSurface({ account_id: "100" }, 3)).toBe(true);
    });
    expect(fake.updateQqSettings).toHaveBeenCalledWith({ account_id: "100", expected_revision: 3 });
    // 同一条 qq_settings 修订链：连接 PUT 成功后保留草稿只推进 revision 基线，天数原文不动，
    // 否则连接保存会把存储草稿的基线落在旧值上，下一次存储 PUT 自己撞 409。
    expect(store.getState().qqInputs.storage).toEqual({
      source: { revision: 4, retention_days: 14, cleanup_mode: "manual" },
      days: "30",
    });
    expect(store.getState().qqSettings?.revision).toBe(4);
  });

  it("refuses an out-of-range window without writing", async () => {
    const { fake } = await renderPage();
    fireEvent.change(retentionInput(), { target: { value: "3651" } });
    await act(async () => fireEvent.click(retentionSave()));
    expect(fake.updateQqStorageSettings).not.toHaveBeenCalled();
    expect(store.getState().error).toBe("请填写 1–3650 之间的整数天数，再保存。");
    fireEvent.change(retentionInput(), { target: { value: "" } });
    await act(async () => fireEvent.click(retentionSave()));
    expect(fake.updateQqStorageSettings).not.toHaveBeenCalled();
  });
});

describe("QQ cleanup workspace", () => {
  it("previews without writing, then runs exactly the frozen snapshot and rereads the list", async () => {
    const { fake } = await renderPage();
    fireEvent.click(cleanCategory());
    await act(async () => {});
    // 预览只读：零写入，对话框列出预览统计。
    expect(fake.previewQqStorageCleanup).toHaveBeenCalledWith({ category: "observation_text" });
    expect(fake.runQqStorageSelectionCleanup).not.toHaveBeenCalled();
    expect(store.getState().qqStorageCleanupPreview).toEqual(previewResponse);
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByRole("button", { name: translate("connections.cancel") }),
    ).toBeTruthy();
    // 取消同样零写入，且不留结果。
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.cancel") }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fake.runQqStorageSelectionCleanup).not.toHaveBeenCalled();
    expect(store.getState().qqStorageCleanupRequest).toBeNull();
    expect(store.getState().qqStorageCleanupResult).toBeNull();

    fireEvent.click(cleanCategory());
    await act(async () => {});
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: translate("connections.storage.manage.runCleanup"),
      }),
    );
    await act(async () => {});
    // 确认执行的恰是预览时冻结的请求；结果统计来自服务端回答。
    expect(fake.runQqStorageSelectionCleanup).toHaveBeenCalledWith({
      category: "observation_text",
    });
    expect(store.getState().qqStorageCleanupResult).toEqual(runResponse);
    expect(screen.getByText(translate("connections.storage.cleaned"))).toBeTruthy();
    // 执行成功后摘要已重读。
    expect(fake.getQqStorage).toHaveBeenCalledTimes(2);
    // 结果对话框关闭后重读第一页：被移除的行不得留在列表里。
    const listCalls = (fake.listQqStorageItems as Mock).mock.calls.length;
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: translate("connections.close"),
      }),
    );
    await act(async () => {});
    expect((fake.listQqStorageItems as Mock).mock.calls.length).toBe(listCalls + 1);
    expect((fake.listQqStorageItems as Mock).mock.calls.at(-1)?.[0]).toMatchObject({
      category: "observation_text",
      status: "all",
      limit: 50,
    });
  });

  it("selects only expired rows, disables protected ones, and freezes the selection at preview", async () => {
    const { fake } = await renderPage();
    // 未到期行没有勾选框；受保护行有但禁用；只有到期且未受保护的行可选。
    expect(within(rowOf("私聊 20002")).queryByRole("checkbox")).toBeNull();
    const protectedBox = within(rowOf("群 40004")).getByRole("checkbox") as HTMLButtonElement;
    expect(protectedBox.disabled).toBe(true);
    expect(
      within(rowOf("群 40004")).getByText(translate("connections.storage.manage.protected")),
    ).toBeTruthy();
    expect(cleanSelected().disabled).toBe(true);
    fireEvent.click(within(rowOf("群 30003")).getByRole("checkbox"));
    fireEvent.click(within(rowOf("私聊 20005")).getByRole("checkbox"));
    fireEvent.click(protectedBox);
    expect(cleanSelected().disabled).toBe(false);

    fireEvent.click(cleanSelected());
    await act(async () => {});
    expect(fake.previewQqStorageCleanup).toHaveBeenCalledWith({
      category: "observation_text",
      ids: ["row-1", "row-4"],
    });
    // 预览后改动勾选不改变待确认的快照：执行发送的仍是预览时冻结的 ids。
    // 对话框打开使背景 aria-hidden，勾选框查询需要 hidden 选项。
    fireEvent.click(within(rowOf("群 30003")).getByRole("checkbox", { hidden: true }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: translate("connections.storage.manage.runCleanup"),
      }),
    );
    await act(async () => {});
    expect(fake.runQqStorageSelectionCleanup).toHaveBeenCalledWith({
      category: "observation_text",
      ids: ["row-1", "row-4"],
    });
  });

  it("pages with the server cursor and re-reads the first page on previous", async () => {
    const { fake } = await renderPage();
    const list = fake.listQqStorageItems as Mock;
    const [initial] = list.mock.calls[0] as [{ category: string; limit: number }];
    expect(initial).toMatchObject({ category: "observation_text", status: "all", limit: 50 });
    expect((initial as { cursor?: string }).cursor).toBeUndefined();
    const previous = screen.getByRole("button", {
      name: translate("connections.storage.manage.previousPage"),
    }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: translate("connections.storage.manage.nextPage") }),
    );
    await act(async () => {});
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: "cursor-2", limit: 50 });
    fireEvent.click(previous);
    await act(async () => {});
    const lastQuery = (list.mock.calls.at(-1)?.[0] ?? {}) as { cursor?: string };
    expect(lastQuery).toMatchObject({ category: "observation_text" });
    expect(lastQuery.cursor).toBeUndefined();
  });

  it("applies category, status, kind and peer filters to the server query", async () => {
    const { fake } = await renderPage();
    const list = fake.listQqStorageItems as Mock;
    await userEvent.click(
      screen.getByRole("tab", { name: translate("connections.storage.removed.nicknames") }),
    );
    await act(async () => {});
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ category: "nicknames", status: "all" });
    fireEvent.change(screen.getByLabelText(translate("connections.storage.manage.statusLabel")), {
      target: { value: "expired" },
    });
    await act(async () => {});
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({
      category: "nicknames",
      status: "expired",
    });
    fireEvent.change(screen.getByLabelText(translate("connections.storage.manage.kindLabel")), {
      target: { value: "group" },
    });
    await act(async () => {});
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "group" });
    fireEvent.change(screen.getByLabelText(translate("connections.storage.manage.peerFilter")), {
      target: { value: "30003" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: translate("connections.storage.manage.apply") }),
    );
    await act(async () => {});
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ peer_id: "30003", kind: "group" });
  });

  it("offers a retry for a failed preview and for a failed run", async () => {
    const preview = vi
      .fn()
      .mockRejectedValueOnce(new Error("预览失败"))
      .mockResolvedValue(previewResponse);
    const run = vi.fn().mockRejectedValueOnce(new Error("执行失败")).mockResolvedValue(runResponse);
    await renderPage({ previewQqStorageCleanup: preview, runQqStorageSelectionCleanup: run });
    fireEvent.click(cleanCategory());
    await act(async () => {});
    expect(screen.getByText("预览失败")).toBeTruthy();
    // 预览失败的重试仍是预览（此时没有可执行的快照）。
    await userEvent.click(screen.getByRole("button", { name: translate("capabilities.retry") }));
    await act(async () => {});
    expect(preview).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    // 执行失败：保留预览，重试原样执行同一份快照。
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: translate("connections.storage.manage.runCleanup"),
      }),
    );
    await act(async () => {});
    expect(screen.getByText("执行失败")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: translate("capabilities.retry") }));
    await act(async () => {});
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toEqual({ category: "observation_text" });
  });

  it("aborts the item read and drops late cleanup responses after unmount", async () => {
    const pending = Promise.withResolvers<QqStorageCleanupSelectionResponse>();
    const { fake, unmount } = await renderPage({
      previewQqStorageCleanup: vi.fn(() => pending.promise),
    });
    // loadQqStorageItems 把 AbortSignal 作为第二个实参直接交给 api。
    const signal = (fake.listQqStorageItems as Mock).mock.calls[0][1] as AbortSignal;
    fireEvent.click(cleanCategory());
    expect(store.getState().qqStorageCleanupRequest).toEqual({ category: "observation_text" });
    unmount();
    // 卸载即中止列表读取并作废在途清理操作。
    expect(signal.aborted).toBe(true);
    expect(store.getState().qqStorageCleanupRequest).toBeNull();
    expect(store.getState().qqStorageSaving).toBe(false);
    pending.resolve(previewResponse);
    await act(async () => {});
    expect(store.getState().qqStorageCleanupPreview).toBeNull();
    expect(store.getState().qqStorageCleanupResult).toBeNull();
  });
});

describe("QQ storage task areas (保留/清理/用量与运行)", () => {
  it("keeps retention save in its own area and the cleanup entry in the cleanup area", async () => {
    const { container } = await renderPage();
    // 保留政策：保存钮与其标题同区；不含清理入口。
    const retention = screen
      .getByText(translate("connections.storage.manage.retentionTitle"))
      .closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(retention).getByRole("button", {
        name: translate("connections.storage.manage.saveRetention"),
      }),
    ).toBeTruthy();
    expect(retention.textContent).not.toContain(
      translate("connections.storage.manage.cleanCategory"),
    );
    // 清理工作区：整类清理入口与其标题同卡；不含保留保存钮。
    const cleanup = screen
      .getByText(translate("connections.storage.manage.cleanupTitle"))
      .closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(cleanup).getByRole("button", {
        name: translate("connections.storage.manage.cleanCategory"),
      }),
    ).toBeTruthy();
    expect(cleanup.textContent).not.toContain(
      translate("connections.storage.manage.saveRetention"),
    );
    // 用量与运行：六类统计与调度裁决同区（同卡），裁决保留日期化逐会话事实。
    const sweepHeading = screen.getByText(translate("connections.storage.sweep"));
    const summaryCard = sweepHeading.closest('[data-slot="card"]') as HTMLElement;
    expect(summaryCard.textContent).toContain(translate("connections.storage.observations"));
    expect(within(summaryCard).getByText("群 30003")).toBeTruthy();
    // 页面根没有横向 max-w。
    expect((container.firstElementChild as HTMLElement).className).not.toMatch(/max-w-/);
  });
});

describe("QQ storage table containment (窄屏表内滚动)", () => {
  it("keeps both metadata tables scrolling inside their own container at 320px", async () => {
    const { container } = await renderPage();
    // 数据表与裁决表各自横向滚动，不把整页撑出 320px。
    const tables = Array.from(container.querySelectorAll("table"));
    expect(tables.length).toBe(2);
    for (const table of tables) {
      const wrapper = table.closest("div");
      expect(wrapper?.classList.contains("overflow-x-auto")).toBe(true);
    }
    // 页面根不引入横向溢出（px-4 全宽、无 max-w）。
    const inventory = container.firstElementChild as HTMLElement;
    expect(inventory.className).not.toMatch(/max-w-/);
  });
});
