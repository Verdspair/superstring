import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { projectConversationEvent } from "../../src/server/conversation/conversation-view";
import { toOrmHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import {
  BUSINESS_MIGRATION_FILES,
  BUSINESS_SCHEMA_VERSION,
  openBusinessDb,
} from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";

/** Windows can hold the SQLite -wal/-shm files for a moment after close(); retry briefly. */
function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(25);
    }
  }
}

const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

function verifyUpgrade(initiallyBoundToB: boolean) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "superstring-refactor-restore-"));
  const original = path.join(dir, "v38.sqlite");
  const backup = path.join(dir, "backup.sqlite");
  const upgraded = path.join(dir, "upgraded.sqlite");
  const restored = path.join(dir, "restored.sqlite");
  let oldDb: Database | undefined;
  let next: ReturnType<typeof openBusinessDb> | undefined;
  try {
    oldDb = new Database(original);
    oldDb.exec("PRAGMA foreign_keys=ON");
    for (const file of BUSINESS_MIGRATION_FILES.slice(0, 38)) {
      oldDb.exec(
        readFileSync(path.join(import.meta.dir, "../../migrations/versions", file), "utf8"),
      );
    }
    oldDb.exec("PRAGMA user_version=38");
    const handle = toOrmHandle(oldDb);
    const session = createSession(handle.orm, "升级保留样例", { modelName: "fixture" });
    const prepared = prepareTurn(handle.orm, session.id, "完整原始提问", "stable-request");
    if (!prepared.generationToken) throw new Error("Missing fixture generation lease");
    saveCompletedAssistantMessage(
      handle.orm,
      session.id,
      "完整原始回答",
      "stable-request",
      prepared.generationToken,
    );
    const knowledge = new KnowledgeRepository(oldDb);
    const document = knowledge.importDocument({
      category_id: "default",
      name: "原文与授权",
      original_text: "第一行\n第二行：不能截断。",
    });
    knowledge.replaceGrants(document.id, document.revision, [DEFAULT_AGENT_ID]);
    updateQqSettings(handle.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
    const scheme = createQqScheme(handle.orm, {
      name: "所有触发保留",
      triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: true },
    });
    const bindingId = crypto.randomUUID();
    const now = nowIso();
    const seconds = Math.floor(Date.now() / 1000);
    handle.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingId,
        accountId: "10001",
        conversationKind: "private",
        peerId: "20002",
        agentId: DEFAULT_AGENT_ID,
        schemeId: scheme.id,
        paused: 0,
        shareWebMemory: 0,
        revision: 1,
        authorityRevision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    handle.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: "fixed-inbound",
        accountId: "10001",
        conversationKind: "private",
        peerId: "20002",
        agentId: DEFAULT_AGENT_ID,
        messageId: "platform-inbound",
        occurredAtSeconds: seconds,
        speakerKind: "member",
        speakerId: "20002",
        addressed: 1,
        recordedAt: now,
      })
      .run();
    oldDb
      .query(
        "INSERT INTO qq_observation_text(event_key,body,occurred_at_seconds,expires_at,recorded_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "fixed-inbound",
        "私聊原文",
        seconds,
        new Date(Date.now() + 14 * 86400_000).toISOString(),
        now,
      );
    recordQqSend(handle.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "private",
        peerId: "20002",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "platform-confirmed" }],
      text: "已确认回复",
      sentAtSeconds: seconds,
    });

    if (initiallyBoundToB) {
      // A has retained history, but B is the only live binding when this old DB is upgraded.
      oldDb
        .query(
          `INSERT INTO agents SELECT 'agent-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?`,
        )
        .run(DEFAULT_AGENT_ID);
      oldDb.query("UPDATE qq_bindings SET agent_id='agent-b' WHERE id=?").run(bindingId);
    }

    // Select only baseline columns when comparing: new columns are additive, not lost facts.
    const fixtureDb = oldDb;
    const baseline = (
      oldDb
        .query(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map(({ name }) => {
      const columns = (
        fixtureDb.query(`PRAGMA table_info(${quoted(name)})`).all() as { name: string }[]
      ).map((r) => r.name);
      const sql = `SELECT ${columns.map(quoted).join(",")} FROM ${quoted(name)}`;
      return {
        name,
        sql,
        rows: fixtureDb
          .query(sql)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      };
    });
    oldDb.close();
    oldDb = undefined;
    copyFileSync(original, backup);
    copyFileSync(backup, upgraded);
    const beforeHash = digest(backup);
    next = openBusinessDb({ path: upgraded });
    expect(next.db.query("PRAGMA user_version").get()).toEqual({
      user_version: BUSINESS_SCHEMA_VERSION,
    });
    expect(next.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const table of baseline)
      expect({
        table: table.name,
        rows: next.db
          .query(table.sql)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      }).toEqual({ table: table.name, rows: table.rows });
    const journal = new ConversationEventRepository(next.db);
    journal.backfill();
    const conversation = journal.ensureWeb(session.id);
    if (!conversation) throw new Error("Missing migrated conversation");
    expect(journal.eventsAfter(conversation.id).items.map((e) => e.kind)).toEqual([
      "inbound",
      "outbound",
    ]);
    const first = next.db
      .query("SELECT * FROM conversation_events ORDER BY conversation_id,seq")
      .all();
    journal.backfill();
    expect(
      next.db.query("SELECT * FROM conversation_events ORDER BY conversation_id,seq").all(),
    ).toEqual(first);
    expect(next.db.query("SELECT count(*) AS n FROM agent_runs").get()).toEqual({ n: 0 });
    // The migration-created history survives assistant rebinding without migrating
    // those imported sources into a new activation's execution journal.
    if (initiallyBoundToB) {
      const installed = journal.ensureOneBot(bindingId)!;
      expect(installed.agentId).toBe("agent-b");
      expect(journal.historyAfter(installed.id).items).toEqual([]);
      next.db
        .query("UPDATE qq_bindings SET agent_id=? WHERE id=?")
        .run(DEFAULT_AGENT_ID, bindingId);
    }
    const originalBot = journal.ensureOneBot(bindingId)!;
    const importedHistory = journal.historyAfter(originalBot.id);
    expect(importedHistory.items.map(({ event }) => event.kind)).toEqual(["inbound", "outbound"]);
    if (initiallyBoundToB) {
      expect(originalBot.bindingEpoch).toBe(2);
      expect(originalBot.consumedSeq).toBe(importedHistory.nextSeq);
      expect(journal.ingestOneBotEvent("fixed-inbound", bindingId)).toBeNull();
      const adapter = new OneBot11Adapter({
        orm: next.orm,
        journal,
        wakes: new WakeRepository(next.db),
      });
      adapter.scanImmediate();
      expect(next.db.query("SELECT count(*) AS n FROM wake_signals").get()).toEqual({ n: 0 });
    }
    next.db
      .query(
        `INSERT INTO agents SELECT 'agent-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=? AND NOT EXISTS(SELECT 1 FROM agents WHERE id='agent-b')`,
      )
      .run(DEFAULT_AGENT_ID);
    next.db.query("UPDATE qq_bindings SET agent_id='agent-b' WHERE id=?").run(bindingId);
    journal.ensureOneBot(bindingId);
    next.db.query("UPDATE qq_bindings SET agent_id=? WHERE id=?").run(DEFAULT_AGENT_ID, bindingId);
    const rebound = journal.ensureOneBot(bindingId)!;
    journal.backfill();
    journal.backfill();
    expect(journal.historySummary(rebound.id)?.id).toBe(originalBot.id);
    expect(journal.historyAfter(rebound.id)).toEqual(importedHistory);
    expect(journal.eventsAfter(rebound.id).items).toEqual([]);
    next.db
      .query(
        "UPDATE qq_observation_text SET expires_at='2000-01-01T00:00:00.000Z' WHERE event_key='fixed-inbound'",
      )
      .run();
    const expired = journal.historyAfter(rebound.id).items[0]!;
    expect(projectConversationEvent(next.db, expired.event)).toMatchObject({
      text: null,
      contentState: "expired",
    });
    expect(journal.historyAfter(rebound.id).nextSeq).toBe(importedHistory.nextSeq);
    expect(next.db.query("SELECT count(*) AS n FROM wake_signals").get()).toEqual({ n: 0 });
    next.close();
    next = undefined;
    copyFileSync(backup, restored);
    expect(digest(backup)).toBe(beforeHash);
    expect(digest(restored)).toBe(digest(original));
    const restoredDb = new Database(restored, { readonly: true });
    try {
      expect(restoredDb.query("PRAGMA user_version").get()).toEqual({ user_version: 38 });
    } finally {
      restoredDb.close();
    }
  } finally {
    oldDb?.close();
    next?.close();
    removeTempDir(dir);
  }
}
for (const initiallyBoundToB of [false, true]) {
  it(`v38 history survives upgrade and rebinding (B initially: ${initiallyBoundToB})`, () =>
    verifyUpgrade(initiallyBoundToB));
}
