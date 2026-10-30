import type { Database } from "bun:sqlite";
import type {
  ConversationAvatar,
  GeneratedAvatar,
} from "../../shared/contracts/conversation-avatar";

export interface AvatarImage {
  bytes: Uint8Array;
  mediaType: string;
  width: number;
  height: number;
  revision: string;
}

/** Callers resolve the current authorized history anchor before using this store. */
export class ConversationAvatarRepository {
  constructor(private readonly db: Database) {}

  metadata(conversationId: string): ConversationAvatar {
    return this.metadataMany([conversationId]).get(conversationId) ?? null;
  }

  metadataMany(conversationIds: readonly string[]): Map<string, ConversationAvatar> {
    const result = new Map<string, ConversationAvatar>();
    if (!conversationIds.length) return result;
    const rows = this.db
      .query(`SELECT conversation_id,kind,style,seed,revision
      FROM json_each(?) selected CROSS JOIN conversation_avatars avatar
      ON avatar.conversation_id=selected.value`)
      .all(JSON.stringify([...new Set(conversationIds)])) as ({
      conversation_id: string;
      revision: string;
    } & (GeneratedAvatar | { kind: "uploaded"; style: null; seed: null }))[];
    for (const row of rows)
      result.set(
        row.conversation_id,
        row.kind === "generated"
          ? { kind: "generated", style: row.style, seed: row.seed }
          : {
              kind: "uploaded",
              url: `/v2/conversations/${encodeURIComponent(row.conversation_id)}/avatar?revision=${row.revision}`,
            },
      );
    return result;
  }

  image(conversationId: string): AvatarImage | null {
    const row = this.db
      .query(
        "SELECT image_bytes,media_type,width,height,revision FROM conversation_avatars WHERE conversation_id=? AND kind='uploaded'",
      )
      .get(conversationId) as {
      image_bytes: Uint8Array;
      media_type: string;
      width: number;
      height: number;
      revision: string;
    } | null;
    return row
      ? {
          bytes: row.image_bytes,
          mediaType: row.media_type,
          width: row.width,
          height: row.height,
          revision: row.revision,
        }
      : null;
  }

  save(conversationId: string, value: GeneratedAvatar | AvatarImage | null): ConversationAvatar {
    if (value === null)
      this.db.query("DELETE FROM conversation_avatars WHERE conversation_id=?").run(conversationId);
    else {
      const generated = "kind" in value ? value : null;
      const image = "bytes" in value ? value : null;
      this.db
        .query(`INSERT INTO conversation_avatars(conversation_id,kind,style,seed,image_bytes,media_type,width,height,revision,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET
        kind=excluded.kind,style=excluded.style,seed=excluded.seed,image_bytes=excluded.image_bytes,
        media_type=excluded.media_type,width=excluded.width,height=excluded.height,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(
          conversationId,
          generated ? "generated" : "uploaded",
          generated?.style ?? null,
          generated?.seed ?? null,
          image?.bytes ?? null,
          image?.mediaType ?? null,
          image?.width ?? null,
          image?.height ?? null,
          image?.revision ?? crypto.randomUUID(),
          new Date().toISOString(),
        );
    }
    return this.metadata(conversationId);
  }
}
