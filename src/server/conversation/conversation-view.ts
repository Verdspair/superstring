import type { Database } from "bun:sqlite";
import type { ConversationEvent, ConversationEventView } from "../../shared/contracts/conversation";
import { bodyRevision } from "../db/conversation-event-repository";

/** Resolve current source bodies on demand. The journal is never a retention bypass. */
export function projectConversationEvent(
  db: Database,
  event: ConversationEvent,
  at = new Date().toISOString(),
): ConversationEventView {
  const base: ConversationEventView = {
    ...event,
    text: null,
    messageStatus: null,
    contentState: "unavailable",
    media: [],
    deliveryStatus: null,
  };
  const expired = (until: string | null | undefined) => !!until && until <= at;
  if (expired(event.source.expiresAt)) return { ...base, contentState: "expired" };
  if (event.source.kind === "web_message") {
    const m = db
      .query(
        "SELECT m.content,m.status,m.role,t.source_valid,t.context_valid,t.generation_status,t.cancel_requested,t.generation_token FROM messages m JOIN turns t ON t.id=m.turn_id WHERE m.id=?",
      )
      .get(event.source.id) as {
      content: string;
      status: string;
      source_valid: number;
      context_valid: number;
      role: string;
      generation_status: string;
      cancel_requested: number;
      generation_token: string | null;
    } | null;
    if (!m) return { ...base, contentState: "revoked" };
    if (
      m.status === "pending" ||
      bodyRevision(`${m.status}\0${m.content}`) !== event.source.revision
    )
      return { ...base, contentState: "unavailable" };
    return {
      ...base,
      text: m.content,
      contentState: "active",
      messageStatus: m.status as "completed" | "failed" | "cancelled",
    };
  }
  if (event.source.kind === "qq_event" || event.source.kind === "qq_observation") {
    const row = db
      .query(
        "SELECT t.body,t.expires_at FROM qq_events e LEFT JOIN qq_observation_text t ON t.event_key=e.event_key WHERE e.event_key=?",
      )
      .get(event.source.id) as { body: string | null; expires_at: string | null } | null;
    if (!row) return { ...base, contentState: "revoked" };
    const media = db
      .query(
        "SELECT id,segment_kind,note,expires_at FROM qq_media_notes WHERE event_key=? ORDER BY segment_index",
      )
      .all(event.source.id) as {
      id: string;
      segment_kind: string;
      note: string | null;
      expires_at: string;
    }[];
    base.media = media.map((m) => ({
      id: m.id,
      kind: m.segment_kind,
      description: expired(m.expires_at) ? null : m.note,
      availability: expired(m.expires_at) ? "expired" : m.note ? "available" : "unavailable",
    }));
    const stale =
      expired(row.expires_at) ||
      event.sources.some((s) => s.kind === "qq_observation" && expired(s.expiresAt));
    return {
      ...base,
      text: stale ? null : row.body,
      contentState: stale
        ? "expired"
        : row.body || base.media.some((m) => m.availability === "available")
          ? "active"
          : "unavailable",
    };
  }
  if (event.source.kind === "qq_media") {
    const m = db
      .query("SELECT id,segment_kind,note,expires_at,attempts FROM qq_media_notes WHERE id=?")
      .get(event.source.id) as {
      id: string;
      segment_kind: string;
      note: string | null;
      expires_at: string;
      attempts: number;
    } | null;
    if (!m) return { ...base, contentState: "expired" };
    if (expired(m.expires_at)) return { ...base, contentState: "expired" };
    if (String(m.attempts) !== event.source.revision) return base;
    return {
      ...base,
      text: m.note,
      contentState: m.note ? "active" : "unavailable",
      media: [
        {
          id: m.id,
          kind: m.segment_kind,
          description: m.note,
          availability: m.note ? "available" : "unavailable",
        },
      ],
    };
  }
  if (event.source.kind === "qq_speech") {
    const m = db
      .query(
        "SELECT t.body,l.expires_at FROM qq_speech_log l LEFT JOIN qq_speech_text t ON t.speech_id=l.id WHERE l.id=?",
      )
      .get(event.source.id) as { body: string | null; expires_at: string } | null;
    if (!m || expired(m.expires_at)) return { ...base, contentState: "expired" };
    return { ...base, text: m.body, contentState: "active", deliveryStatus: "confirmed" };
  }
  if (event.source.kind === "qq_send") {
    const m = db.query("SELECT * FROM qq_send_log WHERE id=?").get(event.source.id) as {
      account_id: string;
      conversation_kind: string;
      peer_id: string;
      agent_id: string;
      sent_at_seconds: number;
      expires_at: string;
      outcome: string;
    } | null;
    if (!m || expired(m.expires_at)) return { ...base, contentState: "expired" };
    const speech = event.sources.find((s) => s.kind === "qq_speech");
    const body = speech
      ? (db
          .query("SELECT body,expires_at FROM qq_speech_text WHERE speech_id=?")
          .get(speech.id) as { body: string; expires_at: string } | null)
      : null;
    const parts = db
      .query("SELECT sticker_id,result FROM qq_send_part WHERE send_id=? AND part_kind='sticker'")
      .all(event.source.id) as { sticker_id: string; result: string }[];
    return {
      ...base,
      text: body && !expired(body.expires_at) ? body.body : null,
      contentState: body && expired(body.expires_at) ? "expired" : "active",
      deliveryStatus:
        m.outcome === "sent" ? "confirmed" : m.outcome === "unknown" ? "unknown" : "failed",
      media: parts.map((p) => ({
        id: p.sticker_id,
        kind: "sticker",
        description: null,
        availability: p.result === "confirmed" ? "available" : "unavailable",
      })),
    };
  }
  if (event.source.kind === "outbound_intent") {
    const i = db
      .query("SELECT status,expires_at FROM outbound_intents WHERE id=?")
      .get(event.source.id) as {
      status: ConversationEventView["deliveryStatus"];
      expires_at: string;
    } | null;
    if (!i) return base;
    if (expired(i.expires_at))
      return { ...base, contentState: "expired", deliveryStatus: i.status };
    const parts = db
      .query("SELECT kind,payload,status FROM outbound_parts WHERE intent_id=? ORDER BY ordinal")
      .all(event.source.id) as { kind: string; payload: string | null; status: string }[];
    const words = parts
      .filter((p) => p.kind === "text" && p.status === "confirmed" && p.payload)
      .map((p) => (JSON.parse(p.payload!) as { text: string }).text);
    return {
      ...base,
      text: words.length ? words.join("\n") : null,
      contentState: "active",
      deliveryStatus: i.status,
      media: parts
        .filter((p) => p.kind === "sticker" && p.payload)
        .map((p) => ({
          id: (JSON.parse(p.payload!) as { stickerId: string }).stickerId,
          kind: "sticker",
          description: null,
          availability: p.status === "confirmed" ? "available" : "unavailable",
        })),
    };
  }
  if (event.kind === "wake") return { ...base, contentState: "active" };
  return base;
}
