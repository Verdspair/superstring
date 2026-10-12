// QQ 输入防刷屏事实投影（§5.4 派生策略单 owner 的投影桥）：把真实 journal 事件事实
// （QqMessageFact，intake 已按平台三键证据归一 image.category）映射成
// deriveQqInputAntispam 的输入事件。本模块只做映射，不复制第二套规则：
// 纯表情判定、burst 分组、固定窗锚全部是 qq-input-antispam 的单一实现。
//
// 无时钟、无库、无模型、无 IO、无缓存/队列/计时器；不持久化第二事实。调用方按各自的
// 冻结范围派生（资格计数在 claim 前、候选锚/自动媒体在 claim 时点），同一派生结果供
// 三个消费者共用，不跨 snapshot 缓存。
//
// 输入合同（caller 责任，本模块不猜）：
// * facts 由 caller 按来源顺序给出（投影按 journal seq 升序保持，不重排）；
// * sourceAvailable 是 caller 对该事件来源 TTL/完整性的投影布尔（false＝硬边界）；
// * explicitDirect 是 caller 已裁定的合法 direct 事实（显式 @ / 合法引用）；
// * speaker.role 非 member 的事件（anonymous/system）不进入输入——与资格计数同口径，
//   它们从来不是合格判定目标，也不打断任何发送者的分组。
//
// 部件映射（平台证据，不冒充）：text→text；face→face；image→image，expressionEvidence
// 只认 intake 从平台 categoryEvidence 归一出的 category:"expression"（模型分类写在独立
// 分类表，从不回写 fact.parts，因此 fact 上的 expression 恒为平台证据）；mention/reply
// 地址元数据不进 parts（direct 与否已由 explicitDirect 承载）；unavailable 的
// record/video/file 是真实其它媒体部件→otherMedia，其余不可核实部件→unsupported。

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

function projectFact(
  fact: QqMessageFact,
  input: QqAntispamProjectionInput,
): QqAntispamEvent | null {
  if (fact.speaker.role !== "member") return null;
  const parts = fact.parts.map(projectPart).filter((part): part is QqAntispamPart => part !== null);
  return {
    seq: fact.seq,
    eventId: fact.id,
    speakerId: fact.speaker.qq ?? fact.id,
    occurredAtSeconds: fact.occurredAtSeconds,
    sourceAvailable: input.sourceAvailable(fact),
    explicitDirect: input.explicitDirect(fact),
    parts,
  };
}

export interface QqAntispamProjectionInput {
  readonly facts: readonly QqMessageFact[];
  readonly burstMinMessages: number;
  readonly burstWindowSeconds: number;
  /** caller 对该事件来源 TTL/完整性的投影布尔；false＝硬边界（结算该发送者当前组）。 */
  readonly sourceAvailable: (fact: QqMessageFact) => boolean;
  /** caller 已裁定的合法 direct（显式 @ / 合法引用）；direct 事件不入组、不进排除。 */
  readonly explicitDirect: (fact: QqMessageFact) => boolean;
}

/** 一条共享派生管线：三消费者各自按当次冻结范围调用，输出直接喂 deriveQqInputAntispam。 */
export function projectQqAntispamDerivation(
  input: QqAntispamProjectionInput,
): QqAntispamDerivation {
  const events: QqAntispamEvent[] = [];
  for (const fact of input.facts) {
    const event = projectFact(fact, input);
    if (event !== null) events.push(event);
  }
  return deriveQqInputAntispam({
    enabled: true,
    events,
    burstMinMessages: input.burstMinMessages,
    burstWindowSeconds: input.burstWindowSeconds,
  });
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
