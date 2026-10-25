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
  "runtime_not_selected",
  "runtime_resources_invalid",
  "network_configuration_required",
  "network_apply_failed",
]);

const QqAccountIdSchema = z.string().regex(/^[1-9]\d*$/);
const QqAbsolutePathSchema = z
  .string()
  .refine((path) => path.trim().length > 0 && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path));

export const QqManagedResourceDiagnosticCodeSchema = z.enum([
  "runtime_not_selected",
  "runtime_descriptor_invalid",
  "runtime_resources_invalid",
  "runtime_platform_unsupported",
]);

export const QqManagedResourceSnapshotSchema = z.strictObject({
  revision: z.string(),
  status: z.enum(["missing", "invalid", "ready"]),
  root: QqAbsolutePathSchema.nullable(),
  diagnostic_code: QqManagedResourceDiagnosticCodeSchema.nullable(),
});
export type QqManagedResourceSnapshot = z.infer<typeof QqManagedResourceSnapshotSchema>;

export const UpdateQqManagedResourcesRequestSchema = z.strictObject({
  expected_revision: z.string(),
  root: QqAbsolutePathSchema,
});
export type UpdateQqManagedResourcesRequest = z.infer<typeof UpdateQqManagedResourcesRequestSchema>;

export const QqManagedAccountsSchema = z.strictObject({
  accounts: z.array(
    z.strictObject({
      account_id: QqAccountIdSchema,
      display_name: z.string().nullable(),
    }),
  ),
});
export type QqManagedAccounts = z.infer<typeof QqManagedAccountsSchema>;

export const QqManagedQuickLoginRequestSchema = z.strictObject({
  account_id: QqAccountIdSchema,
  expected_settings_revision: z.number().int().positive(),
});
export type QqManagedQuickLoginRequest = z.infer<typeof QqManagedQuickLoginRequestSchema>;

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
      "configuration_required",
      "applying_network",
      "transport_ready",
      "challenge",
      "error",
    ]),
    core_ready: z.boolean(),
    network_apply: z.enum(["not_configured", "pending", "verified", "failed", "not_owned"]),
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
