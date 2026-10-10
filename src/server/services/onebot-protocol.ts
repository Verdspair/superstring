import { z } from "zod";
import {
  OneBotAccountIdSchema as AccountId,
  OneBotWireIdSchema as WireId,
} from "../../shared/contracts/onebot-identity";

export { normalizeOneBotAccountId } from "../../shared/contracts/onebot-identity";

// External protocol types stay separate from published HTTP/Turn contracts.
// No sockets, storage, model calls, logging or automatic retries belong here.
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
  | {
      kind: "image" | "record" | "video" | "file";
      file?: string;
      url?: string;
      name?: string;
      /** 规格 §7.2：market face 三键（emoji_id+emoji_package_id+summary 同现且非空 string）
       * 是平台可靠表情证据；其余 wire 键（sub_type/subType/key/URL 模式等）不判分类。
       * 固定枚举值，不携带原始 wire 键。 */
      categoryEvidence?: "expression";
    }
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
    /**
     * 规格 §3.1 的双名字快照。两个字段区分三种状态：
     *   * `string`＝本次入站原值（trim 后非空）；
     *   * `null`＝上游**显式**提供但空白（群名片清空语义，不得沿用旧 card）；
     *   * `undefined`＝上游字段缺省（可用本地有效值并记录来源）。
     * 显式空白与缺省不能合并成一个值——读取方靠它决定"沿用本地旧值"还是"回退个人昵称"。
     */
    groupCard?: string | null;
    personalNickname?: string | null;
    /** 显示名的补齐来源：入站原值或本地回退。不混入权限，只作事实标注。 */
    nameSource?: "wire" | "local";
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

/** A name is usable only after trimming; wire length follows the existing 64-code-point rule. */
const NAME_MAX_CODE_POINTS = 64;

/**
 * 单个 wire 名字字段的三态（规格 §3.1）：
 *   * `undefined`＝字段缺省，或值超限不可核实（读取方可按规则取本地有效值）；
 *   * `null`＝字段到来但空白（显式清空）；
 *   * `string`＝trim 后的原值。
 */
function normalizeWireName(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  // 空白＝显式清空（null）；超限＝不可核实（按缺省 undefined，保留本地可核实的旧名字）。
  if (trimmed === "") return null;
  if ([...trimmed].length > NAME_MAX_CODE_POINTS) return undefined;
  return trimmed;
}

/**
 * 双名字 trim 选择（规格 §3.1）：群名片 trim 非空优先，否则个人昵称 trim 非空，否则没有名字。
 * `presence` 保留 wire 的"缺省 vs 显式空白"区分：`undefined`＝字段没来（可取本地有效值），
 * `null`＝字段来了但是空白（显式清空，群名片不得沿用旧值）。
 * 超过 64 码点的 wire 值**不可核实**：按"缺省"（undefined）处理而不是显式空白——清空会丢掉
 * 本地可核实的旧名字，超限值只是不能用，不是"用户把名字删了"。
 */
function wireNames(sender: { card?: string; nickname?: string } | undefined): {
  card: string | null | undefined;
  nickname: string | null | undefined;
  display: string | null;
} {
  const rawCard = sender?.card;
  const rawNickname = sender?.nickname;
  // card 字段没来时保留 undefined（缺省）；来了但空白显式置 null（清空）；超限按缺省。
  const card = normalizeWireName(rawCard);
  const nickname = normalizeWireName(rawNickname);
  const display = card ?? nickname ?? null;
  return { card, nickname, display };
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
      // 规格 §7.2 平台分类允许清单：NapCat market face 形态（emoji_id+emoji_package_id+
      // summary 三键同现且均为非空 string，报告 prime-platform-image-hint-plan.md §2/§4）。
      // 缺一不猜；sub_type/subType 数值跨实现语义不同源，不映射；其余未知键维持丢弃。
      if (
        value.type === "image" &&
        typeof data.emoji_id === "string" &&
        data.emoji_id.trim() !== "" &&
        typeof data.emoji_package_id === "string" &&
        data.emoji_package_id.trim() !== "" &&
        typeof data.summary === "string" &&
        data.summary.trim() !== ""
      ) {
        media.categoryEvidence = "expression";
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
  const names = wireNames(event.sender);
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
        // 双名字快照（规格 §3.1）：群名片与个人昵称分别保留，不再压成一份不可区分的显示名。
        // 缺省字段的键整个不出现（undefined ≠ null：缺省可取本地有效值，显式空白是清空）。
        // 匿名/系统发言人没有平台身份，也不携带双名字（明确"匿名，QQ号不可用"，§3.2）。
        ...(speakerKind === "member" && names.card !== undefined ? { groupCard: names.card } : {}),
        ...(speakerKind === "member" && names.nickname !== undefined
          ? { personalNickname: names.nickname }
          : {}),
        ...(speakerKind === "member"
          ? { nameSource: names.display !== null ? ("wire" as const) : ("local" as const) }
          : {}),
        displayName: speakerKind === "member" ? names.display : null,
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
