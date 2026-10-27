import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  assertContextSources,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import { createApp } from "../../src/server/app";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { insertQqBinding, saveQqBinding } from "../../src/server/db/qq-binding-repository";
import { saveQqOwnerIdentity } from "../../src/server/db/qq-owner-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { evidenceQueryPage } from "../../src/server/modules/contracts";
import {
  conversationEvidenceSourceAccess,
  createWebConversationEvidence,
} from "../../src/server/modules/conversation-evidence";
import {
  evidenceCursor,
  parseEvidenceCursor,
  SqliteMemoryModule,
  sealEvidenceValue,
} from "../../src/server/modules/memory-module";
import { createAgent } from "../../src/server/services/agent-service";
import {
  MEMORY_SEARCH_FOLD_VERSION,
  memorySearchProjection,
} from "../../src/server/services/memory-contract";
import { memoryConversationAccess } from "../../src/server/services/memory-scope";
import {
  createQqBinding,
  qqMemoryScopeKey,
  resolveQqMemoryAccess,
  updateQqBinding,
} from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

function addMemory(business: ReturnType<typeof openBusinessDb>, sessionId: string, id: string) {
  const prepared = prepareTurn(business.orm, sessionId, "question", id);
  saveCompletedAssistantMessage(business.orm, sessionId, "answer", id, prepared.generationToken!);
  const turn = getTurnByRequest(business.orm, sessionId, id)!;
  const messages = business.orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.turnId, turn.id))
    .all();
  const user = messages.find((message) => message.role === "user")!;
  const assistant = messages.find((message) => message.role === "assistant")!;
  business.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: id,
      summary: id,
      tags: "[]",
      kinds: "[]",
      body: `body ${id}`,
      scope: "reality_user",
      scopeKey: DEFAULT_AGENT_ID,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
      visibility: "session_private",
    })
    .run();
  business.orm
    .insert(schema.memorySources)
    .values({
      memoryId: id,
      turnId: turn.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      sequenceNo: user.sequenceNo,
    })
    .run();
  return turn.id;
}

describe("memory cursor privacy", () => {
  it("hides scan positions, authenticates bindings and rejects legacy signed memory cursors", () => {
    const binding = {
      kind: "memory" as const,
      owner: "a".repeat(64),
      agent: "agent",
      scope: "b".repeat(64),
      query: "c".repeat(64),
    };
    const position = { id: "private-scanned-id", ordinal: -1, offset: 0, score: 3 };
    const cursor = evidenceCursor(binding, position);
    const envelope = JSON.parse(cursor) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["ciphertext", "nonce", "tag", "version"]);
    expect(envelope).not.toHaveProperty("payload");
    expect(parseEvidenceCursor(cursor, binding)).toEqual(position);
    expect(() => parseEvidenceCursor(cursor, { ...binding, query: "d".repeat(64) })).toThrow();
    expect(() => parseEvidenceCursor(cursor, { ...binding, scope: "e".repeat(64) })).toThrow();
    expect(() =>
      parseEvidenceCursor(JSON.stringify({ ...envelope, tag: "A".repeat(22) }), binding),
    ).toThrow();
    expect(() =>
      parseEvidenceCursor(sealEvidenceValue({ version: 1, ...binding, after: position }), binding),
    ).toThrow();
    const knowledge = { ...binding, kind: "knowledge" as const };
    expect(() => parseEvidenceCursor(cursor, knowledge)).toThrow();
    expect(() =>
      parseEvidenceCursor(evidenceCursor(knowledge, { id: "x", ordinal: -1, offset: 0 }), binding),
    ).toThrow();
  });
});

describe("runtime memory conversation access", () => {
  it("keeps same-Agent sessions private and invalidates evidence after mode ABA", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const a = createSession(business.orm, "A", { modelName: "synthetic" });
      const b = createSession(business.orm, "B", { modelName: "synthetic" });
      const turnA = addMemory(business, a.id, "memory-a");
      const sharedId = "00000000-0000-4000-8000-000000000124";
      addMemory(business, b.id, sharedId);
      addMemory(business, b.id, "memory-b");
      const journal = new ConversationEventRepository(business.db);
      const conversation = journal.ensureWeb(a.id, DEFAULT_USER_ID)!;
      journal.ensureWeb(b.id, DEFAULT_USER_ID);
      const agent = getAgentRow(business.orm, DEFAULT_AGENT_ID)!;
      const memory = new SqliteMemoryModule({
        orm: business.orm,
        runtime: () => runtimeFromAgent(agent),
      });
      const input = {
        agentId: DEFAULT_AGENT_ID,
        sessionId: a.id,
        conversationId: conversation.id,
        owner: { kind: "web_turn", id: turnA, userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID },
        scopes: null,
        mode: "standard" as const,
        query: "",
        budget: 65536,
      };
      const page = await memory.query(input);
      expect(page.items.map((item) => item.id)).toContain("memory-a");
      expect(page.items.map((item) => item.id)).not.toContain("memory-b");
      const item = page.items.find((candidate) => candidate.id === "memory-a")!;
      expect(item.sources[0]?.kind).toBe("memory_access");
      expect((await memory.read({ ...input, evidence: item, offset: 0, limit: 4096 })).text).toBe(
        "body memory-a",
      );
      const app = createApp({ business, externalActions: () => [] });
      const grant = await app.request(
        `/agents/${DEFAULT_AGENT_ID}/memory/entries/${sharedId}/visibility`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_revision: 1,
            visibility: "agent_shared",
            recipient_agent_ids: [DEFAULT_AGENT_ID],
          }),
        },
      );
      expect(grant.status).toBe(200);
      expect(
        journal.setMemoryReadMode(conversation.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind,
      ).toBe("saved");
      const sharedMode = await memory.query(input);
      expect(sharedMode.items.map((candidate) => candidate.id)).toContain("memory-a");
      expect(sharedMode.items.map((candidate) => candidate.id)).toContain(sharedId);
      expect(sharedMode.items.map((candidate) => candidate.id)).not.toContain("memory-b");
      expect(
        journal.setMemoryReadMode(conversation.id, DEFAULT_USER_ID, "current_conversation", 2)
          ?.kind,
      ).toBe("saved");
      await expect(
        memory.read({ ...input, evidence: item, offset: 0, limit: 4096 }),
      ).rejects.toThrow();
    } finally {
      business.close();
    }
  });
  it("does not let 301 unshared foreign-session NULL projections block a current-session search", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const a = createSession(business.orm, "A", { modelName: "synthetic" });
      const b = createSession(business.orm, "B", { modelName: "synthetic" });
      const turnA = addMemory(business, a.id, "zz-current-hit");
      addMemory(business, b.id, "foreign-template");
      const template = business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, "foreign-template"))
        .get()!;
      const source = business.orm
        .select()
        .from(schema.memorySources)
        .where(eq(schema.memorySources.memoryId, "foreign-template"))
        .get()!;
      for (let i = 0; i < 301; i++) {
        const id = `foreign-${i.toString().padStart(4, "0")}`;
        business.orm
          .insert(schema.memoryEntries)
          .values({ ...template, id, foldedSearch: null, foldVersion: null })
          .run();
        business.orm
          .insert(schema.memorySources)
          .values({ ...source, memoryId: id })
          .run();
      }
      const current = business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, "zz-current-hit"))
        .get()!;
      business.orm
        .update(schema.memoryEntries)
        .set({
          foldedSearch: memorySearchProjection(current),
          foldVersion: MEMORY_SEARCH_FOLD_VERSION,
        })
        .where(eq(schema.memoryEntries.id, current.id))
        .run();
      const journal = new ConversationEventRepository(business.db);
      const ca = journal.ensureWeb(a.id, DEFAULT_USER_ID)!;
      journal.ensureWeb(b.id, DEFAULT_USER_ID);
      expect(journal.setMemoryReadMode(ca.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind).toBe(
        "saved",
      );
      const memory = new SqliteMemoryModule({
        orm: business.orm,
        runtime: () => runtimeFromAgent(getAgentRow(business.orm, DEFAULT_AGENT_ID)!),
      });
      const result = await memory.query({
        agentId: DEFAULT_AGENT_ID,
        sessionId: a.id,
        conversationId: ca.id,
        owner: { kind: "web_turn", id: turnA, userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID },
        scopes: null,
        mode: "standard",
        query: "zz-current-hit",
        budget: 65536,
      });
      expect(result.status).toBe("ok");
      expect(result.items.map((item) => item.id)).toContain(current.id);
    } finally {
      business.close();
    }
  });

  it("rejects a mismatched Web turn and canonical conversation before returning metadata or body", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const a = createSession(business.orm, "A", { modelName: "synthetic" });
      const b = createSession(business.orm, "B", { modelName: "synthetic" });
      const turnA = addMemory(business, a.id, "owner-a");
      const turnB = addMemory(business, b.id, "private-b");
      const journal = new ConversationEventRepository(business.db);
      journal.ensureWeb(a.id, DEFAULT_USER_ID);
      const cb = journal.ensureWeb(b.id, DEFAULT_USER_ID)!;
      const memory = new SqliteMemoryModule({
        orm: business.orm,
        runtime: () => runtimeFromAgent(getAgentRow(business.orm, DEFAULT_AGENT_ID)!),
      });
      const good = {
        agentId: DEFAULT_AGENT_ID,
        sessionId: b.id,
        conversationId: cb.id,
        owner: { kind: "web_turn", id: turnB, userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID },
        scopes: null,
        mode: "standard" as const,
        query: "",
        budget: 65536,
      };
      const item = (await memory.query(good)).items.find(
        (candidate) => candidate.id === "private-b",
      );
      if (!item) throw new Error("missing B control");
      const mismatch = { ...good, sessionId: a.id, owner: { ...good.owner, id: turnA } };
      await expect(memory.query(mismatch)).rejects.toThrow();
      await expect(
        memory.read({ ...mismatch, evidence: item, offset: 0, limit: 4096 }),
      ).rejects.toThrow();
    } finally {
      business.close();
    }
  });

  it("reads only explicitly granted public derived memory without raw-source authority", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const persona = {
        core_identity: "",
        communication_style: "",
        interaction_boundaries: "",
        example_dialogues: "",
        advanced_instructions: "",
      };
      const other = createAgent(business.orm, { name: "other", model_name: "synthetic" }, persona);
      const sourceSession = createSession(business.orm, "source", { modelName: "synthetic" });
      const targetSession = createSession(business.orm, "target", {
        agentId: other.id,
        modelName: "synthetic",
      });
      const publicId = "00000000-0000-4000-8000-000000000123";
      addMemory(business, sourceSession.id, publicId);
      prepareTurn(business.orm, targetSession.id, "target", "target-turn");
      const targetTurn = getTurnByRequest(business.orm, targetSession.id, "target-turn")!;
      const journal = new ConversationEventRepository(business.db);
      journal.ensureWeb(sourceSession.id, DEFAULT_USER_ID);
      const target = journal.ensureWeb(targetSession.id, DEFAULT_USER_ID)!;
      const app = createApp({ business, externalActions: () => [] });
      const published = await app.request(
        `/agents/${DEFAULT_AGENT_ID}/memory/entries/${publicId}/visibility`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_revision: 1,
            visibility: "public",
            recipient_agent_ids: [other.id],
          }),
        },
      );
      expect(published.status).toBe(200);
      expect(journal.setMemoryReadMode(target.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind).toBe(
        "saved",
      );
      const memory = new SqliteMemoryModule({
        orm: business.orm,
        runtime: () => runtimeFromAgent(getAgentRow(business.orm, other.id)!),
      });
      const input = {
        agentId: other.id,
        sessionId: targetSession.id,
        conversationId: target.id,
        owner: { kind: "web_turn", id: targetTurn.id, userId: DEFAULT_USER_ID, agentId: other.id },
        scopes: null,
        mode: "standard" as const,
        query: "",
        budget: 65536,
      };
      const page = await memory.query(input);
      const item = page.items.find((candidate) => candidate.id === publicId);
      expect(item?.sources.map((source) => source.kind)).toEqual(["memory_access"]);
      if (!item) throw new Error("public memory missing");
      const accessRef = item.sources[0]!;
      expect(
        sourceAccess(business.db, accessRef, input.owner, { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("available");
      const runs = new AgentRunRepository(business.db);
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      runs.createRun({
        runId,
        specId: "memory-visibility",
        specVersion: "1",
        owner: input.owner,
        at: nowIso(),
      });
      runs.startStep({
        runId,
        stepId,
        stepNo: 1,
        model: "synthetic",
        phase: "next",
        at: nowIso(),
        messages: [{ role: "user", content: [{ kind: "text", text: "derived content" }] }],
        sources: [accessRef],
      });
      const handle = { runId, stepId };
      expect(inspectContext(business.db, runs, handle, { userId: DEFAULT_USER_ID })?.status).toBe(
        "exact",
      );
      expect((await memory.read({ ...input, evidence: item, offset: 0, limit: 4096 })).text).toBe(
        `body ${publicId}`,
      );
      expect(JSON.stringify(item)).not.toContain(sourceSession.id);
      const rawTurn = getTurnByRequest(business.orm, sourceSession.id, publicId)!;
      expect(
        sourceAccess(
          business.db,
          { kind: "web_turn", id: rawTurn.id, revision: "ignored" },
          input.owner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      const revoke = await app.request(
        `/agents/${DEFAULT_AGENT_ID}/memory/entries/${publicId}/visibility`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_revision: 2,
            visibility: "session_private",
            recipient_agent_ids: [],
          }),
        },
      );
      expect(revoke.status).toBe(200);
      expect(
        sourceAccess(business.db, accessRef, input.owner, { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("revoked");
      expect(
        inspectContext(
          business.db,
          runs,
          handle,
          { userId: DEFAULT_USER_ID },
          nowIso(),
          () => "available",
        )?.status,
      ).toBe("revoked");
      expect(() =>
        assertContextSources({
          db: business.db,
          sources: [accessRef],
          owner: input.owner,
          now: nowIso(),
          resolveSource: () => "available",
          memoryRevisions: () => new Map(),
          messages: { memory: "memory denied", other: "source denied" },
        }),
      ).toThrow();
      const regrant = await app.request(
        `/agents/${DEFAULT_AGENT_ID}/memory/entries/${publicId}/visibility`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_revision: 3,
            visibility: "public",
            recipient_agent_ids: [other.id],
          }),
        },
      );
      expect(regrant.status).toBe(200);
      await expect(
        memory.read({ ...input, evidence: item, offset: 0, limit: 4096 }),
      ).rejects.toThrow();
      const fresh = (await memory.query(input)).items.find(
        (candidate) => candidate.id === publicId,
      )!;
      expect((await memory.read({ ...input, evidence: fresh, offset: 0, limit: 4096 })).text).toBe(
        `body ${publicId}`,
      );
      const sourceTurn = getTurnByRequest(business.orm, sourceSession.id, publicId)!;
      business.db.query("UPDATE turns SET source_valid=0 WHERE id=?").run(sourceTurn.id);
      await expect(
        memory.read({ ...input, evidence: fresh, offset: 0, limit: 4096 }),
      ).rejects.toThrow();
    } finally {
      business.close();
    }
  });

  it("rejects an explicitly shared mixed-source memory when any source becomes invalid", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const a = createSession(business.orm, "A", { modelName: "synthetic" });
      const b = createSession(business.orm, "B", { modelName: "synthetic" });
      const id = "00000000-0000-4000-8000-000000000126";
      const turnA = addMemory(business, a.id, id);
      const turnB = addMemory(business, b.id, "second-memory");
      const otherSource = business.orm
        .select()
        .from(schema.memorySources)
        .where(eq(schema.memorySources.memoryId, "second-memory"))
        .get()!;
      business.orm
        .insert(schema.memorySources)
        .values({ ...otherSource, memoryId: id })
        .run();
      const journal = new ConversationEventRepository(business.db);
      const ca = journal.ensureWeb(a.id, DEFAULT_USER_ID)!;
      journal.ensureWeb(b.id, DEFAULT_USER_ID);
      const app = createApp({ business, externalActions: () => [] });
      expect(
        (
          await app.request(`/agents/${DEFAULT_AGENT_ID}/memory/entries/${id}/visibility`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expected_revision: 1,
              visibility: "agent_shared",
              recipient_agent_ids: [DEFAULT_AGENT_ID],
            }),
          })
        ).status,
      ).toBe(200);
      expect(journal.setMemoryReadMode(ca.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind).toBe(
        "saved",
      );
      const memory = new SqliteMemoryModule({
        orm: business.orm,
        runtime: () => runtimeFromAgent(getAgentRow(business.orm, DEFAULT_AGENT_ID)!),
      });
      const input = {
        agentId: DEFAULT_AGENT_ID,
        sessionId: a.id,
        conversationId: ca.id,
        owner: { kind: "web_turn", id: turnA, userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID },
        scopes: null,
        mode: "standard" as const,
        query: "",
        budget: 65536,
      };
      const item = (await memory.query(input)).items.find((candidate) => candidate.id === id);
      expect(item).toBeDefined();
      if (!item) throw new Error("shared mixed source missing");
      business.db.query("UPDATE turns SET source_valid=0 WHERE id=?").run(turnB);
      expect((await memory.query(input)).items.map((candidate) => candidate.id)).not.toContain(id);
      await expect(
        memory.read({ ...input, evidence: item, offset: 0, limit: 4096 }),
      ).rejects.toThrow();
    } finally {
      business.close();
    }
  });

  it("does not grant another same-Agent session raw conversation preview through a public memory", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const a = createSession(business.orm, "source", { modelName: "synthetic" });
      const b = createSession(business.orm, "recipient", { modelName: "synthetic" });
      const id = "00000000-0000-4000-8000-000000000125";
      addMemory(business, a.id, id);
      prepareTurn(business.orm, a.id, "current A", "current-a");
      prepareTurn(business.orm, b.id, "current B", "current-b");
      const currentA = getTurnByRequest(business.orm, a.id, "current-a")!;
      const currentB = getTurnByRequest(business.orm, b.id, "current-b")!;
      const journal = new ConversationEventRepository(business.db);
      journal.ensureWeb(a.id, DEFAULT_USER_ID);
      const cb = journal.ensureWeb(b.id, DEFAULT_USER_ID)!;
      const app = createApp({ business, externalActions: () => [] });
      expect(
        (
          await app.request(`/agents/${DEFAULT_AGENT_ID}/memory/entries/${id}/visibility`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expected_revision: 1,
              visibility: "public",
              recipient_agent_ids: [DEFAULT_AGENT_ID],
            }),
          })
        ).status,
      ).toBe(200);
      expect(journal.setMemoryReadMode(cb.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind).toBe(
        "saved",
      );
      const contextA = {
        owner: {
          kind: "web_turn",
          id: currentA.id,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        signal: new AbortController().signal,
      };
      const contextB = {
        owner: {
          kind: "web_turn",
          id: currentB.id,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        signal: new AbortController().signal,
      };
      const raw = createWebConversationEvidence({
        ...business,
        agentId: DEFAULT_AGENT_ID,
        sessionId: a.id,
        currentTurnId: currentA.id,
        assertCurrent() {},
        assertSources() {},
      });
      const rawPage = evidenceQueryPage(await raw.history.query({ query: "" }, contextA));
      const source = rawPage.items[0]?.sources.find((ref) => ref.kind === "conversation_evidence");
      if (!source) throw new Error("missing raw conversation evidence");
      expect(conversationEvidenceSourceAccess(business, source, contextA.owner, nowIso())).toBe(
        "available",
      );
      expect(conversationEvidenceSourceAccess(business, source, contextB.owner, nowIso())).toBe(
        "revoked",
      );
      const memory = new SqliteMemoryModule({
        orm: business.orm,
        runtime: () => runtimeFromAgent(getAgentRow(business.orm, DEFAULT_AGENT_ID)!),
      });
      const result = await memory.query({
        agentId: DEFAULT_AGENT_ID,
        sessionId: b.id,
        conversationId: cb.id,
        owner: contextB.owner,
        scopes: null,
        mode: "standard",
        query: "",
        budget: 65536,
      });
      const published = result.items.find((item) => item.id === id);
      expect(published).toBeDefined();
      if (!published) throw new Error("missing published memory");
      expect(
        (
          await memory.read({
            agentId: DEFAULT_AGENT_ID,
            sessionId: b.id,
            conversationId: cb.id,
            owner: contextB.owner,
            scopes: null,
            evidence: published,
            offset: 0,
            limit: 4096,
          })
        ).text,
      ).toBe(`body ${id}`);
    } finally {
      business.close();
    }
  });

  it("does not revive a retained QQ owner-sharing reference after share off/on", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const session = createSession(business.orm, "web", { modelName: "synthetic" });
      const sharedId = "00000000-0000-4000-8000-000000000127";
      addMemory(business, session.id, sharedId);
      const otherSession = createSession(business.orm, "other web", { modelName: "synthetic" });
      addMemory(business, otherSession.id, "not-granted-web");
      const now = nowIso();
      const schemeId = "20000000-0000-4000-8000-000000000001";
      const bindingId = "30000000-0000-4000-8000-000000000001";
      business.orm
        .insert(schema.qqSchemes)
        .values({ id: schemeId, name: "synthetic", revision: 1, createdAt: now, updatedAt: now })
        .run();
      const identity = saveQqOwnerIdentity(business.orm, {
        accountId: "10001",
        peerId: "20001",
        revision: 1,
      });
      const created = createQqBinding(
        {
          id: bindingId,
          accountId: "10001",
          kind: "private",
          peerId: "20001",
          agentId: DEFAULT_AGENT_ID,
          schemeId,
          paused: false,
          shareWebMemory: true,
        },
        identity,
      );
      if (created.kind !== "saved") throw new Error("cannot create owner binding");
      let binding = insertQqBinding(business.orm, created.binding);
      const journal = new ConversationEventRepository(business.db);
      const conversation = journal.ensureOneBot(bindingId)!;
      journal.ensureWeb(session.id, DEFAULT_USER_ID);
      journal.ensureWeb(otherSession.id, DEFAULT_USER_ID);
      const app = createApp({ business, externalActions: () => [] });
      expect(
        (
          await app.request(`/agents/${DEFAULT_AGENT_ID}/memory/entries/${sharedId}/visibility`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expected_revision: 1,
              visibility: "agent_shared",
              recipient_agent_ids: [DEFAULT_AGENT_ID],
            }),
          })
        ).status,
      ).toBe(200);
      expect(
        journal.setMemoryReadMode(conversation.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind,
      ).toBe("saved");
      const resolved = resolveQqMemoryAccess(binding, identity);
      if (resolved.kind !== "resolved") throw new Error("missing sharing access");
      const memory = new SqliteMemoryModule({
        orm: business.orm,
        runtime: () => runtimeFromAgent(getAgentRow(business.orm, DEFAULT_AGENT_ID)!),
      });
      const input = {
        agentId: DEFAULT_AGENT_ID,
        conversationId: conversation.id,
        owner: {
          kind: "qq_binding",
          id: bindingId,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        scopes: resolved.access.readScopes.map(qqMemoryScopeKey),
        mode: "standard" as const,
        query: "",
        budget: 65536,
      };
      const page = await memory.query(input);
      const item = page.items.find((candidate) => candidate.id === sharedId);
      expect(page.items.map((candidate) => candidate.id)).not.toContain("not-granted-web");
      if (!item) throw new Error("explicitly granted Web memory missing");
      const oldRef = item.sources[0]!;
      const off = updateQqBinding(binding, { shareWebMemory: false }, binding.revision, identity);
      if (off.kind !== "saved") throw new Error("share off failed");
      binding = saveQqBinding(business.orm, {
        binding: off.binding,
        expectedRevision: binding.revision,
      });
      const on = updateQqBinding(binding, { shareWebMemory: true }, binding.revision, identity);
      if (on.kind !== "saved") throw new Error("share on failed");
      binding = saveQqBinding(business.orm, {
        binding: on.binding,
        expectedRevision: binding.revision,
      });
      expect(binding.authorityRevision).toBeGreaterThan(created.binding.authorityRevision);
      expect(
        sourceAccess(business.db, oldRef, input.owner, { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("revoked");
      expect(() =>
        assertContextSources({
          db: business.db,
          sources: [oldRef],
          owner: input.owner,
          now: nowIso(),
          memoryRevisions: () => new Map(),
          messages: { memory: "denied", other: "denied" },
        }),
      ).toThrow();
    } finally {
      business.close();
    }
  });

  it("resolves the active canonical session and fails closed for foreign or closed identity", () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const session = createSession(business.orm, "session", { modelName: "synthetic" });
      const conversation = new ConversationEventRepository(business.db).ensureWeb(
        session.id,
        DEFAULT_USER_ID,
      );
      if (!conversation) throw new Error("missing canonical conversation");
      expect(
        memoryConversationAccess(business.orm, conversation.id, DEFAULT_AGENT_ID, DEFAULT_USER_ID)
          ?.mode,
      ).toBe("current_conversation");
      expect(
        memoryConversationAccess(business.orm, conversation.id, "foreign", DEFAULT_USER_ID),
      ).toBeNull();
      business.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(new Date().toISOString(), conversation.id);
      expect(
        memoryConversationAccess(business.orm, conversation.id, DEFAULT_AGENT_ID, DEFAULT_USER_ID),
      ).toBeNull();
    } finally {
      business.close();
    }
  });
});
