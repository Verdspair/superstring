// Frozen model-context readings: persistence support only. This batch does not
// activate any model unit and calls no live model; it covers the snapshot write
// path and the guards that keep an old snapshot's absence intact.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { freezeModelContext } from "../../src/server/db/context-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  type Orm,
  prepareTurn,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { type ResolvedModelContext, RuntimeConfigSchema } from "../../src/shared/contracts/agent";

const MODEL = "qwen/qwen3-4b-2507";

const READING: ResolvedModelContext = {
  model: MODEL,
  capacity: 32768,
  tokenizer_encoding: "o200k_base",
  route_revision: 3,
};

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  return { business, orm: business.orm };
}

function newSession(orm: Orm, title = "会话"): string {
  return createSession(orm, title, { modelName: MODEL }).id;
}

function activeTurn(orm: Orm, sessionId: string, key: string, user = "当前问题") {
  const prepared = prepareTurn(orm, sessionId, user, key);
  if (prepared.generationToken === null) throw new Error("fresh token expected");
  const turn = getTurnByRequest(orm, sessionId, key);
  if (!turn) throw new Error("turn missing");
  return { prepared, turn };
}

function storedSnapshot(orm: Orm, turnId: string): Record<string, unknown> {
  const turn = orm.select().from(schema.turns).where(eq(schema.turns.id, turnId)).get();
  if (!turn) throw new Error("turn missing");
  return JSON.parse(turn.runtimeConfigSnapshot) as Record<string, unknown>;
}

function replaceSnapshot(orm: Orm, turnId: string, value: Record<string, unknown>): void {
  orm
    .update(schema.turns)
    .set({ runtimeConfigSnapshot: JSON.stringify(value) })
    .where(eq(schema.turns.id, turnId))
    .run();
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string })?.code).toBe(code);
}

function metadataOf(value: unknown): ResolvedModelContext {
  return value as ResolvedModelContext;
}

describe("frozen model context", () => {
  it("rejects inconsistent capacity on an idempotent metadata retry", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "inconsistent-retry");
      const token = current.prepared.generationToken;
      if (token === null) throw new Error("fresh token expected");
      freezeModelContext(
        ctx.orm,
        DEFAULT_AGENT_ID,
        sessionId,
        current.turn.id,
        MODEL,
        READING,
        token,
      );
      const snapshot = storedSnapshot(ctx.orm, current.turn.id);
      snapshot.resolved_model_capacities = { [MODEL]: 1024 };
      replaceSnapshot(ctx.orm, current.turn.id, snapshot);
      const before = JSON.stringify(storedSnapshot(ctx.orm, current.turn.id));
      expectCode(
        () =>
          freezeModelContext(
            ctx.orm,
            DEFAULT_AGENT_ID,
            sessionId,
            current.turn.id,
            MODEL,
            READING,
            token,
          ),
        "CONTEXT_CAPACITY_INSUFFICIENT",
      );
      expect(JSON.stringify(storedSnapshot(ctx.orm, current.turn.id))).toBe(before);
    } finally {
      ctx.business.close();
    }
  });

  it("writes the first reading and the matching capacity into the snapshot", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f1");
      const token = current.prepared.generationToken;
      if (token === null) throw new Error("fresh token expected");
      const frozen = freezeModelContext(
        ctx.orm,
        DEFAULT_AGENT_ID,
        sessionId,
        current.turn.id,
        MODEL,
        READING,
        token,
      );
      expect(frozen[MODEL]).toEqual(READING);
      const stored = storedSnapshot(ctx.orm, current.turn.id);
      expect(stored.resolved_model_contexts).toEqual({ [MODEL]: READING });
      expect(stored.resolved_model_capacities).toEqual({ [MODEL]: 32768 });
      expect(RuntimeConfigSchema.parse(stored).resolved_model_contexts?.[MODEL]?.capacity).toBe(
        32768,
      );
    } finally {
      ctx.business.close();
    }
  });

  it("keeps a new turn snapshot empty and an old snapshot absent", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f2");
      // A snapshot created now may declare the empty map; the older shape (the
      // field absent) is not silently rewritten here either.
      const fresh = RuntimeConfigSchema.parse(storedSnapshot(ctx.orm, current.turn.id));
      expect(fresh.resolved_model_contexts).toEqual({});
      const legacy = storedSnapshot(ctx.orm, current.turn.id);
      delete legacy.resolved_model_contexts;
      replaceSnapshot(ctx.orm, current.turn.id, legacy);
      const old = RuntimeConfigSchema.parse(storedSnapshot(ctx.orm, current.turn.id));
      expect(old.resolved_model_contexts).toBeUndefined();
    } finally {
      ctx.business.close();
    }
  });

  it("refuses to reinterpret an old snapshot and writes nothing", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f3");
      const legacy = storedSnapshot(ctx.orm, current.turn.id);
      delete legacy.resolved_model_contexts;
      replaceSnapshot(ctx.orm, current.turn.id, legacy);
      const before = JSON.stringify(storedSnapshot(ctx.orm, current.turn.id));
      const token = current.prepared.generationToken;
      if (token === null) throw new Error("fresh token expected");
      expectCode(
        () =>
          freezeModelContext(
            ctx.orm,
            DEFAULT_AGENT_ID,
            sessionId,
            current.turn.id,
            MODEL,
            READING,
            token,
          ),
        "CONTEXT_SOURCE_INVALID",
      );
      expect(JSON.stringify(storedSnapshot(ctx.orm, current.turn.id))).toBe(before);
    } finally {
      ctx.business.close();
    }
  });

  it("is idempotent for the same first reading", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f4");
      const token = current.prepared.generationToken;
      if (token === null) throw new Error("fresh token expected");
      const first = freezeModelContext(
        ctx.orm,
        DEFAULT_AGENT_ID,
        sessionId,
        current.turn.id,
        MODEL,
        READING,
        token,
      );
      const afterFirst = JSON.stringify(storedSnapshot(ctx.orm, current.turn.id));
      const second = freezeModelContext(
        ctx.orm,
        DEFAULT_AGENT_ID,
        sessionId,
        current.turn.id,
        MODEL,
        READING,
        token,
      );
      expect(second).toEqual(first);
      expect(JSON.stringify(storedSnapshot(ctx.orm, current.turn.id))).toBe(afterFirst);
    } finally {
      ctx.business.close();
    }
  });

  it("rejects a differing reading without overwriting the first", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f5");
      const token = current.prepared.generationToken;
      if (token === null) throw new Error("fresh token expected");
      freezeModelContext(
        ctx.orm,
        DEFAULT_AGENT_ID,
        sessionId,
        current.turn.id,
        MODEL,
        READING,
        token,
      );
      const afterFirst = JSON.stringify(storedSnapshot(ctx.orm, current.turn.id));
      expectCode(
        () =>
          freezeModelContext(
            ctx.orm,
            DEFAULT_AGENT_ID,
            sessionId,
            current.turn.id,
            MODEL,
            { ...READING, route_revision: 4 },
            token,
          ),
        "CONTEXT_CAPACITY_INSUFFICIENT",
      );
      expect(JSON.stringify(storedSnapshot(ctx.orm, current.turn.id))).toBe(afterFirst);
    } finally {
      ctx.business.close();
    }
  });

  it("rejects a capacity that disagrees with the frozen capacity", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f6");
      const seeded = storedSnapshot(ctx.orm, current.turn.id);
      seeded.resolved_model_capacities = { [MODEL]: 16384 };
      replaceSnapshot(ctx.orm, current.turn.id, seeded);
      const before = JSON.stringify(storedSnapshot(ctx.orm, current.turn.id));
      const token = current.prepared.generationToken;
      if (token === null) throw new Error("fresh token expected");
      expectCode(
        () =>
          freezeModelContext(
            ctx.orm,
            DEFAULT_AGENT_ID,
            sessionId,
            current.turn.id,
            MODEL,
            READING,
            token,
          ),
        "CONTEXT_CAPACITY_INSUFFICIENT",
      );
      expect(JSON.stringify(storedSnapshot(ctx.orm, current.turn.id))).toBe(before);
    } finally {
      ctx.business.close();
    }
  });

  it("keeps an already matching frozen capacity entry", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f7");
      const seeded = storedSnapshot(ctx.orm, current.turn.id);
      seeded.resolved_model_capacities = { [MODEL]: 32768 };
      replaceSnapshot(ctx.orm, current.turn.id, seeded);
      const token = current.prepared.generationToken;
      if (token === null) throw new Error("fresh token expected");
      freezeModelContext(
        ctx.orm,
        DEFAULT_AGENT_ID,
        sessionId,
        current.turn.id,
        MODEL,
        READING,
        token,
      );
      const stored = storedSnapshot(ctx.orm, current.turn.id);
      expect(stored.resolved_model_capacities).toEqual({ [MODEL]: 32768 });
      expect(stored.resolved_model_contexts).toEqual({ [MODEL]: READING });
    } finally {
      ctx.business.close();
    }
  });

  it("rejects a stale generation token", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f8");
      expectCode(
        () =>
          freezeModelContext(
            ctx.orm,
            DEFAULT_AGENT_ID,
            sessionId,
            current.turn.id,
            MODEL,
            READING,
            "stale-generation-token",
          ),
        "CONTEXT_SOURCE_INVALID",
      );
      expect(storedSnapshot(ctx.orm, current.turn.id).resolved_model_contexts).toEqual({});
    } finally {
      ctx.business.close();
    }
  });

  it("rejects a missing generation token", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f9");
      expectCode(
        () =>
          freezeModelContext(
            ctx.orm,
            DEFAULT_AGENT_ID,
            sessionId,
            current.turn.id,
            MODEL,
            READING,
            null,
          ),
        "CONTEXT_SOURCE_INVALID",
      );
    } finally {
      ctx.business.close();
    }
  });

  it("rejects a model outside this turn's snapshot", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f10");
      const token = current.prepared.generationToken;
      if (token === null) throw new Error("fresh token expected");
      expectCode(
        () =>
          freezeModelContext(
            ctx.orm,
            DEFAULT_AGENT_ID,
            sessionId,
            current.turn.id,
            "other/model",
            { ...READING, model: "other/model" },
            token,
          ),
        "CONTEXT_SOURCE_INVALID",
      );
      expect(storedSnapshot(ctx.orm, current.turn.id).resolved_model_contexts).toEqual({});
    } finally {
      ctx.business.close();
    }
  });

  it("rejects invalid metadata before touching the snapshot", () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "f11");
      const token = current.prepared.generationToken;
      if (token === null) throw new Error("fresh token expected");
      const before = JSON.stringify(storedSnapshot(ctx.orm, current.turn.id));
      for (const bad of [
        { ...READING, model: "" },
        { ...READING, capacity: 0 },
        { ...READING, capacity: 1.5 },
        { ...READING, tokenizer_encoding: "p50k" },
        { ...READING, route_revision: -1 },
      ]) {
        expectCode(
          () =>
            freezeModelContext(
              ctx.orm,
              DEFAULT_AGENT_ID,
              sessionId,
              current.turn.id,
              MODEL,
              metadataOf(bad),
              token,
            ),
          "CONTEXT_SOURCE_INVALID",
        );
      }
      expect(JSON.stringify(storedSnapshot(ctx.orm, current.turn.id))).toBe(before);
    } finally {
      ctx.business.close();
    }
  });
});
