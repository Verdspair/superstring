import { runtimeFixtureBusiness } from "../harness/business-db";
// Memory effective tool policy goldens (ADR0019 §8.11 tool-first retrieval): stored
// full_catalog/full_body and legacy batch values stay raw; the active tool path maps
// through the one shared pure policy resolver to the broad bounded catalog with explicit
// bodyRef reads; ordinary modes keep their own presets; off keeps memory out of the
// host's advertised tools and model traffic. Real surfaces only (agent routes, frozen
// runtime, SQLite memory module, OneBot host harness); synthetic data only — no real
// DB/local/state/config/model/QQ/network access.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { readQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { evidenceQueryPage, type MemoryQuery } from "../../src/server/modules/contracts";
import { SqliteMemoryModule } from "../../src/server/modules/memory-module";
import { updateAgent } from "../../src/server/services/agent-service";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { RuntimeConfig } from "../../src/shared/contracts";
import type { Evidence } from "../../src/shared/contracts/evidence";
import { resolveMemoryReadPolicy } from "../../src/shared/contracts/memory";
import { DEFAULT_RETRIEVAL_PRESETS } from "../../src/shared/contracts/models";
import type { ModelStep } from "../harness/model";
import { batchScore, decideGenerate, say } from "../harness/model";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

const owner = { kind: "synthetic", id: "run", agentId: DEFAULT_AGENT_ID, userId: DEFAULT_USER_ID };
const SECRET = "北极星仓库暗号7749";

type AgentWire = {
  id: string;
  config_version: number;
  p5_config: { retrieval_mode: string; max_catalog_batches: number; catalog_batch_size: number };
};

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

let business: BusinessDbHandle;
afterEach(() => {
  business?.close();
  closeHarnesses();
});

function open(): void {
  business = runtimeFixtureBusiness(openBusinessDb(), "synthetic");
  ensureDefaults(business.orm, "synthetic");
}

function seedMemory(id: string, body: string): void {
  business.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: `目录 ${id}`,
      summary: "仅摘要",
      tags: "[]",
      kinds: '["semantic"]',
      body,
      scope: "reality_user",
      scopeKey: DEFAULT_AGENT_ID,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
  const sessionId = createSession(business.orm, "synthetic", { modelName: "synthetic" }).id;
  const prepared = prepareTurn(business.orm, sessionId, `问题 ${id}`, id);
  if (!prepared.generationToken) throw new Error("missing generation token");
  saveCompletedAssistantMessage(business.orm, sessionId, "合成回答", id, prepared.generationToken);
  const turn = getTurnByRequest(business.orm, sessionId, id);
  if (!turn) throw new Error("missing source turn");
  const messages = business.orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.turnId, turn.id))
    .all();
  const user = messages.find((message) => message.role === "user");
  const assistant = messages.find((message) => message.role === "assistant");
  if (!user || !assistant) throw new Error("missing source messages");
  business.orm
    .insert(schema.memorySources)
    .values({
      memoryId: id,
      turnId: turn.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      sequenceNo: user.sequenceNo,
    })
    .run();
}

function frozenRuntime(): RuntimeConfig {
  const row = getAgentRow(business.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("missing agent");
  return runtimeFromAgent(row);
}

function moduleFor(runtime: RuntimeConfig) {
  const selector = mock(async () => [] as string[]);
  const leaf = mock(async () => '{"ids":[]}');
  const memory = new SqliteMemoryModule({
    orm: business.orm,
    runtime: () => runtime,
    select: selector,
    agentRuntime: { completeLeaf: leaf, completeVisionLeaf: leaf },
  });
  const query = async (extra: Partial<MemoryQuery> = {}) =>
    evidenceQueryPage(
      await memory.query({
        agentId: DEFAULT_AGENT_ID,
        owner,
        scopes: null,
        mode: "standard",
        query: "",
        budget: 65536,
        ...extra,
      }),
    );
  const read = (evidence: Evidence, offset = 0, limit = 4096) =>
    memory.read({ agentId: DEFAULT_AGENT_ID, owner, scopes: null, evidence, offset, limit });
  return { memory, selector, leaf, query, read };
}

describe("memory effective tool policy", () => {
  it("keeps stored full modes and legacy batch values raw across real GET, unrelated save and runtime freeze", async () => {
    open();
    const app = createApp({ business, externalActions: () => [] });
    const created = await app.request(
      "http://x/agents",
      json({
        name: "全量档",
        model_name: "synthetic",
        p5_config: { retrieval_mode: "full_body", max_catalog_batches: 7, catalog_batch_size: 3 },
      }),
    );
    expect(created.status).toBe(201);
    const saved = (await created.json()) as AgentWire;
    expect(saved.p5_config).toMatchObject({
      retrieval_mode: "full_body",
      max_catalog_batches: 7,
      catalog_batch_size: 3,
    });
    // Unrelated save (temperature only) must not touch the stored raw mode or batch values.
    const patched = await app.request(
      `http://x/agents/${saved.id}`,
      json({ temperature: 0.5, expected_version: saved.config_version }, "PATCH"),
    );
    expect(patched.status).toBe(200);
    const read = (await (await app.request(`http://x/agents/${saved.id}`)).json()) as AgentWire;
    expect(read.p5_config).toMatchObject({
      retrieval_mode: "full_body",
      max_catalog_batches: 7,
      catalog_batch_size: 3,
    });
    // Runtime freeze keeps raw identity (readStoredP5 validates but never normalizes stored values).
    const frozen = runtimeFromAgent(getAgentRow(business.orm, read.id)!);
    expect(frozen.p5_config.retrieval_mode).toBe("full_body");
    expect(frozen.p5_config.max_catalog_batches).toBe(7);
    expect(frozen.p5_config.catalog_batch_size).toBe(3);
    const catalog = (await (
      await app.request(
        "http://x/agents",
        json({
          name: "全目录档",
          model_name: "synthetic",
          p5_config: { retrieval_mode: "full_catalog" },
        }),
      )
    ).json()) as AgentWire;
    expect(catalog.p5_config.retrieval_mode).toBe("full_catalog");
  });

  it("serves legacy full modes as a paged authorized catalog with explicit bodyRef reads and no selector model call", async () => {
    open();
    const runtime = frozenRuntime();
    runtime.p5_config.retrieval_mode = "full_body";
    for (let index = 0; index < 18; index += 1)
      seedMemory(`m${String(index).padStart(2, "0")}`, `正文${index} ${"x".repeat(200)}`);
    const { selector, leaf, query, read } = moduleFor(runtime);
    const page = await query({ mode: "full_body" });
    expect(page.status).toBe("ok");
    expect(page.items).toHaveLength(16); // broad preset cap (fold), no automatic full scan/body fill
    expect(page.nextCursor).toBeString();
    expect(JSON.stringify(page.items)).not.toContain("正文"); // catalog previews only, never body
    const evidence = page.items[0]!;
    const head = await read(evidence, 0, 16);
    expect(head.text).toBe([...`正文0 ${"x".repeat(200)}`].slice(0, 16).join(""));
    expect(head.nextOffset).toBe(16);
    const tail = await read(evidence, head.nextOffset ?? 0, 4096);
    expect(tail.nextOffset).toBeNull();
    expect(tail.text.length).toBeGreaterThan(0);
    expect(selector).not.toHaveBeenCalled();
    expect(leaf).not.toHaveBeenCalled();
  });

  it("ordinary modes use their own stored preset caps, legacy batch edits have no active effect and off fails closed", async () => {
    open();
    for (let index = 0; index < 20; index += 1)
      seedMemory(`p${String(index).padStart(2, "0")}`, `预设正文${index}`);
    const presets = {
      conservative: {
        candidate_limit: 30,
        max_entries: 2,
        max_tokens: 2048,
        relevance_instruction: "直接相关",
      },
      standard: {
        candidate_limit: 60,
        max_entries: 4,
        max_tokens: 4096,
        relevance_instruction: "直接或必要背景",
      },
      broad: {
        candidate_limit: 120,
        max_entries: 16,
        max_tokens: 8192,
        relevance_instruction: "有帮助的间接背景",
      },
    };
    const row = getAgentRow(business.orm, DEFAULT_AGENT_ID)!;
    const stored = JSON.parse(row.p5Config) as Record<string, unknown>;
    updateAgent(
      business.orm,
      DEFAULT_AGENT_ID,
      { p5_config: { ...stored, retrieval_presets: presets } },
      row.configVersion,
    );
    const { query } = moduleFor(frozenRuntime());
    expect((await query({ mode: "conservative" })).items).toHaveLength(2);
    expect((await query({ mode: "standard" })).items).toHaveLength(4);
    // Legacy batch edits stay stored but are inactive for the current tool path:
    const edited = getAgentRow(business.orm, DEFAULT_AGENT_ID)!;
    const stored2 = JSON.parse(edited.p5Config) as Record<string, unknown>;
    updateAgent(
      business.orm,
      DEFAULT_AGENT_ID,
      {
        p5_config: {
          ...stored2,
          retrieval_mode: "full_body",
          max_catalog_batches: 1,
          catalog_batch_size: 1,
        },
      },
      edited.configVersion,
    );
    const frozen = frozenRuntime();
    const second = moduleFor(frozen);
    const full = await second.query({ mode: "full_body" });
    expect(full.items).toHaveLength(16); // broad cap, not batch=1
    const evidence = full.items[0]!;
    frozen.p5_config.retrieval_mode = "off";
    const off = moduleFor(frozen);
    expect((await off.query({ mode: "broad" })).items).toEqual([]);
    await expect(off.read(evidence)).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
  });

  it("real OneBot host with retrieval_mode=off keeps memory out of direct reply and initiative judgement", async () => {
    const offHost = (steps: readonly ModelStep[]) => {
      const h = createOneBotHarness({
        initiativeBatchTargetCount: 1,
        initiativeBatchJitterCount: 0,
        model: steps,
      });
      const row = getAgentRow(h.orm, DEFAULT_AGENT_ID);
      if (!row) throw new Error("missing agent");
      updateAgent(
        h.orm,
        DEFAULT_AGENT_ID,
        { p5_config: { retrieval_mode: "off" } },
        row.configVersion,
      );
      h.memory(SECRET, { name: "秘密暗号7749" });
      return h;
    };
    // Direct path: decision + generation run normally and stay memory-free.
    const direct = offHost([decideGenerate("20002"), say("在的")]);
    direct.receive({ id: "1", speaker: "20002", addressed: true, text: "在吗" });
    expect(await direct.activate("direct_reply")).toMatchObject({ status: "completed" });
    await direct.deliver();
    const directCalls = direct.model?.calls ?? [];
    expect(directCalls.some((call) => call.phase === "generate")).toBe(true);
    expect(direct.sent.length).toBeGreaterThan(0);
    // Initiative path: one unaddressed message, one batch evaluation leaf. The scripted
    // evaluation answer can only be consumed by the real scoring call, so
    // remaining()===0 proves the judgement leaf actually ran (below threshold -> no_output).
    const initiative = offHost([]);
    initiative.receive({ id: "1", speaker: "20002", text: "今天天气不错" });
    initiative.model?.push([
      batchScore([
        { targetId: "20002", score: 2, intent: "寒暄", sourceSeqs: [initiative.lastEventSeq] },
      ]),
    ]);
    initiative.advance(31);
    expect(await initiative.activate("chiming_in")).toMatchObject({ status: "no_output" });
    const scripted = initiative.model;
    if (!scripted) throw new Error("missing scripted model");
    expect(scripted.remaining()).toBe(0);
    const calls = scripted.calls;
    expect(calls).toHaveLength(1);
    const scoring = calls[0]!;
    expect(scoring.phase).toBe("next");
    expect(scoring.schema).toBe(true);
    expect(scoring.model).toBe(readQqSettings(initiative.orm).judgementModelName ?? "reply-model");
    const wire = JSON.stringify([
      directCalls.map((call) => ({ tools: call.tools, text: call.text })),
      direct.model?.receivedMessages,
      calls.map((call) => ({ tools: call.tools, text: call.text })),
      scripted.receivedMessages,
    ]);
    for (const tool of [...directCalls.flatMap((call) => call.tools), ...scoring.tools])
      expect(tool.startsWith("memory.")).toBe(false);
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain("秘密暗号7749");
  });
});

describe("resolveMemoryReadPolicy", () => {
  const presets = DEFAULT_RETRIEVAL_PRESETS;
  it("keeps ordinary modes on their own preset and folds retired legacy full modes to broad", () => {
    for (const mode of ["conservative", "standard", "broad"] as const)
      expect(resolveMemoryReadPolicy(mode, presets)).toEqual({
        storedMode: mode,
        effectiveMode: mode,
        presetName: mode,
        legacyFieldsInactive: false,
        preset: presets[mode],
      });
    for (const mode of ["full_catalog", "full_body"] as const)
      expect(resolveMemoryReadPolicy(mode, presets)).toEqual({
        storedMode: mode,
        effectiveMode: "broad",
        presetName: "broad",
        legacyFieldsInactive: true,
        preset: presets.broad,
      });
  });
  it("short-circuits off on the conservative preset", () => {
    expect(resolveMemoryReadPolicy("off", presets)).toEqual({
      storedMode: "off",
      effectiveMode: "off",
      presetName: "conservative",
      legacyFieldsInactive: false,
      preset: presets.conservative,
    });
  });
});
