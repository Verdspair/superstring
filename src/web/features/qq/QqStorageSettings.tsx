// §11.1's 存储与诊断 (ADR0018 P5h, plus P5u's 原因可追踪).
//
// The page reports what the QQ side actually keeps and offers one action: remove what has already
// expired. Three lines are deliberately honest rather than impressive — the received-media cache
// holds references and descriptions rather than bytes, failure records are not stored yet, and
// sticker copies are outside this cleanup entirely. Showing a zero for any of them would read as a
// statement ("no failures", "no cache") that the project has not made.
//
// P5u adds the answer to the question this page kept raising: "the switch is on, so why is there no
// sound from that group". Each bound conversation now has a stored verdict from the last quiet-room
// sweep, and the reasons are the sweep's own gates — the page translates them, it does not invent a
// second explanation. What is still NOT recorded is stated in 「还没有的东西」 rather than implied.

import { useEffect } from "react";
import type { QqIdleSweepSkipReason } from "../../../shared/contracts/qq";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { formatBytes } from "./format";

/**
 * The sweep's gates in the user's words. Each key is a reason the server actually stores, so a new
 * reason cannot appear here as an untranslated machine key: the record is `Record<…, string>`, which
 * makes the compiler ask for the label first.
 */
const REASON_LABELS: Record<QqIdleSweepSkipReason, string> = {
  feature_off: "QQ 侧总开关没开，或这条绑定不属于当前账号",
  conversation_paused: "这个会话被暂停了",
  trigger_off: "冷场发起开关关着",
  no_member_baseline: "还没有群友说过话",
  awaiting_reply: "上次主动开口没有人回应",
  not_quiet_yet: "还没到安静时间",
  cooling_down: "离上次发言太近",
  hourly_limit: "这一小时已经说得够多",
  outside_active_hours: "不在允许时段",
  candidate_pending: "已经排好一次开场，正在等发送",
  already_judged: "这一轮安静已经判过，结论是不说；等群里再有人说话才会重新判",
};

export function QqStorageSettings() {
  const t = useI18n();
  const usage = useSuperstringStore((s) => s.qqStorageUsage);
  const removed = useSuperstringStore((s) => s.qqStorageRemoved);
  const loading = useSuperstringStore((s) => s.qqStorageLoading);
  const saving = useSuperstringStore((s) => s.qqStorageSaving);
  const error = useSuperstringStore((s) => s.error);
  const feedback = useSuperstringStore((s) => s.feedback);
  const load = useSuperstringStore((s) => s.loadQqStorage);
  const cleanup = useSuperstringStore((s) => s.runQqStorageCleanup);

  useEffect(() => {
    void load();
  }, [load]);

  // `label` is normally a dictionary key, but a verdict row passes a composed label
  // (「群 30003」): `t()` returns an unknown key unchanged, so both cases render as intended.
  const row = (label: string, value: string, note?: string, key: string = label) => (
    <div key={key}>
      <dt>{t(label)}</dt>
      <dd>{value}</dd>
      {note !== undefined && <small className="hint">{note}</small>}
    </div>
  );

  // Ages are computed against the page's own clock, so a stale runtime shows up as one: a verdict
  // written an hour ago is reported as an hour old instead of as the current reason.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ago = (seconds: number) => {
    const delta = Math.max(0, nowSeconds - seconds);
    if (delta < 60) return t("{0} 秒前", delta);
    if (delta < 3600) return t("{0} 分钟前", Math.floor(delta / 60));
    if (delta < 86_400) return t("{0} 小时前", Math.floor(delta / 3600));
    return t("{0} 天前", Math.floor(delta / 86_400));
  };
  const ahead = (seconds: number) => {
    const delta = Math.max(0, seconds - nowSeconds);
    if (delta < 60) return t("不到 1 分钟");
    if (delta < 3600) return t("约 {0} 分钟", Math.ceil(delta / 60));
    return t("约 {0} 小时", Math.ceil(delta / 3600));
  };

  return (
    <>
      <p className="settings-note">
        {t("这里只显示 QQ 侧真实保存的数据；清理只删除已经过期的内容。")}
      </p>
      {loading && <p role="status">{t("正在读取存储用量…")}</p>}
      {error && (
        <p role="alert" className="error">
          {translateNotice(error)}
        </p>
      )}
      {feedback && (
        <p className="hint workspace-feedback" role="status">
          {translateNotice(feedback)}
        </p>
      )}

      {usage && (
        <SettingsGroup id="qq-storage-usage" title="保存了什么" note="按表计数；素材副本单独治理。">
          <dl className="qq-storage-list">
            {row(
              "群与私聊消息",
              `${usage.observations.messages}`,
              t(
                "其中带正文 {0} 条，已过期 {1} 条",
                usage.observations.text,
                usage.observations.expired_text,
              ),
            )}
            {row("助手发言", `${usage.speech.records}`, t("其中带正文 {0} 条", usage.speech.text))}
            {row("发送台账", `${usage.sends.attempts}`, t("其中部件 {0} 条", usage.sends.parts))}
            {row(
              "成员昵称",
              `${usage.nicknames.current}`,
              t("其中已过期 {0} 条", usage.nicknames.expired),
            )}
            {row(
              "素材副本",
              `${usage.stickers.assets}`,
              t(
                "启用 {0} 个，占用 {1}；集合 {2} 个",
                usage.stickers.enabled,
                formatBytes(usage.stickers.bytes),
                usage.stickers.collections,
              ),
            )}
          </dl>
        </SettingsGroup>
      )}

      {usage && (
        <SettingsGroup
          id="qq-storage-waiting"
          title="QQ 侧在等什么"
          note="这些是真实的待办状态：安静的会话在等开场，收到媒体在等一次理解。"
        >
          <dl className="qq-storage-list">
            {row(
              "排队中的会话",
              `${usage.dispatch.candidates}`,
              t(
                "其中 {0} 个现在可跑；全局同一时刻只跑一条模型链（当前{1}）",
                usage.dispatch.ready_now,
                usage.dispatch.lease_held ? t("占用中") : t("空闲"),
              ),
            )}
            {row(
              "收到的媒体",
              `${usage.media.segments}`,
              t(
                "已理解 {0} 条；已尝试但还没有描述 {1} 条",
                usage.media.described,
                usage.media.pending,
              ),
            )}
          </dl>
        </SettingsGroup>
      )}

      {usage && (
        <SettingsGroup
          id="qq-storage-verdicts"
          title="冷场扫描的裁决"
          note="每个绑定会话一行，写的是最近一次扫描的结论：它决定开口，或者被哪一道门槛挡住。"
        >
          {usage.sweep.entries.length === 0 ? (
            <p className="hint">
              {t("还没有任何裁决记录：要么还没有绑定会话，要么运行时还没有扫描过一次。")}
            </p>
          ) : (
            <>
              {/* A recorded conversation always dates the pass it was recorded in, so the "never
                  swept" wording belongs to the empty state above and nowhere else. */}
              {usage.sweep.last_swept_at_seconds !== null && (
                <p className="hint">
                  {t("最近一次扫描：{0}。", ago(usage.sweep.last_swept_at_seconds))}
                </p>
              )}
              <dl className="qq-storage-list">
                {usage.sweep.entries.map((entry) => {
                  const label = `${entry.kind === "group" ? t("群") : t("私聊")} ${entry.peer_id}`;
                  const parts = [
                    entry.observed_at_seconds === null
                      ? null
                      : t("最近群友消息 {0}", ago(entry.observed_at_seconds)),
                    entry.ready_at_seconds === null
                      ? null
                      : t("最快{0}可以再判", ahead(entry.ready_at_seconds)),
                    t("本轮裁决 {0}", ago(entry.decided_at_seconds)),
                  ].filter((part): part is string => part !== null);
                  return row(
                    label,
                    entry.outcome === "scheduled"
                      ? t("已经决定开口")
                      : t(REASON_LABELS[entry.reason]),
                    parts.join(" · "),
                    `${entry.kind}:${entry.peer_id}`,
                  );
                })}
              </dl>
              {usage.sweep.tracked > usage.sweep.entries.length && (
                <p className="hint">
                  {t(
                    "共 {0} 个会话，这里显示最近裁决的 {1} 个。",
                    usage.sweep.tracked,
                    usage.sweep.entries.length,
                  )}
                </p>
              )}
            </>
          )}
        </SettingsGroup>
      )}

      <SettingsGroup
        id="qq-storage-retention"
        title="保留与清理"
        note={t(
          "消息正文、发送台账、助手发言正文与成员昵称都跟随同一个 {0} 天窗口，到期只删过期内容。",
          usage?.retention.days ?? 14,
        )}
      >
        <div className="qq-sticker-actions">
          <button type="button" disabled={saving} onClick={() => void cleanup()}>
            {t("立即清理过期内容")}
          </button>
        </div>
        {removed && (
          <p className="hint" role="status">
            {t(
              "上次清理：正文 {0} · 媒体说明 {1} · 发言 {2} · 台账 {3} · 昵称 {4}",
              removed.observation_text,
              removed.media_notes,
              removed.speech,
              removed.sends,
              removed.nicknames,
            )}
          </p>
        )}
        <p className="hint">{t("素材与集合不参与这里的清理：素材治理是独立的一块。")}</p>
        <p className="hint">
          {t("裁决记录也不参与清理：它每个扫描周期被重写，只保存结论、时间和原因，没有正文。")}
        </p>
      </SettingsGroup>

      <SettingsGroup id="qq-storage-open" title="还没有的东西" note="如实说明，不用 0 冒充。">
        <p className="hint">
          {t("收到的媒体缓存：本版只保存上游引用与模型描述，不落地字节，因此没有缓存体积。")}
        </p>
        <p className="hint">
          {t(
            "媒体读取失败只留下“尝试过、还没有描述”这一条事实与次数；失败原因不单独记录，处理方式与导出字段仍待定。",
          )}
        </p>
        <p className="hint">
          {t("计划里的失败记录（保留天数、脱敏与导出字段）仍未确定，因此这里也只报事实。")}
        </p>
        <p className="hint">
          {t(
            "直接回应与连续交谈的裁决没有单独记录：它们每一轮都从存储事实重新判断，不额外落库；这里只有冷场扫描的结论。",
          )}
        </p>
      </SettingsGroup>
    </>
  );
}
