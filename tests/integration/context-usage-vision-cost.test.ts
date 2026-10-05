// T14 visionCost 观测接线（prime-vision-cost-plan V3）：
// ContextUsage.vision_cost 契约（strict/旧 payload 兼容/无伪精确字段）与 WebContextSource
// 对 RenderedContext.visionCost 的透传。全链合成夹具，零真实网络；语义锁规格 §11：
// unknown 不是 0、pixels 是准备元数据不是 token、不进 input_units/remaining 容量推导。
import { describe, expect, it } from "bun:test";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { RenderedContext } from "../../src/server/agent/context-engine";
import {
  type ActionObservation,
  ContextEngine,
  textMessage,
} from "../../src/server/agent/context-engine";
import { WebContextSource } from "../../src/server/channels/web-context-source";
import type { ContextUsage } from "../../src/shared/contracts/context-usage";
import { ContextUsageSchema, VisionCostSchema } from "../../src/shared/contracts/context-usage";

const MODEL = "qwen/qwen3-4b-2507";

/** 完整合法的旧形状 usage（无 vision_cost）：wire 向后兼容的锚点。 */
const legacyUsage: ContextUsage = {
  session_id: "00000000-0000-4000-8000-000000000001",
  turn_id: "00000000-0000-4000-8000-000000000002",
  model: MODEL,
  estimator: "utf8_bytes_plus_message_overhead",
  capacity: 32768,
  input_units: 100,
  input_limit: 30000,
  output_reserved: 1024,
  safety_reserved: 744,
  remaining: 29000,
  components: {
    instructions: 10,
    recent_history: 40,
    summaries: 10,
    long_term_memory: 0,
    knowledge: 0,
    current_question: 38,
    protocol: 2,
  },
};

const imagePart = {
  kind: "image" as const,
  sourceId: "asset-1",
  revision: "1",
  mimeType: "image/png",
  sha256: "a".repeat(64),
  width: 4,
  height: 2,
};

describe("ContextUsage.vision_cost 契约（T14 Step 观测）", () => {
  it("正测：合法 usage + vision_cost 通过 strict 解析", () => {
    const parsed = ContextUsageSchema.safeParse({
      ...legacyUsage,
      vision_cost: { state: "unknown", images: 2, pixels: 8 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.vision_cost).toEqual({ state: "unknown", images: 2, pixels: 8 });
  });

  it("正测：旧 payload（无 vision_cost）照常解析——wire 向后兼容", () => {
    const parsed = ContextUsageSchema.safeParse(legacyUsage);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vision_cost).toBeUndefined();
  });

  it("正测：VisionCostSchema 接受三态与可选计数", () => {
    expect(VisionCostSchema.safeParse({ state: "unknown", images: 1, pixels: 8 }).success).toBe(
      true,
    );
    expect(VisionCostSchema.safeParse({ state: "estimated", images: 0, pixels: 0 }).success).toBe(
      true,
    );
    expect(VisionCostSchema.safeParse({ state: "reported" }).success).toBe(true);
  });

  it("负测：strict 拒绝伪精确 token/cost 字段（unknown 不是可折算数值）", () => {
    expect(
      ContextUsageSchema.safeParse({
        ...legacyUsage,
        vision_cost: { state: "unknown", tokens: 123 },
      }).success,
    ).toBe(false);
    expect(VisionCostSchema.safeParse({ state: "reported", cost_units: 1.5 }).success).toBe(false);
  });

  it("负测：负数计数与未知 state 被拒", () => {
    expect(VisionCostSchema.safeParse({ state: "unknown", images: -1 }).success).toBe(false);
    expect(VisionCostSchema.safeParse({ state: "guessed" }).success).toBe(false);
  });
});

describe("WebContextSource.contextUsage 透传 RenderedContext.visionCost", () => {
  it("正测：有图渲染 → vision_cost 逐字透传，usage 其余字段不变", () => {
    const source = makeSource();
    const visionCost = { state: "unknown" as const, images: 1, pixels: 8 };
    const rendered: RenderedContext = {
      messages: [
        textMessage("system", "s"),
        { role: "user", content: [{ kind: "text", text: "看这张" }, imagePart] },
      ],
      sources: [],
      units: 512,
      visionCost,
    };
    const usage = source.contextUsage(rendered);
    if (!usage) throw new Error("usage missing");
    expect(usage.vision_cost).toEqual(visionCost);
    // 不变式：有无 vision_cost，input_units/remaining/components 完全不变。
    const plain = source.contextUsage({
      ...rendered,
      visionCost: { state: "estimated", images: 0, pixels: 0 },
    });
    if (!plain) throw new Error("usage missing");
    for (const key of ["input_units", "remaining", "input_limit", "capacity"] as const)
      expect(usage[key]).toBe(plain[key]);
    expect(usage.components).toEqual(plain.components);
    // 旧形状 usage 仍可解析（组装结果本身过契约）。
    expect(ContextUsageSchema.safeParse(usage).success).toBe(true);
  });

  it("正测：无图渲染 → 精确 estimated 0 透传（不是缺省省略）", () => {
    const source = makeSource();
    const rendered: RenderedContext = {
      messages: [textMessage("system", "s"), textMessage("user", "纯文字")],
      sources: [],
      units: 128,
      visionCost: { state: "estimated", images: 0, pixels: 0 },
    };
    const usage = source.contextUsage(rendered);
    if (!usage) throw new Error("usage missing");
    expect(usage.vision_cost).toEqual({ state: "estimated", images: 0, pixels: 0 });
  });

  it("负测（隐私红线）：usage 序列化不含 data:image / base64 / path", () => {
    const source = makeSource();
    const rendered: RenderedContext = {
      messages: [
        textMessage("system", "s"),
        { role: "user", content: [{ kind: "text", text: "看这张" }, imagePart] },
      ],
      sources: [],
      units: 512,
      visionCost: { state: "unknown", images: 1, pixels: 8 },
    };
    const serialized = JSON.stringify(source.contextUsage(rendered) ?? {});
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("asset-1");
    expect(serialized).not.toContain("a".repeat(64));
  });
});

/** 直接构造最小 WebContextSource：contextUsage() 是纯组装，不触 builder/数据库。 */
function makeSource(): WebContextSource {
  const source = Object.create(WebContextSource.prototype) as WebContextSource;
  const internals = source as unknown as {
    usage: ContextUsage | undefined;
    engine: ContextEngine;
    spec: AgentSpec;
    observations: readonly ActionObservation[];
  };
  internals.usage = legacyUsage;
  internals.engine = new ContextEngine();
  internals.spec = {
    instructions: "i",
    availableActions: [],
    limits: { steps: 1 },
  } as unknown as AgentSpec;
  internals.observations = [];
  return source;
}

describe("context_usage 事件 JSON 实链保真", () => {
  it("RunEvent usage（含 vision_cost）经 appendEvent 持久往返不丢字段", async () => {
    const { openBusinessDb } = await import("../../src/server/db/schema-gate");
    const { AgentRunRepository } = await import("../../src/server/db/agent-run-repository");
    const { ensureDefaults } = await import("../../src/server/db/repositories");
    const business = openBusinessDb();
    ensureDefaults(business.orm, MODEL);
    const repository = new AgentRunRepository(business.db);
    const runId = crypto.randomUUID();
    repository.createRun({
      runId,
      specId: "vision-cost-wire",
      specVersion: "1",
      owner: { kind: "web_turn", id: "00000000-0000-4000-8000-000000000003" },
      at: new Date().toISOString(),
    });
    const usage = ContextUsageSchema.parse({
      ...legacyUsage,
      vision_cost: { state: "unknown", images: 2, pixels: 8 },
    });
    const stored = repository.appendEvent(
      runId,
      { type: "context_usage", usage },
      new Date().toISOString(),
    );
    if (stored.type !== "context_usage") throw new Error("unexpected event type");
    // 实链：仓库读回 payload（JSON 往返），字段保真。
    const events = repository.listEvents(runId);
    const replays = events.filter(
      (event): event is Extract<typeof event, { type: "context_usage" }> =>
        event.type === "context_usage",
    );
    expect(replays).toHaveLength(1);
    const parsed = ContextUsageSchema.parse(replays[0].usage);
    expect(parsed.vision_cost).toEqual({ state: "unknown", images: 2, pixels: 8 });
    expect(stored.usage.vision_cost).toEqual({ state: "unknown", images: 2, pixels: 8 });
  });
});
