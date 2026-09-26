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
import { waterfallLayout } from "../../src/web/features/observability/waterfall-layout";
import { i18n } from "../../src/web/i18n/runtime";
import { ContentReader } from "../../src/web/screens/observability/ContentReader";
import { EvidenceWorkbench } from "../../src/web/screens/observability/EvidenceWorkbench";
import { InvestigationCanvas } from "../../src/web/screens/observability/InvestigationCanvas";
import {
  InspectedEvidence,
  ModelEvidence,
} from "../../src/web/screens/observability/ModelEvidence";
import { ExecutionWorkspace } from "../../src/web/screens/observability/ObservabilityWorkspace";
import { traceTask } from "../../src/web/screens/observability/presentation";
import { TraceTimeline } from "../../src/web/screens/observability/TraceTimeline";
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

it("translates operation-only traces without inventing a model task", () => {
  const trace = { ...group(span(9, 0, 20, { name: "bot.ingress" })), specIds: [] };
  expect(traceTask(trace, (key) => i18n.t(key))).toBe(i18n.t("observability.messageIntake"));
  expect(traceTask(trace, (key) => i18n.t(key))).not.toMatch(/^observability\./);
  expect(
    traceTask({ ...trace, root: { ...trace.root, name: "extension.event" } }, (key) => i18n.t(key)),
  ).toBe("extension.event");
});
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
  void i18n.changeLanguage("zh-CN");
  store.getState().resetForTests(api);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const pointer = async (target: HTMLElement) =>
  userEvent.setup().pointer({ target, keys: "[MouseLeft]", coords: { x: 100, y: 100 } });
function install(items = [group()]) {
  const detail = vi.fn().mockResolvedValue(data),
    inspect = vi.fn().mockResolvedValue(exact);
  store.getState().resetForTests({
    ...api,
    inspectRunContext: inspect,
    getRuntimeWaterfall: detail,
    listRuntimeTraces: async () => ({
      items,
      nextBeforeId: 1,
      hasMore: false,
      summary: {
        totalTraces: items.length,
        activeTraces: 0,
        failedTraces: 0,
        matchedSpans: items.length,
        lastActivityAt: at(1000),
        now: at(1000),
      },
    }),
  });
  return { detail, inspect };
}
it("uses a full-width ledger and opens a dedicated, complete trace without mixing requests", async () => {
  const second = {
    ...group(span(4, 200, 600, { traceId: "b".repeat(32), name: "Other request" })),
    specIds: ["second.task"],
  };
  const { detail } = install([group(), second]);
  render(<ExecutionWorkspace />);
  const ledger = await screen.findByRole("table", { name: "执行记录" });
  expect(within(ledger).getAllByRole("row")).toHaveLength(3);
  await pointer(within(ledger).getByRole("button", { name: /OneBot 主 Agent/ }));
  const region = await screen.findByRole("region", { name: "追踪链路" });
  expect(screen.queryByRole("table", { name: "执行记录" })).toBeNull();
  expect(
    await within(region).findByRole("button", { name: "折叠 Agent 运行 的子步骤" }),
  ).toBeTruthy();
  expect(detail.mock.calls[0][0]).toBe(traceId);
  expect(within(region).queryByText("second.task")).toBeNull();
  await pointer(screen.getByRole("button", { name: "返回执行记录" }));
  await screen.findByRole("table", { name: "执行记录" });
  expect(document.activeElement?.getAttribute("data-trace-action")).toBe(traceId);
});
it("keeps true causal parents and handles missing ancestors without inventing relationships", () => {
  const orphan = span(4, 300, 400, { parentSpanId: "missing" });
  const layout = waterfallLayout([action, orphan, child, root], at(1000));
  expect(layout.roots.map((item) => item.span.id)).toEqual([1, 4]);
  expect(layout.roots[0].children.map((item) => item.span.id)).toEqual([2, 3]);
  expect(layout.roots[1].missingParent).toBe(true);
  expect(layout.interval(child)).toEqual({ offsetMs: 100, durationMs: 600, left: 10, width: 60 });
});
it("uses real keyboard branch controls and reveals the selected evidence ancestry", async () => {
  const onSelect = vi.fn();
  const view = render(<TraceTimeline data={data} selected={null} onSelect={onSelect} />);
  const button = screen.getByRole("button", { name: "折叠 Agent 运行 的子步骤" });
  button.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "查看输入、输出与详情" })).toBeNull();
  view.rerender(<TraceTimeline data={data} selected={child.spanId} onSelect={onSelect} />);
  expect(screen.getByRole("button", { name: "查看输入、输出与详情" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "父子时序图" }).tabIndex).toBe(0);
});
it("inspects exact input and output only on request, then clears both on blur", async () => {
  const { inspect } = install();
  render(<ModelEvidence handle={{ runId: "run-child", stepId: "step-child" }} />);
  expect(inspect).not.toHaveBeenCalled();
  await pointer(screen.getByRole("button", { name: "查看实际输入与输出" }));
  await screen.findByText("Exact protected input");
  await pointer(screen.getByRole("tab", { name: "模型输出" }));
  expect(screen.getByText('{"selected":["one"]}')).toBeTruthy();
  expect(inspect.mock.calls[0][0]).toEqual({ runId: "run-child", stepId: "step-child" });
  fireEvent.blur(window);
  expect(screen.queryByText('{"selected":["one"]}')).toBeNull();
  fireEvent.focus(window);
  expect(inspect).toHaveBeenCalledOnce();
});
it("distinguishes partial output, historical absence, revocation and expiry", async () => {
  const view = render(
    <InspectedEvidence
      value={{ ...exact, result: { status: "partial", text: "partial response", format: "text" } }}
    />,
  );
  await pointer(screen.getByRole("tab", { name: "模型输出" }));
  expect(screen.getByText("partial response")).toBeTruthy();
  expect(screen.getByText("这是中断前保留的部分模型输出。")).toBeTruthy();
  view.rerender(
    <InspectedEvidence
      value={{ ...exact, result: { status: "unavailable", reason: "not_recorded" } }}
    />,
  );
  expect(screen.getByText("此步骤没有保留模型输出。")).toBeTruthy();
  view.rerender(<InspectedEvidence value={{ ...exact, status: "revoked" }} />);
  expect(screen.getByText("来源已撤权或删除，模型输出不可查看。")).toBeTruthy();
  expect(screen.queryByText('{"selected":["one"]}')).toBeNull();
  view.rerender(<InspectedEvidence value={{ ...exact, status: "expired" }} />);
  expect(screen.getByText("来源保留期已结束，模型输出已清除。")).toBeTruthy();
});
it("labels verified fallbacks and unverified requested models truthfully", () => {
  const view = render(<EvidenceWorkbench item={child} />);
  expect(screen.getByText("实际请求模型: actual-model")).toBeTruthy();
  expect(screen.getByText("已使用替补模型；请求模型：requested-model")).toBeTruthy();
  view.rerender(
    <EvidenceWorkbench item={{ ...child, details: { ...child.details, modelResolved: false } }} />,
  );
  expect(screen.getByText("请求模型: actual-model")).toBeTruthy();
  expect(screen.queryByText("已使用替补模型；请求模型：requested-model")).toBeNull();
});
it("changes to the parent run in the workbench without nested dialogs or retained bodies", async () => {
  install();
  store.getState().resetForTests({
    ...store.getState().apiClient,
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
  render(<EvidenceWorkbench item={child} />);
  await pointer(screen.getByRole("button", { name: "查看实际输入与输出" }));
  await screen.findByText("Exact protected input");
  await pointer(screen.getByRole("button", { name: "所属运行" }));
  await screen.findByText("尚未开始模型步骤。");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Exact protected input")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "返回步骤详情" }));
  await userEvent.setup().keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "查看实际输入与输出" })).toBeTruthy();
});
it("uses a literal mature matcher for regex-looking text and retains exact copy/wrap behavior", async () => {
  userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<ContentReader text="[a][a] original" label="Original" />);
  fireEvent.change(screen.getByRole("textbox", { name: "查找当前正文" }), {
    target: { value: "[a]" },
  });
  expect(screen.getByText("2 处匹配")).toBeTruthy();
  const body = screen.getByRole("region", { name: "Original · 正文阅读区" });
  expect(body.tabIndex).toBe(0);
  await pointer(screen.getByRole("button", { name: "下一处" }));
  await pointer(screen.getByRole("button", { name: "自动换行" }));
  expect(body.className).toContain("whitespace-pre");
  await pointer(screen.getByRole("button", { name: "复制原文" }));
  expect(copy).toHaveBeenCalledWith("[a][a] original");
});
it("navigates matching evidence and preserves selected identity without stealing refresh focus", async () => {
  install();
  render(<InvestigationCanvas traceId={traceId} filters={{}} onBack={vi.fn()} />);
  await screen.findByRole("button", { name: /下一个命中/ });
  await pointer(screen.getByRole("button", { name: /下一个命中/ }));
  expect(
    screen.getByRole("button", { name: "查看输入、输出与详情" }).getAttribute("aria-pressed"),
  ).toBe("true");
  const refresh = screen.getByRole("button", { name: "刷新当前链路" });
  refresh.focus();
  fireEvent.click(refresh);
  await screen.findByRole("button", { name: "查看实际输入与输出" });
  expect(document.activeElement).toBe(refresh);
});
it("switches the model list and reader layout without duplicating protected requests", async () => {
  const { inspect } = install();
  render(<InvestigationCanvas traceId={traceId} filters={{}} onBack={vi.fn()} />);
  await screen.findByRole("button", { name: /下一个命中/ });
  await pointer(screen.getByRole("tab", { name: /模型调用/ }));
  await pointer(screen.getByRole("button", { name: "检查调用" }));
  await pointer(screen.getByRole("button", { name: "查看实际输入与输出" }));
  await screen.findByText("Exact protected input");
  await pointer(screen.getByRole("button", { name: "展开阅读" }));
  expect(screen.getAllByRole("region", { name: "模型证据" })).toHaveLength(1);
  expect(inspect).toHaveBeenCalledOnce();
  await pointer(screen.getByRole("button", { name: "恢复布局" }));
  expect(inspect).toHaveBeenCalledOnce();
});
it("renders the same stable-key interface in English through the official i18next instance", async () => {
  await i18n.changeLanguage("en");
  render(<InspectedEvidence value={exact} />);
  expect(screen.getByRole("tab", { name: "Model input" })).toBeTruthy();
  await pointer(screen.getByRole("tab", { name: "Model output" }));
  expect(screen.getByText('{"selected":["one"]}')).toBeTruthy();
  expect(screen.queryByText(/observability\./)).toBeNull();
});
