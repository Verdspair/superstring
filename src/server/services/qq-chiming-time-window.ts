import type { QqSchemeRhythm } from "../../shared/contracts/qq";

/**
 * §5.5 的接话时机模式（方案节奏 participation_timing）。resource_window＝既有的两维资源
 * 窗口；quiet_preferred＝停顿优先：资源窗口照常给出「最早可判」，但在它之上还要等话语
 * 停顿（最新人类活动 + M）才真正就绪；条数/时间的上界仍允许忙群一次判断（即使 M 未停）。
 */
export type QqParticipationTiming = "resource_window" | "quiet_preferred";

const RESOURCE_WINDOW: QqParticipationTiming = "resource_window";

/**
 * 读取方案节奏里的接话时机模式。旧读取面（存量行、迁移前的 schemeConfig）**缺字段**时
 * 按既有 resource_window 语义解析，不让 strict schema 的新字段把旧任务读挂（§5 兼容读合同）。
 * 字段存在但不是合法枚举值时直接失败：合法值域的唯一真源是 shared 的 strict 契约，这里
 * 不做第二份静默兜底，坏值绝不悄悄退化成 resource_window。
 */
export function qqParticipationTimingOf(rhythm: object): QqParticipationTiming {
  const mode = (rhythm as { participation_timing?: QqParticipationTiming }).participation_timing;
  if (mode === undefined) return RESOURCE_WINDOW;
  if (mode !== "quiet_preferred" && mode !== "resource_window") {
    throw new TypeError(`participation_timing 不是合法的接话时机模式: ${String(mode)}`);
  }
  return mode;
}

/**
 * 自主接话的批次两维窗口：条数窗 [X−Y, X+Y] 与时间窗 [A−B, A+B] 是同形的资源名额，
 * 任一成熟即可就绪，两者同时成熟也只判一次。两者都不是随机采样、也不是防抖——上下界都是
 * 确定的。纯函数：没有时钟、数据库或模型，调用方把已校验的节奏参数与事件事实传进来。
 *
 * 起算锚是「最早合格消息」与「上一次有效判定时刻」中较晚的那个，所以判定期间才到的消息
 * 不会因为看起来已经很久没人说话而立刻触发刚判完的那一轮。没有合格输入就没有时间窗，
 * 空白周期因此不会调用模型。参数范围由 shared 的节奏契约校验，这里不复制一份。
 */

export type QqChimingBatchWindow =
  | {
      readonly kind: "none";
      readonly count: number;
      /** 名额等待已到头（条数过上界，或时间过上界），可按繁忙设置跳过或保留。 */
      readonly expired: boolean;
    }
  | {
      readonly kind: "waiting";
      readonly count: number;
      /** 早于这一刻还不该判；机会照入队，ready_at 落在这一刻，不是"不 arm"。 */
      readonly readyAtSeconds: number;
      /** 纯计数模式与「没有人类活动事实的停顿优先」没有第二维上界（null）。 */
      readonly upperAtSeconds: number | null;
      readonly expired: boolean;
      /** 仅停顿优先：当前话语停顿锚（最新人类活动）；resource_window 不输出该字段。 */
      readonly latestHumanSeconds?: number;
    }
  | {
      readonly kind: "ready";
      readonly count: number;
      readonly condition: "count" | "time" | "count_and_time";
      /** 纯计数模式没有第二维上界（null）；时间窗开启时由起算锚独立推出。 */
      readonly upperAtSeconds: number | null;
      readonly expired: boolean;
      /** 仅停顿优先：当前话语停顿锚（最新人类活动）；resource_window 不输出该字段。 */
      readonly latestHumanSeconds?: number;
    };

export interface QqChimingBatchWindowInput {
  /**
   * merge_window_seconds 只在 quiet_preferred 被读取（停顿门 M），且必须由 shared 节奏契约
   * 提供（quiet 分支缺它直接失败，不设缺省、不做 spread 兜底）；旧 resource_window 调用
   * 不传它也照常编译。
   */
  rhythm: Pick<
    QqSchemeRhythm,
    | "initiative_time_window_enabled"
    | "initiative_time_target_seconds"
    | "initiative_time_jitter_seconds"
    | "initiative_batch_target_count"
    | "initiative_batch_jitter_count"
  > &
    Partial<Pick<QqSchemeRhythm, "merge_window_seconds">>;
  /** 边界之后合格成员事件的条数，从事件事实派生，不是 seq 差值。 */
  count: number;
  /** 边界之后最早一条合格成员消息的时刻；null＝本批还没有合格输入。 */
  firstEligibleSeconds: number | null;
  /** 上一次完整有效判定的时刻；null＝本会话还没判过。 */
  judgedAtSeconds: number | null;
  nowSeconds: number;
  /** 接话时机模式；缺省＝既有 resource_window 语义（qqParticipationTimingOf 的产出）。 */
  readonly participationTiming?: QqParticipationTiming;
  /**
   * 窗口边界之后最新一条真实人类入站活动的时刻（member、非自身投递/媒体修订；纯表情与
   * 被指名的 direct 也是活动，即使不计入名额）。null＝窗口内没有人类活动事实——停顿门
   * 按未过处理，绝不拿 0 充当来源。只在 quiet_preferred 下被读取。
   */
  readonly latestHumanSeconds?: number | null;
}

/**
 * 这一批现在该不该判、以及最早什么时候可以判。
 *
 * 时间窗关闭时 `upperAtSeconds` 为 null：纯计数模式没有第二维上界，名额等待到头只看条数。
 * 上界由起算锚独立推出，不跟着 ready_at 走——ready_at 可以因重试或退避被推迟，上界是业务事实。
 */
export function qqChimingBatchWindow(input: QqChimingBatchWindowInput): QqChimingBatchWindow {
  const { rhythm, count, firstEligibleSeconds, judgedAtSeconds, nowSeconds } = input;
  const countLower = rhythm.initiative_batch_target_count - rhythm.initiative_batch_jitter_count;
  const countUpper = rhythm.initiative_batch_target_count + rhythm.initiative_batch_jitter_count;
  const countMature = count >= countLower;
  const countExpired = count >= countUpper;
  if (input.participationTiming === "quiet_preferred") {
    // 停顿优先（4.B）：没有合格素材就没有窗口（与 resource_window 同一守卫）——人类活动
    // 可以推迟话语停顿，但不凑名额、也不凭"有人在说话"开窗。
    if (firstEligibleSeconds === null || count === 0) {
      return { kind: "none", count, expired: countExpired };
    }
    // 停顿门 M 只来自 shared 节奏契约（strict 枚举的上游是唯一真源）：quiet 调用缺它直接
    // 失败，不设缺省、不做 spread 兜底、不静默退化。
    const mergeSeconds = rhythm.merge_window_seconds;
    if (mergeSeconds === undefined) {
      throw new TypeError("quiet_preferred 需要节奏契约提供 merge_window_seconds");
    }
    const latestHumanSeconds = input.latestHumanSeconds ?? null;
    const timeOn = rhythm.initiative_time_window_enabled;
    // 下界与上界沿用 resource_window 的原始锚：max(最早合格消息, 上次有效判定)。上界是
    // "这批材料本身已经冷了很久"的批次年龄事实，**不**锚最新人类活动——纯表情等活动若
    // 推着上界走，合格条数偏低的忙群会永远等不到那次忙中判断。
    const anchorSeconds = Math.max(firstEligibleSeconds, judgedAtSeconds ?? 0);
    const upperAtSeconds = timeOn
      ? anchorSeconds +
        (rhythm.initiative_time_target_seconds + rhythm.initiative_time_jitter_seconds)
      : null;
    const expired = countExpired || (upperAtSeconds !== null && nowSeconds >= upperAtSeconds);
    const lowerTimeMature =
      timeOn &&
      nowSeconds >=
        anchorSeconds +
          (rhythm.initiative_time_target_seconds - rhythm.initiative_time_jitter_seconds);
    // 话语停顿门：最新人类活动 + M（复用 merge_window_seconds，不设第二份 M；M=0 不等
    // 话语间隔）。活动事实缺失时不虚构 0 来源：门按未过处理，只有上界能放行。
    const mergeReadyAtSeconds =
      latestHumanSeconds === null ? null : latestHumanSeconds + mergeSeconds;
    const mergePassed = mergeReadyAtSeconds !== null && nowSeconds >= mergeReadyAtSeconds;
    if (expired || ((countMature || lowerTimeMature) && mergePassed)) {
      // 条数/时间下界任一成熟且话已停就绪；上界（条数或时间）放行忙群一次判断，即使
      // M 未停。condition 报告已成熟的下界维度；只有时间上界放行而下界未到时报 "time"
      // （上界同样是时间维的事实），输出字面与 resource_window 保持同族。
      const condition = countMature ? (lowerTimeMature ? "count_and_time" : "count") : "time";
      return {
        kind: "ready",
        count,
        condition,
        upperAtSeconds,
        expired,
        ...(latestHumanSeconds !== null ? { latestHumanSeconds } : {}),
      };
    }
    if (!timeOn && !countMature) {
      // 时间关闭＝纯计数：条数未到下界就没有窗口（与 resource_window 一致）。
      return { kind: "none", count, expired: false };
    }
    // 等待期限：条数已到下界就**只**等话语停顿（count OR time 是原始口径，不与仍在未来的
    // 资源下界取晚——否则成熟条数会被时间下界压后）；条数未到下界才取 max(资源下界, 话语
    // 停顿)。上界先到就先可判，所以期限再与上界取早——这与 resource_window 里"上界不会早
    // 于下界"的退化一致，也让停顿优先的忙群在批次年龄到上界时真的可判。
    const quietDeadlineSeconds = countMature
      ? (mergeReadyAtSeconds ?? nowSeconds)
      : Math.max(
          timeOn
            ? anchorSeconds +
                (rhythm.initiative_time_target_seconds - rhythm.initiative_time_jitter_seconds)
            : nowSeconds,
          mergeReadyAtSeconds ?? nowSeconds,
        );
    return {
      kind: "waiting",
      count,
      readyAtSeconds:
        upperAtSeconds === null
          ? quietDeadlineSeconds
          : Math.min(upperAtSeconds, quietDeadlineSeconds),
      upperAtSeconds,
      expired,
      ...(latestHumanSeconds !== null ? { latestHumanSeconds } : {}),
    };
  }
  if (!rhythm.initiative_time_window_enabled || firstEligibleSeconds === null) {
    const expired = countExpired;
    if (countMature)
      return { kind: "ready", count, condition: "count", upperAtSeconds: null, expired };
    return { kind: "none", count, expired };
  }
  const anchorSeconds = Math.max(firstEligibleSeconds, judgedAtSeconds ?? 0);
  const readyAtSeconds =
    anchorSeconds + (rhythm.initiative_time_target_seconds - rhythm.initiative_time_jitter_seconds);
  const upperAtSeconds =
    anchorSeconds + (rhythm.initiative_time_target_seconds + rhythm.initiative_time_jitter_seconds);
  const expired = countExpired || nowSeconds >= upperAtSeconds;
  const timeMature = nowSeconds >= readyAtSeconds;
  if (countMature || timeMature) {
    return {
      kind: "ready",
      count,
      condition: countMature ? (timeMature ? "count_and_time" : "count") : "time",
      upperAtSeconds,
      expired,
    };
  }
  return {
    kind: "waiting",
    count,
    readyAtSeconds: Math.max(nowSeconds, readyAtSeconds),
    upperAtSeconds,
    expired,
  };
}
