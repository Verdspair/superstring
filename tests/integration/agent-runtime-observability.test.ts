import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime, AgentRuntimeError } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { textMessage } from "../../src/server/agent/context-engine";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { traceErrorCode } from "../../src/server/observability/agent-tracing";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";
import type { RuntimeSpan } from "../../src/shared/contracts/runtime-observability";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const owner = { kind: "test", id: "fixture", userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID };
const main: AgentSpec = {
  id: "main",
  instructions: "PRIVATE_PERSONA",
  model: "decision",
  context: "conversation",
  availableActions: [],
  limits: { steps: 8 },
  generation: { model: "writer" },
};
const leafInput = { owner, messages: [{ role: "user", content: "PRIVATE_INPUT" }] };
function setup(port: Partial<ModelPort> = {}) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "fixture");
  const telemetry = new RuntimeTelemetry(h.db),
    spans = new RuntimeSpanRepository(h.db),
    runs = new AgentRunRepository(h.db);
  const runtime = new AgentRuntime({
    repository: runs,
    telemetry,
    model: {
      complete: async () => '{"kind":"none"}',
      async *streamText() {
        yield "PRIVATE_OUTPUT";
      },
      completeMultimodal: async () => "PRIVATE_VISION",
      ...port,
    },
  });
  cleanups.push(async () => {
    await telemetry.close();
    h.close();
  });
  const session = createSession(h.orm, "fixture");
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureWeb(session.id)!;
  const host = new ConversationHost({ runtime });
  return { h, telemetry, spans, runs, runtime, host, conversation, session, journal };
}
function parent(spans: RuntimeSpan[], child: RuntimeSpan) {
  return spans.find((s) => s.spanId === child.parentSpanId)!;
}

describe("Agent runtime execution traces", () => {
  it("merges read-call-local measured stage scalars into the same context span", async () => {
    const f = setup();
    const order: string[] = [];
    let measured = 0,
      hookPresent = false;
    await f.runtime.run(main, {
      owner,
      conversationId: f.conversation.id,
      authorizedTargets: [],
      outputMode: "buffered",
      context: {
        async read(
          input: Parameters<Parameters<AgentRuntime["run"]>[1]["context"]["read"]>[0] & {
            onReadTimings?: (timings: { readPreludeMs?: number }) => void;
          },
        ) {
          order.push("read");
          const started = performance.now();
          await Promise.resolve();
          measured = performance.now() - started;
          hookPresent = typeof input.onReadTimings === "function";
          input.onReadTimings?.({ readPreludeMs: measured });
          return { pending: [textMessage("user", "PRIVATE_READ_TIMING")] };
        },
      },
      onContext() {
        order.push("host");
      },
    });
    expect(order).toEqual(["read", "host"]);
    expect(hookPresent).toBe(true);
    const contexts = f.spans.page({}).items.filter((span) => span.name === "agent.context");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.details.readPreludeMs).toBe(measured);
    expect(Number.isFinite(contexts[0]?.details.readPreludeMs)).toBe(true);
    expect(contexts[0]?.details.readViewMs).toBeUndefined();
    expect(contexts[0]?.details.onContextPresent).toBe(true);
    expect(JSON.stringify(contexts)).not.toContain("PRIVATE_");
  });

  it("records measured context read, render and awaited host callback phases in the existing trace", async () => {
    const order: string[] = [];
    let enteredRead!: () => void, releaseRead!: () => void;
    let enteredCallback!: () => void, releaseCallback!: () => void;
    const readEntered = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const callbackEntered = new Promise<void>((resolve) => {
      enteredCallback = resolve;
    });
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const f = setup({
      complete: async () => {
        order.push("model");
        return '{"kind":"none"}';
      },
    });
    const running = f.runtime.run(main, {
      owner,
      conversationId: f.conversation.id,
      authorizedTargets: [],
      outputMode: "buffered",
      context: {
        async read() {
          order.push("read-start");
          enteredRead();
          await readGate;
          order.push("read-end");
          return { pending: [textMessage("user", "PRIVATE_PHASE_INPUT")] };
        },
      },
      async onContext(context, meta) {
        expect(meta.phase).toBe("next");
        expect(context.units).toBeGreaterThan(0);
        order.push("callback-start");
        enteredCallback();
        await callbackGate;
        order.push("callback-end");
      },
    });
    try {
      await readEntered;
      expect(order).toEqual(["read-start"]);
      expect(f.spans.page({}).items.find((span) => span.name === "agent.context")?.status).toBe(
        "started",
      );
      releaseRead();
      await callbackEntered;
      expect(order).toEqual(["read-start", "read-end", "callback-start"]);
      releaseCallback();
      await running;
    } finally {
      releaseRead();
      releaseCallback();
      await Promise.allSettled([running]);
    }
    expect(order).toEqual(["read-start", "read-end", "callback-start", "callback-end", "model"]);
    const context = f.spans.page({}).items.find((span) => span.name === "agent.context");
    expect(context?.status).toBe("completed");
    expect(context?.details.onContextPresent).toBe(true);
    for (const key of ["contextReadMs", "contextRenderMs", "onContextMs"]) {
      const duration = context?.details[key];
      expect(typeof duration).toBe("number");
      expect(Number.isFinite(duration)).toBe(true);
      expect(Number(duration)).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(context)).not.toContain("PRIVATE_");
  });

  it("keeps a failed context read's measured duration without fabricating later phases or invoking model hooks", async () => {
    const order: string[] = [];
    let entered!: () => void, release!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = Object.assign(new Error("PRIVATE_CONTEXT_ERROR"), {
      code: "CONTEXT_SOURCE_INVALID",
    });
    const f = setup({
      complete: async () => {
        order.push("model");
        return '{"kind":"none"}';
      },
    });
    const running = f.runtime.run(main, {
      owner,
      conversationId: f.conversation.id,
      authorizedTargets: [],
      outputMode: "buffered",
      context: {
        async read() {
          order.push("read-start");
          entered();
          await gate;
          throw failure;
        },
      },
      onContext() {
        order.push("callback");
      },
    });
    const captured = running.then(
      () => {
        throw new Error("Expected context read rejection");
      },
      (error: unknown) => error,
    );
    try {
      await enteredRead;
      release();
      expect(await captured).toBe(failure);
    } finally {
      release();
      await Promise.allSettled([running]);
    }
    expect(order).toEqual(["read-start"]);
    const context = f.spans.page({}).items.find((span) => span.name === "agent.context");
    expect(context?.status).toBe("failed");
    expect(context?.code).toBe("CONTEXT_SOURCE_INVALID");
    expect(context?.details.onContextPresent).toBe(true);
    expect(typeof context?.details.contextReadMs).toBe("number");
    expect(Number.isFinite(context?.details.contextReadMs)).toBe(true);
    expect(Number(context?.details.contextReadMs)).toBeGreaterThanOrEqual(0);
    expect(context?.details.contextRenderMs).toBeUndefined();
    expect(context?.details.onContextMs).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("PRIVATE_");
  });

  it("persists live run/model spans and nests context, action, vision and sticker leaves in the hosted Web trace", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let decisions = 0;
    const f = setup({
      complete: async (request) => {
        if (request.model === "memory") {
          enter();
          await gate;
          return "PRIVATE_MEMORY";
        }
        if (request.model !== "decision") return "PRIVATE_LEAF";
        return ++decisions === 1
          ? '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"PRIVATE_QUERY"}}'
          : '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"PRIVATE_DRAFT"}]}';
      },
    });
    const source = {
      kind: "fixture",
      id: "source-1",
      revision: "1",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const action = {
      description: {
        name: "knowledge.query",
        capability: "knowledge.read",
        description: "Read",
        parameters: {},
      },
      async execute() {
        await f.runtime.completeLeaf(
          { id: "knowledge", model: "knowledge" },
          { ...leafInput, owner: { ...owner, kind: "knowledge_job" }, sources: [source] },
        );
        return { value: "PRIVATE_EVIDENCE", sources: [source] };
      },
    };
    let reads = 0;
    const task = f.host.activate({
      conversation: f.conversation,
      spec: { ...main, availableActions: [action.description] },
      owner,
      actions: [action],
      outputMode: "stream",
      authorizedTargets: ["web"],
      context: {
        async read() {
          if (++reads === 1)
            await f.runtime.completeLeaf(
              { id: "memory", model: "memory" },
              { ...leafInput, owner: { ...owner, kind: "memory_job" }, sources: [source] },
            );
          return { pending: [textMessage("user", "PRIVATE_HISTORY")], sources: [source] };
        },
      },
      async prepareGeneration() {
        await f.runtime.completeVisionLeaf(
          { id: "media" },
          {
            owner: { ...owner, kind: "qq_media" },
            model: "vision",
            prompt: "PRIVATE_IMAGE_PROMPT",
            images: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
            sources: [source],
          },
        );
        return undefined;
      },
      async reconsider() {
        await f.runtime.completeLeaf(
          { id: "sticker", model: "selector" },
          { ...leafInput, owner: { ...owner, kind: "qq_sticker" } },
        );
        return false;
      },
    });
    await entered;
    const live = f.spans.page({}).items;
    expect(live.filter((s) => s.name === "agent.run")).toHaveLength(2);
    expect(live.find((s) => s.name === "agent.model")).toMatchObject({
      status: "started",
      model: "memory",
      finishedAt: null,
    });
    expect(f.runs.listRuns({ ownerKind: "memory_job", ownerId: owner.id })[0].status).toBe(
      "generating",
    );
    release();
    const result = await task;
    const all = f.spans.page({ limit: 100 }).items;
    expect(new Set(all.map((s) => s.traceId)).size).toBe(1);
    expect(all.every((s) => s.channel === "web" && s.conversationId === f.conversation.id)).toBe(
      true,
    );
    const leafRuns = all.filter((s) => s.name === "agent.run" && s.details.specId !== "main");
    expect(leafRuns).toHaveLength(4);
    expect(parent(all, leafRuns.find((s) => s.details.specId === "memory")!).name).toBe(
      "agent.context",
    );
    expect(parent(all, leafRuns.find((s) => s.details.specId === "knowledge")!).name).toBe(
      "agent.action",
    );
    expect(parent(all, leafRuns.find((s) => s.details.specId === "media")!).details.phase).toBe(
      "generate",
    );
    expect(parent(all, leafRuns.find((s) => s.details.specId === "sticker")!).name).toBe(
      "agent.checkpoint",
    );
    const generated = all.find((s) => s.name === "agent.model" && s.details.phase === "generate")!;
    expect(generated).toMatchObject({
      model: "writer",
      status: "completed",
      outputId: result.outputs[0].outputId,
    });
    expect(generated.details.outputCharacters).toBe("PRIVATE_OUTPUT".length);
    expect(generated.details.inputUnits).toBeGreaterThan(0);
    expect(generated.durationMs).toBeGreaterThanOrEqual(0);
    expect(
      all.find((s) => s.name === "agent.model" && s.details.phase === "vision")!.details.imageCount,
    ).toBe(1);
    // T14 V4：与 render 同一 visionCostOf 真源的标量投影——有图 unknown、无图精确 0；
    // unknown 不是 0、不折算 token、不进预算。
    const visionSpan = all.find((s) => s.name === "agent.model" && s.details.phase === "vision");
    if (!visionSpan) throw new Error("missing vision span");
    expect(visionSpan.details.visionCostState).toBe("unknown");
    expect(visionSpan.details.visionImages).toBe(1);
    expect(typeof visionSpan.details.visionPixels).toBe("number");
    const generateSpan = all.find(
      (s) => s.name === "agent.model" && s.details.phase === "generate",
    );
    if (!generateSpan) throw new Error("missing generate span");
    expect(generateSpan.details.visionCostState).toBe("estimated");
    expect(generateSpan.details.visionImages).toBe(0);
    expect(generateSpan.details.visionPixels).toBe(0);
    expect(f.telemetry.parentFor("output_id", result.outputs[0].outputId)).not.toBeNull();
    expect(all.find((s) => s.name === "agent.run" && s.runId === result.runId)).toMatchObject({
      status: "completed",
      details: { stepCount: 3 },
    });
    const persisted = JSON.stringify(f.h.db.query("SELECT * FROM runtime_spans").all());
    expect(persisted).not.toContain("PRIVATE_");
    const expiries = f.h.db.query("SELECT DISTINCT expires_at FROM runtime_spans").all() as {
      expires_at: string;
    }[];
    expect(expiries).toEqual([{ expires_at: source.expiresAt }]);
  });

  it("isolates concurrent leaf roots and classifies standalone job/media owners", async () => {
    const f = setup();
    await Promise.all(
      ["memory_job", "knowledge_job", "qq_media", "qq_sticker"].map((kind) =>
        f.runtime.completeLeaf({ id: kind }, { ...leafInput, owner: { ...owner, kind } }),
      ),
    );
    const roots = f.spans.page({}).items.filter((s) => s.name === "agent.run");
    expect(new Set(roots.map((s) => s.traceId)).size).toBe(4);
    expect(roots.every((s) => s.parentSpanId === null && s.conversationId === null)).toBe(true);
    expect(Object.fromEntries(roots.map((s) => [s.details.ownerKind, s.channel]))).toEqual({
      memory_job: "memory",
      knowledge_job: "knowledge",
      qq_media: "onebot11",
      qq_sticker: "onebot11",
    });
  });

  it("resolves standalone Web turns and only journaled media in the current Bot epoch", async () => {
    const f = setup(),
      at = new Date().toISOString();
    f.h.db
      .query(
        "INSERT INTO turns(id,session_id,client_request_id,runtime_config_snapshot,created_at) VALUES('turn',?,'request','{}',?)",
      )
      .run(f.session.id, at);
    await f.runtime.completeLeaf(
      { id: "web-summary" },
      { ...leafInput, owner: { ...owner, kind: "web_turn", id: "turn" } },
    );
    expect(f.spans.page({}).items.find((s) => s.name === "agent.run")).toMatchObject({
      channel: "web",
      conversationId: f.conversation.id,
    });
    const unjournaled = { id: crypto.randomUUID() };
    f.h.db
      .query(`INSERT INTO sessions(id,user_id,agent_id,title,client_request_id,agent_config_snapshot,created_at,updated_at)
      SELECT ?,user_id,agent_id,'unjournaled',?,'{}',?,? FROM sessions WHERE id=?`)
      .run(unjournaled.id, unjournaled.id, at, at, f.session.id);
    f.h.db
      .query(
        "INSERT INTO turns(id,session_id,client_request_id,runtime_config_snapshot,created_at) VALUES('unjournaled-turn',?,'request','{}',?)",
      )
      .run(unjournaled.id, at);
    const before = f.h.db.query("SELECT COUNT(*) AS count FROM conversations").get();
    await f.runtime.completeLeaf(
      { id: "unjournaled-summary" },
      { ...leafInput, owner: { ...owner, kind: "web_turn", id: "unjournaled-turn" } },
    );
    expect(f.h.db.query("SELECT COUNT(*) AS count FROM conversations").get()).toEqual(before);
    expect(
      f.spans
        .page({})
        .items.find(
          (span) => span.name === "agent.run" && span.details.specId === "unjournaled-summary",
        )?.conversationId,
    ).toBeNull();
    const scheme = createQqScheme(f.h.orm, { name: "fixture" });
    f.h.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','100','private','200',?,?,?,?)",
      )
      .run(DEFAULT_AGENT_ID, scheme.id, at, at);
    const bot = f.journal.ensureOneBot("binding")!;
    f.h.db
      .query(
        "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES('event','100','private','200',?,'1',100,'member','200',?)",
      )
      .run(DEFAULT_AGENT_ID, at);
    f.h.db
      .query(
        "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,expires_at,recorded_at,updated_at) VALUES('media','event',0,'image','PRIVATE_URL',?,?,?)",
      )
      .run("2099-01-01T00:00:00.000Z", at, at);
    f.journal.append({
      conversationId: bot.id,
      eventKey: "fixture-event",
      kind: "inbound",
      source: { kind: "qq_observation", id: "event", revision: "1" },
      occurredAt: at,
    });
    const read = () =>
      f.runtime.completeVisionLeaf(
        { id: "media" },
        {
          owner: { ...owner, kind: "qq_media", id: "media" },
          model: "vision",
          prompt: "PRIVATE_MEDIA",
          images: [],
        },
      );
    await read();
    expect(
      f.spans.page({}).items.find((s) => s.name === "agent.run" && s.details.specId === "media")!
        .conversationId,
    ).toBe(bot.id);
    f.h.db.query("UPDATE conversations SET closed_at=? WHERE id=?").run(at, bot.id);
    const replacement = f.journal.ensureOneBot("binding")!;
    expect(replacement.id).not.toBe(bot.id);
    await read();
    const mediaRuns = f.spans
      .page({})
      .items.filter((s) => s.name === "agent.run" && s.details.specId === "media");
    expect(mediaRuns[0].conversationId).toBeNull();
    expect(mediaRuns[1].conversationId).toBe(bot.id);
  });

  it("records no_output, stable model errors and caller cancellation without raw error details", async () => {
    const f = setup();
    await f.host.activate({
      conversation: f.conversation,
      spec: main,
      owner,
      context: { read: async () => ({}) },
      outputMode: "buffered",
      authorizedTargets: [],
    });
    expect(f.spans.page({}).items.find((s) => s.name === "agent.run")!.status).toBe("no_output");
    const invalid = setup({
      complete: async () => {
        throw Object.assign(new Error("PRIVATE_ERROR"), { code: "https://PRIVATE_TOKEN" });
      },
    });
    await expect(invalid.runtime.completeLeaf({ id: "bad" }, leafInput)).rejects.toThrow(
      "PRIVATE_ERROR",
    );
    const errors = invalid.spans.page({}).items;
    expect(errors.every((s) => s.status === "failed" && s.code === "AGENT_FAILED")).toBe(true);
    expect(JSON.stringify(errors)).not.toContain("PRIVATE_");
    const control = new AbortController();
    const cancelled = setup({
      complete: async () => {
        control.abort(new Error("PRIVATE_CANCEL"));
        return "ignored";
      },
    });
    await expect(
      cancelled.runtime.completeLeaf({ id: "cancel" }, { ...leafInput, signal: control.signal }),
    ).rejects.toThrow("PRIVATE_CANCEL");
    expect(cancelled.spans.page({}).items.every((s) => s.status === "cancelled")).toBe(true);
  });

  it("traces deadline exhaustion separately from caller cancellation", async () => {
    const f = setup({
      complete: async ({ signal }) =>
        new Promise((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        }),
    });
    await expect(
      f.runtime.completeLeaf({ id: "timeout", limits: { deadlineMs: 10 } }, leafInput),
    ).rejects.toBeInstanceOf(AgentRuntimeError);
    expect(
      f.spans.page({}).items.every((s) => s.status === "failed" && s.code === "AGENT_DEADLINE"),
    ).toBe(true);
  });

  it("uses the committed terminal if the event consumer disconnects afterwards", async () => {
    const f = setup();
    await expect(
      f.runtime.completeLeaf(
        { id: "committed" },
        {
          ...leafInput,
          onEvent(event) {
            if (event.type === "completed") throw new Error("DISCONNECTED");
          },
        },
      ),
    ).rejects.toThrow("DISCONNECTED");
    expect(f.spans.page({}).items.every((s) => s.status === "completed")).toBe(true);
  });

  it("does not change model results when diagnostic startup fails", async () => {
    const f = setup();
    f.telemetry.start = () => {
      throw new Error("observer unavailable");
    };
    expect(await f.runtime.completeLeaf({ id: "plain" }, leafInput)).toBe('{"kind":"none"}');
    expect(f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
      "completed",
    );
    expect(f.spans.page({}).items).toHaveLength(0);
  });
});

it("normalises our own lowercase codes instead of burying them as AGENT_FAILED", () => {
  // 瀑布里的原因不该因为大小写就消失；但任意外来文本（URL、provider 文案）
  // 仍然不许变成可搜索的诊断码。
  expect(traceErrorCode({ code: "binding_changed" })).toBe("BINDING_CHANGED");
  expect(traceErrorCode({ code: "https://PRIVATE_TOKEN" })).toBe("AGENT_FAILED");
});
