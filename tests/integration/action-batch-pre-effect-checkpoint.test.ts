import { afterEach, describe, expect, it } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { ActionContext, BuiltInAction } from "../../src/server/agent/built-in-actions";
import {
  type ActionObservation,
  type ConversationContextSource,
  textMessage,
} from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { RunEvent } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";

describe("ActionExecutor and AgentRuntime pre-effect checkpoint tests", () => {
  const handles: ReturnType<typeof openBusinessDb>[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.close();
  });

  const baseOwner = { kind: "test_job" as const, id: "job-pre-effect", userId: "u", agentId: "a" };
  const baseContext: ActionContext = {
    owner: baseOwner,
    signal: new AbortController().signal,
  };

  function createReadAction(
    name: string,
    options: {
      onExecute?: () => void;
      fitValue?: (val: unknown) => unknown;
      sources?: readonly SourceRef[];
    } = {},
  ): BuiltInAction {
    return {
      description: {
        name,
        capability: "test.read",
        description: `Read action ${name}`,
        parameters: { type: "object", properties: { q: { type: "string" } } },
        effect: "read",
      },
      async fitResult(val) {
        return options.fitValue ? options.fitValue(val) : val;
      },
      async execute(args) {
        options.onExecute?.();
        return {
          value: { raw: args, readAt: name },
          sources: options.sources ?? [{ kind: "test", id: name, revision: "1" }],
        };
      },
    };
  }

  function createWriteAction(
    name: string,
    options: {
      onExecute?: () => void;
      sources?: readonly SourceRef[];
    } = {},
  ): BuiltInAction {
    return {
      description: {
        name,
        capability: "test.write",
        description: `Write action ${name}`,
        parameters: { type: "object", properties: { text: { type: "string" } } },
        effect: "write",
      },
      async execute(args) {
        options.onExecute?.();
        return {
          value: { written: args },
          sources: options.sources ?? [{ kind: "test", id: name, revision: "1" }],
        };
      },
    };
  }

  it("1. beforeEffects receives completed and fitted reads in original index order before first write", async () => {
    const timeline: string[] = [];
    let writesCalled = 0;

    const read0 = createReadAction("query.alpha", {
      onExecute: () => timeline.push("execute:read0"),
      fitValue: (val) => {
        timeline.push("fit:read0");
        return { ...(val as Record<string, unknown>), fitted: true };
      },
      sources: [{ kind: "test", id: "alpha-source", revision: "1" }],
    });

    const write1 = createWriteAction("save.record", {
      onExecute: () => {
        timeline.push("execute:write1");
        writesCalled++;
      },
    });

    const read2 = createReadAction("query.beta", {
      onExecute: () => timeline.push("execute:read2"),
      fitValue: (val) => {
        timeline.push("fit:read2");
        return { ...(val as Record<string, unknown>), fitted: true };
      },
      sources: [{ kind: "test", id: "beta-source", revision: "1" }],
    });

    const executor = new ActionExecutor();
    let beforeEffectsCalls = 0;
    let receivedReads: readonly {
      index: number;
      result: Omit<ActionObservation, "id" | "name">;
    }[] = [];

    const calls = [
      { action: read0, arguments: { q: "alpha" } },
      { action: write1, arguments: { text: "write-data" } },
      { action: read2, arguments: { q: "beta" } },
    ];

    const results = await executor.executeBatch(calls, baseContext, {
      beforeEffects: async (reads) => {
        beforeEffectsCalls++;
        timeline.push("checkpoint:beforeEffects");
        receivedReads = reads;
        expect(writesCalled).toBe(0);
      },
    });

    expect(beforeEffectsCalls).toBe(1);
    expect(writesCalled).toBe(1);

    // Causal timeline assertions: reads are concurrent, each execute precedes own fit, all fits precede barrier, barrier precedes write
    expect(timeline).toContain("execute:read0");
    expect(timeline).toContain("fit:read0");
    expect(timeline).toContain("execute:read2");
    expect(timeline).toContain("fit:read2");
    expect(timeline).toContain("checkpoint:beforeEffects");
    expect(timeline).toContain("execute:write1");
    expect(timeline).toHaveLength(6);

    expect(timeline.indexOf("execute:read0")).toBeLessThan(timeline.indexOf("fit:read0"));
    expect(timeline.indexOf("execute:read2")).toBeLessThan(timeline.indexOf("fit:read2"));
    expect(timeline.indexOf("fit:read0")).toBeLessThan(
      timeline.indexOf("checkpoint:beforeEffects"),
    );
    expect(timeline.indexOf("fit:read2")).toBeLessThan(
      timeline.indexOf("checkpoint:beforeEffects"),
    );
    expect(timeline.indexOf("checkpoint:beforeEffects")).toBeLessThan(
      timeline.indexOf("execute:write1"),
    );

    expect(receivedReads).toHaveLength(2);
    expect(receivedReads[0].index).toBe(0);
    expect(receivedReads[0].result.value).toEqual({
      raw: { q: "alpha" },
      readAt: "query.alpha",
      fitted: true,
    });
    expect(receivedReads[0].result.sources).toEqual([
      { kind: "test", id: "alpha-source", revision: "1" },
    ]);

    expect(receivedReads[1].index).toBe(2);
    expect(receivedReads[1].result.value).toEqual({
      raw: { q: "beta" },
      readAt: "query.beta",
      fitted: true,
    });
    expect(receivedReads[1].result.sources).toEqual([
      { kind: "test", id: "beta-source", revision: "1" },
    ]);

    expect(results).toHaveLength(3);
    expect(results[1].value).toEqual({ written: { text: "write-data" } });
  });

  it("2. throw, abort, or current revocation at barrier ensures write 0 and reads each 1 without replay", async () => {
    const executor = new ActionExecutor();

    // 2a. Barrier throws error
    let readCountA = 0;
    let writeCountA = 0;
    const readA = createReadAction("readA", { onExecute: () => readCountA++ });
    const writeA = createWriteAction("writeA", { onExecute: () => writeCountA++ });

    await expect(
      executor.executeBatch(
        [
          { action: readA, arguments: {} },
          { action: writeA, arguments: {} },
        ],
        baseContext,
        {
          beforeEffects: async () => {
            throw new Error("PRE_EFFECT_BARRIER_OVERCAP");
          },
        },
      ),
    ).rejects.toThrow("PRE_EFFECT_BARRIER_OVERCAP");

    expect(readCountA).toBe(1);
    expect(writeCountA).toBe(0);

    // 2b. AbortController aborted during barrier
    let readCountB = 0;
    let writeCountB = 0;
    const controllerB = new AbortController();
    const readB = createReadAction("readB", { onExecute: () => readCountB++ });
    const writeB = createWriteAction("writeB", { onExecute: () => writeCountB++ });

    await expect(
      executor.executeBatch(
        [
          { action: readB, arguments: {} },
          { action: writeB, arguments: {} },
        ],
        { ...baseContext, signal: controllerB.signal },
        {
          beforeEffects: async () => {
            controllerB.abort(new Error("BARRIER_ABORTED"));
          },
        },
      ),
    ).rejects.toThrow("BARRIER_ABORTED");

    expect(readCountB).toBe(1);
    expect(writeCountB).toBe(0);

    // 2c. Current revoked (assertCurrent throws)
    let readCountC = 0;
    let writeCountC = 0;
    let currentValid = true;
    const readC = createReadAction("readC", { onExecute: () => readCountC++ });
    const writeC = createWriteAction("writeC", { onExecute: () => writeCountC++ });

    await expect(
      executor.executeBatch(
        [
          { action: readC, arguments: {} },
          { action: writeC, arguments: {} },
        ],
        baseContext,
        {
          assertCurrent: () => {
            if (!currentValid) throw new Error("CONTEXT_REVOKED");
          },
          beforeEffects: async () => {
            currentValid = false;
          },
        },
      ),
    ).rejects.toThrow("CONTEXT_REVOKED");

    expect(readCountC).toBe(1);
    expect(writeCountC).toBe(0);
  });

  it("3. normal small mixed batch preserves read concurrency and sequential write order", async () => {
    let readBatchFunctionCalls = 0;
    const executor = new ActionExecutor(undefined, () => {
      readBatchFunctionCalls++;
      return 2;
    });

    const executionOrder: string[] = [];
    const read1 = createReadAction("read1", { onExecute: () => executionOrder.push("read1") });
    const write2 = createWriteAction("write2", { onExecute: () => executionOrder.push("write2") });
    const read3 = createReadAction("read3", { onExecute: () => executionOrder.push("read3") });
    const write4 = createWriteAction("write4", { onExecute: () => executionOrder.push("write4") });

    let beforeEffectsCalled = 0;
    const results = await executor.executeBatch(
      [
        { action: read1, arguments: { id: 1 } },
        { action: write2, arguments: { id: 2 } },
        { action: read3, arguments: { id: 3 } },
        { action: write4, arguments: { id: 4 } },
      ],
      baseContext,
      {
        beforeEffects: async (reads) => {
          beforeEffectsCalled++;
          expect(reads.map((r) => r.index)).toEqual([0, 2]);
          expect(executionOrder.filter((item) => item.startsWith("write"))).toHaveLength(0);
        },
      },
    );

    expect(beforeEffectsCalled).toBe(1);
    expect(readBatchFunctionCalls).toBeGreaterThanOrEqual(1);
    expect(executionOrder).toEqual(["read1", "read3", "write2", "write4"]);
    expect(results).toHaveLength(4);
    expect(results[0].value).toMatchObject({ raw: { id: 1 } });
    expect(results[1].value).toMatchObject({ written: { id: 2 } });
    expect(results[2].value).toMatchObject({ raw: { id: 3 } });
    expect(results[3].value).toMatchObject({ written: { id: 4 } });
  });

  it("4. read-only batch skips beforeEffects hook and missing hook preserves legacy execution", async () => {
    const executor = new ActionExecutor();

    // 4a. Read-only batch: beforeEffects hook is never invoked
    let beforeEffectsInvoked = 0;
    const readA = createReadAction("readOnlyA");
    const readB = createReadAction("readOnlyB");

    const readOnlyResults = await executor.executeBatch(
      [
        { action: readA, arguments: { x: 1 } },
        { action: readB, arguments: { x: 2 } },
      ],
      baseContext,
      {
        beforeEffects: async () => {
          beforeEffectsInvoked++;
        },
      },
    );

    expect(beforeEffectsInvoked).toBe(0);
    expect(readOnlyResults).toHaveLength(2);

    // 4b. Mixed batch without beforeEffects option: legacy execution succeeds
    const legacyOrder: string[] = [];
    const readLegacy = createReadAction("readLegacy", {
      onExecute: () => legacyOrder.push("read"),
    });
    const writeLegacy = createWriteAction("writeLegacy", {
      onExecute: () => legacyOrder.push("write"),
    });

    const mixedResults = await executor.executeBatch(
      [
        { action: readLegacy, arguments: {} },
        { action: writeLegacy, arguments: {} },
      ],
      baseContext,
    );

    expect(legacyOrder).toEqual(["read", "write"]);
    expect(mixedResults).toHaveLength(2);
  });

  it("5. real AgentRuntime passes prior plus settled read observations with matching id/name/args/value/sources and appends exactly once", async () => {
    const h = openBusinessDb();
    handles.push(h);
    const repository = new AgentRunRepository(h.db);

    const stepCalls: ModelRequest[] = [];
    const port: ModelPort = {
      async complete(request) {
        stepCalls.push(request);
        if (stepCalls.length === 1) {
          // Step 1: initial read action to establish prior observation
          return JSON.stringify({
            kind: "invoke",
            calls: [{ name: "action.read", arguments: { query: "prior-query" } }],
          });
        }
        if (stepCalls.length === 2) {
          // Step 2: mixed batch with a read and a write
          return JSON.stringify({
            kind: "invoke",
            calls: [
              { name: "action.read", arguments: { query: "batch-read-query" } },
              { name: "action.write", arguments: { text: "batch-write-payload" } },
            ],
          });
        }
        // Step 3: finish run
        return JSON.stringify({ kind: "none" });
      },
      async *streamText() {
        yield "";
      },
      async completeMultimodal() {
        return "";
      },
    };

    const runtime = new AgentRuntime({ model: port, repository });

    const actionRead = createReadAction("action.read", {
      sources: [{ kind: "test", id: "read-source-ref", revision: "1" }],
    });
    const actionWrite = createWriteAction("action.write");

    const spec: AgentSpec = {
      id: "test-pre-effect-spec",
      model: "chat",
      instructions: "Pre-effect barrier validation agent",
      context: "conversation",
      availableActions: [actionRead.description, actionWrite.description],
      limits: { steps: 8 },
    };

    let hookCallCount = 0;
    let hookReceivedObservations: readonly ActionObservation[] = [];
    let hookReceivedEffects: readonly { name: string; arguments: Record<string, unknown> }[] = [];

    const contextSource: ConversationContextSource = {
      async read() {
        return { pending: [textMessage("user", "Start run")] };
      },
      async assertBeforeActionEffects(input) {
        hookCallCount++;
        hookReceivedObservations = [...input.observations];
        hookReceivedEffects = [...input.effects];
        expect(input.signal.aborted).toBe(false);
      },
    };

    const recordedEvents: RunEvent[] = [];
    const result = await runtime.run(spec, {
      owner: baseOwner,
      authorizedTargets: ["web"],
      outputMode: "buffered",
      actions: [actionRead, actionWrite],
      context: contextSource,
      onEvent(event) {
        recordedEvents.push(event);
      },
    });

    expect(result.status).toBe("no_output");
    expect(stepCalls).toHaveLength(3);

    // assertBeforeActionEffects was called during step 2 (the mixed batch)
    expect(hookCallCount).toBe(1);

    // Effects received: only the write action
    expect(hookReceivedEffects).toEqual([
      { name: "action.write", arguments: { text: "batch-write-payload" } },
    ]);

    // Observations received in hook: prior observation (from step 1) + current settled read observation
    expect(hookReceivedObservations).toHaveLength(2);

    const priorObs = hookReceivedObservations[0];
    expect(priorObs.name).toBe("action.read");
    expect(priorObs.arguments).toEqual({ query: "prior-query" });
    expect(priorObs.value).toMatchObject({ raw: { query: "prior-query" } });
    expect(priorObs.sources).toEqual([{ kind: "test", id: "read-source-ref", revision: "1" }]);
    expect(priorObs.id).toBeDefined();

    const batchReadObs = hookReceivedObservations[1];
    expect(batchReadObs.name).toBe("action.read");
    expect(batchReadObs.arguments).toEqual({ query: "batch-read-query" });
    expect(batchReadObs.value).toMatchObject({ raw: { query: "batch-read-query" } });
    expect(batchReadObs.sources).toEqual([{ kind: "test", id: "read-source-ref", revision: "1" }]);
    expect(batchReadObs.id).toBeDefined();

    // Verify action_result events emitted by Runtime
    const actionResultEvents = recordedEvents.filter((e) => e.type === "action_result") as Extract<
      RunEvent,
      { type: "action_result" }
    >[];

    // Total action results: 1 from step 1, 2 from step 2 = 3 total, each appended exactly once
    expect(actionResultEvents).toHaveLength(3);

    // Check observation IDs in emitted events:
    // Event 0 matches priorObs.id
    expect(actionResultEvents[0].name).toBe("action.read");
    expect(actionResultEvents[0].observationId).toBe(priorObs.id);

    // Event 1 matches batchReadObs.id (the exact same UUID created in beforeEffects projection!)
    expect(actionResultEvents[1].name).toBe("action.read");
    expect(actionResultEvents[1].observationId).toBe(batchReadObs.id);

    // Event 2 is the write action result
    expect(actionResultEvents[2].name).toBe("action.write");
    expect(actionResultEvents[2].observationId).toBeDefined();

    // Ensure all 3 observation IDs are distinct (no duplicate IDs)
    const observationIds = actionResultEvents.map((e) => e.observationId);
    expect(new Set(observationIds).size).toBe(3);

    // Check step 3 request messages: observations are rendered into context without duplication
    const step3Messages = stepCalls[2].messages;
    const actionObsMessages = step3Messages.filter(
      (m) => m.role === "user" && JSON.stringify(m).includes("action_observation"),
    );
    // 3 action observations rendered in context, each exactly once
    expect(actionObsMessages).toHaveLength(3);
  });
});
