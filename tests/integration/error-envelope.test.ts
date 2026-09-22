import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  DatabaseError,
  errorPayload,
  handleError,
  isDatabaseError,
} from "../../src/server/api/error-handler";
import {
  type AppError,
  DatabaseUnavailableError,
  EmptyModelResponseError,
  fail,
  GenerationAlreadyActiveError,
  GenerationCancelledError,
  GenerationOwnershipLostError,
  IdempotencyConflictError,
  IdempotencyKeyRetiredError,
  isAppError,
  MessageDeleteForbiddenError,
  MessageNotFoundError,
  ModelUnavailableError,
  SessionGenerationBusyError,
  SessionNotFoundError,
  ValidationError,
} from "../../src/server/errors";
import { type ErrorCode, ErrorCodeSchema } from "../../src/shared/contracts/errors";

/** Builds a throwaway Hono app whose only route throws `err`. */
function appThrowing(err: unknown): Hono {
  const app = new Hono();
  app.onError(handleError);
  app.get("/boom", () => {
    throw err;
  });
  return app;
}

/**
 * Produces a genuine `SQLiteError` by provoking bun:sqlite directly. The class
 * cannot be constructed from user code (`new SQLiteError()` throws), so we run
 * a malformed statement to obtain a real instance — the same shape the storage
 * layer throws and that R6 #83-1 must map to DATABASE_UNAVAILABLE.
 */
function rawSqliteError(): unknown {
  const db = new Database(":memory:");
  try {
    db.run("THIS IS NOT VALID SQL");
    return new Error("expected a sqlite error to be thrown");
  } catch (error) {
    return error;
  } finally {
    db.close();
  }
}

async function envelopeFor(err: unknown) {
  const res = await appThrowing(err).request("/boom");
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("error payload shape", () => {
  it("omits request_id when not provided", () => {
    expect(errorPayload("SESSION_NOT_FOUND", "会话不存在，请先新建会话")).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "会话不存在，请先新建会话" },
    });
  });

  it("includes request_id only when provided", () => {
    expect(errorPayload("MODEL_ERROR", "本地模型调用失败", "req-1")).toEqual({
      error: {
        code: "MODEL_ERROR",
        message: "本地模型调用失败",
        request_id: "req-1",
      },
    });
  });
});

describe(" class parity — status codes", () => {
  const cases: Array<[AppError, number, ErrorCode]> = [
    [new SessionNotFoundError(), 404, "SESSION_NOT_FOUND"],
    [new MessageNotFoundError(), 404, "MESSAGE_NOT_FOUND"],
    [new MessageDeleteForbiddenError(), 400, "MESSAGE_DELETE_FORBIDDEN"],
    [new IdempotencyConflictError(), 409, "IDEMPOTENCY_CONFLICT"],
    [new IdempotencyKeyRetiredError(), 409, "IDEMPOTENCY_KEY_RETIRED"],
    [new GenerationAlreadyActiveError(), 409, "GENERATION_ALREADY_ACTIVE"],
    [new SessionGenerationBusyError(), 409, "SESSION_GENERATION_BUSY"],
    [new GenerationOwnershipLostError(), 409, "GENERATION_OWNERSHIP_LOST"],
    [new GenerationCancelledError(), 409, "GENERATION_CANCELLED"],
    [new EmptyModelResponseError(), 502, "MODEL_EMPTY_RESPONSE"],
    [new DatabaseUnavailableError(), 503, "DATABASE_UNAVAILABLE"],
    [new ModelUnavailableError(), 503, "MODEL_SERVICE_UNAVAILABLE"],
    [new ValidationError(), 422, "VALIDATION_ERROR"],
  ];

  for (const [err, status, code] of cases) {
    it(`${err.name} → ${status} ${code}`, () => {
      expect(err.statusCode).toBe(status);
      expect(err.code).toBe(code);
      // every emitted code must be a declared contract code
      expect(ErrorCodeSchema.safeParse(err.code).success).toBe(true);
    });
  }

  it("ModelUnavailableError accepts a code/message override", () => {
    const err = new ModelUnavailableError("MODEL_NOT_LOADED", "LM Studio 未加载指定模型");
    expect(err.code).toBe("MODEL_NOT_LOADED");
    expect(err.statusCode).toBe(503);
    expect(err.message).toBe("LM Studio 未加载指定模型");
  });

  it("fail() defaults to 409 ()", () => {
    let caught: unknown;
    try {
      fail("MEMORY_BUSY", "该 Agent 已有整理任务，请等待完成");
    } catch (e) {
      caught = e;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).statusCode).toBe(409);
    expect((caught as AppError).code).toBe("MEMORY_BUSY");
  });

  it("fail() honours an explicit status override", () => {
    let caught: unknown;
    try {
      fail("MEMORY_FORBIDDEN", "无权访问此 Agent 记忆", 403);
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).statusCode).toBe(403);
  });
});

describe("Hono error handler", () => {
  it("returns the AppError envelope with its own status and no request_id", async () => {
    const { status, body } = await envelopeFor(new SessionNotFoundError());
    expect(status).toBe(404);
    expect(body).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "会话不存在，请先新建会话" },
    });
    expect(JSON.stringify(body)).not.toContain("request_id");
  });

  it("maps a storage failure to DATABASE_UNAVAILABLE 503", async () => {
    const { status, body } = await envelopeFor(new DatabaseError("driver exploded"));
    expect(status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "数据服务暂不可用，请检查数据库",
      },
    });
  });

  it("#83-1 maps a raw bun:sqlite error to DATABASE_UNAVAILABLE 503", async () => {
    // The storage layer throws genuine `SQLiteError`s; until R6 these were
    // not recognised as database errors and surfaced as a generic 500. They
    // must downgrade to 503.
    const { status, body } = await envelopeFor(rawSqliteError());
    expect(status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "数据服务暂不可用，请检查数据库",
      },
    });
  });

  it("#83-1 does not leak the raw sqlite error text at the boundary", async () => {
    const { body } = await envelopeFor(rawSqliteError());
    expect(JSON.stringify(body)).not.toContain("NOT VALID SQL");
  });

  it("does not leak the raw storage message", async () => {
    const { body } = await envelopeFor(new DatabaseError("secret connection string"));
    expect(JSON.stringify(body)).not.toContain("secret connection string");
  });

  it("maps validation failures to 422 VALIDATION_ERROR", async () => {
    const { status, body } = await envelopeFor(new ValidationError());
    expect(status).toBe(422);
    expect(body).toEqual({
      error: { code: "VALIDATION_ERROR", message: "请求参数不合法" },
    });
  });

  it("falls back to a 500 detail body for unknown errors", async () => {
    const { status, body } = await envelopeFor(new TypeError("bug"));
    expect(status).toBe(500);
    expect(body).toEqual({ detail: "Internal Server Error" });
  });

  it("does not treat a look-alike plain object as a database error", () => {
    expect(isDatabaseError({ name: "DatabaseError" })).toBe(true);
    expect(isDatabaseError({ name: "OtherError" })).toBe(false);
    expect(isDatabaseError(new Error("x"))).toBe(false);
  });
});
