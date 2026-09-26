import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { imageSize } from "image-size";
import {
  AVATAR_MAX_DIMENSION,
  AVATAR_MAX_PIXELS,
  AVATAR_MEDIA_TYPES,
  AVATAR_UPLOAD_MAX_BYTES,
  type GeneratedAvatar,
  GeneratedAvatarSchema,
} from "../../shared/contracts/conversation-avatar";
import { visibleConversation } from "../agent/conversation-access";
import {
  type AvatarImage,
  ConversationAvatarRepository,
} from "../db/conversation-avatar-repository";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { parseBody, parseUuidParam, readJsonBody, validationFailed } from "./validation";

const notFound = { error: { code: "CONVERSATION_NOT_FOUND", message: "会话不存在或不可访问" } };

async function readImage(file: File): Promise<AvatarImage> {
  if (file.size === 0 || file.size > AVATAR_UPLOAD_MAX_BYTES) throw validationFailed();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const type = await fileTypeFromBuffer(bytes);
    if (!type || !AVATAR_MEDIA_TYPES.some((mime) => mime === type.mime)) throw validationFailed();
    const size = imageSize(bytes);
    if (
      !size.width ||
      !size.height ||
      size.width > AVATAR_MAX_DIMENSION ||
      size.height > AVATAR_MAX_DIMENSION ||
      size.width * size.height > AVATAR_MAX_PIXELS
    )
      throw validationFailed();
    return {
      bytes,
      mediaType: type.mime,
      width: size.width,
      height: size.height,
      revision: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    throw validationFailed();
  }
}

export function conversationAvatarRoutes(db: Database, includeShared = false): Hono {
  const router = new Hono();
  const journal = new ConversationEventRepository(db);
  const avatars = new ConversationAvatarRepository(db);
  const visible = (id: string) =>
    visibleConversation(db, journal, id, { userId: DEFAULT_USER_ID }, includeShared);
  router.get("/:id/avatar", (c) => {
    const conversation = visible(parseUuidParam(c.req.param("id")));
    if (!conversation) return c.json(notFound, 404);
    const image = avatars.image(conversation.id);
    if (
      !image ||
      (c.req.query("revision") !== undefined && c.req.query("revision") !== image.revision)
    )
      return c.notFound();
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        "content-type": image.mediaType,
        "content-length": String(image.bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
  router.put(
    "/:id/avatar",
    bodyLimit({
      maxSize: AVATAR_UPLOAD_MAX_BYTES + 64 * 1024,
      onError: () => {
        throw validationFailed();
      },
    }),
    async (c) => {
      const id = parseUuidParam(c.req.param("id"));
      if (!visible(id)) return c.json(notFound, 404);
      let value: GeneratedAvatar | AvatarImage | null;
      if (c.req.header("content-type")?.startsWith("multipart/form-data")) {
        let form: FormData;
        try {
          form = await c.req.raw.formData();
        } catch {
          throw validationFailed();
        }
        const file = form.get("file");
        if (!(file instanceof File) || [...form.keys()].length !== 1) throw validationFailed();
        value = await readImage(file);
      } else value = parseBody(GeneratedAvatarSchema.nullable(), await readJsonBody(c.req.raw));
      // Parsing a multipart image yields; a binding may have changed while awaiting bytes.
      const conversation = visible(id);
      if (!conversation) return c.json(notFound, 404);
      return c.json(avatars.save(conversation.id, value));
    },
  );
  return router;
}
