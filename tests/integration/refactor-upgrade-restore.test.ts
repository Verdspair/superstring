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
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
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
const oldFactoryStickerPrompt =
  "你只做一件事：从给定候选里挑一张最贴合当前语境的图。\n" +
  "只输出候选编号；没有贴合的就不选，不要勉强凑一张。\n" +
  "不选与话题无关的图，也不选刚发过的那张。";
const newFactoryStickerPrompt =
  "按当前语境自主选择文字、表情或两者组合；没有合适内容时可以不回复。\n" +
  "需要表情时，先用 sticker.search 查看候选，再用 reply.sticker 选择本次已披露的素材 ID；每个目标至多一张。只发文字时使用 reply.text，不必另行声明不用表情。\n" +
  "不要为了装饰勉强加图，不选无关或刚发过的素材。";

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
    ensureDefaults(handle.orm, "fixture");
    const session = { id: crypto.randomUUID() };
    const turnId = crypto.randomUUID();
    const sourceAt = nowIso();
    const sessionConfig = {
      agent_id: DEFAULT_AGENT_ID,
      name: "历史助手",
      system_prompt: "私人提示词哨兵：仅供合成升级测试",
      additional_instructions: "保留历史附加指令",
      model_name: "fixture-model",
      temperature: 0.7,
      memory_consolidation_model_name: "fixture-organizer",
      memory_consolidation_prompt: "整理历史记忆",
      memory_consolidation_additional_instructions: "私人整理指令哨兵",
      memory_retrieval_model_name: "fixture-retriever",
      memory_retrieval_prompt: "检索历史记忆",
      context_compression_model_name: "fixture-compressor",
      p5_config: { context_window: 16384, max_output_tokens: 2048, recent_turns: 7 },
      resolved_model_capacities: { "fixture-model": 16384 },
      mode: "chat",
      config_version: 1,
      persona_intensity: 60,
    };
    const sessionSnapshot = JSON.stringify(sessionConfig);
    const turnSnapshot = JSON.stringify({
      ...sessionConfig,
      additional_instructions: "本轮私人指令哨兵",
      p5_config: { context_window: 32768, max_output_tokens: 4096, recent_turns: 9 },
      resolved_model_capacities: { "fixture-model": 32768, "fixture-compressor": 16384 },
    });
    // The frozen v38 source schema predates canonical conversations (0040).
    // Seed that exact source shape instead of invoking today's source producer.
    oldDb
      .query(`INSERT INTO sessions(id,user_id,agent_id,title,client_request_id,
      agent_config_snapshot,next_sequence_no,created_at,updated_at)
      VALUES(?,?,?,'升级保留样例','upgrade-session',?,3,?,?)`)
      .run(session.id, DEFAULT_USER_ID, DEFAULT_AGENT_ID, sessionSnapshot, sourceAt, sourceAt);
    oldDb
      .query(`INSERT INTO turns(id,session_id,client_request_id,runtime_config_snapshot,
      context_valid,source_valid,generation_status,created_at)
      VALUES(?,?,'stable-request',?,1,1,'completed',?)`)
      .run(turnId, session.id, turnSnapshot, sourceAt);
    const message = oldDb.query(`INSERT INTO messages(id,session_id,turn_id,sequence_no,role,
      content,status,client_request_id,created_at,completed_at) VALUES(?,?,?,?,?,?,'completed','stable-request',?,?)`);
    message.run(
      crypto.randomUUID(),
      session.id,
      turnId,
      1,
      "user",
      "完整原始提问",
      sourceAt,
      sourceAt,
    );
    message.run(
      crypto.randomUUID(),
      session.id,
      turnId,
      2,
      "assistant",
      "完整原始回答",
      sourceAt,
      sourceAt,
    );
    // Seed the v38 shape directly; today's repository writes columns added after v38.
    const documentId = crypto.randomUUID();
    const documentAt = nowIso();
    oldDb
      .query(
        "INSERT INTO knowledge_documents (id, category_id, name, original_text, import_type, revision, created_at, updated_at) VALUES (?, 'default', ?, ?, 'text', 2, ?, ?)",
      )
      .run(documentId, "原文与授权", "第一行\n第二行：不能截断。", documentAt, documentAt);
    oldDb
      .query(
        "INSERT INTO knowledge_grants (document_id, agent_id, token, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(documentId, DEFAULT_AGENT_ID, crypto.randomUUID(), documentAt);
    oldDb
      .query(
        "INSERT INTO knowledge_jobs (id, document_id, content_version, settings_revision, created_at) VALUES (?, ?, 1, 1, ?)",
      )
      .run(crypto.randomUUID(), documentId, documentAt);
    // Seed v38 settings directly; the current account guard requires later schema tables.
    oldDb
      .query(
        "UPDATE qq_settings SET account_id=?,enabled=1,revision=revision+1 WHERE id=1 AND revision=1",
      )
      .run("10001");
    // 方案行用裸 SQL 写：这是 v38 的库，ORM 模型带的是**当前**列（0046 起还有压缩与装配三栏），
    // 拿现在的模型去写旧库正是这个升级用例要避免的事。
    const schemeId = crypto.randomUUID();
    const schemeCreatedAt = nowIso();
    oldDb
      .query(
        "INSERT INTO qq_schemes (id,name,revision,created_at,updated_at,trigger_direct_reply,trigger_follow_up,trigger_chiming_in,trigger_idle_topic) VALUES (?,?,1,?,?,1,1,1,1)",
      )
      .run(schemeId, "所有触发保留", schemeCreatedAt, schemeCreatedAt);
    const scheme = { id: schemeId };
    const bindingId = crypto.randomUUID();
    const now = nowIso();
    const seconds = Math.floor(Date.now() / 1000);
    // 绑定行同样用裸 SQL 写：现在的 ORM 绑定模型带 0059 的三个限额列，而这是 v38 的库。
    // 只写 v38 就存在的 12 列，其余列留给它们当时的 DDL 默认值（真实旧库行形状）。
    oldDb
      .query(
        "INSERT INTO qq_bindings (id,account_id,conversation_kind,peer_id,agent_id,scheme_id,paused,share_web_memory,revision,authority_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,0,0,1,1,?,?)",
      )
      .run(bindingId, "10001", "private", "20002", DEFAULT_AGENT_ID, scheme.id, now, now);
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
    // This is a v38 database: it has no retention_days column (0050 adds it), so reading the
    // stored window is not available here. Pass the old version's constant explicitly — the
    // window that version would have stamped — instead of asking the new schema's setting.
    recordQqSend(
      handle.orm,
      {
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
      },
      14,
    );

    if (initiallyBoundToB) {
      // A has retained history, but B is the only live binding when this old DB is upgraded.
      oldDb
        .query(
          `INSERT INTO agents SELECT 'agent-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?`,
        )
        .run(DEFAULT_AGENT_ID);
      oldDb.query("UPDATE qq_bindings SET agent_id='agent-b' WHERE id=?").run(bindingId);
    }

    expect(
      oldDb.query("SELECT agent_config_snapshot FROM sessions WHERE id=?").get(session.id),
    ).toEqual({
      agent_config_snapshot: sessionSnapshot,
    });
    expect(oldDb.query("SELECT runtime_config_snapshot FROM turns WHERE id=?").get(turnId)).toEqual(
      {
        runtime_config_snapshot: turnSnapshot,
      },
    );
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
        originalRows: fixtureDb
          .query(sql)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
        rows: fixtureDb
          .query(sql)
          .all()
          .map((row) => {
            const legacy = row as Record<string, unknown>;
            if (name === "qq_schemes" && legacy.prompt_sticker === oldFactoryStickerPrompt) {
              return JSON.stringify({ ...legacy, prompt_sticker: newFactoryStickerPrompt });
            }
            return JSON.stringify(row);
          })
          .sort(),
      };
    });
    oldDb.close();
    oldDb = undefined;
    copyFileSync(original, backup);
    const backupDb = new Database(backup, { readonly: true });
    try {
      for (const table of baseline)
        expect({
          table: table.name,
          rows: backupDb
            .query(table.sql)
            .all()
            .map((row) => JSON.stringify(row))
            .sort(),
        }).toEqual({ table: table.name, rows: table.originalRows });
    } finally {
      backupDb.close();
    }
    copyFileSync(backup, upgraded);
    const beforeHash = digest(backup);
    next = openBusinessDb({ path: upgraded });
    expect(next.db.query("PRAGMA user_version").get()).toEqual({
      user_version: BUSINESS_SCHEMA_VERSION,
    });
    expect(next.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      next.db.query("SELECT visibility FROM knowledge_documents WHERE id=?").get(documentId),
    ).toEqual({ visibility: null });
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
      for (const table of baseline)
        expect({
          table: table.name,
          rows: restoredDb
            .query(table.sql)
            .all()
            .map((row) => JSON.stringify(row))
            .sort(),
        }).toEqual({ table: table.name, rows: table.originalRows });
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
