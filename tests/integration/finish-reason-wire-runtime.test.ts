import { afterEach, expect, test } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { inspectContext } from "../../src/server/agent/context-access";
import { textMessage } from "../../src/server/agent/context-engine";
import { createModelPort } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { DEFAULT_USER_ID } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
const owner = { kind: "test", id: "wire-finish", userId: DEFAULT_USER_ID };
function setup(
  handler: (body: Record<string, unknown>) => Response,
  actions: BuiltInAction[] = [],
) {
  const sent: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ data: [] });
      const body = (await request.json()) as Record<string, unknown>;
      sent.push(body);
      return handler(body);
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;
  const gateway = createLmStudioClient(
    { baseUrl, model: "fixture", timeoutSeconds: 5 },
    {
      externalModel: () => ({ baseUrl, apiKey: null, contextWindow: 8192, providerRevision: 1 }),
    },
  );
  const h = openBusinessDb();
  const repository = new AgentRunRepository(h.db);
  const runtime = new AgentRuntime({ repository, model: createModelPort({ gateway }), actions });
  cleanups.push(() => {
    server.stop(true);
    h.close();
  });
  return { h, repository, runtime, sent };
}
function resultOf(f: ReturnType<typeof setup>, phase: "leaf" | "next" | "generate") {
  const run = f.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
  if (!run) throw new Error("run missing");
  const step = run.steps.find((candidate) => candidate.phase === phase);
  if (!step) throw new Error("step missing");
  return {
    run,
    step,
    context: inspectContext(
      f.h.db,
      f.repository,
      { runId: run.runId, stepId: step.stepId },
      { userId: DEFAULT_USER_ID },
    ),
  };
}

test("valid decision JSON with a rejected finish survives the actual wire, failed step and inspection", async () => {
  const text = JSON.stringify({
    kind: "invoke",
    calls: [{ name: "media.list", arguments: { limit: 10 } }],
  });
  const f = setup(() =>
    Response.json({ choices: [{ finish_reason: "vendor_terminal", message: { content: text } }] }),
  );
  await expect(
    f.runtime.run(
      {
        id: "wire-decision",
        model: "fixture",
        context: "conversation",
        availableActions: [],
        limits: { steps: 3 },
      },
      {
        owner,
        authorizedTargets: [],
        outputMode: "buffered",
        context: { read: async () => ({ pending: [textMessage("user", "synthetic input")] }) },
      },
    ),
  ).rejects.toMatchObject({ code: "MODEL_FINISH_UNSUPPORTED" });
  const { run, step, context } = resultOf(f, "next");
  expect(run.status).toBe("failed");
  expect(step.errorCode).toBe("MODEL_FINISH_UNSUPPORTED");
  expect(context?.result).toEqual({
    status: "partial",
    text,
    format: "json",
    responses: [{ transport: "complete", httpStatus: 200, finishReasons: ["vendor_terminal"] }],
  });
  expect(f.repository.listEvents(run.runId).some((event) => event.type === "action_result")).toBe(
    false,
  );
  expect(f.sent).toHaveLength(1);
});

test("a stream that reports its finish after the last delta retains it when generation fails", async () => {
  const f = setup((body) =>
    body.stream
      ? new Response(
          [
            'data: {"choices":[{"delta":{"content":"partial body"},"finish_reason":null}]}',
            'data: {"choices":[{"finish_reason":"content_filter"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        )
      : Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  kind: "final",
                  outputs: [{ kind: "generate", targetId: "reply", instructions: "fixture" }],
                }),
              },
            },
          ],
        }),
  );
  await expect(
    f.runtime.run(
      {
        id: "wire-stream",
        model: "fixture",
        context: "conversation",
        availableActions: [],
        limits: { steps: 3 },
      },
      {
        owner,
        authorizedTargets: ["reply"],
        outputMode: "buffered",
        context: { read: async () => ({ pending: [textMessage("user", "synthetic input")] }) },
      },
    ),
  ).rejects.toMatchObject({ code: "AGENT_OUTPUT_FAILED" });
  const { step, context } = resultOf(f, "generate");
  expect(step.status).toBe("failed");
  expect(context?.result).toEqual({
    status: "partial",
    text: "partial body",
    format: "text",
    responses: [
      {
        transport: "stream",
        httpStatus: 200,
        finishReasons: [null, "content_filter"],
        doneMarker: true,
      },
    ],
  });
  expect(f.sent).toHaveLength(2);
});

test("a bodyless HTTP error retains response metadata without fabricating text", async () => {
  const f = setup(() => new Response("synthetic rejection", { status: 503 }));
  await expect(
    f.runtime.completeLeaf(
      { id: "wire-leaf", model: "fixture" },
      { owner, messages: [{ role: "user", content: "fixture" }] },
    ),
  ).rejects.toBeInstanceOf(Error);
  const { context } = resultOf(f, "leaf");
  expect(context?.result).toEqual({
    status: "unavailable",
    reason: "no_response",
    responses: [{ transport: "complete", httpStatus: 503, finishReasons: [] }],
  });
  expect(f.sent).toHaveLength(1);
});

const recoverySpec = {
  id: "finish-recovery",
  model: "fixture",
  context: "conversation" as const,
  availableActions: [],
  limits: { steps: 6 },
};
const recoveryContext = {
  read: async () => ({ pending: [textMessage("user", "synthetic input")] }),
};
function terminal(reason: string, content = '{"kind":"none"}') {
  return Response.json({ choices: [{ finish_reason: reason, message: { content } }] });
}

test("a malformed function finish uses the host correction once and preserves the failed attempt", async () => {
  let attempts = 0;
  const feedback = { count: 0 };
  const f = setup(() => terminal(++attempts === 1 ? "malformed_function_call" : "stop"));
  const result = await f.runtime.run(recoverySpec, {
    owner,
    authorizedTargets: [],
    outputMode: "buffered",
    context: recoveryContext,
    onDecisionInvalid: async () => {
      feedback.count += 1;
      return true;
    },
  });
  expect(result.status).toBe("no_output");
  expect(f.sent).toHaveLength(2);
  expect(feedback.count).toBe(1);
  const run = f.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0]!;
  expect(run.steps.map((s) => s.status)).toEqual(["failed", "completed"]);
  expect(run.steps[0]!.errorCode).toBe("MODEL_FINISH_UNSUPPORTED");
  const context = inspectContext(
    f.h.db,
    f.repository,
    { runId: run.runId, stepId: run.steps[0]!.stepId },
    { userId: DEFAULT_USER_ID },
  );
  expect(context?.result.responses?.[0]?.finishReasons).toEqual(["malformed_function_call"]);
});

test("repeated malformed function finishes cannot create an unbounded recovery loop", async () => {
  const correction = { count: 0 };
  const f = setup(() => terminal("malformed_function_call"));
  await expect(
    f.runtime.run(recoverySpec, {
      owner,
      authorizedTargets: [],
      outputMode: "buffered",
      context: recoveryContext,
      onDecisionInvalid: async () => {
        correction.count += 1;
        return true;
      },
    }),
  ).rejects.toMatchObject({ code: "MODEL_FINISH_UNSUPPORTED" });
  expect(f.sent).toHaveLength(2);
  expect(correction.count).toBe(1);
});

test.each(["content_filter", "vendor_terminal", "length"])(
  "does not recover a %s finish as a malformed function",
  async (reason) => {
    const correction = { count: 0 };
    const f = setup(() => terminal(reason));
    await expect(
      f.runtime.run(recoverySpec, {
        owner,
        authorizedTargets: [],
        outputMode: "buffered",
        context: recoveryContext,
        onDecisionInvalid: async () => {
          correction.count += 1;
          return true;
        },
      }),
    ).rejects.toMatchObject({
      code: reason === "length" ? "MODEL_OUTPUT_LIMIT" : "MODEL_FINISH_UNSUPPORTED",
    });
    expect(f.sent).toHaveLength(1);
    expect(correction.count).toBe(0);
  },
);

test.each(["no-host", "terminal", "cancelled", "budget"])(
  "does not send a correction when %s blocks it",
  async (block) => {
    const controller = new AbortController();
    const cancelled = new Error("synthetic cancellation");
    const f = setup(() => terminal("malformed_function_call"));
    await expect(
      f.runtime.run(recoverySpec, {
        owner,
        authorizedTargets: [],
        outputMode: "buffered",
        context: recoveryContext,
        signal: controller.signal,
        ...(block === "terminal" ? { isTerminalDecision: () => true } : {}),
        ...(block === "budget" ? { budget: { maxCalls: 1 } } : {}),
        ...(block === "no-host"
          ? {}
          : {
              onDecisionInvalid: async () => {
                if (block === "cancelled") controller.abort(cancelled);
                return true;
              },
            }),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(f.sent).toHaveLength(1);
  },
);

test("a malformed decision never replays a successful action or executes its rejected body", async () => {
  let actionCalls = 0;
  let requests = 0;
  const action: BuiltInAction = {
    description: {
      name: "fixture.read",
      description: "Read a synthetic value",
      capability: "fixture",
      effect: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    execute: async () => {
      actionCalls += 1;
      return { value: { value: "synthetic result" }, sources: [] };
    },
  };
  const invoke = JSON.stringify({
    kind: "invoke",
    calls: [{ name: "fixture.read", arguments: {} }],
  });
  const f = setup(() => {
    requests += 1;
    if (requests === 1) return terminal("stop", invoke);
    if (requests === 2) return terminal("malformed_function_call", invoke);
    return terminal("stop");
  }, [action]);
  const usage = { calls: 0, inputUnits: 0 };
  await f.runtime.run(
    { ...recoverySpec, availableActions: [action.description] },
    {
      owner,
      authorizedTargets: [],
      outputMode: "buffered",
      context: recoveryContext,
      usage,
      budget: { maxCalls: 3 },
      onDecisionInvalid: async () => true,
    },
  );
  expect(f.sent).toHaveLength(3);
  expect(usage.calls).toBe(3);
  expect(actionCalls).toBe(1);
  expect(JSON.stringify(f.sent[2]?.messages)).toContain("action_observation");
  const run = f.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0]!;
  expect(run.steps.map((s) => s.status)).toEqual(["completed", "failed", "completed"]);
});
