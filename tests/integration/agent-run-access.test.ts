import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { canReadRun, inspectContext, sourceAccess } from "../../src/server/agent/context-access";
import { handleError } from "../../src/server/api/error-handler";
import { runRoutes } from "../../src/server/api/runs";
import { createApp } from "../../src/server/app";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { memoryRevision } from "../../src/server/db/memory-content-repository";
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

describe("run diagnostics authorization and source lifetime", () => {
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
