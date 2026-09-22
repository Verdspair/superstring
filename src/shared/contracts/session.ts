import { z } from "zod";
import {
  IsoTimestampSchema,
  nonBlankString,
  ScopeSchema,
  SessionModeSchema,
  UuidSchema,
} from "./common";

/**
 * Session request & response contracts. Pure `zod` only.
 *
 * 36.
 */

export const CreateSessionRequestSchema = z.strictObject({
  title: nonBlankString(1, 200).default("新会话"),
  agent_id: UuidSchema.nullable().default(null),
  mode: SessionModeSchema.default("chat"),
  client_request_id: nonBlankString(1, 64).nullable().default(null),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const UpdateSessionRequestSchema = z.strictObject({
  title: nonBlankString(1, 200),
});

export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

/**
 * SessionResponse.
 * NOTE: `agent_id` is declared `str`; it is absent (no value) when no agent is bound
 * (api-contract.md §4.1 / 【待实测确认-1】). It is modelled
 * as `str` per the contract; see report for the open uncertainty.
 */
export const SessionResponseSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  agent_id: z.string(),
  mode: SessionModeSchema,
  config_version: z.number().int(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** Compact session option returned by the Agent-scoped memory panel. */
export const MemorySessionOptionSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
});

export type MemorySessionOption = z.infer<typeof MemorySessionOptionSchema>;

export const SessionScopeUpdateSchema = z.strictObject({
  scope: ScopeSchema,
});

export type SessionScopeUpdate = z.infer<typeof SessionScopeUpdateSchema>;
