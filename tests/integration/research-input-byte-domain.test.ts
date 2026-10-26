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

/** Public shape of research subtask result value parsed without `as any`. */
const ResearchResultValueSchema = z.object({
  status: z.string(),
  conclusion: z.string().optional(),
  runId: z.string().optional(),
});
type ResearchResultValue = z.infer<typeof ResearchResultValueSchema>;

const parseResearchValue = (value: unknown): ResearchResultValue =>
  ResearchResultValueSchema.parse(value);

const measureOptions = (req: ModelRequest): ContextTokenMeasureOptions => ({
  responseSchema: req.responseSchema ?? AGENT_DECISION_JSON_SCHEMA,
  tools: req.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })),
});

/** Whole-request byte cost measured via shared measureContextBytes actual projection. */
const byteCostOf = (req: ModelRequest): number =>
  measureContextBytes(req.messages, measureOptions(req));

/** Whole-request token cost measured with the declared tokenizer counter. */
const tokenCostOf = (req: ModelRequest): number =>
  measureContextTokens(req.messages, { encoding, count: countTokens }, measureOptions(req))
    .textTokens;

interface HarnessOptions {
  modelName?: string;
  parentInputBytes?: number;
  parentMaxTokens?: number;
  allocation?: AuxiliaryAllocationProfile;
  prepareModelContext?: (
    model: string,
    signal: AbortSignal,
  ) => Promise<ModelContextBudget | undefined>;
}

function setupChildResearchHarness(options: HarnessOptions = {}) {
  const h = openBusinessDb();
  handles.push(h);
  const requests: ModelRequest[] = [];
  const modelName = options.modelName ?? "chat-research-model";
  const parentMaxTokens = options.parentMaxTokens ?? 4096;

  const actions: BuiltInAction[] = ["read"].map((effect) => ({
    description: {
      name: effect,
      capability: effect,
      description: effect,
      effect: effect as "read",
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      return { value: "evidence", sources: [] };
    },
  }));

  const runtime = new AgentRuntime({
    repository: new AgentRunRepository(h.db),
    researchEnabled: () => true,
    model: {
      async complete(request) {
        requests.push(request);
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
    maxTokens: parentMaxTokens,
    context: "conversation",
    availableActions: actions.map((a) => a.description),
    limits: {
      steps: 8,
      outputTokens: parentMaxTokens,
      ...(options.parentInputBytes !== undefined ? { inputBytes: options.parentInputBytes } : {}),
    },
  };

  const parentInput = {
    owner: { kind: "test" as const, id: "research-byte-domain" },
    conversationId: "test-conv-1",
    authorizedTargets: ["research"],
    outputMode: "buffered" as const,
    actions,
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
    actions,
    allocation: options.allocation,
  });

  const actionContext: ActionContext = {
    owner: { kind: "test", id: "research-byte-domain" },
    signal: new AbortController().signal,
    sources: [],
  };

  const execute = (question: string, contextOverride?: Partial<ActionContext>) =>
    researchAction.execute({ question }, { ...actionContext, ...contextOverride });

  return { runtime, execute, requests, actions };
}

describe("research input byte domain and capacity boundaries", () => {
  it(
    "auto mode with explicit input_limit still checks physical descriptor capacity before child wire: " +
      "capacity minus output_reserved < 1 refuses without issuing child model call",
    async () => {
      let prepareCalls = 0;
      let preparedModel: string | undefined;

      // Auto mode: explicit input_limit 100,000, output_reserved 256.
      // Physical capacity is only 100, so physical room = 100 - 256 = -156 < 1.
      // Must refuse before sending any child wire model request.
      const tinyCapacityHarness = setupChildResearchHarness({
        allocation: {
          mode: "auto",
          input_limit: 100_000,
          output_reserved: 256,
        },
        prepareModelContext: async (model) => {
          prepareCalls++;
          preparedModel = model;
          return Object.freeze({
            model,
            capacity: 100,
            tokenizerEncoding: encoding,
            countText: countTokens,
            assertCurrent() {},
          });
        },
      });

      let thrownError: unknown;
      let executionResult: Awaited<ReturnType<typeof tinyCapacityHarness.execute>> | undefined;
      try {
        executionResult = await tinyCapacityHarness.execute("check physical capacity");
      } catch (err) {
        thrownError = err;
      }

      // Prepare hook must have been called for the child model
      expect(prepareCalls).toBeGreaterThan(0);
      expect(preparedModel).toBe("chat-research-model");

      // Physical room < 1 must refuse without executing child wire request
      expect(tinyCapacityHarness.requests.length).toBe(0);

      // Must refuse either via rejection or via unavailable/non-ok result status
      if (thrownError) {
        expect(thrownError).toMatchObject({
          code: expect.stringMatching(/CONTEXT_AUX_BUDGET|CONTEXT_CAPACITY_UNKNOWN/),
        });
      } else if (executionResult) {
        const parsed = parseResearchValue(executionResult.value);
        expect(parsed.status).not.toBe("ok");
      } else {
        throw new Error("expected tiny physical capacity to refuse via throw or non-ok status");
      }
    },
  );

  it(
    "enforces explicit fixed input_limit as an independent byte hard cap: CJK request exceeding byte limit " +
      "rejects even when declared counter tokens fit, while short question within byte limit succeeds",
    async () => {
      const longCjkQuestion =
        "深入分析分布式一致性协议与高可用架构在极端网络分区下的数据正确性保证机制。".repeat(15);
      const shortQuestion = "简短提问";

      // Calibration step: measure full unconstrained child decision request with no allocation profile
      const probe = setupChildResearchHarness({});
      await probe.execute(longCjkQuestion);
      expect(probe.requests.length).toBe(1);
      const capturedLong = probe.requests[0];
      if (!capturedLong) throw new Error("captured long child request missing");

      const longByteCost = byteCostOf(capturedLong);
      const longTokenCost = tokenCostOf(capturedLong);

      // CJK characters (3 bytes/char) cause byte cost to strictly exceed token count (1 token/code point)
      expect(longByteCost).toBeGreaterThan(longTokenCost);

      // Select byte_limit strictly between tokenCost and byteCost: tokenCost < byteLimit < byteCost
      const byteLimit = Math.floor((longTokenCost + longByteCost) / 2);
      expect(byteLimit).toBeGreaterThan(longTokenCost);
      expect(byteLimit).toBeLessThan(longByteCost);

      // Verify positive control feasibility: short question whole-protocol byte cost strictly fits byteLimit
      const shortProbe = setupChildResearchHarness({});
      await shortProbe.execute(shortQuestion);
      expect(shortProbe.requests.length).toBe(1);
      const capturedShort = shortProbe.requests[0];
      if (!capturedShort) throw new Error("captured short child request missing");
      const shortByteCost = byteCostOf(capturedShort);
      expect(shortByteCost).toBeLessThanOrEqual(byteLimit);

      // Positive control: short question within byteLimit succeeds and produces conclusion
      const underCapHarness = setupChildResearchHarness({
        allocation: {
          mode: "fixed",
          input_limit: byteLimit,
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
      const positiveResult = await underCapHarness.execute(shortQuestion);
      const positiveValue = parseResearchValue(positiveResult.value);
      expect(positiveValue.status).toBe("ok");
      expect(positiveValue.conclusion).toBe("research conclusion");
      expect(underCapHarness.requests.length).toBe(1);

      // Negative test: long CJK question exceeds byteLimit (independent byte cap must refuse before wire)
      const overCapHarness = setupChildResearchHarness({
        allocation: {
          mode: "fixed",
          input_limit: byteLimit,
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

      let overCapError: unknown;
      let overCapResult: Awaited<ReturnType<typeof overCapHarness.execute>> | undefined;
      try {
        overCapResult = await overCapHarness.execute(longCjkQuestion);
      } catch (err) {
        overCapError = err;
      }

      // Over byte cap must refuse without executing child wire request
      expect(overCapHarness.requests.length).toBe(0);

      if (overCapError) {
        expect(overCapError).toMatchObject({
          code: expect.stringMatching(/CONTEXT_AUX_BUDGET|AGENT_CONTEXT_LIMIT/),
        });
      } else if (overCapResult) {
        const parsed = parseResearchValue(overCapResult.value);
        expect(parsed.status).not.toBe("ok");
      } else {
        throw new Error("expected over-cap CJK request to refuse via throw or non-ok status");
      }
    },
  );

  it("preserves legacy wire shape and behavior for absent profile and fixed mode without prepare hook (controls)", async () => {
    // Control A: absent allocation profile preserves parent inheritance (maxTokens 4096), no inputCap
    const absentHarness = setupChildResearchHarness({});
    const absentResult = await absentHarness.execute("absent profile query");
    const absentValue = parseResearchValue(absentResult.value);
    expect(absentValue.status).toBe("ok");
    expect(absentHarness.requests.length).toBe(1);
    const absentCall = absentHarness.requests[0];
    expect(absentCall?.maxTokens).toBe(4096);
    expect(absentCall?.contextBudget).toBeUndefined();

    // Control B: fixed mode without prepare hook succeeds using explicit input_limit and output_reserved
    const fixedNoPrepareHarness = setupChildResearchHarness({
      allocation: {
        mode: "fixed",
        input_limit: 50_000,
        output_reserved: 300,
      },
      prepareModelContext: undefined,
    });
    const fixedResult = await fixedNoPrepareHarness.execute("fixed mode query");
    const fixedValue = parseResearchValue(fixedResult.value);
    expect(fixedValue.status).toBe("ok");
    expect(fixedNoPrepareHarness.requests.length).toBe(1);
    const fixedCall = fixedNoPrepareHarness.requests[0];
    expect(fixedCall?.maxTokens).toBe(300);
    expect(fixedCall?.contextBudget).toBeUndefined();
  });

  it("parent limits.inputBytes narrower than child allocation.input_limit must not be widened by child", async () => {
    // Parent specifies a narrow byte cap (250 bytes), while child profile has generous 50,000 bytes.
    // The child must never widen the parent's byte ceiling.
    const narrowParentHarness = setupChildResearchHarness({
      parentInputBytes: 250,
      allocation: {
        mode: "fixed",
        input_limit: 50_000,
        output_reserved: 300,
      },
    });

    let narrowError: unknown;
    let narrowResult: Awaited<ReturnType<typeof narrowParentHarness.execute>> | undefined;
    try {
      narrowResult = await narrowParentHarness.execute(
        "short question exceeding 250 byte protocol",
      );
    } catch (err) {
      narrowError = err;
    }

    // Must refuse on the parent's narrower byte cap without sending child wire request
    expect(narrowParentHarness.requests.length).toBe(0);
    if (narrowError) {
      expect(narrowError).toMatchObject({
        code: expect.stringMatching(/CONTEXT_AUX_BUDGET|AGENT_CONTEXT_LIMIT/),
      });
    } else if (narrowResult) {
      const parsed = parseResearchValue(narrowResult.value);
      expect(parsed.status).not.toBe("ok");
    } else {
      throw new Error("expected narrow parent byte cap to refuse via throw or non-ok status");
    }
  });

  it("auto mode with absent output_reserved inherits parent maxTokens and checks capacity against actual own model", async () => {
    let requestedModel: string | undefined;

    // Parent has maxTokens 4096 and model 'child-target-model'.
    // Child profile specifies auto mode without output_reserved.
    // Physical descriptor capacity is 2000 tokens (less than parent maxTokens 4096).
    // The capacity check must inherit parent maxTokens (4096) rather than subtracting 0,
    // so 2000 - 4096 = -2096 < 1 must refuse before child wire.
    const autoInheritOutputHarness = setupChildResearchHarness({
      modelName: "child-target-model",
      parentMaxTokens: 4096,
      allocation: {
        mode: "auto",
      },
      prepareModelContext: async (model) => {
        requestedModel = model;
        return Object.freeze({
          model,
          capacity: 2000,
          tokenizerEncoding: encoding,
          countText: countTokens,
          assertCurrent() {},
        });
      },
    });

    let inheritError: unknown;
    let inheritResult: Awaited<ReturnType<typeof autoInheritOutputHarness.execute>> | undefined;
    try {
      inheritResult = await autoInheritOutputHarness.execute("check output inheritance");
    } catch (err) {
      inheritError = err;
    }

    // Verifies that the physical descriptor is queried for the child's own model
    expect(requestedModel).toBe("child-target-model");

    // Inherited parent outputTokens (4096) exceeds physical capacity (2000), must refuse without child wire
    expect(autoInheritOutputHarness.requests.length).toBe(0);
    if (inheritError) {
      expect(inheritError).toMatchObject({
        code: expect.stringMatching(
          /CONTEXT_AUX_BUDGET|CONTEXT_CAPACITY_UNKNOWN|AGENT_CONTEXT_LIMIT/,
        ),
      });
    } else if (inheritResult) {
      const parsed = parseResearchValue(inheritResult.value);
      expect(parsed.status).not.toBe("ok");
    } else {
      throw new Error("expected insufficient capacity for inherited outputTokens to refuse");
    }
  });
});
