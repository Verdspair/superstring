import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ContextUsageSchema } from "../../src/shared/contracts/context-usage";
import { ContextMeter as ContextUsagePanel } from "../../src/web/screens/conversations/ContextMeter";
import { selectLocale } from "../../src/web/i18n";
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
