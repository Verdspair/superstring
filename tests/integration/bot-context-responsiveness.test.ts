import { afterEach, describe, expect, it } from "bun:test";
import { setImmediate as tick } from "node:timers/promises";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { ActionObservation } from "../../src/server/agent/context-engine";
import {
  BotContextSource,
  type BotContextSourceOptions,
} from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  bodyRevision,
  ConversationEventRepository,
} from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const NOW = "2026-10-23T12:00:00.000Z",
  EXPIRES = "2026-10-24T12:00:00.000Z";
const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
function fixture(overrides: Partial<BotContextSourceOptions> = {}) {
  const h = openBusinessDb({ path: ":memory:" });
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "responsive-context" });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(h.orm, created.binding);
  const capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("snapshot");
  const agent = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!agent) throw new Error("agent");
  const runtime = runtimeFromAgent(agent);
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.compression_enabled = false;
  runtime.p5_config.recent_turns = 1;
  const journal = new ConversationEventRepository(h.db),
    outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const refs: SourceRef[] = [];
  h.db.transaction(() => {
    for (let index = 0; index < 4000; index++) {
      const id = `responsive-event-${index}`,
        body = `synthetic source ${index}`;
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: id,
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
          messageId: id,
          occurredAtSeconds: Date.parse(NOW) / 1000,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: NOW,
        })
        .run();
      h.orm
        .insert(schema.qqObservationText)
        .values({
          eventKey: id,
          body,
          occurredAtSeconds: Date.parse(NOW) / 1000,
          expiresAt: EXPIRES,
          recordedAt: NOW,
        })
        .run();
      journal.ingestOneBotEvent(id, binding.id);
      refs.push({ kind: "qq_observation", id, revision: bodyRevision(body), expiresAt: EXPIRES });
    }
  })();
  const runs = new AgentRunRepository(h.db);
  const owner = {
    kind: "qq_binding" as const,
    id: binding.id,
    agentId: DEFAULT_AGENT_ID,
    userId: DEFAULT_USER_ID,
  };
  for (let index = 0; index < 5; index++) {
    const wake = `responsive-wake-${index}`,
      runId = `responsive-score-${index}`,
      stepId = `responsive-step-${index}`;
    h.db
      .query(
        "INSERT INTO wake_signals(id,conversation_id,cause,through_seq,dedupe_key,ready_at,priority,status,created_at) VALUES(?,?,'chiming_in',2,?,?,50,'completed',?)",
      )
      .run(wake, conversation.id, wake, NOW, NOW);
    h.db
      .query(
        "INSERT INTO qq_conversation_tasks(id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,source_from_seq,source_through_seq,status,judgement_done,origin_wake_id,created_at,updated_at) VALUES(?,?,?,1,?,'ordinary','chiming_in',1,2,'pending',1,?,?,?)",
      )
      .run(
        `responsive-task-${index}`,
        `responsive-key-${index}`,
        conversation.id,
        DEFAULT_AGENT_ID,
        wake,
        NOW,
        NOW,
      );
    runs.createRun({
      runId,
      specId: "onebot.initiative.evaluate_batch",
      specVersion: "1",
      owner,
      at: NOW,
    });
    h.db
      .query("UPDATE agent_runs SET conversation_id=?,wake_id=?,observed_seq=2 WHERE run_id=?")
      .run(conversation.id, wake, runId);
    const envelope = {
      kind: "qq_batch_targets",
      trust: "data_only",
      sourceSeqs: [1, 2],
      targets: [{ targetId: "member", speakerId: "20002", sourceSeqs: [2] }],
    };
    runs.startStep({
      runId,
      stepId,
      stepNo: 1,
      model: "synthetic",
      phase: "leaf",
      at: NOW,
      messages: [{ role: "user", content: [{ kind: "text", text: JSON.stringify(envelope) }] }],
      sources: refs,
    });
    runs.finishStep(stepId, "completed", NOW, {
      output: {
        text: JSON.stringify({
          evaluations: [
            { targetId: "member", score: 8, intent: "synthetic intent", sourceSeqs: [1] },
          ],
        }),
        format: "text",
        complete: true,
      },
    });
    runs.setStatus(runId, "completed", NOW);
  }
  const forbidden = async () => {
    throw new Error("no model calls in responsiveness fixture");
  };
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "synthetic", timeoutSeconds: 1 },
    listModels: forbidden,
    probeModelLoaded: forbidden,
    loadedContextCapacity: async () => 1048576,
    complete: forbidden,
    async *streamChat() {
      yield "";
      throw new Error("no streaming");
    },
  };
  const spec: AgentSpec = {
    id: "test.responsive-context",
    model: "synthetic",
    context: "conversation",
    instructions: "synthetic context",
    availableActions: [],
    limits: { steps: 16 },
  };
  const state = { now: NOW, hostCurrent: true, hostChecks: 0 };
  const source = new BotContextSource({
    ...h,
    gateway,
    agentRuntime: createAgentRuntime({ gateway, repository: runs }),
    journal,
    outbox,
    conversationId: conversation.id,
    binding,
    snapshot: capture.snapshot,
    scheme,
    runtime,
    spec,
    path: "direct_reply",
    decisionTier: "reply",
    targets: () => [{ id: "member", speakerId: "20002" }],
    assertCurrent() {
      state.hostChecks++;
      if (!state.hostCurrent) throw new Error("lease revoked during preparation");
    },
    now: () => state.now,
    ...overrides,
  });
  spec.availableActions = source.actions.map((action) => action.description);
  const observations: ActionObservation[] = [
    {
      id: "responsive-observation",
      name: "history.query",
      value: { status: "ok", items: [] },
      sources: refs,
    },
  ];
  return { ...h, source, observations, state };
}
function start(f: ReturnType<typeof fixture>, controller = new AbortController()) {
  const state = { settled: false };
  const outcome = f.source.read({ signal: controller.signal, observations: f.observations }).then(
    (value) => {
      state.settled = true;
      return { ok: true as const, value };
    },
    (error) => {
      state.settled = true;
      return { ok: false as const, error };
    },
  );
  return { state, outcome };
}
describe("large QQ preparation yields to real event-loop work", () => {
  it("services more than one I/O turn before material preparation finishes", async () => {
    const f = fixture(),
      read = start(f);
    await tick();
    const firstPending = !read.state.settled;
    await tick();
    const secondPending = !read.state.settled;
    const outcome = await read.outcome;
    expect(firstPending).toBe(true);
    expect(secondPending).toBe(true);
    expect(outcome.ok).toBe(true);
  });
  it("does not publish an older preparation after a newer read takes ownership", async () => {
    const f = fixture(),
      older = start(f);
    await tick();
    const newer = start(f);
    const [oldOutcome, newOutcome] = await Promise.all([older.outcome, newer.outcome]);
    expect(oldOutcome.ok).toBe(false);
    if (!oldOutcome.ok) expect(oldOutcome.error.code).toBe("CONTEXT_SOURCE_INVALID");
    expect(newOutcome.ok).toBe(true);
  });
  it("honors cancellation delivered while material is being prepared", async () => {
    const f = fixture(),
      controller = new AbortController(),
      read = start(f, controller);
    await tick();
    controller.abort(new Error("cancelled during preparation"));
    const outcome = await read.outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(String(outcome.error)).toContain("cancelled during preparation");
  });
  it("does not publish source material revoked across an I/O yield", async () => {
    const f = fixture(),
      read = start(f);
    await tick();
    f.db
      .query("UPDATE qq_observation_text SET body='changed' WHERE event_key='responsive-event-0'")
      .run();
    const outcome = await read.outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("CONTEXT_SOURCE_INVALID");
  });
  it("rechecks host authority after yielding rather than reusing a proof", async () => {
    const f = fixture(),
      read = start(f);
    await tick();
    f.state.hostCurrent = false;
    const outcome = await read.outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(String(outcome.error)).toContain("lease revoked during preparation");
  });
  it("does not carry a source expiry proof across preparation yields", async () => {
    const f = fixture(),
      read = start(f);
    await tick();
    f.state.now = EXPIRES;
    const outcome = await read.outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("CONTEXT_SOURCE_INVALID");
  });

  it("delivers I/O cancellation after final view proof but before read returns", async () => {
    const controller = new AbortController();
    let proofCalls = 0;
    let cancellationDelivered = false;
    const f = fixture({
      resolveSource: (source) => {
        if (source.id !== "return-boundary") return undefined;
        proofCalls++;
        // This fixture sees the ref first in prelude and then in the final candidate proof.
        if (proofCalls === 2)
          setImmediate(() => {
            cancellationDelivered = true;
            controller.abort(new Error("cancelled between view and return"));
          });
        return "available";
      },
    });
    f.observations = [
      {
        id: "return-boundary-observation",
        name: "history.query",
        value: { status: "ok", items: [] },
        sources: [{ kind: "remote_document", id: "return-boundary", revision: "1" }],
      },
    ];
    const read = start(f, controller);
    const outcome = await read.outcome;
    expect(proofCalls).toBeGreaterThanOrEqual(2);
    expect(cancellationDelivered).toBe(true);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(String(outcome.error)).toContain("cancelled between view and return");
    await tick();
  });

  it("lets a superseding read own prelude before obsolete observation checks or mutations", async () => {
    const seen: string[] = [];
    const f = fixture({
      resolveSource: (source) => {
        if (source.kind !== "remote_document") return undefined;
        seen.push(source.id);
        return "available";
      },
    });
    const observation = (id: string): ActionObservation => ({
      id,
      name: "history.query",
      value: { status: "ok", marker: id },
      sources: [{ kind: "remote_document", id, revision: "1" }],
    });
    const oldResult = f.source
      .read({
        signal: new AbortController().signal,
        observations: [observation("obsolete-prelude")],
      })
      .then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );
    const newResult = f.source.read({
      signal: new AbortController().signal,
      observations: [observation("current-prelude")],
    });
    const [older, material] = await Promise.all([oldResult, newResult]);
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.error.code).toBe("CONTEXT_SOURCE_INVALID");
    expect(seen).not.toContain("obsolete-prelude");
    expect(seen).toContain("current-prelude");
    expect(f.source.commonSources.some((source) => source.id === "obsolete-prelude")).toBe(false);
    expect(f.source.commonSources.some((source) => source.id === "current-prelude")).toBe(true);
    expect(material).toBeDefined();
  });

  it("services I/O between concurrent sources' first preparation callbacks", async () => {
    let sentinelDelivered = false;
    let firstPrelude = true;
    const firstChecks: { id: string; sentinelDelivered: boolean }[] = [];
    const readers = ["left", "middle", "right"].map((id) => {
      let checked = false;
      const f = fixture({
        resolveSource: (source) => {
          if (source.kind !== "remote_document" || source.id !== `fifo-${id}`) return undefined;
          if (!checked) {
            checked = true;
            firstChecks.push({ id, sentinelDelivered });
            if (firstPrelude) {
              firstPrelude = false;
              setImmediate(() => {
                sentinelDelivered = true;
              });
            }
          }
          return "available";
        },
      });
      f.observations = [
        {
          id: `fifo-observation-${id}`,
          name: "history.query",
          value: { status: "ok", items: [] },
          sources: [{ kind: "remote_document", id: `fifo-${id}`, revision: "1" }],
        },
      ];
      return start(f).outcome;
    });
    const results = await Promise.all(readers);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(firstChecks).toHaveLength(3);
    expect(firstChecks[0]?.sentinelDelivered).toBe(false);
    expect(firstChecks[1]?.sentinelDelivered).toBe(true);
    expect(firstChecks[2]?.sentinelDelivered).toBe(true);
  });
});

describe("cached Bot preparation keeps I/O and view ownership", () => {
  async function warm(onFirstProof: () => void = () => {}) {
    const state = {
      armed: false,
      first: false,
      second: false,
      sentinelDelivered: false,
      secondProofSawIO: false,
    };
    const f = fixture({
      resolveSource: (source) => {
        if (source.kind !== "remote_document" || !source.id.startsWith("cached-step-"))
          return undefined;
        if (state.armed && source.id === "cached-step-0" && !state.first) {
          state.first = true;
          setImmediate(() => {
            state.sentinelDelivered = true;
            onFirstProof();
          });
        }
        if (state.armed && source.id === "cached-step-1" && !state.second) {
          state.second = true;
          state.secondProofSawIO = state.sentinelDelivered;
        }
        return "available";
      },
    });
    await f.source.read({ signal: new AbortController().signal, observations: f.observations });
    for (let index = 0; index < 5; index++) {
      const row = f.db
        .query("SELECT source_refs AS refs FROM context_snapshots WHERE step_id=?")
        .get(`responsive-step-${index}`) as { refs: string };
      f.db
        .query("UPDATE context_snapshots SET source_refs=? WHERE step_id=?")
        .run(
          JSON.stringify([
            ...JSON.parse(row.refs),
            { kind: "remote_document", id: `cached-step-${index}`, revision: "1" },
          ]),
          `responsive-step-${index}`,
        );
    }
    state.armed = true;
    return { ...f, cachedState: state };
  }
  const currentView = (f: Awaited<ReturnType<typeof warm>>) =>
    (
      f.source as unknown as {
        views: Map<
          string,
          { material: unknown; concurrentMessage?: unknown; concurrentSources: unknown }
        >;
      }
    ).views.get("reply");

  it("allows I/O between protected-step proofs on three warmed sources", async () => {
    const fixtures = await Promise.all([warm(), warm(), warm()]);
    const results = await Promise.all(fixtures.map((f) => start(f).outcome));
    expect(results.every((result) => result.ok)).toBe(true);
    for (const f of fixtures) {
      expect(f.cachedState.first).toBe(true);
      expect(f.cachedState.secondProofSawIO).toBe(true);
    }
  });
  it("cancels a cached refresh before mutating the retained view", async () => {
    const controller = new AbortController();
    const f = await warm(() => controller.abort(new Error("cancelled cached preparation")));
    const view = currentView(f);
    const material = view?.material,
      message = view?.concurrentMessage,
      sources = view?.concurrentSources;
    const result = await start(f, controller).outcome;
    await tick();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain("cancelled cached preparation");
    expect(currentView(f)).toBe(view);
    expect(view?.material).toBe(material);
    expect(view?.concurrentMessage).toBe(message);
    expect(view?.concurrentSources).toBe(sources);
  });
  it("rejects source revocation delivered between cached step proofs without publishing candidate state", async () => {
    let revoke = () => {};
    const f = await warm(() => revoke());
    const view = currentView(f),
      material = view?.material,
      message = view?.concurrentMessage,
      sources = view?.concurrentSources;
    revoke = () => {
      f.db
        .query(
          "UPDATE qq_observation_text SET body='changed cached source' WHERE event_key='responsive-event-0'",
        )
        .run();
    };
    const result = await start(f).outcome;
    await tick();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONTEXT_SOURCE_INVALID");
    expect(currentView(f)).toBe(view);
    expect(view?.material).toBe(material);
    expect(view?.concurrentMessage).toBe(message);
    expect(view?.concurrentSources).toBe(sources);
  });
  it("lets a newer read supersede cached refresh before the old candidate commits", async () => {
    let replace = () => {};
    const f = await warm(() => replace());
    const view = currentView(f),
      sources = view?.concurrentSources;
    let unchangedAtReplacement = false;
    let newer: ReturnType<typeof start> | undefined;
    replace = () => {
      unchangedAtReplacement = currentView(f) === view && view?.concurrentSources === sources;
      newer = start(f);
    };
    const older = await start(f).outcome;
    await tick();
    if (!newer) throw new Error("newer cached read did not start");
    const latest = await newer.outcome;
    expect(unchangedAtReplacement).toBe(true);
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.error.code).toBe("CONTEXT_SOURCE_INVALID");
    expect(latest.ok).toBe(true);
  });
  it("keeps the existing concurrent message identity when warmed facts are unchanged", async () => {
    const f = await warm();
    const view = currentView(f),
      message = view?.concurrentMessage;
    const result = await start(f).outcome;
    expect(result.ok).toBe(true);
    expect(currentView(f)).toBe(view);
    expect(view?.concurrentMessage).toBe(message);
  });
});

describe("cached preparation authority and publication proof ownership", () => {
  it("uses three complete source passes for a cached read, not a fourth preparation-entry pass", async () => {
    const f = fixture();
    await f.source.read({ signal: new AbortController().signal, observations: f.observations });
    let report: { readAssertCurrentCalls?: number; readAssertCommonOccurrences?: number } = {};
    await f.source.read({
      signal: new AbortController().signal,
      observations: f.observations,
      onReadTimings: (value) => {
        report = value;
      },
    });
    expect(report.readAssertCurrentCalls).toBe(3);
    expect(report.readAssertCommonOccurrences).toBe(3 * f.source.commonSources.length);
  });

  for (const mutation of ["protected context", "expiry", "unrelated source"] as const) {
    it(`rejects ${mutation} changed after cached prelude without publishing a candidate`, async () => {
      let armed = false,
        scheduled = false,
        valid = true,
        delivered = false;
      let mutate = () => {};
      const f = fixture({
        resolveSource: (source) => {
          if (source.kind !== "remote_document" || source.id !== "retained-only") return undefined;
          if (armed && !scheduled) {
            scheduled = true;
            setImmediate(() => {
              delivered = true;
              mutate();
            });
          }
          return valid ? "available" : "revoked";
        },
      });
      f.observations = [
        ...f.observations,
        {
          id: "retained-only-observation",
          name: "history.query",
          value: { status: "ok", items: [] },
          sources: [{ kind: "remote_document", id: "retained-only", revision: "1" }],
        },
      ];
      await f.source.read({ signal: new AbortController().signal, observations: f.observations });
      const source = f.source as unknown as {
        views: Map<
          string,
          {
            material: unknown;
            concurrentMessage: unknown;
            concurrentSources: unknown;
            concurrentContexts: unknown;
          }
        >;
      };
      const view = source.views.get("reply");
      const material = view?.material,
        message = view?.concurrentMessage,
        sources = view?.concurrentSources,
        contexts = view?.concurrentContexts;
      mutate = () => {
        if (mutation === "protected context")
          f.db
            .query(
              "UPDATE context_snapshots SET status='revoked' WHERE step_id='responsive-step-0'",
            )
            .run();
        else if (mutation === "expiry") f.state.now = EXPIRES;
        else valid = false;
      };
      armed = true;
      const result = await start(f).outcome;
      await tick();
      expect(delivered).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONTEXT_SOURCE_INVALID");
      expect(source.views.get("reply")).toBe(view);
      expect(view?.material).toBe(material);
      expect(view?.concurrentMessage).toBe(message);
      expect(view?.concurrentSources).toBe(sources);
      expect(view?.concurrentContexts).toBe(contexts);
    });
  }
});
