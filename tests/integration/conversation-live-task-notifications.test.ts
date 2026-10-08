import { afterEach, describe, expect, it } from "bun:test";
import {
  type ConversationChange,
  subscribeConversationChanges,
} from "../../src/server/conversation/conversation-changes";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_AGENT_ID, DEFAULT_USER_ID } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("conversation changes for live Agent runs", () => {
  it("notifies after a conversation run is durably created and first model step starts", async () => {
    const h = openBusinessDb();
    handles.push(h);
    const session = createSession(h.orm, "live-run-notification", { modelName: "fixture" });
    const conversation = new ConversationEventRepository(h.db).ensureWeb(session.id)!;
    const changes: ConversationChange[] = [];
    const unsubscribe = subscribeConversationChanges(h.db, (change) => changes.push(change));
    const runs = new AgentRunRepository(h.db);
    const runId = crypto.randomUUID();
    runs.createRun({
      runId,
      specId: "fixture",
      specVersion: "1",
      owner: {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
      at: new Date().toISOString(),
    });
    await tick();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.conversationId).toBe(conversation.id);
    expect(
      (h.db.query("SELECT status FROM agent_runs WHERE run_id=?").get(runId) as { status: string })
        .status,
    ).toBe("prepared");
    const source = { kind: "fixture", id: "source", revision: "1" };
    runs.startStep({
      runId,
      stepId: crypto.randomUUID(),
      stepNo: 1,
      model: "fixture-model",
      phase: "next",
      at: new Date().toISOString(),
      messages: [{ role: "user", content: [{ kind: "text", text: "synthetic" }] }],
      sources: [source],
    });
    await tick();
    expect(changes).toHaveLength(2);
    expect(changes[1]?.conversationId).toBe(conversation.id);
    expect(runs.getRun(runId)?.endedAt).toBeNull();
    runs.setStatus(runId, "generating", new Date().toISOString());
    await tick();
    expect(changes).toHaveLength(3);
    unsubscribe();
  });

  it("does not publish for a run owner without a conversation mapping", async () => {
    const h = openBusinessDb();
    handles.push(h);
    const changes: ConversationChange[] = [];
    const unsubscribe = subscribeConversationChanges(h.db, (change) => changes.push(change));
    new AgentRunRepository(h.db).createRun({
      runId: crypto.randomUUID(),
      specId: "fixture",
      specVersion: "1",
      owner: {
        kind: "memory_job",
        id: "synthetic-job",
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
      at: new Date().toISOString(),
    });
    await tick();
    expect(changes).toEqual([]);
    unsubscribe();
  });
});
