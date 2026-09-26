import { z } from "zod";
import { ContextUsageSchema } from "./context-usage";
import { SourceRefSchema } from "./evidence";

export const ContextHandleSchema = z.strictObject({ runId: z.string(), stepId: z.string() });
export type ContextHandle = z.infer<typeof ContextHandleSchema>;
export const ModelContentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({
    kind: z.literal("image"),
    sourceId: z.string(),
    revision: z.string(),
    mimeType: z.string(),
    sha256: z.string(),
  }),
]);
export const ModelMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.array(ModelContentSchema),
});
export type ModelContent = z.infer<typeof ModelContentSchema>;
export type ModelMessage = z.infer<typeof ModelMessageSchema>;
export const RunOwnerSchema = z.strictObject({
  kind: z.string(),
  id: z.string(),
  userId: z.string().optional(),
  agentId: z.string().optional(),
});
export type RunOwner = z.infer<typeof RunOwnerSchema>;
export const RunStatusSchema = z.enum([
  "prepared",
  "deciding",
  "observing",
  "generating",
  "completed",
  "no_output",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const OutputSummarySchema = z.strictObject({
  outputId: z.string(),
  targetId: z.string(),
  status: z.enum(["prepared", "failed", "blocked"]),
  code: z.string().optional(),
});
export type OutputSummary = z.infer<typeof OutputSummarySchema>;
const envelope = {
  runId: z.string(),
  conversationId: z.string().optional(),
  seq: z.number().int().positive(),
  at: z.string(),
  dataStatus: z.enum(["expired", "revoked"]).optional(),
};
export const RunEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("context_usage"), usage: ContextUsageSchema }),
  z.strictObject({ ...envelope, type: z.literal("started"), requestId: z.string().optional() }),
  z.strictObject({
    ...envelope,
    type: z.literal("step"),
    stepId: z.string(),
    context: ContextHandleSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("action_result"),
    name: z.string(),
    observationId: z.string(),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("output_delta"),
    outputId: z.string(),
    text: z.string(),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("completed"),
    outputs: z.array(OutputSummarySchema),
    messageId: z.string().optional(),
    createdAt: z.string().optional(),
    completedAt: z.string().nullable().optional(),
  }),
  z.strictObject({ ...envelope, type: z.literal("no_output") }),
  z.strictObject({ ...envelope, type: z.literal("failed"), code: z.string() }),
  z.strictObject({ ...envelope, type: z.literal("cancelled") }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventPayload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, keyof typeof envelope>
    : never
  : never;
export const AgentStepSnapshotSchema = z.strictObject({
  stepId: z.string(),
  runId: z.string(),
  stepNo: z.number().int(),
  model: z.string(),
  phase: z.enum(["leaf", "next", "generate", "vision"]),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  context: ContextHandleSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export type AgentStepSnapshot = z.infer<typeof AgentStepSnapshotSchema>;
export const RunSnapshotSchema = z.strictObject({
  runId: z.string(),
  specId: z.string(),
  specVersion: z.string(),
  owner: RunOwnerSchema,
  status: RunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  steps: z.array(AgentStepSnapshotSchema),
  lastSeq: z.number().int().nonnegative(),
  outputs: z.array(OutputSummarySchema),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export const ContextLayoutSchema = z.array(
  z.strictObject({
    role: z.string(),
    sourceIds: z.array(z.string()),
    units: z.number().int().nonnegative(),
  }),
);
export const ProtectedModelOutputSchema = z.strictObject({
  text: z.string(),
  format: z.enum(["text", "json"]),
  complete: z.boolean(),
});
export type ProtectedModelOutput = z.infer<typeof ProtectedModelOutputSchema>;
export const InspectedModelResultSchema = z.strictObject({
  status: z.enum(["exact", "partial", "unavailable", "expired", "revoked"]),
  text: z.string().optional(),
  format: z.enum(["text", "json"]).optional(),
  reason: z.enum(["not_recorded", "pending", "no_response"]).optional(),
});
export type InspectedModelResult = z.infer<typeof InspectedModelResultSchema>;
export const InspectedContextSchema = z.strictObject({
  result: InspectedModelResultSchema,
  status: z.enum(["exact", "partial", "expired", "revoked"]),
  layout: ContextLayoutSchema,
  exactMessages: z.array(ModelMessageSchema).optional(),
  unavailableMedia: z
    .array(
      z.strictObject({
        sourceId: z.string(),
        sha256: z.string(),
        reason: z.literal("media_unavailable"),
      }),
    )
    .optional(),
  sourceVersions: z.array(z.strictObject({ id: z.string(), revision: z.string() })),
});
export type InspectedContext = z.infer<typeof InspectedContextSchema>;
export const StoredContextSchema = z.strictObject({
  handle: ContextHandleSchema,
  sources: z.array(SourceRefSchema),
  layout: ContextLayoutSchema,
  messages: z.array(ModelMessageSchema).nullable(),
  output: ProtectedModelOutputSchema.nullable(),
  outputRecorded: z.boolean(),
  expiresAt: z.string().nullable(),
  status: z.enum(["exact", "expired", "revoked"]),
});
export type StoredContext = z.infer<typeof StoredContextSchema>;
