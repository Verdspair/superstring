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

export const QqManagedDiagnosticCodeSchema = z.enum([
  "process_crashed",
  "spawn_failed",
  "stop_failed",
  "handshake_timeout",
  "control_unavailable",
  "challenge_required",
  "account_mismatch",
]);

export const QqManagedStatusSchema = z.discriminatedUnion("apply", [
  z.strictObject({
    process: z.literal("unavailable"),
    apply: z.literal("blocked"),
    unavailable_reason: z.enum(["management_not_configured", "native_validation_required"]),
  }),
  z.strictObject({
    process: z.enum(["disabled", "stopped", "starting", "running", "stopping", "failed"]),
    apply: z.literal("ready"),
    ownership: z.enum(["none", "external", "owned"]),
    phase: z.enum([
      "stopped",
      "starting",
      "waiting_scan",
      "waiting_confirm",
      "core_online",
      "transport_ready",
      "challenge",
      "error",
    ]),
    core_ready: z.boolean(),
    transport_phase: z.enum(["unavailable", "idle", "connecting", "verifying", "ready", "closed"]),
    diagnostic_code: QqManagedDiagnosticCodeSchema.nullable(),
  }),
]);
export type QqManagedStatus = z.infer<typeof QqManagedStatusSchema>;

// QR data is returned only by the explicit, protected QR operation, never by status polling.
export const QqManagedQrSchema = z.strictObject({
  qr_payload: z.string().min(1).max(8192).nullable(),
});
export type QqManagedQr = z.infer<typeof QqManagedQrSchema>;
