// Auxiliary text leaves measure the declared token domain, not bytes.
//
// Contract: when the gateway can prepare a context budget whose route declares
// a tokenizer (ModelContextBudget with countText), the auxiliary auto capacity
// gate must measure the FULL request (messages + response schema) with the
// declared counter against the model capacity minus the saved output reserve.
// The saved input_limit stays a separate utf8 byte hard cap; the two domains
// are never mixed, min'ed or subtracted across units. The descriptor and the
// token ceiling travel into completeLeaf input (contextBudget /
// contextInputLimit), the leaf input stays indivisible (over ceiling refuses,
// never truncates), and a gateway without the optional prepare hook keeps the
// legacy byte gate, call counts and wire shape unchanged.
//
// Synthetic only: in-memory business db, fake gateway, synthetic declared
// tokenizer. No live model, no real data, no network, relative imports only.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { enqueue } from "../../src/server/db/memory-repository";
import {
  readOrganizationSettings,
  updateOrganizationSettings,
} from "../../src/server/db/organization-repository";
import {
  createSession,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  immediate,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { measureContextTokens } from "../../src/server/llm/request-format";
import { KnowledgeOrganizer } from "../../src/server/services/knowledge-organizer";
import { MemoryService } from "../../src/server/services/memory-service";
import { estimateTokens } from "../../src/server/services/token-estimate";

const MODEL = "qwen/qwen3-4b-2507";
const OUTPUT_RESERVED = 512;
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

const DRAFT_JSON = JSON.stringify({
  memory: {
    name: "喜好",
    summary: "用户喜欢精炼回复",
    tags: ["偏好"],
    kinds: ["semantic"],
    body: "用户希望答复使用中文，表达简短。",
  },
});
const BLOCKED_JSON = JSON.stringify({ blocked: false });
const KNOWLEDGE_DRAFT_JSON = JSON.stringify({
  summary: "设备条件",
  tags: ["设备"],
  body: "阈值42.5，例外仅限维护模式。",
});
const KNOWLEDGE_RESERVED = 512;
const KNOWLEDGE_TEXT =
  "该设备的维护阈值是42.5摄氏度，例外仅限维护模式，触发时需要先停止采集再记录日志。".repeat(45);
const BLOCKED_BODY = "完全不同的旧记忆正文";

const USER_TEXT =
  "用户偏好整理：这台设备的答复请保持中文，先给出结论再补充原因，正文控制在两句话以内，" +
  "不要罗列重复的问候语，也不要反复确认已经给出的安排，例外情况提前说明即可。";
const ASSISTANT_TEXT =
  "好的，之后我会先用一句话给出结论，再用一句话补充原因，全部使用中文简短作答，不再重复确认。";

const encoding = "o200k_base" as const;

/** Synthetic declared tokenizer: one token per code point. CJK text costs three
 * UTF-8 bytes per token, so the legacy byte estimate and the declared token
 * measure diverge deterministically without any real tokenizer dependency. */
const countTokens = (text: string): number => [...text].length;

type WireCall = {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  contextBudget?: ModelContextBudget;
  contextInputLimit?: number;
};

/** Legacy gateway double: byte capacity probe only, no optional prepare hook. */
class ByteGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  capacity: number | null = 1_000_000;
  calls: WireCall[] = [];
  capacityProbes = 0;
  async listModels(): Promise<string[]> {
    return [MODEL];
  }
  async loadedContextCapacity(): Promise<number | null> {
    this.capacityProbes += 1;
    return this.capacity;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(options: WireCall): Promise<string> {
    this.calls.push(options);
    const schemaText = JSON.stringify(options.responseSchema);
    // First call is the consolidation draft; a suppression verdict against the
    // seeded blocked entry follows; anything else is a knowledge organize call.
    if (schemaText.includes("MemoryDraft")) return DRAFT_JSON;
    if (schemaText.includes("blocked")) return BLOCKED_JSON;
    return KNOWLEDGE_DRAFT_JSON;
  }
  async *streamChat(): AsyncGenerator<string> {
    yield "unused";
  }
}

/** Adds the optional prepare hook with the declared synthetic counter. */
class CounterGateway extends ByteGateway {
  preparations = 0;
  async prepareContextModel(): Promise<ModelContextBudget> {
    this.preparations += 1;
    return Object.freeze({
      model: MODEL,
      capacity: this.capacity,
      tokenizerEncoding: encoding,
      countText: countTokens,
      assertCurrent: () => {},
    });
  }
}

/** Legacy byte domain, computed from the recorded wire call: the memory
 * worker's current full-request estimate (estimateMessages overhead plus the
 * serialized response schema). */
const byteCostOf = (call: WireCall): number =>
  3 +
  call.messages.reduce(
    (sum, message) => sum + 12 + estimateTokens(message.role) + estimateTokens(message.content),
    0,
  ) +
  estimateTokens(JSON.stringify(call.responseSchema ?? {}));

/** Declared token domain: the same full request measured with the descriptor's
 * counter through the existing measureContextTokens entrypoint. */
const tokenCostOf = (call: WireCall): number =>
  measureContextTokens(
    call.messages,
    { encoding, count: countTokens },
    call.responseSchema === undefined ? undefined : { responseSchema: call.responseSchema },
  ).textTokens;

/** Knowledge organizer byte domain: its own per-message overhead formula (8 per
 * message + 2) plus the serialized response schema. */
const knowledgeByteCostOf = (call: WireCall): number =>
  2 +
  call.messages.reduce((sum, message) => sum + estimateTokens(message.content) + 8, 0) +
  estimateTokens(JSON.stringify(call.responseSchema ?? {}));

function setup(gateway: ModelGateway) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const service = new MemoryService({
    orm: business.orm,
    db: business.db,
    gateway,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
    jobTimeoutMs: 2_000,
  });
  return { business, orm: business.orm, db: business.db, service };
}

type Ctx = ReturnType<typeof setup>;

function completedTurn(orm: Ctx["orm"], sessionId: string, key: string): string {
  const prepared = prepareTurn(orm, sessionId, USER_TEXT, key);
  if (prepared.generationToken === null) throw new Error("fresh token expected");
  saveCompletedAssistantMessage(orm, sessionId, ASSISTANT_TEXT, key, prepared.generationToken);
  const turn = getTurnByRequest(orm, sessionId, key);
  if (!turn) throw new Error("turn missing");
  return turn.id;
}

/** Freeze a memory_consolidate allocation profile into the agent's stored config. */
function setAgentAuxProfile(orm: Ctx["orm"], profile: Record<string, unknown> | undefined): void {
  const row = orm.select().from(schema.agents).where(eq(schema.agents.id, AGENT_ID)).get();
  if (!row) throw new Error("default agent missing");
  const p5 = JSON.parse(row.p5Config) as Record<string, unknown>;
  const aux = (p5.auxiliary_allocation ?? {}) as Record<string, unknown>;
  const next = { ...p5, auxiliary_allocation: { ...aux, memory_consolidate: profile } };
  orm
    .update(schema.agents)
    .set({ p5Config: JSON.stringify(next) })
    .where(eq(schema.agents.id, AGENT_ID))
    .run();
}

/** Seed one suppressed governed entry so the suppression comparison call runs. */
function seedSuppressedEntry(ctx: Ctx): void {
  immediate(ctx.db, () => {
    ctx.orm
      .insert(schema.memoryEntries)
      .values({
        id: crypto.randomUUID(),
        agentId: AGENT_ID,
        userId: DEFAULT_USER_ID,
        name: "旧记忆",
        summary: "旧",
        tags: JSON.stringify([]),
        kinds: JSON.stringify(["semantic"]),
        body: BLOCKED_BODY,
        status: "suppressed",
        scope: "reality_user",
        scopeKey: AGENT_ID,
        configSnapshot: "{}",
        createdAt: nowIso(),
      } satisfies typeof schema.memoryEntries.$inferInsert)
      .run();
  });
}

async function runOne(ctx: Ctx, requestKey: string): Promise<string> {
  const sessionId = createSession(ctx.orm, "宣告计数预算", { modelName: MODEL }).id;
  const turnId = completedTurn(ctx.orm, sessionId, requestKey);
  const job = immediate(ctx.db, () =>
    enqueue(ctx.orm, AGENT_ID, requestKey, { kind: "manual", sessionId, turnIds: [turnId] }),
  );
  await ctx.service.runJob(job.id);
  return job.id;
}

function jobOf(ctx: Ctx, jobId: string) {
  const row = ctx.orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, jobId)).get();
  if (!row) throw new Error("job missing");
  return row;
}

/** Probe run with a huge capacity only: measures the REAL full-request costs of
 * every actual wire call (consolidate and its suppression comparison, each with
 * its own schema) in both domains. No production budget is involved. */
async function measureConsolidateRequests(
  gateway: ByteGateway,
  profile: Record<string, unknown> | undefined,
): Promise<Array<{ byteCost: number; tokenCost: number }>> {
  const ctx = setup(gateway);
  try {
    if (profile) setAgentAuxProfile(ctx.orm, profile);
    seedSuppressedEntry(ctx);
    const jobId = await runOne(ctx, `probe-${crypto.randomUUID()}`);
    expect(jobOf(ctx, jobId)?.status).toBe("succeeded");
    expect(gateway.calls.length).toBe(2);
    expect(JSON.stringify(gateway.calls[0]?.responseSchema)).toContain("MemoryDraft");
    expect(JSON.stringify(gateway.calls[1]?.responseSchema)).toContain("blocked");
  } finally {
    ctx.business.close();
  }
  const measured = gateway.calls.map((call) => ({
    byteCost: byteCostOf(call),
    tokenCost: tokenCostOf(call),
  }));
  for (const { byteCost, tokenCost } of measured)
    expect(byteCost - tokenCost).toBeGreaterThanOrEqual(2);
  return measured;
}

describe("auxiliary declared-counter budget", () => {
  it(
    "admits a CJK request that fits the declared token capacity where the byte estimate " +
      "refuses, and passes the descriptor and token ceiling to completeLeaf",
    async () => {
      const probe = new CounterGateway();
      const measured = await measureConsolidateRequests(probe, {
        mode: "auto",
        output_reserved: OUTPUT_RESERVED,
      });
      const maxByte = Math.max(...measured.map((m) => m.byteCost));
      const maxToken = Math.max(...measured.map((m) => m.tokenCost));
      const ceiling = Math.floor((maxToken + maxByte) / 2);
      expect(ceiling).toBeGreaterThanOrEqual(maxToken);
      expect(ceiling).toBeLessThan(maxByte);

      // Capacity between the two domains: the declared token gate must admit
      // what the legacy byte estimate refuses when the declared token cost fits.
      const gateway = new CounterGateway();
      gateway.capacity = OUTPUT_RESERVED + ceiling;
      const ctx = setup(gateway);
      try {
        setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
        seedSuppressedEntry(ctx);
        const jobId = await runOne(ctx, "counter-tight");
        expect(jobOf(ctx, jobId)?.status).toBe("succeeded");
        expect(jobOf(ctx, jobId)?.errorCode).toBeNull();
        expect(gateway.calls.length).toBe(2);
        for (const call of gateway.calls) {
          expect(call.contextBudget).toBeDefined();
          expect(call.contextBudget?.model).toBe(MODEL);
          expect(call.contextBudget?.capacity).toBe(OUTPUT_RESERVED + ceiling);
          expect(typeof call.contextBudget?.countText).toBe("function");
          expect(call.contextInputLimit).toBe(ceiling);
          expect(call.maxTokens).toBe(OUTPUT_RESERVED);
        }
        // The prepared descriptor is the one capacity source: no second probe.
        expect(gateway.capacityProbes).toBe(0);
        expect(gateway.preparations).toBeGreaterThan(0);
        // The leaf input is indivisible: the full source text reaches the model.
        expect(JSON.stringify(gateway.calls[0]?.messages)).toContain(USER_TEXT);
        // The suppression comparison prices its own schema and carries the same
        // descriptor and ceiling on its own leaf input.
        const suppression = gateway.calls[1];
        if (!suppression) throw new Error("suppression call missing");
        expect(JSON.stringify(suppression.responseSchema)).toContain("blocked");
        expect(JSON.stringify(suppression.messages)).toContain(BLOCKED_BODY);
      } finally {
        ctx.business.close();
      }
    },
  );

  it(
    "keeps the saved input_limit a byte hard cap even when the declared token cost fits " +
      "(no cross-unit reinterpretation)",
    async () => {
      const measured = await measureConsolidateRequests(new ByteGateway(), undefined);
      const consolidate = measured[0];
      if (!consolidate) throw new Error("consolidate measurement missing");
      const byteLimit = Math.floor((consolidate.tokenCost + consolidate.byteCost) / 2);
      expect(byteLimit).toBeGreaterThan(consolidate.tokenCost);
      expect(byteLimit).toBeLessThan(consolidate.byteCost);

      const gateway = new CounterGateway();
      gateway.capacity = 1_000_000;
      const ctx = setup(gateway);
      try {
        // input_limit is the saved utf8 byte hard cap, independent of the
        // declared counter: a token fit never widens it.
        setAgentAuxProfile(ctx.orm, { mode: "fixed", input_limit: byteLimit });
        const jobId = await runOne(ctx, "byte-cap-tight");
        expect(jobOf(ctx, jobId)?.status).toBe("failed");
        expect(jobOf(ctx, jobId)?.errorCode).toBe("CONTEXT_AUX_BUDGET");
        expect(gateway.calls.length).toBe(0);
      } finally {
        ctx.business.close();
      }
    },
  );

  it(
    "keeps the legacy byte auto gate and wire shape when the gateway has no " + "prepare hook",
    async () => {
      const legacy = new ByteGateway();
      const measured = await measureConsolidateRequests(legacy, {
        mode: "auto",
        output_reserved: OUTPUT_RESERVED,
      });
      // Legacy wire shape: no descriptor, no ceiling, the saved reserve as maxTokens.
      const probeCall = legacy.calls[0];
      if (!probeCall) throw new Error("probe call missing");
      expect(probeCall.contextBudget).toBeUndefined();
      expect(probeCall.contextInputLimit).toBeUndefined();
      expect(probeCall.maxTokens).toBe(OUTPUT_RESERVED);

      const consolidate = measured[0];
      if (!consolidate) throw new Error("consolidate measurement missing");
      const ceiling = Math.floor((consolidate.tokenCost + consolidate.byteCost) / 2);
      const gateway = new ByteGateway();
      gateway.capacity = OUTPUT_RESERVED + ceiling;
      const ctx = setup(gateway);
      try {
        setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
        // Without the prepare hook the old byte domain still governs the auto
        // ceiling: the same CJK request must keep refusing (no token rescue).
        const jobId = await runOne(ctx, "legacy-tight");
        expect(jobOf(ctx, jobId)?.status).toBe("failed");
        expect(jobOf(ctx, jobId)?.errorCode).toBe("CONTEXT_AUX_BUDGET");
        expect(gateway.calls.length).toBe(0);
        expect(gateway.capacityProbes).toBe(1);
      } finally {
        ctx.business.close();
      }
    },
  );

  it(
    "knowledge.organize: declared counter admits a CJK segment the byte estimate " +
      "refuses, and passes the descriptor and token ceiling to completeLeaf",
    async () => {
      const runKnowledge = async (gateway: CounterGateway): Promise<void> => {
        const business = openBusinessDb();
        const organizer = new KnowledgeOrganizer({
          db: business.db,
          orm: business.orm,
          gateway,
        });
        try {
          ensureDefaults(business.orm, MODEL);
          updateOrganizationSettings(business.orm, {
            auxiliary_allocation: {
              knowledge_organize: { mode: "auto", output_reserved: KNOWLEDGE_RESERVED },
            },
            expected_revision: readOrganizationSettings(business.orm).revision,
          });
          new KnowledgeRepository(business.db).importDocument({
            category_id: "default",
            name: "合成资料",
            original_text: KNOWLEDGE_TEXT,
          });
          expect(await organizer.runCycle()).toBe(true);
          const job = business.db
            .query("SELECT status, error_code FROM knowledge_jobs LIMIT 1")
            .get() as { status: string; error_code: string | null };
          expect(job.status).toBe("succeeded");
          expect(job.error_code).toBeNull();
        } finally {
          await organizer.stop();
          business.close();
        }
      };
      // Probe run (huge capacity) measures the real per-chunk request in both
      // domains; no production budget is involved.
      const probe = new CounterGateway();
      await runKnowledge(probe);
      expect(probe.calls.length).toBeGreaterThan(0);
      const measured = probe.calls.map((call) => ({
        byteCost: knowledgeByteCostOf(call),
        tokenCost: tokenCostOf(call),
      }));
      const maxByte = Math.max(...measured.map((m) => m.byteCost));
      const maxToken = Math.max(...measured.map((m) => m.tokenCost));
      // The 256-overhead check must also pass in the token domain after the fix
      // while the byte domain keeps refusing; derive the capacity, never invent it.
      expect(maxByte - maxToken).toBeGreaterThan(512);
      const capacity = KNOWLEDGE_RESERVED + 256 + Math.floor((maxToken + maxByte) / 2);
      const gateway = new CounterGateway();
      gateway.capacity = capacity;
      await runKnowledge(gateway);
      expect(gateway.calls.length).toBeGreaterThan(0);
      for (const call of gateway.calls) {
        expect(call.contextBudget).toBeDefined();
        expect(call.contextBudget?.model).toBe(MODEL);
        expect(call.contextBudget?.capacity).toBe(capacity);
        expect(typeof call.contextBudget?.countText).toBe("function");
        expect(call.contextInputLimit).toBe(capacity - KNOWLEDGE_RESERVED - 256);
        // The saved output reserve stays the hard max_tokens on the wire.
        expect(call.maxTokens).toBe(KNOWLEDGE_RESERVED);
      }
      // The prepared descriptor replaces the per-chunk probe: no double probe.
      expect(gateway.capacityProbes).toBe(0);
      expect(gateway.preparations).toBeGreaterThan(0);
    },
  );
  it(
    "knowledge.organize: prepared descriptor without declared counter passes contextBudget " +
      "for route verification but omits contextInputLimit",
    async () => {
      class RouteOnlyGateway extends ByteGateway {
        preparations = 0;
        async prepareContextModel(): Promise<ModelContextBudget> {
          this.preparations += 1;
          return Object.freeze({
            model: MODEL,
            capacity: this.capacity,
            assertCurrent: () => {},
          });
        }
      }
      const gateway = new RouteOnlyGateway();
      gateway.capacity = 1_000_000;
      const business = openBusinessDb();
      const organizer = new KnowledgeOrganizer({
        db: business.db,
        orm: business.orm,
        gateway,
      });
      try {
        ensureDefaults(business.orm, MODEL);
        updateOrganizationSettings(business.orm, {
          auxiliary_allocation: {
            knowledge_organize: { mode: "auto", output_reserved: KNOWLEDGE_RESERVED },
          },
          expected_revision: readOrganizationSettings(business.orm).revision,
        });
        new KnowledgeRepository(business.db).importDocument({
          category_id: "default",
          name: "资料无计数",
          original_text: KNOWLEDGE_TEXT,
        });
        expect(await organizer.runCycle()).toBe(true);
        expect(gateway.calls.length).toBeGreaterThan(0);
        for (const call of gateway.calls) {
          expect(call.contextBudget).toBeDefined();
          expect(call.contextBudget?.model).toBe(MODEL);
          expect(call.contextInputLimit).toBeUndefined();
          expect(call.maxTokens).toBe(KNOWLEDGE_RESERVED);
        }
        expect(gateway.capacityProbes).toBe(0);
        expect(gateway.preparations).toBeGreaterThan(0);
      } finally {
        await organizer.stop();
        business.close();
      }
    },
  );

  it("fixed profile with declared prepare: tiny physical capacity refuses even when saved byte limit is sufficient", async () => {
    const gateway = new CounterGateway();
    // Physical capacity is tiny (50 tokens) - cannot fit the full consolidation request.
    gateway.capacity = 50;
    const ctx = setup(gateway);
    try {
      // Saved byte limit is huge (100,000 bytes) - byte check alone would admit it.
      setAgentAuxProfile(ctx.orm, {
        mode: "fixed",
        input_limit: 100_000,
        output_reserved: 32,
      });
      const jobId = await runOne(ctx, "fixed-tiny-capacity");
      expect(jobOf(ctx, jobId)?.status).toBe("failed");
      expect(jobOf(ctx, jobId)?.errorCode).toBe("CONTEXT_AUX_BUDGET");
      expect(gateway.calls.length).toBe(0);
      expect(gateway.preparations).toBeGreaterThan(0);
    } finally {
      ctx.business.close();
    }
  });

  it("fixed profile with declared prepare: passes descriptor and respects capacity ceiling when capacity fits", async () => {
    const gateway = new CounterGateway();
    gateway.capacity = 1_000_000;
    const ctx = setup(gateway);
    try {
      setAgentAuxProfile(ctx.orm, {
        mode: "fixed",
        input_limit: 100_000,
        output_reserved: OUTPUT_RESERVED,
      });
      const jobId = await runOne(ctx, "fixed-capacity-fits");
      expect(jobOf(ctx, jobId)?.status).toBe("succeeded");
      expect(gateway.calls.length).toBeGreaterThan(0);
      for (const call of gateway.calls) {
        expect(call.contextBudget).toBeDefined();
        expect(call.contextBudget?.model).toBe(MODEL);
      }
      expect(gateway.preparations).toBeGreaterThan(0);
    } finally {
      ctx.business.close();
    }
  });

  it("no-profile legacy snapshot performs no extra probe and preserves legacy wire shape", async () => {
    const gateway = new CounterGateway();
    gateway.capacity = 1_000_000;
    const ctx = setup(gateway);
    try {
      // Profile is undefined (legacy snapshot with no auxiliary allocation profile).
      const jobId = await runOne(ctx, "no-profile-legacy");
      expect(jobOf(ctx, jobId)?.status).toBe("succeeded");
      expect(gateway.capacityProbes).toBe(0);
      expect(gateway.preparations).toBe(0);
      expect(gateway.calls.length).toBeGreaterThan(0);
      for (const call of gateway.calls) {
        expect(call.contextBudget).toBeUndefined();
        expect(call.contextInputLimit).toBeUndefined();
      }
    } finally {
      ctx.business.close();
    }
  });
  it("fixed profile with null input_limit and declared prepare: tiny physical capacity refuses", async () => {
    const gateway = new CounterGateway();
    gateway.capacity = 50;
    const ctx = setup(gateway);
    try {
      // Explicit fixed profile without an input_limit (null/unbounded byte cap).
      // Physical capacity gate still refuses when model tokens exceed capacity.
      setAgentAuxProfile(ctx.orm, {
        mode: "fixed",
        output_reserved: 32,
      });
      const jobId = await runOne(ctx, "fixed-null-limit-tiny");
      expect(jobOf(ctx, jobId)?.status).toBe("failed");
      expect(jobOf(ctx, jobId)?.errorCode).toBe("CONTEXT_AUX_BUDGET");
      expect(gateway.calls.length).toBe(0);
      expect(gateway.preparations).toBeGreaterThan(0);
    } finally {
      ctx.business.close();
    }
  });

  it("fixed profile without prepare hook preserves legacy behavior with zero capacity probes", async () => {
    const gateway = new ByteGateway();
    gateway.capacity = 1_000_000;
    const ctx = setup(gateway);
    try {
      setAgentAuxProfile(ctx.orm, {
        mode: "fixed",
        input_limit: 100_000,
        output_reserved: OUTPUT_RESERVED,
      });
      const jobId = await runOne(ctx, "fixed-legacy-no-probe");
      expect(jobOf(ctx, jobId)?.status).toBe("succeeded");
      expect(gateway.capacityProbes).toBe(0);
      expect(gateway.calls.length).toBeGreaterThan(0);
      for (const call of gateway.calls) {
        expect(call.contextBudget).toBeUndefined();
        expect(call.contextInputLimit).toBeUndefined();
        expect(call.maxTokens).toBe(OUTPUT_RESERVED);
      }
    } finally {
      ctx.business.close();
    }
  });

  it(
    "memory.consolidate: prepared descriptor without declared counter passes contextBudget " +
      "for route verification but omits contextInputLimit",
    async () => {
      class MemoryRouteOnlyGateway extends ByteGateway {
        preparations = 0;
        async prepareContextModel(): Promise<ModelContextBudget> {
          this.preparations += 1;
          return Object.freeze({
            model: MODEL,
            capacity: this.capacity,
            assertCurrent: () => {},
          });
        }
      }
      const gateway = new MemoryRouteOnlyGateway();
      gateway.capacity = 1_000_000;
      const ctx = setup(gateway);
      try {
        setAgentAuxProfile(ctx.orm, {
          mode: "fixed",
          input_limit: 100_000,
          output_reserved: OUTPUT_RESERVED,
        });
        const jobId = await runOne(ctx, "memory-route-only");
        expect(jobOf(ctx, jobId)?.status).toBe("succeeded");
        expect(gateway.calls.length).toBeGreaterThan(0);
        for (const call of gateway.calls) {
          expect(call.contextBudget).toBeDefined();
          expect(call.contextBudget?.model).toBe(MODEL);
          expect(call.contextInputLimit).toBeUndefined();
        }
        expect(gateway.capacityProbes).toBe(0);
        expect(gateway.preparations).toBeGreaterThan(0);
      } finally {
        ctx.business.close();
      }
    },
  );
});
