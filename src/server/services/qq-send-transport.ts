// OneBot transport encoding and sticker bytes. Durable delivery lives in OutboundDelivery.
import { readQqStickerAsset } from "../db/qq-sticker-repository";
import type { Orm } from "../db/repositories";
import type { OneBotSendRequest, OneBotSendResult } from "./onebot-connection";
import type { QqStickerStore } from "./qq-sticker-store";

export interface QqSendPort {
  send(request: OneBotSendRequest): Promise<OneBotSendResult>;
}
export type QqStickerFileReference = (stickerId: string) => string | null;

/** 一条文本部件落库后的内容；`mentions` 见 qqTextSegments 的两套线上语义。 */
export type QqTextPart = { text: string; mentions?: readonly string[] };

/**
 * 把一条文本部件变成平台段。
 *
 * 两套线上语义，由 `mentions` 是否存在决定（出站事实的读回也照这一支还原，发送与投影因此
 * 是同一个编码器）：
 *
 * - `mentions` 存在＝结构化协议，新提交恒写（可以为空数组）。正文按字面文本发送，`@` 只
 *   来自 `mentions` 的成员号；`legacyRecipient` 不参与——是否 @ 由模型决定。
 * - `mentions` 缺失＝变更前计划的旧部件，线上事实是：正文里的 CQ 码拆成 `at` 段，ordinal 0
 *   前置程序收件人（`legacyRecipient`）。按当时的编解码还原，不把历史的 `@` 重新解释掉。
 */
export function qqTextSegments(
  payload: QqTextPart,
  legacyRecipient: string | null = null,
): OneBotSendRequest["message"] {
  const segments: OneBotSendRequest["message"] = [];
  if (payload.mentions !== undefined) {
    if (payload.text.length > 0) segments.push({ type: "text", data: { text: payload.text } });
    for (const id of payload.mentions) {
      // 非纯数字的项是协议错误：宁可显式失败，也不猜一个目标或悄悄少 @ 一个人。
      if (!/^\d+$/.test(id)) throw new TypeError("Invalid mention id in reply payload");
      segments.push({ type: "at", data: { qq: id } });
    }
    // An `at` on its own is a mention the platform accepts; a text part must never come back empty.
    if (segments.length > 0) return segments;
    return [{ type: "text", data: { text: payload.text } }];
  }
  const pattern = /\[CQ:at,qq=(\d+)\]/g;
  // `@` 和后面那句话之间留一个空格，看起来自然些；后面本来就以空白开头就不重复加。
  // 只加在 `at` 与紧随其后的文字之间——单独一个 `at`（后面没有话）不补空格。
  const pushText = (value: string, afterMention: boolean) => {
    if (value.length === 0) return;
    segments.push({
      type: "text",
      data: { text: afterMention && !/^\s/.test(value) ? ` ${value}` : value },
    });
  };
  // 程序决定的收件人排在文字前面；`legacyRecipient` 只可能是纯数字（消息行里的 speaker_id），
  // 所以不需要再做形状检查——它不来自模型。
  let afterMention = false;
  if (legacyRecipient !== null && /^\d+$/.test(legacyRecipient)) {
    segments.push({ type: "at", data: { qq: legacyRecipient } });
    afterMention = true;
  }
  let cursor = 0;
  for (const match of payload.text.matchAll(pattern)) {
    const start = match.index ?? 0;
    pushText(payload.text.slice(cursor, start), afterMention);
    segments.push({ type: "at", data: { qq: match[1] ?? "" } });
    afterMention = true;
    cursor = start + match[0].length;
  }
  pushText(payload.text.slice(cursor), afterMention);
  if (segments.length > 0) return segments;
  return [{ type: "text", data: { text: payload.text } }];
}

export function qqStickerFileReference(orm: Orm, store: QqStickerStore): QqStickerFileReference {
  return (stickerId) => {
    const asset = readQqStickerAsset(orm, stickerId);
    if (!asset) return null;
    try {
      return `base64://${Buffer.from(store.readCopy(asset.fileName)).toString("base64")}`;
    } catch {
      // The copy was removed between the plan and the send; the part is recorded as `not_sent`.
      return null;
    }
  };
}
