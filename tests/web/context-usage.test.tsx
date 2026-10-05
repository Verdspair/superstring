import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ContextUsageSchema } from "../../src/shared/contracts/context-usage";
import { selectLocale } from "../../src/web/i18n";
import { ContextMeter as ContextUsagePanel } from "../../src/web/screens/conversations/ContextMeter";
import { fixtureStore as store } from "./helpers/chat-fixture";

afterEach(() => {
  cleanup();
  selectLocale("zh-CN");
  store.setState({ contextUsage: null, composer: "" });
});
const usage = ContextUsageSchema.parse({
  session_id: "A",
  turn_id: "turn",
  model: "chat-model",
  estimator: "utf8_bytes_plus_message_overhead",
  capacity: 10000,
  input_units: 1000,
  input_limit: 8000,
  output_reserved: 1000,
  safety_reserved: 1000,
  remaining: 7000,
  components: {
    instructions: 100,
    recent_history: 200,
    summaries: 100,
    long_term_memory: 100,
    knowledge: 100,
    current_question: 397,
    protocol: 3,
  },
});
it("opens only on demand, closes on Escape/outside, and returns keyboard focus", async () => {
  store.setState({ currentSessionId: "A", contextUsage: usage });
  render(<ContextUsagePanel />);
  const trigger = screen.getByRole("button", { name: "上下文用量" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭上下文用量" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.click(trigger);
  await userEvent.click(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("closes when switching chats and never revives old open state", () => {
  store.setState({ currentSessionId: "A", contextUsage: usage });
  render(<ContextUsagePanel />);
  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  act(() => store.setState({ currentSessionId: "B" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => store.setState({ currentSessionId: "A" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("renders all assembled components and keeps the unsent draft separate", () => {
  selectLocale("zh-CN");
  store.setState({ currentSessionId: "A", contextUsage: usage, composer: "你好", sending: false });
  const { baseElement: container } = render(<ContextUsagePanel />);
  fireEvent.click(screen.getByRole("button", { name: /上下文用量|Context usage/ }));
  expect(screen.getAllByRole("row")).toHaveLength(10);
  expect(screen.getByText("压缩摘要")).toBeTruthy();
  expect(screen.queryByText("回查原文")).toBeNull();
  expect(container.textContent).toContain("待发送草稿约 6");
  expect(container.textContent).toContain("已用约 1,000 / 10,000");
  expect(container.querySelector(".CircularProgressbar")).toBeTruthy();
  expect(screen.getAllByText("10.0%").length).toBeGreaterThan(0);
});
it("does not show a different session's usage as current", () => {
  store.setState({ currentSessionId: "B", contextUsage: usage, sending: false });
  const { baseElement: container } = render(<ContextUsagePanel />);
  fireEvent.click(screen.getByRole("button", { name: /上下文用量|Context usage/ }));
  expect(container.querySelector(".context-usage-bar")).toBeNull();
  expect(screen.getByText(/尚无请求统计/)).toBeTruthy();
  expect(container.textContent).not.toContain("chat-model");
});
it("translates all component labels without translating model IDs", () => {
  selectLocale("en");
  store.setState({ currentSessionId: "A", contextUsage: usage, sending: false });
  const { baseElement: container } = render(<ContextUsagePanel />);
  fireEvent.click(screen.getByRole("button", { name: /上下文用量|Context usage/ }));
  expect(container.textContent).toContain("chat-model");
  expect(container.textContent).toContain("Summaries");
  expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/);
});
it("renders unknown vision cost as text-only estimate in zh-CN with trigger aria qualification", () => {
  selectLocale("zh-CN");
  const unknownUsage = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "unknown", images: 2, pixels: 800 },
  });
  store.setState({ currentSessionId: "A", contextUsage: unknownUsage, composer: "" });
  const { baseElement: container } = render(<ContextUsagePanel />);
  const trigger = screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" });
  expect(trigger).toBeTruthy();
  expect(trigger.getAttribute("title")).toBe("上下文用量（仅文本估算，视觉成本未计入）");
  fireEvent.click(trigger);

  expect(screen.getAllByRole("row")).toHaveLength(10);
  expect(container.textContent).toContain("最近请求的文本输入估算");
  expect(container.textContent).toContain("文本已用约 1,000 / 10,000");
  expect(screen.getByText("文本剩余空间")).toBeTruthy();
  expect(screen.queryByText("剩余空间")).toBeNull();
  expect(container.textContent).toContain("含 2 张图片（800 像素）");
  expect(container.textContent).toContain("视觉成本未知，未计入上方统计");
  expect(container.textContent).toContain(
    "上方用量与剩余空间仅为文本估算，不代表总成本或可容纳更多图片",
  );
});
it("renders unknown vision cost in English with trigger aria qualification", () => {
  selectLocale("en");
  const unknownUsage = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "unknown", images: 2, pixels: 800 },
  });
  store.setState({ currentSessionId: "A", contextUsage: unknownUsage, composer: "" });
  const { baseElement: container } = render(<ContextUsagePanel />);
  const trigger = screen.getByRole("button", {
    name: "Context usage (text-only estimate, visual cost not counted)",
  });
  expect(trigger).toBeTruthy();
  expect(trigger.getAttribute("title")).toBe(
    "Context usage (text-only estimate, visual cost not counted)",
  );
  fireEvent.click(trigger);

  expect(screen.getAllByRole("row")).toHaveLength(10);
  expect(container.textContent).toContain("Text input estimation of the latest request");
  expect(container.textContent).toContain("Approx. 1,000 text used / 10,000");
  expect(screen.getByText("Text remaining space")).toBeTruthy();
  expect(container.textContent).toContain("Includes 2 image(s) (800 px)");
  expect(container.textContent).toContain("visual cost is unknown and not counted above");
  expect(container.textContent).toContain(
    "Above usage and remaining space are text-only estimates, and do not represent total cost or capacity for more images",
  );
  expect(container.textContent).toContain("chat-model");
  expect(container.textContent).not.toMatch(/[㐀-鿿]/);
});
it("preserves 10 rows and original labels when no images or zero images estimated", () => {
  selectLocale("zh-CN");
  const noImageUsage = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "estimated", images: 0, pixels: 0 },
  });
  store.setState({ currentSessionId: "A", contextUsage: noImageUsage, composer: "" });
  const { baseElement: container } = render(<ContextUsagePanel />);
  const trigger = screen.getByRole("button", { name: "上下文用量" });
  expect(trigger.getAttribute("title")).toBe("上下文用量");
  fireEvent.click(trigger);

  expect(screen.getAllByRole("row")).toHaveLength(10);
  expect(container.textContent).toContain("最近请求的输入占用");
  expect(container.textContent).toContain("已用约 1,000 / 10,000");
  expect(screen.getByText("剩余空间")).toBeTruthy();
  expect(screen.queryByText("文本剩余空间")).toBeNull();
  expect(container.textContent).not.toContain("视觉成本");
  expect(container.textContent).not.toContain("未计入上方统计");
  expect(screen.getAllByText("10.0%").length).toBeGreaterThan(0);
});
it("handles missing image counts for unknown, estimated, and reported without inventing 0", () => {
  selectLocale("zh-CN");
  const unknownMissingCounts = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "unknown" },
  });
  store.setState({ currentSessionId: "A", contextUsage: unknownMissingCounts });
  const { baseElement: c1 } = render(<ContextUsagePanel />);
  const t1 = screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" });
  fireEvent.click(t1);
  expect(c1.textContent).toContain("视觉计量状态未知，未计入上方统计");
  expect(c1.textContent).not.toContain("0 张图片");
  expect(c1.textContent).not.toContain("0 像素");
  expect(screen.getByText("文本剩余空间")).toBeTruthy();
  cleanup();

  const estimatedMissingCounts = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "estimated" },
  });
  store.setState({ currentSessionId: "A", contextUsage: estimatedMissingCounts });
  const { baseElement: c2 } = render(<ContextUsagePanel />);
  const t2 = screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" });
  fireEvent.click(t2);
  expect(c2.textContent).toContain("视觉成本已按规则估算（图数未报），未折算为模型 token");
  expect(screen.getByText("文本剩余空间")).toBeTruthy();
  cleanup();

  const reportedMissingCounts = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "reported" },
  });
  store.setState({ currentSessionId: "A", contextUsage: reportedMissingCounts });
  const { baseElement: c3 } = render(<ContextUsagePanel />);
  const t3 = screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" });
  fireEvent.click(t3);
  expect(c3.textContent).toContain("服务报告状态：reported");
  expect(screen.getByText("文本剩余空间")).toBeTruthy();
});
it("faithfully renders estimated and reported vision states with images without projecting total units", () => {
  selectLocale("zh-CN");
  const estimatedUsage = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "estimated", images: 1, pixels: 2048 },
  });
  store.setState({ currentSessionId: "A", contextUsage: estimatedUsage });
  const { baseElement: c1 } = render(<ContextUsagePanel />);
  const t1 = screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" });
  fireEvent.click(t1);
  expect(c1.textContent).toContain("含 1 张图片（2,048 像素）");
  expect(c1.textContent).toContain("视觉成本已按规则估算，未折算为模型 token");
  expect(screen.getByText("文本剩余空间")).toBeTruthy();
  expect(screen.getAllByRole("row")).toHaveLength(10);
  cleanup();

  const reportedUsage = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "reported", images: 3, pixels: 16384 },
  });
  store.setState({ currentSessionId: "A", contextUsage: reportedUsage });
  const { baseElement: c2 } = render(<ContextUsagePanel />);
  const t2 = screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" });
  fireEvent.click(t2);
  expect(c2.textContent).toContain("含 3 张图片（16,384 像素）");
  expect(c2.textContent).toContain("服务报告状态：reported");
  expect(screen.getByText("文本剩余空间")).toBeTruthy();
  expect(screen.getAllByRole("row")).toHaveLength(10);
});
it("maintains session switch, draft, and focus guards with vision cost present", async () => {
  selectLocale("zh-CN");
  const visionUsage = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "unknown", images: 1, pixels: 500 },
  });
  store.setState({ currentSessionId: "A", contextUsage: visionUsage, composer: "测试草稿" });
  render(<ContextUsagePanel />);
  const trigger = screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" });

  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭上下文用量" }));
  expect(screen.getByText("待发送草稿约 12", { exact: false })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));

  fireEvent.click(trigger);
  act(() => store.setState({ currentSessionId: "B" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => store.setState({ currentSessionId: "A" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("handles unknown images without pixels without displaying undefined or NaN", () => {
  selectLocale("zh-CN");
  const noPixelUsage = ContextUsageSchema.parse({
    ...usage,
    vision_cost: { state: "unknown", images: 1 },
  });
  store.setState({ currentSessionId: "A", contextUsage: noPixelUsage });
  const { baseElement: container } = render(<ContextUsagePanel />);
  fireEvent.click(screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" }));
  expect(container.textContent).toContain("含 1 张图片；视觉成本未知，未计入上方统计");
  expect(container.textContent).not.toContain("undefined");
  expect(container.textContent).not.toContain("NaN");
  expect(container.textContent).not.toContain("像素");
});
