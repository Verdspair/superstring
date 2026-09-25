import { describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { textMessage } from "../../src/server/agent/context-engine";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  createSession,
  ensureDefaults,
  getMessage,
  getTurnByRequest,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

describe("common ConversationHost", () => {
  it("binds channel identity and runs one shared Agent protocol", async () => {
    const business = openBusinessDb();
    try {
      const repository = new AgentRunRepository(business.db);
      const runtime = new AgentRuntime({
        repository,
        model: {
          async complete() {
            return '{"kind":"none"}';
          },
          async *streamText() {
            yield "unused";
          },
          async completeMultimodal() {
            return "unused";
          },
        },
      });
      const host = new ConversationHost({ runtime });
      const result = await host.activate({
        conversation: {
          id: "conversation",
          channel: "onebot11",
          topology: "direct",
          agentId: "agent",
        },
        owner: { kind: "wake", id: "wake" },
        spec: { id: "main", context: "conversation", limits: { steps: 4 }, availableActions: [] },
        context: {
          async read() {
            return { pending: [textMessage("user", "hello")] };
          },
        },
        authorizedTargets: ["peer"],
        outputMode: "buffered",
      });
      expect(repository.getRun(result.runId)?.owner.agentId).toBe("agent");
      expect(
        repository
          .listEvents(result.runId)
          .every((event) => event.conversationId === "conversation"),
      ).toBe(true);
      expect(result.status).toBe("no_output");
    } finally {
      business.close();
    }
  });

  it("rolls back message, turn, and run terminal together when a later host write fails", () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "model");
      const session = createSession(business.orm, "test", { modelName: "model" });
      const prepared = prepareTurn(business.orm, session.id, "question", "request");
      const turnBefore = getTurnByRequest(business.orm, session.id, "request");
      const messageBefore = getMessage(business.orm, session.id, prepared.messageId);
      const repository = new AgentRunRepository(business.db);
      repository.createRun({
        runId: "run",
        specId: "main",
        specVersion: "1",
        owner: { kind: "web_turn", id: turnBefore?.id ?? "missing" },
        at: "2026-01-01",
      });
      expect(() =>
        business.db
          .transaction(() => {
            saveCompletedAssistantMessage(
              business.orm,
              session.id,
              "answer",
              "request",
              prepared.generationToken ?? "missing",
            );
            repository.finishRun(
              "run",
              "completed",
              { type: "completed", outputs: [] },
              "2026-01-02",
            );
            business.db.run("INSERT INTO table_that_does_not_exist VALUES (1)");
          })
          .immediate(),
      ).toThrow();
      expect(getMessage(business.orm, session.id, prepared.messageId)).toEqual(messageBefore);
      expect(getTurnByRequest(business.orm, session.id, "request")).toEqual(turnBefore);
      expect(repository.getRun("run")?.status).toBe("prepared");
      expect(repository.listEvents("run")).toEqual([]);
    } finally {
      business.close();
    }
  });
});
