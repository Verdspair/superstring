// Account changes inspect every affected QQ binding and stored source epoch.
// These fixtures stay in memory; no QQ transport, model or private configuration is used.

import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { readQqSettings, updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_USER_ID, ensureDefaults, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { AppError } from "../../src/server/errors";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT = "00000000-0000-0000-0000-000000000001";
const OUTGOING = "10001";
const INCOMING = "10002";
const AT = "2026-10-24T00:00:00.000000Z";
const FUTURE = "2099-01-01T00:00:00.000000Z";

type Source = { bindingId: string; conversationId: string; accountId: string; epoch: number };

function addBinding(orm: Orm, schemeId: string, accountId: string, peerId: string): Source {
  const bindingId = crypto.randomUUID();
  orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId,
      conversationKind: "group",
      peerId,
      agentId: AGENT,
      schemeId,
      createdAt: AT,
      updatedAt: AT,
    })
    .run();
  const conversationId = crypto.randomUUID();
  for (const epoch of [1, 2]) {
    orm
      .insert(schema.conversations)
      .values({
        id: epoch === 1 ? conversationId : crypto.randomUUID(),
        channel: "onebot11",
        topology: "direct",
        sourceId: bindingId,
        agentId: AGENT,
        userId: DEFAULT_USER_ID,
        bindingEpoch: epoch,
        createdAt: AT,
        updatedAt: AT,
        closedAt: epoch === 1 ? AT : null,
      })
      .run();
  }
  return { bindingId, conversationId, accountId, epoch: 1 };
}

function setup(accountId: string | null = OUTGOING) {
  const business = openBusinessDb({ path: ":memory:" });
  const orm = business.orm;
  ensureDefaults(orm, MODEL);
  orm.update(schema.qqSettings).set({ accountId }).run();
  const scheme = createQqScheme(orm, { name: "synthetic switch" });
  const outgoing = [
    addBinding(orm, scheme.id, OUTGOING, "30001"),
    addBinding(orm, scheme.id, OUTGOING, "30002"),
  ];
  const incoming = [
    addBinding(orm, scheme.id, INCOMING, "30001"),
    addBinding(orm, scheme.id, INCOMING, "30002"),
  ];
  return { business, orm, schemeId: scheme.id, outgoing, incoming };
}

function task(orm: Orm, source: Source, status: string) {
  const id = crypto.randomUUID();
  orm
    .insert(schema.qqConversationTasks)
    .values({
      id,
      taskKey: `task-${id}`,
      conversationId: source.conversationId,
      bindingEpoch: source.epoch,
      agentId: AGENT,
      taskClass: "ordinary",
      cause: "follow_up",
      sourceFromSeq: 0,
      sourceThroughSeq: 1,
      status,
      leaseToken: status === "running" ? `task-lease-${id}` : null,
      leaseExpiresAt: status === "running" ? FUTURE : null,
      createdAt: AT,
      updatedAt: AT,
    })
    .run();
}

function run(orm: Orm, source: Source, endedAt: string | null) {
  const runId = crypto.randomUUID();
  orm
    .insert(schema.agentRuns)
    .values({
      runId,
      conversationId: source.conversationId,
      specId: "qq-reply",
      specVersion: "1",
      ownerKind: "conversation",
      ownerId: source.conversationId,
      userId: DEFAULT_USER_ID,
      agentId: AGENT,
      // A terminal-looking status still blocks when its end stamp is missing.
      status: "completed",
      startedAt: AT,
      endedAt,
    })
    .run();
  return runId;
}

function wake(orm: Orm, source: Source, status: string) {
  const id = crypto.randomUUID();
  orm
    .insert(schema.wakeSignals)
    .values({
      id,
      conversationId: source.conversationId,
      cause: "direct_reply",
      throughSeq: 1,
      dedupeKey: `wake-${id}`,
      readyAt: AT,
      priority: 0,
      status,
      leaseToken: status === "leased" ? `wake-lease-${id}` : null,
      leaseExpiresAt: status === "leased" ? FUTURE : null,
      createdAt: AT,
    })
    .run();
}

function outbox(orm: Orm, source: Source, intentStatus: string, partStatus: string) {
  const intentId = crypto.randomUUID();
  orm
    .insert(schema.outboundIntents)
    .values({
      id: intentId,
      runId: run(orm, source, AT),
      conversationId: source.conversationId,
      outputOrdinal: 0,
      target: JSON.stringify({
        accountId: source.accountId,
        conversationKind: "group",
        peerId: "30002",
      }),
      speechKind: "direct_reply",
      sourceThroughSeq: 1,
      deliverBy: FUTURE,
      status: intentStatus,
      createdAt: AT,
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
      payload: JSON.stringify({ text: "synthetic retained output" }),
      status: partStatus,
    })
    .run();
}

function retained(orm: Orm) {
  return {
    bindings: orm.select().from(schema.qqBindings).all(),
    conversations: orm.select().from(schema.conversations).all(),
    tasks: orm.select().from(schema.qqConversationTasks).all(),
    runs: orm.select().from(schema.agentRuns).all(),
    wakes: orm.select().from(schema.wakeSignals).all(),
    intents: orm.select().from(schema.outboundIntents).all(),
    parts: orm.select().from(schema.outboundParts).all(),
    events: orm.select().from(schema.qqEvents).all(),
    summaries: orm.select().from(schema.qqConversationSummaries).all(),
  };
}

function conflict(action: () => unknown): AppError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ code: "MEMORY_STATE_CONFLICT", statusCode: 409 });
  return caught as AppError;
}

const unsafe = [
  ["running QQ task", (orm: Orm, source: Source) => task(orm, source, "running")],
  ["unfinished Agent run", (orm: Orm, source: Source) => run(orm, source, null)],
  ["leased wake", (orm: Orm, source: Source) => wake(orm, source, "leased")],
  ["unknown intent", (orm: Orm, source: Source) => outbox(orm, source, "unknown", "confirmed")],
  ["sending part", (orm: Orm, source: Source) => outbox(orm, source, "delivering", "sending")],
  ["unknown part", (orm: Orm, source: Source) => outbox(orm, source, "delivering", "unknown")],
] as const;

describe("QQ account switch guard", () => {
  it.each(unsafe)("refuses %s on either account's second binding and closed epoch", (_, add) => {
    for (const side of ["outgoing", "incoming"] as const) {
      const h = setup();
      try {
        add(h.orm, h[side][1]);
        const before = readQqSettings(h.orm);
        const history = retained(h.orm);
        conflict(() =>
          updateQqSettings(h.orm, {
            accountId: INCOMING,
            enabled: true,
            judgementModelName: "new-judge",
            expectedRevision: before.revision,
          }),
        );
        expect(readQqSettings(h.orm)).toEqual(before);
        expect(retained(h.orm)).toEqual(history);
      } finally {
        h.business.close();
      }
    }
  });

  it("guards clearing an account and selecting one from null", async () => {
    for (const clearing of [true, false]) {
      const h = setup(clearing ? OUTGOING : null);
      try {
        task(h.orm, clearing ? h.outgoing[1] : h.incoming[1], "running");
        const app = createApp({ business: h.business });
        const before = readQqSettings(h.orm);
        const history = retained(h.orm);
        const response = await app.request("/qq/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            account_id: clearing ? null : INCOMING,
            enabled: true,
            expected_revision: before.revision,
          }),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: { code: "MEMORY_STATE_CONFLICT" },
        });
        expect(readQqSettings(h.orm)).toEqual(before);
        expect(retained(h.orm)).toEqual(history);
      } finally {
        h.business.close();
      }
    }
  });

  it("checks stale CAS first but does not block same-account or ordinary settings saves", () => {
    const h = setup();
    try {
      task(h.orm, h.outgoing[1], "running");
      const before = readQqSettings(h.orm);
      const history = retained(h.orm);
      const stale = conflict(() =>
        updateQqSettings(h.orm, {
          accountId: INCOMING,
          enabled: true,
          expectedRevision: before.revision + 1,
        }),
      );
      expect(stale.message).toBe("设置已变化，请重新加载后保存");
      expect(readQqSettings(h.orm)).toEqual(before);
      expect(retained(h.orm)).toEqual(history);
      const same = updateQqSettings(h.orm, {
        accountId: OUTGOING,
        expectedRevision: before.revision,
      });
      expect(same).toEqual(before);
      conflict(() =>
        updateQqSettings(h.orm, {
          accountId: OUTGOING,
          expectedRevision: before.revision + 1,
        }),
      );
      const enabled = updateQqSettings(h.orm, {
        enabled: true,
        expectedRevision: same.revision,
      });
      expect(enabled).toEqual({ ...before, enabled: 1, revision: before.revision + 1 });
      const judged = updateQqSettings(h.orm, {
        accountId: OUTGOING,
        judgementModelName: "new-judge",
        expectedRevision: enabled.revision,
      });
      expect(judged).toEqual({
        ...enabled,
        judgementModelName: "new-judge",
        revision: enabled.revision + 1,
      });
      expect(retained(h.orm)).toEqual(history);
    } finally {
      h.business.close();
    }
  });

  it("allows settled and queued work without changing bindings, epochs or owners", () => {
    const h = setup();
    try {
      for (const source of [h.outgoing[1], h.incoming[1]]) {
        for (const status of [
          "pending",
          "completed",
          "failed",
          "cancelled",
          "no_output",
          "expired",
        ]) {
          task(h.orm, source, status);
        }
        wake(h.orm, source, "pending");
        wake(h.orm, source, "no_output");
        for (const status of ["planned", "confirmed", "failed", "stale"]) {
          outbox(h.orm, source, status, status);
        }
        h.orm
          .insert(schema.qqConversationSummaries)
          .values({
            conversationId: source.conversationId,
            agentId: AGENT,
            throughSeq: 1,
            content: JSON.stringify("synthetic retained history"),
            modelName: MODEL,
            configSnapshot: "{}",
            estimatedTokens: 1,
            createdAt: AT,
            updatedAt: AT,
          })
          .run();
        h.orm
          .insert(schema.qqEvents)
          .values({
            eventKey: `event-${source.bindingId}`,
            accountId: source.accountId,
            conversationKind: "group",
            peerId: "30002",
            agentId: AGENT,
            messageId: `message-${source.bindingId}`,
            occurredAtSeconds: 1,
            speakerKind: "member",
            speakerId: "20001",
            recordedAt: AT,
          })
          .run();
      }
      // Work belonging to an unrelated account is outside this switch's scope.
      const unrelated = addBinding(h.orm, h.schemeId, "10003", "30002");
      for (const [, add] of unsafe) add(h.orm, unrelated);
      const before = readQqSettings(h.orm);
      const history = retained(h.orm);
      const switched = updateQqSettings(h.orm, {
        accountId: INCOMING,
        enabled: true,
        expectedRevision: before.revision,
      });
      expect(switched).toEqual({
        ...before,
        accountId: INCOMING,
        enabled: 1,
        revision: before.revision + 1,
      });
      expect(retained(h.orm)).toEqual(history);
    } finally {
      h.business.close();
    }
  });
});
