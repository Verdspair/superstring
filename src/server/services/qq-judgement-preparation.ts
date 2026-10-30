// Offline preparation for one explicitly classified QQ speech path (ADR0018 P3d).
// Reads only an already bound conversation. It never calls a model, opens a socket or sends.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SourceRef } from "../../shared/contracts/evidence";
import { readQqBinding } from "../db/qq-binding-repository";
import { readEffectiveQqScheme } from "../db/qq-group-config-repository";
import { attemptedUnreadMediaNoteIds } from "../db/qq-media-repository";
import {
  conversationMessagesSince,
  type QqConversationScope,
} from "../db/qq-observation-repository";
import {
  effectiveQqTriggers,
  schemeContext,
  schemeReply,
  schemeRhythm,
} from "../db/qq-scheme-repository";
import { readQqSettings } from "../db/qq-settings-repository";
import {
  lastQqInitiativeSeconds,
  lastQqSpeech,
  newestMemberMessageSeconds,
  qqInitiativeSpeechesInWindow,
} from "../db/qq-speech-repository";
import { getAgentRow, type Orm } from "../db/repositories";
import { qqContextLimits } from "./qq-context-contract";
import { type QqReplyTarget, qqReplyTargets } from "./qq-reply-targets";
import { checkQqInitiativeRhythm, qqBatchVerdict } from "./qq-rhythm-contract";
import {
  checkQqSpeechSend,
  checkQqSpeechTrigger,
  disabledKindsFromTriggers,
  isInitiativeSpeech,
} from "./qq-speaking-contract";

const Input = z.strictObject({
  bindingId: z.uuid(),
  // All four paths prepare here. The gate set is the same; what differs is that the two REPLY
  // paths skip the initiative-only gates below (see `initiative`).
  path: z.enum(["direct_reply", "follow_up", "chiming_in", "idle_topic"]),
  nowSeconds: z.number().int().nonnegative(),
  /**
   * 哪一条消息挣来这一轮（立即路径给的事件键）。
   *
   * 为什么需要：被 @ 的那条**可能不是最新的一条**——她开口之前别人又说了话，最新消息就换人了。回话对象
   * 必须是叫她的人，否则 `@` 会加在另一个人身上、回错人。主动路径不传它（目标是按人算出来的）。
   */
  focusEventKey: z.string().trim().min(1).optional(),
});
export type QqPreparationBlock =
  | "binding_missing"
  | "scheme_missing"
  | "agent_unavailable"
  | "account_mismatch"
  | "feature_off"
  | "conversation_paused"
  | "trigger_off"
  | "awaiting_reply"
  | "no_member_message"
  | "waiting_for_batch"
  | "cooling_down"
  | "hourly_limit"
  | "outside_active_hours"
  | "not_quiet_yet"
  | "media_read_failed"
  /** 她上次开口之后没有人再说过话：这一轮没有可回的人（0037）。 */
  | "nothing_to_answer";
/**
 * 同任务恢复（P3 partial recovery）的冻结目标形状：来自宿主验证的执行快照 targetParticipants
 * （获准的 target 范围，不是新一轮猜测）。结构化类型，宿主按形状传入；绝不来自模型或 bare flag。
 */
export type QqJudgementResumeTargets = {
  readonly targetId: string;
  readonly speakerId: string | null;
}[];

export type QqJudgementPreparation =
  | {
      readonly kind: "blocked";
      readonly reason: QqPreparationBlock;
      readonly readyAtSeconds?: number;
    }
  | {
      readonly kind: "prepared";
      readonly path: "direct_reply" | "follow_up" | "chiming_in" | "idle_topic";
      readonly targets: readonly QqReplyTarget[];
    };

/**
 * Canonical deliveries know their audience; old speech rows do not. A confirmed reply
 * to A cannot block B's independently queued opportunity. Any unpaired legacy row or
 * room-wide initiative still keeps the original conversation-wide no-reply gate.
 */
function lastInitiativeForTargets(
  orm: Orm,
  scope: QqConversationScope,
  targets: readonly QqReplyTarget[],
): number | null {
  const db = (orm as Orm & { $client: Database }).$client;
  const speeches = db
    .query(`SELECT kind,spoke_at_seconds AS at,COUNT(*) AS n
    FROM qq_speech_log WHERE account_id=? AND conversation_kind=? AND peer_id=? AND agent_id=?
      AND kind IN('chiming_in','idle_topic') GROUP BY kind,spoke_at_seconds ORDER BY spoke_at_seconds DESC`)
    .all(scope.accountId, scope.conversationKind, scope.peerId, scope.agentId) as {
    kind: string;
    at: number;
    n: number;
  }[];
  const deliveries = db
    .query(`SELECT s.kind,s.sent_at_seconds AS at,
      metadata.participant_id AS participant_id
    FROM outbound_intents i JOIN outbound_intent_metadata metadata ON metadata.intent_id=i.id
    JOIN qq_send_log s ON s.id=i.legacy_send_id
    WHERE s.account_id=? AND s.conversation_kind=? AND s.peer_id=? AND s.agent_id=?
      AND s.kind IN('chiming_in','idle_topic') AND s.outcome='sent'`)
    .all(scope.accountId, scope.conversationKind, scope.peerId, scope.agentId) as {
    kind: string;
    at: number;
    participant_id: string | null;
  }[];
  const audience = new Set(targets.map((t) => t.speakerId));
  for (const speech of speeches) {
    const known = deliveries.filter((d) => d.at === speech.at && d.kind === speech.kind);
    if (
      known.length < speech.n ||
      known.some((d) => d.participant_id === null || audience.has(d.participant_id))
    )
      return speech.at;
  }
  return null;
}

/** Call after a path has been classified. A prepared result is NOT permission to send. */
export function prepareQqJudgement(
  orm: Orm,
  input: unknown,
  options?: {
    /** Host-owned mature, unhandled participant opportunities; never supplied by a model. */
    pendingTargets?: readonly QqReplyTarget[];
    /**
     * 同任务恢复（P3 partial recovery）：宿主已验证受保护判断 ctx（exact/未到期/来源当前）
     * 后才能传入；携带冻结快照的全部获准目标。存在时该轮是**已判定任务**的恢复，不再重入
     * 新起始的 no-reply/合并窗口/节奏闸（判断早已结算，`awaiting_reply` 是新机会的规则）；
     * 配置闸改按发送口径（checkQqSpeechSend 同层输入），目标用冻结集合原样——本选项绝不
     * 由模型或 bare judgementDone 布尔提供。
     */
    resumedInitiative?: { targets: QqJudgementResumeTargets };
    /**
     * T11 host proof (qqNativeReadProof, runId pre-bound in the host closure): which of the blocked
     * media rows were ACTUALLY READ this run — a successful model call really consumed the image
     * part in THIS activation (prepared inventory, HTTP-unsupported failures, fetch-without-send,
     * phase-off and revoked sources are NEVER a proof). Only such rows are relieved from the legacy
     * unread-failure gate (spec §8.1: a valid current-round native read is not blocked by an old
     * failure); mode==native alone is never a proof, and the gate derives no other stage claim from
     * this fact. Undefined = host without native proof support: the gate stays closed.
     */
    nativeReadProof?: (input: {
      scope: QqConversationScope;
      mediaNoteIds: readonly string[];
      now: string;
    }) => ReadonlyArray<{
      mediaNoteId: string;
      proof: {
        /** 本 run 一次成功模型调用实际消费了该图的图像 part。 */
        kind: "model_consumed";
        /** 该成功调用的时刻（run 内真源）。 */
        consumedAt: string;
        /** 被消费的图像来源引用（epoch/seq/ref 由 host 末验仍 current）。 */
        sourceRefs: readonly SourceRef[];
      } | null;
    }>;
    /**
     * 初始资格探询（§8.1）——**「可尝试」，不是「已理解」**。
     *
     * 与 `nativeReadProof` 的分层（两者不可混、不可互相代替）：
     *   * `nativeReadProof` ＝ **已发生的实际理解证据**：同 run 一次成功模型调用真消费了图像
     *     part。只有它能让 `prepareOutput`/`commitOutputs` 的严格闸放行。
     *   * 本回调 ＝ 宿主回答「这些本轮失败的媒体行，本 run 有**可能**真实供图」。它只让
     *     **首次** preparation 暂缓 `media_read_failed` 这一个 reason，好让主链真的走一次
     *     决策相，从而有机会产生上面那种证据。它不解除任何闸、不进缓存、不写状态。
     *
     * 返回值＝**可尝试**的 mediaNoteId 子集。宿主只能返回它能在本 run 自动范围里真实供图的
     * 行（native 模式 ∧ decision 阶段开 ∧ media 能力开 ∧ 该行当前来源有效 ∧ 落在 focus+direct
     * 自动范围内，§7.1）。判定全在宿主闭包内。
     *
     * 消费端只做一个**纯形状**的集合覆盖检查（与上面 requested-notes 检查同一性质，**不重建
     * 任何权限系统**）：所有未 proven 的失败行都被返回才暂缓。部分覆盖、未知/重复 id、空
     * 返回、未提供本回调、回调抛错——一律照旧 blocked（fail closed）。
     */
    initialNativeReadEligibility?: (input: {
      scope: QqConversationScope;
      mediaNoteIds: readonly string[];
      now: string;
    }) => readonly string[];
  },
): QqJudgementPreparation {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ judgement preparation input");
  const { bindingId, path, nowSeconds } = parsed.data;
  const binding = readQqBinding(orm, bindingId);
  if (!binding) return { kind: "blocked", reason: "binding_missing" };
  const settings = readQqSettings(orm);
  if (settings.accountId !== binding.accountId)
    return { kind: "blocked", reason: "account_mismatch" };
  const scheme = readEffectiveQqScheme(orm, binding);
  if (!scheme) return { kind: "blocked", reason: "scheme_missing" };
  const agent = getAgentRow(orm, binding.agentId);
  if (agent?.isActive !== 1) return { kind: "blocked", reason: "agent_unavailable" };
  const scope: QqConversationScope = {
    kind: "qq",
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
  };
  const newest = newestMemberMessageSeconds(orm, scope);
  // 同任务恢复：配置闸按发送口径，不重入新机会的 no-reply 闸；媒体 proof 仍由宿主提供。
  const resumeTargets = options?.resumedInitiative?.targets;
  if (resumeTargets !== undefined) {
    if (path !== "chiming_in") return { kind: "blocked", reason: "trigger_off" };
    const sendGate = checkQqSpeechSend({
      kind: path,
      featureEnabled: settings.enabled === 1,
      conversationPaused: binding.paused,
      disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(binding, scheme)),
    });
    if (sendGate.kind === "blocked") return { kind: "blocked", reason: sendGate.reason };
  } else {
    const gate = checkQqSpeechTrigger({
      kind: path,
      featureEnabled: settings.enabled === 1,
      conversationPaused: binding.paused,
      disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(binding, scheme)),
      lastInitiativeSeconds:
        path === "chiming_in" &&
        schemeReply(scheme).split_by_speaker &&
        options?.pendingTargets?.length
          ? lastInitiativeForTargets(orm, scope, options.pendingTargets)
          : lastQqInitiativeSeconds(orm, scope),
      newestMemberMessageSeconds: newest,
    });
    if (gate.kind === "blocked") return { kind: "blocked", reason: gate.reason };
    if (newest === null) return { kind: "blocked", reason: "no_member_message" };
  }
  // The eligibility window bounds target selection and the media gate.
  const limits = qqContextLimits(schemeContext(scheme), "judgement");
  const sinceSeconds = Math.max(0, nowSeconds - limits.windowMinutes * 60 - 1);
  const messages = conversationMessagesSince(orm, scope, {
    sinceSeconds,
    limit: limits.messageLimit,
  });
  // 这一轮要回谁（0037，不同人的消息分开来跑）。
  //   * 自主接话：按**人**算合并窗口——他自己的最后一条消息过完窗口就算说完了；她上次开口之后说过话
  //     的人才是这一轮的活（回过的人不会因为别人又开一次口被重新翻出来）。
  //   * 冷场发起：她是往安静的房间里开话题，没有回话对象，因此不设目标。
  //   * 回应路径（被叫到 / 连续交谈）：这一轮只回一个人——最新那条消息的发言人。这条路径本来就不跑
  //     判断（被叫到就是决定），但"一条消息一个对象"是同一套结构，`@` 也因此是程序加的。
  // §5.2/§8.2: the merge window exists to batch messages before JUDGING an initiative, and the
  // cooldown/hourly cap only constrain 主动发言. A direct reply or a continuation is neither —
  // waiting to batch a question, or being told to cool down while someone is talking to you, is
  // exactly what those two exemptions forbid. The switch/pause/agent gates above still apply,
  // which is why the immediate paths prepare here instead of assembling a gate set of their own.
  let targets: readonly QqReplyTarget[] = [];
  if (isInitiativeSpeech(path)) {
    const rhythm = schemeRhythm(scheme);
    const lastSpeechSeconds = lastQqSpeech(orm, scope)?.spokeAtSeconds ?? null;
    if (resumeTargets !== undefined) {
      // 恢复轮（P3 partial recovery）：目标＝冻结快照的全部获准成员，原样（不重选、不按合并
      // 窗口/节奏重算——判断早已结算）；媒体失败闸仍照常走。
      targets = resumeTargets.map((entry) => ({
        speakerId: entry.speakerId,
        newestSeconds: 0,
        messageCount: 1,
      }));
    } else if (path === "chiming_in") {
      if (options?.pendingTargets !== undefined) {
        // The durable queue has already measured each person's window. Keep only
        // recipients whose input remains in the configured readable context window.
        targets = options.pendingTargets.filter((target) =>
          messages.some((message) => message.speakerId === target.speakerId),
        );
        if (targets.length === 0) return { kind: "blocked", reason: "nothing_to_answer" };
      } else {
        const plan = qqReplyTargets({
          messages: messages.map((row) => ({
            speakerId: row.speakerId,
            occurredAtSeconds: row.occurredAtSeconds,
          })),
          mergeWindowSeconds: rhythm.merge_window_seconds,
          nowSeconds,
          lastSpeechSeconds,
        });
        // 等的是"最早那个人"自己的窗口，而不是"最后一条消息"——别人刚开口不该把张三的窗口往后推。
        if (plan.kind === "waiting")
          return {
            kind: "blocked",
            reason: "waiting_for_batch",
            readyAtSeconds: plan.readyAtSeconds,
          };
        if (plan.kind === "nothing_to_answer")
          return { kind: "blocked", reason: "nothing_to_answer" };
        targets = plan.targets;
      }
    } else {
      // 冷场发起：安静已经由冷场扫描保证，这里只需要合并窗口（安静期间也不会有新消息）。
      const batch = qqBatchVerdict({
        lastMessageSeconds: newest,
        nowSeconds,
        mergeWindowSeconds: rhythm.merge_window_seconds,
      });
      if (batch.kind === "waiting")
        return {
          kind: "blocked",
          reason: "waiting_for_batch",
          readyAtSeconds: batch.readyAtSeconds,
        };
    }
    // 恢复轮跳过发起节奏闸（合并窗口/冷却/小时帽都是**新机会**的许可条件；本轮的判断已经
    // 结算并冻结）。配置闸与来源/媒体/材料闸不受影响。
    if (resumeTargets === undefined) {
      const cadence = checkQqInitiativeRhythm({
        kind: path,
        rhythm,
        nowSeconds,
        lastSpeechSeconds,
        speechesThisHour: qqInitiativeSpeechesInWindow(orm, scope, { nowSeconds }),
        newestMemberMessageSeconds: newest,
      });
      if (cadence.kind === "blocked")
        return cadence.readyAtSeconds === null
          ? { kind: "blocked", reason: cadence.reason }
          : {
              kind: "blocked",
              reason: cadence.reason,
              readyAtSeconds: cadence.readyAtSeconds,
            };
    }
    // 读过了却没读出（在途或失败）就不要主动开口——没读懂那张图就没有资格
    // 自主接话，§7.1 也不允许假装知道。被叫到或被回复时必须应答，那是别人的问题，不是她的主动性。
    // 此检查放在合并窗口与节奏之后，是为了给在途的读取留出这段时间。
    //
    // 这条闸门只约束**有回话对象**的主动路径。两处收窄：
    //   * 原来按**判断窗口**里的全部消息（60 分钟）算，于是一张 14:43 读失败的图把 15:09–15:32 的
    //     每一轮 chiming_in 都按住了——五十分钟前别人发的东西与"这一轮要回谁"无关。现在只看**这一轮
    //     真正要回应的那一串**：本轮目标发言人、且在她上次开口之后说的话。
    //   * 冷场发起不回应任何具体消息，没有"你要回应的那张图"这个对象，因此完全不看这条闸门（模型仍
    //     看得见那条没有描述的图片，§7.1 照旧禁止假装知道）。
    if (targets.length > 0) {
      const mediaScope = messages.filter(
        (message) =>
          (lastSpeechSeconds === null || message.occurredAtSeconds >= lastSpeechSeconds) &&
          targets.some((target) => target.speakerId === message.speakerId),
      );
      // 该轮判断自己的真实时钟（由 nowSeconds 推导的 ISO），不取宿主当前钟：
      // 同一次判定的媒体闸与窗口读数必须出自同一时刻。
      const gateAt = new Date(nowSeconds * 1000).toISOString();
      const blockedNotes = attemptedUnreadMediaNoteIds(
        orm,
        mediaScope.map((message) => message.eventKey),
        gateAt,
      );
      // 本轮 native 已真实投喂的行（host 闭包内 runId/scope/assertCurrent 复验）按 §8.1 解除
      // 旧失败误挡；host 未注入 proof（undefined）时闸保持原样——宁误挡不误放。
      // The trusted host callback is the ONLY authorization source: run/owner/observedSeq/scope/
      // sent-imageSource correspondence, source readability and consumedAt validity are the
      // PRODUCER's contractual duties (verified inside its closure) — the gate builds no second
      // permission system. It does enforce the light input contract of the response shape itself:
      // only requested ids, no duplicates, and a well-formed non-future consumedAt (these are shape
      // consistency, not authorization).
      const requestedNotes = new Set(blockedNotes);
      const provenNotes = new Set<string>();
      if (blockedNotes.length > 0 && options?.nativeReadProof !== undefined) {
        const nowMs = Date.parse(gateAt);
        for (const entry of options.nativeReadProof({
          scope,
          mediaNoteIds: blockedNotes,
          now: gateAt,
        })) {
          if (!requestedNotes.has(entry.mediaNoteId)) continue;
          if (provenNotes.has(entry.mediaNoteId)) continue;
          const proof = entry.proof;
          if (proof?.kind !== "model_consumed") continue;
          const consumedMs = Date.parse(proof.consumedAt);
          if (!Number.isFinite(consumedMs) || consumedMs > nowMs) continue;
          provenNotes.add(entry.mediaNoteId);
        }
      }
      const pendingNotes = blockedNotes.filter((id) => !provenNotes.has(id));
      if (pendingNotes.length > 0) {
        // 初始资格探询（§8.1）：仅当宿主声明**每一个**未 proven 的失败行本 run 都有可真实供图的机会
        // 才暂缓这一个 reason，让主链真的走一次决策相——决策成功消费后，
        // `prepareOutput`/`commitOutputs` 的严格闸会凭 `model_consumed` 放行。这是“可尝试”，不是“已理解”。
        // 任何不覆盖、未知/重复 id、空返回、未提供本回调、回调抛错 → 一律照旧阻断。
        // 消费端只做**纯形状**的集合覆盖检查，**不重建任何授权**：scope/来源/能力的判定全在宿主闭包内。
        const eligibility = options?.initialNativeReadEligibility;
        let deferrable = eligibility !== undefined;
        if (eligibility !== undefined) {
          // 保留原始数组（不提前去重）：重复与未知都是宿主回答不可信的形状。
          // 回调抛错无需尝试：不吞掉、不转 blocked（blocked 是一种误导），自然穿透。
          const offered = eligibility({ scope, mediaNoteIds: pendingNotes, now: gateAt });
          const requested = new Set(pendingNotes);
          const seen = new Set<string>();
          let wellFormed = true;
          for (const id of offered) {
            if (!requested.has(id) || seen.has(id)) {
              wellFormed = false;
              break;
            }
            seen.add(id);
          }
          // 三个条件同时才算「都能尝试」：无未知、无重复、且完整覆盖。
          // 一张焦点图不能放任窗口里无关失败行解锁；多报一个不请求的 id 也不能算。
          deferrable = wellFormed && pendingNotes.every((id) => seen.has(id));
        }
        if (deferrable) {
          console.warn(
            `[qq-media] ${path} 暂缓媒体失败闸：本轮 ${pendingNotes.length} 项待真实供图后才可开口（会话 ${scope.conversationKind}:${scope.peerId}）`,
          );
        } else {
          console.warn(
            `[qq-media] ${path} 放弃开口：本轮有 ${pendingNotes.length} 项媒体读取未成功（会话 ${scope.conversationKind}:${scope.peerId}）`,
          );
          return { kind: "blocked", reason: "media_read_failed" };
        }
      }
    }
  } else {
    // 被叫到 = **挣来这一轮的那条消息**的发言人（`focusEventKey`；没给就退回最新一条）。匿名发言也是
    // 一个人，只是没有号（`speakerId: null`，不加 `@`）。
    // 为什么不是"最新那条"：@ 之后别人又说了话时，最新那条已经换人，按它回就会回错人。
    const focus =
      parsed.data.focusEventKey === undefined
        ? undefined
        : messages.find((message) => message.eventKey === parsed.data.focusEventKey);
    const newestMessage = focus ?? messages[0];
    if (newestMessage !== undefined) {
      targets = Object.freeze([
        Object.freeze({
          speakerId: newestMessage.speakerId,
          newestSeconds: newestMessage.occurredAtSeconds,
          messageCount: 1,
        }),
      ]);
    }
  }
  return { kind: "prepared", path, targets };
}
