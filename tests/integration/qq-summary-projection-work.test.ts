import { afterEach, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { inputUnits, textMessage } from "../../src/server/agent/context-engine";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { contextDumps } from "../../src/server/db/json-text";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { readQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  type QqSummaryPackage,
  saveQqConversationSummary,
} from "../../src/server/db/qq-summary-repository";
import { DEFAULT_AGENT_ID, getAgentRow } from "../../src/server/db/repositories";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";
import { captureQqTask } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(closeHarnesses);

it("validates each stored source group at most once for each reader and model projection while fitting four packages", async () => {
  const h = createOneBotHarness();
  for (let index = 0; index < 4; index++)
    h.receive({ id: String(97000 + index), text: `stored source ${index}`, speaker: "20002" });
  h.receive({ id: "97004", text: "current question", speaker: "20002" });
  const rows = h.db
    .query(`SELECT e.event_key AS id,t.body,t.expires_at AS expiresAt,ce.seq
    FROM qq_events e JOIN qq_observation_text t ON t.event_key=e.event_key
    JOIN conversation_events ce ON ce.source_kind='qq_event' AND ce.source_id=e.event_key
    WHERE ce.conversation_id=? ORDER BY ce.seq`)
    .all(h.conversationId) as { id: string; body: string; expiresAt: string; seq: number }[];
  expect(rows).toHaveLength(5);
  const rawGroups: string[] = [];
  const packages: QqSummaryPackage[] = rows.slice(0, 4).map((row, index) => {
    const source: SourceRef = {
      kind: "qq_observation",
      id: row.id,
      revision: new Bun.CryptoHasher("sha256").update(row.body).digest("hex"),
      expiresAt: row.expiresAt,
    };
    const raw = contextDumps([[source.kind, source.id, source.revision]]);
    rawGroups.push(raw);
    return {
      facts: [
        {
          kind: "fact",
          speaker: "20002",
          text: `package-${index}:` + "事实".repeat(80),
          source_ids: ["s0"],
        },
      ],
      sources: [source],
      provenance: { s0: raw },
      fromSeq: row.seq,
      throughSeq: row.seq,
      fromSeconds: h.clock.seconds,
      throughSeconds: h.clock.seconds,
      at: h.now(),
    };
  });
  expect(
    saveQqConversationSummary(h.orm, {
      conversationId: h.conversationId,
      agentId: DEFAULT_AGENT_ID,
      throughSeq: rows[3]!.seq,
      coveredSeq: rows[3]!.seq,
      packages,
      modelName: "synthetic",
      configSnapshot: {},
      estimatedTokens: 0,
      at: h.now(),
      expected: null,
      assertCurrent() {},
    }),
  ).toBe(true);
  const packageCost = (items: readonly QqSummaryPackage[]) =>
    inputUnits([
      textMessage(
        "user",
        contextDumps({
          kind: "qq_context_packages",
          trust: "data_only",
          packages: items.map((item) => ({
            fromSeq: item.fromSeq,
            throughSeq: item.throughSeq,
            fromSeconds: item.fromSeconds,
            throughSeconds: item.throughSeconds,
            facts: item.facts,
          })),
        }),
      ),
    ]) - inputUnits([]);
  const allowance = packageCost(packages.slice(2));
  expect(packageCost(packages.slice(1))).toBeGreaterThan(allowance);
  const binding = readQqBinding(h.orm, h.bindingId);
  const scheme = readQqScheme(h.orm, h.scheme.id);
  const agent = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!binding || !scheme || !agent) throw new Error("synthetic config missing");
  const captured = captureQqTask(binding, "reply");
  if (captured.kind !== "captured") throw new Error("synthetic scope missing");
  const runtime = runtimeFromAgent(agent);
  runtime.p5_config.memory_read = { enabled: false, max_bytes: 8192 };
  runtime.p5_config.recent_turns = 1;
  runtime.p5_config.summary_read_max_tokens = allowance;
  const counter = await loadTextTokenCounter("cl100k_base");
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "synthetic", timeoutSeconds: 5 },
    async listModels() {
      return ["synthetic"];
    },
    async probeModelLoaded() {
      return true;
    },
    async loadedContextCapacity() {
      return 65536;
    },
    async prepareContextModel(model) {
      return {
        model,
        capacity: 65536,
        tokenizerEncoding: counter.encoding,
        countText: counter.count,
        assertCurrent() {},
      };
    },
    async complete() {
      throw new Error("unexpected inference");
    },
    async *streamChat() {
      yield "";
      throw new Error("unexpected inference");
    },
  };
  let hostChecks = 0;
  const source = new BotContextSource({
    db: h.db,
    orm: h.orm,
    gateway,
    runtime,
    binding,
    scheme,
    journal: h.journal,
    outbox: h.outbox,
    conversationId: h.conversationId,
    snapshot: captured.snapshot,
    agentRuntime: createAgentRuntime({ gateway, repository: new AgentRunRepository(h.db) }),
    spec: {
      id: "test.summary.work",
      model: "synthetic",
      context: "conversation",
      instructions: "Read facts.",
      availableActions: [],
      limits: { steps: 4 },
    },
    path: "direct_reply",
    decisionTier: "reply",
    targets: () => [{ id: "20002", speakerId: "20002" }],
    assertCurrent() {
      hostChecks++;
    },
    now: h.now,
  });
  const counts = new Map(rawGroups.map((raw) => [raw, 0]));
  const original = JSON.parse;
  let material: Awaited<ReturnType<BotContextSource["read"]>>;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (counts.has(text)) counts.set(text, counts.get(text)! + 1);
    return original(text, reviver);
  }) as typeof JSON.parse;
  try {
    material = await source.read({ signal: new AbortController().signal, observations: [] });
  } finally {
    JSON.parse = original;
  }
  const part = material.history
    ?.flatMap((message) => message.content)
    .find((part) => part.kind === "text" && part.text.includes('"kind":"qq_context_packages"'));
  if (part?.kind !== "text") throw new Error("package material missing");
  const projected = JSON.parse(part.text) as { packages: { fromSeq: number; facts: unknown }[] };
  expect(projected.packages.map((pkg) => pkg.fromSeq)).toEqual(
    packages.slice(2).map((pkg) => pkg.fromSeq),
  );
  expect(projected.packages.map((pkg) => pkg.facts)).toEqual(
    packages.slice(2).map((pkg) => pkg.facts),
  );
  for (const row of rows.slice(2, 4))
    expect(
      material.sources?.some((source) => source.kind === "qq_observation" && source.id === row.id),
    ).toBe(true);
  const checksBefore = hostChecks;
  h.db
    .query("UPDATE qq_observation_text SET body='revoked source body' WHERE event_key=?")
    .run(rows[3]!.id);
  await expect(
    source.read({ signal: new AbortController().signal, observations: [] }),
  ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
  expect(hostChecks).toBeGreaterThan(checksBefore);
  for (const raw of rawGroups) {
    expect(counts.get(raw)).toBeGreaterThan(0);
    expect(counts.get(raw)).toBeLessThanOrEqual(2);
  }
});
