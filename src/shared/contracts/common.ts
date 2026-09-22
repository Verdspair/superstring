import { z } from "zod";
import { codePointLength, isBlank, unicodeStrip } from "./code-point-string";

/**
 * Cross-cutting primitives shared by every contract module.
 * This layer is transport-agnostic: it imports ONLY `zod`. It must never import
 * `bun`, `bun:sqlite`, `node:fs`, `drizzle`, `react`, or any server/browser
 * specific module. No business logic, no I/O — types and validation only.
 */

const UUID_BODY = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_FLAT = "[0-9a-fA-F]{32}";

/**
 * The UUID spellings the contract accepts. It does not merely check for the
 * canonical form — anything else is a 422 here. The accept/reject list below is
 * the frozen contract:
 * ACCEPT `8-4-4-4-12` (any case)
 * `{8-4-4-4-12}` (braces must be paired, body must keep its hyphens)
 * `urn:uuid:8-4-4-4-12` (prefix case-sensitive)
 * `32` flat hex (any case)
 * REJECT `urn:uuid:{...}` · braces around the flat form · mismatched braces
 * `URN:UUID:...` · `urn:...` · any surrounding or interior whitespace
 * partially placed hyphens · lengths other than 32/36
 */
export const UUID_REGEX = new RegExp(
  `^(?:(?:urn:uuid:)?${UUID_BODY}|\\{${UUID_BODY}\\}|${UUID_FLAT})$`,
);

/**
 * The id is parsed into a UUID, and every handler stores its canonical string form
 * i.e. lowercase 8-4-4-4-12, whatever spelling arrived.
 * Skipping this normalisation would let an uppercase or unhyphenated id pass
 * validation and then miss the row it names.
 */
export function normalizeUuid(value: string): string {
  const bare = value
    .replace(/^urn:uuid:/, "")
    .replace(/[{}]/g, "")
    .replace(/-/g, "")
    .toLowerCase();
  return [
    bare.slice(0, 8),
    bare.slice(8, 12),
    bare.slice(12, 16),
    bare.slice(16, 20),
    bare.slice(20, 32),
  ].join("-");
}

/** UUID serialised as a canonical 36-char lowercase string. */
export const UuidSchema = z
  .string()
  .regex(UUID_REGEX, "must be a UUID string")
  .transform(normalizeUuid);

export type Uuid = z.infer<typeof UuidSchema>;

/**
 * UTC ISO-8601 timestamp ending in `Z` and carrying fractional seconds
 * (microsecond precision, per the R2 data-contract requirement). Examples:
 * `2026-01-01T00:00:00.123456Z`, `2026-01-01T12:34:56.789Z`.
 */
export const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z$/;

export const IsoTimestampSchema = z
  .string()
  .regex(
    ISO_TIMESTAMP_REGEX,
    "must be an ISO-8601 UTC timestamp with fractional seconds, e.g. 2026-01-01T00:00:00.123456Z",
  );

export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/**
 * Bounded string primitives — one per validator shape.
 * The contract applies the min/max length bounds to the RAW input and only
 * THEN runs the field's post-validator, and each field picks its own
 * validator. A single "trim then bound" helper cannot express that, so there is
 * one helper per shape and every call site must choose explicitly:
 * rawString field has no validator at all — the value is stored verbatim
 * strippedString validator only strips; an empty result is fine
 * nonBlankString validator strips and then requires content (`_strip_required`)
 * updateString UpdateAgentRequest's `no_explicit_null`: null is a 422, and a
 * non-empty-but-blank value is a 422, but the value is NOT
 * stripped
 * optionalModelName `str | None` model names: null passes through, blank 422
 * Lengths are measured in CODE POINTS on the raw value (`codePointLength`). Zod 4
 * already counts code points, but going through `codePointLength`
 * keeps the order explicit and keeps this file independent of the Zod version.
 * Whitespace is `unicodeStrip` — never `String.prototype.trim()` (see code-point-string.ts).
 */

function lengthIssue(min: number, max: number): string {
  return `长度需在 ${min}~${max} 个字符之间`;
}

/** No strip, no blank rule — mirrors a field with no post-validator. */
export function rawString(minLength: number, maxLength: number): z.ZodType<string> {
  return z
    .string()
    .refine(
      (value) => codePointLength(value) >= minLength && codePointLength(value) <= maxLength,
      lengthIssue(minLength, maxLength),
    );
}

/** Raw length check, then `str.strip()` — an empty result is allowed. */
export function strippedString(minLength: number, maxLength: number): z.ZodType<string> {
  return z
    .string()
    .refine(
      (value) => codePointLength(value) >= minLength && codePointLength(value) <= maxLength,
      lengthIssue(minLength, maxLength),
    )
    .transform(unicodeStrip);
}

/** Raw length check, then strip, then require content (`_strip_required`). */
export function nonBlankString(minLength: number, maxLength: number): z.ZodType<string> {
  return z
    .string()
    .refine(
      (value) => codePointLength(value) >= minLength && codePointLength(value) <= maxLength,
      lengthIssue(minLength, maxLength),
    )
    .transform(unicodeStrip)
    .refine((value) => value !== "", "内容不能为空");
}

/**
 * UpdateAgentRequest string fields (`no_explicit_null`).
 * Explicit `null` is rejected; the raw length constraint already ran; a value
 * that is non-empty yet blank is rejected ("配置内容不能为空白"); everything else
 * is returned UNCHANGED — PATCH does not trim the values it stores.
 */
export function updateString(minLength: number, maxLength: number): z.ZodType<string> {
  return z
    .string()
    .refine(
      (value) => codePointLength(value) >= minLength && codePointLength(value) <= maxLength,
      lengthIssue(minLength, maxLength),
    )
    .refine((value) => value === "" || !isBlank(value), "配置内容不能为空白");
}

/**
 * `str | None` model name. `null` means "follow the conversation model"; a
 * blank string is a 422 in both the AgentConfig and the request variants.
 * `minLength` is 0 for the create/config shapes (the contract declares only a
 * max there) and 1 for the update shape.
 */
export function optionalModelName(
  maxLength: number,
  options: { minLength?: number } = {},
): z.ZodType<string | null> {
  const minLength = options.minLength ?? 0;
  return z
    .string()
    .refine(
      (value) => codePointLength(value) >= minLength && codePointLength(value) <= maxLength,
      lengthIssue(minLength, maxLength),
    )
    .transform(unicodeStrip)
    .refine((value) => value !== "", "模型名称不能是空字符串；使用 null 表示跟随对话模型")
    .nullable();
}

/** Message author role. */
export const RoleSchema = z.enum(["user", "assistant", "system"]);
export type Role = z.infer<typeof RoleSchema>;

/** Persisted message status. */
export const MessageStatusSchema = z.enum(["pending", "completed", "failed", "cancelled"]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

/** Turn generation status (API-internal but observable). */
export const GenerationStatusSchema = z.enum(["active", "completed", "failed", "cancelled"]);
export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;

/** Session interaction mode. */
export const SessionModeSchema = z.enum(["chat", "work"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

/** Memory scope. */
export const ScopeSchema = z.enum([
  "reality_user",
  "companion_relationship",
  "roleplay_world",
  "session_only",
]);
export type Scope = z.infer<typeof ScopeSchema>;

/** P5 context retrieval strength. */
export const RetrievalModeSchema = z.enum([
  "off",
  "conservative",
  "standard",
  "broad",
  "full_catalog",
  "full_body",
]);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;

/** Memory entry lifecycle status. */
export const MemoryEntryStatusSchema = z.enum(["active", "suppressed", "replaced", "invalid"]);
export type MemoryEntryStatus = z.infer<typeof MemoryEntryStatusSchema>;

/** Memory job status. */
export const MemoryJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type MemoryJobStatus = z.infer<typeof MemoryJobStatusSchema>;

/** Memory governance action. */
export const GovernActionSchema = z.enum(["suppress", "enable", "purge"]);
export type GovernAction = z.infer<typeof GovernActionSchema>;

/** Local LM Studio model catalog availability. */
export const LocalModelStatusSchema = z.enum(["available", "empty"]);
export type LocalModelStatus = z.infer<typeof LocalModelStatusSchema>;

/** `/models/capacity` probe status. */
export const ModelLoadStatusSchema = z.enum(["loaded", "unknown", "unavailable"]);
export type ModelLoadStatus = z.infer<typeof ModelLoadStatusSchema>;
