import type { QqSchemeRhythm } from "../../shared/contracts/qq";

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
      readonly upperAtSeconds: number;
      readonly expired: boolean;
    }
  | {
      readonly kind: "ready";
      readonly count: number;
      /** 纯计数模式没有第二维上界（null）；时间窗开启时由起算锚独立推出。 */
      readonly upperAtSeconds: number | null;
      readonly expired: boolean;
    };

export interface QqChimingBatchWindowInput {
  rhythm: Pick<
    QqSchemeRhythm,
    | "initiative_time_window_enabled"
    | "initiative_time_target_seconds"
    | "initiative_time_jitter_seconds"
    | "initiative_batch_target_count"
    | "initiative_batch_jitter_count"
  >;
  /** 边界之后合格成员事件的条数，从事件事实派生，不是 seq 差值。 */
  count: number;
  /** 边界之后最早一条合格成员消息的时刻；null＝本批还没有合格输入。 */
  firstEligibleSeconds: number | null;
  /** 上一次完整有效判定的时刻；null＝本会话还没判过。 */
  judgedAtSeconds: number | null;
  nowSeconds: number;
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
  if (!rhythm.initiative_time_window_enabled || firstEligibleSeconds === null) {
    const expired = countExpired;
    if (countMature) return { kind: "ready", count, upperAtSeconds: null, expired };
    return { kind: "none", count, expired };
  }
  const anchorSeconds = Math.max(firstEligibleSeconds, judgedAtSeconds ?? 0);
  const readyAtSeconds =
    anchorSeconds + (rhythm.initiative_time_target_seconds - rhythm.initiative_time_jitter_seconds);
  const upperAtSeconds =
    anchorSeconds + (rhythm.initiative_time_target_seconds + rhythm.initiative_time_jitter_seconds);
  const expired = countExpired || nowSeconds >= upperAtSeconds;
  if (countMature || nowSeconds >= readyAtSeconds) {
    return { kind: "ready", count, upperAtSeconds, expired };
  }
  return {
    kind: "waiting",
    count,
    readyAtSeconds: Math.max(nowSeconds, readyAtSeconds),
    upperAtSeconds,
    expired,
  };
}
