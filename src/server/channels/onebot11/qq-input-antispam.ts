// QQ 输入防刷屏纯策略：纯表情资格过滤 + 无标记纯图片连发判定，单一纯函数、单一规则 owner。
// 无时钟、无库、无模型、无 IO、无缓存/队列/计时器；输入由 caller 冻结投影，输出是当次
// 范围的派生投影（资格排除 + burst 分组），不持久化第二事实。
//
// 输入合同（caller 责任，本模块不猜）：
// * events 由 caller 按来源顺序（journal seq 升序）给出——来源有序是 caller 合同，
//   本模块不重排、不加运行时顺序守卫；
// * sourceAvailable 是 caller 对该事件来源 TTL/完整性的投影布尔，false 即硬边界；
// * explicitDirect 是 caller 已裁定的合法 direct 事实（显式 @ / 合法引用），本模块不查
//   presence/权限；direct 事件永不入组、永不进纯表情排除；
// * image 部件的 expressionEvidence 只能来自平台三键证据（onebot-protocol categoryEvidence
//   单点），严禁用模型派生的 QqMessagePart.category 冒充平台证据；
// * mention/reply 地址元数据不进入 parts（direct 与否已由 explicitDirect 承载）；文本/正文
//   过期等完整性不可核实的部件由 caller 投影为 unsupported。
//
// 固定窗语义：组的锚是第一条载体。每条纯图载体在入组前先对锚检查：早于锚或距锚超过
// Y 秒即先结算当前组（≥X 条才命中），本事件开新窗。这保证组内任意两点的跨度都在界内，
// 中间大空洞不会被首尾差掩盖，也不需要滑动窗口或重排。

export type QqAntispamPart =
  | { kind: "text"; text: string }
  | { kind: "face" }
  | { kind: "image"; mediaId: string; expressionEvidence: boolean }
  | { kind: "otherMedia"; mediaKind: "record" | "video" | "file" }
  | { kind: "unsupported" };

export interface QqAntispamEvent {
  /** 来源顺序 seq（journal 递增）；调用方必须按此顺序给出，本模块不重排。 */
  seq: number;
  eventId: string;
  /** 成员发送者标识（member 事件；其它 role 不进入输入，也不打断分组）。 */
  speakerId: string;
  occurredAtSeconds: number;
  /** caller 投影的来源可用性（TTL/完整性）；false 为硬边界，不参与分组。 */
  sourceAvailable: boolean;
  /** caller 已裁定的合法 direct（显式 @ / 合法引用）。 */
  explicitDirect: boolean;
  parts: readonly QqAntispamPart[];
}

export interface QqAntispamBurstGroup {
  speakerId: string;
  /** 组内载体事件（按来源顺序）；sourceSeq/eventId/mediaId 原样保留。 */
  carriers: ReadonlyArray<{
    seq: number;
    eventId: string;
    imageMediaIds: readonly string[];
  }>;
  firstOccurredAtSeconds: number;
  lastOccurredAtSeconds: number;
  spanSeconds: number;
}

export interface QqAntispamDerivation {
  /** 纯表情消息（§5.2）被排除出普通资格的事件 seq。 */
  pureExpressionExcludedSeqs: readonly number[];
  /** 命中的无标记纯图片 burst 组（§5.3）。 */
  burstGroups: readonly QqAntispamBurstGroup[];
  /** 命中组图片的平坦投影：排除出自动供图的 (seq,eventId,mediaId)。 */
  burstExcludedImages: ReadonlyArray<{ seq: number; eventId: string; mediaId: string }>;
  /** 命中组载体事件 seq 的平坦投影。 */
  burstExcludedSeqs: readonly number[];
}

interface PartFacts {
  meaningfulText: boolean;
  expressionEvidenceCount: number;
  unmarkedImageMediaIds: string[];
  hasOtherMedia: boolean;
  hasUnsupported: boolean;
}

function partFacts(parts: readonly QqAntispamPart[]): PartFacts {
  let meaningfulText = false;
  let expressionEvidenceCount = 0;
  const unmarkedImageMediaIds: string[] = [];
  let hasOtherMedia = false;
  let hasUnsupported = false;
  for (const part of parts) {
    switch (part.kind) {
      case "text":
        if (part.text.trim() !== "") meaningfulText = true;
        break;
      case "face":
        expressionEvidenceCount += 1;
        break;
      case "image":
        if (part.expressionEvidence) expressionEvidenceCount += 1;
        else unmarkedImageMediaIds.push(part.mediaId);
        break;
      case "otherMedia":
        hasOtherMedia = true;
        break;
      case "unsupported":
        hasUnsupported = true;
        break;
    }
  }
  return {
    meaningfulText,
    expressionEvidenceCount,
    unmarkedImageMediaIds,
    hasOtherMedia,
    hasUnsupported,
  };
}

function isPureExpression(facts: PartFacts): boolean {
  return (
    facts.expressionEvidenceCount > 0 &&
    !facts.meaningfulText &&
    !facts.hasOtherMedia &&
    !facts.hasUnsupported &&
    facts.unmarkedImageMediaIds.length === 0
  );
}

interface OpenGroup {
  speakerId: string;
  carriers: Array<{
    seq: number;
    eventId: string;
    imageMediaIds: string[];
    occurredAtSeconds: number;
  }>;
}

export function deriveQqInputAntispam(input: {
  enabled: boolean;
  events: readonly QqAntispamEvent[];
  burstMinMessages: number;
  burstWindowSeconds: number;
}): QqAntispamDerivation {
  if (!input.enabled) {
    return {
      pureExpressionExcludedSeqs: [],
      burstGroups: [],
      burstExcludedImages: [],
      burstExcludedSeqs: [],
    };
  }

  const pureExpressionExcludedSeqs: number[] = [];
  const burstGroups: QqAntispamBurstGroup[] = [];
  const openGroups = new Map<string, OpenGroup>();

  const closeGroup = (speakerId: string): void => {
    const group = openGroups.get(speakerId);
    if (!group) return;
    openGroups.delete(speakerId);
    // 入组时的锚检查已保证组内首尾跨度落在配置的闭区间内。
    if (group.carriers.length < input.burstMinMessages) return;
    const first = group.carriers[0].occurredAtSeconds;
    const last = group.carriers[group.carriers.length - 1].occurredAtSeconds;
    burstGroups.push({
      speakerId: group.speakerId,
      carriers: group.carriers.map((carrier) => ({
        seq: carrier.seq,
        eventId: carrier.eventId,
        imageMediaIds: [...carrier.imageMediaIds],
      })),
      firstOccurredAtSeconds: first,
      lastOccurredAtSeconds: last,
      spanSeconds: last - first,
    });
  };

  const closeAll = (): void => {
    for (const speakerId of [...openGroups.keys()]) closeGroup(speakerId);
  };

  for (const event of input.events) {
    // 来源失效（TTL/完整性）只结算该发送者自己的组：自身不参与，其它发送者的健康
    // 子序列不被他人的过期消息打断；整段范围/已处理边界由 caller 在投影时限定。
    if (!event.sourceAvailable) {
      closeGroup(event.speakerId);
      continue;
    }

    const facts = partFacts(event.parts);
    const breaksGroup =
      event.explicitDirect ||
      facts.meaningfulText ||
      facts.hasOtherMedia ||
      facts.hasUnsupported ||
      facts.expressionEvidenceCount > 0;

    if (breaksGroup) {
      // 显式 direct 不吞（§5.2）：即使形态纯表情也不进排除名单。
      if (!event.explicitDirect && isPureExpression(facts)) {
        pureExpressionExcludedSeqs.push(event.seq);
      }
      closeGroup(event.speakerId);
      continue;
    }

    // 无标记纯图片载体（unknown/ordinary 均可）；单条多图仍是 1 个载体。
    if (facts.unmarkedImageMediaIds.length > 0) {
      let group = openGroups.get(event.speakerId);
      // 固定窗锚检查：早于锚或距锚超过 Y 秒的载体先结算当前组，再以本事件开新窗。
      if (
        group &&
        (event.occurredAtSeconds < group.carriers[0].occurredAtSeconds ||
          event.occurredAtSeconds - group.carriers[0].occurredAtSeconds > input.burstWindowSeconds)
      ) {
        closeGroup(event.speakerId);
        group = undefined;
      }
      if (!group) {
        group = { speakerId: event.speakerId, carriers: [] };
        openGroups.set(event.speakerId, group);
      }
      group.carriers.push({
        seq: event.seq,
        eventId: event.eventId,
        imageMediaIds: [...facts.unmarkedImageMediaIds],
        occurredAtSeconds: event.occurredAtSeconds,
      });
    }

    // 其余（如仅地址元数据的空投影）既非载体也非打断项，不改变任何组。
  }
  closeAll();

  const burstExcludedImages = burstGroups.flatMap((group) =>
    group.carriers.flatMap((carrier) =>
      carrier.imageMediaIds.map((mediaId) => ({
        seq: carrier.seq,
        eventId: carrier.eventId,
        mediaId,
      })),
    ),
  );
  return {
    pureExpressionExcludedSeqs,
    burstGroups,
    burstExcludedImages,
    burstExcludedSeqs: burstGroups.flatMap((group) => group.carriers.map((carrier) => carrier.seq)),
  };
}
