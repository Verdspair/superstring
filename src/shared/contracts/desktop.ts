import { z } from "zod";

/**
 * Stored close preferences remain readable for existing installations.
 * Since 2026-10-08, an owned desktop window always exits its owned process tree;
 * the host ignores the legacy background preference without rewriting stored settings.
 * Non-window-owned hosts still use the stored preference.
 */
export const DesktopCloseActionSchema = z.enum(["background", "exit"]);
export type DesktopCloseAction = z.infer<typeof DesktopCloseActionSchema>;

export const DesktopSettingsSchema = z.strictObject({
  close_action: DesktopCloseActionSchema,
  revision: z.number().int().min(1),
});
export const DesktopSettingsUpdateSchema = z.strictObject({
  close_action: DesktopCloseActionSchema,
  expected_revision: z.number().int().min(1),
});
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;
export type DesktopSettingsUpdate = z.infer<typeof DesktopSettingsUpdateSchema>;
