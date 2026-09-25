// Test-only pre-cutover behavior oracle; never import from production.
// One model judgement per reply target, over an already classified initiative path (ADR0018 P3e).
// The gateway is injected. This module cannot send a QQ message or start the transport.
//
// 0037（用户 2026-09-25）：判断改成**按发言人**各问一次——"我值不值得回他"。所以一次 `runQqJudgement`
// 会对预备阶段算出的每个目标跑一遍，每人一次真判断。
//
// 2026-09-25（用户决定）：**取消 0036 的"判断间隔 + 复用上次分数"**。用户的理由是语义要简单：每个人的
// 合并窗口一结束就为他判一次门槛。此前的复用会让人看到"这个人明明刚说了话，她却按几分钟前的旧分数
// 决定要不要开口"——省一次调用的代价是分数与当下脱节。`qq_schemes.judgement_interval_turns` 与读数表
// 仍留在存储里（不迁移），但**没有任何代码再读写它们**。
//
// The openings are per person, and so are the failures: one person's unreadable answer or model error
// does not erase another person's readable one. The single-value kinds (`silent`, `unreadable`, …) are
// therefore only returned when NO target produced an opening — the most informative of what happened.

import {
  readQqScheme,
  schemeOutputReserve,
  schemeRhythm,
} from "../../../src/server/db/qq-scheme-repository";
import type { Orm } from "../../../src/server/db/repositories";
import type { ModelGateway } from "../../../src/server/llm/model-gateway";
import { checkQqModelCapacity } from "../../../src/server/services/qq-capacity-preflight";
import {
  prepareQqJudgement,
  type QqJudgementPreparation,
} from "../../../src/server/services/qq-judgement-preparation";
import {
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
  qqJudgeAllowsSpeech,
  qqJudgeOutcome,
} from "../../../src/server/services/qq-prompt-contract";
import type { QqReplyTarget } from "../../../src/server/services/qq-reply-targets";

/** 一个要回的对象 + 判断给它的分数（`null` 表示这条路径不跑判断：被叫到就是决定）。 */
export interface QqReplyOpening {
  /**
   * `null` = 这一轮没有具体的回话对象（冷场发起往安静的房间里开话题）。
   *
   * 注意与"目标是匿名发言"区分：那是 `target.speakerId === null`，仍然是**一个人**，只是没有号。
   */
  readonly target: QqReplyTarget | null;
  readonly score: number | null;
}

export type QqJudgementRun =
  | Extract<QqJudgementPreparation, { kind: "blocked" }>
  | {
      readonly kind:
        | "silent"
        | "unreadable"
        | "model_error"
        | "capacity_unavailable"
        | "capacity_exceeded"
        | "configuration_changed";
    }
  | {
      /** Readable recommendations, NOT permission to send and not a generated reply. */
      readonly kind: "candidate";
      readonly prepared: Extract<QqJudgementPreparation, { kind: "prepared" }>;
      /** One entry per target whose score cleared the scheme's threshold, in the prepared order. */
      readonly openings: readonly QqReplyOpening[];
    };

/**
 * 回应路径的 openings（0037）：被叫到就是决定，所以没有分数——直接把预备阶段算出的目标开成一条。
 *
 * 目标为空（冷场发起往安静的房间里开话题）时开一条"没有对象"的 opening：一条消息、不加 `@`，结构上
 * 与其它路径一致。
 */
export function qqImmediateOpenings(
  prepared: Extract<QqJudgementPreparation, { kind: "prepared" }>,
): readonly QqReplyOpening[] {
  // 开关关掉时整轮只写一条（不加 `@`），与自主接话那边的口径一致：这个开关选的是"分开回每个人"还是
  // "一条回复回整间会话"，不是两套互不相干的机制。
  if (!prepared.splitBySpeaker || prepared.targets.length === 0)
    return Object.freeze([{ target: null, score: null }]);
  return Object.freeze(prepared.targets.map((target) => ({ target, score: null })));
}

/** No retries: a failure, bad JSON or explicit silence cannot cause speech. */
export async function runQqJudgement(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  input: unknown,
): Promise<QqJudgementRun> {
  const prepared = prepareQqJudgement(orm, input);
  if (prepared.kind === "blocked") return prepared;
  const scheme = readQqScheme(orm, prepared.schemeId);
  if (!scheme || scheme.revision !== prepared.schemeRevision)
    return { kind: "configuration_changed" };
  const rhythm = schemeRhythm(scheme);
  const outputReserved = schemeOutputReserve(scheme).judgement_output_reserved;

  const openings: QqReplyOpening[] = [];
  let unreadable = false;
  let modelError = false;
  let capacity: "unavailable" | "exceeded" | null = null;

  for (const prompt of prepared.judgementPrompts) {
    const target = prompt.target;
    const messages = prompt.messages.map(({ role, content }) => ({ role, content }));
    const probe = await checkQqModelCapacity(gateway, {
      model: prepared.modelName,
      messages,
      outputReserved,
    });
    if (probe.kind !== "allowed") {
      capacity = probe.kind === "unavailable" ? "unavailable" : "exceeded";
      continue;
    }
    // A save that changed the scheme while the earlier targets were being judged must not be judged by
    // the old table: the whole round is void rather than half-new, half-old.
    if (readQqScheme(orm, prepared.schemeId)?.revision !== prepared.schemeRevision)
      return { kind: "configuration_changed" };
    let raw: string;
    try {
      raw = await gateway.complete({
        model: prepared.modelName,
        messages,
        responseSchema: QQ_JUDGEMENT_RESPONSE_SCHEMA,
      });
    } catch (error) {
      // Model errors are diagnostic, never an implicit "yes". Do not surface prompt text.
      //
      // 2026-09-25（用户报告"自主接话从不触发、云端后台报错"）：这里此前**一个字都不写日志**，
      // 于是本地无据可查，只能从云端后台反推。现在写一行不带任何正文的告警——只有模型名与错误
      // 的类别/状态，够回答"为什么她不说"，又不落提示词与消息内容。
      const status = (error as { status?: unknown } | null)?.status;
      const name = error instanceof Error ? error.name : typeof error;
      console.warn(
        `[qq-judge] 判断调用失败：模型 ${prepared.modelName}，${name}${typeof status === "number" ? `（HTTP ${status}）` : ""}`,
      );
      modelError = true;
      continue;
    }
    const verdict = qqJudgeOutcome(raw);
    if (verdict.kind === "unreadable") {
      unreadable = true;
      continue;
    }
    if (qqJudgeAllowsSpeech(verdict, rhythm.initiative_min_score)) {
      openings.push({ target, score: verdict.score });
    }
  }

  if (readQqScheme(orm, prepared.schemeId)?.revision !== prepared.schemeRevision)
    return { kind: "configuration_changed" };
  if (openings.length > 0)
    return { kind: "candidate", prepared, openings: Object.freeze(openings) };
  // Nothing may go out. Report the most informative thing that happened, in the same order the single
  // target version used: capacity, then a model failure, then "could not read it", then a readable no.
  if (capacity === "unavailable") return { kind: "capacity_unavailable" };
  if (capacity === "exceeded") return { kind: "capacity_exceeded" };
  if (modelError) return { kind: "model_error" };
  if (unreadable) return { kind: "unreadable" };
  return { kind: "silent" };
}
