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
    const row = this.db
      .query("SELECT kind,style,seed,revision FROM conversation_avatars WHERE conversation_id=?")
      .get(conversationId) as
      | (GeneratedAvatar & { revision: string })
      | {
          kind: "uploaded";
          style: null;
          seed: null;
          revision: string;
        }
      | null;
    if (!row) return null;
    return row.kind === "generated"
      ? { kind: "generated", style: row.style, seed: row.seed }
      : {
          kind: "uploaded",
          url: `/v2/conversations/${encodeURIComponent(conversationId)}/avatar?revision=${row.revision}`,
        };
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
