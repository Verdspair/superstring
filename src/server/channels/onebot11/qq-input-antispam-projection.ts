// 将按 seq 排序的 journal 行投影为防刷屏输入，纯规则由 qq-input-antispam 维护。
// 各调用方在自己的冻结范围内独立派生，不跨调用或快照缓存结果。
// 调用方预筛成员行并核验 scope、TTL 和真实 fact；不可读行的 fact 为 null，
// 投影只给空部件和来源失效边界，不虚构正文。它只结束该发送者的分组，不影响其他成员。
// rows 的 isDirect 由调用方按真实 @ 或引用裁定，本模块不从模型措辞猜测。
// 资格筛选在派生后执行；取舍只影响自动候选，不改原文或限制显式媒体读取。
// 图片类别只认入站平台证据，模型分类不回写事实；mention/reply 不作为内容部件。
// unavailable 的 record/video/file 保留为其他媒体，无法核实的部件标为 unsupported。

import type { QqMessageFact, QqMessagePart } from "../../../shared/contracts/qq-message";
import {
  deriveQqInputAntispam,
  type QqAntispamDerivation,
  type QqAntispamEvent,
  type QqAntispamPart,
} from "./qq-input-antispam";

const OTHER_MEDIA_TYPES = new Set(["record", "video", "file"]);

function projectPart(part: QqMessagePart): QqAntispamPart | null {
  switch (part.kind) {
    case "text":
      return { kind: "text", text: part.text };
    case "face":
      return { kind: "face" };
    case "image":
      // 平台证据单点：intake 只在协议三键同现时归一 category:"expression"；
      // unknown/ordinary（含模型分类）一律不是表情证据。
      return {
        kind: "image",
        mediaId: part.mediaId,
        expressionEvidence: part.category === "expression",
      };
    case "unavailable":
      return OTHER_MEDIA_TYPES.has(part.type)
        ? { kind: "otherMedia", mediaKind: part.type as "record" | "video" | "file" }
        : { kind: "unsupported" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// journal 行桥（P4 breaker 修正）：有界冻结范围内的**完整** journal 行都要进入派生序列，
// 不能先被资格过滤抹掉断组边界——self 的 direct/文本/其它媒体/过期行是同发送者的断组器，
// 其它发送者的过期行不打断健康组。可读行投影真实 fact；过期/不可投影行以 sourceAvailable=false
// 的空 parts 进入（caller 不得为不可读行虚构任何 parts/mediaId）。资格计数（direct/过期/纯表情
// 不计）由 caller 在派生**之后**按资格集合裁决，本桥不做资格过滤。
// ---------------------------------------------------------------------------

/** 有界 journal 行的最小投影形状（caller 从冻结范围内的事实行自带，本模块不读库）。 */
export interface QqAntispamJournalRow {
  /** journal 递增 seq（caller 必须按升序给出，本模块不重排）。 */
  readonly seq: number;
  /** 该行的 journal event key（member 入站行的 source.id，去掉通道前缀后即 fact id 域）。 */
  readonly eventId: string;
  /** 成员发送者标识；caller 已按 member 角色预筛，anonymous/system 行不进入本桥。 */
  readonly speakerId: string;
  readonly occurredAtSeconds: number;
  /** caller 已裁定的合法 direct（journal addressing 复验，不由模型措辞/本桥重判）。 */
  readonly isDirect: boolean;
  /** 该行来源当前可读时 caller 投影的真实事实；null＝过期/不可投影（硬边界，无内容）。 */
  readonly fact: QqMessageFact | null;
}

export function projectQqAntispamSequence(input: {
  readonly rows: readonly QqAntispamJournalRow[];
  readonly burstMinMessages: number;
  readonly burstWindowSeconds: number;
}): QqAntispamDerivation {
  const { rows } = input;
  const events: QqAntispamEvent[] = rows.map((row) => {
    const fact = row.fact;
    if (fact === null) {
      // 过期/不可投影行：空 parts + sourceAvailable=false，只表达"这里有一个来源硬边界"，
      // 不虚构任何部件；它结算该发送者自己的当前组（§5.3），不打断其它发送者。
      return {
        seq: row.seq,
        eventId: row.eventId,
        speakerId: row.speakerId,
        occurredAtSeconds: row.occurredAtSeconds,
        sourceAvailable: false,
        explicitDirect: row.isDirect,
        parts: [],
      };
    }
    const parts = fact.parts
      .map(projectPart)
      .filter((part): part is QqAntispamPart => part !== null);
    return {
      seq: row.seq,
      eventId: row.eventId,
      speakerId: row.speakerId,
      occurredAtSeconds: row.occurredAtSeconds,
      sourceAvailable: true,
      explicitDirect: row.isDirect,
      parts,
    };
  });
  return deriveQqInputAntispam({
    enabled: true,
    events,
    burstMinMessages: input.burstMinMessages,
    burstWindowSeconds: input.burstWindowSeconds,
  });
}
