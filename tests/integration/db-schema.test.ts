// Integration tests for the 16-table business data layer (R2).
//
// Coverage:
//  - migrations/versions/0001_initial.sql runs on an empty DB and is idempotent
//    across repeated execution.
//  - The ACTUAL structure of all 16 tables (verified via PRAGMA table_info /
//    index_list / foreign_key_list) matches the golden contract in
//    docs/reference/data-model.md exactly (columns, types, NOT NULL, PK, indexes,
//    composite unique keys, foreign keys + ON DELETE).
//  - CHECK constraints really fire: violating inserts are rejected.
//  - Foreign keys are actually ON (PRAGMA foreign_keys = 1) and the CASCADE /
//    SET NULL / NO ACTION policies behave.
//  - Schema / version gate: unknown version rejected, structure mismatch rejected,
//    correct version accepted.
//  - json-text.ts: object key sorting + array order preservation.
//  - Anti-drift: src/server/db/schema.ts column definitions match the SQL DB.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { openConnection } from "../../src/server/db/connection";
import { parseJson, stableStringify } from "../../src/server/db/json-text";
import { businessTables } from "../../src/server/db/schema";
import {
  BUSINESS_SCHEMA_VERSION,
  BUSINESS_TABLE_NAMES,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";

const MIGRATION_PATH = path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");
const KNOWLEDGE_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0002_knowledge.sql"),
  "utf8",
);

const READ_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0003_knowledge_read.sql"),
  "utf8",
);

const ORGANIZATION_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0004_organization.sql"),
  "utf8",
);

const QQ_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0005_qq_transport.sql"),
  "utf8",
);

const QQ_MEMORY_SOURCES_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0006_qq_memory_sources.sql"),
  "utf8",
);

const QQ_OBSERVATION_TEXT_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0007_qq_observation_text.sql"),
  "utf8",
);

const QQ_MEMORY_BATCH_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0008_qq_memory_batch.sql"),
  "utf8",
);

const QQ_TRANSPORT_CONFIG_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0009_qq_transport_config.sql"),
  "utf8",
);

const QQ_SCHEMES_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0010_qq_schemes.sql"),
  "utf8",
);
const QQ_SPEECH_LOG_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0011_qq_speech_log.sql"),
  "utf8",
);
const QQ_MEDIA_NOTES_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0012_qq_media_notes.sql"),
  "utf8",
);
const QQ_SCHEME_TRIGGERS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0013_qq_scheme_triggers.sql"),
  "utf8",
);
const QQ_SEND_LOG_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0014_qq_send_log.sql"),
  "utf8",
);
const QQ_SCHEME_RHYTHM_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0015_qq_scheme_rhythm.sql"),
  "utf8",
);
const QQ_CONTEXT_BUDGET_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0016_qq_context_budget.sql"),
  "utf8",
);

const QQ_SCHEME_PROMPTS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0017_qq_scheme_prompts.sql"),
  "utf8",
);
const QQ_MEMBERS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0018_qq_members.sql"),
  "utf8",
);
const QQ_OUTPUT_RESERVE_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0019_qq_output_reserve.sql"),
  "utf8",
);
const QQ_SCHEME_STICKERS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0020_qq_scheme_stickers.sql"),
  "utf8",
);
const QQ_STICKERS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0021_qq_stickers.sql"),
  "utf8",
);
const QQ_STICKER_AUTHORIZATION_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0022_qq_sticker_authorization.sql"),
  "utf8",
);
const QQ_DISPATCH_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0023_qq_dispatch.sql"),
  "utf8",
);
const QQ_MEDIA_PURPOSES_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0024_qq_media_purposes.sql"),
  "utf8",
);
const DESKTOP_SETTINGS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0025_desktop_settings.sql"),
  "utf8",
);
const QQ_MEDIA_SUPPLEMENT_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0026_qq_media_supplement.sql"),
  "utf8",
);
const QQ_EVENT_ADDRESSED_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0027_qq_event_addressed.sql"),
  "utf8",
);
const QQ_IMMEDIATE_LEASE_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0028_qq_immediate_lease.sql"),
  "utf8",
);
const QQ_MODULE_SWITCHES_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0029_qq_module_switches.sql"),
  "utf8",
);
const QQ_SWEEP_VERDICTS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0030_qq_sweep_verdicts.sql"),
  "utf8",
);
const QQ_ATTENTION_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0031_qq_attention.sql"),
  "utf8",
);
const MODEL_PROVIDERS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0032_model_providers.sql"),
  "utf8",
);
const QQ_IDLE_JUDGEMENTS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0033_qq_idle_judgements.sql"),
  "utf8",
);
const QQ_INITIATIVE_MIN_SCORE_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0034_qq_initiative_min_score.sql"),
  "utf8",
);
const QQ_REPLY_SPLIT_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0035_qq_reply_split.sql"),
  "utf8",
);
const QQ_JUDGEMENT_REUSE_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0036_qq_judgement_reuse.sql"),
  "utf8",
);
const QQ_JUDGEMENT_PER_SPEAKER_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0037_qq_judgement_per_speaker.sql"),
  "utf8",
);
const QQ_JUDGEMENT_MODEL_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0038_qq_judgement_model.sql"),
  "utf8",
);
const AGENT_RUNS_SQL = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0039_agent_runs.sql"),
  "utf8",
);
/** Every ordered business migration, joined for a complete reference database. */
const ALL_MIGRATION_SQL = `${MIGRATION_SQL}\n${KNOWLEDGE_SQL}\n${READ_SQL}\n${ORGANIZATION_SQL}\n${QQ_SQL}\n${QQ_MEMORY_SOURCES_SQL}\n${QQ_OBSERVATION_TEXT_SQL}\n${QQ_MEMORY_BATCH_SQL}\n${QQ_TRANSPORT_CONFIG_SQL}\n${QQ_SCHEMES_SQL}\n${QQ_SPEECH_LOG_SQL}\n${QQ_MEDIA_NOTES_SQL}\n${QQ_SCHEME_TRIGGERS_SQL}\n${QQ_SEND_LOG_SQL}\n${QQ_SCHEME_RHYTHM_SQL}\n${QQ_CONTEXT_BUDGET_SQL}\n${QQ_SCHEME_PROMPTS_SQL}\n${QQ_MEMBERS_SQL}\n${QQ_OUTPUT_RESERVE_SQL}\n${QQ_SCHEME_STICKERS_SQL}\n${QQ_STICKERS_SQL}\n${QQ_STICKER_AUTHORIZATION_SQL}
${QQ_DISPATCH_SQL}
${QQ_MEDIA_PURPOSES_SQL}
${DESKTOP_SETTINGS_SQL}
${QQ_MEDIA_SUPPLEMENT_SQL}
${QQ_EVENT_ADDRESSED_SQL}
${QQ_IMMEDIATE_LEASE_SQL}
${QQ_MODULE_SWITCHES_SQL}
${QQ_SWEEP_VERDICTS_SQL}
${QQ_ATTENTION_SQL}
${MODEL_PROVIDERS_SQL}
${QQ_IDLE_JUDGEMENTS_SQL}
${QQ_INITIATIVE_MIN_SCORE_SQL}
${QQ_REPLY_SPLIT_SQL}
${QQ_JUDGEMENT_REUSE_SQL}
${QQ_JUDGEMENT_PER_SPEAKER_SQL}
${QQ_JUDGEMENT_MODEL_SQL}
${AGENT_RUNS_SQL}
${readFileSync(path.join(import.meta.dir, "../../migrations/versions/0040_conversation_wakes.sql"), "utf8")}
${readFileSync(path.join(import.meta.dir, "../../migrations/versions/0041_outbound_intents.sql"), "utf8")}
${readFileSync(path.join(import.meta.dir, "../../migrations/versions/0042_runtime_observability.sql"), "utf8")}`;

// golden column contract (docs/reference/data-model.md)
type ColSpec = { name: string; type: string; notnull: 0 | 1; pk: 0 | 1 };

const GOLDEN_COLUMNS: Record<string, ColSpec[]> = {
  users: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  agents: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "system_prompt", type: "TEXT", notnull: 1, pk: 0 },
    { name: "description", type: "TEXT", notnull: 1, pk: 0 },
    { name: "additional_instructions", type: "TEXT", notnull: 1, pk: 0 },
    { name: "p5_config", type: "TEXT", notnull: 1, pk: 0 },
    { name: "model_name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "temperature", type: "REAL", notnull: 1, pk: 0 },
    { name: "memory_consolidation_model_name", type: "TEXT", notnull: 0, pk: 0 },
    { name: "memory_consolidation_prompt", type: "TEXT", notnull: 1, pk: 0 },
    { name: "memory_consolidation_additional_instructions", type: "TEXT", notnull: 1, pk: 0 },
    { name: "memory_retrieval_model_name", type: "TEXT", notnull: 0, pk: 0 },
    { name: "memory_retrieval_prompt", type: "TEXT", notnull: 1, pk: 0 },
    { name: "context_compression_model_name", type: "TEXT", notnull: 0, pk: 0 },
    { name: "persona_intensity", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "is_active", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "config_version", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  agent_personas: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "agent_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "core_identity", type: "TEXT", notnull: 1, pk: 0 },
    { name: "communication_style", type: "TEXT", notnull: 1, pk: 0 },
    { name: "interaction_boundaries", type: "TEXT", notnull: 1, pk: 0 },
    { name: "example_dialogues", type: "TEXT", notnull: 1, pk: 0 },
    { name: "advanced_instructions", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  sessions: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "user_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "agent_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "title", type: "TEXT", notnull: 1, pk: 0 },
    { name: "mode", type: "TEXT", notnull: 1, pk: 0 },
    { name: "client_request_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "agent_config_snapshot", type: "TEXT", notnull: 1, pk: 0 },
    { name: "config_version", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "next_sequence_no", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  turns: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "session_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "client_request_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "runtime_config_snapshot", type: "TEXT", notnull: 1, pk: 0 },
    { name: "context_valid", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "source_valid", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "generation_token", type: "TEXT", notnull: 0, pk: 0 },
    { name: "generation_status", type: "TEXT", notnull: 1, pk: 0 },
    { name: "lease_expires_at", type: "TEXT", notnull: 0, pk: 0 },
    { name: "cancel_requested", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "cancel_requested_at", type: "TEXT", notnull: 0, pk: 0 },
    { name: "invalidated_at", type: "TEXT", notnull: 0, pk: 0 },
    { name: "invalidation_reason", type: "TEXT", notnull: 0, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  messages: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "session_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "turn_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "sequence_no", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "role", type: "TEXT", notnull: 1, pk: 0 },
    { name: "content", type: "TEXT", notnull: 1, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, pk: 0 },
    { name: "client_request_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "error_code", type: "TEXT", notnull: 0, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "completed_at", type: "TEXT", notnull: 0, pk: 0 },
  ],
  message_deletion_events: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "session_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "turn_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "original_message_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "original_sequence_no", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "role", type: "TEXT", notnull: 1, pk: 0 },
    { name: "deleted_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "reason", type: "TEXT", notnull: 1, pk: 0 },
  ],
  memory_policies: [
    { name: "agent_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "user_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "auto_enabled", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "every_turns", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "target_chars", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "version", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "governance_epoch", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  memory_session_states: [
    { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "scope", type: "TEXT", notnull: 1, pk: 0 },
  ],
  memory_entries: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "agent_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "user_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "summary", type: "TEXT", notnull: 1, pk: 0 },
    { name: "tags", type: "TEXT", notnull: 1, pk: 0 },
    { name: "kinds", type: "TEXT", notnull: 1, pk: 0 },
    { name: "body", type: "TEXT", notnull: 1, pk: 0 },
    { name: "scope", type: "TEXT", notnull: 1, pk: 0 },
    { name: "scope_key", type: "TEXT", notnull: 1, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, pk: 0 },
    { name: "config_snapshot", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  memory_sources: [
    { name: "memory_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "turn_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "user_message_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "assistant_message_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "sequence_no", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  memory_links: [
    { name: "parent_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "child_id", type: "TEXT", notnull: 1, pk: 1 },
  ],
  memory_processed_turns: [
    { name: "turn_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "processed_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  memory_jobs: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "agent_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "user_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "request_key", type: "TEXT", notnull: 1, pk: 0 },
    { name: "kind", type: "TEXT", notnull: 1, pk: 0 },
    { name: "session_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "turn_ids", type: "TEXT", notnull: 1, pk: 0 },
    { name: "memory_ids", type: "TEXT", notnull: 1, pk: 0 },
    { name: "config_snapshot", type: "TEXT", notnull: 1, pk: 0 },
    { name: "governance_epoch", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, pk: 0 },
    { name: "token", type: "TEXT", notnull: 0, pk: 0 },
    { name: "lease_expires_at", type: "TEXT", notnull: 0, pk: 0 },
    { name: "result_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "error_code", type: "TEXT", notnull: 0, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "finished_at", type: "TEXT", notnull: 0, pk: 0 },
  ],
  session_summaries: [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "session_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "agent_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "user_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "start_sequence_no", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "end_sequence_no", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "source_count", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "content", type: "TEXT", notnull: 1, pk: 0 },
    { name: "model_name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "config_snapshot", type: "TEXT", notnull: 1, pk: 0 },
    { name: "template_version", type: "TEXT", notnull: 1, pk: 0 },
    { name: "estimated_tokens", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "is_valid", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "invalidated_at", type: "TEXT", notnull: 0, pk: 0 },
    { name: "invalidation_reason", type: "TEXT", notnull: 0, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  summary_sources: [
    { name: "summary_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "turn_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "user_message_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "assistant_message_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "sequence_no", type: "INTEGER", notnull: 1, pk: 0 },
  ],
};

const GOLDEN_INDEXES: Record<string, { name: string; unique: boolean }[]> = {
  agent_personas: [{ name: "uq_agent_persona_agent", unique: true }],
  sessions: [{ name: "uq_session_user_request", unique: true }],
  turns: [
    { name: "uq_turn_session_request", unique: true },
    { name: "ix_turns_session_created", unique: false },
    { name: "ix_turns_session_generation", unique: false },
  ],
  messages: [
    { name: "uq_message_session_sequence", unique: true },
    { name: "uq_message_turn_role", unique: true },
    { name: "ix_messages_session_order", unique: false },
  ],
  message_deletion_events: [
    { name: "uq_deletion_event_session_message", unique: true },
    { name: "ix_message_deletion_events_session_sequence", unique: false },
  ],
  memory_entries: [{ name: "ix_memory_owner_status", unique: false }],
  memory_jobs: [
    { name: "uq_memory_job_request", unique: true },
    { name: "ix_memory_job_queue", unique: false },
  ],
  session_summaries: [{ name: "ix_summary_session_active", unique: false }],
};

type FkSpec = { table: string; from: string; to: string; onDelete: string };
const GOLDEN_FKS: Record<string, FkSpec[]> = {
  agent_personas: [{ table: "agents", from: "agent_id", to: "id", onDelete: "CASCADE" }],
  sessions: [
    { table: "users", from: "user_id", to: "id", onDelete: "NO ACTION" },
    { table: "agents", from: "agent_id", to: "id", onDelete: "NO ACTION" },
  ],
  turns: [{ table: "sessions", from: "session_id", to: "id", onDelete: "CASCADE" }],
  messages: [
    { table: "sessions", from: "session_id", to: "id", onDelete: "CASCADE" },
    { table: "turns", from: "turn_id", to: "id", onDelete: "CASCADE" },
  ],
  message_deletion_events: [
    { table: "sessions", from: "session_id", to: "id", onDelete: "CASCADE" },
    { table: "turns", from: "turn_id", to: "id", onDelete: "CASCADE" },
  ],
  memory_policies: [
    { table: "agents", from: "agent_id", to: "id", onDelete: "CASCADE" },
    { table: "users", from: "user_id", to: "id", onDelete: "NO ACTION" },
  ],
  memory_session_states: [{ table: "sessions", from: "session_id", to: "id", onDelete: "CASCADE" }],
  memory_entries: [
    { table: "agents", from: "agent_id", to: "id", onDelete: "CASCADE" },
    { table: "users", from: "user_id", to: "id", onDelete: "NO ACTION" },
  ],
  memory_sources: [
    { table: "memory_entries", from: "memory_id", to: "id", onDelete: "CASCADE" },
    { table: "turns", from: "turn_id", to: "id", onDelete: "CASCADE" },
  ],
  memory_links: [
    { table: "memory_entries", from: "parent_id", to: "id", onDelete: "CASCADE" },
    { table: "memory_entries", from: "child_id", to: "id", onDelete: "CASCADE" },
  ],
  memory_processed_turns: [{ table: "turns", from: "turn_id", to: "id", onDelete: "CASCADE" }],
  memory_jobs: [
    { table: "agents", from: "agent_id", to: "id", onDelete: "CASCADE" },
    { table: "users", from: "user_id", to: "id", onDelete: "NO ACTION" },
    { table: "sessions", from: "session_id", to: "id", onDelete: "SET NULL" },
    { table: "memory_entries", from: "result_id", to: "id", onDelete: "SET NULL" },
  ],
  session_summaries: [
    { table: "sessions", from: "session_id", to: "id", onDelete: "CASCADE" },
    { table: "agents", from: "agent_id", to: "id", onDelete: "CASCADE" },
    { table: "users", from: "user_id", to: "id", onDelete: "NO ACTION" },
  ],
  summary_sources: [
    { table: "session_summaries", from: "summary_id", to: "id", onDelete: "CASCADE" },
    { table: "turns", from: "turn_id", to: "id", onDelete: "CASCADE" },
  ],
};

const ALL_TABLES = Object.keys(GOLDEN_COLUMNS);

// helpers
function getColumns(db: Database, table: string): ColSpec[] {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  return rows.map((r) => ({
    name: r.name,
    type: r.type.toUpperCase(),
    notnull: (r.notnull ? 1 : 0) as 0 | 1,
    pk: (r.pk ? 1 : 0) as 0 | 1,
  }));
}

function getIndexes(db: Database, table: string): { name: string; unique: boolean }[] {
  const rows = db.query(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
    origin: string;
  }>;
  return rows
    .filter((r) => r.origin !== "pk") // ignore the auto PK index
    .map((r) => ({ name: r.name, unique: r.unique === 1 }));
}

function getFks(db: Database, table: string): FkSpec[] {
  const rows = db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  return rows.map((r) => ({
    table: r.table,
    from: r.from,
    to: r.to,
    onDelete: r.on_delete.toUpperCase(),
  }));
}

function listUserTables(db: Database): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

function sortedCols(cols: ColSpec[]): ColSpec[] {
  return cols.slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** Insert a row; returns the caught error (or null if it succeeded). */
function tryInsert(db: Database, table: string, row: Record<string, unknown>): unknown {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(",");
  const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`;
  try {
    db.query(sql).run(...(cols.map((c) => row[c]) as Array<string | number | null>));
    return null;
  } catch (err) {
    return err;
  }
}

const NOW = "2026-01-01T00:00:00.000000Z";

/** Seed the minimal parent rows every FK-targeting table needs. */
function seedMinimal(db: Database): void {
  db.query("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run("u1", "default", NOW);
  db.query(
    `INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
      p5_config, model_name, temperature, memory_consolidation_prompt,
      memory_consolidation_additional_instructions, memory_retrieval_prompt,
      persona_intensity, is_active, config_version, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "a1",
    "agent",
    "sp",
    "desc",
    "ai",
    "{}",
    "model",
    0.7,
    "mcp",
    "mca",
    "mrp",
    60,
    1,
    1,
    NOW,
    NOW,
  );
  db.query(
    `INSERT INTO sessions (id, user_id, agent_id, title, mode, client_request_id,
      agent_config_snapshot, config_version, next_sequence_no, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("s1", "u1", "a1", "title", "chat", "cr1", "{}", 1, 1, NOW, NOW);
  db.query(
    `INSERT INTO turns (id, session_id, client_request_id, runtime_config_snapshot,
      context_valid, source_valid, generation_status, cancel_requested, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("t1", "s1", "tcr1", "{}", 1, 1, "completed", 0, NOW);
  db.query(
    `INSERT INTO memory_entries (id, agent_id, user_id, name, summary, tags, kinds,
      body, scope, scope_key, status, config_snapshot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("m1", "a1", "u1", "n", "s", "[]", "[]", "{}", "reality_user", "k", "active", "{}", NOW);
}

// 1. migration runs + idempotency
describe("business migration (SQL idempotency)", () => {
  it("creates exactly the 16 business tables on an empty DB", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATION_SQL);
    const tables = listUserTables(db);
    expect(tables).toEqual(ALL_TABLES.slice().sort());
    expect(tables.length).toBe(16);
    db.close();
  });

  it("is idempotent across repeated execution", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATION_SQL);
    expect(() => db.exec(MIGRATION_SQL)).not.toThrow();
    expect(listUserTables(db).length).toBe(16);
    db.close();
  });
});

// 2. per-table structure vs golden (the anti-drift core)
describe("business schema structure vs golden (PRAGMA assertions)", () => {
  let db: Database;
  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(MIGRATION_SQL);
  });
  afterAll(() => db.close());

  for (const table of ALL_TABLES) {
    it(`${table}: columns match golden (name/type/notnull/pk)`, () => {
      expect(sortedCols(getColumns(db, table))).toEqual(sortedCols(GOLDEN_COLUMNS[table]));
    });

    it(`${table}: indexes match golden`, () => {
      const expected = GOLDEN_INDEXES[table] ?? [];
      const actual = getIndexes(db, table);
      // match by name, ignoring auto-pk / sqlite_autoindex names
      const actualByName = new Map(actual.map((i) => [i.name, i]));
      expect(actual.length).toBe(expected.length);
      for (const exp of expected) {
        const got = actualByName.get(exp.name);
        expect(got, `missing index ${exp.name}`).toBeDefined();
        expect(got?.unique).toBe(exp.unique);
      }
    });

    it(`${table}: foreign keys match golden`, () => {
      const expected = GOLDEN_FKS[table] ?? [];
      const actual = getFks(db, table);
      expect(actual.length).toBe(expected.length);
      for (const exp of expected) {
        expect(
          actual.some(
            (a) =>
              a.table === exp.table &&
              a.from === exp.from &&
              a.to === exp.to &&
              a.onDelete === exp.onDelete,
          ),
          `expected FK ${exp.table}.${exp.to} <- ${exp.from} (${exp.onDelete})`,
        ).toBe(true);
      }
    });
  }
});

// 3. schema.ts <-> SQL DB anti-drift (columns)
describe("schema.ts matches the SQL DDL (anti-drift)", () => {
  let db: Database;
  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(ALL_MIGRATION_SQL);
  });
  afterAll(() => db.close());

  for (const table of Object.values(businessTables)) {
    it(`${getTableConfig(table).name}: drizzle columns == SQL columns`, () => {
      const cfg = getTableConfig(table);
      const cpk = new Set<string>();
      for (const pk of cfg.primaryKeys) {
        for (const c of pk.columns) cpk.add(c.name);
      }
      const schemaCols = cfg.columns
        .map((c) => ({
          name: c.name,
          type: c.getSQLType().toUpperCase(),
          notnull: (c.notNull ? 1 : 0) as 0 | 1,
          pk: (c.primary || cpk.has(c.name) ? 1 : 0) as 0 | 1,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(schemaCols).toEqual(sortedCols(getColumns(db, getTableConfig(table).name)));
    });
  }
});

// 4. CHECK constraints really fire
describe("CHECK constraints reject violating inserts", () => {
  let db: Database;
  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(MIGRATION_SQL);
    seedMinimal(db);
  });
  afterAll(() => db.close());

  const cases: Array<{ table: string; row: Record<string, unknown> }> = [
    {
      table: "agents",
      row: {
        id: "a2",
        name: "x",
        system_prompt: "x",
        description: "x",
        additional_instructions: "x",
        p5_config: "{}",
        model_name: "m",
        temperature: 3,
        memory_consolidation_prompt: "x",
        memory_retrieval_prompt: "x",
        persona_intensity: 60,
        is_active: 1,
        config_version: 1,
        updated_at: NOW,
        created_at: NOW,
      },
    },
    {
      table: "agents",
      row: {
        id: "a3",
        name: "x",
        system_prompt: "x",
        description: "x",
        additional_instructions: "x",
        p5_config: "{}",
        model_name: "m",
        temperature: 0.7,
        memory_consolidation_prompt: "x",
        memory_retrieval_prompt: "x",
        persona_intensity: 60,
        is_active: 1,
        config_version: 0,
        updated_at: NOW,
        created_at: NOW,
      },
    },
    {
      table: "agents",
      row: {
        id: "a4",
        name: "x",
        system_prompt: "x",
        description: "x",
        additional_instructions: "x",
        p5_config: "{}",
        model_name: "m",
        temperature: 0.7,
        memory_consolidation_prompt: "x",
        memory_retrieval_prompt: "x",
        persona_intensity: 150,
        is_active: 1,
        config_version: 1,
        updated_at: NOW,
        created_at: NOW,
      },
    },
    {
      table: "agents",
      row: {
        id: "a5",
        name: "x",
        system_prompt: "x",
        description: "x",
        additional_instructions: "x",
        p5_config: "{}",
        model_name: "m",
        temperature: 0.7,
        memory_consolidation_prompt: "x",
        memory_retrieval_prompt: "x",
        persona_intensity: 60,
        is_active: 2,
        config_version: 1,
        updated_at: NOW,
        created_at: NOW,
      },
    },
    {
      table: "sessions",
      row: {
        id: "s2",
        user_id: "u1",
        agent_id: "a1",
        title: "t",
        mode: "bogus",
        client_request_id: "cr2",
        agent_config_snapshot: "{}",
        config_version: 1,
        next_sequence_no: 1,
        created_at: NOW,
        updated_at: NOW,
      },
    },
    {
      table: "sessions",
      row: {
        id: "s3",
        user_id: "u1",
        agent_id: "a1",
        title: "t",
        mode: "chat",
        client_request_id: "cr3",
        agent_config_snapshot: "{}",
        config_version: 0,
        next_sequence_no: 1,
        created_at: NOW,
        updated_at: NOW,
      },
    },
    {
      table: "sessions",
      row: {
        id: "s4",
        user_id: "u1",
        agent_id: "a1",
        title: "t",
        mode: "chat",
        client_request_id: "cr4",
        agent_config_snapshot: "{}",
        config_version: 1,
        next_sequence_no: 0,
        created_at: NOW,
        updated_at: NOW,
      },
    },
    {
      table: "turns",
      row: {
        id: "t2",
        session_id: "s1",
        client_request_id: "tcr2",
        runtime_config_snapshot: "{}",
        context_valid: 1,
        source_valid: 1,
        generation_status: "bogus",
        cancel_requested: 0,
        created_at: NOW,
      },
    },
    {
      table: "turns",
      row: {
        id: "t3",
        session_id: "s1",
        client_request_id: "tcr3",
        runtime_config_snapshot: "{}",
        context_valid: 2,
        source_valid: 1,
        generation_status: "completed",
        cancel_requested: 0,
        created_at: NOW,
      },
    },
    {
      table: "turns",
      row: {
        id: "t4",
        session_id: "s1",
        client_request_id: "tcr4",
        runtime_config_snapshot: "{}",
        context_valid: 1,
        source_valid: 2,
        generation_status: "completed",
        cancel_requested: 0,
        created_at: NOW,
      },
    },
    {
      table: "turns",
      row: {
        id: "t5",
        session_id: "s1",
        client_request_id: "tcr5",
        runtime_config_snapshot: "{}",
        context_valid: 1,
        source_valid: 1,
        generation_status: "completed",
        cancel_requested: 2,
        created_at: NOW,
      },
    },
    {
      table: "messages",
      row: {
        id: "msg1",
        session_id: "s1",
        turn_id: "t1",
        sequence_no: 1,
        role: "bogus",
        content: "c",
        status: "completed",
        client_request_id: "crmsg1",
        created_at: NOW,
      },
    },
    {
      table: "messages",
      row: {
        id: "msg2",
        session_id: "s1",
        turn_id: "t1",
        sequence_no: 1,
        role: "user",
        content: "c",
        status: "bogus",
        client_request_id: "crmsg2",
        created_at: NOW,
      },
    },
    {
      table: "messages",
      row: {
        id: "msg3",
        session_id: "s1",
        turn_id: "t1",
        sequence_no: 0,
        role: "user",
        content: "c",
        status: "completed",
        client_request_id: "crmsg3",
        created_at: NOW,
      },
    },
    {
      table: "message_deletion_events",
      row: {
        id: "d1",
        session_id: "s1",
        turn_id: "t1",
        original_message_id: "x",
        original_sequence_no: 1,
        role: "system",
        deleted_at: NOW,
        reason: "user_requested",
      },
    },
    {
      table: "message_deletion_events",
      row: {
        id: "d2",
        session_id: "s1",
        turn_id: "t1",
        original_message_id: "y",
        original_sequence_no: 0,
        role: "user",
        deleted_at: NOW,
        reason: "user_requested",
      },
    },
    {
      table: "memory_policies",
      row: {
        agent_id: "a1",
        user_id: "u1",
        auto_enabled: 0,
        every_turns: 0,
        target_chars: 300,
        version: 1,
        governance_epoch: 0,
      },
    },
    {
      table: "memory_policies",
      row: {
        agent_id: "a1",
        user_id: "u1",
        auto_enabled: 0,
        every_turns: 20,
        target_chars: 10,
        version: 1,
        governance_epoch: 0,
      },
    },
    {
      table: "memory_policies",
      row: {
        agent_id: "a1",
        user_id: "u1",
        auto_enabled: 2,
        every_turns: 20,
        target_chars: 300,
        version: 1,
        governance_epoch: 0,
      },
    },
    {
      table: "memory_entries",
      row: {
        id: "m2",
        agent_id: "a1",
        user_id: "u1",
        name: "n",
        summary: "s",
        tags: "[]",
        kinds: "[]",
        body: "{}",
        scope: "reality_user",
        scope_key: "k",
        status: "bogus",
        config_snapshot: "{}",
        created_at: NOW,
      },
    },
    {
      table: "memory_jobs",
      row: {
        id: "j1",
        agent_id: "a1",
        user_id: "u1",
        request_key: "rk1",
        kind: "merge",
        turn_ids: "[]",
        memory_ids: "[]",
        config_snapshot: "{}",
        governance_epoch: 0,
        status: "bogus",
        created_at: NOW,
      },
    },
    {
      table: "session_summaries",
      row: {
        id: "ss1",
        session_id: "s1",
        agent_id: "a1",
        user_id: "u1",
        start_sequence_no: 1,
        end_sequence_no: 2,
        source_count: 1,
        content: "{}",
        model_name: "m",
        config_snapshot: "{}",
        template_version: "p5-1",
        estimated_tokens: 10,
        is_valid: 2,
        created_at: NOW,
      },
    },
  ];

  for (const c of cases) {
    it(`${c.table}: rejects violating row`, () => {
      const err = tryInsert(db, c.table, c.row);
      expect(err, `expected insert into ${c.table} to be rejected by CHECK`).not.toBeNull();
    });
  }

  it("accepts a fully valid row (sanity, not a false-positive pass)", () => {
    const err = tryInsert(db, "agents", {
      id: "aok",
      name: "x",
      system_prompt: "x",
      description: "x",
      additional_instructions: "x",
      p5_config: "{}",
      model_name: "m",
      temperature: 1.5,
      memory_consolidation_prompt: "x",
      memory_consolidation_additional_instructions: "x",
      memory_retrieval_prompt: "x",
      persona_intensity: 42,
      is_active: 1,
      config_version: 3,
      updated_at: NOW,
      created_at: NOW,
    });
    expect(err).toBeNull();
  });
});

// 5. foreign keys are ON and policies behave
describe("foreign key enforcement", () => {
  it("the connection forces PRAGMA foreign_keys = ON", () => {
    const db = openConnection();
    const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });

  it("CASCADE: deleting a session removes its turns", () => {
    const db = openConnection();
    db.exec(MIGRATION_SQL);
    seedMinimal(db);
    db.query("DELETE FROM sessions WHERE id = 's1'").run();
    const rows = db.query("SELECT COUNT(*) AS c FROM turns WHERE session_id = 's1'").get() as {
      c: number;
    };
    expect(rows.c).toBe(0);
    db.close();
  });

  it("SET NULL: deleting a memory entry nulls the job result_id", () => {
    const db = openConnection();
    db.exec(MIGRATION_SQL);
    seedMinimal(db);
    db.query(
      `INSERT INTO memory_jobs (id, agent_id, user_id, request_key, kind, turn_ids,
        memory_ids, config_snapshot, governance_epoch, status, result_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("jx", "a1", "u1", "rk", "merge", "[]", "[]", "{}", 0, "queued", "m1", NOW);
    db.query("DELETE FROM memory_entries WHERE id = 'm1'").run();
    const rows = db.query("SELECT result_id FROM memory_jobs WHERE id = 'jx'").get() as {
      result_id: string | null;
    };
    expect(rows.result_id).toBeNull();
    db.close();
  });

  it("NO ACTION: deleting a referenced agent is rejected", () => {
    const db = openConnection();
    db.exec(MIGRATION_SQL);
    seedMinimal(db);
    expect(() => db.query("DELETE FROM agents WHERE id = 'a1'").run()).toThrow();
    db.close();
  });
});

// 6. schema / version gate
describe("business schema gate", () => {
  it("initialises a fresh db and stamps user_version", () => {
    const h = openBusinessDb();
    const v = h.db.query("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(BUSINESS_SCHEMA_VERSION);
    expect(listUserTables(h.db)).toEqual(BUSINESS_TABLE_NAMES.slice().sort());
    h.close();
  });

  it("re-opening an initialised db is a no-op and does not throw", () => {
    const h = openBusinessDb();
    expect(() => ensureBusinessSchema(h.db)).not.toThrow();
    h.close();
  });

  it("rejects an unknown (non-zero) schema version", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA user_version = 999");
    expect(() => ensureBusinessSchema(db)).toThrow(/REJECT_UNKNOWN_VERSION/);
    db.close();
  });

  it("rejects a fresh db that already has unrelated tables", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE alien (id INTEGER)");
    expect(() => ensureBusinessSchema(db)).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
    db.close();
  });

  it("rejects the correct version but wrong table set", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    db.run(`PRAGMA user_version = ${BUSINESS_SCHEMA_VERSION}`);
    expect(() => ensureBusinessSchema(db)).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
    db.close();
  });

  it("accepts the correct version with the full table set", () => {
    const db = new Database(":memory:");
    db.exec(ALL_MIGRATION_SQL);
    db.run(`PRAGMA user_version = ${BUSINESS_SCHEMA_VERSION}`);
    expect(() => ensureBusinessSchema(db)).not.toThrow();
    db.close();
  });
});

// 7. json-text utility
describe("json-text canonical serialization", () => {
  it("sorts object keys regardless of insertion order", () => {
    const a = stableStringify({ b: 2, a: 1, c: 3 });
    const b = stableStringify({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2,"c":3}');
  });

  it("preserves array element order", () => {
    const s = stableStringify({ x: [3, 1, 2], y: ["z", "a"] });
    expect(s).toBe('{"x":[3,1,2],"y":["z","a"]}');
    const back = parseJson<{ x: number[]; y: string[] }>(s);
    expect(back.x).toEqual([3, 1, 2]);
    expect(back.y).toEqual(["z", "a"]);
  });

  it("recursively sorts nested object keys but never arrays", () => {
    const s = stableStringify({ a: { z: 1, y: [9, 1] }, b: 1 });
    expect(s).toBe('{"a":{"y":[9,1],"z":1},"b":1}');
  });

  it("round-trips arbitrary JSON", () => {
    const value = { name: "x", nested: { arr: [1, 2], flag: true }, n: null };
    const round = parseJson<typeof value>(stableStringify(value));
    expect(round).toEqual(value);
  });
});
