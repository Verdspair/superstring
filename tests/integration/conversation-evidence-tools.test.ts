import type { SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ActionContext, EvidenceQueryModule } from "../../src/server/agent/built-in-actions";
import { sourceAccess } from "../../src/server/agent/context-access";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  bodyRevision,
  ConversationEventRepository,
} from "../../src/server/db/conversation-event-repository";
import { correctionsForTurns } from "../../src/server/db/memory-content-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import {
  DEFAULT_AGENT_ID as AGENT,
  createSession,
  ensureDefaults,
  prepareTurn,
  saveCompletedAssistantMessage,
  DEFAULT_USER_ID as USER,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { fail } from "../../src/server/errors";
import { evidenceQueryPage } from "../../src/server/modules/contracts";
import {
  conversationEvidenceSourceAccess,
  createBotConversationEvidence,
  createWebConversationEvidence,
} from "../../src/server/modules/conversation-evidence";
import type { Evidence, SourceRef } from "../../src/shared/contracts/evidence";

const at = "2026-09-29T12:00:00.000Z",
  later = "2026-09-30T12:00:00.000Z";
const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function fixture() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "model");
  const exec = (sql: string, ...args: SQLQueryBindings[]) => h.db.query(sql).run(...args);
  const session = createSession(h.orm, "evidence", { modelName: "model" });
  const journal = new ConversationEventRepository(h.db);
  let clock = at;
  function completed(text: string, sessionId = session.id) {
    const key = crypto.randomUUID(),
      p = prepareTurn(h.orm, sessionId, text, key);
    if (!p.generationToken) throw new Error("token");
    saveCompletedAssistantMessage(h.orm, sessionId, `answer ${text}`, key, p.generationToken);
    return h.db
      .query(`SELECT t.id,u.id AS userId,a.id AS assistantId,u.sequence_no AS seq FROM turns t
      JOIN messages u ON u.turn_id=t.id AND u.role='user' JOIN messages a ON a.turn_id=t.id AND a.role='assistant'
      WHERE t.session_id=? AND t.client_request_id=?`)
      .get(sessionId, key) as { id: string; userId: string; assistantId: string; seq: number };
  }
  function checker(context: ActionContext) {
    return (sources: readonly SourceRef[]) => {
      for (const s of sources)
        if (
          (conversationEvidenceSourceAccess(h, s, context.owner, clock) ??
            sourceAccess(h.db, s, context.owner, { userId: USER }, clock)) !== "available"
        )
          fail("CONTEXT_SOURCE_INVALID", "revoked");
    };
  }
  function context(kind: "web_turn" | "qq_binding", id: string): ActionContext {
    return {
      owner: { kind, id, userId: USER, agentId: AGENT },
      signal: new AbortController().signal,
    };
  }
  const common = (ctx: ActionContext) => ({
    ...h,
    agentId: AGENT,
    assertCurrent() {},
    assertSources: checker(ctx),
    now: () => clock,
  });
  function web(retrievalEnabled?: boolean, currentTurnId?: string) {
    let turnId = currentTurnId;
    if (!turnId) {
      const key = crypto.randomUUID();
      prepareTurn(h.orm, session.id, "current", key);
      turnId = (
        h.db
          .query("SELECT id FROM turns WHERE session_id=? AND client_request_id=?")
          .get(session.id, key) as { id: string }
      ).id;
    }
    const ctx = context("web_turn", turnId);
    const options = {
      ...common(ctx),
      sessionId: session.id,
      currentTurnId: turnId,
      ...(retrievalEnabled === undefined ? {} : { retrievalEnabled }),
    };
    return { context: ctx, options, ...createWebConversationEvidence(options) };
  }
  function bot() {
    exec(
      `INSERT INTO qq_schemes(id,name,created_at,updated_at)
      VALUES('scheme','scheme',?,?)`,
      at,
      at,
    );
    exec(
      `INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at)
      VALUES('binding','100','group','200',?,'scheme',?,?)`,
      AGENT,
      at,
      at,
    );
    const c = journal.ensureOneBot("binding");
    if (!c) throw new Error("conversation");
    const conversationId = c.id,
      ctx = context("qq_binding", "binding");
    const scope = {
      kind: "qq" as const,
      accountId: "100",
      conversationKind: "group" as const,
      peerId: "200",
      agentId: AGENT,
    };
    const options = {
      ...common(ctx),
      scope,
      conversationId,
      bindingId: "binding",
      bindingEpoch: c.bindingEpoch,
      authorityRevision: 1,
      summaryEnabled: true,
    };
    function append(kind: "inbound" | "outbound", source: SourceRef) {
      journal.append({
        conversationId,
        eventKey: crypto.randomUUID(),
        kind,
        source,
        occurredAt: at,
      });
    }
    function incoming(text: string, peer = "200") {
      const id = crypto.randomUUID();
      exec(
        `INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,
        message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at)
        VALUES(?,'100','group',?,?,?,100,'member','300',?)`,
        id,
        peer,
        AGENT,
        id,
        at,
      );
      exec("INSERT INTO qq_observation_text VALUES(?,?,100,?,?)", id, text, later, at);
      append("inbound", { kind: "qq_event", id, revision: at });
      return id;
    }
    function outbound(text: string, status: "confirmed" | "unknown" | "planned") {
      const runId = crypto.randomUUID();
      new AgentRunRepository(h.db).createRun({
        runId,
        specId: "fixture",
        specVersion: "1",
        owner: ctx.owner,
        at,
      });
      const target = { ...scope, bindingId: "binding", bindingEpoch: options.bindingEpoch };
      const delivery = new OutboundIntentRepository(h.db).commit({
        runId,
        conversationId,
        ordinal: 0,
        target,
        speechKind: "direct_reply",
        sourceThroughSeq: 0,
        deliverBy: later,
        createdAt: at,
        expiresAt: later,
        parts: [{ kind: "text", text }],
      });
      exec("UPDATE outbound_intents SET status=? WHERE id=?", status, delivery.id);
      exec("UPDATE outbound_parts SET status=? WHERE intent_id=?", status, delivery.id);
      append("outbound", { kind: "outbound_intent", id: delivery.id, revision: status });
    }
    function speech() {
      const id = crypto.randomUUID();
      exec(
        `INSERT INTO qq_speech_log VALUES(?,'100','group','200',?,
        'direct_reply',100,?,?)`,
        id,
        AGENT,
        later,
        at,
      );
      exec("INSERT INTO qq_speech_text VALUES(?,'legacy speech',100,?,?)", id, later, at);
      append("outbound", { kind: "qq_speech", id, revision: "100", expiresAt: later });
    }
    function packageFor(id: string) {
      const sources = [
        { kind: "qq_observation", id, revision: bodyRevision("parent"), expiresAt: later },
      ];
      const source_ids = [JSON.stringify(sources.map((s) => [s.kind, s.id, s.revision]))];
      const facts = [{ kind: "fact", speaker: "300", text: "stored package", source_ids }];
      const packages = [
        { facts, fromSeq: 1, throughSeq: 1, fromSeconds: 100, throughSeconds: 100, at, sources },
      ];
      exec(
        `INSERT INTO qq_conversation_summaries(conversation_id,agent_id,through_seq,covered_seq,
        content,model_name,config_snapshot,estimated_tokens,created_at,updated_at)
        VALUES(?,?,1,1,?,'model','{}',20,?,?)`,
        conversationId,
        AGENT,
        JSON.stringify({ packages }),
        at,
        at,
      );
    }
    return {
      context: ctx,
      options,
      c,
      incoming,
      outbound,
      speech,
      packageFor,
      ...createBotConversationEvidence(options),
    };
  }
  function link(
    table: "summary_sources" | "memory_sources",
    id: string,
    t: ReturnType<typeof completed>,
  ) {
    exec(`INSERT INTO ${table} VALUES(?,?,?,?,?)`, id, t.id, t.userId, t.assistantId, t.seq);
  }
  function summary(turn: ReturnType<typeof completed>, corrections: unknown[] = []) {
    const id = crypto.randomUUID();
    const content = JSON.stringify({
      facts: [{ kind: "fact", speaker: "user", text: "saved summary", source_ids: [turn.id] }],
    });
    const snapshot = JSON.stringify({ memory_corrections: corrections });
    exec(
      `INSERT INTO session_summaries(id,session_id,agent_id,user_id,start_sequence_no,end_sequence_no,
      source_count,content,model_name,config_snapshot,template_version,estimated_tokens,is_valid,created_at)
      VALUES(?,?,?,?,?,?,1,?,'model',?,'1',20,1,?)`,
      id,
      session.id,
      AGENT,
      USER,
      turn.seq,
      turn.seq,
      content,
      snapshot,
      at,
    );
    link("summary_sources", id, turn);
    return id;
  }
  function correction(turn: ReturnType<typeof completed>, body: string) {
    const id = crypto.randomUUID();
    const metadata = {
      content_correction: {
        replaces: "retired",
        rejected: [{ name: "old", summary: "old", body: "wrong" }],
      },
    };
    exec(
      `INSERT INTO memory_entries(id,agent_id,user_id,name,summary,tags,kinds,body,scope,
      scope_key,status,config_snapshot,created_at) VALUES(?,?,?,'correction','correction','[]',
      '[]',?,'reality_user',?,'active',?,?)`,
      id,
      AGENT,
      USER,
      body,
      AGENT,
      JSON.stringify(metadata),
      at,
    );
    link("memory_sources", id, turn);
    return id;
  }
  return {
    ...h,
    exec,
    session,
    journal,
    web,
    bot,
    completed,
    summary,
    correction,
    setClock(value: string) {
      clock = value;
    },
  };
}
async function query(
  module: EvidenceQueryModule,
  context: ActionContext,
  input: Parameters<EvidenceQueryModule["query"]>[0] = { query: "" },
) {
  return evidenceQueryPage(await module.query(input, context));
}
function first(items: readonly Evidence[]) {
  const item = items[0];
  if (!item) throw new Error("missing evidence");
  return item;
}
function read(
  module: EvidenceQueryModule,
  context: ActionContext,
  evidence: Evidence,
  offset = 0,
  limit = 4096,
) {
  if (!module.read) throw new Error("missing read");
  return module.read({ evidence, offset, limit }, context);
}
const invalid = { code: "CONTEXT_SOURCE_INVALID" },
  badSelection = { code: "CONTEXT_INVALID_SELECTION" };

describe("read-only conversation evidence modules", () => {
  it("Web keysets scan twice, bind queries and reject forged or cross-domain cursors", async () => {
    const h = fixture();
    h.completed("first");
    h.completed("Straße second");
    const w = h.web();
    const a = await query(w.history, w.context, { query: "strasse", limit: 2 });
    expect(a.items).toHaveLength(0);
    expect(a.nextCursor).toBeString();
    const cursor = a.nextCursor ?? undefined;
    const b = await query(w.history, w.context, { query: "strasse", limit: 2, cursor });
    expect(b.items).toHaveLength(2);
    expect(b.nextCursor).toBeFalsy();
    expect(first(b.items).text).toBe("");
    expect((await read(w.history, w.context, first(b.items))).text).toBe("Straße second");
    await expect(query(w.history, w.context, { query: "different", cursor })).rejects.toMatchObject(
      badSelection,
    );
    await expect(
      query(w.history, w.context, { query: "strasse", cursor: `${cursor}x` }),
    ).rejects.toMatchObject(badSelection);
    await expect(query(w.summary, w.context, { query: "strasse", cursor })).rejects.toMatchObject(
      badSelection,
    );
  });
  it("Web excludes invalid/deleted/cancelled/current turns; session, agent and owner are bound", async () => {
    const h = fixture(),
      valid = h.completed("valid"),
      hidden = h.completed("invalid"),
      cancelled = h.completed("cancelled"),
      deleted = h.completed("deleted");
    h.exec("UPDATE turns SET context_valid=0 WHERE id=?", hidden.id);
    h.exec("UPDATE turns SET cancel_requested=1 WHERE id=?", cancelled.id);
    h.exec("DELETE FROM messages WHERE id=?", deleted.assistantId);
    const other = createSession(h.orm, "other", { modelName: "model" });
    h.completed("secret", other.id);
    const w = h.web();
    expect((await query(w.history, w.context)).items).toHaveLength(2);
    for (const owner of [
      { ...w.context.owner, agentId: "other" },
      { ...w.context.owner, userId: "other" },
    ])
      await expect(query(w.history, { ...w.context, owner })).rejects.toMatchObject(invalid);
    const foreign = createWebConversationEvidence({ ...w.options, sessionId: other.id });
    await expect(query(foreign.history, w.context)).rejects.toMatchObject(invalid);
    const item = first((await query(w.history, w.context)).items);
    h.exec("UPDATE messages SET content='replacement' WHERE id=?", valid.userId);
    await expect(read(w.history, w.context, item)).rejects.toMatchObject(invalid);
    h.exec("UPDATE turns SET cancel_requested=1 WHERE id=?", w.options.currentTurnId);
    await expect(query(w.history, w.context)).rejects.toMatchObject(invalid);
  });
  it("Web corrections revoke old refs, replace old claims and never leak unrelated memory", async () => {
    const h = fixture(),
      turn = h.completed("wrong old fact"),
      unrelated = h.completed("unrelated");
    h.correction(unrelated, "unrelated correction");
    const w = h.web();
    const before = first((await query(w.history, w.context)).items),
      id = h.correction(turn, "correct fact");
    await expect(read(w.history, w.context, before)).rejects.toMatchObject(invalid);
    const item = first((await query(w.history, w.context)).items),
      body = (await read(w.history, w.context, item)).text;
    expect(body).toContain("correct fact");
    expect(body).not.toContain("wrong old fact");
    expect(body).not.toContain("unrelated correction");
    expect(JSON.stringify(item)).not.toContain("wrong old fact");
    expect(item.sources.some((s) => s.kind === "memory")).toBe(true);
    h.exec("UPDATE memory_entries SET status='suppressed' WHERE id=?", id);
    expect((await query(w.history, w.context, { query: "wrong old fact" })).items).toHaveLength(0);
    h.exec("UPDATE turns SET source_valid=0 WHERE id=?", turn.id);
    await expect(read(w.history, w.context, item)).rejects.toMatchObject(invalid);
  });
  it("Web scans default 20/max100 with real SQL LIMIT; Unicode reads max4096 and cancel hard", async () => {
    const h = fixture();
    for (let i = 0; i < 55; i++) h.completed(i === 0 ? "𠮷".repeat(5000) : `line ${i}`);
    const w = h.web(),
      trace = spyOn(h.db, "query");
    expect((await query(w.history, w.context)).items).toHaveLength(20);
    const page = await query(w.history, w.context, { query: "", limit: 1000 });
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).toBeString();
    expect(
      trace.mock.calls.some(([sql]) => sql.includes("sequence_no>") && sql.includes("LIMIT ?")),
    ).toBe(true);
    trace.mockRestore();
    const item = first(page.items);
    expect([...(item.preview?.summary ?? "")].length).toBeLessThanOrEqual(256);
    const body = await read(w.history, w.context, item, 0, 9999);
    expect([...body.text]).toHaveLength(4096);
    expect(body.nextOffset).toBe(4096);
    expect((await read(w.history, w.context, item, 4096)).text).toBe("𠮷".repeat(904));
    await expect(read(w.history, w.context, item, 5001)).rejects.toMatchObject(badSelection);
    await expect(
      read(w.history, { ...w.context, signal: AbortSignal.abort() }, item),
    ).rejects.toBeDefined();
    await expect(
      query(w.history, { ...w.context, signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
  });
  it("Web summary checks correction snapshots, source links, body edits and deletion", async () => {
    const h = fixture(),
      turn = h.completed("original"),
      stale = h.summary(turn);
    h.correction(turn, "correct summary fact");
    const good = h.summary(turn, correctionsForTurns(h.orm, AGENT, [turn.id])),
      w = h.web();
    const page = await query(w.summary, w.context);
    expect(page.items).toHaveLength(1);
    const item = first(page.items);
    expect(item.sources.some((s) => s.kind === "web_turn")).toBe(true);
    expect(item.sources.some((s) => s.kind === "conversation_evidence")).toBe(true);
    h.exec(
      "UPDATE session_summaries SET content=replace(content,'saved summary','changed') WHERE id=?",
      good,
    );
    await expect(read(w.summary, w.context, item)).rejects.toMatchObject(invalid);
    const fresh = first((await query(w.summary, w.context)).items);
    h.exec("UPDATE messages SET content='parent changed' WHERE id=?", turn.userId);
    await expect(read(w.summary, w.context, fresh)).rejects.toMatchObject(invalid);
    h.exec("DELETE FROM session_summaries WHERE id=?", good);
    await expect(read(w.summary, w.context, fresh)).rejects.toMatchObject(invalid);
    h.exec("UPDATE session_summaries SET config_snapshot='{}' WHERE id=?", stale);
    expect((await query(w.summary, w.context)).items).toHaveLength(0);
  });
  it("Web summary refuses missing parents, cross-session source links and context invalidation", async () => {
    const h = fixture(),
      turn = h.completed("parent"),
      id = h.summary(turn),
      w = h.web();
    const item = first((await query(w.summary, w.context)).items);
    h.exec("UPDATE turns SET context_valid=0 WHERE id=?", turn.id);
    await expect(read(w.summary, w.context, item)).rejects.toMatchObject(invalid);
    h.exec("UPDATE turns SET context_valid=1 WHERE id=?", turn.id);
    h.exec("UPDATE summary_sources SET user_message_id='missing' WHERE summary_id=?", id);
    expect((await query(w.summary, w.context)).items).toHaveLength(0);
    const other = createSession(h.orm, "other", { modelName: "model" }),
      t = h.completed("foreign", other.id);
    h.exec(
      "UPDATE summary_sources SET turn_id=?,user_message_id=?,assistant_message_id=? WHERE summary_id=?",
      t.id,
      t.userId,
      t.assistantId,
      id,
    );
    expect((await query(w.summary, w.context)).items).toHaveLength(0);
  });
  it("QQ filters foreign, expired, unknown and unsent bodies and never advances watermarks", async () => {
    const h = fixture(),
      b = h.bot();
    b.incoming("same group");
    b.incoming("foreign secret", "999");
    const expired = b.incoming("expired");
    h.exec("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?", at, expired);
    // The wake event re-references the expired observation; 0040 forbids repeating a
    // (source_kind, source_id, source_revision) tuple, so it carries its own revision.
    h.journal.append({
      conversationId: b.c.id,
      eventKey: "wake",
      kind: "wake",
      source: { kind: "qq_event", id: expired, revision: "wake" },
      occurredAt: at,
    });
    b.outbound("sent body", "confirmed");
    b.outbound("unknown body", "unknown");
    b.outbound("draft", "planned");
    b.speech();
    const sql = "SELECT consumed_seq,source_watermark FROM conversations WHERE id=?",
      before = h.db.query(sql).get(b.c.id);
    h.exec("PRAGMA query_only=ON");
    const page = await query(b.history, b.context);
    expect(page.items).toHaveLength(3);
    expect((await read(b.history, b.context, page.items[1] as Evidence)).text).toBe("sent body");
    expect((await read(b.history, b.context, page.items[2] as Evidence)).text).toBe(
      "legacy speech",
    );
    expect(h.db.query(sql).get(b.c.id)).toEqual(before);
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_conversation_summaries").get()).toEqual({
      n: 0,
    });
  });
  it("QQ invalid-only pages advance; foreign scope, rebind and altered bodies fail", async () => {
    const h = fixture(),
      b = h.bot();
    b.incoming("foreign", "999");
    const id = b.incoming("local");
    const a = await query(b.history, b.context, { query: "", limit: 1 });
    expect(a.items).toHaveLength(0);
    expect(a.nextCursor).toBeString();
    const page = await query(b.history, b.context, {
        query: "",
        limit: 1,
        cursor: a.nextCursor ?? undefined,
      }),
      item = first(page.items);
    const wrong = createBotConversationEvidence({
      ...b.options,
      scope: { ...b.options.scope, peerId: "999" },
    });
    await expect(query(wrong.history, b.context)).rejects.toMatchObject(invalid);
    h.exec("UPDATE qq_observation_text SET body='changed' WHERE event_key=?", id);
    await expect(read(b.history, b.context, item)).rejects.toMatchObject(invalid);
    h.exec("UPDATE qq_bindings SET revision=2,authority_revision=2 WHERE id='binding'");
    await expect(query(b.history, b.context)).rejects.toMatchObject(invalid);
  });
  it("QQ epoch closure and live expiry revoke existing references", async () => {
    const h = fixture(),
      b = h.bot();
    b.incoming("local");
    const item = first((await query(b.history, b.context)).items);
    h.setClock(later);
    await expect(read(b.history, b.context, item)).rejects.toMatchObject(invalid);
    h.setClock(at);
    h.exec("UPDATE conversations SET closed_at=? WHERE id=?", at, b.c.id);
    await expect(read(b.history, b.context, item)).rejects.toMatchObject(invalid);
  });
  it("QQ stored packages expire with parents; judgement installs no summary", async () => {
    const h = fixture(),
      b = h.bot(),
      id = b.incoming("parent");
    b.packageFor(id);
    expect(
      "summary" in createBotConversationEvidence({ ...b.options, summaryEnabled: false }),
    ).toBe(false);
    if (!b.summary) throw new Error("summary");
    const item = first((await query(b.summary, b.context)).items);
    expect((await read(b.summary, b.context, item)).text).toContain("stored package");
    const self = item.sources.find((s) => s.kind === "conversation_evidence");
    if (!self) throw new Error("self ref");
    expect(conversationEvidenceSourceAccess(h, self, b.context.owner, at)).toBe("available");
    h.exec(
      "UPDATE qq_conversation_summaries SET content=replace(content,'stored package','changed')",
    );
    expect(conversationEvidenceSourceAccess(h, self, b.context.owner, at)).toBe("revoked");
    const current = first((await query(b.summary, b.context)).items);
    h.setClock(later);
    await expect(read(b.summary, b.context, current)).rejects.toMatchObject(invalid);
    expect((await query(b.summary, b.context)).items).toHaveLength(0);
    h.setClock(at);
    h.exec("DELETE FROM qq_conversation_summaries");
    await expect(read(b.summary, b.context, current)).rejects.toMatchObject(invalid);
  });
  it("QQ summary cannot use a valid same-agent source from another group", async () => {
    const h = fixture(),
      b = h.bot(),
      id = b.incoming("parent", "999");
    b.packageFor(id);
    if (!b.summary) throw new Error("summary");
    expect((await query(b.summary, b.context)).items).toHaveLength(0);
  });
});

describe("Web evidence with retrieval disabled", () => {
  it("never reads or tracks corrections: raw history is readable and carries no memory sources", async () => {
    const h = fixture(),
      turn = h.completed("raw original");
    h.correction(turn, "correction body must stay hidden");
    const w = h.web(false),
      trace = spyOn(h.db, "query");
    const page = await query(w.history, w.context);
    expect(page.items).toHaveLength(2);
    const item = first(page.items),
      body = await read(w.history, w.context, item);
    expect(body.text).toBe("raw original");
    expect((await read(w.history, w.context, page.items[1] as Evidence)).text).toBe(
      "answer raw original",
    );
    expect(item.sources.some((s) => s.kind === "memory")).toBe(false);
    expect(JSON.stringify(item)).not.toContain("correction body");
    expect(String(item.preview?.title)).not.toContain("corrected");
    expect((await query(w.history, w.context, { query: "raw original" })).items).toHaveLength(2);
    expect(
      (await query(w.history, w.context, { query: "correction body must stay hidden" })).items,
    ).toHaveLength(0);
    expect(
      trace.mock.calls.some(
        ([sql]) => sql.includes("memory_entries") || sql.includes("memory_sources"),
      ),
    ).toBe(false);
    trace.mockRestore();
  });
  it("off-minted refs survive correction changes while on-minted refs and turn checks stay strict", async () => {
    const h = fixture(),
      turn = h.completed("stable raw");
    const off = h.web(false),
      on = h.web(true, off.options.currentTurnId);
    const offItem = first((await query(off.history, off.context)).items),
      onItem = first((await query(on.history, on.context)).items);
    expect((await read(on.history, on.context, onItem)).text).toBe("stable raw");
    const offRef = offItem.sources.find((s) => s.kind === "conversation_evidence");
    if (!offRef) throw new Error("self ref");
    expect(conversationEvidenceSourceAccess(h, offRef, off.context.owner, at)).toBe("available");
    const parsedRef = JSON.parse(offRef.id) as [Record<string, unknown>, string, string];
    expect(
      conversationEvidenceSourceAccess(
        h,
        {
          ...offRef,
          id: JSON.stringify([
            { ...parsedRef[0], retrievalEnabled: true },
            parsedRef[1],
            parsedRef[2],
          ]),
        },
        off.context.owner,
        at,
      ),
    ).toBe("revoked");
    const id = h.correction(turn, "late correction");
    await expect(read(on.history, on.context, onItem)).rejects.toMatchObject(invalid);
    expect((await read(off.history, off.context, offItem)).text).toBe("stable raw");
    expect(conversationEvidenceSourceAccess(h, offRef, off.context.owner, at)).toBe("available");
    h.exec("UPDATE memory_entries SET body='edited correction' WHERE id=?", id);
    expect(conversationEvidenceSourceAccess(h, offRef, off.context.owner, at)).toBe("available");
    h.exec("UPDATE memory_entries SET status='suppressed' WHERE id=?", id);
    expect((await read(off.history, off.context, offItem)).text).toBe("stable raw");
    expect(conversationEvidenceSourceAccess(h, offRef, off.context.owner, at)).toBe("available");
    h.exec("UPDATE turns SET source_valid=0 WHERE id=?", turn.id);
    await expect(read(off.history, off.context, offItem)).rejects.toMatchObject(invalid);
    expect(conversationEvidenceSourceAccess(h, offRef, off.context.owner, at)).toBe("revoked");
  });
  it("refuses corrections snapshots, serves empty snapshots and reads no memory", async () => {
    const h = fixture(),
      turn = h.completed("summary parent");
    h.correction(turn, "snapshot correction");
    const corrections = correctionsForTurns(h.orm, AGENT, [turn.id]);
    expect(corrections).toHaveLength(1);
    h.summary(turn, corrections);
    h.summary(turn, []);
    const w = h.web(false),
      trace = spyOn(h.db, "query");
    const page = await query(w.summary, w.context);
    expect(page.items).toHaveLength(1);
    const item = first(page.items),
      body = await read(w.summary, w.context, item);
    expect(body.text).toContain("saved summary");
    expect(item.sources.some((s) => s.kind === "memory")).toBe(false);
    expect(item.sources.some((s) => s.kind === "web_turn")).toBe(true);
    const self = item.sources.find((s) => s.kind === "conversation_evidence");
    if (!self) throw new Error("self ref");
    expect(conversationEvidenceSourceAccess(h, self, w.context.owner, at)).toBe("available");
    expect(
      trace.mock.calls.some(
        ([sql]) => sql.includes("memory_entries") || sql.includes("memory_sources"),
      ),
    ).toBe(false);
    trace.mockRestore();
  });
  it("binds refs to the factory flag: omitting or flipping it on a corrected turn fails closed", async () => {
    const h = fixture(),
      turn = h.completed("raw body");
    h.correction(turn, "later correction");
    const w = h.web(false);
    const item = first((await query(w.history, w.context)).items);
    const self = item.sources.find((s) => s.kind === "conversation_evidence");
    if (!self) throw new Error("self ref");
    expect(conversationEvidenceSourceAccess(h, self, w.context.owner, at)).toBe("available");
    const parsed = JSON.parse(self.id) as [Record<string, unknown>, string, string];
    const omitted = { ...parsed[0] };
    delete omitted.retrievalEnabled;
    expect(
      conversationEvidenceSourceAccess(
        h,
        { ...self, id: JSON.stringify([omitted, parsed[1], parsed[2]]) },
        w.context.owner,
        at,
      ),
    ).toBe("revoked");
    expect(
      conversationEvidenceSourceAccess(
        h,
        {
          ...self,
          id: JSON.stringify([{ ...parsed[0], retrievalEnabled: true }, parsed[1], parsed[2]]),
        },
        w.context.owner,
        at,
      ),
    ).toBe("revoked");
    expect(conversationEvidenceSourceAccess(h, self, w.context.owner, at)).toBe("available");
  });
});
