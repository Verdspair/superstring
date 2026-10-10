import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { handleError } from "../../src/server/api/error-handler";
import { parseSseFrames } from "../../src/server/api/sse";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

/** Lets the deferred post-commit flush (a microtask) run before assertions. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const appendFixture = (journal: ConversationEventRepository, conversationId: string, n: number) =>
  journal.append({
    conversationId,
    eventKey: `fixture:${n}`,
    kind: "inbound",
    source: { kind: "fixture", id: String(n), revision: "1" },
    occurredAt: nowIso(),
  });

function insertAgent(orm: Parameters<typeof createQqScheme>[0], id: string, name: string) {
  orm
    .insert(schema.agents)
    .values({
      id,
      name,
      systemPrompt: "s",
      description: "",
      additionalInstructions: "",
      p5Config: "{}",
      modelName: "fixture",
      memoryConsolidationPrompt: "p",
      memoryConsolidationAdditionalInstructions: "",
      memoryRetrievalPrompt: "p",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
}

/** QQ binding under one owner: agent A → B → A leaves the same-owner family multi-epoch. */
function setup() {
  const business = openBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "model");
  const journal = new ConversationEventRepository(business.db);
  const app = new Hono()
    .onError(handleError)
    .route("/v2/conversations", conversationRoutes(business.db, { includeShared: true }));
  const agentB = crypto.randomUUID();
  insertAgent(business.orm, agentB, "successor-b");
  const scheme = createQqScheme(business.orm, { name: "group fixture" });
  const bindingId = crypto.randomUUID();
  business.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  const rebind = (agentId: string) => {
    business.db
      .query("UPDATE qq_bindings SET agent_id=?,updated_at=? WHERE id=?")
      .run(agentId, nowIso(), bindingId);
  };
  return { business, journal, app, bindingId, agentB, rebind };
}

/** Opens the SSE stream and returns a frame reader over the raw bytes. */
async function openStream(app: Hono) {
  const controller = new AbortController();
  const response = await app.request("/v2/conversations/changes", {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const next = async () => parseSseFrames(decoder.decode((await reader.read()).value!));
  return { controller, next };
}

describe("display-boundary conversation change notifications (G1)", () => {
  it("[RED] same-owner QQ rebind A→B→A: SSE frames carry the history-root id and global seq identical to the read view", async () => {
    const { journal, app, bindingId, agentB, rebind } = setup();
    const first = journal.ensureOneBot(bindingId)!;
    // The first owner's epoch must hold events so its offset separates the two seq spaces.
    appendFixture(journal, first.id, 1);
    appendFixture(journal, first.id, 2);
    // A→B: closes epoch1 (agent A) and opens epoch2 (agent B) — a disjoint family.
    rebind(agentB);
    const second = journal.ensureOneBot(bindingId)!;
    expect(second.id).not.toBe(first.id);
    // B→A: closes epoch2 and reopens agent A as epoch3 — same-owner family grows to two epochs.
    rebind(DEFAULT_AGENT_ID);
    const third = journal.ensureOneBot(bindingId)!;
    expect(third.id).not.toBe(first.id);
    expect(third.id).not.toBe(second.id);
    appendFixture(journal, third.id, 3);

    // Drain every publish queued by the setup above BEFORE the stream subscribes:
    // the flush is a microtask with no listeners yet, so nothing is lost or retained,
    // and the stream afterwards only ever carries frames for post-open appends.
    await tick();
    await tick();

    const { controller, next } = await openStream(app);
    try {
      // Round 1: the handshake, exactly one frame, nothing else.
      expect(await next()).toEqual([{ event: "ready", data: { ready: true } }]);

      // Round 2: exactly one new physical append; exactly one frame for it.
      appendFixture(journal, third.id, 4);
      await tick();
      const frames = await next();
      expect(frames).toHaveLength(1);
      const frame = frames[0]!;
      expect(frame.event).toBe("conversation_changed");
      const data = frame.data as {
        conversationId: string;
        seq: number;
        bindingEpoch: number;
      };

      // The read view both epochs share, fetched after the append: the frame must carry
      // exactly this view (history-root id, globally remapped seq, current epoch).
      const viewResponse = await app.request(`/v2/conversations/${third.id}`);
      expect(viewResponse.status).toBe(200);
      const view = (await viewResponse.json()) as {
        id: string;
        lastSeq: number;
        bindingEpoch: number;
      };
      expect(view.id).toBe(first.id);
      expect(view.lastSeq).toBe(4);
      expect((await app.request(`/v2/conversations/${first.id}`)).status).toBe(200);

      // Display identity = read-view identity: the frame must address the history root
      // with the globally remapped seq, exactly what the timeline cursor compares against.
      expect(data.conversationId).toBe(view.id);
      expect(data.seq).toBe(view.lastSeq);
      expect(data.bindingEpoch).toBe(view.bindingEpoch);

      // The frame seq is the same cursor space the /events projection returns.
      const events = (await (
        await app.request(`/v2/conversations/${third.id}/events?direction=latest`)
      ).json()) as { items: { seq: number }[] };
      expect(data.seq).toBe(events.items.at(-1)!.seq);
    } finally {
      controller.abort();
    }
  });

  it("different-agent epochs stay isolated: the closed successor family is unreadable and its seq space never merges into the rebind-back family", async () => {
    const { journal, app, bindingId, agentB, rebind } = setup();
    const first = journal.ensureOneBot(bindingId)!;
    appendFixture(journal, first.id, 1);
    rebind(agentB);
    const second = journal.ensureOneBot(bindingId)!;
    rebind(DEFAULT_AGENT_ID);
    const third = journal.ensureOneBot(bindingId)!;

    // The agent-B family is a single closed epoch: not readable, and its rows never
    // join the agent-A family's offset or history.
    const closedResponse = await app.request(`/v2/conversations/${second.id}`);
    expect(closedResponse.status).toBe(404);
    const viewResponse = await app.request(`/v2/conversations/${third.id}`);
    expect(viewResponse.status).toBe(200);
    const view = (await viewResponse.json()) as { id: string; lastSeq: number };
    expect(view.id).toBe(first.id);
    // offset = epoch1.next_seq - 1 = 1; epoch3 has no events yet → lastSeq == 1 exactly.
    // If the agent-B epoch ever merged into this family the number would be larger.
    expect(view.lastSeq).toBe(1);
    const events = (await (
      await app.request(`/v2/conversations/${third.id}/events?direction=latest`)
    ).json()) as { items: { seq: number }[] };
    expect(events.items.map((item) => item.seq)).toEqual([1]);
    // Hub-side contract stays physical and unchanged: the successor publish is asserted
    // by the existing conversation-changes.test.ts and must not be touched here.
    expect(journal.row(first.id)!.closed_at).not.toBeNull();
    expect(journal.row(second.id)!.closed_at).not.toBeNull();
    expect(journal.row(third.id)!.closed_at).toBeNull();
  });

  it("same-seq state notifications map to the root view with an unchanged seq, for the live epoch and the old epoch owner alike", async () => {
    const { business, journal, app, bindingId, agentB, rebind } = setup();
    const first = journal.ensureOneBot(bindingId)!;
    appendFixture(journal, first.id, 1);
    rebind(agentB);
    journal.ensureOneBot(bindingId);
    rebind(DEFAULT_AGENT_ID);
    const third = journal.ensureOneBot(bindingId)!;
    appendFixture(journal, third.id, 2);
    await tick();
    await tick();

    const { controller, next } = await openStream(app);
    try {
      expect(await next()).toEqual([{ event: "ready", data: { ready: true } }]);
      const runs = new AgentRunRepository(business.db);
      // State-only change on the live epoch owner: no journal append, seq unchanged.
      const liveRun = crypto.randomUUID();
      runs.createRun({
        runId: liveRun,
        specId: "fixture",
        specVersion: "1",
        owner: {
          kind: "conversation",
          id: third.id,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        at: nowIso(),
      });
      await tick();
      const liveFrames = await next();
      expect(liveFrames).toHaveLength(1);
      const liveData = liveFrames[0]!.data as {
        conversationId: string;
        seq: number;
        bindingEpoch: number;
      };
      expect(liveData.conversationId).toBe(first.id);
      expect(liveData.seq).toBe(2);
      expect(liveData.bindingEpoch).toBe(3);

      // State-only change on the OLD epoch owner (a run whose owner predates the rebind):
      // same family, same root view, same current seq — never the closed physical row.
      const oldRun = crypto.randomUUID();
      runs.createRun({
        runId: oldRun,
        specId: "fixture",
        specVersion: "1",
        owner: {
          kind: "conversation",
          id: first.id,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        at: nowIso(),
      });
      await tick();
      const oldFrames = await next();
      expect(oldFrames).toHaveLength(1);
      const oldData = oldFrames[0]!.data as {
        conversationId: string;
        seq: number;
        bindingEpoch: number;
      };
      expect(oldData.conversationId).toBe(first.id);
      expect(oldData.seq).toBe(2);
      expect(oldData.bindingEpoch).toBe(3);
    } finally {
      controller.abort();
    }
  });
});
