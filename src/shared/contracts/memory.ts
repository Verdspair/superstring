import { z } from "zod";
import {
  GovernActionSchema,
  IsoTimestampSchema,
  MemoryEntryStatusSchema,
  MemoryJobStatusSchema,
  UuidSchema,
} from "./common";
import { MemorySummarySchema } from "./summary";

/**
 * Memory policy / entry / job / governance request & response contracts.
 * Pure `zod` only.
 * See api-contract.md §1.4, §3.8, §4.7;
 * config-and-memory-contract.md §2.2.4, §4.3, §4.4.
 * Every request schema is `extra="forbid"` (strictObject) and the UUID-list
 * fields enforce the contract's de-duplication invariant.
 */

/** `request_key` shape shared by ConsolidateRequest / MergeRequest (,:63-65). */
const REQUEST_KEY_REGEX = /^[A-Za-z0-9_-]+$/;

const RequestKeySchema = z
  .string()
  .regex(REQUEST_KEY_REGEX, "request_key 只能含字母、数字、下划线或连字符")
  .min(1)
  .max(64);

/**
 * PolicyUpdate. Strict ints for `every_turns`
 * (1..200) and `target_chars` (50..4000); `expected_version` is the optimistic
 * lock (ge=1).
 * `target_chars` default is 1200, not 300: it is the length a consolidated
 * memory aims for, and 300 characters cannot hold the facts a real session
 * produces — memories came out as one-liners. The 50..4000 range is unchanged.
 */
export const PolicyUpdateSchema = z.strictObject({
  auto_enabled: z.boolean(),
  every_turns: z.number().int().min(1).max(200).default(20),
  target_chars: z.number().int().min(50).max(4000).default(1200),
  expected_version: z.number().int().min(1),
});

export type PolicyUpdate = z.infer<typeof PolicyUpdateSchema>;

/** ConsolidateRequest: manual consolidate job. */
export const ConsolidateRequestSchema = z.strictObject({
  request_key: RequestKeySchema,
  session_id: UuidSchema,
  turn_ids: z
    .array(UuidSchema)
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, "turn_ids 不可重复"),
});

export type ConsolidateRequest = z.infer<typeof ConsolidateRequestSchema>;

/**
 * MemorySelection — the shared base for
 * MergeRequest and GovernRequest. 1..100 ids, de-duplicated.
 */
const MemoryIdsSchema = z
  .array(UuidSchema)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "memory_ids 不可重复");

/** MergeRequest narrows the same field to at least two entries. */
const MergeIdsSchema = z
  .array(UuidSchema)
  .min(2)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "memory_ids 不可重复");

/** MergeRequest: merge >= 2 entries into one. */
export const MergeRequestSchema = z.strictObject({
  request_key: RequestKeySchema,
  memory_ids: MergeIdsSchema,
});

export type MergeRequest = z.infer<typeof MergeRequestSchema>;

/**
 * GovernRequest. Inherits `memory_ids` from
 * MemorySelection, so the field is REQUIRED — omitting it is a 422, not a
 * default. `purge` additionally requires `confirm_permanent === true`
 * otherwise the contract raises `完全删除需要明确确认`.
 */
export const GovernRequestSchema = z
  .strictObject({
    memory_ids: MemoryIdsSchema,
    action: GovernActionSchema,
    confirm_permanent: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.action === "purge" && v.confirm_permanent !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "完全删除需要明确确认",
        path: ["confirm_permanent"],
      });
    }
  });

export type GovernRequest = z.infer<typeof GovernRequestSchema>;

export const MemoryAccessMetadataSchema = z.strictObject({
  visibility: z.enum(["session_private", "agent_shared", "public"]).nullable(),
  visibility_revision: z.number().int().positive(),
  recipient_agent_ids: z.array(UuidSchema),
  origins: z.array(
    z.strictObject({
      channel: z.enum(["web", "onebot11", "unknown"]),
      conversation_id: UuidSchema.nullable(),
    }),
  ),
  origin_complete: z.boolean(),
  source_validity: z.enum(["valid", "invalid", "unknown"]),
  runtime_eligibility: z.enum(["available", "unavailable", "unknown"]),
  raw_preview: z.enum(["available", "unavailable", "unknown"]),
});
export type MemoryAccessMetadata = z.infer<typeof MemoryAccessMetadataSchema>;

export interface MemoryManagementQuery {
  offset?: number;
  limit?: number;
  view?: "owned" | "received" | "all";
  origin_conversation_id?: string;
  conversation_id?: string;
  visibility?: "session_private" | "agent_shared" | "public" | "unclassified";
  scope_key?: string;
  search?: string;
  status?: "active" | "suppressed" | "replaced" | "invalid";
}
export const MemoryManagementEntrySchema = MemorySummarySchema.extend({
  owner_agent_id: UuidSchema,
  ...MemoryAccessMetadataSchema.shape,
});
export type MemoryManagementEntry = z.infer<typeof MemoryManagementEntrySchema>;
export const MemoryManagementListSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  items: z.array(MemoryManagementEntrySchema),
});
export type MemoryManagementList = z.infer<typeof MemoryManagementListSchema>;

export const MemoryReadablePageSchema = z.strictObject({
  id: UuidSchema,
  owner_agent_id: UuidSchema,
  reader_agent_id: UuidSchema,
  conversation_id: UuidSchema,
  name: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  content_origin: z.enum(["derived", "manual_correction"]),
  revision: z.string(),
  text: z.string(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type MemoryReadablePage = z.infer<typeof MemoryReadablePageSchema>;
export const MemorySourcePreviewItemSchema = z.strictObject({
  source_key: z.string().nullable(),
  channel: z.enum(["web", "onebot11", "unknown"]),
  state: z.enum(["available", "unavailable", "unknown"]),
  reason: z.string().nullable(),
  conversation_id: UuidSchema.nullable(),
  revision: z.string().nullable(),
  expires_at: z.string().nullable(),
  participant: z.string().nullable(),
  occurred_at: z.string().nullable(),
});
export const MemorySourcePreviewListSchema = z.strictObject({
  memory_id: UuidSchema,
  entry_revision: z.string(),
  source_validity: z.enum(["valid", "invalid", "unknown"]),
  raw_preview: z.enum(["available", "unavailable", "unknown"]),
  checked_sources: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  items: z.array(MemorySourcePreviewItemSchema),
});
export type MemorySourcePreviewList = z.infer<typeof MemorySourcePreviewListSchema>;
export const MemorySourcePreviewPageSchema = z.strictObject({
  memory_id: UuidSchema,
  source_key: z.string(),
  conversation_id: UuidSchema,
  revision: z.string(),
  expires_at: z.string().nullable(),
  content_origin: z.literal("original"),
  corrected: z.boolean(),
  text: z.string(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type MemorySourcePreviewPage = z.infer<typeof MemorySourcePreviewPageSchema>;

export const MemoryVisibilityUpdateSchema = z.strictObject({
  revalidate_publication: z.boolean().optional(),
  expected_revision: z.number().int().positive(),
  visibility: z.enum(["session_private", "agent_shared", "public"]),
  recipient_agent_ids: z.array(UuidSchema).refine((ids) => new Set(ids).size === ids.length),
});
export type MemoryVisibilityUpdate = z.infer<typeof MemoryVisibilityUpdateSchema>;

export const MemoryVisibilityResponseSchema = z.strictObject({
  visibility: z.enum(["session_private", "agent_shared", "public"]),
  visibility_revision: z.number().int().positive(),
  recipient_agent_ids: z.array(UuidSchema),
});
export type MemoryVisibilityResponse = z.infer<typeof MemoryVisibilityResponseSchema>;

export const MemorySearchRebuildSchema = z.strictObject({
  after_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(300),
});

/** Memory entry detail view (api-contract.md §1.4 route 28). */
export const MemoryEntryResponseSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  kinds: z.array(z.string()),
  body: z.string(),
  status: MemoryEntryStatusSchema,
  scope: z.string(),
  scope_key: z.string(),
  created_at: IsoTimestampSchema,
  // The config snapshot is persisted as a JSON *string*, so the route must
  // `JSON.parse` it back into an object. `null` when no snapshot was captured.
  // Typed as unknown|null to accept any nested object shape without
  // over-constraining.
  config_snapshot: z.unknown().nullable(),
});

export type MemoryEntryResponse = z.infer<typeof MemoryEntryResponseSchema>;

/**
 * job_view (api-contract.md §1.4).
 * `session_id` is NULLABLE: a merge job has no session (
 * enqueues it without one, and `MemoryJob.session_id` is `nullable=True` in
 * ). Modelling it as required would reject every merge job.
 */
export const MemoryJobViewSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  session_id: UuidSchema.nullable(),
  status: MemoryJobStatusSchema,
  result_id: z.string().nullable(),
  error_code: z.string().nullable(),
  created_at: IsoTimestampSchema,
  finished_at: IsoTimestampSchema.nullable(),
});

export type MemoryJobView = z.infer<typeof MemoryJobViewSchema>;

/** policy_view (api-contract.md §1.4). */
export const PolicyViewSchema = z.strictObject({
  auto_enabled: z.boolean(),
  every_turns: z.number().int().min(1).max(200),
  target_chars: z.number().int().min(50).max(4000),
  version: z.number().int().min(1),
});

export type PolicyView = z.infer<typeof PolicyViewSchema>;

/** `GET /entries` paginated list (api-contract.md §1.4 route 27). */
export const EntriesListSchema = z.strictObject({
  total: z.number().int().min(0),
  items: z.array(MemorySummarySchema),
});

export type EntriesList = z.infer<typeof EntriesListSchema>;

export type { MemoryReadSettings, ResolvedMemoryReadSettings } from "./memory-read-settings";
export { MemoryReadSettingsSchema, resolveMemoryReadSettings } from "./memory-read-settings";

export const MemoryScopeViewSchema = z.strictObject({
  scope_key: z.string(),
  count: z.number().int().nonnegative(),
  active_count: z.number().int().nonnegative(),
  read_scope_keys: z.array(z.string()).nullable(),
  write_scope_key: z.string(),
  pending: z.number().int().nonnegative().nullable(),
  binding: z
    .strictObject({
      id: UuidSchema,
      revision: z.number().int().positive(),
      memory_batch_size: z.number().int().positive().nullable(),
      paused: z.boolean(),
      enabled: z.boolean(),
    })
    .nullable(),
  latest_job: MemoryJobViewSchema.nullable(),
});
export type MemoryScopeView = z.infer<typeof MemoryScopeViewSchema>;
