import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { inspectContext } from "../../src/server/agent/context-access";
import { handleError } from "../../src/server/api/error-handler";
import { runRoutes } from "../../src/server/api/runs";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  createSession,
  DEFAULT_USER_ID,
  deleteMessage,
  ensureDefaults,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
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
