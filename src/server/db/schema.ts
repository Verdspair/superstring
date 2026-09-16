// Drizzle ORM schema for the 16 business tables, ported 1:1 from the inherited
// reference (Python + SQLAlchemy + MySQL/InnoDB) model to Drizzle + SQLite.
//
// Source of truth: docs/reference/data-model.md (golden). Every column name,
// type, NOT NULL, default, primary key, composite unique key, foreign key (with
// ON DELETE strategy) and CHECK constraint below mirrors that document. The
// authoritative DDL that actually builds the database is
// migrations/versions/0001_initial.sql — this file MUST stay in lock-step with
// it (see tests/integration/db-schema.test.ts for the drift guard).
//
// Type mapping (data-model.md §0):
//   String(N)/Text -> text()   -> TEXT
//   Integer/BigInteger -> integer() -> INTEGER (SQLite INTEGER is 8 bytes)
//   Float -> real() -> REAL
//   Boolean -> integer() -> INTEGER 0/1, CHECK IN (0,1)
//   JSON -> text() -> TEXT (JSON string, see json-text.ts)
//   DATETIME(fsp=6) -> text() -> TEXT ISO8601 with microseconds (app-generated)
//
// MySQL InnoDB / charset / collate table options are all dropped (data-model.md §0).

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
    body: text("body").notNull(), // Markdown TEXT (models.py: MemoryEntry.body)
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

/** Ordered list of all 16 business tables, grouped by schema.ts export name. */
export const businessTables = {
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
} as const;

export type BusinessTables = typeof businessTables;
