// Message freshness wire tests: isolated production createApp + real journal + SSE flows.
//
// Proves the ingress → publish → SSE → GET chain on a migrated in-memory clone:
//   1. a burst of inbound appends coalesces into ONE conversation_changed frame at the
//      current seq, and GET head + GET events show the same remapped cursor (manual refresh
//      sees the identical page without the SSE);
//   2. late media (qq_media_notes arriving after the parent event) publishes a SECOND
//      changed frame and the projected timeline exposes the media_revision item;
//   3. SSE disconnect cancels the hub subscription and rebinding never leaks the old
//      conversation id onto a fresh stream (sealed epoch cannot append);
//   4. timing metadata (append→SSE received, GET duration, query counts) collected over
//      repeated samples and reported as JSON — no hard millisecond assertions anywhere.
//
// No real data/config/network/ports: gateway is a fixture, the app is exercised through
// app.request, the database is the shared migrated in-memory image clone.

import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { cloneBusinessDb } from "../harness/business-db";
import { parseSseFrames } from "../harness/sse";

const future = "2099-01-01T00:00:00.000Z";
const SAMPLES = 20;

class FixtureGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: "fixture", timeoutSeconds: 60 };
  async listModels(): Promise<string[]> {
    return [this.config.model];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return 32768;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(): Promise<string> {
    return "ok";
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield "ok";
  }
}

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

/** Lets the deferred post-commit hub flush (a microtask) run before reads. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const business = cloneBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "fixture");
  const at = nowIso();
  const bindingId = crypto.randomUUID();
  const scheme = createQqScheme(business.orm, { name: "freshness fixture" });
  business.db
    .query(
      `INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at)
       VALUES(?,'10001','group','30001',?,?,?,?)`,
    )
    .run(bindingId, DEFAULT_AGENT_ID, scheme.id, at, at);
  const journal = new ConversationEventRepository(business.db);
  const app = createApp({ business, gateway: new FixtureGateway() });
  const incoming = (id: string, agentId = DEFAULT_AGENT_ID) => {
    business.db
      .query(
        `INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed)
         VALUES(?,'10001','group','30001',?,?,100,'member','200',?,1)`,
      )
      .run(id, agentId, id, at);
    business.db
      .query("INSERT INTO qq_observation_text VALUES(?,?,?,?,?)")
      .run(id, `body ${id}`, 100, future, at);
    return journal.ingestOneBotEvent(id, bindingId)!;
  };
  const addMediaNote = (noteId: string, eventKey: string) => {
    business.db
      .query(
        `INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at)
         VALUES(?,?,0,'image','synthetic','late description','fixture',1,?,?,?)`,
      )
      .run(noteId, eventKey, future, at, at);
  };
  const bindAgent = (agentId: string) => {
    business.db.query("UPDATE qq_bindings SET agent_id=? WHERE id=?").run(agentId, bindingId);
  };
  return { business, journal, app, bindingId, incoming, addMediaNote, bindAgent };
}

/** Chunk-wise SSE reader over an app.request response body. */
function streamReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  return {
    async next(): Promise<ReturnType<typeof parseSseFrames>> {
      const chunk = await reader.read();
      if (chunk.done) return [];
      return parseSseFrames(decoder.decode(chunk.value));
    },
  };
}

async function openChanges(app: ReturnType<typeof createApp>, signal: AbortSignal) {
  // Finish fixture source creation before subscribing to message-arrival changes.
  await tick();
  const response = await app.request("http://synthetic.invalid/v2/conversations/changes", {
    signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const stream = streamReader(response);
  expect(await stream.next()).toEqual([{ event: "ready", data: { ready: true } }]);
  return stream;
}

describe("conversation message freshness over the real app", () => {
  it("coalesces an inbound burst into one SSE frame at the current seq, and GET head plus manual refresh show the identical cursor", async () => {
    const h = setup();
    const controller = new AbortController();
    try {
      const stream = await openChanges(h.app, controller.signal);
      const conversation = h.journal.ensureOneBot(h.bindingId)!;
      h.incoming("fresh-1");
      h.incoming("fresh-2");
      const last = h.incoming("fresh-3");
      await tick();
      const frames = await stream.next();
      expect(frames).toEqual([
        {
          event: "conversation_changed",
          data: { conversationId: conversation.id, seq: last.seq, bindingEpoch: 1 },
        },
      ]);
      // GET head: the directory cursor matches the SSE frame exactly.
      const head = (await (
        await h.app.request(`http://synthetic.invalid/v2/conversations/${conversation.id}`)
      ).json()) as { lastSeq: number };
      expect(head.lastSeq).toBe(last.seq);
      // Manual refresh without SSE: the authoritative page shows the same remapped seqs.
      const page = (await (
        await h.app.request(
          `http://synthetic.invalid/v2/conversations/${conversation.id}/events?afterSeq=0&limit=50`,
        )
      ).json()) as { items: Array<{ seq: number; text?: string }>; nextSeq: number };
      expect(page.items.map((item) => item.seq)).toEqual([1, 2, 3]);
      expect(page.nextSeq).toBe(last.seq);
      expect(page.items.at(-1)!.text).toBe("body fresh-3");
    } finally {
      controller.abort();
    }
  });

  it("late media publishes a second changed frame and the projected timeline exposes the media revision", async () => {
    const h = setup();
    const controller = new AbortController();
    try {
      const stream = await openChanges(h.app, controller.signal);
      const conversation = h.journal.ensureOneBot(h.bindingId)!;
      const parent = h.incoming("media-1");
      await tick();
      expect((await stream.next()).at(-1)!.data).toMatchObject({
        conversationId: conversation.id,
        seq: parent.seq,
      });
      // The media note arrives AFTER the parent event: one new frame, not a re-send.
      h.addMediaNote("media-note-1", "media-1");
      const revision = h.journal.ingestMedia("media-note-1", h.bindingId)!;
      expect(revision.kind).toBe("media_revision");
      await tick();
      const frames = await stream.next();
      expect(frames).toEqual([
        {
          event: "conversation_changed",
          data: { conversationId: conversation.id, seq: revision.seq, bindingEpoch: 1 },
        },
      ]);
      const head = (await (
        await h.app.request(`http://synthetic.invalid/v2/conversations/${conversation.id}`)
      ).json()) as { lastSeq: number };
      expect(head.lastSeq).toBe(revision.seq);
      const page = (await (
        await h.app.request(
          `http://synthetic.invalid/v2/conversations/${conversation.id}/events?afterSeq=${parent.seq}&limit=10`,
        )
      ).json()) as { items: Array<{ seq: number; kind: string }> };
      expect(page.items.map((item) => [item.seq, item.kind])).toEqual([
        [revision.seq, "media_revision"],
      ]);
    } finally {
      controller.abort();
    }
  });

  it("SSE disconnect cancels the subscription and rebinding never leaks the old conversation onto a fresh stream", async () => {
    const h = setup();
    const first = new AbortController();
    try {
      const stream1 = await openChanges(h.app, first.signal);
      const conversation = h.journal.ensureOneBot(h.bindingId)!;
      h.incoming("before-rebind");
      await tick();
      expect((await stream1.next()).at(-1)!.data).toMatchObject({
        conversationId: conversation.id,
      });
      first.abort();
      expect(await stream1.next()).toEqual([]);
      // Successor identity: a second agent rebinds the binding to a new live epoch.
      h.business.db
        .query(
          `INSERT INTO agents SELECT 'agent-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?`,
        )
        .run(DEFAULT_AGENT_ID);
      h.bindAgent("agent-b");
      const rebound = h.journal.ensureOneBot(h.bindingId)!;
      expect(rebound.id).not.toBe(conversation.id);
      await tick();
      // The sealed epoch cannot append, so no stale write can ever emit a frame.
      expect(() =>
        h.journal.append({
          conversationId: conversation.id,
          eventKey: "stale:1",
          kind: "inbound",
          source: { kind: "fixture", id: "1", revision: "1" },
          occurredAt: nowIso(),
        }),
      ).toThrow("CONVERSATION_CLOSED");
      expect(
        (await h.app.request(`http://synthetic.invalid/v2/conversations/${conversation.id}`))
          .status,
      ).toBe(404);
      const second = new AbortController();
      try {
        const stream2 = await openChanges(h.app, second.signal);
        h.incoming("after-rebind", "agent-b");
        await tick();
        const frames = await stream2.next();
        expect(frames).toEqual([
          {
            event: "conversation_changed",
            data: { conversationId: rebound.id, seq: 1, bindingEpoch: 2 },
          },
        ]);
        expect(frames.some((frame) => JSON.stringify(frame).includes(conversation.id))).toBe(false);
      } finally {
        second.abort();
      }
    } finally {
      first.abort();
    }
  });

  it("reports freshness timing metadata over repeated samples without asserting latencies", async () => {
    const h = setup();
    const controller = new AbortController();
    try {
      const stream = await openChanges(h.app, controller.signal);
      const conversation = h.journal.ensureOneBot(h.bindingId)!;
      const rawQuery = h.business.db.query.bind(h.business.db);
      let queries = 0;
      const appendToFrameMs: number[] = [];
      const getEventsMs: number[] = [];
      const queriesPerGet: number[] = [];
      let tail = 0;
      for (let i = 1; i <= SAMPLES; i++) {
        const key = `sample-${i}`;
        const t0 = performance.now();
        const event = h.incoming(key);
        const frames = await stream.next();
        appendToFrameMs.push(+(performance.now() - t0).toFixed(3));
        expect(frames).toEqual([
          {
            event: "conversation_changed",
            data: { conversationId: conversation.id, seq: event.seq, bindingEpoch: 1 },
          },
        ]);
        queries = 0;
        h.business.db.query = ((sql: string, ...rest: unknown[]) => {
          queries++;
          return (rawQuery as (s: string, ...r: unknown[]) => unknown)(sql, ...rest);
        }) as typeof h.business.db.query;
        const t1 = performance.now();
        const response = await h.app.request(
          `http://synthetic.invalid/v2/conversations/${conversation.id}/events?afterSeq=${tail}&limit=50`,
        );
        await response.text();
        getEventsMs.push(+(performance.now() - t1).toFixed(3));
        queriesPerGet.push(queries);
        h.business.db.query = rawQuery as typeof h.business.db.query;
        tail = event.seq;
      }
      // Functional assertions only: every sample produced its frame and its page.
      expect(appendToFrameMs).toHaveLength(SAMPLES);
      expect(getEventsMs).toHaveLength(SAMPLES);
      // Metadata for Root native capture; deliberately no millisecond thresholds.
      console.log(
        `MEASUREMENT ${JSON.stringify({
          samples: SAMPLES,
          appendToSseFrameMs: appendToFrameMs,
          getEventsMs,
          queriesPerGet,
        })}`,
      );
    } finally {
      controller.abort();
    }
  });
});
