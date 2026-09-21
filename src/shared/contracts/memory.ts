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
 *
 * Source: api-contract.md §1.4, §3.8 (services/memory_contract.py), §4.7;
 * config-and-memory-contract.md §2.2.4, §4.3, §4.4.
 *
 * Every request schema is `extra="forbid"` (strictObject) and the UUID-list
 * fields enforce the source's de-duplication invariant (memory_contract.py:52-60).
 */

/** `request_key` shape shared by ConsolidateRequest / MergeRequest (memory_contract.py:39-49, :63-65). */
const REQUEST_KEY_REGEX = /^[A-Za-z0-9_-]+$/;

const RequestKeySchema = z
  .string()
  .regex(REQUEST_KEY_REGEX, "request_key 只能含字母、数字、下划线或连字符")
  .min(1)
  .max(64);

/**
 * PolicyUpdate (memory_contract.py:28-32). Strict ints for `every_turns`
 * (1..200) and `target_chars` (50..4000); `expected_version` is the optimistic
 * lock (ge=1).
 *
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

/** ConsolidateRequest (memory_contract.py:39-49): manual consolidate job. */
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
 * MemorySelection (memory_contract.py:52-60) — the shared base for
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

/** MergeRequest (memory_contract.py:63-65): merge >= 2 entries into one. */
export const MergeRequestSchema = z.strictObject({
  request_key: RequestKeySchema,
  memory_ids: MergeIdsSchema,
});

export type MergeRequest = z.infer<typeof MergeRequestSchema>;

/**
 * GovernRequest (memory_contract.py:68-76). Inherits `memory_ids` from
 * MemorySelection, so the field is REQUIRED — omitting it is a 422, not a
 * default. `purge` additionally requires `confirm_permanent === true`,
 * otherwise the source raises `完全删除需要明确确认`.
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
  // Python stores `config_snapshot` as a dict and the API returns the parsed
  // object (api/memories.py:93-95; db/memory_repository.py stores
  // `config_snapshot=snapshot`, a Python dict). The TS port persists it as a
  // JSON *string*, so the route must `JSON.parse` it back into an object.
  // `null` when no snapshot was captured. We type it as unknown|null to accept
  // any nested object shape without over-constraining.
  config_snapshot: z.unknown().nullable(),
});

export type MemoryEntryResponse = z.infer<typeof MemoryEntryResponseSchema>;

/**
 * job_view (api-contract.md §1.4, api/memories.py:25-28).
 *
 * `session_id` is NULLABLE: a merge job has no session (`api/memories.py:107-110`
 * enqueues it without one, and `MemoryJob.session_id` is `nullable=True` in
 * `db/models.py`). Modelling it as required would reject every merge job.
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

/** policy_view (api-contract.md §1.4, api/memories.py:20-22). */
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
