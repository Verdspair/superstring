import { describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import { chatV2Routes } from "../../src/server/api/chat-v2";
import { DatabaseError } from "../../src/server/api/error-handler";
import { parseSseFrames } from "../../src/server/api/sse";
import { createApp } from "../../src/server/app";
import { WebChannel } from "../../src/server/channels/web-channel";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  createSession,
  ensureDefaults,
  getTurnByRequest,
  listMessages,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type { ChatV2Event } from "../../src/shared/contracts/chat-v2";
import { ChatV2EventSchema } from "../../src/shared/contracts/chat-v2";

class Gateway implements ModelGateway {
  config = { baseUrl: "http://unused", model: "model", timeoutSeconds: 60 };
  decisions: unknown[] = [
    { kind: "final", outputs: [{ kind: "generate", targetId: "reply", instructions: "" }] },
  ];
  deltas = ["answer"];
  fail?: Error;
  completeCalls: Parameters<ModelGateway["complete"]>[0][] = [];
  streamCalls: Parameters<ModelGateway["streamChat"]>[0][] = [];
  async listModels() {
    return ["model"];
  }
  async loadedContextCapacity() {
    return 32768;
  }
  async probeModelLoaded() {
    return true;
  }
  async complete(input: Parameters<ModelGateway["complete"]>[0]) {
    this.completeCalls.push(input);
    return JSON.stringify(this.decisions.shift());
  }
  async *streamChat(input: Parameters<ModelGateway["streamChat"]>[0]) {
    this.streamCalls.push(input);
    for (const delta of this.deltas) yield delta;
    if (this.fail) throw this.fail;
  }
}
function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "model");
  const session = createSession(business.orm, "test", { modelName: "model" });
  const gateway = new Gateway();
  return { business, session, gateway };
}
async function collect(reply: AsyncGenerator<ChatV2Event>) {
  const result: ChatV2Event[] = [];
  for await (const e of reply) result.push(e);
  return result;
}

describe("Web Agent and v2 streaming", () => {
  for (const rollback of [false, true])
    it(`commits failure partial, journal and terminal atomically (rollback=${rollback})`, async () => {
      const { business, session, gateway } = setup();
      try {
        const repository = new AgentRunRepository(business.db);
        const runtime = createAgentRuntime({ gateway, repository });
        const finish = repository.finishRun.bind(repository);
        let sawPartialInTerminalTransaction = false;
        repository.finishRun = (...args) => {
          if (args[1] !== "failed") return finish(...args);
          sawPartialInTerminalTransaction =
            listMessages(business.orm, session.id).find((message) => message.role === "assistant")
              ?.content === "partial";
          const event = finish(...args);
          if (rollback) throw new DatabaseError("terminal transaction failed");
          return event;
        };
        gateway.deltas = ["partial"];
        gateway.fail = new Error("inference failed");
        const channel = new WebChannel({
          db: business.db,
          orm: business.orm,
          gateway,
          agentRuntime: runtime,
        });
        const events: ChatV2Event[] = [];
        await expect(
          (async () => {
            for await (const event of await channel.openReply({
              sessionId: session.id,
              message: "question",
              clientRequestId: "failure",
            }))
              events.push(event);
          })(),
        ).rejects.toMatchObject({ code: rollback ? "DATABASE_UNAVAILABLE" : "MODEL_ERROR" });
        expect(sawPartialInTerminalTransaction).toBe(true);
        const runEvent = events.find((event) => event.type === "started");
        if (runEvent?.type !== "started") throw Error("missing run");
        const assistant = listMessages(business.orm, session.id).find(
          (message) => message.role === "assistant",
        );
        expect(assistant?.status).toBe(rollback ? "pending" : "failed");
        expect(assistant?.content).toBe(rollback ? "" : "partial");
        expect(repository.getRun(runEvent.runId)?.status).toBe(rollback ? "generating" : "failed");
        expect(repository.listEvents(runEvent.runId).some((event) => event.type === "failed")).toBe(
          !rollback,
        );
        const journal = new ConversationEventRepository(business.db);
        const conversation = journal.ensureWeb(session.id);
        expect(conversation?.lastSeq).toBe(rollback ? 1 : 2);
        expect(conversation?.consumedSeq).toBe(0);
      } finally {
        business.close();
      }
    });
  it("preserves the existing whitespace contract through both runtime and channel", async () => {
    const { business, session, gateway } = setup();
    try {
      const channel = new WebChannel({ db: business.db, orm: business.orm, gateway });
      gateway.deltas = ["", "\uFEFF", ""];
      const kept = await collect(
        await channel.openReply({
          sessionId: session.id,
          message: "first",
          clientRequestId: "bom",
        }),
      );
      expect(kept.filter((event) => event.type === "output_delta")).toHaveLength(1);
      expect(kept.at(-1)?.type).toBe("completed");
      expect(
        listMessages(business.orm, session.id).find((message) => message.role === "assistant")
          ?.content,
      ).toBe("\uFEFF");
      gateway.decisions = [
        { kind: "final", outputs: [{ kind: "generate", targetId: "reply", instructions: "" }] },
      ];
      gateway.deltas = ["\u0085"];
      await expect(
        collect(
          await channel.openReply({
            sessionId: session.id,
            message: "second",
            clientRequestId: "nel",
          }),
        ),
      ).rejects.toMatchObject({ code: "MODEL_EMPTY_RESPONSE" });
    } finally {
      business.close();
    }
  });
  it("iterates read-observe-decide with initial context prepared once and stable output identity", async () => {
    const { business, session, gateway } = setup();
    try {
      gateway.decisions = [
        { kind: "invoke", name: "memory.query", arguments: { query: "second query" } },
        {
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "reply", instructions: "answer the original question" },
          ],
        },
      ];
      const builder = new ContextBuilder({ db: business.db, orm: business.orm, gateway });
      const original = builder.build.bind(builder);
      let builds = 0;
      builder.build = async (args) => {
        builds++;
        return original(args);
      };
      const channel = new WebChannel({
        db: business.db,
        orm: business.orm,
        gateway,
        contextBuilder: builder,
      });
      const events = await collect(
        await channel.openReply({
          sessionId: session.id,
          message: "question",
          clientRequestId: "request",
        }),
      );
      const run = events.find((e) => e.type === "started");
      expect(run?.type).toBe("started");
      if (run?.type !== "started") throw Error("missing started");
      expect(run.requestId).toBe("request");
      expect(builds).toBe(1);
      expect(events.some((e) => e.type === "action_result" && e.name === "memory.query")).toBe(
        true,
      );
      const output = events.find((e) => e.type === "output_delta");
      const done = events.at(-1);
      expect(done?.type).toBe("completed");
      if (output?.type !== "output_delta" || done?.type !== "completed")
        throw Error("missing output");
      expect(output.outputId).toBe(done.messageId ?? "missing");
      const persisted = listMessages(business.orm, session.id).find((m) => m.role === "assistant");
      expect(persisted?.content).toBe("answer");
      expect(persisted?.id).toBe(output.outputId);
      expect(gateway.completeCalls).toHaveLength(2);
      const usages = events.filter((event) => event.type === "context_usage");
      expect(usages.at(-1)?.usage.components.long_term_memory).toBeGreaterThan(
        usages[0]?.usage.components.long_term_memory ?? 0,
      );
      for (const event of usages)
        expect(Object.values(event.usage.components).reduce((a, b) => a + b, 0)).toBe(
          event.usage.input_units,
        );
      expect(
        gateway.completeCalls[1]?.messages.some((m) => m.content.includes('"action_observation"')),
      ).toBe(true);
      expect(gateway.streamCalls[0]?.messages.at(-1)?.content).toBe("question");
      expect(gateway.streamCalls[0]?.messages[0]?.content).not.toContain(
        "Return exactly one JSON decision",
      );
      const journal = new ConversationEventRepository(business.db);
      const c = journal.ensureWeb(session.id);
      expect(c?.consumedSeq).toBe(1);
      expect(c?.lastSeq).toBe(2);
      const repo = new AgentRunRepository(business.db);
      expect(repo.getRun(run.runId)?.status).toBe("completed");
      expect(repo.getRun(run.runId)?.steps.map((s) => s.phase)).toEqual([
        "next",
        "next",
        "generate",
      ]);
      const sequences = events.filter((e) => e.type !== "replay").map((e) => e.seq);
      expect(sequences).toEqual(sequences.map((_, i) => i + 1));
      expect(
        repo
          .listEvents(run.runId)
          .filter((e) => e.type === "output_delta")
          .every((e) => e.text === ""),
      ).toBe(true);
      for (const event of events) expect(ChatV2EventSchema.safeParse(event).success).toBe(true);
      const replay = await collect(
        await channel.openReply({
          sessionId: session.id,
          message: "question",
          clientRequestId: "request",
        }),
      );
      expect(replay).toHaveLength(1);
      expect(replay[0]?.type).toBe("replay");
      expect(gateway.completeCalls).toHaveLength(2);
    } finally {
      business.close();
    }
  });
  it("keeps failure partials before terminal and retries with a new run on the same reserved message", async () => {
    const { business, session, gateway } = setup();
    try {
      gateway.deltas = ["partial"];
      gateway.fail = new Error("broken");
      const channel = new WebChannel({ db: business.db, orm: business.orm, gateway });
      const first: ChatV2Event[] = [];
      try {
        for await (const event of await channel.openReply({
          sessionId: session.id,
          message: "question",
          clientRequestId: "request",
        })) {
          first.push(event);
          if (event.type === "failed")
            expect(
              listMessages(business.orm, session.id).find((m) => m.role === "assistant")?.content,
            ).toBe("partial");
        }
      } catch {
        /* The v1 facade receives the classified legacy error after the v2 terminal. */
      }
      expect(first.at(-1)?.type).toBe("failed");
      const before = listMessages(business.orm, session.id).find((m) => m.role === "assistant");
      expect(before?.status).toBe("failed");
      gateway.fail = undefined;
      gateway.deltas = ["retried"];
      gateway.decisions = [
        { kind: "final", outputs: [{ kind: "generate", targetId: "reply", instructions: "" }] },
      ];
      const second = await collect(
        await channel.openReply({
          sessionId: session.id,
          message: "question",
          clientRequestId: "request",
        }),
      );
      const a = first[0],
        b = second[0];
      if (!a || !b || a.type === "replay" || b.type === "replay") throw Error("missing runs");
      expect(a.runId).not.toBe(b.runId);
      expect(b.seq).toBe(1);
      expect(listMessages(business.orm, session.id).find((m) => m.role === "assistant")?.id).toBe(
        before?.id,
      );
      expect(getTurnByRequest(business.orm, session.id, "request")?.generationStatus).toBe(
        "completed",
      );
    } finally {
      business.close();
    }
  });
  it("serves typed full SSE records and preserves eager JSON preparation errors", async () => {
    const { business, session, gateway } = setup();
    try {
      const app = createApp({ business, gateway });
      app.route("/", chatV2Routes({ db: business.db, orm: business.orm, gateway }));
      const response = await app.request("/v2/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: session.id,
          message: "question",
          client_request_id: "request",
        }),
      });
      expect(response.status).toBe(200);
      const frames = parseSseFrames(await response.text());
      expect(frames[0]?.event).toBe("started");
      expect(frames.at(-1)?.event).toBe("completed");
      for (const frame of frames) {
        const parsed = ChatV2EventSchema.parse(frame.data);
        expect(frame.event).toBe(parsed.type);
      }
      const conflict = await app.request("/v2/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: session.id,
          message: "different",
          client_request_id: "request",
        }),
      });
      expect(conflict.status).toBe(409);
      expect(conflict.headers.get("content-type")).toContain("application/json");
    } finally {
      business.close();
    }
  });
});
