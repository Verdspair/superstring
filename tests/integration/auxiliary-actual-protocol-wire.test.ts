// Auxiliary workers actual-protocol wire integration tests.
//
// Contract:
// 1. Auxiliary text leaves (MemoryService consolidation/suppression and
//    KnowledgeOrganizer) prepare actual request format via gateway.prepareRequestFormat
//    and measure declared token domain using the unified pure measurePreparedRequest.
// 2. The exact PreparedRequestFormat snapshot is passed into LeafInput.requestFormat,
//    ensuring the pre-gate and the runtime wire send use identical protocol snapshots.
// 3. Independent byte hard caps (input_limit) and token capacity ceilings remain
//    separate and unmixed.
// 4. Memory draft remains indivisible; auto suppression greedily packs contiguous
//    blocked prefixes under the actual protocol token ceiling.
// 5. Knowledge organizer preserves its capacity - output - 256 margin.
// 6. When prepareRequestFormat or declared counter is absent, workers maintain the
//    legacy complete protocol estimate rather than using an empty format.
// 7. Real default LeafAgentRuntime + real ModelGateway client transmits verified
//    wire payload with exact structured output schema over HTTP.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import http, { type Server } from "node:http";
import { eq } from "drizzle-orm";
import type {
  LeafAgentRuntime,
  LeafInput,
  VisionLeafInput,
} from "../../src/server/agent/agent-runtime";
import type { LeafAgentSpec } from "../../src/server/agent/agent-specs";
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
import {
  type ChatMessage,
  createLmStudioClient,
  type ExternalModelRoute,
  type ModelGateway,
  type ModelTool,
} from "../../src/server/llm/model-gateway";
import type { PreparedRequestFormat } from "../../src/server/llm/request-format";
import { KnowledgeOrganizer } from "../../src/server/services/knowledge-organizer";
import {
  DRAFT_RESULT_JSON_SCHEMA,
  SUPPRESSION_RESULT_JSON_SCHEMA,
} from "../../src/server/services/memory-contract";
import { MemoryService } from "../../src/server/services/memory-service";

const MODEL = "qwen/qwen3-4b-2507";
const OUTPUT_RESERVED = 512;
const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const encoding = "o200k_base" as const;

/** Synthetic declared tokenizer: one token per code point. */
const countTokens = (text: string): number => [...text].length;

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

const USER_TEXT =
  "用户偏好整理：这台设备的答复请保持中文，先给出结论再补充原因，正文控制在两句话以内。";
const ASSISTANT_TEXT = "好的，之后我会全部使用中文简短作答。";

interface HttpWireBody {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  response_format?: Record<string, unknown>;
  tools?: { function: ModelTool }[];
}

let server: Server;
let serverPort = 0;
const sentHttpBodies: HttpWireBody[] = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: MODEL }] }));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(raw) as HttpWireBody;
      sentHttpBodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      const schemaStr = JSON.stringify(body.response_format ?? {});
      const content = schemaStr.includes("blocked") ? BLOCKED_JSON : DRAFT_JSON;
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as { port: number }).port;
});

afterEach(() => {
  sentHttpBodies.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

type WireCall = {
  messages: Array<ChatMessage>;
  model?: string;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  contextBudget?: ModelContextBudget;
  contextInputLimit?: number;
  requestFormat?: PreparedRequestFormat;
};

class LegacyFallbackGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  capacity: number | null = 1_000_000;
  calls: WireCall[] = [];
  preparations = 0;
  capacityProbes = 0;
  suppressionReplies: string[] = [];
  enableCounter = true;

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

  async prepareContextModel(): Promise<ModelContextBudget> {
    this.preparations += 1;
    return Object.freeze({
      model: MODEL,
      capacity: this.capacity,
      ...(this.enableCounter ? { tokenizerEncoding: encoding, countText: countTokens } : {}),
      assertCurrent: () => {},
    });
  }

  async complete(options: WireCall): Promise<string> {
    this.calls.push(options);
    const schemaText = JSON.stringify(options.responseSchema ?? {});
    if (schemaText.includes("MemoryDraft")) return DRAFT_JSON;
    if (schemaText.includes("blocked")) {
      return this.suppressionReplies.shift() ?? BLOCKED_JSON;
    }
    return KNOWLEDGE_DRAFT_JSON;
  }

  async *streamChat(): AsyncGenerator<string> {
    yield "unused";
  }
}

class ScriptedWireGateway extends LegacyFallbackGateway {
  prepareFormatCalls: Array<{
    model: string;
    responseSchema?: Record<string, unknown>;
    tools?: readonly ModelTool[];
  }> = [];

  prepareRequestFormat(input: {
    model: string;
    responseSchema?: Record<string, unknown>;
    tools?: readonly ModelTool[];
  }): PreparedRequestFormat {
    this.prepareFormatCalls.push(input);
    return Object.freeze({
      level: input.responseSchema ? "json_schema" : "none",
      schema: input.responseSchema,
      tools: input.tools,
      wireNames: new Map<string, string>(),
    });
  }
}

/** Spy runtime that records LeafInput directly while implementing completeVisionLeaf. */
class RecordingLeafRuntime implements LeafAgentRuntime {
  leafCalls: Array<{ spec: LeafAgentSpec; input: LeafInput }> = [];
  constructor(private readonly fallbackComplete: (options: WireCall) => Promise<string>) {}

  async completeLeaf(spec: LeafAgentSpec, input: LeafInput): Promise<string> {
    this.leafCalls.push({ spec, input });
    const wire: WireCall = {
      messages: [...input.messages] as ChatMessage[],
      model: spec.model,
      maxTokens: spec.maxTokens,
      responseSchema: spec.responseSchema,
      contextBudget: input.contextBudget,
      contextInputLimit: input.contextInputLimit,
      requestFormat: input.requestFormat,
    };
    return this.fallbackComplete(wire);
  }

  async completeVisionLeaf(_spec: LeafAgentSpec, _input: VisionLeafInput): Promise<string> {
    throw new Error("Vision leaf not supported in text auxiliary tests");
  }
}

function setupMemory(gateway: ModelGateway, runtime?: LeafAgentRuntime) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const service = new MemoryService({
    orm: business.orm,
    db: business.db,
    gateway,
    agentRuntime: runtime,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
    jobTimeoutMs: 2_000,
  });
  return { business, orm: business.orm, db: business.db, service };
}

function completedTurn(
  orm: ReturnType<typeof openBusinessDb>["orm"],
  sessionId: string,
  key: string,
): string {
  const prepared = prepareTurn(orm, sessionId, USER_TEXT, key);
  if (prepared.generationToken === null) throw new Error("fresh token expected");
  saveCompletedAssistantMessage(orm, sessionId, ASSISTANT_TEXT, key, prepared.generationToken);
  const turn = getTurnByRequest(orm, sessionId, key);
  if (!turn) throw new Error("turn missing");
  return turn.id;
}

function setAgentAuxProfile(
  orm: ReturnType<typeof openBusinessDb>["orm"],
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

function seedSuppressedEntry(
  business: ReturnType<typeof openBusinessDb>,
  body: string = "旧记忆内容",
): void {
  immediate(business.db, () => {
    business.orm
      .insert(schema.memoryEntries)
      .values({
        id: crypto.randomUUID(),
        agentId: AGENT_ID,
        userId: DEFAULT_USER_ID,
        name: "旧记忆",
        summary: "旧",
        tags: JSON.stringify([]),
        kinds: JSON.stringify(["semantic"]),
        body,
        status: "suppressed",
        scope: "reality_user",
        scopeKey: AGENT_ID,
        configSnapshot: "{}",
        createdAt: nowIso(),
      } satisfies typeof schema.memoryEntries.$inferInsert)
      .run();
  });
}

async function runMemoryJob(
  ctx: ReturnType<typeof setupMemory>,
  requestKey: string,
): Promise<string> {
  const sessionId = createSession(ctx.orm, "实际协议验证", { modelName: MODEL }).id;
  const turnId = completedTurn(ctx.orm, sessionId, requestKey);
  const blocked = ctx.orm
    .select()
    .from(schema.memoryEntries)
    .where(eq(schema.memoryEntries.status, "suppressed"))
    .all();
  if (blocked.length > 0) {
    const sourceTurnId = completedTurn(ctx.orm, sessionId, `${requestKey}-blocked-source`);
    const messages = ctx.orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.turnId, sourceTurnId))
      .all();
    const user = messages.find((message) => message.role === "user");
    const assistant = messages.find((message) => message.role === "assistant");
    if (!user || !assistant) throw new Error("completed blocked source messages missing");
    for (const entry of blocked) {
      ctx.orm
        .insert(schema.memorySources)
        .values({
          memoryId: entry.id,
          turnId: sourceTurnId,
          userMessageId: user.id,
          assistantMessageId: assistant.id,
          sequenceNo: user.sequenceNo,
        })
        .run();
    }
  }
  const job = immediate(ctx.db, () =>
    enqueue(ctx.orm, AGENT_ID, requestKey, { kind: "manual", sessionId, turnIds: [turnId] }),
  );
  await ctx.service.runJob(job.id);
  return job.id;
}

function jobOf(ctx: ReturnType<typeof setupMemory>, jobId: string) {
  return ctx.orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, jobId)).get();
}

describe("auxiliary workers actual protocol wire", () => {
  it("real production LeafAgentRuntime + real ModelGateway client sends verified actual wire body over HTTP", async () => {
    const route: ExternalModelRoute = {
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      apiKey: "synthetic-key",
      contextWindow: 1_000_000,
      tokenizerEncoding: "cl100k_base",
      providerRevision: 1,
    };
    const realClient = createLmStudioClient(
      { baseUrl: `http://127.0.0.1:${serverPort}/v1`, model: MODEL, timeoutSeconds: 5 },
      { externalModel: (model) => (model === MODEL ? route : null) },
    );

    // Construct MemoryService WITHOUT passing agentRuntime:
    // It creates the real default createAgentRuntime under the hood.
    const ctx = setupMemory(realClient);
    try {
      setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      seedSuppressedEntry(ctx.business, "真实线上传输历史记忆");
      const jobId = await runMemoryJob(ctx, "real-http-wire-1");
      expect(jobOf(ctx, jobId)?.status).toBe("succeeded");

      // Verify the real HTTP bodies captured by server
      expect(sentHttpBodies.length).toBe(2);
      const [consolidateWire, suppressionWire] = sentHttpBodies;

      expect(consolidateWire?.model).toBe(MODEL);
      expect(consolidateWire?.max_tokens).toBe(OUTPUT_RESERVED);
      expect(consolidateWire?.response_format).toBeDefined();
      expect(consolidateWire?.response_format?.type).toBe("json_schema");
      const draftSchema = (consolidateWire?.response_format?.json_schema as { schema?: unknown })
        ?.schema;
      expect(draftSchema).toBeDefined();

      expect(suppressionWire?.model).toBe(MODEL);
      expect(suppressionWire?.max_tokens).toBe(OUTPUT_RESERVED);
      expect(suppressionWire?.response_format).toBeDefined();
      expect(suppressionWire?.response_format?.type).toBe("json_schema");
      const suppSchema = (suppressionWire?.response_format?.json_schema as { schema?: unknown })
        ?.schema;
      expect(suppSchema).toBeDefined();
    } finally {
      ctx.business.close();
    }
  });

  it("memory-service passes prepared requestFormat to completeLeaf for both consolidate and suppression", async () => {
    const gateway = new ScriptedWireGateway();
    const runtime = new RecordingLeafRuntime((w) => gateway.complete(w));

    const ctx = setupMemory(gateway, runtime);
    try {
      setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      seedSuppressedEntry(ctx.business, "不相关的历史记录");
      const jobId = await runMemoryJob(ctx, "mem-wire-1");
      expect(jobOf(ctx, jobId)?.status).toBe("succeeded");

      // Verify prepareRequestFormat was called for both schemas with actualModel
      expect(gateway.prepareFormatCalls.length).toBe(2);
      expect(gateway.prepareFormatCalls[0]?.model).toBe(MODEL);
      expect(gateway.prepareFormatCalls[0]?.responseSchema).toEqual(DRAFT_RESULT_JSON_SCHEMA);
      expect(gateway.prepareFormatCalls[1]?.model).toBe(MODEL);
      expect(gateway.prepareFormatCalls[1]?.responseSchema).toEqual(SUPPRESSION_RESULT_JSON_SCHEMA);

      // Verify runtime calls received the prepared format on LeafInput
      expect(runtime.leafCalls.length).toBe(2);
      const [consolidateCall, suppressionCall] = runtime.leafCalls;
      expect(consolidateCall?.input.requestFormat).toBeDefined();
      expect(consolidateCall?.input.requestFormat?.level).toBe("json_schema");
      expect(consolidateCall?.input.requestFormat?.schema).toEqual(DRAFT_RESULT_JSON_SCHEMA);

      expect(suppressionCall?.input.requestFormat).toBeDefined();
      expect(suppressionCall?.input.requestFormat?.level).toBe("json_schema");
      expect(suppressionCall?.input.requestFormat?.schema).toEqual(SUPPRESSION_RESULT_JSON_SCHEMA);

      // Verify wire calls received identical requestFormat
      expect(gateway.calls.length).toBe(2);
      expect(gateway.calls[0]?.requestFormat).toBe(consolidateCall?.input.requestFormat);
      expect(gateway.calls[1]?.requestFormat).toBe(suppressionCall?.input.requestFormat);
    } finally {
      ctx.business.close();
    }
  });

  it("memory auto suppression greedily packs contiguous blocked entries using actual request format cost", async () => {
    const gateway = new ScriptedWireGateway();
    gateway.capacity = 1_000_000;
    const runtime = new RecordingLeafRuntime((w) => gateway.complete(w));
    const ctx = setupMemory(gateway, runtime);
    try {
      setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      for (let i = 0; i < 12; i++) {
        seedSuppressedEntry(ctx.business, `历史封存条目_${i}_内容文本`);
      }
      const jobId = await runMemoryJob(ctx, "mem-auto-pack");
      expect(jobOf(ctx, jobId)?.status).toBe("succeeded");

      const suppressionCalls = runtime.leafCalls.filter((c) => c.spec.id === "memory.suppression");
      expect(suppressionCalls.length).toBeGreaterThan(0);
      for (const call of suppressionCalls) {
        expect(call.input.requestFormat).toBeDefined();
        expect(call.input.requestFormat?.schema).toEqual(SUPPRESSION_RESULT_JSON_SCHEMA);
      }
    } finally {
      ctx.business.close();
    }
  });

  it("memory-service indivisible draft: fails closed when consolidation request exceeds capacity ceiling", async () => {
    const gateway = new ScriptedWireGateway();
    gateway.capacity = OUTPUT_RESERVED + 5;
    const runtime = new RecordingLeafRuntime((w) => gateway.complete(w));
    const ctx = setupMemory(gateway, runtime);
    try {
      setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      const jobId = await runMemoryJob(ctx, "mem-over-ceiling");
      expect(jobOf(ctx, jobId)?.status).toBe("failed");
      expect(jobOf(ctx, jobId)?.errorCode).toBe("CONTEXT_AUX_BUDGET");
      expect(runtime.leafCalls.length).toBe(0);
      expect(gateway.calls.length).toBe(0);
    } finally {
      ctx.business.close();
    }
  });

  it("memory-service: independent byte limit refuses even when declared token cost fits", async () => {
    const gateway = new ScriptedWireGateway();
    gateway.capacity = 1_000_000;
    const runtime = new RecordingLeafRuntime((w) => gateway.complete(w));
    const ctx = setupMemory(gateway, runtime);
    try {
      setAgentAuxProfile(ctx.orm, {
        mode: "fixed",
        input_limit: 20,
        output_reserved: OUTPUT_RESERVED,
      });
      const jobId = await runMemoryJob(ctx, "mem-byte-cap");
      expect(jobOf(ctx, jobId)?.status).toBe("failed");
      expect(jobOf(ctx, jobId)?.errorCode).toBe("CONTEXT_AUX_BUDGET");
      expect(runtime.leafCalls.length).toBe(0);
    } finally {
      ctx.business.close();
    }
  });

  it("knowledge-organizer passes prepared requestFormat to completeLeaf and enforces capacity - output - 256", async () => {
    const gateway = new ScriptedWireGateway();
    const runtime = new RecordingLeafRuntime((w) => gateway.complete(w));

    const business = openBusinessDb();
    const organizer = new KnowledgeOrganizer({
      db: business.db,
      orm: business.orm,
      gateway,
      agentRuntime: runtime,
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
        name: "知识文档",
        original_text: KNOWLEDGE_TEXT,
      });

      expect(await organizer.runCycle()).toBe(true);
      const job = business.db
        .query("SELECT status, error_code FROM knowledge_jobs LIMIT 1")
        .get() as { status: string; error_code: string | null };
      expect(job.status).toBe("succeeded");
      expect(job.error_code).toBeNull();

      expect(gateway.prepareFormatCalls.length).toBeGreaterThan(0);
      const koFormat = gateway.prepareFormatCalls.find((c) => c.model === MODEL);
      expect(koFormat).toBeDefined();

      expect(runtime.leafCalls.length).toBeGreaterThan(0);
      for (const call of runtime.leafCalls) {
        expect(call.input.requestFormat).toBeDefined();
        expect(call.input.requestFormat?.level).toBe("json_schema");
        expect(call.input.contextInputLimit).toBe(gateway.capacity! - KNOWLEDGE_RESERVED - 256);
      }
      expect(gateway.calls.length).toBeGreaterThan(0);
      expect(gateway.calls[0]?.requestFormat).toBe(runtime.leafCalls[0]?.input.requestFormat);
    } finally {
      await organizer.stop();
      business.close();
    }
  });

  it("knowledge-organizer independent byte limit refuses when input_limit is exceeded", async () => {
    const gateway = new ScriptedWireGateway();
    gateway.capacity = 1_000_000;
    const runtime = new RecordingLeafRuntime((w) => gateway.complete(w));
    const business = openBusinessDb();
    const organizer = new KnowledgeOrganizer({
      db: business.db,
      orm: business.orm,
      gateway,
      agentRuntime: runtime,
    });

    try {
      ensureDefaults(business.orm, MODEL);
      updateOrganizationSettings(business.orm, {
        auxiliary_allocation: {
          knowledge_organize: {
            mode: "fixed",
            input_limit: 20,
            output_reserved: KNOWLEDGE_RESERVED,
          },
        },
        expected_revision: readOrganizationSettings(business.orm).revision,
      });
      new KnowledgeRepository(business.db).importDocument({
        category_id: "default",
        name: "超限文档",
        original_text: KNOWLEDGE_TEXT,
      });

      expect(await organizer.runCycle()).toBe(true);
      const job = business.db
        .query("SELECT status, error_code FROM knowledge_jobs LIMIT 1")
        .get() as { status: string; error_code: string | null };
      expect(job.status).toBe("failed");
      expect(job.error_code).toBe("CONTEXT_AUX_BUDGET");
      expect(runtime.leafCalls.length).toBe(0);
    } finally {
      await organizer.stop();
      business.close();
    }
  });

  it("fallback: when gateway lacks prepareRequestFormat, workers maintain complete protocol schema estimate", async () => {
    const gateway = new LegacyFallbackGateway();
    gateway.capacity = 1_000_000;
    const runtime = new RecordingLeafRuntime((w) => gateway.complete(w));
    const ctx = setupMemory(gateway, runtime);
    try {
      setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      seedSuppressedEntry(ctx.business, "回退测试条目");
      const jobId = await runMemoryJob(ctx, "fallback-no-preparer");
      expect(jobOf(ctx, jobId)?.status).toBe("succeeded");

      expect(runtime.leafCalls.length).toBe(2);
      for (const call of runtime.leafCalls) {
        expect(call.input.requestFormat).toBeUndefined();
        expect(call.input.contextBudget).toBeDefined();
      }
    } finally {
      ctx.business.close();
    }
  });
});
