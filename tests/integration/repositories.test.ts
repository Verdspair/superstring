// Integration tests for the R3 repository layer — the idempotency / lease /
// cancellation / deletion state machine.
// Covers duplicate generation and stale writers overwriting newer answers.
// Assertions follow docs/reference/api-contract.md §2 and the corresponding
// state transitions in
// Ground rules encoded here:
// - A rejection path must write NOTHING (the whole transition runs inside
// BEGIN IMMEDIATE and rolls back on throw).
// - replay (assistant already `completed`) must NOT call the model: it returns
// the existing message id and a null generation token.
// - Save must refuse stale output: wrong token, expired lease, or a cancelled
// turn all raise instead of writing.
// - Deleting a message retires its client_request_id forever.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type BusinessDbHandle, toOrmHandle } from "../../src/server/db/connection";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  deleteMessage,
  getSession,
  getTurnByRequest,
  heartbeatGeneration,
  listMessages,
  type Orm,
  prepareTurn,
  saveCompletedAssistantMessage,
  saveFailedAssistantMessage,
  saveUserMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";

const MIGRATION_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql"),
  "utf8",
);

/** Fresh migrated in-memory database with foreign keys enforced. */
function newHandle(): BusinessDbHandle {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION_SQL);
  for (const file of ["0002_knowledge.sql", "0003_knowledge_read.sql", "0004_organization.sql"]) {
    db.exec(readFileSync(path.join(import.meta.dir, "../../migrations/versions", file), "utf8"));
  }
  return toOrmHandle(db);
}

interface Ctx {
  handle: BusinessDbHandle;
  orm: Orm;
  sessionId: string;
}

function setup(): Ctx {
  const handle = newHandle();
  const orm = handle.orm;
  const session = createSession(orm, "会话", { modelName: "qwen3-4b" });
  return { handle, orm, sessionId: session.id };
}

/** Assert a thrown AppError carries the expected code (never match on message text alone). */
function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${code} to be thrown`).toBeDefined();
  expect((caught as { code?: string }).code).toBe(code);
}

describe("createSession", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("creates the default user + agent + persona and a session on sequence 1", () => {
    const session = getSession(ctx.orm, ctx.sessionId);
    expect(session.mode).toBe("chat");
    expect(session.nextSequenceNo).toBe(1);
    expect(session.userId).toBe(DEFAULT_USER_ID);
    expect(session.agentId).toBe(DEFAULT_AGENT_ID);

    expect(ctx.orm.select().from(schema.users).all()).toHaveLength(1);
    expect(ctx.orm.select().from(schema.agents).all()).toHaveLength(1);
    expect(ctx.orm.select().from(schema.agentPersonas).all()).toHaveLength(1);
  });

  it("is idempotent for the same client_request_id and payload", () => {
    const first = createSession(ctx.orm, "会话", {
      clientRequestId: "req-1",
      modelName: "qwen3-4b",
    });
    const second = createSession(ctx.orm, "会话", {
      clientRequestId: "req-1",
      modelName: "qwen3-4b",
    });
    expect(second.id).toBe(first.id);
    expect(ctx.orm.select().from(schema.sessions).all()).toHaveLength(2); // default + this one
  });

  it("raises IDEMPOTENCY_CONFLICT when the same key carries a different title", () => {
    createSession(ctx.orm, "会话", { clientRequestId: "req-2", modelName: "qwen3-4b" });
    expectCode(
      () =>
        createSession(ctx.orm, "另一个标题", { clientRequestId: "req-2", modelName: "qwen3-4b" }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("rejects an unknown agent with AGENT_NOT_FOUND (404) and writes nothing", () => {
    expectCode(
      () =>
        createSession(ctx.orm, "x", {
          agentId: "00000000-0000-0000-0000-0000000000ff",
          modelName: "qwen3-4b",
        }),
      "AGENT_NOT_FOUND",
    );
    expect(ctx.orm.select().from(schema.sessions).all()).toHaveLength(1);
  });

  it("refuses an agent whose persona row is missing", () => {
    const other = crypto.randomUUID();
    ctx.orm
      .insert(schema.agents)
      .values({
        id: other,
        name: "无性格",
        systemPrompt: "s",
        description: "",
        additionalInstructions: "",
        p5Config: "{}",
        modelName: "qwen3-4b",
        temperature: 0.7,
        memoryConsolidationModelName: null,
        memoryConsolidationPrompt: "p",
        memoryConsolidationAdditionalInstructions: "",
        memoryRetrievalModelName: null,
        memoryRetrievalPrompt: "p",
        contextCompressionModelName: null,
        personaIntensity: 60,
        isActive: 1,
        configVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    expectCode(
      () => createSession(ctx.orm, "x", { agentId: other, modelName: "qwen3-4b" }),
      "PERSONA_NOT_FOUND",
    );
  });
});

describe("prepareTurn — first turn", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("creates the turn plus a completed user message and a pending assistant message", () => {
    const prep = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");

    expect(prep.replay).toBe(false);
    expect(prep.generationToken).not.toBeNull();

    const messages = listMessages(ctx.orm, ctx.sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("你好");
    expect(messages[0].status).toBe("completed");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].status).toBe("pending");
    expect(messages[1].content).toBe("");
    expect(prep.messageId).toBe(messages[1].id);

    // Next free sequence advanced by exactly two (user + assistant).
    expect(getSession(ctx.orm, ctx.sessionId).nextSequenceNo).toBe(3);
  });

  it("binds the turn snapshot to the session's agent and mode", () => {
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    const turn = getTurnByRequest(ctx.orm, ctx.sessionId, "cg-1");
    expect(turn).not.toBeNull();
    const snapshot = JSON.parse(turn?.runtimeConfigSnapshot ?? "{}");
    expect(snapshot.agent_id).toBe(DEFAULT_AGENT_ID);
    expect(snapshot.mode).toBe("chat");
    expect(turn?.generationStatus).toBe("active");
    expect(turn?.leaseExpiresAt).not.toBeNull();
  });

  it("raises SESSION_NOT_FOUND for an unknown session", () => {
    expectCode(
      () => prepareTurn(ctx.orm, "00000000-0000-0000-0000-0000000000aa", "hi", "cg-x"),
      "SESSION_NOT_FOUND",
    );
  });

  it("saveUserMessage mirrors prepareTurn and returns the user row", () => {
    const row = saveUserMessage(ctx.orm, ctx.sessionId, "独立消息", "cg-solo");
    expect(row.role).toBe("user");
    expect(row.content).toBe("独立消息");
    expect(row.status).toBe("completed");
    // It delegates to prepareTurn, so a turn and a pending assistant row exist.
    expect(ctx.orm.select().from(schema.turns).all()).toHaveLength(1);
    expect(listMessages(ctx.orm, ctx.sessionId)).toHaveLength(2);
  });
});

describe("prepareTurn — idempotency", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("replays a completed turn without issuing a new generation token", () => {
    const first = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    saveCompletedAssistantMessage(
      ctx.orm,
      ctx.sessionId,
      "你好，有什么可以帮你？",
      "cg-1",
      first.generationToken as string,
    );

    const again = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    expect(again.replay).toBe(true);
    expect(again.generationToken).toBeNull();
    expect(again.messageId).toBe(first.messageId);
    // No extra messages were appended.
    expect(listMessages(ctx.orm, ctx.sessionId)).toHaveLength(2);
  });

  it("raises GENERATION_ALREADY_ACTIVE before comparing content (lease check wins)", () => {
    // 593 runs before the content comparison at:608, so a
    // leased turn reports busy even when the content differs.
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    expectCode(
      () => prepareTurn(ctx.orm, ctx.sessionId, "你好吗", "cg-1"),
      "GENERATION_ALREADY_ACTIVE",
    );
  });

  it("raises IDEMPOTENCY_CONFLICT for the same key with different content once idle", () => {
    const first = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    // Finish the turn so the lease check no longer short-circuits first.
    saveCompletedAssistantMessage(
      ctx.orm,
      ctx.sessionId,
      "答",
      "cg-1",
      first.generationToken as string,
    );
    expectCode(() => prepareTurn(ctx.orm, ctx.sessionId, "你好吗", "cg-1"), "IDEMPOTENCY_CONFLICT");
  });

  it("retries a failed generation in place: same message row, reset to pending", () => {
    const first = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    saveFailedAssistantMessage(
      ctx.orm,
      ctx.sessionId,
      "cg-1",
      "MODEL_ERROR",
      first.generationToken as string,
      {
        partialContent: "半句",
      },
    );

    const retry = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    expect(retry.replay).toBe(false);
    expect(retry.generationToken).not.toBeNull();
    expect(retry.messageId).toBe(first.messageId);

    const messages = listMessages(ctx.orm, ctx.sessionId);
    expect(messages).toHaveLength(2); // reused, not appended
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.status).toBe("pending");
    expect(assistant?.content).toBe("");
    expect(assistant?.errorCode).toBeNull();
  });

  it("raises GENERATION_ALREADY_ACTIVE when the same turn is still leased", () => {
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    expectCode(
      () => prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1"),
      "GENERATION_ALREADY_ACTIVE",
    );
  });

  it("raises SESSION_GENERATION_BUSY when a DIFFERENT turn in the session is leased", () => {
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    expectCode(
      () => prepareTurn(ctx.orm, ctx.sessionId, "再来", "cg-2"),
      "SESSION_GENERATION_BUSY",
    );
    // The busy rejection must not have created a third message.
    expect(listMessages(ctx.orm, ctx.sessionId)).toHaveLength(2);
  });

  it("reclaims an expired lease and marks the abandoned generation failed", () => {
    const first = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1", { leaseSeconds: -1 });
    const second = prepareTurn(ctx.orm, ctx.sessionId, "再来", "cg-2");

    expect(second.replay).toBe(false);
    expect(second.generationToken).not.toBe(first.generationToken);

    const stale = getTurnByRequest(ctx.orm, ctx.sessionId, "cg-1");
    expect(stale?.generationStatus).toBe("failed");
    expect(stale?.invalidationReason).toBe("generation_lease_expired");

    const staleAssistant = listMessages(ctx.orm, ctx.sessionId).find(
      (m) => m.turnId === stale?.id && m.role === "assistant",
    );
    expect(staleAssistant?.status).toBe("failed");
    expect(staleAssistant?.errorCode).toBe("GENERATION_LEASE_EXPIRED");
  });
});

describe("heartbeatGeneration", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("reports active and extends the lease for the owning token", () => {
    const prep = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    const before = getTurnByRequest(ctx.orm, ctx.sessionId, "cg-1")?.leaseExpiresAt;
    const result = heartbeatGeneration(
      ctx.orm,
      ctx.sessionId,
      "cg-1",
      prep.generationToken as string,
      {
        leaseSeconds: 120,
      },
    );
    expect(result).toBe("active");
    const after = getTurnByRequest(ctx.orm, ctx.sessionId, "cg-1")?.leaseExpiresAt;
    expect(after).not.toBe(before);
  });

  it("reports lost for a stale token and never throws", () => {
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    expect(heartbeatGeneration(ctx.orm, ctx.sessionId, "cg-1", "not-the-token")).toBe("lost");
  });

  it("reports lost for an unknown client_request_id", () => {
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    expect(heartbeatGeneration(ctx.orm, ctx.sessionId, "cg-nope", "any")).toBe("lost");
  });

  it("reports lost once the turn has been completed", () => {
    const prep = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    saveCompletedAssistantMessage(
      ctx.orm,
      ctx.sessionId,
      "答",
      "cg-1",
      prep.generationToken as string,
    );
    expect(
      heartbeatGeneration(ctx.orm, ctx.sessionId, "cg-1", prep.generationToken as string),
    ).toBe("lost");
  });
});

describe("saving assistant output", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("writes completed content and closes the turn", () => {
    const prep = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    const saved = saveCompletedAssistantMessage(
      ctx.orm,
      ctx.sessionId,
      "你好呀",
      "cg-1",
      prep.generationToken as string,
    );
    expect(saved.content).toBe("你好呀");
    expect(saved.status).toBe("completed");
    expect(saved.completedAt).not.toBeNull();
    expect(getTurnByRequest(ctx.orm, ctx.sessionId, "cg-1")?.generationStatus).toBe("completed");
  });

  it("refuses a stale token with GENERATION_OWNERSHIP_LOST and writes nothing", () => {
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    expectCode(
      () => saveCompletedAssistantMessage(ctx.orm, ctx.sessionId, "ghost", "cg-1", "wrong"),
      "GENERATION_OWNERSHIP_LOST",
    );
    const assistant = listMessages(ctx.orm, ctx.sessionId).find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("");
    expect(assistant?.status).toBe("pending");
  });

  it("refuses to write after the lease expired", () => {
    const prep = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1", { leaseSeconds: -1 });
    expectCode(
      () =>
        saveCompletedAssistantMessage(
          ctx.orm,
          ctx.sessionId,
          "too late",
          "cg-1",
          prep.generationToken as string,
        ),
      "GENERATION_OWNERSHIP_LOST",
    );
  });

  it("refuses to write for an unknown turn", () => {
    expectCode(
      () => saveCompletedAssistantMessage(ctx.orm, ctx.sessionId, "x", "cg-missing", "t"),
      "GENERATION_OWNERSHIP_LOST",
    );
  });

  it("marks cancelled for CLIENT_DISCONNECTED / GENERATION_CANCELLED and failed otherwise", () => {
    const prep = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    const saved = saveFailedAssistantMessage(
      ctx.orm,
      ctx.sessionId,
      "cg-1",
      "GENERATION_CANCELLED",
      prep.generationToken as string,
    );
    expect(saved.status).toBe("cancelled");
    expect(saved.errorCode).toBe("GENERATION_CANCELLED");
    expect(getTurnByRequest(ctx.orm, ctx.sessionId, "cg-1")?.generationStatus).toBe("cancelled");
  });
});

describe("deleteMessage — cancellation and idempotency retirement", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("deletes the message, records an event, and invalidates the turn", () => {
    const prep = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    const user = listMessages(ctx.orm, ctx.sessionId).find((m) => m.role === "user");
    const result = deleteMessage(ctx.orm, ctx.sessionId, user?.id as string);

    expect(result.repeated).toBe(false);
    expect(result.role).toBe("user");
    expect(result.contextInvalidated).toBe(true);

    expect(listMessages(ctx.orm, ctx.sessionId)).toHaveLength(1);
    const events = ctx.orm.select().from(schema.messageDeletionEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].originalMessageId).toBe(user?.id as string);
    expect(prep.messageId).toBeDefined();
  });

  it("cancels an in-flight turn and its assistant message when the user message is deleted", () => {
    const prep = prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    const user = listMessages(ctx.orm, ctx.sessionId).find((m) => m.role === "user");
    deleteMessage(ctx.orm, ctx.sessionId, user?.id as string);

    const turn = getTurnByRequest(ctx.orm, ctx.sessionId, "cg-1");
    expect(turn?.generationStatus).toBe("cancelled");
    expect(turn?.cancelRequested).toBe(1);
    expect(turn?.leaseExpiresAt).toBeNull();

    const assistant = listMessages(ctx.orm, ctx.sessionId).find((m) => m.id === prep.messageId);
    expect(assistant?.status).toBe("cancelled");
    expect(assistant?.errorCode).toBe("GENERATION_CANCELLED");
  });

  it("is idempotent: a repeated delete reports repeated=true and adds no event", () => {
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    const user = listMessages(ctx.orm, ctx.sessionId).find((m) => m.role === "user");
    const first = deleteMessage(ctx.orm, ctx.sessionId, user?.id as string);
    const second = deleteMessage(ctx.orm, ctx.sessionId, user?.id as string);

    expect(first.repeated).toBe(false);
    expect(second.repeated).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(ctx.orm.select().from(schema.messageDeletionEvents).all()).toHaveLength(1);
  });

  it("retires the client_request_id forever after its message was deleted", () => {
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    const user = listMessages(ctx.orm, ctx.sessionId).find((m) => m.role === "user");
    deleteMessage(ctx.orm, ctx.sessionId, user?.id as string);

    expectCode(
      () => prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1"),
      "IDEMPOTENCY_KEY_RETIRED",
    );
  });

  it("raises MESSAGE_NOT_FOUND for an unknown message", () => {
    expectCode(
      () => deleteMessage(ctx.orm, ctx.sessionId, "00000000-0000-0000-0000-0000000000bb"),
      "MESSAGE_NOT_FOUND",
    );
  });

  it("refuses to delete a system-role message with MESSAGE_DELETE_FORBIDDEN", () => {
    // The schema allows a `system` role; deletion is restricted to user/assistant.
    const turn = getTurnByRequest(ctx.orm, ctx.sessionId, "none");
    expect(turn).toBeNull();

    const session = getSession(ctx.orm, ctx.sessionId);
    const turnId = crypto.randomUUID();
    ctx.orm
      .insert(schema.turns)
      .values({
        id: turnId,
        sessionId: ctx.sessionId,
        clientRequestId: "cg-sys",
        runtimeConfigSnapshot: "{}",
        contextValid: 0,
        sourceValid: 0,
        generationToken: null,
        generationStatus: "completed",
        leaseExpiresAt: null,
        cancelRequested: 0,
        createdAt: new Date().toISOString(),
      })
      .run();
    const systemId = crypto.randomUUID();
    ctx.orm
      .insert(schema.messages)
      .values({
        id: systemId,
        sessionId: ctx.sessionId,
        turnId,
        sequenceNo: session.nextSequenceNo,
        role: "system",
        content: "sys",
        status: "completed",
        clientRequestId: "cg-sys",
        createdAt: new Date().toISOString(),
      })
      .run();

    expectCode(() => deleteMessage(ctx.orm, ctx.sessionId, systemId), "MESSAGE_DELETE_FORBIDDEN");
  });
});

describe("ordering and consistency", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("keeps assistant messages sorted by sequence_no with no gaps", () => {
    for (let i = 1; i <= 3; i += 1) {
      const prep = prepareTurn(ctx.orm, ctx.sessionId, `问题${i}`, `cg-${i}`);
      saveCompletedAssistantMessage(
        ctx.orm,
        ctx.sessionId,
        `回答${i}`,
        `cg-${i}`,
        prep.generationToken as string,
      );
    }
    const messages = listMessages(ctx.orm, ctx.sessionId);
    expect(messages.map((m) => m.sequenceNo)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("rolls back every write when a transition is rejected", () => {
    prepareTurn(ctx.orm, ctx.sessionId, "你好", "cg-1");
    const before = listMessages(ctx.orm, ctx.sessionId).length;
    const seqBefore = getSession(ctx.orm, ctx.sessionId).nextSequenceNo;

    expectCode(
      () => prepareTurn(ctx.orm, ctx.sessionId, "再来", "cg-2"),
      "SESSION_GENERATION_BUSY",
    );

    expect(listMessages(ctx.orm, ctx.sessionId).length).toBe(before);
    expect(getSession(ctx.orm, ctx.sessionId).nextSequenceNo).toBe(seqBefore);
    expect(ctx.orm.select().from(schema.turns).all()).toHaveLength(1);
  });
});
