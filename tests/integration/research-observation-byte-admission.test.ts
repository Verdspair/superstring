import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { ActionContext, BuiltInAction } from "../../src/server/agent/built-in-actions";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelContextBudget, ModelRequest } from "../../src/server/agent/model-port";
import { createResearchAction } from "../../src/server/agent/research-action";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  type ContextTokenMeasureOptions,
  measureContextBytes,
  measureContextTokens,
} from "../../src/server/llm/request-format";
import { AGENT_DECISION_JSON_SCHEMA } from "../../src/shared/contracts/agent-output";
import type { AuxiliaryAllocationProfile } from "../../src/shared/contracts/context-allocation";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const encoding = "o200k_base" as const;

/** Synthetic declared counter: 1 token per code point. For CJK text, 3 UTF-8 bytes per token. */
const countTokens = (text: string): number => [...text].length;

const ResearchResultValueSchema = z.object({
  status: z.string(),
  conclusion: z.string().optional(),
  runId: z.string().optional(),
});
type ResearchResultValue = z.infer<typeof ResearchResultValueSchema>;

const parseResearchValue = (value: unknown): ResearchResultValue =>
  ResearchResultValueSchema.parse(value);

/** Tool payload shape inside action_observation envelope. */
const ToolPayloadSchema = z.object({
  status: z.string(),
  text: z.string().optional(),
  code: z.string().optional(),
});
type ToolPayload = z.infer<typeof ToolPayloadSchema>;

const ActionObservationEnvelopeSchema = z.object({
  kind: z.literal("action_observation"),
  value: z.object({
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    value: ToolPayloadSchema,
    sources: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
});

const extractObservationPayloads = (req: ModelRequest): ToolPayload[] =>
  req.messages
    .flatMap((m) => m.content)
    .filter((part) => part.kind === "text")
    .flatMap((part) => {
      try {
        const parsed = ActionObservationEnvelopeSchema.safeParse(JSON.parse(part.text));
        return parsed.success ? [parsed.data.value.value] : [];
      } catch {
        return [];
      }
    });

const measureOptions = (req: ModelRequest): ContextTokenMeasureOptions => ({
  responseSchema: req.responseSchema ?? AGENT_DECISION_JSON_SCHEMA,
  tools: req.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })),
});

const byteCostOf = (req: ModelRequest): number =>
  measureContextBytes(req.messages, measureOptions(req));

const tokenCostOf = (req: ModelRequest): number =>
  measureContextTokens(req.messages, { encoding, count: countTokens }, measureOptions(req))
    .textTokens;

const ref = { kind: "test_source", id: "authorized_evidence", revision: "one" };

interface HarnessOptions {
  toolValue?: unknown;
  toolValues?: readonly unknown[];
  callsCount?: 1 | 2;
  modelName?: string;
  allocation?: AuxiliaryAllocationProfile;
  prepareModelContext?: (
    model: string,
    signal: AbortSignal,
  ) => Promise<ModelContextBudget | undefined>;
}

function setupMultiStepResearchHarness(options: HarnessOptions) {
  const h = openBusinessDb();
  handles.push(h);
  const requests: ModelRequest[] = [];
  const modelName = options.modelName ?? "chat-research-model";
  const callsCount = options.callsCount ?? 1;
  let childStep = 0;
  let toolExecutions = 0;

  const action: BuiltInAction = {
    description: {
      name: "web.read",
      capability: "web",
      description: "read remote text",
      effect: "read",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
    async execute() {
      const idx = toolExecutions++;
      const val = options.toolValues
        ? (options.toolValues[idx] ?? options.toolValue)
        : options.toolValue;
      return { value: val, sources: [ref] };
    },
    fitResult(value, sources, arguments_, context) {
      if (!context.fitReadResult) throw new Error("missing child admission");
      return context.fitReadResult("web.read", arguments_, value, sources);
    },
  };

  const runtime = new AgentRuntime({
    repository: new AgentRunRepository(h.db),
    researchEnabled: () => true,
    model: {
      async complete(request) {
        requests.push(request);
        childStep += 1;
        if (childStep === 1) {
          if (callsCount === 2) {
            return JSON.stringify({
              kind: "invoke",
              calls: [
                { name: "web.read", arguments: { query: "first query" } },
                { name: "web.read", arguments: { query: "second query" } },
              ],
            });
          }
          return JSON.stringify({
            kind: "invoke",
            calls: [{ name: "web.read", arguments: { query: "target query" } }],
          });
        }
        return JSON.stringify({
          kind: "final",
          outputs: [{ kind: "inline", targetId: "research", text: "research conclusion" }],
        });
      },
      async *streamText() {
        yield "research conclusion text";
      },
      async completeMultimodal() {
        return "";
      },
    },
  });

  const parentSpec: AgentSpec = {
    id: "parent-agent",
    model: modelName,
    maxTokens: 4096,
    context: "conversation",
    availableActions: [action.description],
    limits: { steps: 8, inputUnits: 16384 },
  };

  const parentInput = {
    owner: { kind: "test" as const, id: "research-obs-byte-domain" },
    conversationId: "test-conv-obs-1",
    authorizedTargets: ["research"],
    outputMode: "buffered" as const,
    actions: [action],
    context: {
      prepareModelContext: options.prepareModelContext,
      researchAllocation: () => options.allocation,
      read: async () => ({ pending: [textMessage("user", "parent prompt")] }),
    },
    async commitOutputs() {
      return undefined;
    },
  };

  const executor = new ActionExecutor();

  const researchAction = createResearchAction({
    runtime,
    executor,
    spec: parentSpec,
    input: parentInput,
    actions: [action],
    allocation: options.allocation,
  });

  const actionContext: ActionContext = {
    owner: { kind: "test", id: "research-obs-byte-domain" },
    signal: new AbortController().signal,
    sources: [],
  };

  const execute = (question: string) => researchAction.execute({ question }, actionContext);

  return { runtime, execute, requests, action, toolExecutions: () => toolExecutions };
}

describe("research subtask observation byte admission boundaries", () => {
  it(
    "tool returns large result whose tokens fit but whole bytes exceed inputBytes: " +
      "admits bounded unavailable observation into second step, completing successfully without wire crash",
    async () => {
      // 600 CJK characters: 600 tokens in declared counter, but 1800 UTF-8 bytes.
      const fullText = "分".repeat(600);
      const question = "查询分布式一致性协议机制";

      // 1. Calibration run with generous unconstrained limit to measure full requests
      const probe = setupMultiStepResearchHarness({
        toolValue: { status: "ok", text: fullText },
        prepareModelContext: async (model) =>
          Object.freeze({
            model,
            capacity: 100_000,
            tokenizerEncoding: encoding,
            countText: countTokens,
            assertCurrent() {},
          }),
      });

      const probeResult = await probe.execute(question);
      expect(parseResearchValue(probeResult.value).status).toBe("ok");
      expect(probe.requests.length).toBe(2);

      const step2ProbeReq = probe.requests[1];
      if (!step2ProbeReq) throw new Error("step 2 probe request missing");

      const byteWithFull = byteCostOf(step2ProbeReq);
      const tokenWithFull = tokenCostOf(step2ProbeReq);

      // CJK text ensures full request byte cost strictly exceeds token count
      expect(byteWithFull).toBeGreaterThan(tokenWithFull);

      // Calculate the size if the tool returned the bounded refusal instead of full text
      const refusalProbe = setupMultiStepResearchHarness({
        toolValue: { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" },
        prepareModelContext: async (model) =>
          Object.freeze({
            model,
            capacity: 100_000,
            tokenizerEncoding: encoding,
            countText: countTokens,
            assertCurrent() {},
          }),
      });
      await refusalProbe.execute(question);
      expect(refusalProbe.requests.length).toBe(2);
      const step2RefusalReq = refusalProbe.requests[1];
      if (!step2RefusalReq) throw new Error("step 2 refusal request missing");
      const byteWithRefusal = byteCostOf(step2RefusalReq);

      // Choose input_limit strictly between byteWithRefusal and byteWithFull,
      // and ensure tokenWithFull fits well within inputUnits (16384).
      const byteLimit = Math.floor((byteWithRefusal + byteWithFull) / 2);
      expect(byteLimit).toBeGreaterThan(byteWithRefusal);
      expect(byteLimit).toBeLessThan(byteWithFull);
      expect(tokenWithFull).toBeLessThan(16384);

      // 2. Real test: with allocation.input_limit = byteLimit.
      // - Candidate full text tokens fit inputUnits (16384).
      // - Candidate full text bytes (> byteLimit) exceed inputBytes.
      // - Bounded refusal bytes (< byteLimit) fit inputBytes.
      // fitReadResult MUST reject fullText and admit unavailable observation,
      // allowing child step 2 to complete without crashing on the byte gate.
      const targetHarness = setupMultiStepResearchHarness({
        toolValue: { status: "ok", text: fullText },
        allocation: {
          mode: "fixed",
          input_limit: byteLimit,
          output_reserved: 300,
        },
        prepareModelContext: async (model) =>
          Object.freeze({
            model,
            capacity: 100_000,
            tokenizerEncoding: encoding,
            countText: countTokens,
            assertCurrent() {},
          }),
      });

      const result = await targetHarness.execute(question);
      const parsed = parseResearchValue(result.value);

      // Child run must complete successfully rather than crashing on step 2 byte gate
      expect(parsed.status).toBe("ok");
      expect(targetHarness.requests.length).toBe(2);

      // Extract observations delivered to step 2
      const step2Req = targetHarness.requests[1];
      if (!step2Req) throw new Error("step 2 request missing");
      const payloads = extractObservationPayloads(step2Req);

      expect(payloads.length).toBe(1);
      // The observation must be the bounded refusal, NOT the oversized full text
      expect(payloads[0]).toEqual({
        status: "unavailable",
        code: "CONTEXT_BUDGET_EXCEEDED",
      });
      expect(JSON.stringify(step2Req.messages)).not.toContain(fullText);
    },
  );

  it(
    "tool returns short result whose bytes and tokens both fit within inputBytes: " +
      "admits ok observation and delivers full text into step 2",
    async () => {
      const shortText = "短证据数据";
      const question = "简短查询";

      const harness = setupMultiStepResearchHarness({
        toolValue: { status: "ok", text: shortText },
        allocation: {
          mode: "fixed",
          input_limit: 50_000,
          output_reserved: 300,
        },
        prepareModelContext: async (model) =>
          Object.freeze({
            model,
            capacity: 100_000,
            tokenizerEncoding: encoding,
            countText: countTokens,
            assertCurrent() {},
          }),
      });

      const result = await harness.execute(question);
      const parsed = parseResearchValue(result.value);
      expect(parsed.status).toBe("ok");
      expect(harness.requests.length).toBe(2);

      const step2Req = harness.requests[1];
      if (!step2Req) throw new Error("step 2 request missing");
      const payloads = extractObservationPayloads(step2Req);

      expect(payloads.length).toBe(1);
      expect(payloads[0]).toEqual({ status: "ok", text: shortText });
      expect(JSON.stringify(step2Req.messages)).toContain(shortText);
    },
  );

  it("no-counter environment: large tool result exceeding inputBytes is refused and bounded unavailable is admitted", async () => {
    // 400 CJK characters: 1200 UTF-8 bytes
    const longText = "概".repeat(400);
    const question = "无计数器环境长查询";

    // 1. Calibration run without declared counter (prepareModelContext: undefined)
    const probe = setupMultiStepResearchHarness({
      toolValue: { status: "ok", text: longText },
      prepareModelContext: undefined,
    });
    await probe.execute(question);
    expect(probe.requests.length).toBe(2);
    const step2ProbeReq = probe.requests[1];
    if (!step2ProbeReq) throw new Error("step 2 probe request missing");
    const byteWithLong = byteCostOf(step2ProbeReq);

    // Refusal calibration without counter
    const refusalProbe = setupMultiStepResearchHarness({
      toolValue: { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" },
      prepareModelContext: undefined,
    });
    await refusalProbe.execute(question);
    expect(refusalProbe.requests.length).toBe(2);
    const step2RefusalReq = refusalProbe.requests[1];
    if (!step2RefusalReq) throw new Error("step 2 refusal request missing");
    const byteWithRefusal = byteCostOf(step2RefusalReq);

    // Calibrate byteLimit strictly between refusal and full text
    const byteLimit = Math.floor((byteWithRefusal + byteWithLong) / 2);
    expect(byteLimit).toBeGreaterThan(byteWithRefusal);
    expect(byteLimit).toBeLessThan(byteWithLong);

    // 2. Target run: without counter, the new inputBytes gate must still refuse longText and admit refusal
    const target = setupMultiStepResearchHarness({
      toolValue: { status: "ok", text: longText },
      allocation: {
        mode: "fixed",
        input_limit: byteLimit,
        output_reserved: 300,
      },
      prepareModelContext: undefined,
    });

    const result = await target.execute(question);
    const parsed = parseResearchValue(result.value);
    expect(parsed.status).toBe("ok");
    expect(target.requests.length).toBe(2);

    const step2Req = target.requests[1];
    if (!step2Req) throw new Error("step 2 request missing");
    const payloads = extractObservationPayloads(step2Req);
    expect(payloads.length).toBe(1);
    expect(payloads[0]).toEqual({
      status: "unavailable",
      code: "CONTEXT_BUDGET_EXCEEDED",
    });
    expect(JSON.stringify(target.requests[1].messages)).not.toContain(longText);
  });

  it(
    "joint reservation: two concurrent read-only observations each fit inputBytes alone but jointly exceed it, " +
      "ensuring at most one full text is admitted and the second is bounded refusal, with whole wire request fitting byteCap",
    async () => {
      // 250 CJK characters: 750 UTF-8 bytes for each result
      const fullText = "项".repeat(250);
      const question = "并发两项只读查询";

      // 1. Calibration run: 2 calls returning full text with generous cap
      const bothProbe = setupMultiStepResearchHarness({
        callsCount: 2,
        toolValue: { status: "ok", text: fullText },
        prepareModelContext: async (model) =>
          Object.freeze({
            model,
            capacity: 100_000,
            tokenizerEncoding: encoding,
            countText: countTokens,
            assertCurrent() {},
          }),
      });
      await bothProbe.execute(question);
      expect(bothProbe.requests.length).toBe(2);
      expect(bothProbe.toolExecutions()).toBe(2);
      const step2BothReq = bothProbe.requests[1];
      if (!step2BothReq) throw new Error("step 2 both request missing");
      const byteWithBoth = byteCostOf(step2BothReq);

      // 2. Calibration run: 1 call returning full text, 1 call returning refusal
      const singleProbe = setupMultiStepResearchHarness({
        callsCount: 2,
        toolValues: [
          { status: "ok", text: fullText },
          { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" },
        ],
        prepareModelContext: async (model) =>
          Object.freeze({
            model,
            capacity: 100_000,
            tokenizerEncoding: encoding,
            countText: countTokens,
            assertCurrent() {},
          }),
      });
      await singleProbe.execute(question);
      expect(singleProbe.requests.length).toBe(2);
      expect(singleProbe.toolExecutions()).toBe(2);
      const step2SingleReq = singleProbe.requests[1];
      if (!step2SingleReq) throw new Error("step 2 single request missing");
      const byteWithSingleAndRefusal = byteCostOf(step2SingleReq);

      // Choose byteLimit strictly between (1 full + 1 refusal) and (2 full).
      // Each full text alone fits in byteLimit, but both together strictly exceed it.
      const byteLimit = Math.floor((byteWithSingleAndRefusal + byteWithBoth) / 2);
      expect(byteLimit).toBeGreaterThan(byteWithSingleAndRefusal);
      expect(byteLimit).toBeLessThan(byteWithBoth);

      // 3. Real test: both calls return fullText, but allocation.input_limit = byteLimit.
      // - First call admits fullText and reserves its delta in the "bytes" group.
      // - Second call tests fullText, exceeds byteLimit when combined with the first delta -> refuses.
      // - Second call falls back to refusal, which fits within the remaining byte limit.
      const targetHarness = setupMultiStepResearchHarness({
        callsCount: 2,
        toolValue: { status: "ok", text: fullText },
        allocation: {
          mode: "fixed",
          input_limit: byteLimit,
          output_reserved: 300,
        },
        prepareModelContext: async (model) =>
          Object.freeze({
            model,
            capacity: 100_000,
            tokenizerEncoding: encoding,
            countText: countTokens,
            assertCurrent() {},
          }),
      });

      const result = await targetHarness.execute(question);
      const parsed = parseResearchValue(result.value);

      expect(parsed.status).toBe("ok");
      expect(targetHarness.requests.length).toBe(2);
      // Each tool executed exactly once, no replay
      expect(targetHarness.toolExecutions()).toBe(2);

      const step2Req = targetHarness.requests[1];
      if (!step2Req) throw new Error("step 2 request missing");
      const payloads = extractObservationPayloads(step2Req);

      expect(payloads.length).toBe(2);
      // Exactly one observation must be full text, and exactly one must be bounded refusal
      const okPayloads = payloads.filter((p) => p.status === "ok");
      const unavailPayloads = payloads.filter((p) => p.status === "unavailable");

      expect(okPayloads.length).toBe(1);
      expect(okPayloads[0]?.text).toBe(fullText);
      expect(unavailPayloads.length).toBe(1);
      expect(unavailPayloads[0]).toEqual({
        status: "unavailable",
        code: "CONTEXT_BUDGET_EXCEEDED",
      });

      // The whole second next wire request must strictly fit within byteLimit
      const actualStep2Bytes = byteCostOf(step2Req);
      expect(actualStep2Bytes).toBeLessThanOrEqual(byteLimit);
    },
  );

  it("legacy environment without declared counter operates using standard byte estimates", async () => {
    const shortText = "legacy data";
    const harness = setupMultiStepResearchHarness({
      toolValue: { status: "ok", text: shortText },
      allocation: {
        mode: "fixed",
        input_limit: 50_000,
        output_reserved: 300,
      },
      prepareModelContext: undefined,
    });

    const result = await harness.execute("legacy query");
    const parsed = parseResearchValue(result.value);
    expect(parsed.status).toBe("ok");
    expect(harness.requests.length).toBe(2);
  });
});
