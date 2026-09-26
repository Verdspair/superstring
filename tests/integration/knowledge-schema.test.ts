import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { businessTables } from "../../src/server/db/schema";
import {
  BUSINESS_SCHEMA_VERSION,
  BUSINESS_TABLE_NAMES,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";

const v1 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql"),
  "utf8",
);
const v2 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0002_knowledge.sql"),
  "utf8",
);
const v3 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0003_knowledge_read.sql"),
  "utf8",
);
const v4 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0004_organization.sql"),
  "utf8",
);
const v5 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0005_qq_transport.sql"),
  "utf8",
);
const v6 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0006_qq_memory_sources.sql"),
  "utf8",
);
const v7 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0007_qq_observation_text.sql"),
  "utf8",
);
const v8 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0008_qq_memory_batch.sql"),
  "utf8",
);
const v9 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0009_qq_transport_config.sql"),
  "utf8",
);
const v10 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0010_qq_schemes.sql"),
  "utf8",
);
const v11 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0011_qq_speech_log.sql"),
  "utf8",
);
const v12 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0012_qq_media_notes.sql"),
  "utf8",
);
const v13 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0013_qq_scheme_triggers.sql"),
  "utf8",
);
const v14 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0014_qq_send_log.sql"),
  "utf8",
);
const v15 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0015_qq_scheme_rhythm.sql"),
  "utf8",
);
const v16 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0016_qq_context_budget.sql"),
  "utf8",
);
const v17 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0017_qq_scheme_prompts.sql"),
  "utf8",
);
const v18 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0018_qq_members.sql"),
  "utf8",
);
const v19 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0019_qq_output_reserve.sql"),
  "utf8",
);
const v20 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0020_qq_scheme_stickers.sql"),
  "utf8",
);
const v21 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0021_qq_stickers.sql"),
  "utf8",
);
const v22 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0022_qq_sticker_authorization.sql"),
  "utf8",
);
const v23 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0023_qq_dispatch.sql"),
  "utf8",
);
const v24 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0024_qq_media_purposes.sql"),
  "utf8",
);
const v25 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0025_desktop_settings.sql"),
  "utf8",
);
const v26 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0026_qq_media_supplement.sql"),
  "utf8",
);
const v27 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0027_qq_event_addressed.sql"),
  "utf8",
);
const v28 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0028_qq_immediate_lease.sql"),
  "utf8",
);
const v29 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0029_qq_module_switches.sql"),
  "utf8",
);
const v30 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0030_qq_sweep_verdicts.sql"),
  "utf8",
);
const v31 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0031_qq_attention.sql"),
  "utf8",
);
const v32 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0032_model_providers.sql"),
  "utf8",
);
const v33 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0033_qq_idle_judgements.sql"),
  "utf8",
);
const v34 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0034_qq_initiative_min_score.sql"),
  "utf8",
);
const v35 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0035_qq_reply_split.sql"),
  "utf8",
);
const v36 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0036_qq_judgement_reuse.sql"),
  "utf8",
);
const v37 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0037_qq_judgement_per_speaker.sql"),
  "utf8",
);
const v38 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0038_qq_judgement_model.sql"),
  "utf8",
);
const v39 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0039_agent_runs.sql"),
  "utf8",
);
const v40 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0040_conversation_wakes.sql"),
  "utf8",
);
const v41 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0041_outbound_intents.sql"),
  "utf8",
);
const v42 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0042_runtime_observability.sql"),
  "utf8",
);
const v43 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0043_protected_model_results.sql"),
  "utf8",
);
const v44 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0044_conversation_avatars.sql"),
  "utf8",
);
const ddl = (db: Database) =>
  db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )
    .all();

// Independent field/type contract. ? means nullable; all other fields are NOT NULL.
const golden: Record<string, string> = {
  organization_settings:
    "id:I model_name:T? revision:I vision_model_name:T? transcription_model_name:T?",
  agent_knowledge_read_settings:
    "agent_id:T enabled:I context_budget:I? scope:T document_ids:T revision:I",
  knowledge_settings: "id:I auto_enabled:I model_name:T? context_budget:I revision:I",
  knowledge_categories: "id:T name:T revision:I",
  knowledge_documents:
    "id:T category_id:T name:T original_text:T import_type:T content_mode:T content_version:I revision:I created_at:T updated_at:T",
  knowledge_grants: "document_id:T agent_id:T token:T created_at:T",
  knowledge_chunks:
    "id:T document_id:T content_version:I ordinal:I start_offset:I end_offset:I body:T",
  knowledge_drafts:
    "id:T document_id:T content_version:I summary:T tags:T body:T sources:T model_name:T created_at:T",
  knowledge_jobs:
    "id:T document_id:T content_version:I settings_revision:I status:T token:T? lease_expires_at:T? error_code:T? created_at:T finished_at:T?",
  turn_knowledge_snapshots: "turn_id:T agent_id:T settings_revision:I items:T created_at:T",
};

function seedParents(db: Database) {
  db.exec(`INSERT INTO users VALUES ('u', 'synthetic', 'now');
    INSERT INTO agents (id, name, system_prompt, description, additional_instructions, p5_config, model_name, memory_consolidation_prompt, memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
    VALUES ('a', 'synthetic', '', '', '', '{}', 'fake', '', '', '', 'now', 'now');
    INSERT INTO sessions (id, user_id, agent_id, title, client_request_id, agent_config_snapshot, created_at, updated_at)
    VALUES ('s', 'u', 'a', 'synthetic', 'r', '{}', 'now', 'now');
    INSERT INTO turns (id, session_id, client_request_id, runtime_config_snapshot, created_at)
    VALUES ('t', 's', 'r', '{}', 'now');
    INSERT INTO memory_entries (id, agent_id, user_id, name, summary, tags, kinds, body, scope, scope_key, config_snapshot, created_at)
    VALUES ('m', 'a', 'u', 'synthetic', '', '[]', '[]', '旧记忆', 'reality_user', 'u', '{}', 'now');`);
}
function document(db: Database, id = "d") {
  db.query(
    "INSERT INTO knowledge_documents (id, category_id, name, original_text, import_type, created_at, updated_at) VALUES (?, 'default', '资料', CAST(? AS TEXT), 'md', 'now', 'now')",
  ).run(id, Buffer.from("\uFEFF# 原文\r\n  中文𠮷\t42.5\n", "utf8"));
}

describe("frozen schema defaults and product initialization", () => {
  // Every migration in order. The fingerprint list below is checked against this one, so a new
  // migration cannot arrive without its DDL being pinned (or its pinned value reviewed).
  const migrations = [
    v1,
    v2,
    v3,
    v4,
    v5,
    v6,
    v7,
    v8,
    v9,
    v10,
    v11,
    v12,
    v13,
    v14,
    v15,
    v16,
    v17,
    v18,
    v19,
    v20,
    v21,
    v22,
    v23,
    v24,
    v25,
    v26,
    v27,
    v28,
    v29,
    v30,
    v31,
    v32,
    v33,
    v34,
    v35,
    v36,
    v37,
    v38,
    v39,
    v40,
    v41,
    v42,
    v43,
    v44,
  ] as const;
  // Independent snapshots: v1 matches published v0.2.0-alpha; v2-v4 are the
  // accepted pre-ADR0016 development schemas; v5 onwards are the additive QQ
  // migrations. Do not regenerate on DDL edits.
  const fingerprints = [
    "74ee87ebedcbf813987cc7ea8685cada577968fee81df056bce11f47a37504cd",
    "4510c41acfd9d1deca2e859ffa9695c1cc959d2f16a71935cbb4320367b7004c",
    "58957fceb3959d7a3e7bab2deffed0f349314d9826f301ce4064e1b17a633de7",
    "0a3f0f3efc537fdb3af5efcd94bdfe3775fb7f8f430fb8f6c71ca906f4756677",
    "8d94b3cf499b8c0f61b7fea7f166473605807a97cae4f769cf0d3c37e7c9fdfa",
    "6c04160def8cc0d21a8e71e67a54af80ec457aac7caf2b70eaab6749c9deb39c",
    "7ede03635ba90f9c4ea03e4f76024ac61db60b929207de4251c1c8f0a4aaa1c1",
    "3e6a48e53ccced79e9be7cce206358bb504e006ff6094296693048c0e8cec79c",
    "b84aaf8f5a2ffe3a92a8180eb966a0fae3c00a8c2dbad98081715b2939103296",
    "71cae28e7abf9f3d1c5dfcb58e36087a690bc42284b0928e491ce66dd52f4116",
    "f335d1a5c861429a4d9b98bb6e21680d7f5a866e5eb769a5fa21da3be1cc40cf",
    "191098bab21a92347456ad2d15dcd3d95b3da22cfbcfdcb51201dd6920e871b4",
    "48531ae3b40dfcb60fb8d76c3b4e30162bc62a495fb05ab69ecdbae82546b802",
    "fe2da8ac129bd03bde2bec1c52f1beb4d9b94dbacf874afc0cf19c2e54c0824e",
    "be1a1ced0da117b613e8cb1b493aae70cd027e6c4962206b8a91019345b2f830",
    "94cbf53b4d9bed457265e98342b64bc5a60c2da27144425e988b78019009eb66",
    "ca3fd70c725e94f5a84d301a392eca80d312330a9127f2f39ec86f4634a4a8d9",
    "60278d456236745932ec1cc40b90c98513091421dd6b179b7768840e4ba29f1e",
    "0389b4ef0575fdf12814dd624fd1e2935775ed65175d9983ec63a85a57d53e84",
    "7079bef25f7382dd8a2f71735b8c87d8845152745aa42ccaa5d6c0254e2455ff",
    "c002e512a3384269ea7a7637e255a2f7d5f085b19abdca097d987f8fc2751537",
    "46135624f2465a979856490fc8c506ca1dcd80d35a5d2836d39494180176435d",
    "2cd4ffeab60a24959d0fb26564c4271ff3f2e275838bd9d416fd2dd10e3b1c33",
    // v24 = P5i (media purposes on the shared row + the sticker tag draft); measured by applying
    // v1—v24 through `ddl()` after v1—v23 reproduced their pinned values byte for byte.
    "2b08c4acaaa3d7342a5aeedc1b8f643965a9bf02c8eb6a37e6dc9759373ba2e1",
    // v25 = P5l (the desktop close preference); measured the same way, after v1—v24 reproduced
    // their pinned values byte for byte.
    "f7ae18f02d08d54b366596c0f92a254bcd9ffc32d1204dd27ca67c81dcb87e94",
    // v26 = P5m (the media supplement window on qq_schemes + the addressed bit on media rows);
    // measured the same way, after v1—v25 reproduced their pinned values byte for byte. Corrected
    // once: the first recorded value was taken before the migration gained its second column, and
    // the loop below stopped one version short, so nothing checked it.
    "9e6ec77d27b9153dd35593d7bad6310120c6beaf30af797a7ea8c56c5d4e9e65",
    // v27 = P5r (whether an observed message was addressed to the assistant — the immediate reply
    // path reads that fact from storage).
    "e6251b6174b9d66c40fbbed53856b856abdfb28fed9c8fb13e37ae9420fb1cf6",
    // v28 = P5s (the global slot can name a holder without a candidate, for 直接回应/连续交谈).
    "b02efdca55a3a5e9110758140a3196bdd758605d0f17c3823c2e5828a1b17bba",
    // v29 = P5t (per-conversation module switches + the scheme's media sampling parameters).
    "76d91b6e7d7a9b69b41e4295f9d118c0f5e5fc4c3bcb028429f29fcdd1236aec",
    // v30 = P5u (one durable quiet-room verdict per conversation, for §11.1's 原因可追踪).
    "aab980ed87a208896408c65dbbb4f2f0d1b7095488947bc1d2fe05769fbb1773",
    // v31 = P6 后续 (「重要的人」: the per-conversation attention mode and its JSON member list).
    "0b271a711cfdfec9ac00b0f11fe105b3ddb0c17f08093e65e1c4d4858722763a",
    // v32 = 外部模型API (the provider table: base URL + sealed key + declared models with windows).
    "e58646ee23fd05e4831fc90a8a79d23face1fb5fffc239c3a715e119a3ba59fb",
    // v33 = the cold-room judgement memory (one row per conversation: which basis was judged).
    "402f0dccd199a87b5f36b9889536785375975a18e61a05cca3ee705fb7eb161e",
    // v34 = 主动开口门槛 (the interest score the judge must reach before she speaks unprompted).
    "1d5ba70c6a57da16177f80bad64a37de18c3d96a0cde2b3ba5c28cc9010aeaf3",
    // v35 = 按发言人分开回答的开关（split_reply_by_speaker）+ 判断默认文案补上打分口径。
    "a90058ba6c2196562663bc7a32123caa330bdddcfb9746232c60fb98a37e4650",
    // v36 = 判断间隔（judgement_interval_turns）+ 最近一次读数表 + 打分口径抬一档。
    "3b3e3bb086c8bdffd4998d287de9cb589e002db79c946dceb1193aaa6a80234f",
    // v37 = 判断读数改成按发言人一行（(conversation_key, speaker_id) 复合主键）。
    "ae49f4124bdabc1dbd9db3ce9c12d0339d7be75069bf0af606d58f6b3d988a4f",
    // v38 = QQ 全局判断模型（`qq_settings.judgement_model_name`）：判断开口兴趣打分用哪一个
    // 模型，NULL＝跟随每间会话绑定助手的对话模型。实测于 v1—v37 逐字节重现原值之后。
    "0b2cfa6295a1f660d2d6f28e42d3327bb95457043cf997a20108531217ab2773",
    // v39–v41: unified Agent runs, conversation journal and outbound intents; pins re-recorded with
    // the follow-up review fixes to migration 0039.
    "ecc3b52a58b85045be4b22df0e2dc0257a142dd5e3953ca7ef70f1701daf46f1",
    "2e9244362629c8beecfc95e44e7f5420243b08741ea818ba06f391b17cc46f0b",
    "2383ad5c56b764249f6d3385ada548faeb0aefa084a7713312860f3b36938454",
    "bdbd6421ba1b091c69a370114c3d92b739a269402bb01195c6bdec307a3ead88",
    // v43: protected model responses and the shared source-redaction cascade.
    "bea5eee844e444bf092ba8ac08d30422504b5186e51d55c3def3b92ae49a10fe",
    // v44: independently stored conversation presentation, no changes to existing tables.
    "ca68e4fec6c0f2e115f969a65915adb1ffd17d138cb59a9a392f0520672bb45d",
  ];
  // The loop is driven BY the fingerprint list, not by a hand-written run of numbers: the two were
  // maintained separately once, the loop stopped one version short, and the newest recorded hash —
  // the only one that had just been written by hand — was the one nothing checked (2026-09-24).
  it("pins one DDL fingerprint for every business migration", () => {
    expect(fingerprints).toHaveLength(migrations.length);
  });
  for (const version of fingerprints.map((_, index) => index + 1)) {
    it(`opens frozen v${version}, preserves old values, and only seeds new library settings`, () => {
      const db = new Database(":memory:");
      try {
        for (const sql of migrations.slice(0, version)) db.exec(sql);
        expect(
          createHash("sha256")
            .update(JSON.stringify(ddl(db)))
            .digest("hex"),
        ).toBe(fingerprints[version - 1]);
        db.exec(`PRAGMA user_version = ${version}`);
        seedParents(db);
        db.exec("INSERT INTO memory_policies (agent_id, user_id) VALUES ('a', 'u')");
        expect(db.query("SELECT target_chars FROM memory_policies").get()).toEqual({
          target_chars: 300,
        });
        ensureBusinessSchema(db);
        expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 44 });
        expect(db.query("SELECT target_chars FROM memory_policies").get()).toEqual({
          target_chars: 300,
        });
        expect(db.query("SELECT context_budget FROM knowledge_settings").get()).toEqual({
          context_budget: version === 1 ? 16384 : 4096,
        });
        db.exec("UPDATE knowledge_settings SET context_budget = 7777, revision = 7");
        ensureBusinessSchema(db);
        expect(db.query("SELECT context_budget, revision FROM knowledge_settings").get()).toEqual({
          context_budget: 7777,
          revision: 7,
        });
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    });
  }
});

describe("knowledge schema v2 migration", () => {
  it("upgrades exact v1 without changing legacy data; fresh and upgraded DDL match", () => {
    const old = new Database(":memory:");
    const fresh = openBusinessDb();
    try {
      old.exec(v1);
      old.exec("PRAGMA user_version = 1");
      seedParents(old);
      const legacy = BUSINESS_TABLE_NAMES.slice(0, 16).map((table) =>
        old.query(`SELECT * FROM ${table}`).all(),
      );
      ensureBusinessSchema(old);
      expect(old.query("PRAGMA user_version").get()).toEqual({ user_version: 44 });
      expect(ddl(old)).toEqual(ddl(fresh.db));
      expect(
        BUSINESS_TABLE_NAMES.slice(0, 16).map((table) => old.query(`SELECT * FROM ${table}`).all()),
      ).toEqual(legacy);
      expect(old.query("PRAGMA foreign_key_check").all()).toEqual([]);
      old.exec(
        "UPDATE knowledge_categories SET name = '用户改名'; UPDATE knowledge_settings SET auto_enabled = 0;",
      );
      ensureBusinessSchema(old);
      expect(old.query("SELECT name FROM knowledge_categories").all()).toEqual([
        { name: "用户改名" },
      ]);
      expect(old.query("SELECT auto_enabled FROM knowledge_settings").get()).toEqual({
        auto_enabled: 0,
      });
    } finally {
      old.close();
      fresh.close();
    }
  });

  it("rolls back all v2 DDL, seeds and version when an upgrade fails on existing data", () => {
    const db = new Database(":memory:");
    try {
      db.exec(v1);
      db.exec("PRAGMA user_version = 1");
      seedParents(db);
      const before = ddl(db);
      // Valid against the empty reference, but fails on this populated v1 fixture.
      const failure = `${v2}\nCREATE TABLE failure_guard (n INTEGER CHECK (n = 0)); INSERT INTO failure_guard SELECT count(*) FROM users;`;
      expect(() =>
        ensureBusinessSchema(db, [
          v1,
          failure,
          v3,
          v4,
          v5,
          v6,
          v7,
          v8,
          v9,
          v10,
          v11,
          v12,
          v13,
          v14,
          v15,
          v16,
          v17,
          v18,
          v19,
          v20,
          v21,
          v22,
          v23,
          v24,
          v25,
          v27,
          v28,
          v29,
          v26,
          v30,
          v31,
          v32,
          v33,
          v34,
          v35,
          v36,
          v37,
          v38,
          v39,
          v40,
          v41,
          v42,
          v43,
          v44,
        ]),
      ).toThrow();
      expect(ddl(db)).toEqual(before);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(db.query("SELECT body FROM memory_entries").get()).toEqual({ body: "旧记忆" });
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 44 });
    } finally {
      db.close();
    }
  });

  it("rejects corrupt v1 before creating any knowledge objects", () => {
    const db = new Database(":memory:");
    try {
      db.exec(v1);
      db.exec("PRAGMA user_version = 1; DROP INDEX ix_memory_owner_status;");
      const before = ddl(db);
      expect(() => ensureBusinessSchema(db)).toThrow("REJECT_UNKNOWN_STRUCTURE");
      expect(ddl(db)).toEqual(before);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects v2 structural tampering and future versions", () => {
    const h = openBusinessDb();
    try {
      h.db.exec("DROP INDEX ix_knowledge_grants_agent;");
      expect(() => ensureBusinessSchema(h.db)).toThrow("REJECT_UNKNOWN_STRUCTURE");
      // Derived, not hardcoded: this used to say 38 while 38 was the CURRENT version, so the drop
      // above was what the gate reported and the version branch stopped being exercised at all.
      h.db.exec(`PRAGMA user_version = ${BUSINESS_SCHEMA_VERSION + 1};`);
      expect(() => ensureBusinessSchema(h.db)).toThrow("REJECT_UNKNOWN_VERSION");
    } finally {
      h.close();
    }
  });

  it("seeds exactly one category and default-on settings, never grants", () => {
    const h = openBusinessDb();
    try {
      expect(h.db.query("SELECT * FROM knowledge_categories").all()).toEqual([
        { id: "default", name: "资料", revision: 1 },
      ]);
      expect(h.db.query("SELECT * FROM knowledge_settings").all()).toEqual([
        { id: 1, auto_enabled: 1, model_name: null, context_budget: 16384, revision: 1 },
      ]);
      expect(h.db.query("SELECT * FROM knowledge_grants").all()).toEqual([]);
    } finally {
      h.close();
    }
  });

  for (const [name, spec] of Object.entries(golden)) {
    it(`${name}: independent columns plus ORM key/index/FK contract`, () => {
      const h = openBusinessDb();
      try {
        const columns = h.db.query(`PRAGMA table_info(${name})`).all() as {
          name: string;
          type: string;
          notnull: number;
        }[];
        expect(
          columns
            .map((c) => `${c.name}:${c.type === "INTEGER" ? "I" : "T"}${c.notnull ? "" : "?"}`)
            .join(" "),
        ).toBe(spec);
        const table = Object.values(businessTables).find((t) => getTableConfig(t).name === name);
        if (!table) throw new Error(`Missing ORM table ${name}`);
        const config = getTableConfig(table);
        const actualIndexes = h.db.query(`PRAGMA index_list(${name})`).all() as {
          name: string;
          unique: number;
          origin: string;
        }[];
        const expectedIndexes = [
          ...config.indexes.map((i) => ({
            name: i.config.name,
            unique: Number(i.config.unique),
            columns: i.config.columns.map((c) => ("name" in c ? c.name : "")),
          })),
          ...config.uniqueConstraints.map((i) => ({
            name: i.name,
            unique: 1,
            columns: i.columns.map((c) => c.name),
          })),
        ];
        expect(actualIndexes.filter((i) => i.origin !== "pk").length).toBe(expectedIndexes.length);
        for (const i of expectedIndexes) {
          expect(actualIndexes.some((a) => a.name === i.name && a.unique === i.unique)).toBe(true);
          const indexColumns = h.db.query(`PRAGMA index_info(${i.name})`).all() as {
            name: string;
          }[];
          expect(indexColumns.map((c) => c.name)).toEqual(i.columns);
        }
        const fks = h.db.query(`PRAGMA foreign_key_list(${name})`).all() as {
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }[];
        expect(fks.length).toBe(config.foreignKeys.length);
        for (const fk of config.foreignKeys) {
          const ref = fk.reference();
          expect(
            fks.some(
              (f) =>
                f.table === getTableConfig(ref.foreignTable).name &&
                f.from === ref.columns[0].name &&
                f.to === ref.foreignColumns[0].name &&
                f.on_delete.toLowerCase() === (fk.onDelete ?? "no action"),
            ),
          ).toBe(true);
        }
      } finally {
        h.close();
      }
    });
  }

  it("preserves exact original text, restricts category deletion and does not inherit grants", () => {
    const h = openBusinessDb();
    try {
      seedParents(h.db);
      document(h.db);
      h.db.exec("INSERT INTO knowledge_grants VALUES ('d', 'a', 'grant-1', 'now');");
      document(h.db, "d2");
      expect(
        h.db.query("SELECT original_text FROM knowledge_documents WHERE id = 'd'").get(),
      ).toEqual({ original_text: "\uFEFF# 原文\r\n  中文𠮷\t42.5\n" });
      expect(h.db.query("SELECT document_id FROM knowledge_grants").all()).toEqual([
        { document_id: "d" },
      ]);
      expect(() => h.db.exec("DELETE FROM knowledge_categories WHERE id = 'default'")).toThrow();
      h.db.exec(
        "INSERT INTO knowledge_categories VALUES ('other', 'Other', 1); UPDATE knowledge_documents SET category_id = 'other' WHERE id = 'd';",
      );
      expect(
        h.db.query("SELECT token FROM knowledge_grants WHERE document_id = 'd'").get(),
      ).toEqual({ token: "grant-1" });
      expect(() =>
        h.db.exec("INSERT INTO knowledge_grants VALUES ('d', 'a', 'duplicate', 'now')"),
      ).toThrow();
      expect(() => h.db.exec("UPDATE knowledge_documents SET content_mode = 'script'")).toThrow();
      expect(() => h.db.exec("UPDATE knowledge_settings SET auto_enabled = 2")).toThrow();
      expect(() => h.db.exec("UPDATE knowledge_settings SET context_budget = 0")).toThrow();
    } finally {
      h.close();
    }
  });

  it("document deletion cascades derivatives and grants but preserves request evidence", () => {
    const h = openBusinessDb();
    try {
      seedParents(h.db);
      document(h.db);
      h.db.exec(`INSERT INTO knowledge_grants VALUES ('d', 'a', 'grant-1', 'now');
        INSERT INTO knowledge_chunks VALUES ('c', 'd', 1, 0, 0, 2, '原文');
        INSERT INTO knowledge_drafts VALUES ('draft', 'd', 1, '', '[]', '整理稿', '[]', 'fake', 'now');
        INSERT INTO knowledge_jobs (id, document_id, content_version, settings_revision, created_at) VALUES ('j', 'd', 1, 1, 'now');
        INSERT INTO turn_knowledge_snapshots VALUES ('t', 'a', 1, '[{"document_id":"d","grant_token":"grant-1"}]', 'now');`);
      expect(() => h.db.exec("UPDATE knowledge_chunks SET end_offset = start_offset")).toThrow();
      expect(() => h.db.exec("UPDATE knowledge_jobs SET status = 'partial'")).toThrow();
      h.db.exec("DELETE FROM knowledge_documents WHERE id = 'd';");
      for (const table of [
        "knowledge_grants",
        "knowledge_chunks",
        "knowledge_drafts",
        "knowledge_jobs",
      ]) {
        expect(h.db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
      }
      expect(h.db.query("SELECT * FROM turn_knowledge_snapshots").all().length).toBe(1);
      h.db.exec("DELETE FROM turns WHERE id = 't';");
      expect(h.db.query("SELECT * FROM turn_knowledge_snapshots").all()).toEqual([]);
    } finally {
      h.close();
    }
  });
});
