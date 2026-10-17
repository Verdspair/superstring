import { afterEach, describe, expect, it } from "bun:test";
import { projectConversationEvent } from "../../src/server/conversation/conversation-view";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";

const at = "2026-10-17T02:00:00.000Z";
const handles: ReturnType<typeof openBusinessDb>[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function setup() {
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "model");
  handle.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)")
    .run(at, at);
  handle.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','100','group','200',?,'scheme',?,?)",
    )
    .run(DEFAULT_AGENT_ID, at, at);
  const journal = new ConversationEventRepository(handle.db);
  const conversation = journal.ensureOneBot("binding")!;
  const wakes = new WakeRepository(handle.db);
  const runs = new AgentRunRepository(handle.db);
  return { ...handle, journal, conversation, wakes, runs };
}

function offerWake(h: ReturnType<typeof setup>, cause = "chiming_in") {
  return h.wakes.enqueue({
    conversationId: h.conversation.id,
    cause,
    throughSeq: 0,
    dedupeKey: `wake:${crypto.randomUUID()}`,
    readyAt: at,
    priority: 50,
    at,
  });
}

function wakeEvent(h: ReturnType<typeof setup>, wakeId: string) {
  return h.journal
    .eventsAfter(h.conversation.id)
    .items.find((event) => event.source.id === wakeId)!;
}

function settle(
  h: ReturnType<typeof setup>,
  wake: ReturnType<typeof offerWake>,
  errorCode: string | null = null,
) {
  const lease = h.wakes.claim({ at, leaseMs: 1000, wakeId: wake.id })!;
  h.wakes.complete(lease.id, lease.leaseToken!, "no_output", 0, at);
  if (errorCode)
    h.db.query("UPDATE wake_signals SET error_code=? WHERE id=?").run(errorCode, wake.id);
}

function addRun(
  h: ReturnType<typeof setup>,
  wakeId: string,
  input: {
    runId: string;
    specId: string;
    ownerKind: "conversation" | "qq_binding";
    ownerId: string;
    agentId?: string | null;
    phase?: "leaf" | "next" | "vision";
    stepStatus?: "running" | "completed" | "failed" | "cancelled";
    leaveRunning?: boolean;
    decision?: unknown;
  },
) {
  h.runs.createRun({
    runId: input.runId,
    specId: input.specId,
    specVersion: "1",
    owner: {
      kind: input.ownerKind,
      id: input.ownerId,
      userId: DEFAULT_USER_ID,
      agentId: input.agentId ?? DEFAULT_AGENT_ID,
    },
    at,
  });
  h.journal.linkRun(input.runId, h.conversation.id, 0, wakeId);
  if (input.agentId === null)
    h.db.query("UPDATE agent_runs SET agent_id=NULL WHERE run_id=?").run(input.runId);
  if (input.phase) {
    const stepId = `${input.runId}-step`;
    h.runs.startStep({
      runId: input.runId,
      stepId,
      stepNo: 1,
      model: "model",
      phase: input.phase,
      at,
      messages: [],
      sources: [],
    });
    if (!input.leaveRunning)
      h.runs.finishStep(stepId, input.stepStatus ?? "completed", at, {
        ...(input.decision === undefined ? {} : { decision: input.decision }),
      });
  }
}

describe("initiative wake judgement history marker", () => {
  it("marks a preflight no-eligible-source outcome as not judged", () => {
    const h = setup();
    const wake = offerWake(h);
    settle(h, wake, "BATCH_NO_ELIGIBLE_SOURCE");

    const view = projectConversationEvent(h.db, wakeEvent(h, wake.id), at);
    expect(view.wake?.judgmentStarted).toBe(false);
  });

  it("marks only a persisted batch-evaluation leaf as an actual initiative judgement", () => {
    const h = setup();
    const wake = offerWake(h);
    settle(h, wake);
    addRun(h, wake.id, {
      runId: "initiative-evaluation",
      specId: "onebot.initiative.evaluate_batch",
      ownerKind: "qq_binding",
      ownerId: "binding",
      phase: "leaf",
      decision: { kind: "allowed" },
    });

    expect(projectConversationEvent(h.db, wakeEvent(h, wake.id), at).wake?.judgmentStarted).toBe(
      true,
    );
  });

  it("keeps a completed model none decision visible", () => {
    const h = setup();
    const wake = offerWake(h);
    settle(h, wake);
    addRun(h, wake.id, {
      runId: "initiative-reply-none",
      specId: "onebot.main",
      ownerKind: "conversation",
      ownerId: h.conversation.id,
      phase: "next",
      decision: "none",
    });

    expect(projectConversationEvent(h.db, wakeEvent(h, wake.id), at).wake?.judgmentStarted).toBe(
      true,
    );
  });

  it("counts a persisted running or failed intent step as started", () => {
    const h = setup();
    const runningWake = offerWake(h);
    settle(h, runningWake);
    addRun(h, runningWake.id, {
      runId: "initiative-reply-running",
      specId: "onebot.main",
      ownerKind: "conversation",
      ownerId: h.conversation.id,
      phase: "next",
      leaveRunning: true,
    });
    const failedWake = offerWake(h);
    settle(h, failedWake);
    addRun(h, failedWake.id, {
      runId: "initiative-reply-failed",
      specId: "onebot.main",
      ownerKind: "conversation",
      ownerId: h.conversation.id,
      phase: "next",
      stepStatus: "failed",
    });

    expect(
      projectConversationEvent(h.db, wakeEvent(h, runningWake.id), at).wake?.judgmentStarted,
    ).toBe(true);
    expect(
      projectConversationEvent(h.db, wakeEvent(h, failedWake.id), at).wake?.judgmentStarted,
    ).toBe(true);
  });

  it("does not count a parent batch run without an intent step", () => {
    const h = setup();
    const wake = offerWake(h);
    settle(h, wake);
    addRun(h, wake.id, {
      runId: "initiative-parent-only",
      specId: "onebot.initiative.batch",
      ownerKind: "conversation",
      ownerId: h.conversation.id,
    });

    expect(projectConversationEvent(h.db, wakeEvent(h, wake.id), at).wake?.judgmentStarted).toBe(
      false,
    );
  });

  it("does not count a media-only main step or a foreign-agent judge run", () => {
    const h = setup();
    const wake = offerWake(h);
    settle(h, wake);
    addRun(h, wake.id, {
      runId: "initiative-media-only",
      specId: "onebot.main",
      ownerKind: "conversation",
      ownerId: h.conversation.id,
      phase: "vision",
    });
    addRun(h, wake.id, {
      runId: "foreign-agent-evaluation",
      specId: "onebot.initiative.evaluate_batch",
      ownerKind: "qq_binding",
      ownerId: "binding",
      agentId: "foreign-agent",
      phase: "leaf",
    });
    addRun(h, wake.id, {
      runId: "foreign-binding-evaluation",
      specId: "onebot.initiative.evaluate_batch",
      ownerKind: "qq_binding",
      ownerId: "another-binding",
      phase: "leaf",
    });
    addRun(h, wake.id, {
      runId: "unscoped-agent-evaluation",
      specId: "onebot.initiative.evaluate_batch",
      ownerKind: "qq_binding",
      ownerId: "binding",
      agentId: null,
      phase: "leaf",
    });

    expect(projectConversationEvent(h.db, wakeEvent(h, wake.id), at).wake?.judgmentStarted).toBe(
      false,
    );
  });

  it("leaves unknown terminal legacy wakes unclassified and direct replies unchanged", () => {
    const h = setup();
    const unknownWake = offerWake(h);
    settle(h, unknownWake);
    const unknown = projectConversationEvent(h.db, wakeEvent(h, unknownWake.id), at);
    expect(unknown.wake?.judgmentStarted).toBeUndefined();

    const directWake = offerWake(h, "direct_reply");
    settle(h, directWake);
    addRun(h, directWake.id, {
      runId: "direct-reply-run",
      specId: "onebot.main",
      ownerKind: "conversation",
      ownerId: h.conversation.id,
      phase: "next",
    });
    const direct = projectConversationEvent(h.db, wakeEvent(h, directWake.id), at);
    expect(direct.wake?.judgmentStarted).toBeUndefined();
  });

  it("classifies a known pending initiative without judgement separately", () => {
    const h = setup();
    const wake = offerWake(h);
    const view = projectConversationEvent(h.db, wakeEvent(h, wake.id), at);
    expect(view.wake?.judgmentStarted).toBe(false);
  });
});
