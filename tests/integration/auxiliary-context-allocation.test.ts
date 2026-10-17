// RED: auxiliary context allocation — memory_consolidate role (AUX-CONTRACT-FROZEN).
//
// Contract: agents.p5_config.auxiliary_allocation.memory_consolidate
// { mode, input_limit?, output_reserved? } is frozen into memory_jobs.configSnapshot
// at enqueue (no live read on retry). output_reserved is the maxTokens actually
// sent on BOTH consolidate and suppression leaf calls (hard in both modes).
// input_limit (fixed) gates the real estimated full request before any model call:
// indivisible input fails with an explicit code, never truncated.
// Absent profile preserves the exact old caller behavior (no maxTokens, no gate).
//
// This file starts RED: the profile is not yet frozen nor applied. Root runs it
// natively. No live model, no real data, no service calls, relative imports only.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { measureContextTokens, textMessage } from "../../src/server/agent/context-engine";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { enqueue, entries } from "../../src/server/db/memory-repository";
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
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { KnowledgeOrganizer } from "../../src/server/services/knowledge-organizer";
import { MemoryService } from "../../src/server/services/memory-service";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { createQqMediaAdapter } from "../../src/server/services/qq-media-adapter";
import { createEphemeralAgentRuntime } from "../harness/ephemeral-runtime";

const MODEL = "qwen/qwen3-4b-2507";

const DRAFT_JSON = JSON.stringify({
  memory: {
    name: "喜好",
    summary: "用户喜欢精炼回复",
    tags: ["偏好"],
    kinds: ["semantic"],
    body: "用户希望答复使用中文，表达简短。",
  },
});
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

interface CompleteCall {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
}

class AuxGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  calls: CompleteCall[] = [];

  async listModels(): Promise<string[]> {
    return [MODEL];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return 32768;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(options: CompleteCall): Promise<string> {
    this.calls.push(options);
    // First call is the consolidation draft; any further call is the suppression
    // verdict against the seeded blocked entry. Both explicit, never guessed.
    const isConsolidate = JSON.stringify(options.responseSchema).includes("MemoryDraft");
    return isConsolidate ? DRAFT_JSON : JSON.stringify({ blocked: false });
  }
  async *streamChat(): AsyncGenerator<string> {
    yield "unused";
  }
}

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const gateway = new AuxGateway();
  const service = new MemoryService({
    orm: business.orm,
    db: business.db,
    gateway,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
    jobTimeoutMs: 2_000,
  });
  return { business, orm: business.orm, db: business.db, gateway, service };
}

function completedTurn(
  orm: ReturnType<typeof setup>["orm"],
  sessionId: string,
  key: string,
): string {
  const prepared = prepareTurn(orm, sessionId, `u-${key}`, key);
  if (prepared.generationToken === null) throw new Error("fresh token expected");
  saveCompletedAssistantMessage(orm, sessionId, `a-${key}`, key, prepared.generationToken);
  const turn = getTurnByRequest(orm, sessionId, key);
  if (!turn) throw new Error("turn missing");
  return turn.id;
}

/** Freeze a memory_consolidate allocation profile into the agent's stored p5_config. */
function setAgentAuxProfile(
  orm: ReturnType<typeof setup>["orm"],
  profile: Record<string, unknown> | undefined,
): void {
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

function snapshotAllocation(orm: ReturnType<typeof setup>["orm"], jobId: string): unknown {
  const job = orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, jobId)).get();
  if (!job) throw new Error("job missing");
  return (JSON.parse(job.configSnapshot) as Record<string, unknown>).allocation;
}

async function runOne(ctx: ReturnType<typeof setup>, requestKey: string): Promise<string> {
  const sessionId = createSession(ctx.orm, "辅助分配", { modelName: MODEL }).id;
  const turnId = completedTurn(ctx.orm, sessionId, requestKey);
  const job = immediate(ctx.db, () =>
    enqueue(ctx.orm, AGENT_ID, requestKey, { kind: "manual", sessionId, turnIds: [turnId] }),
  );
  await ctx.service.runJob(job.id);
  return job.id;
}

describe("auxiliary allocation: memory_consolidate role", () => {
  it("freezes the profile at enqueue and sends output_reserved as maxTokens on both calls", async () => {
    const ctx = setup();
    try {
      setAgentAuxProfile(ctx.orm, { mode: "fixed", output_reserved: 999 });
      const jobId = await runOne(ctx, "aux-tokens");
      const frozen = snapshotAllocation(ctx.orm, jobId);
      // Frozen at enqueue, not read live: the snapshot must carry the profile.
      expect(frozen).toEqual({ mode: "fixed", output_reserved: 999 });
      // With no blocked entries there is exactly one (consolidate) call.
      expect(ctx.gateway.calls.length).toBe(1);
      expect(ctx.gateway.calls[0]?.maxTokens).toBe(999);
      expect(ctx.gateway.calls[0]?.model).toBe(MODEL);
    } finally {
      ctx.business.close();
    }
  });

  it("applies the profile output cap to suppression calls too", async () => {
    const ctx = setup();
    try {
      setAgentAuxProfile(ctx.orm, { mode: "fixed", output_reserved: 777 });
      const sessionId = createSession(ctx.orm, "辅助抑制", { modelName: MODEL }).id;
      const turnId = completedTurn(ctx.orm, sessionId, "seed");
      // Suppression compares only governed rows (suppressed/replaced) — seed a
      // suppressed entry so the blocked list is non-empty and the verdict call runs.
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
            body: "完全不同的旧记忆正文",
            status: "suppressed",
            scope: "reality_user",
            scopeKey: AGENT_ID,
            configSnapshot: "{}",
            createdAt: "now",
          } satisfies typeof schema.memoryEntries.$inferInsert)
          .run();
      });
      const job = immediate(ctx.db, () =>
        enqueue(ctx.orm, AGENT_ID, "aux-suppression", {
          kind: "manual",
          sessionId,
          turnIds: [turnId],
        }),
      );
      ctx.gateway.calls = [];
      await ctx.service.runJob(job.id);
      // Explicit pre-conditions instead of guessing: the governed row is loaded
      // into the blocked comparison set, and the job outcome is visible.
      const governed = entries(ctx.orm, AGENT_ID).filter((entry) => entry.status === "suppressed");
      expect(governed.map((entry) => entry.body)).toEqual(["完全不同的旧记忆正文"]);
      const jobRow = ctx.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(jobRow?.status).toBe("succeeded");
      expect(jobRow?.errorCode).toBeNull();
      const consolidate = ctx.gateway.calls.find((call) =>
        JSON.stringify(call.responseSchema).includes("MemoryDraft"),
      );
      const suppression = ctx.gateway.calls.find((call) =>
        JSON.stringify(call.responseSchema).includes("blocked"),
      );
      expect(consolidate).toBeDefined();
      expect(suppression).toBeDefined();
      expect(consolidate?.maxTokens).toBe(777);
      expect(suppression?.maxTokens).toBe(777);
    } finally {
      ctx.business.close();
    }
  });

  it("gates a fixed input_limit before any model call and never truncates", async () => {
    const ctx = setup();
    try {
      setAgentAuxProfile(ctx.orm, { mode: "fixed", input_limit: 1 });
      const jobId = await runOne(ctx, "aux-gate");
      const job = ctx.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, jobId))
        .get();
      // The full request exceeds 1 estimated input unit: fail closed, no call.
      expect(job?.status).toBe("failed");
      expect(job?.errorCode).toBe("CONTEXT_AUX_BUDGET");
      expect(ctx.gateway.calls.length).toBe(0);
    } finally {
      ctx.business.close();
    }
  });

  it("keeps the exact old behavior when the profile is absent", async () => {
    const ctx = setup();
    try {
      const jobId = await runOne(ctx, "aux-absent");
      expect(snapshotAllocation(ctx.orm, jobId)).toBeUndefined();
      expect(ctx.gateway.calls.length).toBe(1);
      expect(ctx.gateway.calls[0]?.maxTokens).toBeUndefined();
      const job = ctx.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, jobId))
        .get();
      expect(job?.status).toBe("succeeded");
    } finally {
      ctx.business.close();
    }
  });
});

describe("auxiliary allocation: research role", () => {
  it("caps the child request input and generation output from the saved profile", async () => {
    // Deterministic counter: the same function the runtime uses for admission is
    // reused here, so the test derives the TRUE protocol cost from a probe run
    // instead of guessing a cap. No production budget is involved.
    const h = openBusinessDb();
    try {
      const counter = {
        encoding: "o200k_base" as const,
        count: (text: string) => new TextEncoder().encode(text).length,
      };
      const makeRuntime = (
        requests: { contextInputLimit?: number; maxTokens?: number; request: unknown }[],
        calls: { researchInvokes: number } = { researchInvokes: 0 },
      ) => {
        // Per-run counter: the parent invokes the research subtask exactly once,
        // then ends the run — the same protocol the old healthy research tests use.
        let parentRounds = 0;
        return new AgentRuntime({
          repository: new AgentRunRepository(h.db),
          researchEnabled: () => true,
          model: {
            async complete(request) {
              requests.push({
                contextInputLimit: request.contextInputLimit,
                maxTokens: request.maxTokens,
                request,
              });
              // The child run's system instructions are exact; the parent's system
              // prompt never carries them.
              const text = JSON.stringify(request.messages);
              if (text.includes("Research only the supplied question")) {
                return JSON.stringify({
                  kind: "final",
                  outputs: [{ kind: "generate", targetId: "research", instructions: "summarize" }],
                });
              }
              parentRounds += 1;
              if (parentRounds === 1) {
                calls.researchInvokes += 1;
                return JSON.stringify({
                  kind: "invoke",
                  calls: [{ name: "research.run", arguments: { question: "short question" } }],
                });
              }
              return '{"kind":"none"}';
            },
            async *streamText(request) {
              requests.push({
                contextInputLimit: request.contextInputLimit,
                maxTokens: request.maxTokens,
                request,
              });
              yield "conclusion";
            },
            async completeMultimodal() {
              return "unused";
            },
          },
        });
      };
      const runOnce = async (
        allocationInputLimit: number,
        parentInputUnits: number,
        requests: { contextInputLimit?: number; maxTokens?: number; request: unknown }[],
      ) => {
        const calls = { researchInvokes: 0 };
        const runtime = makeRuntime(requests, calls);
        const spec: AgentSpec = {
          id: `aux-research-${parentInputUnits}`,
          model: "fixture",
          context: "conversation",
          availableActions: [],
          limits: { steps: 8, inputUnits: parentInputUnits },
        };
        const result = await runtime.run(spec, {
          owner: { kind: "test", id: `aux-research-${parentInputUnits}` },
          authorizedTargets: ["reply"],
          outputMode: "buffered",
          actions: [],
          context: {
            researchAllocation: () => ({
              mode: "fixed" as const,
              input_limit: allocationInputLimit,
              output_reserved: 555,
            }),
            prepareModelContext: async () => ({
              model: "fixture",
              capacity: 131072,
              tokenizerEncoding: "o200k_base" as const,
              countText: counter.count,
              assertCurrent() {},
            }),
            read: async () => ({ pending: [textMessage("user", "parent input")] }),
          },
          async commitOutputs() {},
        });
        return { result, calls };
      };
      // Probe run: generous caps (child 16000 < parent 16384) used ONLY to measure
      // the REAL cost of every request — child decision, child generation, parent.
      const probeRequests: { contextInputLimit?: number; maxTokens?: number; request: unknown }[] =
        [];
      const probe = await runOnce(16000, 16384, probeRequests);
      expect(probe.result.status).toBe("no_output");
      expect(probe.calls.researchInvokes).toBe(1);
      const classify = (entry: { request: unknown }) => {
        const text = JSON.stringify(entry.request);
        if (text.includes("Research only the supplied question")) return "child" as const;
        if (text.includes("Write a concise research conclusion")) return "childGeneration" as const;
        return "parent" as const;
      };
      const measureOf = (entry: { request: unknown }): number => {
        const request = entry.request as {
          messages: Parameters<typeof measureContextTokens>[0];
          responseSchema?: Record<string, unknown>;
          tools?: Parameters<typeof measureContextTokens>[2] extends {
            tools?: infer T;
          }
            ? T
            : never;
        };
        return measureContextTokens(request.messages, counter, {
          responseSchema: request.responseSchema,
          tools: request.tools,
        }).textTokens;
      };
      const childMeasures = probeRequests.filter((entry) => classify(entry) !== "parent");
      expect(childMeasures.length).toBeGreaterThan(0);
      const parentMeasures = probeRequests.filter((entry) => classify(entry) === "parent");
      expect(parentMeasures.length).toBeGreaterThan(0);
      // The saved child cap covers the LARGEST child-side request (decision and
      // generation alike) plus margin; the parent cap covers the largest parent
      // request plus margin and always stays above the child cap. Derived, not
      // invented; no production budget involved.
      const childCap = Math.max(...childMeasures.map(measureOf)) + 100;
      const parentCap = Math.max(16384, childCap + 1000);
      expect(parentCap).toBeGreaterThan(childCap);
      const mainRequests: { contextInputLimit?: number; maxTokens?: number; request: unknown }[] =
        [];
      const main = await runOnce(childCap, parentCap, mainRequests);
      expect(main.result.status).toBe("no_output");
      expect(main.calls.researchInvokes).toBe(1);
      const child = mainRequests.filter((entry) => classify(entry) !== "parent");
      expect(child.length).toBeGreaterThan(0);
      // The saved cap is applied to every child-side request (decision + generation
      // leaves) and the parent cap is never widened.
      for (const entry of child) expect(entry.contextInputLimit).toBe(childCap);
      // Output override lands on the conclusion-generation leaf only.
      const conclusion = mainRequests.filter((entry) => entry.maxTokens === 555);
      expect(conclusion.length).toBe(1);
    } finally {
      h.close();
    }
  });

  it("keeps the child request unchanged when no profile exists", async () => {
    const h = openBusinessDb();
    try {
      const requests: { contextInputLimit?: number; maxTokens?: number; text: string }[] = [];
      let parentRounds = 0;
      const runtime = new AgentRuntime({
        repository: new AgentRunRepository(h.db),
        researchEnabled: () => true,
        model: {
          async complete(request) {
            const text = JSON.stringify(request.messages);
            requests.push({
              contextInputLimit: request.contextInputLimit,
              maxTokens: request.maxTokens,
              text,
            });
            if (text.includes("Research only the supplied question")) {
              return JSON.stringify({
                kind: "final",
                outputs: [{ kind: "generate", targetId: "research", instructions: "summarize" }],
              });
            }
            return ++parentRounds === 1
              ? JSON.stringify({
                  kind: "invoke",
                  calls: [{ name: "research.run", arguments: { question: "short question" } }],
                })
              : '{"kind":"none"}';
          },
          async *streamText(request) {
            requests.push({
              contextInputLimit: request.contextInputLimit,
              maxTokens: request.maxTokens,
              text: JSON.stringify(request.messages),
            });
            yield "conclusion";
          },
          async completeMultimodal() {
            return "unused";
          },
        },
      });
      const spec: AgentSpec = {
        id: "aux-research-absent",
        model: "fixture",
        context: "conversation",
        availableActions: [],
        limits: { steps: 8, inputUnits: 8192 },
      };
      const result = await runtime.run(spec, {
        owner: { kind: "test", id: "aux-research-absent" },
        authorizedTargets: ["reply"],
        outputMode: "buffered",
        actions: [],
        context: {
          read: async () => ({ pending: [textMessage("user", "parent input")] }),
        },
        async commitOutputs() {},
      });
      expect(result.status).toBe("no_output");
      const child = requests.filter((request) =>
        request.text.includes("Research only the supplied question"),
      );
      for (const request of child) expect(request.contextInputLimit).toBeUndefined();
      expect(requests.every((request) => request.maxTokens === undefined)).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe("auxiliary allocation: global roles", () => {
  it("knowledge_organize: fixed output_reserved replaces the capacity-derived formula", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, MODEL);
      updateOrganizationSettings(business.orm, {
        auxiliary_allocation: { knowledge_organize: { mode: "fixed", output_reserved: 1234 } },
        expected_revision: readOrganizationSettings(business.orm).revision,
      });
      const repo = new KnowledgeRepository(business.db);
      const output = JSON.stringify({ summary: "设备条件", tags: ["设备"], body: "阈值42.5。" });
      const calls: { maxTokens?: number }[] = [];
      const gateway: ModelGateway = {
        config: { baseUrl: "http://synthetic.invalid/v1", model: MODEL, timeoutSeconds: 1 },
        async listModels() {
          return [MODEL];
        },
        async loadedContextCapacity() {
          return 16000;
        },
        async probeModelLoaded() {
          return true;
        },
        async complete(options) {
          calls.push(options);
          return output;
        },
        async *streamChat() {
          yield "synthetic";
        },
      };
      const organizer = new KnowledgeOrganizer({ db: business.db, orm: business.orm, gateway });
      repo.importDocument({
        category_id: "default",
        name: "合成资料",
        original_text: "阈值42.5，例外仅限维护模式。",
      });
      expect(await organizer.runCycle()).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.maxTokens).toBe(1234);
      await organizer.stop();
    } finally {
      business.close();
    }
  });

  it("knowledge_organize: absent profile keeps the capacity-derived formula", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, MODEL);
      const repo = new KnowledgeRepository(business.db);
      const output = JSON.stringify({ summary: "设备条件", tags: ["设备"], body: "阈值42.5。" });
      const calls: { maxTokens?: number }[] = [];
      const gateway: ModelGateway = {
        config: { baseUrl: "http://synthetic.invalid/v1", model: MODEL, timeoutSeconds: 1 },
        async listModels() {
          return [MODEL];
        },
        async loadedContextCapacity() {
          return 16000;
        },
        async probeModelLoaded() {
          return true;
        },
        async complete(options) {
          calls.push(options);
          return output;
        },
        async *streamChat() {
          yield "synthetic";
        },
      };
      const organizer = new KnowledgeOrganizer({ db: business.db, gateway });
      repo.importDocument({
        category_id: "default",
        name: "合成资料",
        original_text: "阈值42.5，例外仅限维护模式。",
      });
      expect(await organizer.runCycle()).toBe(true);
      expect(calls).toHaveLength(1);
      // min(2048, floor(16000/4)) = 2048 — the old formula, verbatim.
      expect(calls[0]?.maxTokens).toBe(2048);
      await organizer.stop();
    } finally {
      business.close();
    }
  });

  it("qq_media_describe: fixed output_reserved reaches the vision request; absent does not", async () => {
    const png = new Uint8Array(encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8));
    const makeVision = () => {
      const calls: { maxTokens?: number }[] = [];
      return {
        calls,
        client: {
          annotate: async (request: { maxTokens?: number }) => {
            calls.push(request);
            return "一张合成图片";
          },
        },
      };
    };
    const bytesSource = {
      bytes: png,
    };
    // Fixed profile: the saved reserve is the hard max_tokens on the wire.
    const fixed = makeVision();
    const fixedRuntime = createEphemeralAgentRuntime({ vision: fixed.client });
    try {
      const adapter = createQqMediaAdapter({
        fetchSource: async () => bytesSource,
        agentRuntime: fixedRuntime,
        prompt: "如实说明这条消息里的媒体内容。",
        auxiliary_allocation: { mode: "fixed", output_reserved: 800 },
      });
      expect(
        await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local", bytes: png }),
      ).toBe("一张合成图片");
      expect(fixed.calls).toHaveLength(1);
      expect(fixed.calls[0]?.maxTokens).toBe(800);
    } finally {
      fixedRuntime.close();
    }
    // Absent profile: no output cap is sent (old behavior).
    const absent = makeVision();
    const absentRuntime = createEphemeralAgentRuntime({ vision: absent.client });
    try {
      const adapter = createQqMediaAdapter({
        fetchSource: async () => bytesSource,
        agentRuntime: absentRuntime,
        prompt: "如实说明这条消息里的媒体内容。",
      });
      expect(
        await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local", bytes: png }),
      ).toBe("一张合成图片");
      expect(absent.calls).toHaveLength(1);
      expect(absent.calls[0]?.maxTokens).toBeUndefined();
    } finally {
      absentRuntime.close();
    }
    // Auto with a known capacity and no declared encoding: gated by the same
    // conservative estimator against the real capacity — the call proceeds.
    const autoKnown = makeVision();
    const autoKnownRuntime = createEphemeralAgentRuntime({ vision: autoKnown.client });
    try {
      const adapter = createQqMediaAdapter({
        fetchSource: async () => bytesSource,
        agentRuntime: autoKnownRuntime,
        prompt: "如实说明这条消息里的媒体内容。",
        auxiliary_allocation: { mode: "auto" },
        loadedContextCapacity: async () => 32768,
      });
      expect(
        await adapter.read({
          kind: "image",
          sourceRef: "ref",
          model: "vision-local",
          bytes: png,
        }),
      ).toBe("一张合成图片");
      expect(autoKnown.calls).toHaveLength(1);
      expect(autoKnown.calls[0]?.maxTokens).toBeUndefined();
    } finally {
      autoKnownRuntime.close();
    }
    // Auto without a capacity source fails closed instead of faking an ungated auto.
    const auto = makeVision();
    const autoRuntime = createEphemeralAgentRuntime({ vision: auto.client });
    try {
      const adapter = createQqMediaAdapter({
        fetchSource: async () => bytesSource,
        agentRuntime: autoRuntime,
        prompt: "如实说明这条消息里的媒体内容。",
        auxiliary_allocation: { mode: "auto" },
      });
      await expect(
        adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local", bytes: png }),
      ).rejects.toThrow("CONTEXT_CAPACITY_UNKNOWN");
      expect(auto.calls).toHaveLength(0);
    } finally {
      autoRuntime.close();
    }
  });
});
