import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const baseUsage = ContextUsageSchema.parse({
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

it("renders token estimate and percentage with byte detail for legacy components (zh-CN)", () => {
  selectLocale("zh-CN");
  const usageWithTokens = {
    ...baseUsage,
    model_tokens: {
      method: "serialized_chat_token_estimate",
      encoding: "o200k_base",
      input_tokens: 1500,
      input_limit: 8000,
      media_state: "none" as const,
    },
  };
  store.setState({ currentSessionId: "A", contextUsage: usageWithTokens as any, composer: "" });
  const { baseElement: container } = render(<ContextUsagePanel />);

  const trigger = screen.getByRole("button", { name: "上下文用量" });
  expect(trigger).toBeTruthy();
  expect(container.textContent).toContain("15.0%");

  fireEvent.click(trigger);
  expect(screen.getAllByRole("row")).toHaveLength(10);
  expect(container.textContent).toContain("最近请求的输入占用");
  expect(container.textContent).toContain("已用约 1,500 / 10,000 Token（估算）");
  expect(container.textContent).toContain("按模型分词估算，非物理精确 token 数。");
  expect(container.textContent).toContain(
    "最近请求模型：chat-model（容量 10,000）· 编码：o200k_base",
  );

  // Legacy components show byte detail instead of projecting percentage against capacity C
  const byteDetails = screen.getAllByText("字节明细");
  expect(byteDetails).toHaveLength(7);

  // Reserves and remaining show percentages against capacity C
  // output: 1000/10000 = 10.0%, safety: 1000/10000 = 10.0%, remaining: (8000 - 1500)/10000 = 65.0%
  expect(screen.getAllByText("10.0%")).toHaveLength(2);
  expect(screen.getByText("65.0%")).toBeTruthy();
  expect(screen.getByText("6,500")).toBeTruthy();
  expect(screen.getByText("剩余空间")).toBeTruthy();
});

it("renders token estimate and percentage with byte detail in English (en)", () => {
  selectLocale("en");
  const usageWithTokens = {
    ...baseUsage,
    model_tokens: {
      method: "serialized_chat_token_estimate",
      encoding: "o200k_base",
      input_tokens: 2000,
      input_limit: 8000,
      media_state: "none" as const,
    },
  };
  store.setState({ currentSessionId: "A", contextUsage: usageWithTokens as any, composer: "" });
  const { baseElement: container } = render(<ContextUsagePanel />);

  const trigger = screen.getByRole("button", { name: "Context usage" });
  expect(trigger).toBeTruthy();
  expect(container.textContent).toContain("20.0%");

  fireEvent.click(trigger);
  expect(screen.getAllByRole("row")).toHaveLength(10);
  expect(container.textContent).toContain("Input usage of the latest request");
  expect(container.textContent).toContain("Approx. 2,000 / 10,000 tokens (estimate)");
  expect(container.textContent).toContain(
    "Estimated from model tokenizer, not physical exact tokens.",
  );

  const byteDetails = screen.getAllByText("Byte detail");
  expect(byteDetails).toHaveLength(7);

  // output: 1000/10000 = 10.0%, safety: 1000/10000 = 10.0%, remaining: (8000 - 2000)/10000 = 60.0%
  expect(screen.getByText("60.0%")).toBeTruthy();
  expect(screen.getByText("6,000")).toBeTruthy();
  expect(screen.getByText("Remaining space")).toBeTruthy();
  expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/);
});

it("renders unknown media state with text-only label, token estimate, and vision note", () => {
  selectLocale("zh-CN");
  const unknownMediaUsage = {
    ...baseUsage,
    vision_cost: { state: "unknown" as const, images: 2, pixels: 800 },
    model_tokens: {
      method: "serialized_chat_token_estimate",
      encoding: "o200k_base",
      input_tokens: 1200,
      input_limit: 8000,
      media_state: "unknown" as const,
    },
  };
  store.setState({ currentSessionId: "A", contextUsage: unknownMediaUsage as any, composer: "" });
  const { baseElement: container } = render(<ContextUsagePanel />);

  const trigger = screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" });
  expect(trigger).toBeTruthy();
  expect(trigger.getAttribute("title")).toBe("上下文用量（仅文本估算，视觉成本未计入）");

  fireEvent.click(trigger);
  expect(container.textContent).toContain("最近请求的文本输入估算");
  expect(container.textContent).toContain("文本已用约 1,200 / 10,000 Token（估算）");
  expect(screen.getByText("文本剩余空间")).toBeTruthy();
  expect(screen.queryByText("剩余空间")).toBeNull();

  // Vision note warning retained
  expect(container.textContent).toContain("含 2 张图片（800 像素）");
  expect(container.textContent).toContain("视觉成本未知，未计入上方统计");

  // Remaining: (8000 - 1200) = 6800 -> 68.0%
  expect(screen.getByText("6,800")).toBeTruthy();
  expect(screen.getByText("68.0%")).toBeTruthy();
});

it("renders unknown media state when vision_cost is absent with fallback warning", () => {
  selectLocale("zh-CN");
  const unknownNoVision = {
    ...baseUsage,
    vision_cost: undefined,
    model_tokens: {
      method: "serialized_chat_token_estimate",
      encoding: "o200k_base",
      input_tokens: 1000,
      input_limit: 8000,
      media_state: "unknown" as const,
    },
  };
  store.setState({ currentSessionId: "A", contextUsage: unknownNoVision as any, composer: "" });
  const { baseElement: container } = render(<ContextUsagePanel />);

  const trigger = screen.getByRole("button", { name: "上下文用量（仅文本估算，视觉成本未计入）" });
  fireEvent.click(trigger);

  expect(container.textContent).toContain("视觉计量状态未知，未计入上方统计");
  expect(container.textContent).toContain("文本已用约 1,000 / 10,000 Token（估算）");
  expect(screen.getByText("文本剩余空间")).toBeTruthy();
});

it("clamps remaining tokens to 0 when input_tokens exceeds input_limit", () => {
  selectLocale("zh-CN");
  const overflowUsage = {
    ...baseUsage,
    model_tokens: {
      method: "serialized_chat_token_estimate",
      encoding: "o200k_base",
      input_tokens: 8500,
      input_limit: 8000,
      media_state: "none" as const,
    },
  };
  store.setState({ currentSessionId: "A", contextUsage: overflowUsage as any });
  const { baseElement: container } = render(<ContextUsagePanel />);

  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  expect(container.textContent).toContain("已用约 8,500 / 10,000 Token（估算）");
  expect(screen.getByText("0.0%")).toBeTruthy();
});

it("preserves exact legacy byte behavior when model_tokens is absent", () => {
  selectLocale("zh-CN");
  store.setState({ currentSessionId: "A", contextUsage: baseUsage, composer: "" });
  const { baseElement: container } = render(<ContextUsagePanel />);

  const trigger = screen.getByRole("button", { name: "上下文用量" });
  expect(trigger).toBeTruthy();
  expect(container.textContent).toContain("10.0%");

  fireEvent.click(trigger);
  expect(screen.getAllByRole("row")).toHaveLength(10);
  expect(container.textContent).toContain("最近请求的输入占用");
  expect(container.textContent).toContain("已用约 1,000 / 10,000");
  expect(container.textContent).not.toContain("Token");
  expect(container.textContent).not.toContain("字节明细");
  expect(container.textContent).toContain("按 UTF-8 字节和消息开销估算，非模型精确 token 数。");
  expect(container.textContent).toContain("最近请求模型：chat-model（容量 10,000）· 保守字节估算");
  expect(screen.getByText("剩余空间")).toBeTruthy();
});

it("keeps unsent draft as separate UTF-8 byte estimate without converting to tokens", () => {
  selectLocale("zh-CN");
  const usageWithTokens = {
    ...baseUsage,
    model_tokens: {
      method: "serialized_chat_token_estimate",
      encoding: "o200k_base",
      input_tokens: 1500,
      input_limit: 8000,
      media_state: "none" as const,
    },
  };
  store.setState({
    currentSessionId: "A",
    contextUsage: usageWithTokens as any,
    composer: "你好",
  });
  const { baseElement: container } = render(<ContextUsagePanel />);

  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  expect(container.textContent).toContain("待发送草稿约 6");
  expect(container.textContent).toContain("已用约 1,500 / 10,000 Token（估算）");
});
