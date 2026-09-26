// OneBot transport encoding and sticker bytes. Durable delivery lives in OutboundDelivery.
import { readQqStickerAsset } from "../db/qq-sticker-repository";
import type { Orm } from "../db/repositories";
import type { OneBotSendRequest, OneBotSendResult } from "./onebot-connection";
import type { QqStickerStore } from "./qq-sticker-store";

export interface QqSendPort {
  send(request: OneBotSendRequest): Promise<OneBotSendResult>;
}
export type QqStickerFileReference = (stickerId: string) => string | null;

export function qqTextSegments(
  text: string,
  mention: string | null = null,
): OneBotSendRequest["message"] {
  const pattern = /\[CQ:at,qq=(\d+)\]/g;
  const segments: OneBotSendRequest["message"] = [];
  // `@` 和后面那句话之间留一个空格，看起来自然些；后面本来就以空白开头就不重复加。
  // 只加在 `at` 与紧随其后的文字之间——单独一个 `at`（后面没有话）不补空格。
  const pushText = (value: string, afterMention: boolean) => {
    if (value.length === 0) return;
    segments.push({
      type: "text",
      data: { text: afterMention && !/^\s/.test(value) ? ` ${value}` : value },
    });
  };
  // 程序决定的收件人排在文字前面；`mention` 只可能是纯数字（消息行里的 speaker_id），所以不需要
  // 再做形状检查——它不来自模型。
  let afterMention = false;
  if (mention !== null && /^\d+$/.test(mention)) {
    segments.push({ type: "at", data: { qq: mention } });
    afterMention = true;
  }
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    pushText(text.slice(cursor, start), afterMention);
    segments.push({ type: "at", data: { qq: match[1] ?? "" } });
    afterMention = true;
    cursor = start + match[0].length;
  }
  pushText(text.slice(cursor), afterMention);
  // An `at` on its own is a mention the platform accepts; a text part must never come back empty.
  if (segments.length > 0) return segments;
  return [{ type: "text", data: { text } }];
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
