import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  assertContextSources,
  canReadRun,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import { handleError } from "../../src/server/api/error-handler";
import { runRoutes } from "../../src/server/api/runs";
import { createApp } from "../../src/server/app";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { memoryRevision } from "../../src/server/db/memory-content-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  deleteMessage,
  ensureDefaults,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { unconfiguredPermissions } from "../../src/server/permissions/service";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
function setup() {
  const business = openBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "test-model");
  const repository = new AgentRunRepository(business.db);
  const app = new Hono().onError(handleError).route("/v2/runs", runRoutes(business.db, repository));
  const snapshot = (
    sources: SourceRef[] = [],
    owner: RunOwner = {
      kind: "knowledge_job",
      id: crypto.randomUUID(),
      userId: DEFAULT_USER_ID,
    },
    image = false,
  ) => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const at = new Date().toISOString();
    repository.createRun({ runId, specId: "test", specVersion: "1", owner, at });
    repository.startStep({
      runId,
      stepId,
      stepNo: 1,
      model: "test-model",
      phase: "leaf",
      at,
      messages: [
        {
          role: "user",
          content: [
            { kind: "text", text: "private original" },
            ...(image
              ? [
                  {
                    kind: "image" as const,
                    sourceId: "image-1",
                    revision: "1",
                    mimeType: "image/png",
                    sha256: "image-digest",
                  },
                ]
              : []),
          ],
        },
      ],
      sources,
    });
    return { runId, stepId };
  };
  return { business, repository, app, snapshot };
}

const NOTE_BINDING_ID = "note-binding";
const NOTE_EVENT_KEY = "note-event";
const NOTE_MEDIA_ID = "note-media";
const NOTE_EXPIRY = "2099-01-01T00:00:00.000Z";
const SECOND_AGENT_ID = "00000000-0000-0000-0000-000000000002";

/** 与 context-access 的 qq_media_note 复验口径一致：note/note_model/attempts/event_key。 */
function qqMediaNoteRevision(note: string, noteModel: string, attempts: number, eventKey: string) {
  return createHash("sha256")
    .update(JSON.stringify([note, noteModel, attempts, eventKey]))
    .digest("hex");
}

function insertNoteBinding(
  business: ReturnType<typeof openBusinessDb>,
  input: { id: string; peerId: string; agentId: string; schemeId: string },
) {
  const at = new Date().toISOString();
  business.orm
    .insert(schema.qqBindings)
    .values({
      id: input.id,
      accountId: "100",
      conversationKind: "private",
      peerId: input.peerId,
      agentId: input.agentId,
      schemeId: input.schemeId,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: at,
      updatedAt: at,
    })
    .run();
}

/** QQ 私聊绑定 + 事件/媒体 note 合成行；note 修订号按生产复验公式从四元组算出。 */
function seedQqNoteScope(business: ReturnType<typeof openBusinessDb>) {
  const at = new Date().toISOString();
  const scheme = createQqScheme(business.orm, { name: "agent-run-access-note" });
  insertNoteBinding(business, {
    id: NOTE_BINDING_ID,
    peerId: "200",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
  });
  business.db
    .query(
      `INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      NOTE_EVENT_KEY,
      "100",
      "private",
      "200",
      DEFAULT_AGENT_ID,
      "note-message",
      1,
      "member",
      "200",
      at,
      1,
    );
  business.orm
    .insert(schema.qqMediaNotes)
    .values({
      id: NOTE_MEDIA_ID,
      eventKey: NOTE_EVENT_KEY,
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: "synthetic",
      note: "original note",
      noteModel: "fixture",
      attempts: 1,
      expiresAt: NOTE_EXPIRY,
      recordedAt: at,
      updatedAt: at,
    })
    .run();
  const noteRef: SourceRef = {
    kind: "qq_media_note",
    id: NOTE_MEDIA_ID,
    revision: qqMediaNoteRevision("original note", "fixture", 1, NOTE_EVENT_KEY),
    expiresAt: NOTE_EXPIRY,
  };
  return { at, schemeId: scheme.id, noteRef };
}

describe("run diagnostics authorization and source lifetime", () => {
  it.each([true, false])(
    "does not let a custom resolver override revoked permissions (configured=%s)",
    async (configured) => {
      const { business, repository, snapshot } = setup();
      const resolved: string[] = [];
      const app = createApp({
        business,
        permissions: configured ? unconfiguredPermissions : undefined,
        resolveSource(source) {
          resolved.push(source.kind);
          return "available";
        },
      });
      const handle = snapshot([
        { kind: "tool_permission", id: "mcp.documents.read", revision: "revoked-grant" },
      ]);
      const response = await app.request(`/v2/runs/${handle.runId}/context/${handle.stepId}`);
      expect(response.status).toBe(200);
      expect((await response.json()).status).toBe("revoked");
      expect(repository.getContext(handle)?.messages).toBeNull();
      expect(resolved).not.toContain("tool_permission");
    },
  );

  it("uses the application's module resolver for inspection without bypassing owner or fallback checks", async () => {
    const { business, repository, snapshot } = setup();
    let current = true;
    const resolved: string[] = [];
    const app = createApp({
      business,
      browserStateSecret: "synthetic-source-resolver",
      resolveSource(source, owner) {
        resolved.push(source.id);
        expect(owner.userId).toBe(DEFAULT_USER_ID);
        return source.kind === "external_document"
          ? current
            ? "available"
            : "revoked"
          : undefined;
      },
    });
    const source = { kind: "external_document", id: "remote-document", revision: "version-1" };
    const handle = snapshot([source]);
    const url = `/v2/runs/${handle.runId}/context/${handle.stepId}`;
    expect((await (await app.request(url)).json()).status).toBe("exact");
    expect(repository.getContext(handle)?.messages?.[0].content).toContainEqual({
      kind: "text",
      text: "private original",
    });
    const foreign = snapshot([source], {
      kind: "memory_job",
      id: "foreign",
      userId: "another-user",
    });
    const calls = resolved.length;
    expect((await app.request(`/v2/runs/${foreign.runId}/context/${foreign.stepId}`)).status).toBe(
      404,
    );
    expect(resolved).toHaveLength(calls);
    const unknown = snapshot([{ kind: "unhandled", id: "unknown", revision: "1" }]);
    expect(
      (await (await app.request(`/v2/runs/${unknown.runId}/context/${unknown.stepId}`)).json())
        .status,
    ).toBe("revoked");
    current = false;
    expect((await (await app.request(url)).json()).status).toBe("revoked");
    expect(repository.getContext(handle)?.messages).toBeNull();
    expect(repository.getContext(handle)?.layout.length).toBeGreaterThan(0);
  });

  it("keeps source expiry authoritative during tool execution even when a resolver accepts it", () => {
    const { business } = setup();
    expect(() =>
      assertContextSources({
        db: business.db,
        sources: [
          { kind: "external", id: "expired", revision: "1", expiresAt: "2030-01-01T00:00:00.000Z" },
        ],
        owner: { kind: "test", id: "run", userId: DEFAULT_USER_ID },
        now: "2030-01-02T00:00:00.000Z",
        resolveSource: () => "available",
        memoryRevisions: () => new Map(),
        messages: { memory: "memory changed", other: "source expired" },
      }),
    ).toThrow("source expired");
  });

  it("keeps the retained source expiry authoritative when a module returns available", () => {
    const { business, repository, snapshot } = setup();
    const handle = snapshot([
      {
        kind: "external_document",
        id: "remote",
        revision: "1",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    ]);
    expect(
      inspectContext(
        business.db,
        repository,
        handle,
        { userId: DEFAULT_USER_ID },
        "2030-01-02T00:00:00.000Z",
        () => "available",
      )?.status,
    ).toBe("expired");
    expect(repository.getContext(handle)?.messages).toBeNull();
  });

  it("rejects changed memory, observation, media and speech revisions", () => {
    const { business } = setup();
    const at = new Date().toISOString(),
      expiresAt = "2099-01-01T00:00:00.000Z";
    const owner = {
      kind: "fixture",
      id: "fixture",
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    const principal = { userId: DEFAULT_USER_ID };
    const hash = (body: string) => createHash("sha256").update(body).digest("hex");
    const memory = business.orm
      .insert(schema.memoryEntries)
      .values({
        id: "memory",
        agentId: DEFAULT_AGENT_ID,
        userId: DEFAULT_USER_ID,
        name: "test",
        summary: "test",
        tags: "[]",
        kinds: '["semantic"]',
        body: "original",
        scope: "reality_user",
        scopeKey: DEFAULT_AGENT_ID,
        status: "active",
        configSnapshot: "{}",
        createdAt: at,
      })
      .returning()
      .get();
    if (!memory) throw new Error("Missing memory fixture");
    business.db
      .query(
        "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed) VALUES('event','100','private','200',?,'event',1,'member','200',?,1)",
      )
      .run(DEFAULT_AGENT_ID, at);
    business.db
      .query("INSERT INTO qq_observation_text VALUES('event','original',1,?,?)")
      .run(expiresAt, at);
    business.orm
      .insert(schema.qqMediaNotes)
      .values({
        id: "media",
        eventKey: "event",
        segmentIndex: 0,
        segmentKind: "image",
        sourceRef: "synthetic",
        note: "original",
        noteModel: "fixture",
        attempts: 1,
        expiresAt,
        recordedAt: at,
        updatedAt: at,
      })
      .run();
    business.orm
      .insert(schema.qqSpeechLog)
      .values({
        id: "speech",
        accountId: "100",
        conversationKind: "private",
        peerId: "200",
        agentId: DEFAULT_AGENT_ID,
        kind: "direct_reply",
        spokeAtSeconds: 1,
        expiresAt,
        recordedAt: at,
      })
      .run();
    business.orm
      .insert(schema.qqSpeechText)
      .values({
        speechId: "speech",
        body: "original",
        spokeAtSeconds: 1,
        expiresAt,
        recordedAt: at,
      })
      .run();
    const refs: SourceRef[] = [
      { kind: "memory", id: "memory", revision: memoryRevision(memory) },
      { kind: "qq_observation", id: "event", revision: hash("original"), expiresAt },
      { kind: "qq_media", id: "media", revision: "1", expiresAt },
      { kind: "qq_speech", id: "speech", revision: hash("original"), expiresAt },
    ];
    expect(refs.map((ref) => sourceAccess(business.db, ref, owner, principal, at))).toEqual(
      Array(4).fill("available"),
    );
    business.db.query("UPDATE memory_entries SET body='changed' WHERE id='memory'").run();
    business.db
      .query("UPDATE qq_observation_text SET body='changed' WHERE event_key='event'")
      .run();
    business.db.query("UPDATE qq_media_notes SET note='changed',attempts=2 WHERE id='media'").run();
    business.db.query("UPDATE qq_speech_text SET body='changed' WHERE speech_id='speech'").run();
    expect(refs.map((ref) => sourceAccess(business.db, ref, owner, principal, at))).toEqual(
      Array(4).fill("revoked"),
    );
  });

  it("keeps a QQ media note exact for its own binding and conversation scope without consulting the resolver", async () => {
    const { business, repository, app, snapshot } = setup();
    const { at, noteRef } = seedQqNoteScope(business);
    const calls: string[] = [];
    const resolveSource = (source: SourceRef): "available" => {
      calls.push(source.kind);
      return "available";
    };
    const owner: RunOwner = {
      kind: "qq_binding",
      id: NOTE_BINDING_ID,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    const handle = snapshot([noteRef], owner);
    const inspected = inspectContext(
      business.db,
      repository,
      handle,
      { userId: DEFAULT_USER_ID },
      at,
      resolveSource,
    );
    expect(inspected?.status).toBe("exact");
    expect(inspected?.exactMessages?.[0].content).toContainEqual({
      kind: "text",
      text: "private original",
    });
    const conversation = new ConversationEventRepository(business.db).ensureOneBot(NOTE_BINDING_ID);
    if (!conversation) throw new Error("Missing QQ conversation fixture");
    const conversationHandle = snapshot([noteRef], {
      kind: "conversation",
      id: conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    });
    const conversationInspected = inspectContext(
      business.db,
      repository,
      conversationHandle,
      { userId: DEFAULT_USER_ID },
      at,
      resolveSource,
    );
    expect(conversationInspected?.status).toBe("exact");
    assertContextSources({
      db: business.db,
      sources: [noteRef],
      owner,
      now: at,
      resolveSource,
      memoryRevisions: () => new Map(),
      messages: { memory: "memory changed", other: "note unavailable" },
    });
    // 内置复验优先：这个 kind 从不把裁决交给外部 resolver。
    expect(calls).toEqual([]);
    const response = await app.request(`/v2/runs/${handle.runId}/context/${handle.stepId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("exact");
  });

  it("revokes a rewritten QQ media note on the same attempt and erases the retained input", () => {
    const { business, repository, snapshot } = setup();
    const { at, noteRef } = seedQqNoteScope(business);
    const owner: RunOwner = {
      kind: "qq_binding",
      id: NOTE_BINDING_ID,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    const calls: string[] = [];
    const resolveSource = (source: SourceRef): "available" => {
      calls.push(source.kind);
      return "available";
    };
    const handle = snapshot([noteRef], owner);
    const before = inspectContext(
      business.db,
      repository,
      handle,
      { userId: DEFAULT_USER_ID },
      at,
      resolveSource,
    );
    expect(before?.status).toBe("exact");
    // 同一 attempt（attempts 不变）改写 note 与 note_model：旧修订号立即失配。
    business.db
      .query("UPDATE qq_media_notes SET note=?,note_model=? WHERE id=?")
      .run("rewritten note", "second-model", NOTE_MEDIA_ID);
    const after = inspectContext(
      business.db,
      repository,
      handle,
      { userId: DEFAULT_USER_ID },
      at,
      resolveSource,
    );
    expect(after?.status).toBe("revoked");
    expect(repository.getContext(handle)?.messages).toBeNull();
    expect(repository.getContext(handle)?.layout.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
    // 新内容配新修订号仍是这条 note 的合法引用：修订号确实绑定这四个字段。
    expect(
      sourceAccess(
        business.db,
        {
          ...noteRef,
          revision: qqMediaNoteRevision("rewritten note", "second-model", 1, NOTE_EVENT_KEY),
        },
        owner,
        { userId: DEFAULT_USER_ID },
        at,
      ),
    ).toBe("available");
  });

  it("rejects a QQ media note from another conversation, another agent or after expiry, and an all-available resolver cannot take over", () => {
    const { business, repository, snapshot } = setup();
    const { at, schemeId, noteRef } = seedQqNoteScope(business);
    const principal = { userId: DEFAULT_USER_ID };
    const owner: RunOwner = {
      kind: "qq_binding",
      id: NOTE_BINDING_ID,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    const calls: string[] = [];
    const resolveSource = (source: SourceRef): "available" => {
      calls.push(source.kind);
      return "available";
    };
    expect(sourceAccess(business.db, noteRef, owner, principal, at)).toBe("available");

    // 另一个绑定与另一个会话：账号与类型一致但 peer 不同，不能读这条 note。
    insertNoteBinding(business, {
      id: "other-binding",
      peerId: "201",
      agentId: DEFAULT_AGENT_ID,
      schemeId,
    });
    const foreignOwner: RunOwner = {
      kind: "qq_binding",
      id: "other-binding",
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    expect(sourceAccess(business.db, noteRef, foreignOwner, principal, at)).toBe("revoked");
    const foreignConversation = new ConversationEventRepository(business.db).ensureOneBot(
      "other-binding",
    );
    if (!foreignConversation) throw new Error("Missing QQ conversation fixture");
    expect(
      sourceAccess(
        business.db,
        noteRef,
        {
          kind: "conversation",
          id: foreignConversation.id,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        principal,
        at,
      ),
    ).toBe("revoked");
    const foreign = snapshot([noteRef], foreignOwner);
    const foreignInspected = inspectContext(
      business.db,
      repository,
      foreign,
      principal,
      at,
      resolveSource,
    );
    expect(foreignInspected?.status).toBe("revoked");
    expect(repository.getContext(foreign)?.messages).toBeNull();
    expect(() =>
      assertContextSources({
        db: business.db,
        sources: [noteRef],
        owner: foreignOwner,
        now: at,
        resolveSource,
        memoryRevisions: () => new Map(),
        messages: { memory: "memory changed", other: "note scope changed" },
      }),
    ).toThrow("note scope changed");
    expect(calls).toEqual([]);

    // 过期：note 和绑定都还在，但时间窗已过。
    const expiryNow = "2099-01-02T00:00:00.000Z";
    expect(sourceAccess(business.db, noteRef, owner, principal, expiryNow)).toBe("expired");
    const stale = snapshot([noteRef], owner);
    const staleInspected = inspectContext(
      business.db,
      repository,
      stale,
      principal,
      expiryNow,
      resolveSource,
    );
    expect(staleInspected?.status).toBe("expired");
    expect(repository.getContext(stale)?.messages).toBeNull();
    expect(calls).toEqual([]);

    // 改绑到第二任助手：新助手即使持有该绑定也读不到第一位助手的 note。
    business.orm
      .insert(schema.agents)
      .values({
        id: SECOND_AGENT_ID,
        name: "synthetic second assistant",
        systemPrompt: "synthetic",
        description: "",
        additionalInstructions: "",
        p5Config: "{}",
        modelName: "test-model",
        temperature: 0.7,
        memoryConsolidationModelName: null,
        memoryConsolidationPrompt: "synthetic",
        memoryConsolidationAdditionalInstructions: "",
        memoryRetrievalModelName: null,
        memoryRetrievalPrompt: "synthetic",
        contextCompressionModelName: null,
        personaIntensity: 60,
        isActive: 1,
        configVersion: 1,
        updatedAt: at,
        createdAt: at,
      })
      .run();
    business.db
      .query("UPDATE qq_bindings SET agent_id=?,revision=2,authority_revision=2 WHERE id=?")
      .run(SECOND_AGENT_ID, NOTE_BINDING_ID);
    const reboundOwner: RunOwner = {
      kind: "qq_binding",
      id: NOTE_BINDING_ID,
      userId: DEFAULT_USER_ID,
      agentId: SECOND_AGENT_ID,
    };
    expect(sourceAccess(business.db, noteRef, reboundOwner, principal, at)).toBe("revoked");
    const rebound = snapshot([noteRef], reboundOwner);
    const reboundInspected = inspectContext(
      business.db,
      repository,
      rebound,
      principal,
      at,
      resolveSource,
    );
    expect(reboundInspected?.status).toBe("revoked");
    expect(repository.getContext(rebound)?.messages).toBeNull();
    expect(calls).toEqual([]);
  });

  it("does not authorize a retired conversation merely from the stored run user ID", () => {
    const { business } = setup();
    const session = createSession(business.orm, "owned", { modelName: "test-model" });
    const conversation = new ConversationEventRepository(business.db).ensureWeb(session.id);
    if (!conversation) throw new Error("Missing conversation fixture");
    const owner = {
      kind: "conversation",
      id: conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    expect(canReadRun(business.db, owner, { userId: DEFAULT_USER_ID })).toBe(true);
    business.db
      .query("UPDATE conversations SET closed_at=? WHERE id=?")
      .run(new Date().toISOString(), conversation.id);
    expect(canReadRun(business.db, owner, { userId: DEFAULT_USER_ID })).toBe(false);
  });
  it("can inspect its current pending input without treating an incomplete turn as revoked", () => {
    const { business, repository, snapshot } = setup();
    const session = createSession(business.orm, "active input", { modelName: "test-model" });
    const prepared = prepareTurn(business.orm, session.id, "current question", "active-request");
    if (!prepared.generationToken) throw new Error("Missing fixture lease");
    const turn = business.db.query("SELECT id FROM turns WHERE session_id=?").get(session.id) as {
      id: string;
    };
    const handle = snapshot(
      [{ kind: "web_turn", id: turn.id, revision: prepared.generationToken }],
      { kind: "web_turn", id: turn.id, userId: DEFAULT_USER_ID },
    );
    expect(
      inspectContext(business.db, repository, handle, { userId: DEFAULT_USER_ID })?.status,
    ).toBe("exact");
    saveCompletedAssistantMessage(
      business.orm,
      session.id,
      "answer",
      "active-request",
      prepared.generationToken,
    );
    expect(
      inspectContext(business.db, repository, handle, { userId: DEFAULT_USER_ID })?.status,
    ).toBe("exact");
    deleteMessage(business.orm, session.id, prepared.messageId);
    expect(repository.getContext(handle)?.messages).toBeNull();
    expect(
      inspectContext(business.db, repository, handle, { userId: DEFAULT_USER_ID })?.status,
    ).toBe("revoked");
  });
  it("lists only the local owner's metadata and keeps actual input on the explicit context route", async () => {
    const { app, snapshot } = setup();
    const owner = { kind: "memory_job", id: crypto.randomUUID(), userId: DEFAULT_USER_ID };
    const handle = snapshot([], owner);
    snapshot([], { ...owner, userId: crypto.randomUUID() });
    const list = await app.request(`/v2/runs?ownerKind=memory_job&ownerId=${owner.id}`);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const text = await list.text();
    expect(text).not.toContain("private original");
    expect(JSON.parse(text).runs).toHaveLength(1);
    const context = await app.request(`/v2/runs/${handle.runId}/context/${handle.stepId}`);
    expect((await context.json()).status).toBe("exact");
  });

  it("does not accept another owner or a step from another run", async () => {
    const { app, snapshot } = setup();
    const first = snapshot();
    const second = snapshot();
    const foreign = snapshot([], { kind: "memory_job", id: "foreign", userId: "another-user" });
    expect((await app.request(`/v2/runs/${foreign.runId}`)).status).toBe(404);
    expect((await app.request(`/v2/runs/${first.runId}/context/${second.stepId}`)).status).toBe(
      404,
    );
    expect((await app.request(`/v2/runs/${first.runId}/events?afterSeq=-1`)).status).toBe(422);
  });

  it("erases expired input and keeps only the source/layout metadata", () => {
    const { business, repository, snapshot } = setup();
    const handle = snapshot([
      { kind: "qq_observation", id: "event", revision: "1", expiresAt: "2030-01-01T00:00:00.000Z" },
    ]);
    const inspected = inspectContext(
      business.db,
      repository,
      handle,
      { userId: DEFAULT_USER_ID },
      "2030-01-02T00:00:00.000Z",
    );
    expect(inspected?.status).toBe("expired");
    expect(inspected?.exactMessages).toBeUndefined();
    expect(inspected?.layout).toHaveLength(1);
    expect(repository.getContext(handle)?.messages).toBeNull();
  });

  it("marks unavailable image bytes partial while preserving the actual text and image digest", () => {
    const { business, repository, snapshot } = setup();
    const handle = snapshot([], undefined, true);
    const result = inspectContext(business.db, repository, handle, { userId: DEFAULT_USER_ID });
    expect(result?.status).toBe("partial");
    expect(result?.unavailableMedia?.[0]?.sha256).toBe("image-digest");
    expect(JSON.stringify(result)).not.toContain("data:image");
  });

  it("redacts source-bound input in the same transaction as knowledge grant revocation", () => {
    const { business, repository, snapshot } = setup();
    const knowledge = new KnowledgeRepository(business.db);
    const category = knowledge.createCategory("test");
    const document = knowledge.importDocument({
      category_id: category.id,
      name: "source",
      original_text: "retained original",
    });
    const granted = knowledge.replaceGrants(document.id, document.revision, [DEFAULT_USER_ID]);
    const token = (
      business.db
        .query("SELECT token FROM knowledge_grants WHERE document_id=?")
        .get(document.id) as { token: string }
    ).token;
    const handle = snapshot([
      { kind: "knowledge_document", id: document.id, revision: String(document.content_version) },
      {
        kind: "knowledge_grant",
        id: JSON.stringify([document.id, DEFAULT_USER_ID]),
        revision: token,
      },
    ]);
    knowledge.replaceGrants(document.id, granted.revision, []);
    // No diagnostic read or retention sweep is needed to remove the copied plaintext.
    expect(repository.getContext(handle)?.messages).toBeNull();
    const result = inspectContext(business.db, repository, handle, { userId: DEFAULT_USER_ID });
    expect(result?.status).toBe("revoked");
    const fresh = knowledge.detail(document.id);
    knowledge.replaceGrants(document.id, fresh.revision, [DEFAULT_USER_ID]);
    expect(
      inspectContext(business.db, repository, handle, { userId: DEFAULT_USER_ID })?.status,
    ).toBe("revoked");
  });

  it("reports the actual latest knowledge maintenance job for UI run correlation", () => {
    const { business } = setup();
    const knowledge = new KnowledgeRepository(business.db);
    const category = knowledge.createCategory("jobs");
    const document = knowledge.importDocument({
      category_id: category.id,
      name: "source",
      original_text: "input",
    });
    const job = business.db
      .query("SELECT id FROM knowledge_jobs WHERE document_id=? ORDER BY rowid DESC LIMIT 1")
      .get(document.id) as { id: string };
    expect(document.latest_job_id).toBe(job.id);
  });
});
