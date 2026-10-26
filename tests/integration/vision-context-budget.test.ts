import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  readQqBinding,
  writeQqGroupAgentConfigRow,
} from "../../src/server/db/qq-binding-repository";
import { DEFAULT_USER_ID } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { measureContextTokens } from "../../src/server/llm/request-format";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";
import { createLmStudioVisionClient, type VisionRequest } from "../../src/server/llm/vision-client";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { checkQqModelCapacity } from "../../src/server/services/qq-capacity-preflight";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  closeHarnesses();
  for (const handle of handles.splice(0)) handle.close();
});
const config = {
  baseUrl: "http://unused.invalid/v1",
  model: "synthetic-vision",
  timeoutSeconds: 5,
};
const image = { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
const schema = {
  type: "object",
  properties: { description: { type: "string" } },
  required: ["description"],
  additionalProperties: false,
};
const format = {
  type: "json_schema",
  json_schema: { name: "superstring_result", strict: true, schema },
};
type BudgetRequest = VisionRequest & {
  contextBudget?: ModelContextBudget;
  contextInputLimit?: number;
  assertPreparedCurrent?: (input: { model: string }) => void;
};
const response = () =>
  new Response(
    JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
    { status: 200 },
  );
const fakeFetch = (
  handler: (input: unknown, init?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: () => {} });

async function descriptor(assertCurrent = () => {}) {
  const counter = await loadTextTokenCounter("cl100k_base");
  return {
    model: "synthetic-vision",
    capacity: 65536,
    tokenizerEncoding: counter.encoding,
    countText: counter.count,
    assertCurrent,
  } satisfies ModelContextBudget;
}

function inputCost(budget: ModelContextBudget, prompt: string, systemPrompt?: string) {
  if (!budget.countText || !budget.tokenizerEncoding) throw new Error("counter missing");
  return measureContextTokens(
    [
      ...(systemPrompt === undefined ? [] : [textMessage("system", systemPrompt)]),
      textMessage("user", prompt),
    ],
    { encoding: budget.tokenizerEncoding, count: budget.countText },
    { responseFormat: format },
  ).textTokens;
}

describe("vision actual-send budget guards", () => {
  it("counts the complete system, prompt and response format before any HTTP send", async () => {
    const budget = await descriptor();
    const prompt = "A short prompt";
    const systemPrompt = "Preserve the actual request schema.";
    const limit = inputCost(budget, prompt, systemPrompt) - 1;
    let sends = 0;
    const client = createLmStudioVisionClient(
      config,
      fakeFetch(async () => {
        sends++;
        return response();
      }),
    );
    const request: BudgetRequest = {
      model: budget.model,
      systemPrompt,
      prompt,
      images: [image],
      responseSchema: schema,
      contextBudget: budget,
      contextInputLimit: limit,
    };
    await expect(client.annotate(request)).rejects.toMatchObject({
      code: "CONTEXT_BUDGET_EXCEEDED",
    });
    expect(sends).toBe(0);
  });

  it("admits declared-counter text at its exact ceiling without token-counting image base64", async () => {
    const real = await descriptor();
    const counted: string[] = [];
    const budget = {
      ...real,
      countText(text: string) {
        counted.push(text);
        return real.countText(text);
      },
    };
    const prompt = "合格的完整中文上下文".repeat(30);
    const limit = inputCost(real, prompt);
    const bodies: Record<string, unknown>[] = [];
    const client = createLmStudioVisionClient(
      config,
      fakeFetch(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response();
      }),
    );
    const request: BudgetRequest = {
      model: budget.model,
      prompt,
      images: [{ ...image, bytes: new Uint8Array(65536).fill(137) }],
      responseSchema: schema,
      contextBudget: budget,
      contextInputLimit: limit,
    };
    await expect(client.annotate(request)).resolves.toBe("ok");
    expect(bodies).toHaveLength(1);
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.every((text) => !text.includes("data:image") && !text.includes("base64"))).toBe(
      true,
    );
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(limit);
  });

  it("rechecks the frozen route before a user retry instead of sending with an expired descriptor", async () => {
    let current = true;
    const reason = new Error("synthetic route revision changed");
    const budget = await descriptor(() => {
      if (!current) throw reason;
    });
    let sends = 0;
    const client = createLmStudioVisionClient(
      config,
      fakeFetch(async () => {
        sends++;
        current = false;
        return sends === 1 ? new Response("overloaded", { status: 429 }) : response();
      }),
    );
    const request: BudgetRequest = {
      model: budget.model,
      prompt: "p",
      images: [image],
      contextBudget: budget,
      contextInputLimit: 4096,
      retryPolicy: { maxAttempts: 2, retryDelayMs: 1 },
    };
    await expect(client.annotate(request)).rejects.toBe(reason);
    expect(sends).toBe(1);
  });

  it("rechecks sources before schema fallback and does not turn a guard failure into a new HTTP attempt", async () => {
    const budget = await descriptor();
    let current = true;
    const reason = new Error("synthetic image source revoked");
    let sends = 0;
    const client = createLmStudioVisionClient(
      config,
      fakeFetch(async () => {
        sends++;
        current = false;
        return sends === 1
          ? new Response("unsupported response_format", { status: 400 })
          : response();
      }),
    );
    const request: BudgetRequest = {
      model: budget.model,
      prompt: "p",
      images: [image],
      responseSchema: { ...schema, title: "source-guard-fallback" },
      contextBudget: budget,
      contextInputLimit: 4096,
      assertPreparedCurrent() {
        if (!current) throw reason;
      },
    };
    await expect(client.annotate(request)).rejects.toBe(reason);
    expect(sends).toBe(1);
  });

  it("preserves caller cancellation before sending", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic cancelled vision");
    controller.abort(reason);
    let sends = 0;
    const budget = await descriptor();
    const client = createLmStudioVisionClient(
      config,
      fakeFetch(async () => {
        sends++;
        return response();
      }),
    );
    const request: BudgetRequest = {
      model: budget.model,
      prompt: "p",
      images: [image],
      signal: controller.signal,
      contextBudget: budget,
      contextInputLimit: 4096,
    };
    await expect(client.annotate(request)).rejects.toBe(reason);
    expect(sends).toBe(0);
  });

  it("keeps the old optional-field-free request working without a counter", async () => {
    let sends = 0;
    const client = createLmStudioVisionClient(
      config,
      fakeFetch(async () => {
        sends++;
        return response();
      }),
    );
    await expect(
      client.annotate({ model: "synthetic-legacy-vision", prompt: "p", images: [image] }),
    ).resolves.toBe("ok");
    expect(sends).toBe(1);
  });
});

describe("runtime and ModelPort vision budget propagation", () => {
  it("passes the original descriptor, ceiling and source guard to the existing vision client", async () => {
    const h = openBusinessDb({ path: ":memory:" });
    handles.push(h);
    const budget = await descriptor();
    let seen: BudgetRequest | undefined;
    let proofs = 0;
    const runtime = createAgentRuntime({
      repository: new AgentRunRepository(h.db),
      vision: {
        async annotate(request) {
          seen = request;
          return "ok";
        },
      },
    });
    await expect(
      runtime.completeVisionLeaf(
        { id: "test.vision.budget", maxTokens: 128 },
        {
          model: budget.model,
          prompt: "p",
          images: [image],
          owner: { kind: "synthetic", id: "vision-owner" },
          contextBudget: budget,
          contextInputLimit: 4096,
          assertSources() {
            proofs++;
          },
        },
      ),
    ).resolves.toBe("ok");
    if (!seen) throw new Error("vision request missing");
    expect(seen.contextBudget).toBe(budget);
    expect(seen.contextInputLimit).toBe(4096);
    if (!seen.assertPreparedCurrent) throw new Error("vision source guard missing");
    const before = proofs;
    seen.assertPreparedCurrent({ model: budget.model });
    expect(proofs).toBeGreaterThan(before);
  });
});

it("rejects a restored group capability epoch before a schema fallback can send again", async () => {
  const h = createOneBotHarness();
  const binding = readQqBinding(h.orm, h.bindingId);
  if (!binding) throw new Error("synthetic binding missing");
  const guard = new QqGroupCapabilityGuard(h.orm);
  let sends = 0;
  const vision = createLmStudioVisionClient(
    { ...config, baseUrl: "http://epoch-fixture.invalid/v1" },
    fakeFetch(async () => {
      sends++;
      if (sends === 1) {
        writeQqGroupAgentConfigRow(h.orm, {
          bindingId: binding.id,
          agentId: binding.agentId,
          overrides: {},
          disabledCapabilities: ["media"],
          expectedRevision: 0,
        });
        writeQqGroupAgentConfigRow(h.orm, {
          bindingId: binding.id,
          agentId: binding.agentId,
          overrides: {},
          disabledCapabilities: [],
          expectedRevision: 1,
        });
        return new Response("unsupported response_format", { status: 400 });
      }
      return response();
    }),
  );
  const runtime = createAgentRuntime({
    repository: new AgentRunRepository(h.db),
    vision,
    assertLeaf: (owner, specId) => guard.assertLeaf(owner, specId),
  });
  await expect(
    runtime.completeVisionLeaf(
      {
        id: "media.describe",
        responseSchema: { ...schema, title: "epoch-fallback" },
        maxTokens: 128,
      },
      {
        model: "epoch-vision",
        prompt: "p",
        images: [image],
        owner: {
          kind: "qq_binding",
          id: binding.id,
          agentId: binding.agentId,
          userId: DEFAULT_USER_ID,
        },
      },
    ),
  ).rejects.toMatchObject({ code: "QQ_GROUP_CAPABILITY_DISABLED" });
  expect(sends).toBe(1);
});

it("keeps zero and large role output reservations within actual capacity checks", async () => {
  const messages = [{ role: "user", content: "p" }];
  const gateway = { loadedContextCapacity: async () => 200000 };
  await expect(
    checkQqModelCapacity(gateway, { model: "v", messages, outputReserved: 0 }),
  ).resolves.toMatchObject({ kind: "allowed" });
  await expect(
    checkQqModelCapacity(gateway, { model: "v", messages, outputReserved: 100000 }),
  ).resolves.toMatchObject({ kind: "allowed" });
  await expect(
    checkQqModelCapacity(
      { loadedContextCapacity: async () => 99999 },
      { model: "v", messages, outputReserved: 100000 },
    ),
  ).resolves.toEqual({ kind: "exceeded" });
  await expect(
    checkQqModelCapacity(
      { loadedContextCapacity: async () => null },
      { model: "v", messages, outputReserved: 0 },
    ),
  ).resolves.toEqual({ kind: "unavailable" });
});
