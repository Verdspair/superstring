// 运行数据与保留：统计/保护范围展示、列表筛选与分页、行内可清理范围、
// 预览 → 确认的清理流程（取消 0 写、快照锁定、防双写）以及迟到响应与读失败处理。
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionPolicySchema,
  type PermissionsResponse,
} from "../../src/shared/contracts/permissions";
import type {
  RuntimeStorageCleanupRequest,
  RuntimeStorageCleanupResult,
  RuntimeStorageItem,
  RuntimeStorageItemsPage,
  RuntimeStorageSummary,
} from "../../src/shared/contracts/runtime-observability";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { formatDate, i18n } from "../../src/web/i18n/runtime";
import { channelLabels, statusLabels } from "../../src/web/screens/observability/labels";
import { ExecutionSettings } from "../../src/web/screens/runs/execution-settings";
import { RuntimeStoragePanel } from "../../src/web/screens/runs/runtime-storage";
import { useSuperstringStore as store } from "../../src/web/store";

const P = "connections.execution.runtimeStorage";
const NOW = "2026-09-30T12:00:00.000Z";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

// 面板与保留设置实际用到的键：缺任何一条都会让对应语言渲染不出该文案。
const PANEL_KEYS = [
  `${P}.title`,
  `${P}.autoNote`,
  `${P}.scopeNote`,
  `${P}.userContentNote`,
  `${P}.refresh`,
  `${P}.summaryError`,
  `${P}.itemsError`,
  `${P}.categoryLabel`,
  `${P}.statusLabel`,
  `${P}.filterAgentId`,
  `${P}.filterConversationId`,
  `${P}.filterInvalid`,
  `${P}.categoryTraces`,
  `${P}.categoryContexts`,
  `${P}.categoryTaskPayloads`,
  `${P}.statusLive`,
  `${P}.statusExpired`,
  `${P}.retentionLine`,
  `${P}.tracesLine`,
  `${P}.spansLine`,
  `${P}.contextsLine`,
  `${P}.payloadsLine`,
  `${P}.listSummary`,
  `${P}.empty`,
  `${P}.columnSelect`,
  `${P}.columnId`,
  `${P}.columnStatus`,
  `${P}.columnDetail`,
  `${P}.columnExpires`,
  `${P}.columnProtection`,
  `${P}.protectedBadge`,
  `${P}.contextBodyBadge`,
  `${P}.selectRow`,
  `${P}.contextStatusExact`,
  `${P}.contextStatusExpired`,
  `${P}.contextStatusRevoked`,
  `${P}.spansCount`,
  `${P}.lastActivity`,
  `${P}.sources`,
  `${P}.calls`,
  `${P}.selectedCount`,
  `${P}.cleanSelected`,
  `${P}.cleanCategory`,
  `${P}.previewLine`,
  `${P}.confirm`,
  `${P}.resultLine`,
  `${P}.resultCategory`,
  `${P}.truncated`,
  `${P}.prev`,
  `${P}.next`,
  `${P}.actionError`,
  "connections.execution.retention",
  "connections.execution.retentionDays",
  "connections.execution.retentionDaysHint",
];

const T = (key: string, options?: Record<string, string | number>) =>
  i18n.t(key, options) as string;

function summaryFixture(overrides: Partial<RuntimeStorageSummary> = {}): RuntimeStorageSummary {
  return {
    now: NOW,
    retention: {
      traceRetentionDays: 14,
      traceRetentionDefaultDays: 14,
      traceRetentionMinDays: 1,
      traceRetentionMaxDays: 3650,
    },
    cleanupScope: {
      categories: ["traces", "contexts", "task_payloads"],
      protectedTraceStatuses: ["started", "unknown"],
      protectedTaskStatuses: ["queued", "running", "waiting_tool", "waiting_approval", "unknown"],
      protectedCallStatuses: ["running", "waiting_approval", "unknown"],
      contextClearedFields: ["protected_messages", "protected_output"],
      taskClearedFields: ["arguments", "result"],
    },
    traces: { live: 3, expired: 2, started: 1, unknown: 0 },
    spans: { live: 5, expired: 4 },
    contexts: { live: 1, expired: 2, revoked: 1, withProtectedBody: 2, expiredProtectedBodies: 1 },
    taskPayloads: { live: 2, expired: 3, protected: 1, removable: 2 },
    ...overrides,
  };
}

const traceEligible = {
  kind: "trace",
  traceId: "trace-eligible",
  at: NOW,
  lastActivityAt: NOW,
  status: "completed",
  spanCount: 3,
  expiresAt: "2026-09-29T12:00:00.000Z",
  expired: true,
  protected: false,
  channels: ["web"],
  agentId: null,
  conversationId: null,
} satisfies RuntimeStorageItem;
const traceProtected = {
  ...traceEligible,
  traceId: "trace-protected",
  status: "started",
  protected: true,
} satisfies RuntimeStorageItem;
const traceLive = {
  ...traceEligible,
  traceId: "trace-live",
  expired: false,
  protected: false,
} satisfies RuntimeStorageItem;
const contextEligible = {
  kind: "context",
  stepId: "context-eligible",
  runId: "run-eligible",
  at: NOW,
  status: "expired",
  expiresAt: "2026-09-29T12:00:00.000Z",
  expired: true,
  sourceCount: 2,
  hasProtectedBody: true,
  agentId: null,
  conversationId: null,
} satisfies RuntimeStorageItem;
const payloadProtected = {
  kind: "task_payload",
  taskId: "payload-protected",
  conversationId: "22222222-2222-4222-8222-222222222222",
  agentId: AGENT_ID,
  status: "running",
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: "2026-09-29T12:00:00.000Z",
  expired: true,
  protected: true,
  callCount: 2,
  payloadCallCount: 2,
} satisfies RuntimeStorageItem;

function pageFixture(
  items: RuntimeStorageItem[],
  overrides: Partial<RuntimeStorageItemsPage> = {},
): RuntimeStorageItemsPage {
  const live = items.filter((item) => !item.expired).length;
  return {
    now: NOW,
    category: "traces",
    status: "all",
    items,
    nextCursor: null,
    hasMore: false,
    summary: { total: items.length, live, expired: items.length - live },
    ...overrides,
  };
}

function cleanupResult(
  overrides: Partial<RuntimeStorageCleanupResult> = {},
): RuntimeStorageCleanupResult {
  return {
    now: NOW,
    category: "traces",
    dryRun: true,
    expired: 3,
    removable: 2,
    protected: 1,
    matched: 3,
    missing: 0,
    removed: 0,
    ids: [],
    truncated: false,
    ...overrides,
  };
}

interface PanelMocks {
  summary: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  preview: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

async function renderPanel(overrides: Partial<PanelMocks> = {}): Promise<PanelMocks> {
  const mocks: PanelMocks = {
    summary: overrides.summary ?? vi.fn().mockResolvedValue(summaryFixture()),
    list: overrides.list ?? vi.fn().mockResolvedValue(pageFixture([traceEligible])),
    preview:
      overrides.preview ??
      vi.fn().mockResolvedValue(
        cleanupResult({
          dryRun: true,
          expired: 1,
          removable: 1,
          protected: 0,
          matched: 1,
          missing: 0,
          ids: [traceEligible.traceId],
        }),
      ),
    run:
      overrides.run ??
      vi.fn().mockResolvedValue(cleanupResult({ dryRun: false, removed: 1, ids: [] })),
  };
  store.getState().resetForTests({
    ...api,
    getRuntimeStorage: mocks.summary,
    listRuntimeStorageItems: mocks.list,
    previewRuntimeStorageCleanup: mocks.preview,
    runRuntimeStorageCleanup: mocks.run,
  } as unknown as typeof api);
  render(<RuntimeStoragePanel />);
  await act(async () => {});
  return mocks;
}

const selectRowLabel = (id: string) => T(`${P}.selectRow`, { "0": id });

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("runtime storage panel", () => {
  it("shows the retention window, real counters and the server-declared scope", async () => {
    const { summary } = await renderPanel();
    expect(summary).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(T(`${P}.retentionLine`, { "0": 14, "1": 14, "2": 1, "3": 3650 })),
    ).toBeTruthy();
    expect(screen.getByText(T(`${P}.tracesLine`, { "0": 3, "1": 2, "2": 1, "3": 0 }))).toBeTruthy();
    expect(screen.getByText(T(`${P}.spansLine`, { "0": 5, "1": 4 }))).toBeTruthy();
    expect(
      screen.getByText(T(`${P}.contextsLine`, { "0": 1, "1": 2, "2": 1, "3": 2, "4": 1 })),
    ).toBeTruthy();
    expect(
      screen.getByText(T(`${P}.payloadsLine`, { "0": 2, "1": 3, "2": 1, "3": 2 })),
    ).toBeTruthy();
    // 保护范围来自服务端 cleanupScope：状态经既有标签翻译，字段码保持稳定拼写。
    const traceScope = ["started", "unknown"].map((value) => T(statusLabels[value])).join(" / ");
    const taskScope = ["queued", "running", "waiting_tool", "waiting_approval", "unknown"]
      .map((value) => T(`connections.tasks.status.${value}`))
      .join(" / ");
    const callScope = ["running", "waiting_approval", "unknown"]
      .map((value) => T(`connections.tasks.status.${value}`))
      .join(" / ");
    expect(
      screen.getByText(
        T(`${P}.scopeNote`, {
          "0": traceScope,
          "1": taskScope,
          "2": callScope,
          "3": "protected_messages, protected_output",
          "4": "arguments, result",
        }),
      ),
    ).toBeTruthy();
    expect(screen.getByText(T(`${P}.autoNote`))).toBeTruthy();
    expect(screen.getByText(T(`${P}.userContentNote`))).toBeTruthy();
  });

  it("offers checkboxes only for removable expired rows and marks protected rows", async () => {
    const list = vi
      .fn()
      .mockResolvedValue(
        pageFixture([traceLive, traceEligible, traceProtected, contextEligible, payloadProtected]),
      );
    await renderPanel({ list });
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual([
      selectRowLabel(traceEligible.traceId),
      selectRowLabel(contextEligible.stepId),
    ]);
    expect(screen.getAllByText(T(`${P}.protectedBadge`))).toHaveLength(2);
    expect(screen.getByText(T(`${P}.contextBodyBadge`))).toBeTruthy();
    expect(screen.getByText(T(`${P}.columnProtection`))).toBeTruthy();
    expect(screen.queryByLabelText(selectRowLabel(traceLive.traceId))).toBeNull();
    expect(screen.getByText(T(`${P}.listSummary`, { "0": 5, "1": 1, "2": 4 }))).toBeTruthy();
  });

  it("applies category, status and UUID filters to the list query and rejects bad ids", async () => {
    const list = vi.fn().mockResolvedValue(pageFixture([traceEligible]));
    await renderPanel({ list });
    const [initial] = list.mock.calls[0];
    expect(initial).toMatchObject({ category: "traces", status: "all", limit: 50 });
    expect(initial.cursor).toBeUndefined();

    fireEvent.mouseDown(screen.getByRole("tab", { name: T(`${P}.categoryContexts`) }));
    await act(async () => {});
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ category: "contexts", status: "all" });

    fireEvent.mouseDown(screen.getByRole("tab", { name: T(`${P}.statusExpired`) }));
    await act(async () => {});
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ category: "contexts", status: "expired" });

    const before = list.mock.calls.length;
    fireEvent.change(screen.getByLabelText(T(`${P}.filterAgentId`)), {
      target: { value: "not-a-uuid" },
    });
    fireEvent.click(screen.getByRole("button", { name: T("observability.applyFilters") }));
    await act(async () => {});
    expect(screen.getByText(T(`${P}.filterInvalid`))).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(before);

    fireEvent.change(screen.getByLabelText(T(`${P}.filterAgentId`)), {
      target: { value: AGENT_ID },
    });
    fireEvent.click(screen.getByRole("button", { name: T("observability.applyFilters") }));
    await act(async () => {});
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({
      category: "contexts",
      status: "expired",
      agentId: AGENT_ID,
    });
  });

  it("pages 50 rows at a time forward and back through the cursor trail", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(
        pageFixture([traceEligible], { hasMore: true, nextCursor: "cursor-1" }),
      )
      .mockResolvedValueOnce(pageFixture([contextEligible]))
      .mockResolvedValue(pageFixture([traceEligible]));
    await renderPanel({ list });
    const prev = () => screen.getByRole("button", { name: T(`${P}.prev`) }) as HTMLButtonElement;
    expect(prev().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: T(`${P}.next`) }));
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0]).toMatchObject({ limit: 50, cursor: "cursor-1" });
    expect(screen.getByText(contextEligible.stepId)).toBeTruthy();
    fireEvent.click(prev());
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2][0].cursor).toBeUndefined();
    expect(screen.getByText(traceEligible.traceId)).toBeTruthy();
  });

  it("previews the selected rows and cancels without any write", async () => {
    const preview = vi.fn().mockResolvedValue(
      cleanupResult({
        dryRun: true,
        expired: 1,
        removable: 1,
        protected: 0,
        matched: 1,
        missing: 0,
        ids: [traceEligible.traceId],
      }),
    );
    const run = vi.fn();
    await renderPanel({ preview, run });
    fireEvent.click(screen.getByRole("checkbox", { name: selectRowLabel(traceEligible.traceId) }));
    fireEvent.click(screen.getByRole("button", { name: T(`${P}.cleanSelected`) }));
    await act(async () => {});
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0][0]).toEqual({ category: "traces", ids: [traceEligible.traceId] });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(T(`${P}.previewLine`, { "0": 1, "1": 1, "2": 0, "3": 1 }));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("locks the previewed snapshot, executes once and reports real units", async () => {
    const list = vi.fn().mockResolvedValue(pageFixture([traceEligible]));
    const pending = Promise.withResolvers<RuntimeStorageCleanupResult>();
    const run = vi.fn((_request: RuntimeStorageCleanupRequest) => pending.promise);
    const { summary } = await renderPanel({ list, run });
    const box = screen.getByRole("checkbox", { name: selectRowLabel(traceEligible.traceId) });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: T(`${P}.cleanSelected`) }));
    await act(async () => {});
    const dialog = screen.getByRole("alertdialog");
    // 预览之后即使勾选被改动，确认执行的仍是锁定的目标快照；重复点击只执行一次。
    fireEvent.click(box);
    const confirm = within(dialog).getByRole("button", { name: T(`${P}.confirm`) });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({ category: "traces", ids: [traceEligible.traceId] });
    await act(async () => {
      pending.resolve(
        cleanupResult({
          dryRun: false,
          removed: 2,
          expired: 3,
          protected: 1,
          matched: 3,
          missing: 1,
          ids: [traceEligible.traceId, "trace-other"],
        }),
      );
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(
      T(`${P}.resultLine`, { "0": 2, "1": 3, "2": 1, "3": 3, "4": 1 }),
    );
    expect(status.textContent).toContain(
      T(`${P}.resultCategory`, { "0": T(`${P}.categoryTraces`) }),
    );
    // 清理后重读统计与当前页。
    expect(summary).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("cleans a whole category by scope without inventing an ids list", async () => {
    const preview = vi.fn().mockResolvedValue(cleanupResult({ dryRun: true, ids: [] }));
    const run = vi.fn().mockResolvedValue(cleanupResult({ dryRun: false, removed: 2, ids: [] }));
    await renderPanel({ preview, run });
    fireEvent.click(screen.getByRole("button", { name: T(`${P}.cleanCategory`) }));
    await act(async () => {});
    expect(preview.mock.calls[0][0]).toEqual({ category: "traces" });
    // 空 ids 是 422 而不是"全部"，所以从不发送 ids 字段。
    expect("ids" in preview.mock.calls[0][0]).toBe(false);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: T(`${P}.confirm`) }),
    );
    await act(async () => {});
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({ category: "traces" });
  });

  it("reports read failures and retries the same query", async () => {
    const summary = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(summaryFixture());
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("list down"))
      .mockResolvedValue(pageFixture([traceEligible]));
    await renderPanel({ summary, list });
    expect(screen.getByText(T(`${P}.summaryError`, { "0": "offline" }))).toBeTruthy();
    expect(screen.getByText(T(`${P}.itemsError`, { "0": "list down" }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: T("capabilities.retry") }));
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText(traceEligible.traceId)).toBeTruthy();
    expect(screen.queryByText(T(`${P}.itemsError`, { "0": "list down" }))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: T(`${P}.refresh`) }));
    await act(async () => {});
    expect(summary).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(T(`${P}.retentionLine`, { "0": 14, "1": 14, "2": 1, "3": 3650 })),
    ).toBeTruthy();
  });

  it("does not let a superseded page land after the category changed", async () => {
    const stale = Promise.withResolvers<RuntimeStorageItemsPage>();
    const list = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(pageFixture([contextEligible], { category: "contexts" }));
    await renderPanel({ list });
    fireEvent.mouseDown(screen.getByRole("tab", { name: T(`${P}.categoryContexts`) }));
    await act(async () => {});
    await act(async () => {
      stale.resolve(pageFixture([traceEligible]));
    });
    expect(screen.queryByText(traceEligible.traceId)).toBeNull();
    expect(screen.getByText(contextEligible.stepId)).toBeTruthy();
  });

  it("does not clear page or set error when superseded category query rejects late", async () => {
    const stale = Promise.withResolvers<RuntimeStorageItemsPage>();
    const list = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(pageFixture([contextEligible], { category: "contexts" }));
    await renderPanel({ list });
    fireEvent.mouseDown(screen.getByRole("tab", { name: T(`${P}.categoryContexts`) }));
    await act(async () => {});
    await act(async () => {
      stale.reject(new Error("Superseded category error"));
    });
    expect(screen.queryByText("Superseded category error")).toBeNull();
    expect(screen.getByText(contextEligible.stepId)).toBeTruthy();
  });

  it("preserves loaded page data across window blur and cancels an in-flight query only when hidden", async () => {
    const pendingQuery = Promise.withResolvers<RuntimeStorageItemsPage>();
    const signals: AbortSignal[] = [];
    const list = vi
      .fn()
      .mockResolvedValueOnce(pageFixture([traceEligible]))
      .mockImplementationOnce((_params, signal) => {
        if (signal) signals.push(signal);
        return pendingQuery.promise;
      });
    await renderPanel({ list });
    expect(screen.getByText(traceEligible.traceId)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: T("observability.applyFilters") }));
    expect(list).toHaveBeenCalledTimes(2);
    fireEvent.blur(window);
    expect(screen.getByText(traceEligible.traceId)).toBeTruthy();
    expect(signals[0]?.aborted).toBe(false);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByText(traceEligible.traceId)).toBeTruthy();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("sits under the retention section of the execution settings page", async () => {
    const permissions: PermissionsResponse = {
      revision: "pr-1",
      policy: { version: 1, grants: [], execution: ExecutionPolicySchema.parse({}) },
      resources: [],
    };
    const summary = vi.fn().mockResolvedValue(summaryFixture());
    store.getState().resetForTests({
      ...api,
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getRuntimeStorage: summary,
      listRuntimeStorageItems: vi.fn().mockResolvedValue(pageFixture([])),
      previewRuntimeStorageCleanup: vi.fn(),
      runRuntimeStorageCleanup: vi.fn(),
    } as unknown as typeof api);
    render(<ExecutionSettings />);
    await act(async () => {});
    const nav = screen.getByRole("navigation", { name: "执行设置" });
    expect(
      within(nav).getByRole("link", { name: T("connections.execution.retention") }),
    ).toBeTruthy();
    const retention = screen.getByLabelText(
      T("connections.execution.retentionDays"),
    ) as HTMLInputElement;
    expect(retention.value).toBe("14");
    expect(
      screen.getByRole("heading", { name: T("connections.execution.retention") }),
    ).toBeTruthy();
    expect(screen.getByText(T(`${P}.title`))).toBeTruthy();
    expect(summary).toHaveBeenCalled();
  });
});

describe("runtime storage catalogs", () => {
  it("resolves every panel key from the shipped zh and en catalogs", () => {
    for (const lng of ["zh-CN", "en"]) {
      const missing = PANEL_KEYS.filter((key) => !i18n.exists(key, { lng }));
      expect(missing).toEqual([]);
    }
  });

  it("renders the English catalog and the narrow-width wrap classes at 320px (DOM only)", async () => {
    // jsdom 无布局：这里只证明 DOM（文案与类名），几何与浏览器行为不由本用例声称。
    vi.stubGlobal("innerWidth", 320);
    await act(async () => {
      selectLocale("en");
    });
    await renderPanel();
    expect(i18n.language).toBe("en");
    const titleKey = `${P}.title`;
    const english = T(titleKey);
    const chinese = i18n.t(titleKey, { lng: "zh-CN" }) as string;
    expect(english).not.toBe(titleKey);
    expect(english).not.toBe(chinese);
    expect(screen.getByText(english)).toBeTruthy();
    expect(screen.queryByText(chinese)).toBeNull();
    expect(document.body.textContent).not.toContain(P);

    const lists = screen.getAllByRole("tablist");
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect(list.className).toContain("max-w-full");
      expect(list.className).toContain("flex-wrap");
      expect(list.className).toContain("group-data-horizontal/tabs:h-auto");
      expect(list.className).toContain("[&_[role=tab]]:min-h-8");
      expect(list.className).toContain("[&_[role=tab]]:flex-none");
      expect(list.className).toContain("[&_[role=tab]]:whitespace-normal");
    }

    const idCell = screen.getByText(traceEligible.traceId).closest("td");
    expect(idCell?.textContent).toBe(traceEligible.traceId);
    expect(idCell?.className).toContain("whitespace-normal");
    expect(idCell?.className).toContain("break-words");
    expect(idCell?.className).not.toContain("truncate");

    const detail = [
      T(`${P}.spansCount`, { "0": 3 }),
      T(channelLabels.web),
      T(`${P}.lastActivity`, { "0": formatDate(NOW, "en") }),
    ].join(" · ");
    const detailCell = screen.getByText(detail).closest("td");
    expect(detailCell?.textContent).toBe(detail);
    expect(detailCell?.className).toContain("whitespace-normal");
    expect(detailCell?.className).toContain("break-words");
    expect(detailCell?.className).not.toContain("truncate");

    for (const label of [`${P}.filterAgentId`, `${P}.filterConversationId`]) {
      const input = screen.getByLabelText(T(label));
      expect(input.className).toContain("min-w-0");
      expect(input.className).toContain("max-w-full");
    }
  });

  it("cancels old in-flight request when filters are applied and immediately dispatches new query", async () => {
    const stale = Promise.withResolvers<RuntimeStorageItemsPage>();
    const filteredPage = pageFixture([traceEligible], { category: "traces" });
    const list = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(filteredPage);

    await renderPanel({ list });
    expect(list).toHaveBeenCalledTimes(1);

    // Apply agent filter while initial request is still in-flight
    const input = screen.getByLabelText(T(`${P}.filterAgentId`));
    fireEvent.change(input, { target: { value: AGENT_ID } });
    fireEvent.click(screen.getByRole("button", { name: T("observability.applyFilters") }));

    // The new query MUST be dispatched immediately, not blocked by the in-flight pending request!
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0]).toMatchObject({ agentId: AGENT_ID });

    // Old in-flight request rejects late
    await act(async () => {
      stale.reject(new Error("Old stale query rejected"));
    });

    // Old rejection must not wipe out or show error
    expect(screen.queryByText("Old stale query rejected")).toBeNull();
  });
  it("pauses summary and list polling when active becomes false and aborts in-flight query while keeping page data", async () => {
    vi.useFakeTimers();
    let inFlightSignal: AbortSignal | undefined;
    const summary = vi.fn().mockResolvedValue(summaryFixture());
    const list = vi
      .fn()
      .mockResolvedValueOnce(pageFixture([traceEligible]))
      .mockImplementation((_params, signal) => {
        inFlightSignal = signal;
        return new Promise(() => {}); // stays pending
      });

    store.getState().resetForTests({
      ...api,
      getRuntimeStorage: summary,
      listRuntimeStorageItems: list,
    } as unknown as typeof api);

    const { rerender } = render(<RuntimeStoragePanel active={true} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(traceEligible.traceId)).toBeTruthy();
    expect(summary).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);

    // Advance 5000ms: second polling round starts (stays in-flight)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(summary).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);

    // Now space is hidden: active becomes false
    rerender(<RuntimeStoragePanel active={false} />);
    await act(async () => {});

    // In-flight read should be cancelled/aborted
    expect(inFlightSignal?.aborted).toBe(true);
    // Page data must still be visible (retained)
    expect(screen.getByText(traceEligible.traceId)).toBeTruthy();

    // Advance time further while hidden: NO new polling requests should fire
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(summary).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);

    // Space becomes active again
    rerender(<RuntimeStoragePanel active={true} />);
    await act(async () => {});
    // Page data is still visible
    expect(screen.getByText(traceEligible.traceId)).toBeTruthy();
  });
});
