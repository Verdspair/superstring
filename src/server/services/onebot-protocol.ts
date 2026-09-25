import { z } from "zod";

// External protocol types stay separate from published HTTP/Turn contracts.
// No sockets, storage, model calls, logging or automatic retries belong here.
const WireId = z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).transform((value) => {
  const text = String(value);
  const negative = text.startsWith("-");
  const digits = (negative ? text.slice(1) : text).replace(/^0+(?=\d)/, "");
  return negative && digits !== "0" ? `-${digits}` : digits;
});
const AccountId = WireId.refine((id) => id !== "0" && !id.startsWith("-"));

export function normalizeOneBotAccountId(input: unknown): string | null {
  const parsed = AccountId.safeParse(input);
  return parsed.success ? parsed.data : null;
}
const WireSegment = z.object({
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).nullable(),
});
const MessageEnvelope = z.object({
  time: z.number().int().nonnegative(),
  self_id: AccountId,
  post_type: z.enum(["message", "message_sent"]),
  message_type: z.enum(["group", "private"]),
  sub_type: z.string().min(1),
  message_id: WireId,
  user_id: AccountId,
  group_id: AccountId.optional(),
  anonymous: z.unknown().optional(),
  message: z.unknown(),
  sender: z.object({ nickname: z.string().optional(), card: z.string().optional() }).optional(),
});

export type QqSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; target: string }
  | { kind: "reply"; messageId: string }
  | { kind: "face"; id: string }
  | { kind: "image" | "record" | "video" | "file"; file?: string; url?: string; name?: string }
  | { kind: "unsupported"; type: string };

export interface QqObservation {
  accountId: string;
  conversation: { kind: "group" | "private"; peerId: string; key: string };
  eventKey: string;
  messageId: string;
  occurredAtSeconds: number;
  subType: string;
  speaker: {
    kind: "member" | "anonymous" | "system";
    id: string | null;
    displayName: string | null;
  };
  segments: QqSegment[];
  /** Plain text only; not a substitute for the ordered, possibly media-only message. */
  text: string;
  mentionsSelf: boolean;
  /**
   * 这条消息在回复哪一条（QQ 的 reply 段带的消息 id）。规范化时总会填（没有就是 null），可缺省是
   * 为了让只关心别的字段的构造处不必补它；读取方一律按"没有"处理（`?? null`）。
   *
   * 它本身不改判定——"回复的是不是我们自己发的"要查发送台账，那一步在接入层做（见 `qq-intake.ts`）。
   */
  replyToMessageId?: string | null;
}

export type QqMessageResult =
  | { kind: "message"; observation: QqObservation }
  | { kind: "ignored"; reason: "not_message" | "self_message" | "account_mismatch" }
  | {
      kind: "invalid";
      reason:
        | "invalid_account"
        | "invalid_event"
        | "invalid_segments"
        | "unsupported_message_format";
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeSegment(value: z.infer<typeof WireSegment>): QqSegment | null {
  const data = value.data ?? {};
  switch (value.type) {
    case "text":
      return typeof data.text === "string" ? { kind: "text", text: data.text } : null;
    case "at": {
      if (data.qq === "all") return { kind: "mention", target: "all" };
      const id = AccountId.safeParse(data.qq);
      return id.success ? { kind: "mention", target: id.data } : null;
    }
    case "reply": {
      const id = WireId.safeParse(data.id);
      return id.success ? { kind: "reply", messageId: id.data } : null;
    }
    case "face": {
      const id = WireId.safeParse(data.id);
      return id.success ? { kind: "face", id: id.data } : null;
    }
    case "image":
    case "record":
    case "video":
    case "file": {
      // References only. Never dereference upstream URLs or local paths here.
      const media: QqSegment = { kind: value.type };
      for (const key of ["file", "url", "name"] as const) {
        if (data[key] !== undefined) {
          if (typeof data[key] !== "string") return null;
          media[key] = data[key];
        }
      }
      return media;
    }
    default:
      return { kind: "unsupported", type: value.type };
  }
}

/** Caller supplies the account verified by the connection identity handshake. */
export function normalizeOneBotMessage(input: unknown, expectedAccountId: string): QqMessageResult {
  const expected = AccountId.safeParse(expectedAccountId);
  if (!expected.success) return { kind: "invalid", reason: "invalid_account" };
  const raw = record(input);
  if (!raw) return { kind: "invalid", reason: "invalid_event" };
  if (raw.post_type !== "message" && raw.post_type !== "message_sent") {
    return { kind: "ignored", reason: "not_message" };
  }
  const parsed = MessageEnvelope.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", reason: "invalid_event" };
  const event = parsed.data;
  if (event.self_id !== expected.data) return { kind: "ignored", reason: "account_mismatch" };
  if (event.post_type === "message_sent" || event.user_id === event.self_id) {
    return { kind: "ignored", reason: "self_message" };
  }
  if (typeof event.message === "string") {
    return { kind: "invalid", reason: "unsupported_message_format" };
  }
  const array = z.array(WireSegment).safeParse(event.message);
  if (!array.success) return { kind: "invalid", reason: "invalid_segments" };
  const segments: QqSegment[] = [];
  for (const wire of array.data) {
    const segment = normalizeSegment(wire);
    if (!segment) return { kind: "invalid", reason: "invalid_segments" };
    segments.push(segment);
  }
  const kind = event.message_type;
  const peerId = kind === "group" ? event.group_id : event.user_id;
  if (!peerId) return { kind: "invalid", reason: "invalid_event" };
  const speakerKind =
    kind === "group" && event.sub_type === "notice"
      ? "system"
      : kind === "group" && (event.sub_type === "anonymous" || event.anonymous != null)
        ? "anonymous"
        : "member";
  const identity = ["qq", event.self_id, kind, peerId];
  return {
    kind: "message",
    observation: {
      accountId: event.self_id,
      conversation: { kind, peerId, key: JSON.stringify(identity) },
      eventKey: JSON.stringify([...identity, event.message_id]),
      messageId: event.message_id,
      occurredAtSeconds: event.time,
      subType: event.sub_type,
      speaker: {
        kind: speakerKind,
        id: speakerKind === "member" ? event.user_id : null,
        displayName:
          speakerKind === "member" ? event.sender?.card || event.sender?.nickname || null : null,
      },
      segments,
      text: segments.flatMap((segment) => (segment.kind === "text" ? [segment.text] : [])).join(""),
      mentionsSelf: segments.some(
        (segment) => segment.kind === "mention" && segment.target === event.self_id,
      ),
      replyToMessageId: segments.find((segment) => segment.kind === "reply")?.messageId ?? null,
    },
  };
}

export type OneBotSendReceipt =
  | { kind: "confirmed"; messageId: string }
  | { kind: "failed"; retcode: number }
  | { kind: "unknown"; reason: "async" | "malformed_receipt" | "missing_message_id" }
  | { kind: "unrelated" };

/** A matching echo correlates a request; it never authorizes resending that request. */
export function classifyOneBotSendReceipt(input: unknown, expectedEcho: string): OneBotSendReceipt {
  if (!expectedEcho) throw new TypeError("A non-empty request echo is required");
  const raw = record(input);
  if (!raw || raw.echo !== expectedEcho) return { kind: "unrelated" };
  if (raw.post_type !== undefined) return { kind: "unrelated" };
  if (!Number.isSafeInteger(raw.retcode)) return { kind: "unknown", reason: "malformed_receipt" };
  if (raw.status === "async" && raw.retcode === 1) return { kind: "unknown", reason: "async" };
  if (raw.status === "failed" && raw.retcode !== 0 && raw.retcode !== 1) {
    return { kind: "failed", retcode: raw.retcode as number };
  }
  if (raw.status !== "ok" || raw.retcode !== 0) {
    return { kind: "unknown", reason: "malformed_receipt" };
  }
  const id = WireId.safeParse(record(raw.data)?.message_id);
  return id.success
    ? { kind: "confirmed", messageId: id.data }
    : { kind: "unknown", reason: "missing_message_id" };
}

/** NapCat may reject authorization AFTER the WebSocket open event, without an echo. */
export function isOneBotAuthenticationFailure(input: unknown): boolean {
  const raw = record(input);
  return (
    raw !== null &&
    raw.post_type === undefined &&
    raw.status === "failed" &&
    (raw.retcode === 1401 || raw.retcode === 1403) &&
    (raw.echo === undefined || raw.echo === null || raw.echo === "")
  );
}
