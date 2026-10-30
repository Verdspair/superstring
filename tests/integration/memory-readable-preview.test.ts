import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { sourceAccess } from "../../src/server/agent/context-access";
import { createApp } from "../../src/server/app";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  memoryPreviewTargets,
  memorySourceFactAssessment,
} from "../../src/server/db/memory-source-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID as A,
  createSession,
  ensureDefaults,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
  DEFAULT_USER_ID as U,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { SqliteMemoryModule } from "../../src/server/modules/memory-module";
import { createAgent, getAgentRowById } from "../../src/server/services/agent-service";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { qqConversationKey, qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import {
  MemoryReadablePageSchema,
  MemorySourcePreviewListSchema,
  MemorySourcePreviewPageSchema,
} from "../../src/shared/contracts/memory";

function fixture() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "synthetic");
  const journal = new ConversationEventRepository(business.db);
  const B = createAgent(
    business.orm,
    { name: "receiver", model_name: "synthetic" },
    {
      core_identity: "",
      communication_style: "",
      interaction_boundaries: "",
      example_dialogues: "",
      advanced_instructions: "",
    },
  ).id;
  const source = createSession(business.orm, "source", { modelName: "synthetic" });
  const receiver = createSession(business.orm, "receiver", { agentId: B, modelName: "synthetic" });
  const sourceConversation = journal.ensureWeb(source.id, U)!;
  const recipientConversation = journal.ensureWeb(receiver.id, U)!;
  const raw = "RAW_USER_ONLY 🦄\n" + "原文".repeat(2500);
  const prepared = prepareTurn(business.orm, source.id, raw, "source-pair");
  saveCompletedAssistantMessage(
    business.orm,
    source.id,
    "RAW_ASSISTANT_ONLY",
    "source-pair",
    prepared.generationToken!,
  );
  const turn = getTurnByRequest(business.orm, source.id, "source-pair")!;
  const messages = business.orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.turnId, turn.id))
    .all();
  const user = messages.find((m) => m.role === "user")!,
    assistant = messages.find((m) => m.role === "assistant")!;
  journal.ingestWebMessage(user.id);
  journal.ingestWebMessage(assistant.id);
  const id = crypto.randomUUID();
  const body = "DERIVED_ONLY " + "🦄".repeat(5000);
  const entry = business.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: A,
      userId: U,
      name: "received memory",
      summary: "derived summary",
      body,
      tags: "[]",
      kinds: "[]",
      scope: "reality_user",
      scopeKey: A,
      status: "active",
      configSnapshot: JSON.stringify({ prompt: "OWNER_PROMPT_ONLY" }),
      visibility: "session_private",
      createdAt: nowIso(),
    })
    .returning()
    .get()!;
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
  const app = createApp({ business, externalActions: () => [] });
  const owner = `/agents/${A}/memory/entries/${id}`,
    received = `/agents/${B}/memory/entries/${id}`;
  const publish = async (recipients: string[], revision: number) =>
    app.request(`${owner}/visibility`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: revision,
        visibility: recipients.length ? "public" : "session_private",
        recipient_agent_ids: recipients,
      }),
    });
  return {
    business,
    journal,
    B,
    source,
    sourceConversation,
    recipientConversation,
    user,
    assistant,
    turn,
    id,
    entry,
    raw,
    body,
    app,
    owner,
    received,
    publish,
  };
}

function traceSourceReads(db: Database) {
  const reads: Array<{ sql: string; args: unknown[]; rows: Record<string, unknown>[] }> = [];
  const query = db.query,
    prepare = db.prepare;
  let constructing = false;
  const wrap = (original: typeof db.query) =>
    ((sql: string) => {
      if (constructing) return Reflect.apply(original, db, [sql]);
      constructing = true;
      let statement: ReturnType<typeof db.query>;
      try {
        statement = Reflect.apply(original, db, [sql]);
      } finally {
        constructing = false;
      }
      return new Proxy(statement, {
        get(target, key) {
          const method = Reflect.get(target, key, target);
          if (key === "all" || key === "get")
            return (...args: unknown[]) => {
              const result = Reflect.apply(method, target, args);
              reads.push({
                sql,
                args,
                rows: structuredClone(Array.isArray(result) ? result : result ? [result] : []),
              });
              return result;
            };
          return typeof method === "function" ? method.bind(target) : method;
        },
      });
    }) as typeof db.query;
  db.query = wrap(query);
  db.prepare = wrap(prepare);
  return {
    reads,
    restore() {
      db.query = query;
      db.prepare = prepare;
    },
  };
}

function addDistinctInspectionSources(
  f: ReturnType<typeof fixture>,
  count: number,
  channel: "web" | "qq" | "mixed",
) {
  const targets: Array<{
    conversationId: string;
    kind: "web_message" | "qq_observation";
    id: string;
    turnId?: string;
    role?: "user";
  }> = [];
  const textById = new Map<string, string>();
  let qqConversation: ReturnType<typeof f.journal.ensureOneBot> = null;
  let binding: string | null = null;
  if (channel !== "web") {
    const now = nowIso(),
      scheme = crypto.randomUUID();
    binding = crypto.randomUUID();
    f.business.orm
      .insert(schema.qqSchemes)
      .values({ id: scheme, name: "distinct scale", createdAt: now, updatedAt: now })
      .run();
    f.business.orm
      .insert(schema.qqBindings)
      .values({
        id: binding,
        accountId: "91001",
        conversationKind: "group",
        peerId: "31003",
        agentId: A,
        schemeId: scheme,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    qqConversation = f.journal.ensureOneBot(binding)!;
  }
  for (let index = 0; index < count; index++) {
    const web = channel === "web" || (channel === "mixed" && index % 2 === 0);
    const text = `${web ? "WEB" : "QQ"}_DISTINCT_${index}_🦄`;
    if (web) {
      const request = `distinct-${channel}-${index}`;
      const prepared = prepareTurn(f.business.orm, f.source.id, text, request);
      saveCompletedAssistantMessage(
        f.business.orm,
        f.source.id,
        `assistant-${index}`,
        request,
        prepared.generationToken!,
      );
      const turn = getTurnByRequest(f.business.orm, f.source.id, request)!;
      const pair = f.business.orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.turnId, turn.id))
        .all();
      const user = pair.find((row) => row.role === "user")!,
        assistant = pair.find((row) => row.role === "assistant")!;
      f.journal.ingestWebMessage(user.id);
      f.journal.ingestWebMessage(assistant.id);
      f.business.orm
        .insert(schema.memorySources)
        .values({
          memoryId: f.id,
          turnId: turn.id,
          userMessageId: user.id,
          assistantMessageId: assistant.id,
          sequenceNo: user.sequenceNo,
        })
        .run();
      targets.push({
        conversationId: f.sourceConversation.id,
        kind: "web_message",
        id: user.id,
        turnId: turn.id,
        role: "user",
      });
      textById.set(user.id, text);
    } else {
      const observed = normalizeOneBotMessage(
        {
          time: Math.floor(Date.now() / 1000),
          self_id: 91001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: 10000 + index,
          user_id: 21002 + index,
          group_id: 31003,
          sender: { nickname: `member-${index}` },
          message: [{ type: "text", data: { text } }],
        },
        "91001",
      );
      if (observed.kind !== "message") throw new Error("no distinct observation");
      recordObservation(f.business.orm, observed.observation, A);
      f.journal.ingestOneBotEvent(observed.observation.eventKey, binding!);
      const scopeKey = qqMemoryScopeKey({
        kind: "qq",
        accountId: "91001",
        conversationKind: "group",
        peerId: "31003",
        agentId: A,
      });
      f.business.orm
        .insert(schema.qqMemorySources)
        .values({
          memoryId: f.id,
          eventKey: observed.observation.eventKey,
          scopeKey,
          conversationKey: qqConversationKey({
            accountId: "91001",
            kind: "group",
            peerId: "31003",
          }),
          messageId: observed.observation.messageId,
          occurredAtSeconds: observed.observation.occurredAtSeconds,
          speakerKind: observed.observation.speaker.kind,
          speakerId: observed.observation.speaker.id,
        })
        .run();
      targets.push({
        conversationId: qqConversation!.id,
        kind: "qq_observation",
        id: observed.observation.eventKey,
      });
      textById.set(observed.observation.eventKey, text);
    }
  }
  return { targets, textById, qqConversation };
}

describe("received content and independently authorized original preview", () => {
  it("walks received discovery, explicit canonical, full derived pages and actual raw pages without owner impersonation", async () => {
    const f = fixture();
    try {
      expect((await f.publish([f.B], 1)).status).toBe(200);
      const listResponse = await f.app.request(`/agents/${f.B}/memory/entries?view=received`);
      expect(listResponse.headers.get("cache-control")).toBe("no-store");
      const list = (await listResponse.json()) as { items: { id: string }[] };
      expect(list.items.map((item) => item.id)).toEqual([f.id]);
      expect((await f.app.request(`${f.received}/read`)).status).toBe(409);
      const c = f.recipientConversation.id;
      expect((await f.app.request(`${f.received}/read?conversation_id=${c}`)).status).toBe(409);
      f.journal.setMemoryReadMode(c, U, "agent_shared", 1);
      const firstResponse = await f.app.request(`${f.received}/read?conversation_id=${c}`);
      expect(firstResponse.headers.get("cache-control")).toBe("no-store");
      const first = MemoryReadablePageSchema.parse(await firstResponse.json());
      const second = MemoryReadablePageSchema.parse(
        await (
          await f.app.request(
            `${f.received}/read?conversation_id=${c}&offset=${first.nextOffset}&revision=${first.revision}`,
          )
        ).json(),
      );
      expect(first.text + second.text).toBe(f.body);
      expect(JSON.stringify(first)).not.toContain("RAW_USER_ONLY");
      expect(JSON.stringify(first)).not.toContain("OWNER_PROMPT_ONLY");
      expect(first.reader_agent_id).toBe(f.B);
      expect((await f.app.request(f.received)).status).toBe(404);
      expect((await f.app.request(`${f.received}/content`)).status).toBe(404);
      const sources = MemorySourcePreviewListSchema.parse(
        await (await f.app.request(`${f.received}/sources?conversation_id=${c}`)).json(),
      );
      expect(sources.raw_preview).toBe("available");
      const originals: string[] = [];
      for (const item of sources.items) {
        expect(item.state).toBe("available");
        const query = new URLSearchParams({
          conversation_id: c,
          source_key: item.source_key!,
          revision: item.revision!,
        });
        let response = MemorySourcePreviewPageSchema.parse(
          await (await f.app.request(`${f.received}/source-preview?${query}`)).json(),
        );
        let text = response.text;
        while (response.nextOffset !== null) {
          query.set("offset", String(response.nextOffset));
          response = MemorySourcePreviewPageSchema.parse(
            await (await f.app.request(`${f.received}/source-preview?${query}`)).json(),
          );
          text += response.text;
        }
        originals.push(text);
      }
      expect(originals).toContain(f.raw);
      expect(originals).toContain("RAW_ASSISTANT_ONLY");
      expect(originals.join()).not.toContain("DERIVED_ONLY");
      expect(
        (
          await f.app.request(`${f.received}/correct`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expected_revision: "a".repeat(64),
              name: "bad",
              summary: "bad",
              tags: [],
              body: "bad",
            }),
          })
        ).status,
      ).toBe(404);
    } finally {
      f.business.close();
    }
  });
  it("revalidates grant/mode ABA and independently denies source access without changing derived authority", async () => {
    const f = fixture();
    try {
      await f.publish([f.B], 1);
      const c = f.recipientConversation.id;
      f.journal.setMemoryReadMode(c, U, "agent_shared", 1);
      const first = MemoryReadablePageSchema.parse(
        await (await f.app.request(`${f.received}/read?conversation_id=${c}`)).json(),
      );
      await f.publish([], 2);
      await f.publish([f.B], 3);
      expect(
        (
          await f.app.request(
            `${f.received}/read?conversation_id=${c}&offset=4096&revision=${first.revision}`,
          )
        ).status,
      ).toBe(409);
      const sources = MemorySourcePreviewListSchema.parse(
        await (await f.app.request(`${f.owner}/sources`)).json(),
      );
      const item = sources.items[0]!;
      f.business.orm
        .insert(schema.users)
        .values({ id: "foreign", name: "foreign user", createdAt: nowIso() })
        .run();
      f.business.db
        .query("UPDATE conversations SET user_id=? WHERE id=?")
        .run("foreign", f.sourceConversation.id);
      const denied = MemorySourcePreviewListSchema.parse(
        await (await f.app.request(`${f.owner}/sources`)).json(),
      );
      expect(denied.raw_preview).toBe("unavailable");
      expect(
        denied.items.every((value) => value.source_key === null && value.conversation_id === null),
      ).toBe(true);
      const query = new URLSearchParams({ source_key: item.source_key!, revision: item.revision! });
      expect((await f.app.request(`${f.owner}/source-preview?${query}`)).status).toBe(409);
    } finally {
      f.business.close();
    }
  });
  it("rejects a tampered Web pair even when the substituted message belongs to the same conversation", async () => {
    const f = fixture();
    try {
      const prepared = prepareTurn(
        f.business.orm,
        f.source.id,
        "UNRELATED_SAME_CONVERSATION",
        "second",
      );
      saveCompletedAssistantMessage(
        f.business.orm,
        f.source.id,
        "other",
        "second",
        prepared.generationToken!,
      );
      const turn = getTurnByRequest(f.business.orm, f.source.id, "second")!;
      const m = f.business.orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.turnId, turn.id))
        .all()
        .find((row) => row.role === "user")!;
      f.journal.ingestWebMessage(m.id);
      f.business.db
        .query("UPDATE memory_sources SET user_message_id=? WHERE memory_id=?")
        .run(m.id, f.id);
      const response = MemorySourcePreviewListSchema.parse(
        await (await f.app.request(`${f.owner}/sources`)).json(),
      );
      expect(response.source_validity).toBe("invalid");
      expect(response.raw_preview).toBe("unavailable");
      expect(response.items.every((item) => item.source_key === null)).toBe(true);
      expect(JSON.stringify(response)).not.toContain("UNRELATED_SAME_CONVERSATION");
    } finally {
      f.business.close();
    }
  });
  it("keeps QQ permanent facts valid after body expiry while raw read denies; page targets resolve only the requested batch", async () => {
    const f = fixture();
    try {
      const now = nowIso(),
        binding = crypto.randomUUID(),
        scheme = crypto.randomUUID();
      f.business.orm
        .insert(schema.qqSchemes)
        .values({ id: scheme, name: "scheme", createdAt: now, updatedAt: now })
        .run();
      f.business.orm
        .insert(schema.qqBindings)
        .values({
          id: binding,
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: A,
          schemeId: scheme,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const c = f.journal.ensureOneBot(binding)!;
      const normalized = normalizeOneBotMessage(
        {
          time: Math.floor(Date.now() / 1000),
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: 125,
          user_id: 20002,
          group_id: 30003,
          sender: { nickname: "member" },
          message: [{ type: "text", data: { text: "QQ_RAW_ONLY 🦄" } }],
        },
        "90001",
      );
      if (normalized.kind !== "message") throw new Error("missing observation");
      recordObservation(f.business.orm, normalized.observation, A);
      f.journal.ingestOneBotEvent(normalized.observation.eventKey, binding);
      const key = qqMemoryScopeKey({
        kind: "qq",
        accountId: "90001",
        conversationKind: "group",
        peerId: "30003",
        agentId: A,
      });
      f.business.db.query("UPDATE memory_entries SET scope_key=? WHERE id=?").run(key, f.id);
      f.business.orm
        .insert(schema.qqMemorySources)
        .values({
          memoryId: f.id,
          eventKey: normalized.observation.eventKey,
          scopeKey: key,
          conversationKey: qqConversationKey({
            accountId: "90001",
            kind: "group",
            peerId: "30003",
          }),
          messageId: normalized.observation.messageId,
          occurredAtSeconds: normalized.observation.occurredAtSeconds,
          speakerKind: normalized.observation.speaker.kind,
          speakerId: normalized.observation.speaker.id,
        })
        .run();
      const before = MemorySourcePreviewListSchema.parse(
        await (await f.app.request(`${f.owner}/sources`)).json(),
      );
      expect(
        before.items.some((item) => item.channel === "onebot11" && item.state === "available"),
      ).toBe(true);
      const { inspectConversationSourcePages } = await import(
        "../../src/server/agent/conversation-access"
      );
      const caps = f.business.db
        .query("SELECT expires_at FROM qq_observation_text WHERE event_key=?")
        .get(normalized.observation.eventKey) as { expires_at: string };
      const activeItem = before.items.find((item) => item.channel === "onebot11")!;
      const activeQuery = new URLSearchParams({
        source_key: activeItem.source_key!,
        revision: activeItem.revision!,
      });
      const activePreview = await f.app.request(`${f.owner}/source-preview?${activeQuery}`);
      expect(activePreview.status).toBe(200);
      expect(MemorySourcePreviewPageSchema.parse(await activePreview.json()).text).toBe(
        "QQ_RAW_ONLY 🦄",
      );
      const trace = traceSourceReads(f.business.db);
      try {
        const boundary = inspectConversationSourcePages(
          f.business.db,
          f.journal,
          { userId: U },
          [{ conversationId: c.id, kind: "qq_observation", id: normalized.observation.eventKey }],
          {
            includeShared: true,
            now: nowIso(),
            clock: () => caps.expires_at,
            signal: new AbortController().signal,
            offset: 0,
            limit: 4096,
          },
        );
        expect(boundary[0]).toMatchObject({ state: "unavailable", reason: "expired" });
        const payload = trace.reads.filter((read) => read.sql.includes("t.body"));
        expect(payload).toHaveLength(1);
        expect(payload[0]!.rows.map((row) => row.text)).toEqual(["QQ_RAW_ONLY 🦄"]);
        const metadata = trace.reads.filter((read) =>
          read.sql.includes("NULL AS text,NULL AS status,t.expires_at"),
        );
        expect(metadata).toHaveLength(2);
        expect(metadata[1]!.rows.map((row) => row.text)).toEqual([null]);
        trace.reads.length = 0;
        const expired = inspectConversationSourcePages(
          f.business.db,
          f.journal,
          { userId: U },
          [{ conversationId: c.id, kind: "qq_observation", id: normalized.observation.eventKey }],
          {
            includeShared: true,
            now: caps.expires_at,
            clock: () => caps.expires_at,
            signal: new AbortController().signal,
            offset: 0,
            limit: 4096,
          },
        );
        expect(expired).toEqual([{ state: "unavailable", reason: "expired" }]);
        expect(trace.reads.filter((read) => read.sql.includes("t.body"))).toHaveLength(0);
        const expiredMetadata = trace.reads.filter((read) =>
          read.sql.includes("NULL AS text,NULL AS status,t.expires_at"),
        );
        expect(expiredMetadata).toHaveLength(2);
        expect(expiredMetadata.flatMap((read) => read.rows.map((row) => row.text))).toEqual([
          null,
          null,
        ]);
      } finally {
        trace.restore();
      }
      f.business.db
        .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
        .run("2000-01-01T00:00:00.000Z", normalized.observation.eventKey);
      const row = f.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, f.id))
        .get()!;
      expect(memorySourceFactAssessment(f.business.orm, [row]).states.get(f.id)).toBe("valid");
      const changesBefore = f.business.db.query("SELECT total_changes() AS changes").get();
      const expiredTrace = traceSourceReads(f.business.db);
      f.business.db.exec("PRAGMA query_only=ON");
      try {
        const after = MemorySourcePreviewListSchema.parse(
          await (await f.app.request(`${f.owner}/sources`)).json(),
        );
        expect(after.raw_preview).toBe("unavailable");
        expect(after.items.some((item) => item.reason === "expired")).toBe(true);
        const expiredPreview = await f.app.request(`${f.owner}/source-preview?${activeQuery}`);
        expect(expiredPreview.status).toBe(409);
        const deniedBody = await expiredPreview.text();
        expect(deniedBody).toContain("CONTEXT_SOURCE_INVALID");
        expect(deniedBody).not.toContain("QQ_RAW_ONLY");
        const metadata = expiredTrace.reads.filter((read) =>
          read.sql.includes("NULL AS text,NULL AS status,t.expires_at"),
        );
        expect(metadata).toHaveLength(4);
        expect(metadata.flatMap((read) => read.rows.map((row) => row.text))).toEqual([
          null,
          null,
          null,
          null,
        ]);
        expect(expiredTrace.reads.filter((read) => read.sql.includes("t.body"))).toHaveLength(0);
      } finally {
        f.business.db.exec("PRAGMA query_only=OFF");
        expiredTrace.restore();
      }
      expect(f.business.db.query("SELECT total_changes() AS changes").get()).toEqual(changesBefore);
      const page = memoryPreviewTargets(f.business.orm, row, { offset: 1, limit: 1 });
      expect(page.total).toBe(3);
      expect(page.targets).toHaveLength(1);
      expect(f.business.db.query("SELECT id FROM conversations WHERE id=?").get(c.id)).toBeTruthy();
    } finally {
      f.business.close();
    }
  });
  it("rejects strict malformed parameters and keeps readonly discovery/body requests free of policy or journal writes", async () => {
    const f = fixture();
    try {
      const before = f.business.db
        .query(
          "SELECT (SELECT count(*) FROM memory_policies) AS policies,(SELECT count(*) FROM conversations) AS conversations,(SELECT count(*) FROM memory_jobs) AS jobs",
        )
        .get();
      expect((await f.app.request(`${f.owner}/sources?unknown=1`)).status).toBe(422);
      expect((await f.app.request(`${f.owner}/sources?offset=0&offset=1`)).status).toBe(422);
      expect((await f.app.request(`${f.owner}/sources?limit=101`)).status).toBe(422);
      expect((await f.app.request(`${f.owner}/sources?offset=-1`)).status).toBe(422);
      const first = await f.app.request(`${f.owner}/sources?limit=1`);
      expect(first.status).toBe(200);
      const after = f.business.db
        .query(
          "SELECT (SELECT count(*) FROM memory_policies) AS policies,(SELECT count(*) FROM conversations) AS conversations,(SELECT count(*) FROM memory_jobs) AS jobs",
        )
        .get();
      expect(after).toEqual(before);
      f.business.db
        .query("UPDATE memory_entries SET body=? WHERE id=?")
        .run("x".repeat(64001), f.id);
      expect((await f.app.request(`${f.owner}/sources`)).status).toBe(409);
    } finally {
      f.business.close();
    }
  });

  it("resolves one requested source target with a constant number of relation statements as source sets grow", () => {
    const f = fixture();
    try {
      const traced: string[] = [],
        query = f.business.db.query;
      for (let index = 0; index < 32; index++) {
        const request = `scale-${index}`;
        const p = prepareTurn(f.business.orm, f.source.id, `unrelated ${index}`, request);
        saveCompletedAssistantMessage(
          f.business.orm,
          f.source.id,
          "reply",
          request,
          p.generationToken!,
        );
        const turn = getTurnByRequest(f.business.orm, f.source.id, request)!;
        const pair = f.business.orm
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.turnId, turn.id))
          .all();
        const u = pair.find((m) => m.role === "user")!,
          a = pair.find((m) => m.role === "assistant")!;
        f.business.orm
          .insert(schema.memorySources)
          .values({
            memoryId: f.id,
            turnId: turn.id,
            userMessageId: u.id,
            assistantMessageId: a.id,
            sequenceNo: u.sequenceNo,
          })
          .run();
      }
      f.business.db.query = ((sql: string) => {
        traced.push(sql);
        return Reflect.apply(query, f.business.db, [sql]);
      }) as typeof query;
      try {
        const page = memoryPreviewTargets(f.business.orm, f.entry, { offset: 32, limit: 1 });
        expect(page.total).toBe(66);
        expect(page.targets).toHaveLength(1);
        expect(traced).toHaveLength(3);
        expect(traced.every((sql) => !/\b(?:content|body)\b/.test(sql))).toBe(true);
      } finally {
        f.business.db.query = query;
      }
    } finally {
      f.business.close();
    }
  });

  it.each([1, 32, 400])(
    "batches actual raw body inspection for %i selected targets without per-target queries",
    async (count) => {
      const f = fixture();
      try {
        const { inspectConversationSourcePages } = await import(
          "../../src/server/agent/conversation-access"
        );
        const targets = Array.from({ length: count }, () => ({
          conversationId: f.sourceConversation.id,
          kind: "web_message" as const,
          id: f.user.id,
          turnId: f.turn.id,
          role: "user" as const,
        }));
        const traced: string[] = [],
          query = f.business.db.query;
        f.business.db.query = ((sql: string) => {
          traced.push(sql);
          return Reflect.apply(query, f.business.db, [sql]);
        }) as typeof query;
        try {
          const pages = inspectConversationSourcePages(
            f.business.db,
            f.journal,
            { userId: U },
            targets,
            {
              includeShared: true,
              now: nowIso(),
              signal: new AbortController().signal,
              offset: 0,
              limit: 1,
            },
          );
          expect(pages).toHaveLength(count);
          expect(pages.every((page) => page.state === "available" && page.text === "R")).toBe(true);
          expect(traced).toHaveLength(6);
          expect(traced.filter((sql) => sql.includes("m.content"))).toHaveLength(2);
        } finally {
          f.business.db.query = query;
        }
      } finally {
        f.business.close();
      }
    },
  );

  it("keeps mixed raw inspection order, duplicate targets and real cancellation at the selected batch boundary", async () => {
    const f = fixture();
    try {
      const { inspectConversationSourcePages } = await import(
        "../../src/server/agent/conversation-access"
      );
      const { targets, textById } = addDistinctInspectionSources(f, 3, "qq");
      f.business.db
        .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
        .run("2000-01-01T00:00:00.000Z", targets[1]!.id);
      const selected = [targets[1]!, targets[2]!, targets[0]!, targets[2]!];
      const secondText = textById.get(targets[2]!.id);
      const firstText = textById.get(targets[0]!.id);
      if (secondText === undefined || firstText === undefined) {
        throw new Error("Missing inspection source text in fixture");
      }
      const options = {
        includeShared: true,
        now: nowIso(),
        signal: new AbortController().signal,
        offset: 0,
        limit: 4096,
      };
      const trace = traceSourceReads(f.business.db);
      f.business.db.exec("PRAGMA query_only=ON");
      try {
        const pages = inspectConversationSourcePages(
          f.business.db,
          f.journal,
          { userId: U },
          selected,
          options,
        );
        expect(pages.map((page) => page.state)).toEqual([
          "unavailable",
          "available",
          "available",
          "available",
        ]);
        expect(pages[0]).toEqual({ state: "unavailable", reason: "expired" });
        expect(
          pages.slice(1).map((page) => (page.state === "available" ? page.text : null)),
        ).toEqual([secondText, firstText, secondText]);
        const metadata = trace.reads.filter((read) =>
          read.sql.includes("NULL AS text,NULL AS status,t.expires_at"),
        );
        const payload = trace.reads.filter((read) => read.sql.includes("t.body"));
        expect(metadata).toHaveLength(2);
        expect(payload).toHaveLength(2);
        expect(metadata.map((read) => read.rows.map((row) => row.text))).toEqual([
          [null, null, null, null],
          [null, null, null, null],
        ]);
        for (const read of payload) {
          expect(
            JSON.parse(String(read.args[1])).map((row: { ordinal: number }) => Number(row.ordinal)),
          ).toEqual([1, 2, 3]);
          expect(read.rows.map((row) => row.text)).toEqual([
            textById.get(targets[2]!.id),
            textById.get(targets[0]!.id),
            textById.get(targets[2]!.id),
          ]);
        }
        const cancelled = new AbortController();
        cancelled.abort(new Error("selected inspection cancelled"));
        trace.reads.length = 0;
        expect(() =>
          inspectConversationSourcePages(f.business.db, f.journal, { userId: U }, selected, {
            ...options,
            signal: cancelled.signal,
          }),
        ).toThrow("selected inspection cancelled");
        expect(trace.reads).toHaveLength(0);
      } finally {
        f.business.db.exec("PRAGMA query_only=OFF");
        trace.restore();
      }
      const controller = new AbortController();
      const query = f.business.db.query;
      let payloadReads = 0;
      f.business.db.query = ((sql: string) => {
        const statement = Reflect.apply(query, f.business.db, [sql]);
        return new Proxy(statement, {
          get(target, key) {
            const method = Reflect.get(target, key, target);
            if (key === "all")
              return (...args: unknown[]) => {
                const result = Reflect.apply(method, target, args);
                if (sql.includes("t.body")) {
                  payloadReads++;
                  controller.abort(new Error("cancel after first body batch"));
                }
                return result;
              };
            return typeof method === "function" ? method.bind(target) : method;
          },
        });
      }) as typeof query;
      try {
        expect(() =>
          inspectConversationSourcePages(f.business.db, f.journal, { userId: U }, selected, {
            ...options,
            signal: controller.signal,
          }),
        ).toThrow("cancel after first body batch");
        expect(payloadReads).toBe(1);
      } finally {
        f.business.db.query = query;
      }
    } finally {
      f.business.close();
    }
  });

  it("retains ordinary canonical QQ derived reads and refs after only raw/fact retention, while preview and tampered/closed authority deny", async () => {
    const f = fixture();
    try {
      const now = nowIso(),
        binding = crypto.randomUUID(),
        scheme = crypto.randomUUID();
      f.business.orm
        .insert(schema.qqSchemes)
        .values({ id: scheme, name: "ordinary", createdAt: now, updatedAt: now })
        .run();
      f.business.orm
        .insert(schema.qqBindings)
        .values({
          id: binding,
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: A,
          schemeId: scheme,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const conversation = f.journal.ensureOneBot(binding)!;
      const observed = normalizeOneBotMessage(
        {
          time: Math.floor(Date.now() / 1000),
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: 999,
          user_id: 20002,
          group_id: 30003,
          sender: { nickname: "member" },
          message: [{ type: "text", data: { text: "EXPIRES_RAW_NOT_DERIVED" } }],
        },
        "90001",
      );
      if (observed.kind !== "message") throw new Error("no observation");
      recordObservation(f.business.orm, observed.observation, A);
      f.journal.ingestOneBotEvent(observed.observation.eventKey, binding);
      const key = qqMemoryScopeKey({
        kind: "qq",
        accountId: "90001",
        conversationKind: "group",
        peerId: "30003",
        agentId: A,
      });
      f.business.db.query("DELETE FROM memory_sources WHERE memory_id=?").run(f.id);
      f.business.db
        .query("UPDATE memory_entries SET scope_key=?,body=? WHERE id=?")
        .run(key, "RETAINED_DERIVED", f.id);
      f.business.orm
        .insert(schema.qqMemorySources)
        .values({
          memoryId: f.id,
          eventKey: observed.observation.eventKey,
          scopeKey: key,
          conversationKey: qqConversationKey({
            accountId: "90001",
            kind: "group",
            peerId: "30003",
          }),
          messageId: observed.observation.messageId,
          occurredAtSeconds: observed.observation.occurredAtSeconds,
          speakerKind: observed.observation.speaker.kind,
          speakerId: observed.observation.speaker.id,
        })
        .run();
      const owner = { kind: "conversation", id: conversation.id, userId: U, agentId: A };
      const module = new SqliteMemoryModule({
        orm: f.business.orm,
        runtime: () => runtimeFromAgent(getAgentRowById(f.business.orm, A)),
      });
      const input = {
        agentId: A,
        conversationId: conversation.id,
        scopes: null,
        query: "",
        budget: 65536,
        owner,
      };
      const queried = await module.query(input);
      const evidence = queried.items.find((item) => item.id === f.id);
      if (!evidence) throw new Error("ordinary derived missing before retention");
      expect((await module.read({ ...input, evidence, offset: 0, limit: 4096 })).text).toBe(
        "RETAINED_DERIVED",
      );
      const beforeRaw = MemorySourcePreviewListSchema.parse(
        await (await f.app.request(`${f.owner}/sources`)).json(),
      );
      expect(beforeRaw.raw_preview).toBe("available");
      f.business.db
        .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
        .run("2000-01-01T00:00:00.000Z", observed.observation.eventKey);
      f.business.db
        .query("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?")
        .run("2000-01-01T00:00:00.000Z", observed.observation.eventKey);
      const after = await module.query(input);
      expect(after.items.map((item) => item.id)).toContain(f.id);
      expect((await module.read({ ...input, evidence, offset: 0, limit: 4096 })).text).toBe(
        "RETAINED_DERIVED",
      );
      expect(
        sourceAccess(f.business.db, evidence.sources[0]!, owner, { userId: U }, nowIso()),
      ).toBe("available");
      const derivedHttp = await f.app.request(`${f.owner}/read?conversation_id=${conversation.id}`);
      expect(MemoryReadablePageSchema.parse(await derivedHttp.json()).text).toBe(
        "RETAINED_DERIVED",
      );
      const rawExpired = MemorySourcePreviewListSchema.parse(
        await (await f.app.request(`${f.owner}/sources`)).json(),
      );
      expect(rawExpired.raw_preview).toBe("unavailable");
      f.business.db
        .query("DELETE FROM qq_observation_text WHERE event_key=?")
        .run(observed.observation.eventKey);
      expect((await module.read({ ...input, evidence, offset: 0, limit: 4096 })).text).toBe(
        "RETAINED_DERIVED",
      );
      expect((await f.publish([f.B], 1)).status).toBe(409);
      f.business.db
        .query("UPDATE qq_events SET speaker_id=? WHERE event_key=?")
        .run("tampered", observed.observation.eventKey);
      expect(
        sourceAccess(f.business.db, evidence.sources[0]!, owner, { userId: U }, nowIso()),
      ).toBe("revoked");
      f.business.db
        .query("UPDATE qq_events SET speaker_id=? WHERE event_key=?")
        .run(observed.observation.speaker.id, observed.observation.eventKey);
      f.business.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(nowIso(), conversation.id);
      expect(
        sourceAccess(f.business.db, evidence.sources[0]!, owner, { userId: U }, nowIso()),
      ).toBe("revoked");
      const reopened = f.journal.ensureOneBot(binding)!;
      expect(reopened.id).not.toBe(conversation.id);
      expect(
        sourceAccess(f.business.db, evidence.sources[0]!, owner, { userId: U }, nowIso()),
      ).toBe("revoked");
    } finally {
      f.business.close();
    }
  });

  it("resolves an explicitly selected QQ history root to the unique current canonical before management list diagnostics", async () => {
    const f = fixture();
    try {
      const { qqConversation } = addDistinctInspectionSources(f, 1, "qq");
      const root = qqConversation!;
      f.business.db.query("UPDATE conversations SET closed_at=? WHERE id=?").run(nowIso(), root.id);
      const active = f.journal.ensureOneBot(root.sourceId)!;
      expect(active.id).not.toBe(root.id);
      const directory = (await (
        await f.app.request("/v2/conversations?channel=onebot11")
      ).json()) as { items: Array<{ id: string; agentId: string }> };
      expect(directory.items.some((row) => row.id === root.id && row.agentId === A)).toBe(true);
      const resolved = (await (
        await f.app.request(`/v2/conversations/${root.id}/memory-read-mode`)
      ).json()) as {
        conversation_id: string;
        mode: string;
        revision: number;
      };
      expect(resolved.conversation_id).toBe(active.id);
      expect(
        (await f.app.request(`/agents/${A}/memory/entries?conversation_id=${root.id}`)).status,
      ).toBe(409);
      expect(
        (
          await f.app.request(
            `/agents/${A}/memory/entries?conversation_id=${resolved.conversation_id}&origin_conversation_id=${root.id}`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await f.app.request(
            `/agents/${f.B}/memory/entries?conversation_id=${resolved.conversation_id}`,
          )
        ).status,
      ).toBe(409);
      f.business.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(nowIso(), active.id);
      expect((await f.app.request(`/v2/conversations/${root.id}/memory-read-mode`)).status).toBe(
        404,
      );
    } finally {
      f.business.close();
    }
  });

  it.each(
    [1, 32, 400].flatMap((count) =>
      (["web", "qq", "mixed"] as const).map((channel) => ({ count, channel })),
    ),
  )(
    "inspects $count distinct $channel source targets in real page-sized batches with exact bodies and no foreign-history reads",
    async ({ count, channel }) => {
      const f = fixture();
      try {
        const { inspectConversationSourcePages } = await import(
          "../../src/server/agent/conversation-access"
        );
        const { targets, textById } = addDistinctInspectionSources(f, count, channel);
        expect(new Set(targets.map((target) => target.id)).size).toBe(count);
        expect(textById.size).toBe(count);
        const factStatements: Array<{ sql: string; rows: number }> = [];
        const originalQuery = f.business.db.query;
        f.business.db.query = ((sql: string) => {
          const statement = Reflect.apply(originalQuery, f.business.db, [sql]);
          return new Proxy(statement, {
            get(target, key) {
              const method = Reflect.get(target, key, target);
              if (key === "all")
                return (...args: unknown[]) => {
                  const rows = Reflect.apply(method, target, args) as unknown[];
                  factStatements.push({ sql, rows: rows.length });
                  return rows;
                };
              return typeof method === "function" ? method.bind(target) : method;
            },
          });
        }) as typeof originalQuery;
        let facts: ReturnType<typeof memorySourceFactAssessment>;
        try {
          facts = memorySourceFactAssessment(f.business.orm, [f.entry]);
        } finally {
          f.business.db.query = originalQuery;
        }
        expect(facts.states.get(f.id)).toBe("valid");
        const expectedWeb = targets.filter((target) => target.kind === "web_message").length;
        const expectedQq = count - expectedWeb;
        expect(facts.webSources.get(f.id)).toHaveLength(expectedWeb + 1);
        expect(facts.observationSources.get(f.id) ?? []).toHaveLength(expectedQq);
        expect(factStatements).toHaveLength(2);
        expect(factStatements.reduce((sum, item) => sum + item.rows, 0)).toBe(count + 1);
        expect(factStatements.every((item) => !/\b(?:content|body)\b/.test(item.sql))).toBe(true);
        const targetPage = memoryPreviewTargets(f.business.orm, f.entry, { offset: 0, limit: 100 });
        expect(targetPage.total).toBe(2 + expectedWeb * 2 + expectedQq);
        expect(targetPage.targets.length).toBe(Math.min(100, targetPage.total));
        expect(
          targetPage.targets.every((target) => target.valid && target.conversationId !== null),
        ).toBe(true);
        const foreignPrepared = prepareTurn(
          f.business.orm,
          f.source.id,
          "UNSELECTED_BODY",
          "unselected",
        );
        saveCompletedAssistantMessage(
          f.business.orm,
          f.source.id,
          "unselected-reply",
          "unselected",
          foreignPrepared.generationToken!,
        );
        const trace: Array<{ sql: string; args: unknown[]; rows: number }> = [];
        const query = f.business.db.query;
        f.business.db.query = ((sql: string) => {
          const statement = Reflect.apply(query, f.business.db, [sql]);
          return new Proxy(statement, {
            get(target, key) {
              const method = Reflect.get(target, key, target);
              if (key === "all")
                return (...args: unknown[]) => {
                  const result = Reflect.apply(method, target, args) as unknown[];
                  trace.push({ sql, args, rows: result.length });
                  return result;
                };
              return typeof method === "function" ? method.bind(target) : method;
            },
          });
        }) as typeof query;
        const readIds: string[] = [];
        try {
          for (let offset = 0; offset < targets.length; offset += 100) {
            const selected = targets.slice(offset, offset + 100);
            const start = trace.length;
            const pages = inspectConversationSourcePages(
              f.business.db,
              f.journal,
              { userId: U },
              selected,
              {
                includeShared: true,
                now: nowIso(),
                signal: new AbortController().signal,
                offset: 0,
                limit: 4096,
              },
            );
            expect(pages).toHaveLength(selected.length);
            for (const [index, page] of pages.entries()) {
              expect(page.state).toBe("available");
              if (page.state !== "available") throw new Error("distinct source unavailable");
              const expectedText = textById.get(selected[index]!.id);
              if (expectedText === undefined)
                throw new Error("missing distinct source expectation");
              expect(page.text).toBe(expectedText);
              expect(page.text).not.toContain("UNSELECTED_BODY");
              readIds.push(selected[index]!.id);
            }
            const statements = trace.slice(start);
            const kinds = new Set(selected.map((target) => target.kind));
            // Each revalidation reads one Web batch and QQ metadata + active payload batches.
            expect(statements).toHaveLength(
              4 + kinds.size * 2 + (kinds.has("qq_observation") ? 2 : 0),
            );
            const qqMetadata = statements.filter((item) =>
              item.sql.includes("NULL AS text,NULL AS status,t.expires_at"),
            );
            expect(qqMetadata).toHaveLength(kinds.has("qq_observation") ? 2 : 0);
            expect(qqMetadata.reduce((sum, item) => sum + item.rows, 0)).toBe(
              selected.filter((target) => target.kind === "qq_observation").length * 2,
            );
            const bodyReads = statements.filter(
              (item) => item.sql.includes("m.content") || item.sql.includes("t.body"),
            );
            expect(bodyReads.reduce((sum, item) => sum + item.rows, 0)).toBe(selected.length * 2);
            for (const item of bodyReads) {
              const requested = JSON.parse(String(item.args[1])) as Array<{
                id: string;
                conversationId: string;
              }>;
              expect(
                requested.every((value) =>
                  selected.some(
                    (target) =>
                      target.id === value.id && target.conversationId === value.conversationId,
                  ),
                ),
              ).toBe(true);
            }
          }
        } finally {
          f.business.db.query = query;
        }
        expect(new Set(readIds).size).toBe(count);
        const first = targets[0]!;
        const denied = inspectConversationSourcePages(
          f.business.db,
          f.journal,
          { userId: "foreign-user" },
          [first],
          {
            includeShared: true,
            now: nowIso(),
            signal: new AbortController().signal,
            offset: 0,
            limit: 4096,
          },
        );
        expect(denied).toEqual([{ state: "unavailable", reason: "forbidden" }]);
      } finally {
        f.business.close();
      }
    },
  );
});
