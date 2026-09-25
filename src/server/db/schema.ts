// Drizzle ORM schema: 16 business tables plus the additive knowledge and QQ
// transport tables.
// The business tables are mapped 1:1 onto Drizzle + SQLite.
// Source of truth: docs/reference/data-model.md (golden). Every column name
// type, NOT NULL, default, primary key, composite unique key, foreign key (with
// ON DELETE strategy) and CHECK constraint below mirrors that document. The
// authoritative DDL that actually builds the database is
// migrations/versions/0001_initial.sql through 0005_qq_transport.sql — stay in
// lock-step with it (see tests/integration/db-schema.test.ts for the drift guard).
// Type mapping (data-model.md §0):
// String(N)/Text -> text() -> TEXT
// Integer/BigInteger -> integer() -> INTEGER (SQLite INTEGER is 8 bytes)
// Float -> real() -> REAL
// Boolean -> integer() -> INTEGER 0/1, CHECK IN (0,1)
// JSON -> text() -> TEXT (JSON string, see json-text.ts)
// DATETIME(fsp=6) -> text() -> TEXT ISO8601 with microseconds (app-generated)
// Engine / charset / collate table options are dropped (data-model.md §0).

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import {
  QQ_MODEL_OUTPUT_RESERVE_DEFAULT,
  QQ_REPLY_DEFAULT,
  QQ_STICKER_DEDUP_DEFAULT,
} from "../../shared/contracts/qq";
import { QQ_PROMPT_DEFAULTS } from "../services/qq-prompt-contract";
import { QQ_RHYTHM_DEFAULT } from "../services/qq-rhythm-contract";

// 1. users (data-model.md §1.1) — no FK, no CHECK.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

// 2. agents (data-model.md §1.2)
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    description: text("description").notNull(),
    additionalInstructions: text("additional_instructions").notNull(),
    p5Config: text("p5_config").notNull(), // JSON
    modelName: text("model_name").notNull(),
    temperature: real("temperature").notNull().default(0.7),
    memoryConsolidationModelName: text("memory_consolidation_model_name"),
    memoryConsolidationPrompt: text("memory_consolidation_prompt").notNull(),
    memoryConsolidationAdditionalInstructions: text(
      "memory_consolidation_additional_instructions",
    ).notNull(),
    memoryRetrievalModelName: text("memory_retrieval_model_name"),
    memoryRetrievalPrompt: text("memory_retrieval_prompt").notNull(),
    contextCompressionModelName: text("context_compression_model_name"),
    personaIntensity: integer("persona_intensity").notNull().default(60),
    isActive: integer("is_active").notNull().default(1),
    configVersion: integer("config_version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("agent_temperature", sql`${t.temperature} >= 0 AND ${t.temperature} <= 2`),
    check("agent_config_version", sql`${t.configVersion} >= 1`),
    check(
      "agent_persona_intensity",
      sql`${t.personaIntensity} >= 0 AND ${t.personaIntensity} <= 100`,
    ),
    // Boolean storage contract (data-model.md §0).
    check("agent_is_active", sql`${t.isActive} IN (0, 1)`),
  ],
);

// 3. agent_personas (data-model.md §1.3) — UQ on agent_id.
export const agentPersonas = sqliteTable(
  "agent_personas",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    coreIdentity: text("core_identity").notNull().default(""),
    communicationStyle: text("communication_style").notNull().default(""),
    interactionBoundaries: text("interaction_boundaries").notNull().default(""),
    exampleDialogues: text("example_dialogues").notNull().default(""),
    advancedInstructions: text("advanced_instructions").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique("uq_agent_persona_agent").on(t.agentId)],
);

// 4. sessions (data-model.md §1.4)
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    title: text("title").notNull(),
    mode: text("mode").notNull().default("chat"),
    clientRequestId: text("client_request_id").notNull(),
    agentConfigSnapshot: text("agent_config_snapshot").notNull(), // JSON
    configVersion: integer("config_version").notNull().default(1),
    nextSequenceNo: integer("next_sequence_no").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("session_mode", sql`${t.mode} IN ('chat', 'work')`),
    check("session_config_version", sql`${t.configVersion} >= 1`),
    check("session_next_sequence_no", sql`${t.nextSequenceNo} >= 1`),
    unique("uq_session_user_request").on(t.userId, t.clientRequestId),
  ],
);

// 5. turns (data-model.md §1.5)
export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    clientRequestId: text("client_request_id").notNull(),
    runtimeConfigSnapshot: text("runtime_config_snapshot").notNull(), // JSON
    contextValid: integer("context_valid").notNull().default(1),
    sourceValid: integer("source_valid").notNull().default(1),
    generationToken: text("generation_token"),
    generationStatus: text("generation_status").notNull().default("completed"),
    leaseExpiresAt: text("lease_expires_at"),
    cancelRequested: integer("cancel_requested").notNull().default(0),
    cancelRequestedAt: text("cancel_requested_at"),
    invalidatedAt: text("invalidated_at"),
    invalidationReason: text("invalidation_reason"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("turn_context_valid", sql`${t.contextValid} IN (0, 1)`),
    check("turn_source_valid", sql`${t.sourceValid} IN (0, 1)`),
    check(
      "turn_generation_status",
      sql`${t.generationStatus} IN ('active', 'completed', 'failed', 'cancelled')`,
    ),
    check("turn_cancel_requested", sql`${t.cancelRequested} IN (0, 1)`),
    unique("uq_turn_session_request").on(t.sessionId, t.clientRequestId),
    index("ix_turns_session_created").on(t.sessionId, t.createdAt, t.id),
    index("ix_turns_session_generation").on(t.sessionId, t.generationStatus, t.leaseExpiresAt),
  ],
);

// 6. messages (data-model.md §1.6)
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    sequenceNo: integer("sequence_no").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [
    check("message_role", sql`${t.role} IN ('user', 'assistant', 'system')`),
    check("message_status", sql`${t.status} IN ('pending', 'completed', 'failed', 'cancelled')`),
    check("message_sequence_no", sql`${t.sequenceNo} >= 1`),
    unique("uq_message_session_sequence").on(t.sessionId, t.sequenceNo),
    unique("uq_message_turn_role").on(t.turnId, t.role),
    index("ix_messages_session_order").on(t.sessionId, t.sequenceNo),
  ],
);

// 7. message_deletion_events (data-model.md §1.7)
export const messageDeletionEvents = sqliteTable(
  "message_deletion_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    originalMessageId: text("original_message_id").notNull(),
    originalSequenceNo: integer("original_sequence_no").notNull(),
    role: text("role").notNull(),
    deletedAt: text("deleted_at").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [
    check("deletion_event_role", sql`${t.role} IN ('user', 'assistant')`),
    check("deletion_event_sequence_no", sql`${t.originalSequenceNo} >= 1`),
    unique("uq_deletion_event_session_message").on(t.sessionId, t.originalMessageId),
    index("ix_message_deletion_events_session_sequence").on(t.sessionId, t.originalSequenceNo),
  ],
);

// 8. memory_policies (data-model.md §1.8) — composite PK on agent_id.
export const memoryPolicies = sqliteTable(
  "memory_policies",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    autoEnabled: integer("auto_enabled").notNull().default(0),
    everyTurns: integer("every_turns").notNull().default(20),
    // Frozen SQL default; repository creation supplies the current product default.
    targetChars: integer("target_chars").notNull().default(300),
    version: integer("version").notNull().default(1),
    governanceEpoch: integer("governance_epoch").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.agentId] }),
    check("memory_every_turns", sql`${t.everyTurns} >= 1 AND ${t.everyTurns} <= 200`),
    check("memory_target_chars", sql`${t.targetChars} >= 50 AND ${t.targetChars} <= 4000`),
    check("memory_auto_enabled", sql`${t.autoEnabled} IN (0, 1)`),
  ],
);

// 9. memory_session_states (data-model.md §1.9) — composite PK on session_id.
export const memorySessionStates = sqliteTable(
  "memory_session_states",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("reality_user"),
  },
  (t) => [primaryKey({ columns: [t.sessionId] })],
);

// 10. memory_entries (data-model.md §1.10)
export const memoryEntries = sqliteTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    tags: text("tags").notNull(), // JSON list[str]
    kinds: text("kinds").notNull(), // JSON list[str]
    body: text("body").notNull(), // Markdown TEXT (: MemoryEntry.body)
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    status: text("status").notNull().default("active"),
    configSnapshot: text("config_snapshot").notNull(), // JSON
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("memory_status", sql`${t.status} IN ('active', 'suppressed', 'replaced', 'invalid')`),
    index("ix_memory_owner_status").on(t.userId, t.agentId, t.status),
  ],
);

// 11. memory_sources (data-model.md §1.11) — composite PK (memory_id, turn_id).
export const memorySources = sqliteTable(
  "memory_sources",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    userMessageId: text("user_message_id").notNull(),
    assistantMessageId: text("assistant_message_id").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
  },
  (t) => [primaryKey({ columns: [t.memoryId, t.turnId] })],
);

// 12. memory_links (data-model.md §1.12) — composite PK (parent_id, child_id).
export const memoryLinks = sqliteTable(
  "memory_links",
  {
    parentId: text("parent_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    childId: text("child_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.parentId, t.childId] })],
);

// 13. memory_processed_turns (data-model.md §1.13) — composite PK on turn_id.
export const memoryProcessedTurns = sqliteTable(
  "memory_processed_turns",
  {
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    processedAt: text("processed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.turnId] })],
);

// 14. memory_jobs (data-model.md §1.14)
export const memoryJobs = sqliteTable(
  "memory_jobs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    requestKey: text("request_key").notNull(),
    kind: text("kind").notNull(),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    turnIds: text("turn_ids").notNull(), // JSON list[str], sorted
    memoryIds: text("memory_ids").notNull(), // JSON list[str], sorted
    configSnapshot: text("config_snapshot").notNull(), // JSON
    governanceEpoch: integer("governance_epoch").notNull(),
    status: text("status").notNull().default("queued"),
    token: text("token"),
    leaseExpiresAt: text("lease_expires_at"),
    resultId: text("result_id").references(() => memoryEntries.id, {
      onDelete: "set null",
    }),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [
    check("memory_job_status", sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed')`),
    unique("uq_memory_job_request").on(t.agentId, t.userId, t.requestKey),
    index("ix_memory_job_queue").on(t.status, t.createdAt),
  ],
);

// 15. session_summaries (data-model.md §1.15)
export const sessionSummaries = sqliteTable(
  "session_summaries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    startSequenceNo: integer("start_sequence_no").notNull(),
    endSequenceNo: integer("end_sequence_no").notNull(),
    sourceCount: integer("source_count").notNull(),
    content: text("content").notNull(), // JSON
    modelName: text("model_name").notNull(),
    configSnapshot: text("config_snapshot").notNull(), // JSON
    templateVersion: text("template_version").notNull(),
    estimatedTokens: integer("estimated_tokens").notNull(),
    isValid: integer("is_valid").notNull().default(1),
    invalidatedAt: text("invalidated_at"),
    invalidationReason: text("invalidation_reason"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("summary_is_valid", sql`${t.isValid} IN (0, 1)`),
    index("ix_summary_session_active").on(t.sessionId, t.isValid, t.startSequenceNo),
  ],
);

// 16. summary_sources (data-model.md §1.16) — composite PK (summary_id, turn_id).
export const summarySources = sqliteTable(
  "summary_sources",
  {
    summaryId: text("summary_id")
      .notNull()
      .references(() => sessionSummaries.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    userMessageId: text("user_message_id").notNull(),
    assistantMessageId: text("assistant_message_id").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
  },
  (t) => [primaryKey({ columns: [t.summaryId, t.turnId] })],
);

// Knowledge library additions (0002_knowledge.sql, ADR0014).
export const knowledgeSettings = sqliteTable(
  "knowledge_settings",
  {
    id: integer("id").notNull().primaryKey(),
    autoEnabled: integer("auto_enabled").notNull().default(1),
    modelName: text("model_name"),
    // Frozen SQL default; first-time schema initialization seeds the product default.
    contextBudget: integer("context_budget").notNull().default(4096),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    check("knowledge_settings_id", sql`${t.id} = 1`),
    check("knowledge_auto_enabled", sql`${t.autoEnabled} IN (0, 1)`),
    check("knowledge_context_budget", sql`${t.contextBudget} >= 1`),
    check("knowledge_settings_revision", sql`${t.revision} >= 1`),
  ],
);

export const knowledgeCategories = sqliteTable(
  "knowledge_categories",
  {
    id: text("id").notNull().primaryKey(),
    name: text("name").notNull(),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    check("knowledge_category_name", sql`length(trim(${t.name})) > 0`),
    check("knowledge_category_revision", sql`${t.revision} >= 1`),
  ],
);

export const knowledgeDocuments = sqliteTable(
  "knowledge_documents",
  {
    id: text("id").notNull().primaryKey(),
    categoryId: text("category_id")
      .notNull()
      .references(() => knowledgeCategories.id),
    name: text("name").notNull(),
    originalText: text("original_text").notNull(),
    importType: text("import_type").notNull(),
    contentMode: text("content_mode").notNull().default("draft"),
    contentVersion: integer("content_version").notNull().default(1),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("knowledge_document_name", sql`length(trim(${t.name})) > 0`),
    check("knowledge_original_text", sql`length(${t.originalText}) > 0`),
    check("knowledge_import_type", sql`${t.importType} IN ('text', 'txt', 'md')`),
    check("knowledge_content_mode", sql`${t.contentMode} IN ('draft', 'original')`),
    check("knowledge_content_version", sql`${t.contentVersion} >= 1`),
    check("knowledge_document_revision", sql`${t.revision} >= 1`),
    index("ix_knowledge_documents_category").on(t.categoryId, t.id),
  ],
);

export const knowledgeGrants = sqliteTable(
  "knowledge_grants",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.agentId] }),
    index("ix_knowledge_grants_agent").on(t.agentId, t.documentId),
  ],
);

export const knowledgeChunks = sqliteTable(
  "knowledge_chunks",
  {
    id: text("id").notNull().primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    contentVersion: integer("content_version").notNull(),
    ordinal: integer("ordinal").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    body: text("body").notNull(),
  },
  (t) => [
    check("knowledge_chunk_version", sql`${t.contentVersion} >= 1`),
    check("knowledge_chunk_ordinal", sql`${t.ordinal} >= 0`),
    check("knowledge_chunk_start", sql`${t.startOffset} >= 0`),
    check("knowledge_chunk_end", sql`${t.endOffset} > ${t.startOffset}`),
    unique("uq_knowledge_chunk_position").on(t.documentId, t.contentVersion, t.ordinal),
  ],
);

export const knowledgeDrafts = sqliteTable(
  "knowledge_drafts",
  {
    id: text("id").notNull().primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    contentVersion: integer("content_version").notNull(),
    summary: text("summary").notNull(),
    tags: text("tags").notNull(),
    body: text("body").notNull(),
    sources: text("sources").notNull(),
    modelName: text("model_name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("knowledge_draft_version", sql`${t.contentVersion} >= 1`),
    unique("uq_knowledge_draft_version").on(t.documentId, t.contentVersion),
  ],
);

export const knowledgeJobs = sqliteTable(
  "knowledge_jobs",
  {
    id: text("id").notNull().primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    contentVersion: integer("content_version").notNull(),
    settingsRevision: integer("settings_revision").notNull(),
    status: text("status").notNull().default("queued"),
    token: text("token"),
    leaseExpiresAt: text("lease_expires_at"),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [
    check("knowledge_job_version", sql`${t.contentVersion} >= 1`),
    check("knowledge_job_settings_revision", sql`${t.settingsRevision} >= 1`),
    check(
      "knowledge_job_status",
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    index("ix_knowledge_job_queue").on(t.status, t.createdAt, t.id),
  ],
);

export const turnKnowledgeSnapshots = sqliteTable(
  "turn_knowledge_snapshots",
  {
    turnId: text("turn_id")
      .notNull()
      .primaryKey()
      .references(() => turns.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    settingsRevision: integer("settings_revision").notNull(),
    items: text("items").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [check("knowledge_snapshot_revision", sql`${t.settingsRevision} >= 1`)],
);

// Per-assistant reading rules (0003_knowledge_read.sql, ADR0015).
export const agentKnowledgeReadSettings = sqliteTable(
  "agent_knowledge_read_settings",
  {
    agentId: text("agent_id")
      .notNull()
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    enabled: integer("enabled").notNull().default(1),
    contextBudget: integer("context_budget"),
    scope: text("scope").notNull().default("all"),
    documentIds: text("document_ids").notNull().default("[]"),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    check("agent_knowledge_read_enabled", sql`${t.enabled} IN (0, 1)`),
    check(
      "agent_knowledge_read_budget",
      sql`${t.contextBudget} IS NULL OR ${t.contextBudget} >= 1`,
    ),
    check("agent_knowledge_read_scope", sql`${t.scope} IN ('all', 'selected')`),
    check(
      "agent_knowledge_read_ids",
      sql`json_valid(${t.documentIds}) AND json_type(${t.documentIds}) = 'array'`,
    ),
    check("agent_knowledge_read_all", sql`${t.scope} <> 'all' OR ${t.documentIds} = '[]'`),
    check("agent_knowledge_read_revision", sql`${t.revision} >= 1`),
  ],
);

// Shared organization model default (0004_organization.sql, ADR0015).
export const organizationSettings = sqliteTable(
  "organization_settings",
  {
    id: integer("id").notNull().primaryKey(),
    modelName: text("model_name"),
    /** Media purposes (§7.1): unset means "cannot understand", never a fallback (P4b). */
    visionModelName: text("vision_model_name"),
    transcriptionModelName: text("transcription_model_name"),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    check("organization_settings_id", sql`${t.id} = 1`),
    check("organization_settings_revision", sql`${t.revision} >= 1`),
  ],
);

// QQ transport settings (0005_qq_transport.sql, ADR0017/ADR0018) — single row.
export const qqSettings = sqliteTable(
  "qq_settings",
  {
    id: integer("id").notNull().primaryKey(),
    enabled: integer("enabled").notNull().default(0),
    accountId: text("account_id"),
    // The user's own locally listening OneBot endpoint, and its token as ciphertext.
    endpoint: text("endpoint"),
    tokenCiphertext: text("token_ciphertext"),
    revision: integer("revision").notNull().default(1),
    // 0038 (§11.1's 判断开口兴趣打分): which model judges, QQ-globally. NULL = follow each bound
    // assistant's conversation model, which is what every install did before this column existed.
    judgementModelName: text("judgement_model_name"),
  },
  (t) => [
    check("qq_settings_id", sql`${t.id} = 1`),
    check("qq_settings_enabled", sql`${t.enabled} IN (0, 1)`),
    check("qq_settings_revision", sql`${t.revision} >= 1`),
  ],
);

// The local user's own QQ identity — single row, saved explicitly, never inferred.
export const qqOwnerIdentities = sqliteTable(
  "qq_owner_identities",
  {
    id: integer("id").notNull().primaryKey(),
    accountId: text("account_id").notNull(),
    peerId: text("peer_id"),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    check("qq_owner_identity_id", sql`${t.id} = 1`),
    check("qq_owner_identity_revision", sql`${t.revision} >= 1`),
  ],
);

// One binding per (account, conversation kind, peer). `scheme_id` is an opaque
// reference until the named chat schemes get their own migration.
export const qqBindings = sqliteTable(
  "qq_bindings",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    conversationKind: text("conversation_kind").notNull(),
    peerId: text("peer_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    schemeId: text("scheme_id").notNull(),
    paused: integer("paused").notNull().default(0),
    shareWebMemory: integer("share_web_memory").notNull().default(0),
    // NULL = automatic organising off for this conversation (see 0008).
    memoryBatchSize: integer("memory_batch_size"),
    ownerIdentityRevision: integer("owner_identity_revision"),
    // 0029 (§0.6/F05): per-conversation module switches. NULL = follow the scheme; 0/1 override it
    // for this conversation only. Detailed parameters deliberately have no override columns.
    triggerDirectReply: integer("trigger_direct_reply"),
    triggerFollowUp: integer("trigger_follow_up"),
    triggerChimingIn: integer("trigger_chiming_in"),
    triggerIdleTopic: integer("trigger_idle_topic"),
    // 0031 (P6 follow-up, 用户 2026-09-25): 「重要的人」. A NULL mode means the list is off for this
    // conversation; 'soft' marks the listed speakers in the context, 'hard' lets only them trigger.
    // The members travel as a JSON array because the list belongs to exactly one binding.
    attentionMode: text("attention_mode"),
    attentionMembers: text("attention_members"),
    revision: integer("revision").notNull().default(1),
    authorityRevision: integer("authority_revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("qq_binding_kind", sql`${t.conversationKind} IN ('group', 'private')`),
    check("qq_binding_paused", sql`${t.paused} IN (0, 1)`),
    check("qq_binding_share", sql`${t.shareWebMemory} IN (0, 1)`),
    check(
      "qq_binding_owner_revision",
      sql`${t.ownerIdentityRevision} IS NULL OR ${t.ownerIdentityRevision} >= 1`,
    ),
    check("qq_binding_revision", sql`${t.revision} >= 1`),
    check("qq_binding_batch_size", sql`${t.memoryBatchSize} IS NULL OR ${t.memoryBatchSize} >= 1`),
    check("qq_binding_authority_revision", sql`${t.authorityRevision} >= 1`),
    check(
      "qq_binding_trigger_direct_reply",
      sql`${t.triggerDirectReply} IS NULL OR ${t.triggerDirectReply} IN (0, 1)`,
    ),
    check(
      "qq_binding_trigger_follow_up",
      sql`${t.triggerFollowUp} IS NULL OR ${t.triggerFollowUp} IN (0, 1)`,
    ),
    check(
      "qq_binding_trigger_chiming_in",
      sql`${t.triggerChimingIn} IS NULL OR ${t.triggerChimingIn} IN (0, 1)`,
    ),
    check(
      "qq_binding_trigger_idle_topic",
      sql`${t.triggerIdleTopic} IS NULL OR ${t.triggerIdleTopic} IN (0, 1)`,
    ),
    check(
      "qq_binding_attention_mode",
      sql`${t.attentionMode} IS NULL OR ${t.attentionMode} IN ('soft', 'hard')`,
    ),
    check(
      "qq_binding_attention_members",
      sql`${t.attentionMembers} IS NULL OR (json_valid(${t.attentionMembers}) AND json_type(${t.attentionMembers}) = 'array')`,
    ),
    check("qq_binding_authority_bound", sql`${t.authorityRevision} <= ${t.revision}`),
    check(
      "qq_binding_share_requires_owner",
      sql`${t.shareWebMemory} = 0 OR (${t.conversationKind} = 'private' AND ${t.ownerIdentityRevision} IS NOT NULL)`,
    ),
    check(
      "qq_binding_owner_requires_share",
      sql`${t.shareWebMemory} = 1 OR ${t.ownerIdentityRevision} IS NULL`,
    ),
    unique("uq_qq_binding_conversation").on(t.accountId, t.conversationKind, t.peerId),
    index("ix_qq_binding_agent").on(t.agentId, t.conversationKind, t.peerId),
  ],
);

// Observation provenance and persistent dedup. No message text is stored here.
export const qqEvents = sqliteTable(
  "qq_events",
  {
    eventKey: text("event_key").primaryKey(),
    accountId: text("account_id").notNull(),
    conversationKind: text("conversation_kind").notNull(),
    peerId: text("peer_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    occurredAtSeconds: integer("occurred_at_seconds").notNull(),
    speakerKind: text("speaker_kind").notNull(),
    speakerId: text("speaker_id"),
    recordedAt: text("recorded_at").notNull(),
    // 0027: was this message aimed at the assistant? Nullable: rows written before the column
    // have no answer, and "unknown" is read as "not addressed" (P5r).
    addressed: integer("addressed"),
  },
  (t) => [
    check("qq_event_kind", sql`${t.conversationKind} IN ('group', 'private')`),
    check("qq_event_message_id", sql`length(${t.messageId}) > 0`),
    check("qq_event_occurred_at", sql`${t.occurredAtSeconds} >= 0`),
    check("qq_event_speaker_kind", sql`${t.speakerKind} IN ('member', 'anonymous', 'system')`),
    check(
      "qq_event_speaker_identity",
      sql`(${t.speakerKind} = 'member') = (${t.speakerId} IS NOT NULL)`,
    ),
    index("ix_qq_event_conversation").on(
      t.accountId,
      t.conversationKind,
      t.peerId,
      t.occurredAtSeconds,
    ),
  ],
);

// Observation-backed memory provenance (0006_qq_memory_sources.sql, ADR0018).
// Web memory keeps using `memorySources` (a paired turn). The `event_key` reference
// is intentionally not cascading, so expiring observations cannot silently orphan a
// memory's provenance.
export const qqMemorySources = sqliteTable(
  "qq_memory_sources",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    eventKey: text("event_key")
      .notNull()
      .references(() => qqEvents.eventKey),
    scopeKey: text("scope_key").notNull(),
    conversationKey: text("conversation_key").notNull(),
    messageId: text("message_id").notNull(),
    occurredAtSeconds: integer("occurred_at_seconds").notNull(),
    speakerKind: text("speaker_kind").notNull(),
    speakerId: text("speaker_id"),
  },
  (t) => [
    check("qq_memory_source_message_id", sql`length(${t.messageId}) > 0`),
    check("qq_memory_source_occurred_at", sql`${t.occurredAtSeconds} >= 0`),
    check(
      "qq_memory_source_speaker_kind",
      sql`${t.speakerKind} IN ('member', 'anonymous', 'system')`,
    ),
    check(
      "qq_memory_source_speaker_identity",
      sql`(${t.speakerKind} = 'member') = (${t.speakerId} IS NOT NULL)`,
    ),
    primaryKey({ columns: [t.memoryId, t.eventKey] }),
    index("ix_qq_memory_source_event").on(t.eventKey),
  ],
);

// Message text for a QQ observation (0007_qq_observation_text.sql, ADR0018 P2d).
// Kept apart from `qqEvents` so the two-week retention window can delete a body
// without touching the permanent dedup identity or a memory's provenance.
export const qqObservationText = sqliteTable(
  "qq_observation_text",
  {
    eventKey: text("event_key")
      .primaryKey()
      .references(() => qqEvents.eventKey, { onDelete: "cascade" }),
    body: text("body").notNull(),
    occurredAtSeconds: integer("occurred_at_seconds").notNull(),
    expiresAt: text("expires_at").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [
    check("qq_observation_body", sql`length(trim(${t.body})) > 0`),
    check("qq_observation_occurred_at", sql`${t.occurredAtSeconds} >= 0`),
    index("ix_qq_observation_expiry").on(t.expiresAt),
  ],
);

// Mirrors `memoryProcessedTurns`: outlives the retention window on purpose, so a
// batch is not re-offered to consolidation after its text has expired.
export const qqProcessedEvents = sqliteTable("qq_processed_events", {
  eventKey: text("event_key")
    .primaryKey()
    .references(() => qqEvents.eventKey, { onDelete: "cascade" }),
  processedAt: text("processed_at").notNull(),
});

// The assistant's own utterances (0011_qq_speech_log.sql). `qq_events` holds only what
// other people said — the assistant's own messages arrive as `message_sent` and are
// dropped as `self_message` — so the "no reply, do not keep asking" rule needs its own
// record of when this assistant last spoke, and in which way. Text is deliberately not
// stored: the rule only needs order.
export const qqSpeechLog = sqliteTable(
  "qq_speech_log",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    conversationKind: text("conversation_kind").notNull(),
    peerId: text("peer_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    spokeAtSeconds: integer("spoke_at_seconds").notNull(),
    expiresAt: text("expires_at").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [
    check("qq_speech_conversation_kind", sql`${t.conversationKind} IN ('group', 'private')`),
    check(
      "qq_speech_kind",
      sql`${t.kind} IN ('direct_reply', 'follow_up', 'chiming_in', 'idle_topic')`,
    ),
    check("qq_speech_spoke_at", sql`${t.spokeAtSeconds} >= 0`),
    index("ix_qq_speech_conversation").on(
      t.accountId,
      t.conversationKind,
      t.peerId,
      t.agentId,
      t.spokeAtSeconds,
    ),
    index("ix_qq_speech_expiry").on(t.expiresAt),
  ],
);

// The assistant's own words (0016_qq_context_budget.sql, ADR0018 P3b-2). Kept apart from
// `qqSpeechLog` for the same reason observation text is kept apart from `qqEvents`: the log
// answers "did the assistant speak after us" and must keep answering it for the whole
// window, while the body may expire without touching that answer. Only delivered utterances
// have a row here — nobody saw what was never sent — and a sticker-only utterance writes no
// row at all, because there are no words to store.
export const qqSpeechText = sqliteTable(
  "qq_speech_text",
  {
    speechId: text("speech_id")
      .primaryKey()
      .references(() => qqSpeechLog.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    spokeAtSeconds: integer("spoke_at_seconds").notNull(),
    expiresAt: text("expires_at").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [
    check("qq_speech_text_body", sql`length(trim(${t.body})) > 0`),
    check("qq_speech_text_spoke_at", sql`${t.spokeAtSeconds} >= 0`),
    index("ix_qq_speech_text_expiry").on(t.expiresAt),
  ],
);

// Media attachments (0012_qq_media_notes.sql): what a picture or a voice message was read
// as, keyed by the message identity plus the segment's position. The bytes are not stored,
// only the upstream reference — the media cache stays a cache and can expire on the same
// window, because a written note no longer needs the file.
export const qqMediaNotes = sqliteTable(
  "qq_media_notes",
  {
    id: text("id").primaryKey(),
    eventKey: text("event_key")
      .notNull()
      .references(() => qqEvents.eventKey, { onDelete: "cascade" }),
    segmentIndex: integer("segment_index").notNull(),
    segmentKind: text("segment_kind").notNull(),
    sourceRef: text("source_ref").notNull(),
    note: text("note"),
    noteModel: text("note_model"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: text("expires_at").notNull(),
    recordedAt: text("recorded_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // 0026: was the carrying message addressed to the assistant? Nullable because rows that
    // predate the column have no answer, and "unknown" is read as "not addressed" (P5m).
    addressed: integer("addressed"),
  },
  (t) => [
    check("qq_media_addressed", sql`${t.addressed} IS NULL OR ${t.addressed} IN (0, 1)`),
    check("qq_media_segment_index", sql`${t.segmentIndex} >= 0`),
    check("qq_media_segment_kind", sql`${t.segmentKind} IN ('image', 'record', 'video', 'file')`),
    check("qq_media_source_ref", sql`length(trim(${t.sourceRef})) > 0`),
    check("qq_media_attempts", sql`${t.attempts} >= 0 AND ${t.attempts} <= 2`),
    // A note is model output and must name its model; §7.1 forbids an unattributed reading.
    check("qq_media_note_model", sql`${t.note} IS NULL OR ${t.noteModel} IS NOT NULL`),
    unique("uq_qq_media_segment").on(t.eventKey, t.segmentIndex),
    index("ix_qq_media_expiry").on(t.expiresAt),
  ],
);

// Send results for the assistant's own messages (0014_qq_send_log.sql, ADR0018 P4c).
// `qq_speech_log` records *that* the assistant spoke; this records what the platform
// actually accepted, part by part, which is what §8.2's rows are written about.
export const qqSendLog = sqliteTable(
  "qq_send_log",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    conversationKind: text("conversation_kind").notNull(),
    peerId: text("peer_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    outcome: text("outcome").notNull(),
    deliveryMessageId: text("delivery_message_id"),
    sentAtSeconds: integer("sent_at_seconds").notNull(),
    expiresAt: text("expires_at").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [
    check("qq_send_conversation_kind", sql`${t.conversationKind} IN ('group', 'private')`),
    check(
      "qq_send_kind",
      sql`${t.kind} IN ('direct_reply', 'follow_up', 'chiming_in', 'idle_topic')`,
    ),
    check(
      "qq_send_outcome",
      sql`${t.outcome} IN ('sent', 'partially_sent', 'sticker_failed', 'text_failed', 'unknown', 'not_submitted')`,
    ),
    check(
      "qq_send_delivery_message_id",
      sql`${t.deliveryMessageId} IS NULL OR length(${t.deliveryMessageId}) > 0`,
    ),
    check("qq_send_sent_at", sql`${t.sentAtSeconds} >= 0`),
    // A fully sent reply necessarily has a confirmed part, and only a reply with at
    // least one confirmed part can name a delivered message.
    check(
      "qq_send_delivery_requires_confirmed",
      sql`${t.outcome} <> 'sent' OR ${t.deliveryMessageId} IS NOT NULL`,
    ),
    check(
      "qq_send_delivery_only_when_delivered",
      sql`${t.deliveryMessageId} IS NULL OR ${t.outcome} IN ('sent', 'partially_sent')`,
    ),
    index("ix_qq_send_conversation").on(
      t.accountId,
      t.conversationKind,
      t.peerId,
      t.agentId,
      t.sentAtSeconds,
    ),
    index("ix_qq_send_expiry").on(t.expiresAt),
  ],
);

// One platform request inside an attempt. A platform id exists exactly when the platform
// confirmed that part: an id is never invented for a part whose fate is unknown, because
// §8.2 requires an unknown outcome to be assumed neither successful nor lost.
export const qqSendPart = sqliteTable(
  "qq_send_part",
  {
    sendId: text("send_id")
      .notNull()
      .references(() => qqSendLog.id, { onDelete: "cascade" }),
    partIndex: integer("part_index").notNull(),
    partKind: text("part_kind").notNull(),
    result: text("result").notNull(),
    platformMessageId: text("platform_message_id"),
    // 0022: which asset a sticker part carried, so §9.3's per-conversation history ("历史按群独立")
    // can be computed at all. Nullable because the column is appended to a table that may already
    // hold sticker parts: those rows keep the weaker fact they really have rather than an invented
    // id. The CHECK states only the direction that never depends on a backfill — a part carrying
    // words can never name a sticker.
    stickerId: text("sticker_id").references(() => qqStickerAssets.id),
  },
  (t) => [
    check("qq_send_part_index", sql`${t.partIndex} >= 0`),
    check("qq_send_part_kind", sql`${t.partKind} IN ('text', 'sticker')`),
    check(
      "qq_send_part_result",
      sql`${t.result} IN ('confirmed', 'failed', 'unknown', 'not_sent')`,
    ),
    check(
      "qq_send_part_platform_message_id",
      sql`${t.platformMessageId} IS NULL OR length(${t.platformMessageId}) > 0`,
    ),
    check(
      "qq_send_part_confirmed_identity",
      sql`(${t.result} = 'confirmed') = (${t.platformMessageId} IS NOT NULL)`,
    ),
    check(
      "qq_send_part_sticker_identity",
      sql`${t.stickerId} IS NULL OR ${t.partKind} = 'sticker'`,
    ),
    primaryKey({ columns: [t.sendId, t.partIndex] }),
  ],
);

// Member display names (0018_qq_members.sql, ADR0018 P3c). Not scoped by assistant on
// purpose: a nickname is a platform fact about a conversation, so scoping it by `agent_id`
// would let two assistants bound to the same group hold two different names for one person.
// Latest-seen semantics — a rename overwrites the row — and the row is keyed by the stable QQ
// number, so a rename can never split one person into two speakers in the timeline.
export const qqMembers = sqliteTable(
  "qq_members",
  {
    accountId: text("account_id").notNull(),
    conversationKind: text("conversation_kind").notNull(),
    peerId: text("peer_id").notNull(),
    userId: text("user_id").notNull(),
    nickname: text("nickname").notNull(),
    firstSeenAtSeconds: integer("first_seen_at_seconds").notNull(),
    lastSeenAtSeconds: integer("last_seen_at_seconds").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    check("qq_members_conversation_kind", sql`${t.conversationKind} IN ('group', 'private')`),
    check(
      "qq_members_nickname",
      sql`length(trim(${t.nickname})) > 0 AND length(${t.nickname}) <= 64`,
    ),
    check("qq_members_first_seen", sql`${t.firstSeenAtSeconds} >= 0`),
    check("qq_members_last_seen", sql`${t.lastSeenAtSeconds} >= 0`),
    check("qq_members_seen_order", sql`${t.lastSeenAtSeconds} >= ${t.firstSeenAtSeconds}`),
    primaryKey({ columns: [t.accountId, t.conversationKind, t.peerId, t.userId] }),
  ],
);

// The sticker library (0021_qq_stickers.sql, ADR0018 P4e). Three tables because the plan
// treats them as three separable things: a collection is what a scheme authorizes, an asset is
// the file plus its shared description, and membership ties the two. §9.1 lets one asset sit in
// several collections without duplicating file or description, so the split is load-bearing
// rather than cosmetic.
//
// `enabled` defaults to 0 and `descriptionDraft` lives in its own column: an import is
// deliberately not selectable, and a model's draft is deliberately not its description.
export const qqStickerCollections = sqliteTable(
  "qq_sticker_collections",
  {
    id: text("id").notNull().primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "qq_sticker_collection_name",
      sql`length(trim(${t.name})) > 0 AND length(${t.name}) <= 200`,
    ),
    check(
      "qq_sticker_collection_description",
      sql`${t.description} IS NULL OR length(${t.description}) <= 2000`,
    ),
    check("qq_sticker_collection_revision", sql`${t.revision} >= 1`),
    unique("uq_qq_sticker_collection_name").on(t.name),
  ],
);

export const qqStickerAssets = sqliteTable(
  "qq_sticker_assets",
  {
    id: text("id").notNull().primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    descriptionDraft: text("description_draft"),
    tags: text("tags"),
    /** §9.2's 标签草稿: the model's suggestion waits here until the user saves it. */
    tagsDraft: text("tags_draft"),
    usageNote: text("usage_note"),
    /** A generated file name inside the sticker directory — never a path (see the migration). */
    fileName: text("file_name").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    enabled: integer("enabled").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("qq_sticker_asset_name", sql`length(trim(${t.name})) > 0 AND length(${t.name}) <= 200`),
    check(
      "qq_sticker_asset_description",
      sql`${t.description} IS NULL OR length(${t.description}) <= 2000`,
    ),
    check(
      "qq_sticker_asset_description_draft",
      sql`${t.descriptionDraft} IS NULL OR length(${t.descriptionDraft}) <= 2000`,
    ),
    check(
      "qq_sticker_asset_usage_note",
      sql`${t.usageNote} IS NULL OR length(${t.usageNote}) <= 2000`,
    ),
    check(
      "qq_sticker_asset_file_name",
      sql`length(${t.fileName}) > 0 AND length(${t.fileName}) <= 120`,
    ),
    check("qq_sticker_asset_media_type", sql`${t.mediaType} IN ('image', 'animation')`),
    check("qq_sticker_asset_byte_size", sql`${t.byteSize} > 0`),
    check("qq_sticker_asset_width", sql`${t.width} IS NULL OR ${t.width} > 0`),
    check("qq_sticker_asset_height", sql`${t.height} IS NULL OR ${t.height} > 0`),
    // A half-read header would show "400 × ?"; refuse it instead of storing a partial size.
    check("qq_sticker_asset_dimensions", sql`(${t.width} IS NULL) = (${t.height} IS NULL)`),
    check("qq_sticker_asset_enabled", sql`${t.enabled} IN (0, 1)`),
  ],
);

// Membership only. §9.1's "移出集合只移除该归类" is therefore a row deletion that cannot touch
// the asset, and the (collection, asset) primary key is what keeps one asset from being counted
// twice inside a collection.
export const qqStickerCollectionItems = sqliteTable(
  "qq_sticker_collection_items",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => qqStickerCollections.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => qqStickerAssets.id),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.assetId] }),
    index("ix_qq_sticker_item_asset").on(t.assetId),
  ],
);

// A named chat scheme (0010_qq_schemes.sql). Identity and the confirmed groups:
// speech switches (0013), rhythm (0015), two context tiers (0016), editable prompts
// (0017), and configurable model output reserves (0019). Undecided §5.2 fields have
// no columns. Binding integrity (a binding must name an existing scheme, and an in-use scheme
// cannot be deleted) lives in table triggers, because it is a cross-table invariant that
// CHECK cannot express.
export const qqSchemes = sqliteTable(
  "qq_schemes",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // The four speech paths of 0013. They sit last because SQLite can only append a column,
    // so this is the order the table really has — declared in the same order the migration
    // produced, rather than in the order that reads best.
    triggerDirectReply: integer("trigger_direct_reply").notNull().default(0),
    triggerFollowUp: integer("trigger_follow_up").notNull().default(0),
    triggerChimingIn: integer("trigger_chiming_in").notNull().default(0),
    triggerIdleTopic: integer("trigger_idle_topic").notNull().default(0),
    // 0015, appended in the same migration order. Units are in the names because the plan
    // mixes seconds, minutes and clock values; a bare `window` would be read as whichever
    // unit the reader assumed.
    mergeWindowSeconds: integer("merge_window_seconds").notNull().default(30),
    replyCooldownSeconds: integer("reply_cooldown_seconds").notNull().default(10),
    hourlySpeechLimit: integer("hourly_speech_limit").notNull().default(200),
    idleQuietMinutes: integer("idle_quiet_minutes").notNull().default(15),
    // Not nullable by design: "not limited" is the flag being 0 with a placeholder window,
    // so a direct SQL write cannot record half a window.
    activeHoursEnabled: integer("active_hours_enabled").notNull().default(0),
    activeHoursStartMinutes: integer("active_hours_start_minutes").notNull().default(0),
    activeHoursEndMinutes: integer("active_hours_end_minutes").notNull().default(1439),
    maxRecomputeCount: integer("max_recompute_count").notNull().default(1),
    maxStickerCount: integer("max_sticker_count").notNull().default(1),
    // 0026: how long a failed addressed media read waits for a same-speaker supplement (§7.1).
    // 0 = do not wait (the first read still happens).
    mediaSupplementWindowMinutes: integer("media_supplement_window_minutes").notNull().default(10),
    // 0029: §7.1's 可改 sampling parameters, on the scheme beside the other numeric limits. The
    // defaults reproduce the fixed behaviour they replace. No token budget: P4d recorded that an
    // image's token count has no basis.
    mediaFrameCount: integer("media_frame_count").notNull().default(3),
    mediaMaxDimension: integer("media_max_dimension").notNull().default(512),
    // 0016, appended in the same migration order: the two context tiers §6.1 requires to be
    // configured separately. `*_token_budget` is in the project's estimator unit (UTF-8
    // bytes, see token-estimate.ts), the same yardstick the web context budgets use.
    judgementMessageLimit: integer("judgement_message_limit").notNull().default(20),
    judgementWindowMinutes: integer("judgement_window_minutes").notNull().default(60),
    judgementTokenBudget: integer("judgement_token_budget").notNull().default(2000),
    replyMessageLimit: integer("reply_message_limit").notNull().default(60),
    replyWindowMinutes: integer("reply_window_minutes").notNull().default(360),
    replyTokenBudget: integer("reply_token_budget").notNull().default(6000),
    // 0017, appended in the same migration order: the six editable prompts of §6.1 / §11.1.
    // Runtime defaults share constants with repository creation; committed migrations
    // remain frozen even when future product defaults change.
    promptScene: text("prompt_scene").notNull().default(QQ_PROMPT_DEFAULTS.scene),
    promptJudge: text("prompt_judge").notNull().default(QQ_PROMPT_DEFAULTS.judge),
    promptReply: text("prompt_reply").notNull().default(QQ_PROMPT_DEFAULTS.reply),
    promptReview: text("prompt_review").notNull().default(QQ_PROMPT_DEFAULTS.review),
    promptSticker: text("prompt_sticker").notNull().default(QQ_PROMPT_DEFAULTS.sticker),
    promptMedia: text("prompt_media").notNull().default(QQ_PROMPT_DEFAULTS.media),
    // 0019: model output reserves, independent of the two recent-message budgets.
    judgementOutputReserved: integer("judgement_output_reserved")
      .notNull()
      .default(QQ_MODEL_OUTPUT_RESERVE_DEFAULT.judgement_output_reserved),
    replyOutputReserved: integer("reply_output_reserved")
      .notNull()
      .default(QQ_MODEL_OUTPUT_RESERVE_DEFAULT.reply_output_reserved),
    // 0020: §9.3's repetition rules. In minutes and in utterances respectively, because those
    // are the units the two rules are written in; `0` is a real setting in both ("no minimum
    // spacing" / "do not avoid recent ones"), which is why neither column is nullable.
    stickerMinRepeatMinutes: integer("sticker_min_repeat_minutes")
      .notNull()
      .default(QQ_STICKER_DEDUP_DEFAULT.sticker_min_repeat_minutes),
    stickerRecentAvoidCount: integer("sticker_recent_avoid_count")
      .notNull()
      .default(QQ_STICKER_DEDUP_DEFAULT.sticker_recent_avoid_count),
    // 0034: the unprompted-speech threshold. The judge answers with an interest SCORE (0–10) and
    // this is the number it has to reach; 0 = "any readable score speaks", 10 = "almost never".
    // Kept beside the rhythm limits because it binds the same two initiative paths and nothing else.
    initiativeMinScore: integer("initiative_min_score")
      .notNull()
      .default(QQ_RHYTHM_DEFAULT.initiative_min_score),
    // 0036（用户 2026-09-25）：距上一次真跑判断之后又来多少条群友消息才再真跑一次；没到就拿最近
    // 一次的分数出来比较（`qq_judgement_readings`）。1＝来一条新消息就问一次。
    judgementIntervalTurns: integer("judgement_interval_turns")
      .notNull()
      .default(QQ_RHYTHM_DEFAULT.judgement_interval_turns),
    // 0035: 回复形状（用户 2026-09-25）。开（默认）＝不同人发的消息各写一条，回复任务用程序提供的
    // 「按发言人分条」文案；关＝用程序内置的默认回复文案。
    splitReplyBySpeaker: integer("split_reply_by_speaker")
      .notNull()
      .default(QQ_REPLY_DEFAULT.split_by_speaker ? 1 : 0),
  },
  (t) => [
    check("qq_scheme_name", sql`length(trim(${t.name})) > 0`),
    check("qq_scheme_revision", sql`${t.revision} >= 1`),
    check("qq_scheme_trigger_direct_reply", sql`${t.triggerDirectReply} IN (0, 1)`),
    check("qq_scheme_split_reply_by_speaker", sql`${t.splitReplyBySpeaker} IN (0, 1)`),
    check("qq_scheme_trigger_follow_up", sql`${t.triggerFollowUp} IN (0, 1)`),
    check("qq_scheme_trigger_chiming_in", sql`${t.triggerChimingIn} IN (0, 1)`),
    check("qq_scheme_trigger_idle_topic", sql`${t.triggerIdleTopic} IN (0, 1)`),
    check(
      "qq_scheme_merge_window",
      sql`${t.mergeWindowSeconds} >= 0 AND ${t.mergeWindowSeconds} <= 300`,
    ),
    check(
      "qq_scheme_reply_cooldown",
      sql`${t.replyCooldownSeconds} >= 1 AND ${t.replyCooldownSeconds} <= 600`,
    ),
    check(
      "qq_scheme_hourly_speech_limit",
      sql`${t.hourlySpeechLimit} >= 1 AND ${t.hourlySpeechLimit} <= 500`,
    ),
    check(
      "qq_scheme_idle_quiet_minutes",
      sql`${t.idleQuietMinutes} >= 1 AND ${t.idleQuietMinutes} <= 1000`,
    ),
    check("qq_scheme_active_hours_enabled", sql`${t.activeHoursEnabled} IN (0, 1)`),
    check(
      "qq_scheme_active_hours_start",
      sql`${t.activeHoursStartMinutes} >= 0 AND ${t.activeHoursStartMinutes} <= 1439`,
    ),
    check(
      "qq_scheme_active_hours_end",
      sql`${t.activeHoursEndMinutes} >= 0 AND ${t.activeHoursEndMinutes} <= 1439`,
    ),
    check(
      "qq_scheme_max_recompute_count",
      sql`${t.maxRecomputeCount} >= 0 AND ${t.maxRecomputeCount} <= 2`,
    ),
    check(
      "qq_scheme_max_sticker_count",
      sql`${t.maxStickerCount} >= 1 AND ${t.maxStickerCount} <= 3`,
    ),
    check(
      "qq_scheme_judgement_message_limit",
      sql`${t.judgementMessageLimit} >= 1 AND ${t.judgementMessageLimit} <= 200`,
    ),
    check(
      "qq_scheme_judgement_window_minutes",
      sql`${t.judgementWindowMinutes} >= 1 AND ${t.judgementWindowMinutes} <= 20160`,
    ),
    check(
      "qq_scheme_judgement_token_budget",
      sql`${t.judgementTokenBudget} >= 256 AND ${t.judgementTokenBudget} <= 16384`,
    ),
    check(
      "qq_scheme_reply_message_limit",
      sql`${t.replyMessageLimit} >= 1 AND ${t.replyMessageLimit} <= 500`,
    ),
    check(
      "qq_scheme_reply_window_minutes",
      sql`${t.replyWindowMinutes} >= 1 AND ${t.replyWindowMinutes} <= 20160`,
    ),
    check(
      "qq_scheme_reply_token_budget",
      sql`${t.replyTokenBudget} >= 256 AND ${t.replyTokenBudget} <= 16384`,
    ),
    // A prompt must be non-blank and bounded. Blank is not "no preference" — it is a model
    // with no instruction, which is why the request layer uses `nonBlankString` too and why
    // clearing a field by accident cannot silently drop a rule. The 16000 ceiling matches the
    // agent prompt fields, so the two editable prompt surfaces have the same limit.
    check(
      "qq_scheme_prompt_scene",
      sql`length(trim(${t.promptScene})) > 0 AND length(${t.promptScene}) <= 16000`,
    ),
    check(
      "qq_scheme_prompt_judge",
      sql`length(trim(${t.promptJudge})) > 0 AND length(${t.promptJudge}) <= 16000`,
    ),
    check(
      "qq_scheme_prompt_reply",
      sql`length(trim(${t.promptReply})) > 0 AND length(${t.promptReply}) <= 16000`,
    ),
    check(
      "qq_scheme_prompt_review",
      sql`length(trim(${t.promptReview})) > 0 AND length(${t.promptReview}) <= 16000`,
    ),
    check(
      "qq_scheme_prompt_sticker",
      sql`length(trim(${t.promptSticker})) > 0 AND length(${t.promptSticker}) <= 16000`,
    ),
    check(
      "qq_scheme_prompt_media",
      sql`length(trim(${t.promptMedia})) > 0 AND length(${t.promptMedia}) <= 16000`,
    ),
    check(
      "qq_scheme_judgement_output_reserved",
      sql`${t.judgementOutputReserved} >= 256 AND ${t.judgementOutputReserved} <= 16384`,
    ),
    check(
      "qq_scheme_reply_output_reserved",
      sql`${t.replyOutputReserved} >= 256 AND ${t.replyOutputReserved} <= 16384`,
    ),
    check(
      "qq_scheme_sticker_min_repeat",
      sql`${t.stickerMinRepeatMinutes} >= 0 AND ${t.stickerMinRepeatMinutes} <= 1440`,
    ),
    check(
      "qq_scheme_sticker_recent_avoid",
      sql`${t.stickerRecentAvoidCount} >= 0 AND ${t.stickerRecentAvoidCount} <= 20`,
    ),
    check(
      "qq_scheme_initiative_min_score",
      sql`${t.initiativeMinScore} >= 0 AND ${t.initiativeMinScore} <= 10`,
    ),
    check(
      "qq_scheme_judgement_interval",
      sql`${t.judgementIntervalTurns} >= 1 AND ${t.judgementIntervalTurns} <= 50`,
    ),
    unique("uq_qq_scheme_name").on(t.name),
  ],
);

// Which collections a scheme authorizes (0022_qq_sticker_authorization.sql).
//
// §9.1 makes the collection the unit of authorization and says "方案授权其中任一集合即可候选", so
// this is a set rather than a column: two schemes can share a collection, and one scheme can
// authorize several. The pair is the key, which is what keeps "authorize the same collection
// twice" from being two facts — the other half of §9.1's "同一素材只算一个候选".
export const qqSchemeStickerCollections = sqliteTable(
  "qq_scheme_sticker_collections",
  {
    schemeId: text("scheme_id")
      .notNull()
      .references(() => qqSchemes.id, { onDelete: "cascade" }),
    collectionId: text("collection_id")
      .notNull()
      .references(() => qqStickerCollections.id, { onDelete: "cascade" }),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schemeId, t.collectionId] }),
    // The reverse direction is §9.2's "展示影响的方案和群": enabling an asset asks which schemes
    // authorize the collections it sits in.
    index("ix_qq_scheme_sticker_collection").on(t.collectionId),
  ],
);

// P3 durable QQ dispatch. A single lease row bounds global QQ model concurrency; candidate
// rows hold only identities and clocks, never drafts or platform submission instructions.
export const qqDispatchSettings = sqliteTable(
  "qq_dispatch_settings",
  {
    id: integer("id").notNull().primaryKey(),
    leaseSeconds: integer("lease_seconds").notNull().default(120),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    check("qq_dispatch_settings_id", sql`${t.id} = 1`),
    check("qq_dispatch_settings_lease", sql`${t.leaseSeconds} BETWEEN 30 AND 600`),
    check("qq_dispatch_settings_revision", sql`${t.revision} >= 1`),
  ],
);

export const qqDispatchCandidates = sqliteTable(
  "qq_dispatch_candidates",
  {
    conversationKey: text("conversation_key").notNull().primaryKey(),
    bindingId: text("binding_id")
      .notNull()
      .references(() => qqBindings.id),
    eventKey: text("event_key").references(() => qqEvents.eventKey),
    path: text("path").notNull(),
    readyAtSeconds: integer("ready_at_seconds").notNull(),
    observedAtSeconds: integer("observed_at_seconds").notNull(),
    generation: integer("generation").notNull().default(1),
    claimedGeneration: integer("claimed_generation"),
  },
  (t) => [
    check("qq_dispatch_ready", sql`${t.readyAtSeconds} >= 0`),
    check("qq_dispatch_observed", sql`${t.observedAtSeconds} >= 0`),
    check("qq_dispatch_generation", sql`${t.generation} >= 1`),
    check(
      "qq_dispatch_path",
      sql`${t.path} IN ('direct_reply', 'follow_up', 'chiming_in', 'idle_topic')`,
    ),
    check(
      "qq_dispatch_claimed_generation",
      sql`${t.claimedGeneration} IS NULL OR (${t.claimedGeneration} >= 1 AND ${t.claimedGeneration} <= ${t.generation})`,
    ),
    index("ix_qq_dispatch_ready").on(t.readyAtSeconds, t.conversationKey),
  ],
);

export const qqDispatchLease = sqliteTable(
  "qq_dispatch_lease",
  {
    id: integer("id").notNull().primaryKey(),
    token: text("token"),
    conversationKey: text("conversation_key").references(
      () => qqDispatchCandidates.conversationKey,
    ),
    generation: integer("generation"),
    expiresAtSeconds: integer("expires_at_seconds"),
  },
  (t) => [
    check("qq_dispatch_lease_id", sql`${t.id} = 1`),
    check(
      "qq_dispatch_lease_shape",
      sql`(${t.token} IS NULL AND ${t.conversationKey} IS NULL AND ${t.generation} IS NULL AND ${t.expiresAtSeconds} IS NULL) OR (${t.token} IS NOT NULL AND length(${t.token}) > 0 AND ${t.conversationKey} IS NOT NULL AND ${t.generation} >= 1 AND ${t.expiresAtSeconds} >= 0)`,
    ),
  ],
);

// Why the quiet-room sweep left each conversation alone (0030_qq_sweep_verdicts.sql, §11.1/F11).
//
// One row per conversation, rewritten on every pass; a diagnostic record only. No foreign key to
// `qq_bindings`: the sweep reconciles the table against the bound conversations it just walked, so
// a row outliving its binding is impossible without the FK, and adding one would make unbinding a
// conversation a delete-order problem for no gain.
export const qqSweepVerdicts = sqliteTable(
  "qq_sweep_verdicts",
  {
    conversationKey: text("conversation_key").notNull().primaryKey(),
    conversationKind: text("conversation_kind").notNull(),
    peerId: text("peer_id").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    observedAtSeconds: integer("observed_at_seconds"),
    readyAtSeconds: integer("ready_at_seconds"),
    decidedAtSeconds: integer("decided_at_seconds").notNull(),
  },
  (t) => [
    check("qq_sweep_verdicts_kind", sql`${t.conversationKind} IN ('group', 'private')`),
    check("qq_sweep_verdicts_outcome", sql`${t.outcome} IN ('scheduled', 'skipped')`),
    check(
      "qq_sweep_verdicts_reason",
      sql`${t.reason} IS NULL OR ${t.reason} IN ('feature_off', 'conversation_paused', 'trigger_off', 'no_member_baseline', 'awaiting_reply', 'not_quiet_yet', 'cooling_down', 'hourly_limit', 'outside_active_hours', 'candidate_pending')`,
    ),
    check(
      "qq_sweep_verdicts_observed",
      sql`${t.observedAtSeconds} IS NULL OR ${t.observedAtSeconds} >= 0`,
    ),
    check("qq_sweep_verdicts_ready", sql`${t.readyAtSeconds} IS NULL OR ${t.readyAtSeconds} >= 0`),
    check("qq_sweep_verdicts_decided", sql`${t.decidedAtSeconds} >= 0`),
    check(
      "qq_sweep_verdicts_shape",
      sql`(${t.outcome} = 'scheduled' AND ${t.reason} IS NULL) OR (${t.outcome} = 'skipped' AND ${t.reason} IS NOT NULL)`,
    ),
    index("ix_qq_sweep_verdicts_decided").on(t.decidedAtSeconds, t.conversationKey),
  ],
);

/** All business tables, including additive knowledge library storage. */
// Desktop close preference (0025_desktop_settings.sql, §12) — single row.
//
// Only the two values the product can honour today: the "ask on close" member arrives with the
// host dialog that shows it. See the migration for why the default is 'exit'.
export const desktopSettings = sqliteTable(
  "desktop_settings",
  {
    id: integer("id").notNull().primaryKey(),
    closeAction: text("close_action").notNull(),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    check("desktop_settings_id", sql`${t.id} = 1`),
    check("desktop_settings_close_action", sql`${t.closeAction} IN ('background', 'exit')`),
    check("desktop_settings_revision", sql`${t.revision} >= 1`),
  ],
);

// 外部模型 API（0032，用户 2026-09-25）：OpenAI 兼容的额外模型来源。
//
// One row per provider: a base URL, its key as ciphertext, and the models this provider serves with
// the context window the user typed for each (external services rarely report one, and the capacity
// preflight refuses an unknown window rather than risk an over-window call).
export const modelProviders = sqliteTable(
  "model_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    // Ciphertext (AES-256-GCM, machine key file in the state directory). NULL = no key configured.
    apiKey: text("api_key"),
    // JSON array of `{ name, context_window }`. The contract owns the shape; SQL owns "valid JSON".
    models: text("models").notNull().default("[]"),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "model_providers_models",
      sql`json_valid(${t.models}) AND json_type(${t.models}) = 'array'`,
    ),
    check("model_providers_revision", sql`${t.revision} >= 1`),
    unique("uq_model_providers_name").on(t.name),
  ],
);

// 冷场判断的记忆（0033）：每个会话"上一轮安静判到哪个基准"。沉默是判断的一种结论，而它此前的
// 生命周期只有内存，于是定时扫描会拿着同一个基准反复判（每轮一次模型调用）。这张表让扫描在
// 基准没有前进时直接跳过；群里出现更新的群友消息时基准前进，判断自然恢复。
export const qqIdleJudgements = sqliteTable(
  "qq_idle_judgements",
  {
    conversationKey: text("conversation_key").primaryKey(),
    basisSeconds: integer("basis_seconds").notNull(),
    judgedAtSeconds: integer("judged_at_seconds").notNull(),
  },
  (t) => [
    check("qq_idle_judgements_basis", sql`${t.basisSeconds} >= 0`),
    check("qq_idle_judgements_judged", sql`${t.judgedAtSeconds} >= 0`),
  ],
);

// 判断读数（0036，用户 2026-09-25）：每会话一行"最近一次判断给出的分数"。判断模型每次问的是同一个
// 问题（"此刻这间会话值不值得开口"），短时间内的答案几乎不变，而每一次自主接话/冷场发起都要付一次
// 调用。有了这一行，两条主动路径在间隔没到时就拿它出来比门槛，不再花算力。只存分数与计数——模型给的
// 说明文字不落库；刻意不加指向 qq_bindings 的外键（与 0030 的裁决表同一处决定：守卫按会话收敛）。
export const qqJudgementReadings = sqliteTable(
  "qq_judgement_readings",
  {
    conversationKey: text("conversation_key").notNull(),
    // 判断现在是按发言人做的（0037）：每个群友一行自己的分数，所以主键是(会话, 发言人)。
    speakerId: text("speaker_id").notNull(),
    score: integer("score").notNull(),
    // 判断当时**这个人**在会话里的消息条数：0036 的"判断间隔"因此也是按人算的。
    basisEventCount: integer("basis_event_count").notNull(),
    judgedAtSeconds: integer("judged_at_seconds").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationKey, t.speakerId] }),
    check("qq_judgement_readings_score", sql`${t.score} >= 0 AND ${t.score} <= 10`),
    check("qq_judgement_readings_count", sql`${t.basisEventCount} >= 0`),
    check("qq_judgement_readings_judged", sql`${t.judgedAtSeconds} >= 0`),
  ],
);

// 0040–0041: canonical conversations and durable effects.
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey().notNull(),
  channel: text("channel").notNull(),
  topology: text("topology").notNull(),
  sourceId: text("source_id").notNull(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  bindingEpoch: integer("binding_epoch").notNull(),
  sourceWatermark: integer("source_watermark").notNull().default(0),
  nextSeq: integer("next_seq").notNull().default(1),
  consumedSeq: integer("consumed_seq").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  closedAt: text("closed_at"),
});

export const wakeSignals = sqliteTable("wake_signals", {
  id: text("id").primaryKey().notNull(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  cause: text("cause").notNull(),
  throughSeq: integer("through_seq").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  readyAt: text("ready_at").notNull(),
  priority: integer("priority").notNull(),
  status: text("status").notNull(),
  leaseToken: text("lease_token"),
  leaseExpiresAt: text("lease_expires_at"),
  attempts: integer("attempts").notNull().default(0),
  errorCode: text("error_code"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

// 0039: inference ownership and source-bound input snapshots.
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    runId: text("run_id").primaryKey().notNull(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    wakeId: text("wake_id").references(() => wakeSignals.id, { onDelete: "set null" }),
    observedSeq: integer("observed_seq"),
    specId: text("spec_id").notNull(),
    specVersion: text("spec_version").notNull(),
    ownerKind: text("owner_kind").notNull(),
    ownerId: text("owner_id").notNull(),
    userId: text("user_id"),
    agentId: text("agent_id"),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    errorCode: text("error_code"),
  },
  (t) => [
    index("ix_agent_runs_owner").on(t.ownerKind, t.ownerId, t.startedAt),
    index("ix_agent_runs_user").on(t.userId, t.startedAt),
    check(
      "agent_runs_status",
      sql`${t.status} IN ('prepared','deciding','observing','generating','completed','no_output','failed','cancelled')`,
    ),
  ],
);
export const agentSteps = sqliteTable(
  "agent_steps",
  {
    stepId: text("step_id").primaryKey().notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.runId, { onDelete: "cascade" }),
    stepNo: integer("step_no").notNull(),
    model: text("model").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    errorCode: text("error_code"),
    decision: text("decision"),
  },
  (t) => [
    unique("agent_steps_run_no").on(t.runId, t.stepNo),
    check("agent_steps_no", sql`${t.stepNo} > 0`),
    check("agent_steps_phase", sql`${t.phase} IN ('leaf','next','generate','vision')`),
    check("agent_steps_status", sql`${t.status} IN ('running','completed','failed','cancelled')`),
  ],
);
export const contextSnapshots = sqliteTable(
  "context_snapshots",
  {
    stepId: text("step_id")
      .primaryKey()
      .notNull()
      .references(() => agentSteps.stepId, { onDelete: "cascade" }),
    sourceRefs: text("source_refs").notNull(),
    layout: text("layout").notNull(),
    expiresAt: text("expires_at"),
    protectedMessages: text("protected_messages"),
    status: text("status").notNull(),
  },
  (t) => [
    index("ix_context_snapshots_expiry").on(t.expiresAt),
    check("context_snapshots_refs", sql`json_valid(${t.sourceRefs})`),
    check("context_snapshots_layout", sql`json_valid(${t.layout})`),
    check(
      "context_snapshots_messages",
      sql`${t.protectedMessages} IS NULL OR json_valid(${t.protectedMessages})`,
    ),
    check("context_snapshots_status", sql`${t.status} IN ('exact','expired','revoked')`),
  ],
);
export const runEvents = sqliteTable(
  "run_events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.runId, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    at: text("at").notNull(),
    payload: text("payload").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    check("run_events_seq", sql`${t.seq} > 0`),
    check("run_events_payload", sql`json_valid(${t.payload})`),
  ],
);

export const conversationEvents = sqliteTable(
  "conversation_events",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    eventKey: text("event_key").notNull(),
    kind: text("kind").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceRevision: text("source_revision").notNull(),
    sourceExpiresAt: text("source_expires_at"),
    sources: text("sources").notNull(),
    participant: text("participant"),
    addressing: text("addressing").notNull(),
    occurredAt: text("occurred_at").notNull(),
    recordedAt: text("recorded_at").notNull(),
    runId: text("run_id").references(() => agentRuns.runId, { onDelete: "set null" }),
    outputId: text("output_id"),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.seq] })],
);

export const outboundIntents = sqliteTable("outbound_intents", {
  id: text("id").primaryKey().notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.runId, { onDelete: "cascade" }),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  outputOrdinal: integer("output_ordinal").notNull(),
  target: text("target").notNull(),
  speechKind: text("speech_kind").notNull(),
  sourceThroughSeq: integer("source_through_seq").notNull(),
  deliverBy: text("deliver_by").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  legacySendId: text("legacy_send_id"),
});

export const outboundParts = sqliteTable("outbound_parts", {
  id: text("id").primaryKey().notNull(),
  intentId: text("intent_id")
    .notNull()
    .references(() => outboundIntents.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload"),
  status: text("status").notNull(),
  platformMessageId: text("platform_message_id"),
  attemptedAt: text("attempted_at"),
  finishedAt: text("finished_at"),
});

export const businessTables = {
  conversations,
  conversationEvents,
  wakeSignals,
  outboundIntents,
  outboundParts,
  agentRuns,
  agentSteps,
  contextSnapshots,
  runEvents,
  users,
  agents,
  agentPersonas,
  sessions,
  turns,
  messages,
  messageDeletionEvents,
  memoryPolicies,
  memorySessionStates,
  memoryEntries,
  memorySources,
  memoryLinks,
  memoryProcessedTurns,
  memoryJobs,
  sessionSummaries,
  summarySources,
  knowledgeSettings,
  knowledgeCategories,
  knowledgeDocuments,
  knowledgeGrants,
  knowledgeChunks,
  knowledgeDrafts,
  knowledgeJobs,
  turnKnowledgeSnapshots,
  agentKnowledgeReadSettings,
  organizationSettings,
  qqSettings,
  qqSchemes,
  qqOwnerIdentities,
  qqBindings,
  qqEvents,
  qqMemorySources,
  qqObservationText,
  qqProcessedEvents,
  qqSpeechLog,
  qqSpeechText,
  qqMediaNotes,
  qqSendLog,
  qqSendPart,
  qqMembers,
  qqStickerCollections,
  qqStickerAssets,
  qqStickerCollectionItems,
  qqSchemeStickerCollections,
  qqDispatchSettings,
  qqDispatchCandidates,
  qqDispatchLease,
  qqSweepVerdicts,
  desktopSettings,
  modelProviders,
  qqIdleJudgements,
  qqJudgementReadings,
} as const;

export type BusinessTables = typeof businessTables;
