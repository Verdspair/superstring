// DELETE /qq/bindings/:bindingId — the binding goes, retained material and the canonical
// conversation stay. Synthetic database only.

import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme, readQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT = "00000000-0000-0000-0000-000000000001";
const FUTURE = "2030-01-01T00:00:00.000000Z";

type App = ReturnType<typeof createApp>;

function base() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  return business;
}

function setup(
  options: { kind?: "group" | "private"; peerId?: string; selfPrivate?: boolean } = {},
) {
  const business = base();
  const orm = business.orm;
  const scheme = createQqScheme(orm, { name: "synthetic" });
  const bindingId =
    options.kind === "private" && options.selfPrivate
      ? "59500000-0000-4000-8000-000000000001"
      : "11111111-1111-4111-8111-111111111111";
  const accountId = "10001";
  const peerId = options.selfPrivate ? accountId : (options.peerId ?? "30003");
  orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId,
      conversationKind: options.kind ?? "group",
      peerId,
      agentId: AGENT,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  const app = createApp({
    business,
    gateway: {
      config: { baseUrl: "http://x/v1", model: MODEL, timeoutSeconds: 5 },
      listModels: async () => [MODEL],
    } as never,
  });
  const journal = new ConversationEventRepository(business.db);
  return { business, orm, app, bindingId, schemeId: scheme.id, accountId, peerId, journal };
}

function currentConversation(journal: ConversationEventRepository, bindingId: string): string {
  const current = journal.ensureOneBotActivation(bindingId);
  if (!current) throw new Error("missing canonical fixture activation");
  return current.id;
}

function insertTask(
  orm: Orm,
  conversationId: string,
  input: { status: string; epoch?: number; leaseToken?: string | null },
): string {
  const id = crypto.randomUUID();
  orm
    .insert(schema.qqConversationTasks)
    .values({
      id,
      taskKey: `task-${id}`,
      conversationId,
      bindingEpoch: input.epoch ?? 1,
      agentId: AGENT,
      taskClass: "ordinary",
      cause: "follow_up",
      sourceFromSeq: 0,
      sourceThroughSeq: 1,
      status: input.status,
      leaseToken: input.leaseToken ?? null,
      leaseExpiresAt: input.leaseToken ? FUTURE : null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  return id;
}

function insertRun(orm: Orm, conversationId: string, status: string): string {
  const runId = crypto.randomUUID();
  orm
    .insert(schema.agentRuns)
    .values({
      runId,
      conversationId,
      specId: "qq-reply",
      specVersion: "1",
      ownerKind: "conversation",
      ownerId: conversationId,
      userId: DEFAULT_USER_ID,
      agentId: AGENT,
      status,
      startedAt: nowIso(),
      endedAt: ["completed", "no_output", "failed", "cancelled"].includes(status) ? nowIso() : null,
    })
    .run();
  return runId;
}

function insertWake(
  orm: Orm,
  conversationId: string,
  input: { status: string; leaseToken?: string | null },
): string {
  const id = crypto.randomUUID();
  orm
    .insert(schema.wakeSignals)
    .values({
      id,
      conversationId,
      cause: "direct_reply",
      throughSeq: 1,
      dedupeKey: `dedupe-${id}`,
      readyAt: nowIso(),
      priority: 0,
      status: input.status,
      leaseToken: input.leaseToken ?? null,
      leaseExpiresAt: input.leaseToken ? FUTURE : null,
      createdAt: nowIso(),
    })
    .run();
  return id;
}

function insertOutbox(
  orm: Orm,
  conversationId: string,
  input: { intentStatus: string; partStatus: string },
): string {
  const runId = insertRun(orm, conversationId, "completed");
  const intentId = crypto.randomUUID();
  orm
    .insert(schema.outboundIntents)
    .values({
      id: intentId,
      runId,
      conversationId,
      outputOrdinal: 0,
      target: JSON.stringify({ accountId: "10001", conversationKind: "group", peerId: "30003" }),
      speechKind: "direct_reply",
      sourceThroughSeq: 1,
      deliverBy: FUTURE,
      status: input.intentStatus,
      createdAt: nowIso(),
      expiresAt: FUTURE,
    })
    .run();
  orm
    .insert(schema.outboundParts)
    .values({
      id: crypto.randomUUID(),
      intentId,
      ordinal: 0,
      kind: "text",
      payload: JSON.stringify({ text: "合成" }),
      status: input.partStatus,
    })
    .run();
  return intentId;
}

function del(app: App, bindingId: string, expectedRevision: number | string) {
  return app.request(`/qq/bindings/${bindingId}?expected_revision=${expectedRevision}`, {
    method: "DELETE",
  });
}

async function errorBody(response: Response) {
  return (await response.json()) as { error: { code: string } };
}

describe("DELETE /qq/bindings/:bindingId", () => {
  it("removes a normal group binding with 204; retained material stays and the conversation is unlisted", async () => {
    const h = setup();
    try {
      const conversationId = currentConversation(h.journal, h.bindingId);
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "evt-1",
          accountId: h.accountId,
          conversationKind: "group",
          peerId: h.peerId,
          agentId: AGENT,
          messageId: "evt-1",
          occurredAtSeconds: 1_700_000_000,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      h.orm
        .insert(schema.qqGroupAgentConfigs)
        .values({
          id: "cfg-1",
          bindingId: h.bindingId,
          agentId: AGENT,
          schemeOverrides: "{}",
          disabledCapabilities: "[]",
          revision: 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .run();

      const response = await del(h.app, h.bindingId, 1);
      expect(response.status).toBe(204);

      // The binding and its per-binding config are gone.
      expect(readQqBinding(h.orm, h.bindingId)).toBeNull();
      expect(h.orm.select().from(schema.qqGroupAgentConfigs).all().length).toBe(0);
      // Canonical bodies, the assistant and the scheme are retained.
      expect(h.orm.select().from(schema.qqEvents).all().length).toBe(1);
      expect(readQqScheme(h.orm, h.schemeId)).not.toBeNull();
      expect(h.orm.select().from(schema.conversations).all().length).toBe(1);
      // The conversation is unlisted: the read guard checks the binding, which is gone.
      const listed = await h.app.request("/v2/conversations?channel=onebot11");
      const body = (await listed.json()) as { items: { id: string }[] };
      expect(body.items.some((item) => item.id === conversationId)).toBe(false);
    } finally {
      h.business.close();
    }
  });

  it("accepts a legacy self private binding; a UUID path and a non-integer revision are 422", async () => {
    const h = setup({ kind: "private", selfPrivate: true });
    try {
      expect((await del(h.app, h.bindingId, 1)).status).toBe(204);
      expect(readQqBinding(h.orm, h.bindingId)).toBeNull();

      const other = setup();
      try {
        expect(
          (
            await other.app.request(`/qq/bindings/not-a-uuid?expected_revision=1`, {
              method: "DELETE",
            })
          ).status,
        ).toBe(422);
        expect((await del(other.app, other.bindingId, "abc")).status).toBe(422);
        expect((await del(other.app, other.bindingId, "1.5")).status).toBe(422);
        expect(
          (await other.app.request(`/qq/bindings/${other.bindingId}`, { method: "DELETE" })).status,
        ).toBe(422);
      } finally {
        other.business.close();
      }
    } finally {
      h.business.close();
    }
  });

  it("404 for an unknown binding and 409 on a revision conflict, with no side effects on either", async () => {
    const h = setup();
    try {
      const beforeConversations = h.orm.select().from(schema.conversations).all();
      const missing = await del(h.app, "00000000-0000-4000-8000-0000000000ff", 1);
      expect(missing.status).toBe(404);
      expect((await errorBody(missing)).error.code).toBe("MEMORY_NOT_FOUND");

      const conflict = await del(h.app, h.bindingId, 2);
      expect(conflict.status).toBe(409);
      expect((await errorBody(conflict)).error.code).toBe("MEMORY_STATE_CONFLICT");
      // Nothing was written by either refused request.
      expect(readQqBinding(h.orm, h.bindingId)).not.toBeNull();
      expect(h.orm.select().from(schema.conversations).all()).toEqual(beforeConversations);
    } finally {
      h.business.close();
    }
  });

  it("refuses while a task runs, a run is unfinished, a wake is leased or the outbox is sending/unknown", async () => {
    const h = setup();
    try {
      const conversationId = currentConversation(h.journal, h.bindingId);
      const blocked: Array<() => void> = [
        () => insertTask(h.orm, conversationId, { status: "running", leaseToken: "lease-1" }),
        () => insertRun(h.orm, conversationId, "generating"),
        () => insertWake(h.orm, conversationId, { status: "leased", leaseToken: "lease-2" }),
        () =>
          insertOutbox(h.orm, conversationId, {
            intentStatus: "delivering",
            partStatus: "sending",
          }),
        () =>
          insertOutbox(h.orm, conversationId, { intentStatus: "unknown", partStatus: "confirmed" }),
        () =>
          insertOutbox(h.orm, conversationId, {
            intentStatus: "delivering",
            partStatus: "unknown",
          }),
      ];
      for (const add of blocked) {
        add();
        const response = await del(h.app, h.bindingId, 1);
        expect(response.status).toBe(409);
        expect((await errorBody(response)).error.code).toBe("MEMORY_STATE_CONFLICT");
        expect(readQqBinding(h.orm, h.bindingId)).not.toBeNull();
        // Roll the fixture back to the bare conversation for the next case.
        h.orm.delete(schema.outboundParts).run();
        h.orm.delete(schema.outboundIntents).run();
        h.orm.delete(schema.agentRuns).run();
        h.orm.delete(schema.wakeSignals).run();
        h.orm.delete(schema.qqConversationTasks).run();
      }
    } finally {
      h.business.close();
    }
  });

  it("also refuses when the live work sits on a CLOSED epoch of the same binding", async () => {
    const h = setup();
    try {
      const closed = currentConversation(h.journal, h.bindingId);
      h.business.db.query("UPDATE conversations SET closed_at=? WHERE id=?").run(nowIso(), closed);
      const successor = h.journal.ensureOneBotActivation(h.bindingId)!;
      expect(successor.id).not.toBe(closed);
      insertRun(h.orm, closed, "generating");
      const response = await del(h.app, h.bindingId, 1);
      expect(response.status).toBe(409);
      expect(readQqBinding(h.orm, h.bindingId)).not.toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("cancels pending tasks with a stored plain reason, skips pending wakes, and stale-marks queued outbox", async () => {
    const h = setup();
    try {
      const conversationId = currentConversation(h.journal, h.bindingId);
      const pendingTask = insertTask(h.orm, conversationId, { status: "pending" });
      const doneTask = insertTask(h.orm, conversationId, { status: "completed" });
      const pendingWake = insertWake(h.orm, conversationId, { status: "pending" });
      const doneWake = insertWake(h.orm, conversationId, { status: "no_output" });
      insertOutbox(h.orm, conversationId, { intentStatus: "planned", partStatus: "planned" });

      const response = await del(h.app, h.bindingId, 1);
      expect(response.status).toBe(204);

      const cancelled = h.orm
        .select()
        .from(schema.qqConversationTasks)
        .all()
        .find((row) => row.id === pendingTask);
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.errorCode).toBe("binding_removed");
      const untouched = h.orm
        .select()
        .from(schema.qqConversationTasks)
        .all()
        .find((row) => row.id === doneTask);
      expect(untouched?.status).toBe("completed");
      expect(untouched?.errorCode).toBeNull();

      const skipped = h.orm
        .select()
        .from(schema.wakeSignals)
        .all()
        .find((row) => row.id === pendingWake);
      expect(skipped?.status).toBe("no_output");
      expect(skipped?.errorCode).toBe("binding_removed");
      const doneWakeRow = h.orm
        .select()
        .from(schema.wakeSignals)
        .all()
        .find((row) => row.id === doneWake);
      expect(doneWakeRow?.status).toBe("no_output");

      const intent = h.orm.select().from(schema.outboundIntents).all().at(0);
      expect(intent?.status).toBe("stale");
      // Retained history rows keep their bodies: the plan part was emptied by the existing
      // stale() helper, the completed task/wake rows are untouched.
      const part = h.orm.select().from(schema.outboundParts).all().at(0);
      expect(part?.status).toBe("stale");
    } finally {
      h.business.close();
    }
  });

  it("does not cascade-wipe history: private and group rows survive with their conversation", async () => {
    for (const kind of ["private", "group"] as const) {
      const h = setup({ kind });
      try {
        const conversationId = currentConversation(h.journal, h.bindingId);
        h.orm
          .insert(schema.qqEvents)
          .values({
            eventKey: `evt-${kind}`,
            accountId: h.accountId,
            conversationKind: kind,
            peerId: h.peerId,
            agentId: AGENT,
            messageId: `evt-${kind}`,
            occurredAtSeconds: 1_700_000_000,
            speakerKind: "member",
            speakerId: "20002",
            recordedAt: nowIso(),
          })
          .run();
        h.orm
          .insert(schema.qqConversationSummaries)
          .values({
            conversationId,
            agentId: AGENT,
            throughSeq: 1,
            content: "[]",
            modelName: MODEL,
            configSnapshot: "{}",
            estimatedTokens: 1,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
          .run();
        expect((await del(h.app, h.bindingId, 1)).status).toBe(204);
        expect(h.orm.select().from(schema.qqEvents).all().length).toBe(1);
        expect(
          h.orm
            .select()
            .from(schema.qqConversationSummaries)
            .all()
            .some((row) => row.conversationId === conversationId),
        ).toBe(true);
        expect(h.orm.select().from(schema.conversations).all().length).toBe(1);
      } finally {
        h.business.close();
      }
    }
  });
});
