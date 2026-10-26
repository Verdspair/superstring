import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { canReadRun, inspectContext, sourceAccess } from "../../src/server/agent/context-access";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import { conversationRoutes } from "../../src/server/api/conversations";
import { deliveryRoutes } from "../../src/server/api/deliveries";
import { handleError } from "../../src/server/api/error-handler";
import { runRoutes } from "../../src/server/api/runs";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  bodyRevision,
  ConversationEventRepository,
} from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { createQqScheme, readQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import type { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const future = "2099-01-01T00:00:00.000Z";
function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "fixture");
  const journal = new ConversationEventRepository(h.db);
  const runs = new AgentRunRepository(h.db);
  const outbox = new OutboundIntentRepository(h.db);
  const wakes = new WakeRepository(h.db);
  const scheme = createQqScheme(h.orm, {
    name: "history",
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
  });
  const bindingId = crypto.randomUUID(),
    at = new Date().toISOString();
  h.db
    .query(`INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at)
    VALUES(?,'100','private','200',?,?,?,?)`)
    .run(bindingId, DEFAULT_AGENT_ID, scheme.id, at, at);
  h.db
    .query(
      `INSERT INTO agents SELECT 'agent-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?`,
    )
    .run(DEFAULT_AGENT_ID);
  const app = new Hono()
    .onError(handleError)
    .route("/v2/conversations", conversationRoutes(h.db))
    .route("/v2/deliveries", deliveryRoutes(h.db))
    .route("/v2/runs", runRoutes(h.db, runs));
  const bind = (agentId: string) => {
    h.db.query("UPDATE qq_bindings SET agent_id=? WHERE id=?").run(agentId, bindingId);
    return journal.ensureOneBot(bindingId)!;
  };
  const incoming = (id: string, agentId = DEFAULT_AGENT_ID) => {
    h.db
      .query(`INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed)
      VALUES(?,'100','private','200',?,?,100,'member','200',?,1)`)
      .run(id, agentId, id, at);
    h.db
      .query("INSERT INTO qq_observation_text VALUES(?,?,?,?,?)")
      .run(id, `body ${id}`, 100, future, at);
    return journal.ingestOneBotEvent(id, bindingId)!;
  };
  const snapshot = (conversation: ConversationSummary, sources: SourceRef[] = []) => {
    const runId = crypto.randomUUID(),
      stepId = crypto.randomUUID();
    const owner = {
      kind: "conversation",
      id: conversation.id,
      agentId: conversation.agentId,
      userId: DEFAULT_USER_ID,
    };
    runs.createRun({ runId, specId: "fixture", specVersion: "1", owner, at });
    runs.startStep({
      runId,
      stepId,
      stepNo: 1,
      phase: "leaf",
      model: "fixture",
      at,
      messages: [{ role: "user", content: [{ kind: "text", text: "retained context" }] }],
      sources,
    });
    return { runId, stepId, owner };
  };
  const delivery = (conversation: ConversationSummary, runId: string, ordinal = 0) =>
    outbox.commit({
      runId,
      conversationId: conversation.id,
      ordinal,
      target: {
        bindingId,
        accountId: "100",
        conversationKind: "private",
        peerId: "200",
        agentId: conversation.agentId,
        bindingEpoch: conversation.bindingEpoch,
      },
      speechKind: "direct_reply",
      sourceThroughSeq: journal.sourceThroughSeq(conversation.id),
      deliverBy: future,
      createdAt: at,
      expiresAt: future,
      parts: [{ kind: "text", text: "confirmed prior reply" }],
    });
  const ingestOneBot = (
    msg: {
      messageId: number;
      message: Array<{ type: string; data: Record<string, unknown> }>;
      time?: number;
    },
    agentId = DEFAULT_AGENT_ID,
  ) => {
    const nowSeconds = Math.floor(Date.parse(at) / 1000);
    const normalized = normalizeOneBotMessage(
      {
        time: msg.time ?? nowSeconds,
        self_id: 100,
        post_type: "message",
        message_type: "private",
        sub_type: "normal",
        message_id: msg.messageId,
        user_id: 200,
        sender: { card: "阿林", nickname: "林某" },
        message: msg.message,
      },
      "100",
    );
    if (normalized.kind !== "message") throw new Error("expected message");
    recordObservation(h.orm, normalized.observation, agentId);
    return journal.ingestOneBotEvent(normalized.observation.eventKey, bindingId)!;
  };
  return {
    ...h,
    journal,
    runs,
    outbox,
    wakes,
    app,
    bindingId,
    at,
    bind,
    incoming,
    ingestOneBot,
    snapshot,
    delivery,
  };
}

describe("stable assistant history and activation isolation", () => {
  it("restores A's canonical history ID, stable cursors and source-backed activity without injecting past input into A's new activation", async () => {
    const h = setup(),
      a1 = h.bind(DEFAULT_AGENT_ID);
    h.incoming("a-old");
    const wake = h.wakes.enqueue({
      conversationId: a1.id,
      cause: "direct_reply",
      throughSeq: 1,
      dedupeKey: "old-wake",
      readyAt: h.at,
      priority: 1,
      at: h.at,
    });
    const oldRun = h.snapshot(a1);
    h.journal.linkRun(oldRun.runId, a1.id, 1, wake.id);
    const priorDelivery = h.delivery(a1, oldRun.runId);
    const part = h.outbox.claimPart(priorDelivery.id, h.at)!;
    h.outbox.settlePart(part.part.id, { status: "confirmed", messageId: "prior-receipt" }, h.at);
    h.journal.append({
      conversationId: a1.id,
      eventKey: `delivery:${priorDelivery.id}:fixture-confirmed`,
      kind: "delivery",
      source: {
        kind: "outbound_intent",
        id: priorDelivery.id,
        revision: "confirmed",
        expiresAt: future,
      },
      occurredAt: h.at,
      runId: oldRun.runId,
      outputId: priorDelivery.id,
    });
    // Activity recording evolves independently from history identity. Both PR2 and
    // PR3 persist this explicit source-backed record; PR3 may also journal the wake.
    const oldBoundary = h.journal.get(a1.id)!.lastSeq;
    const read = async (id: string, query = "") =>
      (await h.app.request(`/v2/conversations/${id}/events${query}`)).json();
    const first = await read(a1.id, "?limit=1");
    expect(first.items.map((e: { text: string }) => e.text)).toEqual(["body a-old"]);
    expect(first.nextSeq).toBe(1);
    const b = h.bind("agent-b");
    h.incoming("b-private", "agent-b");
    expect((await h.app.request(`/v2/conversations/${a1.id}`)).status).toBe(404);
    expect((await h.app.request(`/v2/runs/${oldRun.runId}`)).status).toBe(404);
    const a3 = h.bind(DEFAULT_AGENT_ID);
    expect(a3.id).not.toBe(a1.id);
    expect(a3.bindingEpoch).toBe(3);
    // Migration/restart backfill must neither import old input into epoch 3 nor enqueue a wake.
    h.journal.backfill();
    h.journal.backfill();
    expect(h.journal.eventsAfter(a3.id).items).toEqual([]);
    expect(h.journal.sourceThroughSeq(a3.id)).toBe(0);
    expect(h.db.query("SELECT count(*) AS n FROM wake_signals").get()).toEqual({ n: 1 });
    h.incoming("a-new");
    expect(h.journal.eventsAfter(a3.id).items.map((e) => e.seq)).toEqual([1]);
    const directory = await (
      await h.app.request(`/v2/conversations?channel=onebot11&sourceId=${h.bindingId}`)
    ).json();
    expect(directory.items).toHaveLength(1);
    expect(directory.items[0]).toMatchObject({
      id: a1.id,
      bindingEpoch: 3,
      lastSeq: oldBoundary + 1,
      consumedSeq: oldBoundary,
    });
    expect((await (await h.app.request(`/v2/conversations/${a3.id}`)).json()).id).toBe(a1.id);
    const second = await read(
      a1.id,
      `?afterSeq=${first.nextSeq}&limit=${oldBoundary - first.nextSeq}`,
    );
    expect(second.items.at(-1)).toMatchObject({
      conversationId: a1.id,
      seq: oldBoundary,
      runId: oldRun.runId,
      outputId: priorDelivery.id,
      deliveryStatus: "confirmed",
      text: "confirmed prior reply",
    });
    expect(second.nextSeq).toBe(oldBoundary);
    expect(second.hasMore).toBe(true);
    const third = await read(a3.id, `?afterSeq=${second.nextSeq}`);
    expect(third.items.map((e: { text: string }) => e.text)).toEqual(["body a-new"]);
    expect(third.nextSeq).toBe(oldBoundary + 1);
    expect(JSON.stringify(await read(a1.id))).not.toContain("b-private");
    expect((await h.app.request(`/v2/conversations/${b.id}/events`)).status).toBe(404);
    expect(() =>
      h.journal.append({
        conversationId: a1.id,
        eventKey: "late",
        kind: "inbound",
        source: { kind: "fixture", id: "late", revision: "1" },
        occurredAt: h.at,
      }),
    ).toThrow("CONVERSATION_CLOSED");
    const retained = h.journal.historyAfter(a1.id);
    h.journal.backfill();
    h.journal.backfill();
    expect(h.journal.historyAfter(a1.id)).toEqual(retained);
    // Retention remains source-authoritative; rebinding does not revive expired body text.
    h.db
      .query(
        "UPDATE qq_observation_text SET expires_at='2000-01-01T00:00:00.000Z' WHERE event_key='a-old'",
      )
      .run();
    const expired = await read(a1.id);
    expect(expired.items[0]).toMatchObject({ seq: 1, text: null, contentState: "expired" });
    expect(expired.nextSeq).toBe(oldBoundary + 1);
  });

  it("permits historical run/retained context and delivery reads only for the currently rebound assistant, while execution still rejects old sources", async () => {
    const h = setup(),
      a1 = h.bind(DEFAULT_AGENT_ID);
    const event = h.incoming("a-input");
    const input = event.sources.find((s) => s.kind === "qq_observation")!;
    const run = h.snapshot(a1, [input]);
    const delivery = h.delivery(a1, run.runId);
    const part = h.outbox.claimPart(delivery.id, h.at)!;
    h.outbox.settlePart(part.part.id, { status: "confirmed", messageId: "receipt" }, h.at);
    const source = {
      kind: "outbound_intent",
      id: delivery.id,
      revision: bodyRevision("confirmed prior reply"),
      expiresAt: future,
    };
    const sourceRun = h.snapshot(a1, [source]);
    const foreign = h.bind("agent-b"),
      foreignRun = h.snapshot(foreign);
    h.delivery(foreign, foreignRun.runId);
    expect((await h.app.request(`/v2/runs/${run.runId}/context/${run.stepId}`)).status).toBe(404);
    expect((await h.app.request(`/v2/deliveries/${delivery.id}`)).status).toBe(404);
    // An inaccessible URL must not destroy context which remains owned by A.
    expect(h.runs.getContext(run)?.status).toBe("exact");
    const current = h.bind(DEFAULT_AGENT_ID),
      currentRun = h.snapshot(current);
    expect((await h.app.request(`/v2/runs/${run.runId}`)).status).toBe(200);
    expect(
      (await (await h.app.request(`/v2/runs/${run.runId}/context/${run.stepId}`)).json()).status,
    ).toBe("exact");
    expect(inspectContext(h.db, h.runs, sourceRun, { userId: DEFAULT_USER_ID }, h.at)?.status).toBe(
      "exact",
    );
    expect(sourceAccess(h.db, source, sourceRun.owner, { userId: DEFAULT_USER_ID }, h.at)).toBe(
      "revoked",
    );
    expect(canReadRun(h.db, run.owner, { userId: "another-user" })).toBe(false);
    const list = await (
      await h.app.request(`/v2/runs?ownerKind=conversation&ownerId=${a1.id}`)
    ).json();
    expect(new Set(list.runs.map((r: { runId: string }) => r.runId))).toEqual(
      new Set([run.runId, sourceRun.runId, currentRun.runId]),
    );
    expect((await h.app.request(`/v2/runs/${foreignRun.runId}`)).status).toBe(404);
    const deliveryList = await (
      await h.app.request(`/v2/deliveries?conversationId=${current.id}`)
    ).json();
    expect(deliveryList.items).toHaveLength(1);
    expect(deliveryList.items[0]).toMatchObject({
      id: delivery.id,
      conversationId: a1.id,
      status: "confirmed",
    });
    expect(JSON.stringify(deliveryList)).not.toContain("confirmed prior reply");
    // Source removal still erases inspectable material after access has been restored.
    h.db.query("DELETE FROM qq_observation_text WHERE event_key='a-input'").run();
    const erased = inspectContext(h.db, h.runs, run, { userId: DEFAULT_USER_ID }, h.at)!;
    expect(erased.status).not.toBe("exact");
    expect(erased.exactMessages).toBeUndefined();
    h.db.query("DELETE FROM qq_bindings WHERE id=?").run(h.bindingId);
    expect((await h.app.request(`/v2/conversations/${a1.id}`)).status).toBe(404);
    expect((await h.app.request(`/v2/runs/${run.runId}`)).status).toBe(404);
    expect((await h.app.request(`/v2/deliveries/${delivery.id}`)).status).toBe(404);
  });

  it("does not claim pending or interrupted old wakes after A is rebound", () => {
    const h = setup(),
      a1 = h.bind(DEFAULT_AGENT_ID);
    h.incoming("old-source");
    for (const dedupeKey of ["old-pending", "old-leased"])
      h.wakes.enqueue({
        conversationId: a1.id,
        cause: "direct_reply",
        throughSeq: 1,
        dedupeKey,
        readyAt: h.at,
        at: h.at,
        priority: 1,
      });
    const oldLease = h.wakes.claim({ at: h.at, leaseMs: 1 })!;
    expect(oldLease).not.toBeNull();
    h.bind("agent-b");
    const current = h.bind(DEFAULT_AGENT_ID);
    h.wakes.recover({ at: future, maxAttempts: 3, retryDelayMs: 1 });
    expect(h.wakes.peek({ at: future })).toBeNull();
    expect(h.wakes.claim({ at: future, leaseMs: 1000 })).toBeNull();
    expect(h.journal.get(current.id)?.consumedSeq).toBe(0);
    const fresh = h.incoming("fresh");
    const wake = h.wakes.enqueue({
      conversationId: current.id,
      cause: "direct_reply",
      throughSeq: fresh.seq,
      dedupeKey: "fresh",
      readyAt: h.at,
      at: h.at,
      priority: 1,
    });
    expect(h.wakes.claim({ at: future, leaseMs: 1000 })?.id).toBe(wake.id);
  });
  it("production recovery can read historical A deliveries but fences their sends and stale-plan wakes", async () => {
    const h = setup(),
      a1 = h.bind(DEFAULT_AGENT_ID);
    updateQqSettings(h.orm, { accountId: "100", enabled: true, expectedRevision: 1 });
    h.incoming("old-input");
    const oldRun = h.snapshot(a1);
    // 同会话因果序：in-flight 的必须是最早（ordinal 0）那条，后面的只能是等待中的 planned；
    // 否则 claimPart 会按因果序拒绝后到 in-flight 的领取，recover 就看不到 sending 部件。
    const interrupted = h.delivery(a1, oldRun.runId);
    const planned = h.delivery(a1, oldRun.runId, 1);
    h.outbox.claimPart(interrupted.id, h.at);
    const authorizeSnapshot = (id: string) => {
      const binding = readQqBinding(h.orm, h.bindingId)!;
      const scheme = readQqScheme(h.orm, binding.schemeId)!;
      const target = JSON.parse(h.outbox.row(id)!.target);
      h.db.query("UPDATE outbound_intents SET target=? WHERE id=?").run(
        JSON.stringify({
          ...target,
          bindingRevision: binding.revision,
          authorityRevision: binding.authorityRevision,
          schemeId: scheme.id,
          schemeRevision: scheme.revision,
          agentConfigVersion: getAgentRow(h.orm, DEFAULT_AGENT_ID)!.configVersion,
        }),
        id,
      );
    };
    authorizeSnapshot(planned.id);
    authorizeSnapshot(interrupted.id);
    h.bind("agent-b");
    const current = h.bind(DEFAULT_AGENT_ID),
      currentRun = h.snapshot(current);
    const fresh = h.delivery(current, currentRun.runId);
    authorizeSnapshot(fresh.id);
    // Keep all snapshot fields unchanged except physical activation identity: only epoch
    // fencing may invalidate the old plan, and the same current plan must still send.
    let modelCalls = 0,
      recoveryWakes = 0;
    const sent: unknown[] = [];
    const agentRuntime = createAgentRuntime({ repository: h.runs });
    const runtime = createOneBotConversationRuntime({
      orm: h.orm,
      db: h.db,
      journal: h.journal,
      agentRuntime,
      host: new ConversationHost({ runtime: agentRuntime }),
      gateway: {
        complete: async () => {
          modelCalls++;
          throw new Error("unexpected inference");
        },
        loadedContextCapacity: async () => 65536,
      },
      store: { copyExists: () => false } as unknown as QqStickerStore,
      port: {
        send: async (request) => {
          sent.push(request);
          return { kind: "confirmed", messageId: "fresh-receipt" };
        },
      },
      wake: () => {
        recoveryWakes++;
      },
    });
    expect(h.outbox.get(interrupted.id)?.status).toBe("unknown");
    expect((await h.app.request(`/v2/deliveries/${planned.id}`)).status).toBe(200);
    await runtime.delivery.runOnce();
    expect(h.outbox.get(planned.id)?.status).toBe("stale");
    expect(h.outbox.get(interrupted.id)?.status).toBe("unknown");
    expect(h.outbox.get(fresh.id)?.status).toBe("confirmed");
    expect(sent).toHaveLength(1);
    expect(modelCalls).toBe(0);
    expect(recoveryWakes).toBe(0);
    expect(h.db.query("SELECT count(*) AS n FROM wake_signals").get()).toEqual({ n: 0 });
    expect(h.journal.row(a1.id)?.closed_at).not.toBeNull();
  });

  it("pure image without text projects to active contentState and available media without description, while image with deleted body stays unavailable", async () => {
    const h = setup(),
      a1 = h.bind(DEFAULT_AGENT_ID);

    // 1. Pure image message (textless, zero read note)
    const pureImageEvent = h.ingestOneBot({
      messageId: 5001,
      message: [{ type: "image", data: { file: "file-5001" } }],
    });

    // 2. Rich message (text + image) where body text will subsequently be deleted
    const richEvent = h.ingestOneBot({
      messageId: 5002,
      message: [
        { type: "text", data: { text: "caption text" } },
        { type: "image", data: { file: "file-5002" } },
      ],
    });

    const read = async (id: string, query = "") =>
      (await h.app.request(`/v2/conversations/${id}/events${query}`)).json();

    const initial = await read(a1.id);
    const pureItem = initial.items.find(
      (e: { source: { id: string } }) => e.source.id === pureImageEvent.source.id,
    );
    const richItem = initial.items.find(
      (e: { source: { id: string } }) => e.source.id === richEvent.source.id,
    );

    // Pure image: immutable authorized facts prove message never had text parts ->
    // contentState is active (no false '原文暂不可用'), media is available with null description ('暂无可用媒体描述').
    expect(pureItem).toMatchObject({
      contentState: "active",
      text: null,
      media: [
        {
          kind: "image",
          description: null,
          availability: "available",
        },
      ],
    });

    // Rich message before deletion has text and active contentState
    expect(richItem).toMatchObject({
      contentState: "active",
      text: "caption text",
      media: [
        {
          kind: "image",
          description: null,
          availability: "available",
        },
      ],
    });

    // Now simulate text body loss/deletion for the rich message
    h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(richEvent.source.id);

    const afterDeletion = await read(a1.id);
    const richAfterItem = afterDeletion.items.find(
      (e: { source: { id: string } }) => e.source.id === richEvent.source.id,
    );
    const pureAfterItem = afterDeletion.items.find(
      (e: { source: { id: string } }) => e.source.id === pureImageEvent.source.id,
    );

    // Negative case: Rich message lost its text body -> contentState MUST remain "unavailable".
    // Available media presence must NOT mask the lost text body!
    expect(richAfterItem).toMatchObject({
      contentState: "unavailable",
      text: null,
      media: [
        {
          kind: "image",
          description: null,
          availability: "available",
        },
      ],
    });

    // Pure image remains active and unaffected
    expect(pureAfterItem).toMatchObject({
      contentState: "active",
      text: null,
      media: [
        {
          kind: "image",
          description: null,
          availability: "available",
        },
      ],
    });

    // Expiry retains true expired state
    h.db
      .query("UPDATE qq_media_notes SET expires_at='2000-01-01T00:00:00.000Z' WHERE event_key=?")
      .run(pureImageEvent.source.id);

    const expiredView = await read(a1.id);
    const pureExpiredItem = expiredView.items.find(
      (e: { source: { id: string } }) => e.source.id === pureImageEvent.source.id,
    );
    expect(pureExpiredItem).toMatchObject({
      contentState: "expired",
      text: null,
      media: [
        {
          kind: "image",
          description: null,
          availability: "expired",
        },
      ],
    });
  });
});
