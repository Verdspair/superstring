import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InspectedContext } from "../../src/shared/contracts/agent-run";
import type {
  RuntimeSpan,
  RuntimeTrace,
  RuntimeTraceDetail,
} from "../../src/shared/contracts/runtime-observability";
import { api } from "../../src/web/api";
import { TraceExplorer } from "../../src/web/features/observability/TraceExplorer";
import { TraceWaterfall } from "../../src/web/features/observability/TraceWaterfall";
import { waterfallLayout } from "../../src/web/features/observability/waterfall-layout";
import { ContextContent } from "../../src/web/features/runs/RunInspector";
import { useSuperstringStore as store } from "../../src/web/store";

const origin = Date.parse("2026-09-26T00:00:00Z"),
  at = (ms: number) => new Date(origin + ms).toISOString();
const traceId = "a".repeat(32);
function span(
  id: number,
  start: number,
  end: number,
  patch: Partial<RuntimeSpan> = {},
): RuntimeSpan {
  return {
    id,
    traceId,
    spanId: `span-${id}`,
    parentSpanId: null,
    name: "agent.run",
    at: at(start),
    finishedAt: at(end),
    durationMs: end - start,
    channel: "onebot11",
    stage: "run",
    status: "completed",
    code: "DONE",
    model: null,
    conversationId: null,
    agentId: null,
    runId: null,
    wakeId: null,
    outputId: null,
    sourceSeq: null,
    details: {},
    ...patch,
  };
}
const root = span(1, 0, 1000, {
  details: { specId: "onebot.main", cause: "direct_reply" },
  runId: "run-main-123",
});
const child = span(2, 100, 700, {
  parentSpanId: root.spanId,
  stage: "model",
  name: "agent.model",
  model: "actual-model",
  runId: "run-child",
  details: {
    specId: "memory.select",
    phase: "leaf",
    stepId: "step-child",
    modelResolved: true,
    requestedModel: "requested-model",
  },
});
const action = span(3, 800, 900, {
  parentSpanId: root.spanId,
  name: "agent.action",
  stage: "action",
  details: { action: "knowledge.query" },
});
function group(item = root): RuntimeTrace {
  return {
    traceId: item.traceId,
    cursorId: item.id,
    root: item,
    at: item.at,
    lastActivityAt: at(1000),
    finishedAt: at(1000),
    durationMs: 1000,
    status: "completed",
    spanCount: 3,
    matchedSpanCount: 1,
    models: ["actual-model"],
    channels: ["onebot11"],
    runIds: [],
    wakeIds: [],
    causes: ["direct_reply"],
    specIds: ["onebot.main", "memory.select"],
  };
}
const data: RuntimeTraceDetail = {
  now: at(1000),
  trace: group(),
  items: [action, child, root],
  matchedSpanIds: [child.spanId],
};
const exact: InspectedContext = {
  status: "exact",
  layout: [],
  sourceVersions: [],
  exactMessages: [{ role: "user", content: [{ kind: "text", text: "Exact protected input" }] }],
  result: { status: "exact", format: "json", text: '{"selected":["one"]}' },
};
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  store.getState().resetForTests(api);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps two interleaved requests in independent server groups and expands the complete selected chain", async () => {
  const second = group(span(4, 200, 600, { traceId: "b".repeat(32), name: "Other request" }));
  const aggregate = { ...group(), root: { ...root, name: "bot.ingress", details: {} } };
  const detail = vi.fn().mockResolvedValue(data);
  store.getState().resetForTests({
    ...api,
    listRuntimeTraces: async () => ({
      items: [second, aggregate],
      nextBeforeId: 1,
      hasMore: false,
      summary: {
        totalTraces: 2,
        activeTraces: 0,
        failedTraces: 0,
        matchedSpans: 2,
        lastActivityAt: at(1000),
        now: at(1000),
      },
    }),
    getRuntimeWaterfall: detail,
  });
  render(<TraceExplorer />);
  const triggers = await screen.findAllByRole("button", { name: "展开时序链路" });
  expect(triggers).toHaveLength(2);
  const card = triggers[1].closest("li");
  if (!card) throw new Error("Missing trace card");
  expect(within(card).getByText("触发类型: 直接回应")).toBeTruthy();
  expect(within(card).getByText("链路任务: OneBot 主 Agent · 记忆筛选")).toBeTruthy();
  fireEvent.click(triggers[1]);
  const dialog = await screen.findByRole("region", { name: "追踪链路" });
  expect(await within(dialog).findAllByText("记忆筛选", { exact: false })).not.toHaveLength(0);
  expect(detail.mock.calls[0][0]).toBe(traceId);
  expect(within(dialog).queryByText("Other request")).toBeNull();
  expect(within(dialog).getAllByText("命中筛选")).toHaveLength(1);
  expect(within(dialog).getByText("Agent 行动", { selector: "strong" })).toBeTruthy();
});

it("uses exact causal parents and proportional offsets instead of sorting unrelated timestamps into a chain", () => {
  const orphan = span(4, 300, 400, { parentSpanId: "unavailable-parent" });
  const layout = waterfallLayout([action, orphan, child, root], at(1000));
  expect(layout.roots.map((node) => node.span.id)).toEqual([1, 4]);
  expect(layout.roots[0].children.map((node) => node.span.id)).toEqual([2, 3]);
  expect(layout.roots[1].missingParent).toBe(true);
  expect(layout.interval(child)).toEqual({ offsetMs: 100, durationMs: 600, left: 10, width: 60 });
  const view = render(<TraceWaterfall data={data} />);
  const bar = view.container.querySelector("#trace-span-span-2 .waterfall-bar") as HTMLElement;
  expect(bar.style.left).toBe("10%");
  expect(bar.style.width).toBe("60%");
  expect(screen.getByText("起点 +100 ms · 耗时 600 ms")).toBeTruthy();
});

it("makes branch collapse keyboard accessible and shows attempt/run and resolved fallback identities", async () => {
  render(
    <TraceWaterfall
      data={{
        ...data,
        items: [{ ...root, details: { ...root.details, attempt: 2 } }, child, action],
      }}
    />,
  );
  expect(screen.getByText("尝试 #2")).toBeTruthy();
  expect(screen.getByText("run-main")).toBeTruthy();
  expect(screen.getByText("已使用替补模型；请求模型：requested-model")).toBeTruthy();
  const button = screen.getByRole("button", { name: "折叠 Agent 运行 的子步骤" });
  button.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "查看输入、输出与详情" })).toBeNull();
  await userEvent.setup().keyboard(" ");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "查看输入、输出与详情" })).toBeTruthy();
});

it("inspects the selected model step through the protected endpoint and clears both input and output on blur", async () => {
  const inspect = vi.fn().mockResolvedValue(exact);
  store.getState().resetForTests({ ...api, inspectRunContext: inspect });
  render(<TraceWaterfall data={data} />);
  fireEvent.click(screen.getByRole("button", { name: "查看输入、输出与详情" }));
  expect(inspect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "查看实际输入与输出" }));
  await screen.findByText("Exact protected input");
  await userEvent.setup().click(screen.getByRole("tab", { name: "模型输出" }));
  expect(screen.getByText('{"selected":["one"]}')).toBeTruthy();
  expect(inspect.mock.calls[0][0]).toEqual({ runId: "run-child", stepId: "step-child" });
  fireEvent.blur(window);
  expect(screen.queryByText("Exact protected input")).toBeNull();
  expect(screen.queryByText('{"selected":["one"]}')).toBeNull();
});

it("distinguishes partial, unrecorded, expired and revoked output without showing stale text", async () => {
  const view = render(
    <ContextContent
      context={{
        ...exact,
        result: { status: "partial", format: "text", text: "partial response" },
      }}
    />,
  );
  await userEvent.setup().click(screen.getByRole("tab", { name: "模型输出" }));
  expect(screen.getByText("这是中断前保留的部分模型输出。", { exact: false })).toBeTruthy();
  expect(screen.getByText("partial response")).toBeTruthy();
  view.rerender(
    <ContextContent
      context={{ ...exact, result: { status: "unavailable", reason: "not_recorded" } }}
    />,
  );
  expect(screen.getByText("此步骤没有保留模型输出。")).toBeTruthy();
  view.rerender(<ContextContent context={{ ...exact, status: "revoked" }} />);
  expect(screen.queryByText('{"selected":["one"]}')).toBeNull();
  expect(screen.getByText("来源已撤权或删除，模型输出不可查看。")).toBeTruthy();
  view.rerender(<ContextContent context={{ ...exact, status: "expired" }} />);
  expect(screen.queryByText('{"selected":["one"]}')).toBeNull();
  expect(screen.getByText("来源保留期已结束，模型输出已清除。")).toBeTruthy();
});

it("does not label requested or historical model names as resolved actual models", () => {
  render(
    <TraceWaterfall
      data={{ ...data, items: [{ ...child, details: { ...child.details, modelResolved: false } }] }}
    />,
  );
  expect(screen.getByText("请求模型", { exact: false })).toBeTruthy();
  expect(screen.queryByText("实际请求模型", { exact: false })).toBeNull();
  expect(screen.queryByText("已使用替补模型", { exact: false })).toBeNull();
});

it("keeps run navigation inside the step inspector and discards protected bodies when leaving the step", async () => {
  const inspect = vi.fn().mockResolvedValue(exact);
  store.getState().resetForTests({
    ...api,
    inspectRunContext: inspect,
    getRun: async (runId) => ({
      runId,
      specId: "memory.select",
      specVersion: "1",
      owner: { kind: "test", id: "owner" },
      status: "completed",
      startedAt: at(0),
      endedAt: at(1000),
      lastSeq: 1,
      steps: [],
      outputs: [],
      errorCode: null,
    }),
  });
  render(<TraceWaterfall data={data} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "查看输入、输出与详情" }));
  await user.click(screen.getByRole("button", { name: "查看实际输入与输出" }));
  await screen.findByText("Exact protected input");
  await user.click(screen.getByRole("button", { name: "运行详情" }));
  await screen.findByText("尚未开始模型步骤。");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Exact protected input")).toBeNull();
  await user.click(screen.getByRole("button", { name: "返回步骤详情" }));
  expect(screen.getByRole("button", { name: "查看实际输入与输出" })).toBeTruthy();
  expect(inspect).toHaveBeenCalledOnce();
});

it("reveals a collapsed matching branch without changing the complete causal data", async () => {
  render(<TraceWaterfall data={data} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "折叠全部步骤" }));
  expect(screen.queryByRole("button", { name: "查看输入、输出与详情" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "下一个命中" }));
  expect(
    screen.getByRole("button", { name: "查看输入、输出与详情" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: "查看实际输入与输出" })).toBeTruthy();
  expect(screen.getByText("Agent 行动", { selector: "strong" })).toBeTruthy();
});

it("uses keyboard tabs and read-only text tools without fetching another copy of protected output", async () => {
  const user = userEvent.setup();
  render(
    <ContextContent
      context={{ ...exact, result: { status: "exact", format: "text", text: "alpha beta alpha" } }}
    />,
  );
  const input = screen.getByRole("tab", { name: "模型输入" });
  input.focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "模型输出" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByText("Exact protected input")).toBeNull();
  const reader = screen.getByRole("region", { name: "模型输出正文" });
  await user.type(within(reader).getByLabelText("搜索此正文"), "alpha");
  expect(reader.querySelector("mark")?.textContent).toBe("alpha");
  expect(reader.querySelector("pre")?.textContent).toBe("alpha beta alpha");
  await user.click(within(reader).getByRole("button", { name: "下一个匹配" }));
  expect(reader.querySelector("mark")?.previousSibling?.textContent).toBe("alpha beta ");
  await user.click(within(reader).getByRole("button", { name: "自动换行" }));
  expect(reader.querySelector("pre")?.getAttribute("data-wrap")).toBe("false");
  await user.click(within(reader).getByRole("button", { name: "复制正文" }));
  expect(await navigator.clipboard.readText()).toBe("alpha beta alpha");
});

it("restores a selected step after revalidation without moving focus until explicit navigation", async () => {
  const view = render(
    <>
      <button type="button">Filter control</button>
      <TraceWaterfall key="initial" data={data} selectedSpanId={child.spanId} />
    </>,
  );
  const control = screen.getByRole("button", { name: "Filter control" });
  control.focus();
  view.rerender(
    <>
      <button type="button">Filter control</button>
      <TraceWaterfall key="revalidated" data={data} selectedSpanId={child.spanId} />
    </>,
  );
  expect(document.activeElement).toBe(control);
  await userEvent.setup().click(screen.getByRole("button", { name: "查看输入、输出与详情" }));
  const inspector = screen.getByRole("complementary", { name: "步骤检查器" });
  expect(document.activeElement).toBe(within(inspector).getByRole("heading"));
});
