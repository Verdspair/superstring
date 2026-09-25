import { z } from "zod";

/**
 * What the desktop host should do when the last interface window closes (§12, U07).
 *
 * The user decided on 2026-09-24 that the answer is REMEMBERED and changeable in settings, and
 * that a "keep the app online in the background" answer must actually keep it online.
 *
 * Only two members exist: the plan's original "ask every time" needs a dialog, and the dialog is
 * the desktop host's (a C# launcher this tree cannot build or verify). A stored value no code path
 * can honour would be a setting that lies, so "ask" arrives together with the dialog, as one more
 * allowed member.
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
