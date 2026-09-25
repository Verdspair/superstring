import { useQqInput } from "./use-qq-input";
// QQ 聊天方案页 (§5.2's field groups, §11.2's shared draft; ADR0018 P5f).
//
// PR3 places this under 接入 with continuous anchored sections for triggers, rhythm, hours,
// prompts, output, context and resources. A scheme is a QQ-GLOBAL resource; the page follows the
// sticker library's rules: no assistant selector, notices in the page's own flow, and no controls
// for what is undecided or unwired.
//
// Two things are deliberately NOT on this page:
//
//   * Model selection. §11.1 keeps every model choice in Agent → 默认模型 and says feature pages
//     only link there; the page says so and links.
//   * Rebinding a conversation. §11.1 keeps the group/private list and its bindings in
//     接入 → 运行模式与连接, so `另存为新方案` ends by pointing there rather than at the scheme list.
//     growing a second binding surface here (§11.2's "按用户选择给目标群改绑" happens there).
//
// The prompts are edited in the group they belong to ("提示词就近放在相关功能分组") and the 提示词索引
// block at the top only scrolls to them — §3.3's rule that anchors scroll and never fold.
//
// 用户 2026-09-25 的九项改版（"所有ui和操作逻辑人性化、与其它页面一致"）：
//   1. 数字框编辑时不夹紧：边打边改，失焦才校验；不合法就报错并挡住保存，绝不静默改成边界值。
//   2. 切方案 / 新建 / 另存 / 删除之前，有未保存改动时先确认。
//   3. 保存条常驻页面底部（保存、放弃、还有多少没保存）。
//   4. 允许时段用时间选择器（本机时间；底层仍是当天第几分钟，判断端按运行时钟比）。
//   5. 数字字段统一用 `Field`（与其它设置页同一种标签、同一种小字）。
//   6. 上下文与记忆拆成「判断」「回复」两组，字段标签去掉前缀（名字里已说明归哪一组）。
//   7. 变更预览可开可关、按分区归组，改过的字段就地标「已修改」。
//   8. 四个触发开关写明各自受哪些节奏门槛约束；只读的回复任务框做出只读的样子。
//   9. 同类按钮就近按序：另存与新建相邻、删除独立在最后，日常的保存/放弃在底部条里。

import { useEffect, useState } from "react";
import { qqReplyTaskPrompt } from "../../../shared/contracts/qq";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { qqSchemeChanges, qqSchemeDirty } from "./types";

/** 本机与运行时钟（UTC）之间的一处换算；见 `fromLocalClock`。 */
const LOCAL_OFFSET_MINUTES = -new Date().getTimezoneOffset();
const clockOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/**
 * 允许时段在存储里是"当天第几分钟"，判断端拿运行时钟（epoch 秒）比，也就是 UTC 的第几分钟。
 * 页面上必须按本机时间显示与填写——填 22:00 的人说的是自己的晚上——所以这里做一次模 1440 的平移：
 * 平移不改变窗口形状，跨午夜与"开始＝结束＝全天"都照旧。
 */
const toLocalClock = (utcMinutes: number) =>
  clockOf((utcMinutes + LOCAL_OFFSET_MINUTES + 1440) % 1440);
const fromLocalClock = (clock: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return (hours * 60 + minutes - LOCAL_OFFSET_MINUTES + 1440) % 1440;
};

/** 字段标签与分区只有这一份：变更预览的分组、改过的标记都从它来，不另造一张会漂移的表。 */
const TRIGGERS = [
  {
    key: "direct_reply",
    label: "直接回应",
    hint: "群里明确叫到助手时回应；不受任何节奏门槛限制（随时可回）。",
  },
  { key: "follow_up", label: "连续交谈", hint: "正在进行的交谈里继续接话；同样不受节奏门槛限制。" },
  {
    key: "chiming_in",
    label: "自主接话",
    hint: "无人叫到时，判断值得再开口；还受发言冷却、每小时上限与允许时段约束。",
  },
  {
    key: "idle_topic",
    label: "冷场发起",
    hint: "会话安静满一段时间后主动开话题；还受冷场安静、发言冷却、每小时上限与允许时段约束。",
  },
] as const;

const RHYTHM_KEYS = {
  initiative_min_score: {
    label: "主动开口门槛（0–10 分）",
    hint: "判断模型给这次开口打兴趣分：跟说话的人本身的关系最重，其次是刚聊的这件事，再其次是记忆与资料；达到门槛才说话，调高更安静。每个人的合并窗口一结束就为他真判一次。",
    min: 0,
    max: 10,
  },
  merge_window_seconds: {
    label: "合并窗口（秒）",
    hint: "按人算：每个人自己的最后一条消息过了这么久才算说完，才为他判断一次门槛；0＝每条立即判断。",
    min: 0,
    max: 300,
  },
  reply_cooldown_seconds: {
    label: "发言冷却（秒）",
    hint: "两次主动发言之间的最小间隔；只约束主动发言。",
    min: 1,
    max: 600,
  },
  hourly_speech_limit: {
    label: "每小时上限",
    hint: "滚动一小时内的主动发言条数；只约束主动发言。",
    min: 1,
    max: 500,
  },
  idle_quiet_minutes: {
    label: "冷场安静（分钟）",
    hint: "最后一条群友消息之后安静这么久才算冷场。",
    min: 1,
    max: 1000,
  },
  max_recompute_count: {
    label: "最多重算次数",
    hint: "提交前发现关键补充时最多重算几次；0＝不重算。",
    min: 0,
    max: 2,
  },
} as const;

// 判断与回复各自一组（用户第 6 项）：`visible` 是分组标题下显示的短名，`label` 仍是完整名字
// （无障碍标签与变更预览用它），所以同一句话不会在页面上重复两遍。
type NumberRow = {
  readonly key: string;
  readonly label: string;
  readonly visible?: string;
  readonly hint?: string;
  readonly min: number;
  readonly max: number;
};

const CONTEXT: readonly (NumberRow & { readonly part: "判断" | "回复" })[] = [
  {
    key: "judgement_message_limit",
    label: "判断：最近条数",
    visible: "最近条数",
    part: "判断",
    min: 1,
    max: 200,
  },
  {
    key: "judgement_window_minutes",
    label: "判断：时间范围（分钟）",
    visible: "时间范围（分钟）",
    part: "判断",
    min: 1,
    max: 20160,
  },
  {
    key: "judgement_token_budget",
    label: "判断：预算（估算字节）",
    visible: "预算（估算字节）",
    part: "判断",
    min: 256,
    max: 16384,
  },
  {
    key: "reply_message_limit",
    label: "回复：最近条数",
    visible: "最近条数",
    part: "回复",
    min: 1,
    max: 500,
  },
  {
    key: "reply_window_minutes",
    label: "回复：时间范围（分钟）",
    visible: "时间范围（分钟）",
    part: "回复",
    min: 1,
    max: 20160,
  },
  {
    key: "reply_token_budget",
    label: "回复：预算（估算字节）",
    visible: "预算（估算字节）",
    part: "回复",
    min: 256,
    max: 16384,
  },
];

const RESERVE: readonly (NumberRow & { readonly part: "判断" | "回复" })[] = [
  {
    key: "judgement_output_reserved",
    label: "判断：输出预留（估算字节）",
    visible: "输出预留（估算字节）",
    part: "判断",
    hint: "为本次判断回答预留的容量；不是近期原文的上限。",
    min: 256,
    max: 16384,
  },
  {
    key: "reply_output_reserved",
    label: "回复：输出预留（估算字节）",
    visible: "输出预留（估算字节）",
    part: "回复",
    min: 256,
    max: 16384,
  },
];

const EXPRESSION = [
  {
    key: "max_sticker_count",
    label: "每条回复最多几张表情",
    hint: "上限，不是配额；模型只要一张就发一张。",
    min: 1,
    max: 3,
    // §5.2 lists it under 表达, but the stored group is `rhythm` (P3b-1); the page shows it here.
    group: "rhythm",
  },
  {
    key: "sticker_min_repeat_minutes",
    label: "同一素材最短重复间隔（分钟）",
    hint: "硬规则：未到间隔的素材不会被选用；0＝不限。",
    min: 0,
    max: 1440,
    group: "stickers",
  },
  {
    key: "sticker_recent_avoid_count",
    label: "最近几张尽量避开",
    hint: "软规则：只影响排序，不禁止；0＝不回避。",
    min: 0,
    max: 20,
    group: "stickers",
  },
  {
    key: "media_supplement_window_minutes",
    label: "被@媒体读取失败后的等待（分钟）",
    hint: "同一发言人在这个时间内继续发言，会再理解一次；0＝不等补充。",
    min: 0,
    max: 1440,
    group: "rhythm",
  },
  {
    key: "media_frame_count",
    label: "动图抽帧张数",
    hint: "动图按这个张数抽样理解，不是完整视频理解；越多越慢。",
    min: 1,
    max: 10,
    group: "rhythm",
  },
  {
    key: "media_max_dimension",
    label: "抽帧长边像素",
    hint: "抽出的帧按这个长边等比缩小后再交给图片模型。",
    min: 64,
    max: 2048,
    group: "rhythm",
  },
] as const;

const PROMPTS = [
  { key: "scene", label: "场景与行为", group: "speech", hint: "助手在 QQ 里怎么说话。" },
  { key: "judge", label: "判断任务", group: "speech", hint: "决定要不要开口。" },
  { key: "review", label: "复核任务", group: "speech", hint: "新消息来了，这条回复要不要改。" },
  {
    key: "sticker",
    label: "选图任务",
    group: "expression",
    hint: "从候选表情里挑一张；只输出编号。",
  },
  {
    key: "media",
    label: "媒体说明任务",
    group: "expression",
    hint: "如实说明图片或语音里有什么。",
  },
] as const;

/** 变更预览里的分区顺序（也是页面上分组的顺序）。 */
const PREVIEW_SECTIONS = [
  "方案",
  "发言触发",
  "节奏与门槛",
  "回答方式",
  "上下文与记忆（判断）",
  "上下文与记忆（回复）",
  "媒体与表达",
  "提示词",
] as const;

type PendingAction = {
  readonly message: string;
  readonly confirmLabel: string;
  readonly run: () => void;
};

export function SchemeSettings() {
  const t = useI18n();
  const schemes = useSuperstringStore((s) => s.qqSchemes);
  const loading = useSuperstringStore((s) => s.qqSchemesLoading);
  const saving = useSuperstringStore((s) => s.qqSchemeSaving);
  const editor = useSuperstringStore((s) => s.qqSchemeEditor);
  const usage = useSuperstringStore((s) => s.qqSchemeUsage);
  const collections = useSuperstringStore((s) => s.qqStickerCollections);
  const error = useSuperstringStore((s) => s.error);
  const feedback = useSuperstringStore((s) => s.feedback);
  const load = useSuperstringStore((s) => s.loadQqSchemes);
  const loadCollections = useSuperstringStore((s) => s.loadQqStickers);
  const select = useSuperstringStore((s) => s.selectQqScheme);
  const create = useSuperstringStore((s) => s.createQqScheme);
  const patch = useSuperstringStore((s) => s.patchQqScheme);
  const patchGroup = useSuperstringStore((s) => s.patchQqSchemeGroup);
  const save = useSuperstringStore((s) => s.saveQqScheme);
  const duplicate = useSuperstringStore((s) => s.duplicateQqScheme);
  const remove = useSuperstringStore((s) => s.deleteQqScheme);
  const discard = useSuperstringStore((s) => s.discardQqSchemeChanges);
  const openRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const [newName, setNewName] = useQqInput("schemeNewName");
  const [copyName, setCopyName] = useQqInput("schemeCopyName");
  const [texts, setTexts] = useQqInput("schemeTexts");
  const [invalid, setInvalid] = useQqInput("schemeInvalid");
  const [showPreview, setShowPreview] = useState(true);
  const [pending, setPending] = useState<PendingAction | null>(null);

  useEffect(() => {
    void load();
    void loadCollections();
  }, [load, loadCollections]);

  const dirty = qqSchemeDirty(editor);
  const changes = qqSchemeChanges(editor);
  const changedKeys = new Set(changes.map((change) => change.field));
  const invalidCount = Object.keys(invalid).length;
  const labelOf = (field: string): string => {
    const [group, key] = field.split(".");
    if (group === "name") return t("方案名称");
    if (group === "description") return t("说明");
    const table: Record<string, string> = {
      ...Object.fromEntries(TRIGGERS.map((row) => [`triggers.${row.key}`, row.label])),
      ...Object.fromEntries(
        Object.entries(RHYTHM_KEYS).map(([key, row]) => [`rhythm.${key}`, row.label]),
      ),
      ...Object.fromEntries(CONTEXT.map((row) => [`context.${row.key}`, row.label])),
      ...Object.fromEntries(RESERVE.map((row) => [`output_reserve.${row.key}`, row.label])),
      // Keyed by the row's OWN group: the expression section holds rows from two groups
      // (`max_sticker_count` lives in rhythm), and a mismatched key means the preview prints the
      // machine name instead of the label the user just edited.
      ...Object.fromEntries(EXPRESSION.map((row) => [`${row.group}.${row.key}`, row.label])),
      "sticker_collections.collection_ids": "授权集合",
      "reply.split_by_speaker": "按发言人分开回答",
      ...Object.fromEntries(PROMPTS.map((row) => [`prompts.${row.key}`, row.label])),
      // 时段三件套在预览里也要报得出名字（值渲染成时间，见 `changeValue`）。
      "rhythm.active_hours_enabled": "允许时段",
      "rhythm.active_hours_start_minutes": "允许时段开始",
      "rhythm.active_hours_end_minutes": "允许时段结束",
    };
    return t(table[field] ?? key ?? field);
  };
  const sectionOf = (field: string): string => {
    const [group, key] = field.split(".");
    if (group === "name" || group === "description") return "方案";
    if (group === "triggers") return "发言触发";
    if (group === "reply") return "回答方式";
    if (group === "context" || group === "output_reserve") {
      const part = [...CONTEXT, ...RESERVE].find((row) => row.key === key)?.part;
      return `上下文与记忆（${part ?? "判断"}）`;
    }
    if (group === "sticker_collections") return "媒体与表达";
    if (group === "stickers") return "媒体与表达";
    if (group === "prompts") return "提示词";
    if (group === "rhythm") {
      // 表情与媒体那几张数字住在 rhythm 组里，但页面上属于「媒体与表达」。
      return EXPRESSION.some((row) => row.group === "rhythm" && row.key === key)
        ? "媒体与表达"
        : "节奏与门槛";
    }
    return "其它";
  };
  // 时段的"当天第几分钟"在预览里按本机时间显示——与上面那个时间选择器看到的是同一个钟点。
  const changeValue = (field: string, value: string): string => {
    if (
      field === "rhythm.active_hours_start_minutes" ||
      field === "rhythm.active_hours_end_minutes"
    ) {
      const minutes = Number(value);
      return Number.isInteger(minutes) ? toLocalClock(minutes) : value;
    }
    return value;
  };
  const textOf = (event: { target: { value: string } }) => event.target.value;
  const clearField = (key: string) =>
    setTexts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  const clearInvalidField = (key: string) =>
    setInvalid((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  const resetInputs = () => {
    setTexts({});
    setInvalid({});
  };
  /** 有未保存（或还没改对）的东西时先问一句，再执行会丢掉/改写它们的动作。 */
  const guard = (message: string, confirmLabel: string, run: () => void) => {
    const proceed = () => {
      resetInputs();
      run();
    };
    if (!dirty && invalidCount === 0) {
      proceed();
      return;
    }
    setPending({ message, confirmLabel, run: proceed });
  };
  const numberField = (
    group: "rhythm" | "context" | "outputReserve" | "stickers",
    row: NumberRow,
  ) => {
    const field = `${group}.${row.key}`;
    const value = (
      group === "rhythm"
        ? (editor?.rhythm[row.key as keyof typeof editor.rhythm] as number)
        : group === "stickers"
          ? (editor?.stickers[row.key as keyof typeof editor.stickers] as number)
          : group === "context"
            ? (editor?.context[row.key as keyof typeof editor.context] as number)
            : (editor?.outputReserve[row.key as keyof typeof editor.outputReserve] as number)
    ) as number;
    const text = texts[field] ?? String(value);
    const error = invalid[field];
    const commit = (raw: string): boolean => {
      const next = Number(raw);
      if (raw.trim() === "" || !Number.isInteger(next)) return false;
      if (next < row.min || next > row.max) return false;
      void patchGroup(group, { [row.key]: next });
      return true;
    };
    return (
      <Field
        key={field}
        label={row.visible ?? row.label}
        info={row.hint}
        tag={changedKeys.has(field) ? t("已修改") : undefined}
      >
        <input
          type="number"
          min={row.min}
          max={row.max}
          disabled={saving}
          value={text}
          aria-label={t(row.label)}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            const raw = event.target.value;
            setTexts((prev) => ({ ...prev, [field]: raw }));
            // 边打边改：只有已经合法的值才写进草稿，这样变更预览是活的，而非法输入不会被夹紧。
            if (commit(raw)) clearInvalidField(field);
          }}
          onBlur={() => {
            if (!(field in texts)) return;
            if (commit(texts[field] ?? "")) {
              clearField(field);
              clearInvalidField(field);
              return;
            }
            setInvalid((prev) => ({
              ...prev,
              [field]: t("需要 {0}–{1} 之间的整数", row.min, row.max),
            }));
          }}
        />
        {error && (
          <small className="error" role="alert">
            {error}
          </small>
        )}
      </Field>
    );
  };

  return (
    <>
      <p className="settings-note">
        {t("QQ 全局方案，不随当前助手切换；群与私聊绑定方案后在「接入 → 运行模式与连接」改绑。")}
      </p>
      {loading && <p role="status">{t("正在读取聊天方案…")}</p>}
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

      {editor && (
        <>
          <nav className="workspace-anchors" aria-label={t("方案分区")}>
            {[
              ["pick", "方案"],
              ["speech", "何时观察与发言"],
              ["rhythm", "发言节奏"],
              ["hours", "主动发言时段"],
              ["prompts", "决策提示词"],
              ["output", "输出与受众"],
              ["context", "上下文与记忆"],
              ["knowledge", "知识库使用"],
              ["expression", "媒体与表达"],
            ].map(([id, label]) => (
              <a key={id} href={`#qq-scheme-${id}`}>
                {t(label ?? "")}
              </a>
            ))}
          </nav>
          <nav className="workspace-anchors" aria-label={t("提示词索引")}>
            <span>{t("提示词索引")}：</span>
            {PROMPTS.map((row) => (
              <a key={row.key} href={`#qq-prompt-${row.key}`}>
                {t(row.label)}
              </a>
            ))}
          </nav>
        </>
      )}

      <SettingsGroup
        id="qq-scheme-pick"
        title="方案"
        note="方案是 QQ 全局的命名资源，可以跨助手复用；这里改的是它本身，改绑会话在「接入 → 运行模式与连接」。"
      >
        <Field label="当前方案" info="切换方案会放弃未保存的改动；有改动时会先问一次。">
          <select
            aria-label={t("当前方案")}
            disabled={saving}
            value={editor?.source.id ?? ""}
            onChange={(event) => {
              const id = event.target.value;
              guard(
                t("当前方案有未保存的改动，切换会丢掉它们。要继续吗？"),
                t("放弃改动并继续"),
                () => select(id),
              );
            }}
          >
            {schemes.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </Field>
        {editor ? (
          <>
            <Field label="方案名称" info="方案的名字，也是你在绑定会话时看到的那一个。">
              <input
                value={editor.name}
                disabled={saving}
                aria-label={t("方案名称")}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>
            <Field label="说明" info="只给你自己看。">
              <input
                value={editor.description}
                disabled={saving}
                aria-label={t("说明")}
                onChange={(event) => patch({ description: event.target.value })}
              />
            </Field>
            <p className="hint" role="status">
              {usage?.schemeId === editor.source.id
                ? `${t("当前被")}${usage.bindings}${t("个会话使用")}${t("；改绑在「接入 → 运行模式与连接」。")}`
                : t("正在读取使用情况…")}
            </p>
            {/* 同类按钮就近按序（用户第 9 项）：另存与新建是同一类"造一个新方案"的动作，挨着；
                删除只属于眼前这个方案，单独一行放在最后；日常的保存/放弃在底部保存条里。 */}
            <Field
              label="另存为新方案"
              info="把当前草稿存成新方案，不动原来那个；有未保存的改动时会一起存进去。"
            >
              <input
                value={copyName}
                disabled={saving || !editor}
                aria-label={t("另存为新方案")}
                placeholder={t("新方案名称")}
                onChange={(event) => setCopyName(event.target.value)}
              />
              <button
                type="button"
                disabled={saving || !editor || copyName.trim() === ""}
                onClick={() => {
                  const name = copyName.trim();
                  if (name === "") return;
                  guard(
                    t("另存会把当前未保存的改动一起存进新方案；原方案保持已保存的样子。"),
                    t("继续"),
                    () => {
                      void duplicate(name).then((ok) => {
                        if (ok) setCopyName("");
                      });
                    },
                  );
                }}
              >
                {t("另存")}
              </button>
            </Field>
            <Field label="新建方案" info="新方案默认所有发言触发都是关闭的。">
              <input
                value={newName}
                disabled={saving}
                aria-label={t("新建方案")}
                placeholder={t("方案名称")}
                onChange={(event) => setNewName(event.target.value)}
              />
              <button
                type="button"
                disabled={saving || newName.trim() === ""}
                onClick={() => {
                  const name = newName.trim();
                  if (name === "") return;
                  guard(
                    t("新建会打开一个全新的方案；当前未保存的改动会丢失。"),
                    t("放弃改动并继续"),
                    () => {
                      void create(name).then((ok) => {
                        if (ok) setNewName("");
                      });
                    },
                  );
                }}
              >
                {t("新建")}
              </button>
            </Field>
            <div className="qq-scheme-danger">
              <button
                type="button"
                className="danger"
                disabled={saving}
                onClick={() => {
                  const used = usage?.schemeId === editor.source.id && usage.bindings > 0;
                  setPending({
                    message:
                      t("删除方案「{0}」；参数会一起删掉，不能撤销。", editor.source.name) +
                      (used
                        ? `${t("；它仍被")}${usage?.bindings ?? 0}${t("个会话使用，请先改绑")}`
                        : t("；没有会话在用它。")),
                    confirmLabel: t("确认删除"),
                    run: () => void remove(editor.source.id),
                  });
                }}
              >
                {t("删除方案")}
              </button>
            </div>
          </>
        ) : (
          <p className="hint">{t("还没有任何方案；新建一个才能配置。")}</p>
        )}
      </SettingsGroup>

      {editor && (
        <>
          <SettingsGroup
            id="qq-scheme-speech"
            title="何时观察与发言"
            note="触发开关决定哪几种发言会出现；节奏参数只约束主动发言，被叫到时的直接回应不受限。"
          >
            <div className="qq-scheme-checks">
              {TRIGGERS.map((row) => (
                <label key={row.key}>
                  <input
                    type="checkbox"
                    disabled={saving}
                    checked={editor.triggers[row.key]}
                    aria-label={t(row.label)}
                    onChange={(event) =>
                      void patchGroup("triggers", { [row.key]: event.target.checked })
                    }
                  />
                  <span>{t(row.label)}</span>
                  <small className="hint">{t(row.hint)}</small>
                </label>
              ))}
            </div>
          </SettingsGroup>
          <SettingsGroup id="qq-scheme-rhythm" title="发言节奏">
            <div className="qq-scheme-grid">
              {Object.entries(RHYTHM_KEYS).map(([key, row]) =>
                numberField("rhythm", { ...row, key }),
              )}
            </div>
          </SettingsGroup>
          <SettingsGroup id="qq-scheme-hours" title="主动发言时段">
            <div className="qq-scheme-grid">
              <Field
                label="允许时段"
                info="默认关闭＝不限；开启后只在这段时间内主动发言。"
                tag={changedKeys.has("rhythm.active_hours_enabled") ? t("已修改") : undefined}
              >
                <input
                  type="checkbox"
                  disabled={saving}
                  checked={editor.rhythm.active_hours_enabled}
                  aria-label={t("允许时段")}
                  onChange={(event) =>
                    void patchGroup("rhythm", { active_hours_enabled: event.target.checked })
                  }
                />
              </Field>
              {(["start", "end"] as const).map((edge) => {
                const key = `active_hours_${edge}_minutes` as const;
                const field = `rhythm.${key}`;
                const stored = editor.rhythm[key];
                const text = texts[field] ?? toLocalClock(stored);
                return (
                  <Field
                    key={field}
                    label={edge === "start" ? "时段开始" : "时段结束"}
                    info={
                      edge === "start"
                        ? "按本机时间填写；开始与结束相同＝全天，结束早于开始＝跨过午夜。"
                        : "按本机时间填写；可跨午夜，例如 22:00–07:00。"
                    }
                    tag={changedKeys.has(field) ? t("已修改") : undefined}
                  >
                    <input
                      type="time"
                      disabled={saving || !editor.rhythm.active_hours_enabled}
                      value={text}
                      aria-label={t(edge === "start" ? "允许时段开始" : "允许时段结束")}
                      onChange={(event) => {
                        const raw = event.target.value;
                        setTexts((prev) => ({ ...prev, [field]: raw }));
                        const minutes = fromLocalClock(raw);
                        if (minutes !== null) void patchGroup("rhythm", { [key]: minutes });
                      }}
                      onBlur={() => {
                        if (!(field in texts)) return;
                        const minutes = fromLocalClock(texts[field] ?? "");
                        if (minutes === null) {
                          // 只有两种可能：清空（还原已保存值）或浏览器给的半截时间；都退回原值。
                          clearField(field);
                          return;
                        }
                        void patchGroup("rhythm", { [key]: minutes });
                        clearField(field);
                      }}
                    />
                  </Field>
                );
              })}
            </div>
          </SettingsGroup>
          <SettingsGroup id="qq-scheme-prompts" title="决策提示词">
            {PROMPTS.filter((row) => row.group === "speech").map((row) => (
              <Field
                key={row.key}
                label={row.label}
                info={row.hint}
                tag={changedKeys.has(`prompts.${row.key}`) ? t("已修改") : undefined}
              >
                <textarea
                  id={`qq-prompt-${row.key}`}
                  rows={row.key === "scene" ? 6 : 4}
                  disabled={saving}
                  value={editor.prompts[row.key]}
                  aria-label={t(row.label)}
                  onChange={(event) => void patchGroup("prompts", { [row.key]: textOf(event) })}
                />
              </Field>
            ))}
          </SettingsGroup>
          <SettingsGroup id="qq-scheme-output" title="输出与受众">
            {/* 用户 2026-09-25：回复任务文案由这个开关选，开关下面就是当前生效的那一份（只读）。 */}
            <div className="qq-scheme-checks">
              <label>
                <input
                  type="checkbox"
                  disabled={saving}
                  checked={editor.reply.split_by_speaker}
                  aria-label={t("按发言人分开回答")}
                  onChange={(event) =>
                    void patchGroup("reply", { split_by_speaker: event.target.checked })
                  }
                />
                <span>{t("按发言人分开回答")}</span>
                <small className="hint">
                  {t(
                    "不同人发的话分开成各自的任务来跑：每人各自判断一次、各写一条回复，并 @ 到对方；同一个人不分条。关掉就用下面那份默认文案。",
                  )}
                </small>
              </label>
            </div>
            <Field
              label="回复任务"
              info={t(
                "这一段由上面的开关决定，暂时不能修改；开着＝按发言人分开回（一条消息只回一个人），关掉＝默认文案。",
              )}
              tag={changedKeys.has("reply.split_by_speaker") ? t("已修改") : undefined}
            >
              <textarea
                id="qq-prompt-reply"
                className="readonly-field"
                rows={4}
                readOnly
                disabled={saving}
                value={qqReplyTaskPrompt(editor.reply.split_by_speaker)}
                aria-label={t("回复任务")}
              />
            </Field>
          </SettingsGroup>

          <SettingsGroup
            id="qq-scheme-context"
            title="上下文与记忆"
            note="这里只配置近期原文和输出预留；长期记忆的读取与整理规则统一在「资料 → 长期记忆」管理。"
          >
            {(["判断", "回复"] as const).map((part) => (
              <div className="qq-scheme-part" key={part}>
                <h4>{t(part)}</h4>
                <div className="qq-scheme-grid">
                  {CONTEXT.filter((row) => row.part === part).map((row) =>
                    numberField("context", row),
                  )}
                  {RESERVE.filter((row) => row.part === part).map((row) =>
                    numberField("outputReserve", row),
                  )}
                </div>
              </div>
            ))}
            <p className="hint">
              {t("QQ 记忆按助手与会话隔离，本方案不改变记忆范围；")}
              <button
                type="button"
                className="link-button"
                onClick={() => openRoute("long-memory")}
              >
                {t("前往长期记忆")}
              </button>
            </p>
          </SettingsGroup>

          <SettingsGroup
            id="qq-scheme-knowledge"
            title="知识库使用"
            note="QQ 里读取知识库仍受当前助手的授权约束：方案只能沿用，不能扩大权限。"
          >
            <p className="hint">
              {t("资料与授权在「资料 → 知识库配置」里管理；这里没有独立的开关。")}
              <button
                type="button"
                className="link-button"
                onClick={() => openRoute("knowledge-config")}
              >
                {t("前往知识库配置")}
              </button>
            </p>
          </SettingsGroup>

          <SettingsGroup
            id="qq-scheme-expression"
            title="媒体与表达"
            note="表情的选择、防重复与授权集合；媒体理解用哪两个模型在默认模型页选择。"
          >
            <div className="qq-scheme-grid">
              {EXPRESSION.map((row) =>
                // The value comes from the row's OWN key. It used to be hard-coded to
                // `max_sticker_count` while that was the only rhythm-group row here, which meant a
                // second one displayed the first one's number (found by opening the page, P5o).
                numberField(row.group === "rhythm" ? "rhythm" : "stickers", row),
              )}
            </div>
            <Field
              label="授权集合"
              info="方案授权的是集合；新增并启用的素材进入已授权集合后即可被选用，不必改方案。"
            >
              {collections.length === 0 ? (
                <p className="hint">{t("还没有素材集合；先到表情素材页建一个。")}</p>
              ) : (
                <div className="qq-sticker-memberships">
                  {collections.map((collection) => (
                    <label key={collection.id}>
                      <input
                        type="checkbox"
                        disabled={saving}
                        checked={editor.stickerCollectionIds.includes(collection.id)}
                        onChange={(event) =>
                          patch({
                            stickerCollectionIds: event.target.checked
                              ? [...editor.stickerCollectionIds, collection.id]
                              : editor.stickerCollectionIds.filter((id) => id !== collection.id),
                          })
                        }
                      />
                      {collection.name}
                    </label>
                  ))}
                </div>
              )}
            </Field>
            {PROMPTS.filter((row) => row.group === "expression").map((row) => (
              <Field
                key={row.key}
                label={row.label}
                info={row.hint}
                tag={changedKeys.has(`prompts.${row.key}`) ? t("已修改") : undefined}
              >
                <textarea
                  id={`qq-prompt-${row.key}`}
                  rows={4}
                  disabled={saving}
                  value={editor.prompts[row.key]}
                  aria-label={t(row.label)}
                  onChange={(event) =>
                    void patchGroup("prompts", { [row.key]: event.target.value })
                  }
                />
              </Field>
            ))}
            <p className="hint">
              {t("媒体理解用哪个视觉或转写模型在默认模型页选择。")}
              <button type="button" className="link-button" onClick={() => openRoute("management")}>
                {t("前往默认模型")}
              </button>
            </p>
          </SettingsGroup>

          {showPreview && changes.length > 0 && (
            <div className="qq-scheme-preview" id="qq-scheme-changes">
              <h4>{t("将要保存的变更")}</h4>
              {PREVIEW_SECTIONS.map((section) => {
                const rows = changes.filter((change) => sectionOf(change.field) === section);
                if (rows.length === 0) return null;
                return (
                  <div key={section}>
                    <h5>{t(section)}</h5>
                    <ul>
                      {rows.map((change) => (
                        <li key={change.field}>
                          {labelOf(change.field)}：{changeValue(change.field, change.before)} →{" "}
                          {changeValue(change.field, change.after)}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
              <ul className="qq-scheme-preview-other">
                {changes
                  .filter((change) => sectionOf(change.field) === "其它")
                  .map((change) => (
                    <li key={change.field}>
                      {labelOf(change.field)}：{changeValue(change.field, change.before)} →{" "}
                      {changeValue(change.field, change.after)}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* 底部保存条（用户第 3 项）：日常动作只有一个地方，滑到哪都在。 */}
          <div className="qq-scheme-savebar">
            <button
              type="button"
              className="primary"
              disabled={saving || !dirty || invalidCount > 0}
              onClick={() => void save()}
            >
              {t(saving ? "正在保存方案…" : "保存方案")}
            </button>
            <button
              type="button"
              disabled={saving || (!dirty && invalidCount === 0)}
              onClick={() => {
                discard();
                resetInputs();
              }}
            >
              {t("放弃改动")}
            </button>
            <span className="hint" role="status">
              {invalidCount > 0
                ? t("有 {0} 处输入还需要改对，改好才能保存。", invalidCount)
                : dirty
                  ? t("共 {0} 项改动尚未保存。", changes.length)
                  : t("当前方案已保存。")}
            </span>
            <button
              type="button"
              className="link-button"
              aria-expanded={showPreview}
              aria-controls="qq-scheme-changes"
              onClick={() => setShowPreview((value) => !value)}
            >
              {t(showPreview ? "隐藏变更预览" : "显示变更预览")}
            </button>
          </div>
        </>
      )}

      {pending && (
        <ConfirmDialog
          message={pending.message}
          confirmLabel={pending.confirmLabel}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const action = pending;
            setPending(null);
            action.run();
          }}
        />
      )}
    </>
  );
}
