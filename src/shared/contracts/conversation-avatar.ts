import { z } from "zod";

export const AVATAR_STYLES = [
  "shapes",
  "rings",
  "pixel-art",
  "lorelei",
  "notionists",
  "thumbs",
] as const;
export const AVATAR_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const AVATAR_MAX_DIMENSION = 8192;
export const AVATAR_MAX_PIXELS = 40_000_000;
export const AVATAR_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const GeneratedAvatarSchema = z.strictObject({
  kind: z.literal("generated"),
  style: z.enum(AVATAR_STYLES),
  seed: z.string().min(1).max(128),
});
export const ConversationAvatarSchema = z
  .union([
    GeneratedAvatarSchema,
    z.strictObject({
      kind: z.literal("uploaded"),
      url: z.string().startsWith("/v2/conversations/"),
    }),
  ])
  .nullable();
export type GeneratedAvatar = z.infer<typeof GeneratedAvatarSchema>;
export type ConversationAvatar = z.infer<typeof ConversationAvatarSchema>;
