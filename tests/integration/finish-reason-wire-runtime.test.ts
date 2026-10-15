import { afterEach, expect, test } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
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
function setup(handler: (body: Record<string, unknown>) => Response) {
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
  const runtime = new AgentRuntime({ repository, model: createModelPort({ gateway }) });
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
