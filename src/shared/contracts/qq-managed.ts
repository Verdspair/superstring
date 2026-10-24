import { z } from "zod";

export const QqManagedConfigSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
});
export type QqManagedConfig = z.infer<typeof QqManagedConfigSchema>;

export const QqManagedConfigSnapshotSchema = z.strictObject({
  config: QqManagedConfigSchema,
  revision: z.string(),
});
export type QqManagedConfigSnapshot = z.infer<typeof QqManagedConfigSnapshotSchema>;

export const UpdateQqManagedConfigRequestSchema = z.strictObject({
  config: QqManagedConfigSchema,
  expected_revision: z.string(),
});
export type UpdateQqManagedConfigRequest = z.infer<typeof UpdateQqManagedConfigRequestSchema>;

// Native activation remains unavailable until package, profile and network apply are verified.
export const QqManagedStatusSchema = z.strictObject({
  process: z.literal("unavailable"),
  apply: z.literal("blocked"),
  unavailable_reason: z.enum(["management_not_configured", "native_validation_required"]),
});
export type QqManagedStatus = z.infer<typeof QqManagedStatusSchema>;
