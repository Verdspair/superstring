import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectedContext } from "../../src/shared/contracts/agent-run";
import type {
  RuntimeSpan,
  RuntimeTrace,
  RuntimeTraceDetail,
  RuntimeTracesPage,
} from "../../src/shared/contracts/runtime-observability";
import { api } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { ConversationActiveTraces } from "../../src/web/screens/conversations/ConversationActiveTraces";
import { traceTask } from "../../src/web/screens/observability/presentation";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore as store } from "../../src/web/store";

const origin = Date.parse("2026-09-26T00:00:00Z");
const at = (ms: number) => new Date(origin + ms).toISOString();
const conversationId = "11111111-1111-4111-8111-111111111111";
const traceId = "a".repeat(32);

const makeDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

function span(id: number, patch: Partial<RuntimeSpan> = {}): RuntimeSpan {
  return {
    id,
    traceId,
    spanId: `span-${id}`,
    parentSpanId: null,
    name: "agent.run",
    at: at(0),
    finishedAt: null,
    durationMs: null,
    channel: "onebot11",
    stage: "run",
    status: "started",
    code: "RUN_STARTED",
    model: null,
    conversationId,
    agentId: null,
    runId: "run-parent-9",
    wakeId: null,
    outputId: null,
    sourceSeq: 100,
    details: { specId: "onebot.main" },
    ...patch,
  };
}

const rootSpan = span(1);
const childSpan = span(2, {
  parentSpanId: rootSpan.spanId,
  stage: "model",
  name: "agent.model",
  model: "local/model",
  runId: "run-child-9",
  details: { specId: "memory.select", phase: "leaf", stepId: "step-child-9" },
});
const actionSpan = span(3, {
  parentSpanId: rootSpan.spanId,
  stage: "action",
  name: "agent.action",
  status: "completed",
  finishedAt: at(400),
  durationMs: 400,
});

const child2Span = span(4, {
  parentSpanId: rootSpan.spanId,
  stage: "model",
  name: "agent.model",
  model: "local/model",
  runId: "run-child-10",
  details: { specId: "memory.select", phase: "leaf", stepId: "step-child-10" },
});

function traceGroup(root = rootSpan): RuntimeTrace {
  return {
    traceId: root.traceId,
    cursorId: root.id,
    root,
    at: root.at,
    lastActivityAt: at(400),
    finishedAt: null,
    durationMs: 400,
    status: "started",
    spanCount: 3,
    matchedSpanCount: 3,
    models: ["local/model"],
    channels: ["onebot11"],
    runIds: ["run-parent-9"],
    wakeIds: [],
    causes: ["direct_reply"],
    specIds: ["onebot.main"],
  };
}

const page = (items: RuntimeTrace[], hasMore = false): RuntimeTracesPage => ({
  items,
  nextBeforeId: items.at(-1)?.cursorId ?? 0,
  hasMore,
  summary: {
    totalTraces: items.length,
    activeTraces: items.length,
    failedTraces: 0,
    matchedSpans: 9,
    lastActivityAt: at(400),
    now: at(400),
  },
});

const detail: RuntimeTraceDetail = {
  now: at(500),
  trace: traceGroup(),
  items: [rootSpan, childSpan, actionSpan],
  matchedSpanIds: [rootSpan.spanId, childSpan.spanId, actionSpan.spanId],
};

const detailWithChild2: RuntimeTraceDetail = {
  ...detail,
  trace: { ...traceGroup(), spanCount: 4, matchedSpanCount: 4 },
  items: [rootSpan, childSpan, actionSpan, child2Span],
  matchedSpanIds: [rootSpan.spanId, childSpan.spanId, actionSpan.spanId, child2Span.spanId],
};

const exact: InspectedContext = {
  status: "exact",
  layout: [],
  sourceVersions: [],
  exactMessages: [{ role: "user", content: [{ kind: "text", text: "Protected input" }] }],
  result: { status: "exact", format: "text", text: "Protected output" },
};

// 与产品渲染同源的任务名：specIds 优先（onebot.main → OneBot 主 Agent）
const taskTitle = () => traceTask(traceGroup(), (key) => i18n.t(key));

function install(listImpl: (filters: unknown, signal?: AbortSignal) => Promise<RuntimeTracesPage>) {
  const list = vi.fn(listImpl);
  const waterfall = vi.fn().mockResolvedValue(detail);
  const inspect = vi.fn().mockResolvedValue(exact);
  store.getState().resetForTests({
    ...api,
    listRuntimeTraces: list,
    getRuntimeWaterfall: waterfall,
    inspectRunContext: inspect,
  });
  return { list, waterfall, inspect };
}

const notifyChanged = (seq: number) =>
  notifyConversationChange({
    event: "conversation_changed",
    conversationId,
    seq,
    bindingEpoch: 1,
  });

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  void i18n.changeLanguage("zh-CN");
  resetConversationChangesForTests();
  store.getState().resetForTests(api);
});

afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.restoreAllMocks();
});

describe("conversation active traces strip", () => {
  it("only reads started traces for the active conversation view and stays metadata-only", async () => {
    const { list, waterfall, inspect } = install(() => Promise.resolve(page([traceGroup()])));
    const view = render(
      <ConversationActiveTraces conversationId={conversationId} active={false} />,
    );

    await act(async () => {});
    expect(list).not.toHaveBeenCalled();

    view.rerender(<ConversationActiveTraces conversationId={conversationId} active={true} />);
    const aside = await screen.findByRole("complementary");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(list.mock.calls[0][0]).toEqual({ conversationId, status: "started", limit: 50 });
    expect(within(aside).getByText("1")).toBeTruthy();
    // 打开前只读元数据：不取瀑布、不取受保护正文
    expect(waterfall).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("shows the parent trace with its child count and opens the existing waterfall without protected prefetch", async () => {
    const { list, waterfall, inspect } = install(() => Promise.resolve(page([traceGroup()])));
    const user = userEvent.setup();
    render(<ConversationActiveTraces conversationId={conversationId} />);

    const aside = await screen.findByRole("complementary");
    const traceButton = within(aside).getByRole("button", { name: new RegExp(taskTitle()) });
    expect(within(traceButton).getByText("3")).toBeTruthy();
    await user.click(traceButton);

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("3 个步骤")).toBeTruthy();
    expect(waterfall).toHaveBeenCalledTimes(1);
    expect(waterfall.mock.calls[0][0]).toBe(traceId);
    expect(waterfall.mock.calls[0][1]).toEqual({ conversationId });
    // 打开父链路详情不预取任何子步骤的受保护正文
    expect(inspect).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("auto-inspects the explicitly selected child once without a second explicit request", async () => {
    const { inspect } = install(() => Promise.resolve(page([traceGroup()])));
    const user = userEvent.setup();
    render(<ConversationActiveTraces conversationId={conversationId} />);

    const aside = await screen.findByRole("complementary");
    await user.click(within(aside).getByRole("button", { name: new RegExp(taskTitle()) }));
    const dialog = await screen.findByRole("dialog");

    await user.pointer({
      keys: "[MouseLeft]",
      target: within(dialog).getByRole("button", { name: "查看输入、输出与详情" }),
      coords: { x: 100, y: 100 },
    });
    const workbench = await within(dialog).findByRole("region", { name: "步骤检查器" });

    // 新契约：点选子步骤后立即自动检查一次，无需第二次显式请求
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    expect(inspect.mock.calls[0][0]).toEqual({ runId: "run-child-9", stepId: "step-child-9" });
    expect(await within(workbench).findByText("Protected input")).toBeTruthy();

    await act(async () => {});
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("removes the active entry on the terminal conversation event", async () => {
    const list = vi
      .fn<(filters: unknown, signal?: AbortSignal) => Promise<RuntimeTracesPage>>()
      .mockResolvedValueOnce(page([traceGroup()]))
      .mockResolvedValueOnce(page([]));
    store.getState().resetForTests({ ...api, listRuntimeTraces: list });
    render(<ConversationActiveTraces conversationId={conversationId} />);

    await screen.findByRole("complementary");
    notifyChanged(2);

    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0]).toEqual({ conversationId, status: "started", limit: 50 });
  });

  it("keeps an already opened detail open when the trace terminates so children results stay visible", async () => {
    const list = vi
      .fn<(filters: unknown, signal?: AbortSignal) => Promise<RuntimeTracesPage>>()
      .mockResolvedValueOnce(page([traceGroup()]))
      .mockResolvedValueOnce(page([]));
    const waterfall = vi.fn().mockResolvedValue(detail);
    store.getState().resetForTests({
      ...api,
      listRuntimeTraces: list,
      getRuntimeWaterfall: waterfall,
    });
    const user = userEvent.setup();
    render(<ConversationActiveTraces conversationId={conversationId} />);

    const aside = await screen.findByRole("complementary");
    await user.click(within(aside).getByRole("button", { name: new RegExp(taskTitle()) }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("3 个步骤")).toBeTruthy();

    notifyChanged(2);
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());

    // 列表为空时已打开的详情不得被拆掉，子步骤结果仍可查看
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByText("3 个步骤")).toBeTruthy();
  });

  it("surfaces a truthful hasMore count with a view-all jump instead of dropping ongoing parents", async () => {
    const second = traceGroup(span(90, { traceId: "b".repeat(32) }));
    install(() => Promise.resolve(page([traceGroup(), second], true)));
    const requestView = vi.fn();
    store.setState({ requestConversationView: requestView } as never);
    render(<ConversationActiveTraces conversationId={conversationId} />);

    const aside = await screen.findByRole("complementary");
    expect(within(aside).getAllByRole("button", { name: new RegExp(taskTitle()) })).toHaveLength(2);
    expect(within(aside).getByText("2+")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(within(aside).getByRole("button", { name: "全部活动" }));
    expect(requestView).toHaveBeenCalledWith("activity", "current");
  });

  it("does not leak an older conversation's late strip response after switching conversations", async () => {
    const deferredA = makeDeferred<RuntimeTracesPage>();
    const listA = vi.fn().mockReturnValue(deferredA.promise);
    const listB = vi.fn().mockResolvedValue(page([]));
    store.getState().resetForTests({ ...api, listRuntimeTraces: listA });
    const view = render(<ConversationActiveTraces conversationId={conversationId} />);
    await waitFor(() => expect(listA).toHaveBeenCalledTimes(1));

    store.getState().resetForTests({ ...api, listRuntimeTraces: listB });
    view.rerender(
      <ConversationActiveTraces conversationId="22222222-2222-4222-8222-222222222222" />,
    );
    await waitFor(() => expect(listB).toHaveBeenCalledTimes(1));
    expect(listB.mock.calls[0][0]).toEqual({
      conversationId: "22222222-2222-4222-8222-222222222222",
      status: "started",
      limit: 50,
    });

    await act(async () => {
      deferredA.resolve(page([traceGroup()]));
      await deferredA.promise;
    });
    await act(async () => {});
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes a stale detail on API switch and never renders the old client's late waterfall", async () => {
    const deferredA = makeDeferred<RuntimeTraceDetail>();
    const listA = vi.fn().mockResolvedValue(page([traceGroup()]));
    const waterfallA = vi.fn().mockReturnValue(deferredA.promise);
    store.getState().resetForTests({
      ...api,
      listRuntimeTraces: listA,
      getRuntimeWaterfall: waterfallA,
    });
    const user = userEvent.setup();
    render(<ConversationActiveTraces conversationId={conversationId} />);

    const aside = await screen.findByRole("complementary");
    await user.click(within(aside).getByRole("button", { name: new RegExp(taskTitle()) }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(waterfallA).toHaveBeenCalledTimes(1));
    expect(within(dialog).queryByText("3 个步骤")).toBeNull();

    store.getState().resetForTests({
      ...api,
      listRuntimeTraces: vi.fn().mockResolvedValue(page([])),
      getRuntimeWaterfall: vi.fn(
        () => makeDeferred<RuntimeTraceDetail>().promise as Promise<RuntimeTraceDetail>,
      ),
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await act(async () => {
      deferredA.resolve(detail);
      await deferredA.promise;
    });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("3 个步骤")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  it("merges a trailing conversation notification while the waterfall is in flight and shows the late child arrival", async () => {
    const deferredFirst = makeDeferred<RuntimeTraceDetail>();
    const second = makeDeferred<RuntimeTraceDetail>();
    const waterfall = vi
      .fn<() => Promise<RuntimeTraceDetail>>()
      .mockReturnValueOnce(deferredFirst.promise)
      .mockReturnValueOnce(second.promise);
    store.getState().resetForTests({
      ...api,
      listRuntimeTraces: vi.fn().mockResolvedValue(page([traceGroup()])),
      getRuntimeWaterfall: waterfall,
    });
    const user = userEvent.setup();
    render(<ConversationActiveTraces conversationId={conversationId} />);

    const aside = await screen.findByRole("complementary");
    await user.click(within(aside).getByRole("button", { name: new RegExp(taskTitle()) }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(waterfall).toHaveBeenCalledTimes(1));
    expect(within(dialog).queryByText("3 个步骤")).toBeNull();

    // 首个瀑布读取在飞时到达的尾随会话通知只合并为一次重读
    notifyChanged(2);
    await act(async () => {
      deferredFirst.resolve(detail);
      await deferredFirst.promise;
    });

    await waitFor(() => expect(waterfall).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve(detailWithChild2);
      await second.promise;
    });

    // 迟到的子步骤到达后按最新数据展示，不再回显旧首读
    expect(await within(dialog).findByText("4 个步骤")).toBeTruthy();
    expect(within(dialog).queryByText("3 个步骤")).toBeNull();
  });
});
