// Test-only pre-cutover behavior oracle; never import from production.
// Delivering an authorized reply (ADR0018 §8.1/§8.2, P5o).
//
// Everything up to this point deliberately stopped short of the platform: the judgement, the draft,
// the review, the preflight and the commit guard all produce "this task was current and its facts
// still stand", never a platform request. This module is the only place that builds one — and it
// exists exactly where the plan puts the boundary: AFTER the commit guard authorized the task, so
// nothing here re-decides whether the reply may go out.
//
// Three rules are structural rather than commented:
//
//   * ONE request per part, in the plan's send order. §8.2 treats a mixed reply as
//     non-atomic — "已发文字、后续表情明确失败" is a real outcome — so the parts must be able to
//     succeed and fail independently, and each one lands in the ledger on its own row.
//   * A part that never left is `not_sent`, never `failed`. When the text does not reach the
//     platform, the sticker is NOT improvised into a sentence of its own (§8.1-6 forbids swapping
//     or rewriting); it is recorded as `not_sent` because that is the fact.
//   * The ledger is written by `recordQqSend`, which is also what turns a confirmed delivery into
//     the assistant's own speech record. A failure or an unknown result writes the ledger and
//     nothing else, and reports U13 as pending instead of answering it.

import { readQqBinding } from "../../../src/server/db/qq-binding-repository";
import {
  type QqSendPartInput,
  type QqSendRecord,
  recordQqSend,
} from "../../../src/server/db/qq-send-repository";
import { readQqStickerAsset } from "../../../src/server/db/qq-sticker-repository";
import type { Orm } from "../../../src/server/db/repositories";
import type {
  OneBotSendRequest,
  OneBotSendResult,
} from "../../../src/server/services/onebot-connection";
import type { QqPlannedOutput } from "../../../src/server/services/qq-output-plan";
import type { QqSpeechKind } from "../../../src/server/services/qq-speaking-contract";
import type { QqStickerStore } from "../../../src/server/services/qq-sticker-store";
import type { QqReplySender } from "./qq-dispatch-cycle";

/** The transport seam: the same call the connection already exposes. */
export interface QqSendPort {
  send(request: OneBotSendRequest): Promise<OneBotSendResult>;
}

/**
 * The sticker's file reference, or `null` when the copy is gone.
 *
 * `base64://` rather than a path on purpose: the bot side is often a container with a filesystem
 * of its own, and a path into this installation's private directory would resolve in one deployment
 * and not in the next. P6 has to confirm the spelling against a running NapCat; until then this is
 * the shape that does not depend on shared files.
 */
export type QqStickerFileReference = (stickerId: string) => string | null;

export interface QqPreparedSendInput {
  readonly scope: {
    readonly accountId: string;
    readonly conversationKind: "group" | "private";
    readonly peerId: string;
    readonly agentId: string;
  };
  readonly kind: QqSpeechKind;
  readonly plan: QqPlannedOutput;
  /** The draft's own words, or `null` for a sticker-only reply. */
  readonly text: string | null;
  readonly sentAtSeconds: number;
  /**
   * 这条消息回给谁（0037）：程序在文字前加一个 `at` 段，`@` 的对象由这一轮的任务决定，不是模型写的。
   * `null`／省略＝不加 `@`（冷场发起往安静的房间里开话题）。
   */
  readonly mention?: string | null;
}

/**
 * 一条文本部件怎么变成平台段。
 *
 * 0037：`@` 由**程序**加——`mention` 是这一轮任务的收件人（消息行里的发言人 ID，是事实），所以
 * 不可能 @ 错人。模型被明确要求不要自己写 @。
 *
 * 兜底仍然保留：万一文字里还是出现了 `[CQ:at,qq=号码]`（关掉开关的那条路径用的是程序默认文案，不讲
 * 这一套；或者模型没听劝），这里照旧把它拆成真正的 `at` 段。数组形态的 `message` **不会**解析文本里
 * 的 CQ 码，不拆的话群里看到的是一串字面量；只认纯数字，其余方括号内容原样当文本。
 */
export function qqTextSegments(
  text: string,
  mention: string | null = null,
): OneBotSendRequest["message"] {
  const pattern = /\[CQ:at,qq=(\d+)\]/g;
  const segments: OneBotSendRequest["message"] = [];
  // 程序决定的收件人排在文字前面；`mention` 只可能是纯数字（消息行里的 speaker_id），所以不需要
  // 再做形状检查——它不来自模型。
  if (mention !== null && /^\d+$/.test(mention)) {
    segments.push({ type: "at", data: { qq: mention } });
  }
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const head = text.slice(cursor, start);
    if (head.length > 0) segments.push({ type: "text", data: { text: head } });
    segments.push({ type: "at", data: { qq: match[1] ?? "" } });
    cursor = start + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail.length > 0) segments.push({ type: "text", data: { text: tail } });
  // An `at` on its own is a mention the platform accepts; a text part must never come back empty.
  if (segments.length > 0) return segments;
  return [{ type: "text", data: { text } }];
}

/** `null` when there was nothing to deliver (an abandoned plan), so the caller can say so. */
export async function sendQqPreparedReply(
  orm: Orm,
  ports: { send: QqSendPort["send"]; stickerFile: QqStickerFileReference },
  input: QqPreparedSendInput,
): Promise<QqSendRecord | null> {
  const parts: QqSendPartInput[] = [];
  // A previous part that did not reach the platform stops the rest: the remaining parts are
  // recorded as `not_sent`, which keeps "we chose not to" distinguishable from "it failed".
  let stopped = false;

  for (const [index, part] of input.plan.parts.entries()) {
    if (stopped) {
      parts.push({ kind: part.kind, result: "not_sent", messageId: null, ...stickerIdOf(part) });
      continue;
    }
    if (part.kind === "text") {
      const result = await ports.send({
        kind: input.scope.conversationKind,
        peerId: input.scope.peerId,
        // 0037: 第一条文字部件带上程序决定的 `@`。原来的"文字里写 CQ 码"只是兜底——模型现在被明确
        // 要求不要自己写 @。
        message: qqTextSegments(part.text, index === 0 ? (input.mention ?? null) : null),
      });
      parts.push({ kind: "text", result: partResult(result), messageId: messageIdOf(result) });
      if (partResult(result) !== "confirmed") stopped = true;
      continue;
    }
    const file = ports.stickerFile(part.stickerId);
    if (file === null) {
      // The copy vanished between the plan and the send. §8.1-6's material failure is recorded as
      // a part that never left, and the text (already sent) stands as it was written.
      parts.push({
        kind: "sticker",
        result: "not_sent",
        messageId: null,
        stickerId: part.stickerId,
      });
      stopped = true;
      continue;
    }
    const result = await ports.send({
      kind: input.scope.conversationKind,
      peerId: input.scope.peerId,
      message: [{ type: "image", data: { file } }],
    });
    parts.push({
      kind: "sticker",
      result: partResult(result),
      messageId: messageIdOf(result),
      stickerId: part.stickerId,
    });
    if (partResult(result) !== "confirmed") stopped = true;
  }

  if (parts.length === 0) return null;
  return recordQqSend(orm, {
    scope: {
      kind: "qq",
      accountId: input.scope.accountId,
      conversationKind: input.scope.conversationKind,
      peerId: input.scope.peerId,
      agentId: input.scope.agentId,
    },
    kind: input.kind,
    parts,
    sentAtSeconds: input.sentAtSeconds,
    text: input.text,
  });
}

/**
 * The production sender: resolve the conversation from the task snapshot, then deliver.
 *
 * The binding is read here rather than trusted from the snapshot because the snapshot is what the
 * guard validated, not what the platform must be addressed with: a binding that disappeared between
 * the commit and this call means there is no conversation to send into, and the honest outcome is
 * "nothing was delivered".
 */
export function qqReplySender(input: {
  orm: Orm;
  store: QqStickerStore;
  ports: QqSendPort;
  nowSeconds?: () => number;
}): QqReplySender {
  const now = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  return async ({ prepared, plan }) => {
    const binding = readQqBinding(input.orm, prepared.snapshot.bindingId);
    if (!binding) return null;
    return sendQqPreparedReply(
      input.orm,
      { send: input.ports.send, stickerFile: qqStickerFileReference(input.orm, input.store) },
      {
        scope: {
          accountId: binding.accountId,
          conversationKind: binding.kind,
          peerId: binding.peerId,
          agentId: binding.agentId,
        },
        kind: prepared.path,
        plan,
        text: prepared.text,
        sentAtSeconds: now(),
        // 0037: 收件人跟着这条草稿走。程序加 `@`，模型不需要自己写。
        mention: prepared.targetSpeakerId,
      },
    );
  };
}

/** The production sticker reference: the private copy's bytes, as a base64 URL. */
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

function stickerIdOf(
  part: QqPlannedOutput["parts"][number],
): { stickerId: string } | Record<string, never> {
  return part.kind === "sticker" ? { stickerId: part.stickerId } : {};
}

/** One platform answer, mapped to the ledger's four part results. */
function partResult(result: OneBotSendResult): "confirmed" | "failed" | "unknown" | "not_sent" {
  if (result.kind === "confirmed") return "confirmed";
  if (result.kind === "failed") return "failed";
  if (result.kind === "not_sent") return "not_sent";
  // Timeout, disconnect, transport error or a malformed receipt: §8.2 says do not assume either
  // way, which is exactly what `unknown` records.
  return "unknown";
}

/** A platform id exists only where the platform confirmed it. */
function messageIdOf(result: OneBotSendResult): string | null {
  return result.kind === "confirmed" ? result.messageId : null;
}
