import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  RuntimeSpan,
  RuntimeSpansPage,
  RuntimeTrace,
} from "../../src/shared/contracts/runtime-observability";
import { api, type SuperstringApi } from "../../src/web/api";
import { localDateTime } from "../../src/web/features/observability/trace-filters";
import { i18n } from "../../src/web/i18n/runtime";
import { ConversationRuntimeSummary } from "../../src/web/screens/observability/ConversationActivity";
import { ExecutionWorkspace } from "../../src/web/screens/observability/ObservabilityWorkspace";
import { DeliveryDetails } from "../../src/web/screens/runs/DeliveryEvidence";
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
  void i18n.changeLanguage("zh-CN");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const pointer = async (target: HTMLElement) =>
  userEvent.setup().pointer({ target, keys: "[MouseLeft]", coords: { x: 100, y: 100 } });
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
it("applies all typed server filters through the new query bar and preserves URL scope", async () => {
  const list = vi.fn().mockResolvedValue(page());
  setup({ listRuntimeSpans: list });
  render(<ExecutionWorkspace />);
  await screen.findByRole("table", { name: "执行记录" });
  fireEvent.change(screen.getByRole("textbox", { name: "搜索运行记录" }), {
    target: { value: "wake & retry" },
  });
  await pointer(screen.getByRole("button", { name: "添加筛选" }));
  fireEvent.change(screen.getByRole("combobox", { name: "来源通道" }), {
    target: { value: "onebot11" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "处理阶段" }), {
    target: { value: "model" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "处理状态" }), {
    target: { value: "failed" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "模型（精确匹配）" }), {
    target: { value: "local/model" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "会话 ID" }), {
    target: { value: conversationId },
  });
  await pointer(screen.getByRole("button", { name: "应用筛选" }));
  await waitFor(() =>
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({
      q: "wake & retry",
      channel: "onebot11",
      stage: "model",
      status: "failed",
      model: "local/model",
      conversationId,
    }),
  );
  expect(new URLSearchParams(window.location.search).get("trace-q")).toBe("wake & retry");
});
it("keeps a locked conversation scope while clearing user filters", async () => {
  window.history.replaceState(null, "", "/?trace-q=global");
  const list = vi.fn().mockResolvedValue(page());
  setup({ listRuntimeSpans: list });
  render(<ExecutionWorkspace conversationId={conversationId} />);
  await screen.findByRole("table", { name: "执行记录" });
  expect(list.mock.calls[0][0]).toMatchObject({ conversationId });
  expect(list.mock.calls[0][0].q).toBeUndefined();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索运行记录" }), {
    target: { value: "local" },
  });
  await pointer(screen.getByRole("button", { name: "搜索" }));
  await screen.findByRole("button", { name: "清除筛选" });
  await pointer(screen.getByRole("button", { name: "清除筛选" }));
  await waitFor(() => expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ conversationId }));
  expect(list.mock.calls.at(-1)?.[0].q).toBeUndefined();
});
it("aborts obsolete queries and refuses their late result", async () => {
  let finish: (value: RuntimeSpansPage) => void = () => {};
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<RuntimeSpansPage>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(page([span(11, { name: "fresh" })]));
  setup({ listRuntimeSpans: list });
  render(<ExecutionWorkspace />);
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByRole("textbox", { name: "搜索运行记录" }), {
    target: { value: "fresh" },
  });
  await pointer(screen.getByRole("button", { name: "搜索" }));
  await screen.findByRole("button", { name: /fresh/ });
  expect(list.mock.calls[0][1].aborted).toBe(true);
  await act(async () => finish(page([span(9, { name: "late revoked" })])));
  expect(screen.queryByText("late revoked")).toBeNull();
});
it("revalidates the entire loaded cursor range and removes unverifiable metadata", async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([span(100)], { hasMore: true, nextBeforeId: 100 }))
    .mockResolvedValueOnce(page([span(50)], { nextBeforeId: 50 }))
    .mockResolvedValueOnce(page([span(110)], { hasMore: true, nextBeforeId: 100 }))
    .mockResolvedValueOnce(page([span(50)], { nextBeforeId: 50 }))
    .mockRejectedValueOnce(new Error("READ_FAILED"));
  setup({ listRuntimeSpans: list });
  render(<ExecutionWorkspace />);
  await pointer(await screen.findByRole("button", { name: "加载更早运行记录" }));
  await waitFor(() => expect(screen.getByText(/已加载 2 条链路/)).toBeTruthy());
  await pointer(screen.getByRole("button", { name: "刷新运行记录" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
  expect(list.mock.calls[3][0].beforeId).toBe(100);
  await pointer(screen.getByRole("button", { name: "刷新运行记录" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("table", { name: "执行记录" })).toBeNull();
});
it("shows the real connection, queue, pending window and unknown delivery status", async () => {
  setup({
    getConversationRuntimeStatus: async () => ({
      pendingWakes: 3,
      activeRuns: 2,
      failedWakes: 4,
      unknownDeliveries: 5,
      nextReadyAt: "2026-09-26T00:01:00Z",
      lastActivityAt: now,
      connectionPhase: "ready",
      now,
    }),
  });
  render(<ConversationRuntimeSummary conversationId={conversationId} />);
  await screen.findByText("连接已就绪");
  expect(screen.getByText("进行中 2 · 排队 3")).toBeTruthy();
  expect(screen.getByText(/等待窗口至/)).toBeTruthy();
  expect(screen.getByText("处理失败的唤醒").nextElementSibling?.textContent).toBe("4");
  expect(screen.getByText("结果待确认的投递").nextElementSibling?.textContent).toBe("5");
});
it("normalizes precise local time bounds and rejects a reversed interval", async () => {
  const list = vi.fn().mockResolvedValue(page());
  setup({ listRuntimeSpans: list });
  render(<ExecutionWorkspace />);
  await screen.findByRole("table", { name: "执行记录" });
  await pointer(screen.getByRole("button", { name: "添加筛选" }));
  fireEvent.change(screen.getByLabelText("开始时间（本地）"), {
    target: { value: localDateTime(now) },
  });
  fireEvent.change(screen.getByLabelText("结束时间（本地）"), {
    target: { value: localDateTime("2026-09-26T00:00:05Z") },
  });
  await pointer(screen.getByRole("button", { name: "应用筛选" }));
  await waitFor(() =>
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({
      from: "2026-09-26T00:00:00.000Z",
      to: "2026-09-26T00:00:05.000Z",
    }),
  );
  fireEvent.change(screen.getByLabelText("结束时间（本地）"), {
    target: { value: localDateTime("2026-09-25T00:00:00Z") },
  });
  const calls = list.mock.calls.length;
  await pointer(screen.getByRole("button", { name: "应用筛选" }));
  expect(list).toHaveBeenCalledTimes(calls);
  expect(screen.getByRole("alert")).toBeTruthy();
});
it("compares two trace identities with independent complete metadata reads", async () => {
  const first = span(),
    second = span(20, { name: "Second activity" });
  const detail = vi
    .fn()
    .mockImplementation(async (id) => page([id === first.traceId ? first : second]));
  setup({ listRuntimeSpans: async () => page([first, second]), getRuntimeTrace: detail });
  render(<ExecutionWorkspace />);
  await screen.findByRole("table", { name: "执行记录" });
  await pointer(screen.getByRole("checkbox", { name: `比较 ${first.traceId}` }));
  await pointer(screen.getByRole("checkbox", { name: `比较 ${second.traceId}` }));
  await pointer(screen.getByRole("button", { name: "比较已选 2 条" }));
  await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
  expect(new Set(detail.mock.calls.map((call) => call[0]))).toEqual(
    new Set([first.traceId, second.traceId]),
  );
  expect(await screen.findByRole("region", { name: first.traceId })).toBeTruthy();
  expect(screen.getByRole("region", { name: second.traceId })).toBeTruthy();
});
it("retains investigation identity across foreground clearing without preserving stale details", async () => {
  const detail = vi.fn().mockResolvedValue(page());
  setup({ listRuntimeSpans: async () => page(), getRuntimeTrace: detail });
  render(<ExecutionWorkspace />);
  await pointer(await screen.findByRole("button", { name: /Model generation/ }));
  await screen.findByRole("button", { name: /下一个命中/ });
  fireEvent.blur(window);
  expect(screen.queryByRole("button", { name: /下一个命中/ })).toBeNull();
  expect(screen.getByRole("region", { name: "追踪链路" })).toBeTruthy();
  fireEvent.focus(window);
  await screen.findByRole("button", { name: /下一个命中/ });
  expect(detail).toHaveBeenCalledTimes(2);
});
it("shows confirmed and unknown parts independently and aborts delivery inspection on close", async () => {
  const delivery = {
    id: "out",
    runId: "run",
    conversationId,
    ordinal: 0,
    target: { peerId: "group", participantId: "b" },
    status: "unknown" as const,
    sourceThroughSeq: 2,
    deliverBy: now,
    createdAt: now,
    parts: ["confirmed", "unknown"].map((status, ordinal) => ({
      id: String(ordinal),
      ordinal,
      kind: "text" as const,
      status: status as "confirmed" | "unknown",
      platformMessageId: ordinal === 0 ? "receipt" : null,
      attemptedAt: now,
      finishedAt: now,
      stickerId: null,
    })),
  };
  const read = vi.fn().mockResolvedValue(delivery);
  setup({ getDelivery: read });
  render(
    <DeliveryDetails
      outputId="out"
      conversation={{ participants: [{ id: "b", label: "Member B", role: "member" }] }}
    />,
  );
  expect(read).not.toHaveBeenCalled();
  await pointer(screen.getByRole("button", { name: /送达详情/ }));
  await screen.findByText("receipt");
  expect(screen.getByText(/Member B/)).toBeTruthy();
  expect(screen.getByText("已送达")).toBeTruthy();
  expect(screen.getAllByText("发送结果待确认").length).toBe(2);
  fireEvent.blur(window);
  expect(screen.queryByText("receipt")).toBeNull();
});
