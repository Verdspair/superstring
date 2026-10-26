import { afterEach, describe, expect, it } from "bun:test";
import type { LeafAgentRuntime } from "../../src/server/agent/agent-runtime";
import {
  type CompressionRecord,
  ConversationCompressor,
} from "../../src/server/agent/conversation-compression";
import { DEFAULT_AGENT_ID, ensureDefaults, getAgentRow } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function fixture(
  text: string,
  options: { records?: CompressionRecord[]; speaker?: string; sourceId?: string } = {},
) {
  const h = openBusinessDb({ path: ":memory:" });
  handles.push(h);
  ensureDefaults(h.orm, "synthetic-compressor");
  const agent = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!agent) throw new Error("synthetic agent missing");
  const runtime = runtimeFromAgent(agent);
  const sourceId = options.sourceId ?? `qq-record:${"x".repeat(43)}`;
  const raw = JSON.stringify({
    facts: [{ kind: "fact", speaker: options.speaker ?? "20002", text, source_ids: [sourceId] }],
  });
  const calls: unknown[] = [];
  const agentRuntime = {
    async completeLeaf(_spec: unknown, input: { validate(text: string): unknown }) {
      calls.push(input);
      input.validate(raw);
      return raw;
    },
  } as unknown as LeafAgentRuntime;
  const compressor = new ConversationCompressor({
    runtime,
    agentRuntime,
    gateway: { loadedContextCapacity: async () => 65536 },
    owner: { kind: "qq_binding", id: "synthetic-binding", agentId: DEFAULT_AGENT_ID },
    assertSources() {},
  });
  return {
    calls,
    raw,
    compressor,
    records: options.records ?? [
      { id: sourceId, seq: 1, speaker: "20002", text: "source text", sources: [] },
    ],
  };
}

describe("summary whole-envelope byte budgets", () => {
  it("refuses an impossible one-byte structured result before spending a leaf call", async () => {
    const f = fixture("x");
    await expect(
      f.compressor.summarize({
        records: f.records,
        target: 1,
        requireFacts: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_SUMMARY_BUDGET" });
    expect(f.calls).toHaveLength(0);
  });

  it("counts JSON structure, source labels and escaped UTF-8 rather than prose characters", async () => {
    const f = fixture('😀"\\');
    let published = false;
    await expect(
      f.compressor.summarize({
        records: f.records,
        target: Buffer.byteLength(f.raw, "utf8") - 1,
        requireFacts: true,
        signal: new AbortController().signal,
        onSummary() {
          published = true;
        },
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_SUMMARY_BUDGET" });
    expect(f.calls).toHaveLength(1);
    expect(published).toBe(false);
  });

  it("accepts an exactly fitting complete result without changing its sources", async () => {
    const f = fixture('😀"\\');
    let published = false;
    const result = await f.compressor.summarize({
      records: f.records,
      target: Buffer.byteLength(f.raw, "utf8"),
      requireFacts: true,
      signal: new AbortController().signal,
      onSummary() {
        published = true;
      },
    });
    expect(f.calls).toHaveLength(1);
    expect(published).toBe(true);
    expect(result).not.toBeNull();
  });
});

it("admits independently allowed short speaker and source labels from different records", async () => {
  const records: CompressionRecord[] = [
    { id: "i", speaker: "long-speaker-".repeat(30), seq: 1, text: "first source", sources: [] },
    { id: "long-source-".repeat(30), speaker: "s", seq: 2, text: "second source", sources: [] },
  ];
  const f = fixture("x", { records, speaker: "s", sourceId: "i" });
  const target = Buffer.byteLength(f.raw, "utf8");
  for (const record of records) {
    const paired = JSON.stringify({
      facts: [{ kind: "fact", speaker: record.speaker, text: "x", source_ids: [record.id] }],
    });
    expect(Buffer.byteLength(paired, "utf8")).toBeGreaterThan(target);
  }
  let published = false;
  const result = await f.compressor.summarize({
    records,
    target,
    requireFacts: true,
    signal: new AbortController().signal,
    onSummary(facts) {
      expect(facts).toEqual([{ kind: "fact", speaker: "s", text: "x", source_ids: ["i"] }]);
      published = true;
    },
  });
  expect(result).not.toBeNull();
  expect(f.calls).toHaveLength(1);
  expect(published).toBe(true);
});

it("includes prior overview labels when checking the minimum complete result", async () => {
  const records: CompressionRecord[] = [
    {
      id: "long-current-source-".repeat(20),
      speaker: "long-current-speaker-".repeat(20),
      seq: 1,
      text: "current source",
      sources: [],
    },
  ];
  const f = fixture("x", { records, speaker: "s", sourceId: "i" });
  const previous = [{ kind: "fact" as const, speaker: "s", text: "prior fact", source_ids: ["i"] }];
  const result = await f.compressor.summarize({
    records,
    previous,
    target: Buffer.byteLength(f.raw, "utf8"),
    requireFacts: true,
    signal: new AbortController().signal,
  });
  expect(result).not.toBeNull();
  expect(f.calls).toHaveLength(1);
});
