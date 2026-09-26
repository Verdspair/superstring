import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  RuntimeSpan,
  RuntimeSpansPage,
  RuntimeTrace,
} from "../../src/shared/contracts/runtime-observability";
import { api, type SuperstringApi } from "../../src/web/api";
import { APP_SECTIONS, currentAppSection, sectionDestinations } from "../../src/web/app/app-routes";
import { ConversationRuntimeSummary } from "../../src/web/features/observability/ConversationRuntimeSummary";
import { TraceExplorer } from "../../src/web/features/observability/TraceExplorer";
import { localDateTime } from "../../src/web/features/observability/trace-filters";
import { useSuperstringStore as store } from "../../src/web/store";

const now = "2026-09-26T00:00:00Z";
const conversationId = "11111111-1111-4111-8111-111111111111";
const traceId = "a".repeat(32);
const span = (id = 10, patch: Partial<RuntimeSpan> = {}): RuntimeSpan => ({
  id,
  traceId: id === 10 ? traceId : id.toString(16).padStart(32, "0"),
  spanId: `span-${id}`,
  parentSpanId: null,
  name: "Model generation",
  at: now,
  finishedAt: now,
  durationMs: 900,
  channel: "onebot11",
  stage: "model",
  status: "completed",
  code: "MODEL_COMPLETED",
  model: "local/model",
  conversationId,
  agentId: null,
  runId: null,
  wakeId: "wake",
  outputId: null,
  sourceSeq: 100,
  details: { attempt: 2 },
  ...patch,
});
const page = (items = [span()], patch: Partial<RuntimeSpansPage> = {}): RuntimeSpansPage => ({
  items,
  nextBeforeId: items.at(-1)?.id ?? 0,
  hasMore: false,
  summary: { total: 123, active: 2, failed: 3, unknown: 4, lastActivityAt: now, now },
  ...patch,
});
const traceGroup = (root: RuntimeSpan): RuntimeTrace => ({
  traceId: root.traceId,
  cursorId: root.id,
  root,
  at: root.at,
  lastActivityAt: root.at,
  finishedAt: root.finishedAt,
  durationMs: root.durationMs ?? 0,
  status: root.status,
  spanCount: 1,
  matchedSpanCount: 1,
  models: root.model ? [root.model] : [],
  channels: [root.channel],
  runIds: root.runId ? [root.runId] : [],
  wakeIds: root.wakeId ? [root.wakeId] : [],
  causes: typeof root.details.cause === "string" ? [root.details.cause] : [],
  specIds: typeof root.details.specId === "string" ? [root.details.specId] : [],
});
// Existing interaction assertions use span fixtures; translate them into the new server group DTO.
const setup = (client: Partial<SuperstringApi>) =>
  store.getState().resetForTests({
    ...api,
    ...client,
    listRuntimeTraces:
      client.listRuntimeTraces ??
      (async (filters, signal) => {
        const source = await (client.listRuntimeSpans ?? api.listRuntimeSpans)(filters, signal);
        return {
          items: source.items.map(traceGroup),
          nextBeforeId: source.nextBeforeId,
          hasMore: source.hasMore,
          summary: {
            totalTraces: source.summary.total,
            activeTraces: source.summary.active,
            failedTraces: source.summary.failed,
            matchedSpans: source.summary.total,
            lastActivityAt: source.summary.lastActivityAt,
            now: source.summary.now,
          },
        };
      }),
    getRuntimeWaterfall:
      client.getRuntimeWaterfall ??
      (async (id, _filters, signal) => {
        const source = await (client.getRuntimeTrace ?? api.getRuntimeTrace)(id, undefined, signal);
        const root = source.items.find((item) => item.parentSpanId === null) ?? source.items[0];
        if (!root) throw new Error("Trace fixture needs a root");
        return {
          trace: {
            ...traceGroup(root),
            spanCount: source.items.length,
            matchedSpanCount: source.items.length,
          },
          items: source.items,
          matchedSpanIds: source.items.map((item) => item.spanId),
          now: source.summary.now,
        };
      }),
  });
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("searches the full server data set with typed filters and preserves applied URL filters", async () => {
  const list = vi.fn().mockResolvedValue(page());
  setup({ listRuntimeSpans: list });
  const view = render(<TraceExplorer />);
  await screen.findByText("Model generation");
  expect(screen.getByText("共 123 条链路 · 活跃 2 · 含失败 3 · 123 个阶段命中")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("搜索运行记录"), { target: { value: "retry wake-id" } });
  fireEvent.change(screen.getByLabelText("来源通道"), { target: { value: "memory" } });
  fireEvent.change(screen.getByLabelText("处理阶段"), { target: { value: "model" } });
  fireEvent.change(screen.getByLabelText("处理状态"), { target: { value: "failed" } });
  fireEvent.click(screen.getByText("模型、时间与关联筛选"));
  fireEvent.change(screen.getByLabelText("模型（精确匹配）"), { target: { value: "local/model" } });
  fireEvent.change(screen.getByLabelText("开始时间（本地）"), {
    target: { value: localDateTime(now) },
  });
  fireEvent.change(screen.getByLabelText("Trace ID"), { target: { value: traceId } });
  fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(list.mock.calls[1][0]).toEqual({
    q: "retry wake-id",
    channel: "memory",
    stage: "model",
    status: "failed",
    model: "local/model",
    from: new Date(now).toISOString(),
    traceId,
    beforeId: undefined,
    limit: 100,
  });
  expect(new URLSearchParams(window.location.search).get("trace-q")).toBe("retry wake-id");
  view.unmount();
  render(<TraceExplorer />);
  expect((screen.getByLabelText("搜索运行记录") as HTMLInputElement).value).toBe("retry wake-id");
  await screen.findByText("Model generation");
});
it("clearing a scoped filter retains the conversation and ignores global URL filters", async () => {
  window.history.replaceState(null, "", "/?trace-channel=web&trace-q=global");
  const list = vi.fn().mockResolvedValue(page());
  setup({ listRuntimeSpans: list });
  render(<TraceExplorer conversationId={conversationId} />);
  await screen.findByText("Model generation");
  expect(list.mock.calls[0][0]).toEqual({ conversationId, beforeId: undefined, limit: 100 });
  fireEvent.change(screen.getByLabelText("搜索运行记录"), { target: { value: "scoped" } });
  fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  expect(list.mock.calls[2][0]).toEqual({ conversationId, beforeId: undefined, limit: 100 });
  expect(window.location.search).toContain("trace-q=global");
});
it("new filters abort old requests and cannot display late results", async () => {
  let resolve!: (value: RuntimeSpansPage) => void;
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(page([span(11, { name: "New scope" })]));
  setup({ listRuntimeSpans: list });
  render(<TraceExplorer />);
  fireEvent.change(screen.getByLabelText("处理状态"), { target: { value: "unknown" } });
  fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));
  await screen.findByText("New scope");
  await act(async () => resolve(page([span(10, { name: "Old unauthorized scope" })])));
  expect(list.mock.calls[0][1].aborted).toBe(true);
  expect(screen.queryByText("Old unauthorized scope")).toBeNull();
});
it("revalidates every loaded trace page and clears unverifiable records on a failed refresh", async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([span(20)], { hasMore: true }))
    .mockResolvedValueOnce(page([span(10, { name: "Earlier model" })], { hasMore: true }))
    .mockResolvedValueOnce(page([span(30, { name: "Newest model" }), span(20)], { hasMore: true }))
    .mockResolvedValueOnce(page([span(10, { name: "Earlier model" })], { hasMore: true }))
    .mockRejectedValue(new Error("Access revoked"));
  setup({ listRuntimeSpans: list });
  render(<TraceExplorer />);
  await screen.findByText("Model generation");
  fireEvent.click(screen.getByRole("button", { name: "加载更早运行记录" }));
  await screen.findByText("Earlier model");
  expect(list.mock.calls[1][0].beforeId).toBe(20);
  fireEvent.click(screen.getByRole("button", { name: "刷新运行记录" }));
  await screen.findByText("Newest model");
  expect(list.mock.calls[3][0].beforeId).toBe(20);
  expect(screen.getByText("Earlier model")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新运行记录" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Earlier model")).toBeNull();
  expect(screen.queryByText("Newest model")).toBeNull();
});
it("opens a complete trace with parent relationships, unknown outcomes and keyboard close", async () => {
  const trace = vi.fn().mockResolvedValue(
    page([
      span(11, {
        name: "Sticker delivery",
        stage: "delivery",
        status: "unknown",
        code: "DELIVERY_UNKNOWN",
        parentSpanId: "span-10",
      }),
      span(10, { name: "Parent generation" }),
    ]),
  );
  setup({ listRuntimeSpans: async () => page(), getRuntimeTrace: trace });
  render(<TraceExplorer />);
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "展开时序链路" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Sticker delivery");
  expect(trace.mock.calls[0][0]).toBe(traceId);
  const child = within(dialog).getByText("Sticker delivery").closest("li");
  expect(child?.parentElement?.closest("li")?.id).toBe("trace-span-span-10");
  if (!child) throw new Error("Expected child step");
  fireEvent.click(within(child).getByRole("button", { name: "查看步骤详情" }));
  expect(
    within(dialog).getByText("结果尚未确认，不等同于失败；请沿追踪链路核对后续结果。"),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("shows actual connection/window/queue state separately from trace counts", async () => {
  setup({
    getConversationRuntimeStatus: async () => ({
      pendingWakes: 2,
      activeRuns: 1,
      failedWakes: 3,
      unknownDeliveries: 1,
      nextReadyAt: "2026-09-26T00:01:00Z",
      lastActivityAt: now,
      now,
      connectionPhase: "closed",
    }),
  });
  render(<ConversationRuntimeSummary conversationId={conversationId} />);
  await screen.findByText("连接已断开");
  expect(screen.getByText("进行中 1 · 排队 2")).toBeTruthy();
  fireEvent.click(screen.getByText("连接已断开"));
  expect(screen.getByText("等待窗口至")).toBeTruthy();
  expect(screen.getByText("待确认投递 1")).toBeTruthy();
});
it("adds a guarded Agent destination without changing the five primary sections", async () => {
  setup({});
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
    qqInputs: { ...store.getState().qqInputs, schemeTexts: { "rhythm.hourly_speech_limit": "-" } },
  });
  const destination = sectionDestinations("agent").find((item) => item.id === "observability");
  expect(APP_SECTIONS).toHaveLength(5);
  destination?.open(store.getState());
  expect(store.getState().navigationConfirmOpen).toBe(true);
  expect(store.getState().settingsView).toBe("workspace");
  store.getState().cancelPendingNavigation();
  expect(store.getState().qqInputs.schemeTexts["rhythm.hourly_speech_limit"]).toBe("-");
  store.setState({ settingsView: "observability" });
  expect(currentAppSection(store.getState())).toBe("agent");
});
it("serializes directional history and observation filters into no-store requests", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextSeq: 0, firstSeq: 0, hasMore: false })),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify(page([]))));
  await api.getConversationEvents(conversationId, {
    direction: "before",
    beforeSeq: 100,
    limit: 50,
  });
  await api.listRuntimeSpans({
    q: "wake & retry",
    channel: "onebot11",
    model: "local/model",
    beforeId: 20,
  });
  const historyUrl = new URL(String(fetcher.mock.calls[0][0]), "http://localhost");
  expect(historyUrl.searchParams.get("direction")).toBe("before");
  expect(historyUrl.searchParams.get("beforeSeq")).toBe("100");
  const traceUrl = new URL(String(fetcher.mock.calls[1][0]), "http://localhost");
  expect(traceUrl.searchParams.get("q")).toBe("wake & retry");
  expect(traceUrl.searchParams.get("model")).toBe("local/model");
  expect(fetcher.mock.calls[1][1]?.cache).toBe("no-store");
});
it("applies a native local-time range as ISO and offers recent-time presets", async () => {
  const list = vi.fn().mockResolvedValue(page());
  setup({ listRuntimeSpans: list });
  render(<TraceExplorer />);
  await screen.findByText("Model generation");
  fireEvent.click(screen.getByText("模型、时间与关联筛选"));
  expect(screen.getByLabelText("开始时间（本地）").getAttribute("type")).toBe("datetime-local");
  fireEvent.click(screen.getByRole("button", { name: "最近 15 分钟" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  const filters = list.mock.calls[1][0];
  expect(Date.parse(filters.to) - Date.parse(filters.from)).toBe(15 * 60_000);
  expect(new URLSearchParams(window.location.search).get("trace-from")).toBe(filters.from);
});

it("keeps a selected trace open when completion removes its filtered result row", async () => {
  window.history.replaceState(null, "", "/?trace-status=started");
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([span(10, { status: "started" })]))
    .mockResolvedValue(page([]));
  const trace = vi
    .fn()
    .mockResolvedValueOnce(page([span(10, { status: "started" })]))
    .mockResolvedValue(page([span(10, { name: "Completed trace step" })]));
  setup({ listRuntimeSpans: list, getRuntimeTrace: trace });
  render(<TraceExplorer />);
  const trigger = await screen.findByRole("button", { name: "展开时序链路" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findAllByText("Model generation");
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(trigger.isConnected).toBe(false);
  expect(screen.getByRole("dialog")).toBe(dialog);
  await within(dialog).findAllByText("Completed trace step");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭追踪链路" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "刷新运行记录" }));
});

it("retains trace selection across blur while clearing and revalidating its source data", async () => {
  const trace = vi
    .fn()
    .mockResolvedValueOnce(page([span(10, { name: "Private trace metadata" })]))
    .mockRejectedValue(new Error("Trace access expired"));
  setup({ listRuntimeSpans: async () => page(), getRuntimeTrace: trace });
  render(<TraceExplorer />);
  fireEvent.click(await screen.findByRole("button", { name: "展开时序链路" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findAllByText("Private trace metadata");
  fireEvent.blur(window);
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(within(dialog).queryByText("Private trace metadata")).toBeNull();
  fireEvent.focus(window);
  await within(dialog).findByText("Trace access expired");
  expect(within(dialog).queryByText("Private trace metadata")).toBeNull();
});

it("closes trace selection when the applied filter scope changes", async () => {
  setup({ listRuntimeSpans: async () => page(), getRuntimeTrace: async () => page() });
  render(<TraceExplorer />);
  const status = screen.getByLabelText("处理状态");
  const apply = screen.getByRole("button", { name: "应用筛选" });
  fireEvent.click(await screen.findByRole("button", { name: "展开时序链路" }));
  await screen.findByRole("dialog");
  fireEvent.change(status, { target: { value: "failed" } });
  fireEvent.click(apply);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
