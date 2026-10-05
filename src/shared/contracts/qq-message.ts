// QQ 消息事实、对话关系与消息设置契约（规格 §3–6）。
//
// 本文件是全部共享 QQ 消息类型的唯一来源：`QqTimeDisplay`/`QqReplyMode`/`QqMessageSettings`/
// `QqIdentity`/`QqMessagePart`/`QqMessageFact`/`QqConversationScope`/`QqMessageFocus` 的字段名
// 与字面量联合由实施计划 §2.3 逐字锁定，后续任务不得各自命名。
//
// 依赖方向（规格 §2.3 固定）：`SourceRef` 来自 `evidence.ts`；`QqImageCategory` 由
// `qq-media-input.ts` 唯一导出——这里只 `import type`，绝不 runtime import，避免循环。
// `QqMessageFact.id` 是稳定的内部事件/已确认发送部件 ID；平台 ID 保持原始字符串，可能为负数，
// 不能当 UUID。身份来源不接受 empty 字符串猜测：缺失就是缺失，不伪造。

import { z } from "zod";
import { type SourceRef, SourceRefSchema } from "./evidence";
import type { QqImageCategory } from "./qq-media-input";

// ---- 消息设置（方案级 message_settings 组） --------------------------------------------

/** 时间呈现：完整时间、完整＋相对时长、混合（默认）。 */
export const QqTimeDisplaySchema = z.enum(["full", "full_relative", "hybrid"]);
export type QqTimeDisplay = z.infer<typeof QqTimeDisplaySchema>;
/**
 * 引用展开模式：`one_then_on_demand`＝先给直接引用原文、更深层按需续读；
 * `configured_depth`＝按配置层数自动展开。`reply_depth` 在 one_then_on_demand 下不参与运行，
 * 但仍是合法设置（初值 2，边界 1–8）。
 */
export const QqReplyModeSchema = z.enum(["one_then_on_demand", "configured_depth"]);
export type QqReplyMode = z.infer<typeof QqReplyModeSchema>;

export interface QqMessageSettings {
  reply_mode: QqReplyMode;
  reply_depth: number;
  time_display: QqTimeDisplay;
  timezone: string;
}

/**
 * 时区必须是真实 IANA 名称（规格 §5「验证真实时区名称，不仅检查非空字符串」）。
 * 用运行环境自带的 ICU 数据验证，不维护自己的时区表。
 */
function isRealIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const QqMessageSettingsSchema = z.strictObject({
  reply_mode: QqReplyModeSchema,
  /** one_then_on_demand 下不参与运行，但仍是受验证的设置；1–8 层。 */
  reply_depth: z.number().int().min(1).max(8),
  time_display: QqTimeDisplaySchema,
  timezone: z
    .string()
    .min(1)
    .refine(isRealIanaTimeZone, { message: "timezone 必须是真实 IANA 时区名称" }),
});

/** 已批准默认值（规格 §5/§0.1，不随本任务更改）：混合时间、上海时区、按需引用、初值 2 层。 */
export const QQ_MESSAGE_SETTINGS_DEFAULT: Readonly<QqMessageSettings> = Object.freeze({
  reply_mode: "one_then_on_demand",
  reply_depth: 2,
  time_display: "hybrid",
  timezone: "Asia/Shanghai",
});

// ---- 身份与消息事实 --------------------------------------------------------------------

export interface QqIdentity {
  role: "member" | "anonymous" | "assistant";
  qq: string | null;
  groupCard: string | null;
  personalNickname: string | null;
  legacyDisplayName: string | null;
  nameState: "known" | "unknown" | "legacy";
  currentName?: {
    groupCard: string | null;
    personalNickname: string | null;
  };
}

const optionalNonEmptyString = z.string().min(1).nullable();

export const QqIdentitySchema = z.strictObject({
  role: z.enum(["member", "anonymous", "assistant"]),
  qq: optionalNonEmptyString,
  groupCard: optionalNonEmptyString,
  personalNickname: optionalNonEmptyString,
  legacyDisplayName: optionalNonEmptyString,
  nameState: z.enum(["known", "unknown", "legacy"]),
  currentName: z
    .strictObject({
      groupCard: optionalNonEmptyString,
      personalNickname: optionalNonEmptyString,
    })
    .optional(),
});

export type QqMessagePart =
  | { kind: "text"; text: string }
  | { kind: "mention"; qq: string | "all" }
  | { kind: "face"; id: string; name: string | null }
  | { kind: "image"; mediaId: string; category: QqImageCategory }
  | { kind: "unavailable"; type: string };

export const QqMessagePartSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({
    kind: z.literal("mention"),
    qq: z.union([z.string().min(1), z.literal("all")]),
  }),
  z.strictObject({
    kind: z.literal("face"),
    id: z.string().min(1),
    /** 名称不能核实就 null（「名称未知＋ID」），不填模型猜测的名称。 */
    name: z.string().min(1).nullable(),
  }),
  z.strictObject({
    kind: z.literal("image"),
    mediaId: z.string().min(1),
    category: z.enum(["ordinary", "expression", "unknown"]),
  }),
  z.strictObject({ kind: z.literal("unavailable"), type: z.string().min(1) }),
]);

export interface QqMessageFact {
  id: string;
  platformMessageId: string | null;
  seq: number;
  occurredAtSeconds: number;
  speaker: QqIdentity;
  parts: QqMessagePart[];
  mentions: Array<{ qq: string | "all"; identity: QqIdentity | null }>;
  replyTo: { platformMessageId: string } | null;
  sources: SourceRef[];
  completeness: "full" | "legacy_partial" | "unavailable";
}

export const QqMessageFactSchema = z.strictObject({
  id: z.string().min(1),
  platformMessageId: optionalNonEmptyString,
  seq: z.number().int().nonnegative(),
  occurredAtSeconds: z.number().int(),
  speaker: QqIdentitySchema,
  parts: z.array(QqMessagePartSchema),
  mentions: z.array(
    z.strictObject({
      qq: z.union([z.string().min(1), z.literal("all")]),
      identity: QqIdentitySchema.nullable(),
    }),
  ),
  replyTo: z.strictObject({ platformMessageId: z.string().min(1) }).nullable(),
  sources: z.array(SourceRefSchema),
  completeness: z.enum(["full", "legacy_partial", "unavailable"]),
});

// ---- 作用域与焦点 -----------------------------------------------------------------------

export interface QqConversationScope {
  conversationId: string;
  accountId: string;
  conversationKind: "group" | "private";
  peerId: string;
  agentId: string;
  bindingId: string;
  bindingEpoch: number;
  authorityRevision: number;
}

export const QqConversationScopeSchema = z.strictObject({
  conversationId: z.string().min(1),
  accountId: z.string().min(1),
  conversationKind: z.enum(["group", "private"]),
  peerId: z.string().min(1),
  agentId: z.string().min(1),
  bindingId: z.string().min(1),
  bindingEpoch: z.number().int().positive(),
  authorityRevision: z.number().int().positive(),
});

export interface QqMessageFocus {
  triggerMessageIds: string[];
  responseMessageIds: string[];
  responseQqs: string[];
  assistantQq: string;
}

export const QqMessageFocusSchema = z.strictObject({
  triggerMessageIds: z.array(z.string().min(1)),
  responseMessageIds: z.array(z.string().min(1)),
  responseQqs: z.array(z.string().min(1)),
  assistantQq: z.string().min(1),
});
