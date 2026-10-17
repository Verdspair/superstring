import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { ContextEngine } from "../../src/server/agent/context-engine";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, getAgentRow } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function fixture(
  mode: "fixed" | "auto",
  options: {
    tier?: "judgement" | "reply";
    encoding?: "cl100k_base";
    counter?: (text: string) => number;
    onDiagnostic?: (event: unknown) => void;
  } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000),
    now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const stored = createQqScheme(h.orm, { name: "allocation" });
  const scheme = {
    ...stored,
    allocation: JSON.stringify({ judgement: { mode }, reply: { mode } }),
  };
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: stored.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw Error("binding");
  const binding = insertQqBinding(h.orm, created.binding),
    capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw Error("snapshot");
  const row = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!row) throw Error("agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.compression_enabled = false;
  const journal = new ConversationEventRepository(h.db),
    outbox = new OutboundIntentRepository(h.db),
    conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw Error("conversation");
  const gateway = {
    loadedContextCapacity: async () => 65536,
    complete: async () => "unused",
    ...(options.encoding
      ? {
          prepareContextModel: async () => ({
            model: "reply-model",
            capacity: 65536,
            tokenizerEncoding: options.encoding,
            countText: options.counter!,
            assertCurrent() {},
          }),
        }
      : {}),
  };
  const spec = {
    id: "allocation",
    model: "reply-model",
    context: "conversation" as const,
    instructions: "synthetic context",
    availableActions: [],
    limits: { steps: 16, inputUnits: 0 },
  };
  const build = () =>
    new BotContextSource({
      ...h,
      gateway,
      agentRuntime: createAgentRuntime({ gateway, repository: new AgentRunRepository(h.db) }),
      journal,
      outbox,
      conversationId: conversation.id,
      binding,
      snapshot: capture.snapshot,
      scheme,
      runtime,
      spec,
      path: "direct_reply",
      decisionTier: options.tier ?? "reply",
      targets: () => [{ id: "alice", speakerId: "20002" }],
      assertCurrent() {},
      now: () => now,
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
  const seed = (text: string, age = 0) => {
    const eventKey = crypto.randomUUID(),
      expiresAt = new Date((seconds + 3600) * 1000).toISOString();
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        messageId: eventKey,
        occurredAtSeconds: seconds - age,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqMessageFacts)
      .values({
        eventKey,
        legacyDisplayName: "member",
        nameState: "legacy",
        parts: JSON.stringify([{ kind: "text", text }]),
        revision: 1,
        expiresAt,
        recordedAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey,
        body: text,
        occurredAtSeconds: seconds - age,
        expiresAt,
        recordedAt: now,
      })
      .run();
    journal.ingestOneBotEvent(eventKey, binding.id);
  };
  return { ...h, build, seed, spec };
}
const signal = () => new AbortController().signal;
describe("QQ automatic context allocation", () => {
  it("uses actual request room rather than the fixed raw byte slice", async () => {
    const h = fixture("auto");
    for (let i = 0; i < 8; i++) h.seed(`OLDER-${i} ` + "o".repeat(900), 10 - i);
    h.seed("CURRENT");
    const s = h.build(),
      material = await s.read({ signal: signal(), observations: [] });
    expect(JSON.stringify(material)).toContain("OLDER-0");
  });
  it("reselects optional old material to admit a complete tool result", async () => {
    const h = fixture("auto");
    for (let i = 0; i < 8; i++) h.seed(`OLDER-${i} ` + "o".repeat(900), 10 - i);
    h.seed("CURRENT");
    const s = h.build();
    await s.read({ signal: signal(), observations: [] });
    const accept = await s.actionResultFitter(
      "web.fetch",
      { url: "https://public.example" },
      signal(),
      true,
    );
    const value = { status: "ok", text: "r".repeat(46921) };
    expect(accept(value, [])).toBe(true);
    const observation = {
      id: "00000000-0000-0000-0000-000000000001",
      name: "web.fetch",
      arguments: { url: "https://public.example" },
      value,
      sources: [],
    };
    const material = await s.read({ signal: signal(), observations: [observation] });
    const rendered = new ContextEngine().render(h.spec, material, [observation], ["alice"]);
    const text = JSON.stringify(rendered.messages);
    expect(text).toContain(value.text);
    expect(text).toContain("CURRENT");
    expect(s.measurePhaseInput("decision", rendered.messages)).toBeLessThanOrEqual(
      h.spec.limits.inputUnits,
    );
  });
  it("keeps the saved raw window in fixed mode", async () => {
    const h = fixture("fixed");
    for (let i = 0; i < 8; i++) h.seed(`OLDER-${i} ` + "o".repeat(900), 10 - i);
    h.seed("CURRENT");
    const s = h.build(),
      material = await s.read({ signal: signal(), observations: [] });
    expect(JSON.stringify(material)).not.toContain("OLDER-0");
    expect(JSON.stringify(material)).toContain("CURRENT");
  });

  it("preserves sibling result reservations while automatic history is reclaimed", async () => {
    const h = fixture("auto");
    for (let i = 0; i < 8; i++) h.seed(`OLDER-${i} ` + "o".repeat(900), 10 - i);
    h.seed("CURRENT");
    const s = h.build();
    await s.read({ signal: signal(), observations: [] });
    const a = await s.actionResultFitter(
      "web.fetch",
      { url: "https://public.example/a" },
      signal(),
      true,
    );
    const b = await s.actionResultFitter(
      "web.fetch",
      { url: "https://public.example/b" },
      signal(),
      true,
    );
    expect(a({ text: "a".repeat(28000) }, [])).toBe(true);
    expect(b({ text: "b".repeat(46921) }, [])).toBe(false);
    expect(b({ text: "small" }, [])).toBe(true);
    s.invalidate();
    expect(b({ text: "b".repeat(46921) }, [])).toBe(false);
  });

  it("measures automatic candidates with the declared local encoding", async () => {
    const { loadTextTokenCounter } = await import("../../src/server/llm/text-token-counter");
    const counter = await loadTextTokenCounter("cl100k_base");
    const h = fixture("auto", { encoding: "cl100k_base", counter: counter.count });
    for (let i = 0; i < 8; i++) h.seed(`OLDER-${i} ` + "中".repeat(900), 10 - i);
    h.seed("CURRENT");
    const s = h.build(),
      material = await s.read({ signal: signal(), observations: [] });
    expect(JSON.stringify(material)).toContain("OLDER-0");
    const value = { text: "中".repeat(3000) },
      fit = await s.actionResultFitter("web.fetch", {}, signal(), true);
    expect(fit(value, [])).toBe(true);
  });
  it("reports content-free numeric rejection without treating a candidate as delivered", async () => {
    const events: unknown[] = [];
    const h = fixture("auto", { onDiagnostic: (event) => events.push(event) });
    h.seed("CURRENT");
    const s = h.build();
    await s.read({ signal: signal(), observations: [] });
    const fit = await s.actionResultFitter(
      "web.fetch",
      { secret: "private-argument" },
      signal(),
      true,
    );
    expect(fit({ text: "private-result" + "x".repeat(100000) }, [])).toBe(false);
    const event = events.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        "stage" in item &&
        item.stage === "action_result_fit",
    );
    expect(event).toBeDefined();
    if (!event) throw Error("missing diagnostic");
    expect(event.unit).toBe("bytes");
    expect(typeof event.candidateCost).toBe("number");
    expect(typeof event.siblingReserved).toBe("number");
    expect(JSON.stringify(event)).not.toContain("private-argument");
    expect(JSON.stringify(event)).not.toContain("private-result");
  });

  it("keeps judgement and reply requests independently priced during automatic refit", async () => {
    const h = fixture("auto", { tier: "judgement" });
    for (let i = 0; i < 8; i++) h.seed(`OLD-${i} ` + "o".repeat(900), 10 - i);
    h.seed("CURRENT");
    const s = h.build();
    await s.read({ signal: signal(), observations: [] });
    const accept = await s.actionResultFitter("web.fetch", {}, signal(), true);
    expect(accept({ text: "r".repeat(46921) }, [])).toBe(true);
    expect(s.isTerminalDecision()).toBe(false);
  });
  it("admits the current result without reserving an impossible future tool", async () => {
    const h = fixture("auto");
    for (let i = 0; i < 8; i++) h.seed(`OLD-${i} ` + "o".repeat(900), 10 - i);
    h.seed("CURRENT");
    const s = h.build();
    await s.read({ signal: signal(), observations: [] });
    const accept = await s.actionResultFitter("history.read", {}, signal());
    expect(accept({ text: "r".repeat(46921) }, [])).toBe(true);
  });
});
