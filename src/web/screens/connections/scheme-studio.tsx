import { Copy, Crosshair, FileDiff, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  QQ_REPLY_DEFAULT_PROMPT,
  type QqSchemePrompts,
  qqEffectiveReplyPrompt,
} from "../../../shared/contracts/qq";
import { ConfirmDialog } from "../../components/confirmation";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { NativeSelect } from "../../components/ui/native-select";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";
import { invalidSchemeInputs, invalidSchemeTimezone } from "../../features/qq/draft-state";
import {
  imageFields,
  participationFields,
  QQ_SCHEME_ENUM_OPTION_LABELS,
  QQ_SCHEME_FIELD_LABELS,
  QQ_SCHEME_SECTIONS,
  responseFields,
  stickerFields,
  TRIGGER_LABELS,
} from "../../features/qq/scheme-field-metadata";
import { qqSchemeChanges, qqSchemeDirty } from "../../features/qq/types";
import { useQqInput } from "../../features/qq/use-qq-input";
import { translateNotice } from "../../i18n";
import type { SuperstringState } from "../../state/types";
import { useSuperstringStore } from "../../store";
import { QqMessagePreview } from "./qq-message-preview";
import { SchemeFieldCard } from "./scheme-field-shared";
import {
  fieldBounds,
  headroomPercentBounds,
  isValidTimezone,
  localClock,
  type NumberEditorGroup,
  numberEditorGroups,
  type SchemeTask,
  schemeFieldTask,
  TIMEZONE_SUGGESTIONS,
  utcMinutes,
} from "./scheme-fields";

/** Only these fields are switches; text that reads "true"/"开"/"关" is the user's own content. */
const schemeBooleanFields: ReadonlySet<string> = new Set([
  ...Object.keys(TRIGGER_LABELS).map((key) => `triggers.${key}`),
  "rhythm.active_hours_enabled",
  "rhythm.initiative_queue_on_busy",
  "reply.split_by_speaker",
  // 0052 的 stages 布尔同样按开/关渲染（人话，不出现 true/false）。
  "media_input.stages.decision",
  "media_input.stages.evaluation",
  "media_input.stages.generation",
]);

/** 文案键唯一来源在 features/qq/scheme-field-metadata（含触发器与 0052 两组）；这里只补方案名/描述两项页面专属键。 */
const schemeFieldLabels: Readonly<Record<string, string>> = {
  name: "connections.schemeName",
  description: "connections.description",
  ...QQ_SCHEME_FIELD_LABELS,
};

/** Collection ids read as names; an id no known collection matches stays visible instead of vanishing. */
function schemeCollectionNames(
  joined: string,
  collections: readonly { readonly id: string; readonly name: string }[],
): string {
  if (joined.trim() === "") return joined;
  return joined
    .split("、")
    .map((id) => collections.find((collection) => collection.id === id)?.name ?? id)
    .join("、");
}

/** 枚举选项的中话标签（值原样进入载荷，不在这里改写契约值）。 */
const schemeEnumLabels = QQ_SCHEME_ENUM_OPTION_LABELS;

/**
 * 数字输入：原文留在草稿里，只有契约 schema 认可的值才写回方案；无效原文不丢弃、保存被禁用。
 * min/max/step 现读契约（fieldBounds），浏览器拦下的范围就是服务端会拒绝的范围；
 * 错误用 aria-describedby 挂在同一个输入上，另有页脚的「定位」按钮把焦点送回这里。
 * 0052 的两组编辑器组同样走这里（messageSettings/mediaInput），canonical 键保持 message_settings.<key>。
 */
function SchemeNumber({
  group,
  name,
  label,
  info,
  disabled = false,
}: {
  group: NumberEditorGroup;
  name: string;
  label: string;
  info?: string;
  /** 外部条件禁用（如 one_then_on_demand 下的层数）：控件不可改，配置值原样保留。 */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.qqSchemeEditor);
  const saving = useSuperstringStore((s) => s.qqSchemeSaving);
  const patch = useSuperstringStore((s) => s.patchQqSchemeGroup);
  const [texts, setTexts] = useQqInput("schemeTexts");
  const [invalid, setInvalid] = useQqInput("schemeInvalid");
  if (!editor) return null;
  const id = `${group}.${name}`;
  const inputId = `scheme-field-${id}`;
  const errorId = `${inputId}-error`;
  const bounds = fieldBounds(group, name);
  const value = (editor[group] as unknown as Record<string, number>)[name] ?? 0;
  const fieldSchema = (
    numberEditorGroups[group].shape as Record<
      string,
      { safeParse: (v: unknown) => { success: boolean } } | undefined
    >
  )[name];
  const valid = (raw: string) =>
    raw.trim() !== "" && fieldSchema?.safeParse(Number(raw)).success === true;
  const clear = () => {
    setTexts((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    setInvalid((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  };
  return (
    <Field label={label} info={info}>
      <Input
        id={inputId}
        type="number"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        disabled={saving || disabled}
        value={texts[id] ?? String(value)}
        aria-invalid={!!invalid[id]}
        aria-describedby={invalid[id] ? errorId : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          setTexts((old) => ({ ...old, [id]: raw }));
          if (valid(raw)) {
            patch(group, { [name]: Number(raw) });
            setInvalid((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
          }
        }}
        onBlur={() => {
          const raw = texts[id];
          if (raw === undefined) return;
          if (valid(raw)) {
            patch(group, { [name]: Number(raw) });
            clear();
          } else
            setInvalid((old) => ({
              ...old,
              [id]: t("schemes.studio.integerRange", {
                "0": String(bounds.min ?? ""),
                "1": String(bounds.max ?? ""),
              }),
            }));
        }}
      />
      {invalid[id] && (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {invalid[id]}
        </p>
      )}
    </Field>
  );
}

/** 枚举选择（引用模式/时间模式/图片输入模式）：选项显示人话，载荷原样存契约值。 */
function SchemeEnum({
  group,
  name,
  label,
  info,
}: {
  group: "messageSettings" | "mediaInput";
  name: string;
  label: string;
  info?: string;
}) {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.qqSchemeEditor);
  const saving = useSuperstringStore((s) => s.qqSchemeSaving);
  const patch = useSuperstringStore((s) => s.patchQqSchemeGroup);
  if (!editor) return null;
  const value = (editor[group] as unknown as Record<string, string>)[name];
  // 选项标签按 canonical 持久键查（message_settings/media_input），与预览的 field 键一致。
  const canonicalGroup = group === "messageSettings" ? "message_settings" : "media_input";
  const labels = schemeEnumLabels[`${canonicalGroup}.${name}`] ?? {};
  return (
    <Field label={label} info={info}>
      <NativeSelect
        id={`scheme-field-${group}.${name}`}
        data-field={`${group}.${name}`}
        disabled={saving}
        value={value}
        onChange={(e) => patch(group, { [name]: e.target.value })}
      >
        {Object.entries(labels).map(([key, labelKey]) => (
          <option key={key} value={key}>
            {t(labelKey)}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

/**
 * 时区：可输入可选择的自由文本。合法 IANA 名称写进编辑器；非法原文留在 schemeTexts 并
 * aria 关联错误（invalidSchemeTimezone 拦页内/复制/统一保存），不洗成默认值。
 */
function SchemeTimezone({ label }: { label: string }) {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.qqSchemeEditor);
  const saving = useSuperstringStore((s) => s.qqSchemeSaving);
  const patch = useSuperstringStore((s) => s.patchQqSchemeGroup);
  const [texts, setTexts] = useQqInput("schemeTexts");
  const [invalid, setInvalid] = useQqInput("schemeInvalid");
  if (!editor) return null;
  const id = "message_settings.timezone";
  const inputId = `scheme-field-${id}`;
  const errorId = `${inputId}-error`;
  const raw = texts[id];
  const valid = isValidTimezone;
  return (
    <Field label={label} info="connections.timezoneHint">
      <Input
        id={inputId}
        type="text"
        list="scheme-timezone-suggestions"
        disabled={saving}
        value={raw ?? editor.messageSettings.timezone}
        aria-invalid={!!invalid[id]}
        aria-describedby={invalid[id] ? errorId : undefined}
        onChange={(e) => {
          const value = e.target.value;
          setTexts((old) => ({ ...old, [id]: value }));
          if (valid(value)) {
            patch("messageSettings", { timezone: value.trim() });
            setInvalid((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
          } else setInvalid((old) => ({ ...old, [id]: t("connections.timezoneInvalid") }));
        }}
      />
      <datalist id="scheme-timezone-suggestions">
        {TIMEZONE_SUGGESTIONS.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      {invalid[id] && (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {invalid[id]}
        </p>
      )}
    </Field>
  );
}

/** 图片输入的阶段开关：独立三开关，全关合法（图片能力开着但不自动发画面，仅按需）。 */
function StageSwitch({ phase }: { phase: "decision" | "evaluation" | "generation" }) {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.qqSchemeEditor);
  const saving = useSuperstringStore((s) => s.qqSchemeSaving);
  const patchQqScheme = useSuperstringStore((s) => s.patchQqScheme);
  if (!editor) return null;
  const labelKey = `schemes.studio.stage${phase[0].toUpperCase()}${phase.slice(1)}`;
  const label = t(labelKey);
  return (
    <Label className="rounded-lg border p-4">
      <Checkbox
        disabled={saving}
        aria-label={label}
        checked={editor.mediaInput.stages[phase]}
        onCheckedChange={(checked) =>
          patchQqScheme({
            mediaInput: {
              ...editor.mediaInput,
              stages: { ...editor.mediaInput.stages, [phase]: checked === true },
            },
          })
        }
      />
      <span className="space-y-1">
        <span className="block">{label}</span>
        <span className="block text-xs font-normal leading-5 text-muted-foreground">
          {t("schemes.studio.stageOffHint")}
        </span>
      </span>
    </Label>
  );
}

/**
 * 普通静图规格：显式「原图 / 限制长边」二选一 + 数值输入。null＝原图是真实设置值，
 * 不是 0 或缺省——不允许把 0 当成原图（0 不在契约 64–2048 内，会拦保存）。
 */
function OrdinaryStillSpec() {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.qqSchemeEditor);
  const saving = useSuperstringStore((s) => s.qqSchemeSaving);
  const patch = useSuperstringStore((s) => s.patchQqSchemeGroup);
  const [texts, setTexts] = useQqInput("schemeTexts");
  const [invalid, setInvalid] = useQqInput("schemeInvalid");
  if (!editor) return null;
  const name = "ordinary_still_max_dimension";
  const id = `media_input.${name}`;
  const inputId = `scheme-field-${id}`;
  const errorId = `${inputId}-error`;
  const bounds = fieldBounds("mediaInput", name);
  const current = editor.mediaInput[name];
  const raw = texts[id];
  const valid = (value: string) =>
    value.trim() !== "" &&
    /^\d+$/.test(value.trim()) &&
    Number(value) >= 64 &&
    Number(value) <= 2048;
  const choose = (kind: "original" | "limited") => {
    if (kind === "original") {
      // 显式原图：写 null，清掉非法原文。
      patch("mediaInput", { [name]: null });
      setTexts((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
      setInvalid((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
    } else if (current === null) {
      // 从原图切到限制长边：无先前数值，给契约下限起步（不是 0）。
      patch("mediaInput", { [name]: 64 });
    }
  };
  return (
    // Field 的 control 探测取第一个表单子件（选择框），htmlFor 正确挂到它；
    // 数值框各自带显式 aria-label「长边上限」，两个控件可标注名不同，测试可各自唯一定位。
    <Field label="connections.ordinaryStillChoice" info="connections.ordinaryStillOriginal">
      <NativeSelect
        id={`${inputId}-choice`}
        data-field={`${id}.choice`}
        disabled={saving}
        value={current === null ? "original" : "limited"}
        onChange={(e) => choose(e.target.value === "original" ? "original" : "limited")}
      >
        <option value="original">{t("connections.ordinaryStillOriginal")}</option>
        <option value="limited">{t("connections.ordinaryStillLimited")}</option>
      </NativeSelect>
      <Input
        id={inputId}
        type="number"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        /* 嵌套组合件各自显式命名：数值框用「长边上限」，选择（含 Field 标题）用「规格」。 */
        aria-label={t("connections.ordinaryStillMaxDimension")}
        disabled={saving || current === null}
        value={raw ?? String(current ?? 64)}
        aria-invalid={!!invalid[id]}
        aria-describedby={invalid[id] ? errorId : undefined}
        onChange={(e) => {
          const value = e.target.value;
          setTexts((old) => ({ ...old, [id]: value }));
          if (valid(value)) {
            patch("mediaInput", { [name]: Number(value) });
            setInvalid((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
          }
        }}
        onBlur={() => {
          const value = texts[id];
          if (value === undefined || current === null) return;
          if (valid(value)) {
            patch("mediaInput", { [name]: Number(value) });
            setInvalid((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
            setTexts((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
          } else
            setInvalid((old) => ({
              ...old,
              [id]: t("schemes.studio.integerRange", {
                "0": String(bounds.min ?? ""),
                "1": String(bounds.max ?? ""),
              }),
            }));
        }}
      />
      {invalid[id] && (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {invalid[id]}
        </p>
      )}
    </Field>
  );
}

/**
 * 回复档的「消息条数」不再由方案决定：它跟随**绑定助手**的「保留最近轮数」，
 * 所以这里只读显示——值一致就显示该值，多个助手不同就显示区间，没有会话用这个方案就直说。
 */
function BoundRecentTurns() {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.qqSchemeEditor);
  const qqBindings = useSuperstringStore((s) => s.qqBindings);
  const agents = useSuperstringStore((s) => s.agents);
  const loadQqBindings = useSuperstringStore((s) => s.loadQqBindings);
  useEffect(() => {
    void loadQqBindings();
  }, [loadQqBindings]);
  if (!editor) return null;
  const agentIds = new Set(
    qqBindings
      .filter((binding) => binding.scheme_id === editor.source.id)
      .map((binding) => binding.agent_id),
  );
  const values = [
    ...new Set(
      agents.filter((agent) => agentIds.has(agent.id)).map((agent) => agent.p5_config.recent_turns),
    ),
  ].sort((left, right) => left - right);
  const value =
    agentIds.size === 0
      ? t("connections.noConversationUsesThisSchemeYet")
      : values.length === 0
        ? t("connections.followsTheBoundAssistant")
        : values.length === 1
          ? String(values[0])
          : t("connections.variesByAssistantBetween", {
              "0": String(values[0]),
              "1": String(values[values.length - 1]),
            });
  return (
    <Field
      label="connections.replyRecentMessages"
      info="connections.followsTheBoundAssistantRecentTurns"
    >
      <p className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">{value}</p>
    </Field>
  );
}

/** 装配冗余在界面上是整数百分比，存的是比例（5 ↔ 0.05）；边界同样来自契约（0–50）。 */
function SchemePercent({
  name,
  label,
  info,
}: {
  name: "headroom_ratio";
  label: string;
  info: string;
}) {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.qqSchemeEditor);
  const saving = useSuperstringStore((s) => s.qqSchemeSaving);
  const patch = useSuperstringStore((s) => s.patchQqSchemeGroup);
  const [texts, setTexts] = useQqInput("schemeTexts");
  const [invalid, setInvalid] = useQqInput("schemeInvalid");
  if (!editor) return null;
  const id = `compression.${name}`;
  const inputId = `scheme-field-${id}`;
  const errorId = `${inputId}-error`;
  const bounds = headroomPercentBounds();
  const percent = Math.round(editor.compression[name] * 100);
  const valid = (raw: string) =>
    raw.trim() !== "" &&
    Number.isInteger(Number(raw)) &&
    Number(raw) >= bounds.min &&
    Number(raw) <= bounds.max;
  const write = (raw: string) => patch("compression", { [name]: Number(raw) / 100 });
  const clear = () => {
    setTexts((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    setInvalid((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  };
  return (
    <Field label={label} info={info}>
      <Input
        id={inputId}
        type="number"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        disabled={saving}
        value={texts[id] ?? String(percent)}
        aria-invalid={!!invalid[id]}
        aria-describedby={invalid[id] ? errorId : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          setTexts((old) => ({ ...old, [id]: raw }));
          if (valid(raw)) {
            write(raw);
            setInvalid((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
          }
        }}
        onBlur={() => {
          const raw = texts[id];
          if (raw === undefined) return;
          if (valid(raw)) {
            write(raw);
            clear();
          } else
            setInvalid((old) => ({
              ...old,
              [id]: t("schemes.studio.integerRange", {
                "0": String(bounds.min),
                "1": String(bounds.max),
              }),
            }));
        }}
      />
      {invalid[id] && (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {invalid[id]}
        </p>
      )}
    </Field>
  );
}

/** 提示词槽位：值原样保存、原样使用，不在这里改写用户的文字。 */
function PromptEditor({
  slot,
  titleKey,
  hint,
}: {
  slot: keyof QqSchemePrompts;
  titleKey: string;
  hint?: string;
}) {
  const qqSchemeEditor = useSuperstringStore((s) => s.qqSchemeEditor);
  const qqSchemeSaving = useSuperstringStore((s) => s.qqSchemeSaving);
  const patchQqSchemeGroup = useSuperstringStore((s) => s.patchQqSchemeGroup);
  return (
    <Field label={titleKey} info={hint}>
      <Textarea
        className="min-h-36 font-mono text-xs leading-6"
        disabled={qqSchemeSaving}
        value={qqSchemeEditor?.prompts[slot] ?? ""}
        onChange={(e) => patchQqSchemeGroup("prompts", { [slot]: e.target.value })}
      />
    </Field>
  );
}

export function SchemeStudio({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const state = useSuperstringStore(
    useShallow((s) => ({
      // 数据字段：按实际读取面窄订阅；无关 store 更新不再重渲染本页。
      error: s.error,
      feedback: s.feedback,
      qqInputs: s.qqInputs,
      qqSchemeEditor: s.qqSchemeEditor,
      qqSchemeSaving: s.qqSchemeSaving,
      qqSchemes: s.qqSchemes,
      qqSchemesLoading: s.qqSchemesLoading,
      qqSchemeUsage: s.qqSchemeUsage,
      qqSchemeUsageError: s.qqSchemeUsageError,
      qqStickerCollections: s.qqStickerCollections,
      // 动作引用稳定（zustand store 动作不随 set 重建）。
      createQqScheme: s.createQqScheme,
      deleteQqScheme: s.deleteQqScheme,
      discardQqSchemeChanges: s.discardQqSchemeChanges,
      duplicateQqScheme: s.duplicateQqScheme,
      loadQqSchemes: s.loadQqSchemes,
      loadQqStickers: s.loadQqStickers,
      openSettingsRoute: s.openSettingsRoute,
      patchQqScheme: s.patchQqScheme,
      patchQqSchemeGroup: s.patchQqSchemeGroup,
      refreshQqScheme: s.refreshQqScheme,
      requestQqSchemeNavigation: s.requestQqSchemeNavigation,
      saveQqScheme: s.saveQqScheme,
    })),
  );
  const { loadQqSchemes, loadQqStickers, qqSchemeEditor: editor, qqSchemeSaving: saving } = state;
  const [task, setTask] = useState<SchemeTask>("participation");
  const [visitedTasks, setVisitedTasks] = useState<SchemeTask[]>(["participation"]);
  const taskScrollRoot = useRef<HTMLDivElement>(null);
  const taskScrollPositions = useRef(new Map<SchemeTask, number>());
  const previousTask = useRef(task);
  useLayoutEffect(() => {
    const viewport = taskScrollRoot.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport || previousTask.current === task) return;
    taskScrollPositions.current.set(previousTask.current, viewport.scrollTop);
    viewport.scrollTop = taskScrollPositions.current.get(task) ?? 0;
    previousTask.current = task;
  }, [task]);
  useEffect(() => {
    setVisitedTasks((previous) => (previous.includes(task) ? previous : [...previous, task]));
  }, [task]);
  const [naming, setNaming] = useState<{ kind: "new" | "copy"; step: "name" | "draft" } | null>(
    null,
  );
  const [namingBusy, setNamingBusy] = useState(false);
  const [newName, setNewName] = useQqInput("schemeNewName");
  const [copyName, setCopyName] = useQqInput("schemeCopyName");
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [focusField, setFocusField] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    void loadQqSchemes();
    void loadQqStickers();
  }, [active, loadQqSchemes, loadQqStickers]);
  // 定位到出错字段：先切页签；Radix 面板内容下一帧才挂载，所以等一帧并做有限重试。
  useEffect(() => {
    if (!focusField) return;
    const id = `scheme-field-${focusField}`;
    let attempts = 0;
    let raf = 0;
    const tryFocus = () => {
      const el = document.getElementById(id);
      if (el) {
        el.focus();
        setFocusField(null);
        return;
      }
      if (++attempts < 10) raf = requestAnimationFrame(tryFocus);
      else setFocusField(null);
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, [focusField]);
  const changes = qqSchemeChanges(editor);
  const previewValue = (field: string, raw: string) => {
    if (field === "sticker_collections.collection_ids")
      return schemeCollectionNames(raw, state.qqStickerCollections);
    // Stored ratio/UTC minutes; the form edits percent and local clock, so the preview does too.
    if (field === "compression.headroom_ratio") {
      const ratio = Number(raw);
      return Number.isFinite(ratio) ? String(Math.round(ratio * 100)) : raw;
    }
    if (
      field === "rhythm.active_hours_start_minutes" ||
      field === "rhythm.active_hours_end_minutes"
    ) {
      const minutes = Number(raw);
      return Number.isFinite(minutes) ? localClock(minutes) : raw;
    }
    if (schemeBooleanFields.has(field) && (raw === "true" || raw === "false"))
      return t(raw === "true" ? "connections.on" : "connections.off");
    // 0052 枚举：预览按选项人话渲染（null 原图读「原图」，其余数字/文本原样）。
    const enumLabels = schemeEnumLabels[field];
    if (enumLabels?.[raw]) return t(enumLabels[raw]);
    if (field === "media_input.ordinary_still_max_dimension" && raw === "null")
      return t("connections.ordinaryStillOriginal");
    return raw;
  };
  const invalidFields = [
    ...new Set([
      ...Object.keys(state.qqInputs.schemeInvalid),
      // invalidSchemeInputs 只读 qqSchemeEditor 与 qqInputs；本页已窄订阅这两个字段。
      ...invalidSchemeInputs({
        qqSchemeEditor: state.qqSchemeEditor,
        qqInputs: state.qqInputs,
      } as SuperstringState).map(([field]) => field),
    ]),
  ];
  const invalid = invalidFields.length > 0;
  const dirty = qqSchemeDirty(editor) || invalid;
  const selectedUsage =
    state.qqSchemeUsage && state.qqSchemeUsage.schemeId === editor?.source.id
      ? state.qqSchemeUsage.bindings
      : null;
  const effectiveTab = editor ? task : "participation";
  const namingName = naming?.kind === "copy" ? copyName : newName;
  // 命名确认：新建且草稿已改时先问草稿去向；放弃继续会保留原草稿直到创建成功（失败不丢草稿与名称）。
  const busy = namingBusy || saving || state.qqSchemesLoading;
  const runNaming = async (saveFirst: boolean) => {
    if (!naming || busy) return;
    setNamingBusy(true);
    try {
      if (saveFirst && !(await state.saveQqScheme())) return;
      const name = namingName.trim();
      const ok =
        naming.kind === "copy"
          ? await state.duplicateQqScheme(name)
          : await state.createQqScheme(name);
      if (ok) {
        setNaming(null);
        setNewName("");
        setCopyName("");
      }
    } finally {
      setNamingBusy(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <NativeSelect
          className="min-w-48"
          aria-label={t("connections.chooseAChatScheme")}
          value={editor?.source.id ?? ""}
          disabled={busy}
          onChange={(e) => state.requestQqSchemeNavigation(e.target.value)}
        >
          {!state.qqSchemes.length && <option value="">{t("connections.noSchemesYet")}</option>}
          {state.qqSchemes.map((scheme) => (
            <option key={scheme.id} value={scheme.id}>
              {scheme.name}
            </option>
          ))}
        </NativeSelect>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!editor || busy}
            onClick={() => void state.refreshQqScheme()}
          >
            <RefreshCw />
            {t("schemes.studio.refresh")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setNaming({ kind: "new", step: "name" })}
          >
            <Plus />
            {t("connections.create")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!editor || busy || invalid}
            onClick={() => setNaming({ kind: "copy", step: "name" })}
          >
            <Copy />
            {t("connections.saveAs")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("connections.deleteScheme")}
            disabled={!editor || busy || selectedUsage !== 0}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
          </Button>
        </div>
        {editor && selectedUsage !== 0 && (
          <p className="w-full text-xs text-muted-foreground">
            {selectedUsage === null
              ? t("schemes.studio.usageUnknownCannotDelete")
              : t("schemes.studio.inUseCannotDelete", { "0": selectedUsage })}
          </p>
        )}
      </div>
      {!editor ? (
        <div className="grid flex-1 place-content-center gap-3 p-8 text-center">
          <h2 className="text-lg font-medium">
            {t("connections.defineParticipationInRealConversations")}
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("connections.aSchemeCanBeSharedBySeveralGroupsOr")}
          </p>
          <Button disabled={saving} onClick={() => setNaming({ kind: "new", step: "name" })}>
            <Plus />
            {t("connections.newScheme")}
          </Button>
        </div>
      ) : (
        <Tabs
          value={effectiveTab}
          onValueChange={(value) => setTask(value as SchemeTask)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="border-b px-4 py-3">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="connections.schemeName">
                <Input
                  value={editor.name}
                  disabled={saving}
                  onChange={(e) => state.patchQqScheme({ name: e.target.value })}
                />
              </Field>
              <Field label="connections.description">
                <Input
                  value={editor.description}
                  disabled={saving}
                  onChange={(e) => state.patchQqScheme({ description: e.target.value })}
                />
              </Field>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t("schemes.sharedScopeNote")}</p>
          </div>
          <div className="border-b px-4 py-3">
            <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:h-auto [&_[role=tab]]:whitespace-normal">
              {QQ_SCHEME_SECTIONS.map((section) => (
                <TabsTrigger key={section.id} value={section.id}>
                  {t(section.labelKey)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <ScrollArea ref={taskScrollRoot} className="min-h-0 flex-1">
            <div className="min-w-0 space-y-6 px-4 py-6">
              {(effectiveTab === "participation" || visitedTasks.includes("participation")) && (
                <TabsContent
                  value="participation"
                  forceMount
                  className="m-0 space-y-6 data-[state=inactive]:hidden"
                >
                  <SchemeFieldCard
                    title={t("connections.speechTriggers")}
                    description="schemes.studio.triggersHint"
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      {Object.entries(TRIGGER_LABELS).map(([key, label]) => (
                        <Label key={key} className="flex items-start gap-3 rounded-lg border p-4">
                          <Checkbox
                            disabled={saving}
                            checked={editor.triggers[key as keyof typeof TRIGGER_LABELS]}
                            onCheckedChange={(value) => {
                              if (key === "follow_up" && value === true) {
                                state.patchQqSchemeGroup("triggers", {
                                  follow_up: true,
                                  chiming_in: false,
                                });
                              } else if (key === "chiming_in" && value === true) {
                                state.patchQqSchemeGroup("triggers", {
                                  chiming_in: true,
                                  follow_up: false,
                                });
                              } else {
                                state.patchQqSchemeGroup("triggers", { [key]: value === true });
                              }
                            }}
                          />
                          <span className="space-y-1">
                            <span className="block">{t(label)}</span>
                            <span className="block text-xs font-normal leading-5 text-muted-foreground">
                              {t(
                                key === "direct_reply" || key === "follow_up"
                                  ? "connections.directRepliesAndOngoingConversationsAreNotSubjectTo"
                                  : "connections.subjectToScoreCooldownHourlyLimitsAndActiveHours",
                              )}
                            </span>
                          </span>
                        </Label>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t("connections.triggersMutualExclusionHint")}
                    </p>
                    {editor.triggers.follow_up && editor.triggers.chiming_in && (
                      <div className="mt-3 rounded-md bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                        {t("connections.legacyChimingInPrecedenceNotice")}
                      </div>
                    )}
                  </SchemeFieldCard>
                  <SchemeFieldCard
                    title={t("schemes.studio.rhythmTitle")}
                    description="schemes.studio.rhythmHint"
                  >
                    <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                      {participationFields.map(([name, label, info]) => (
                        <SchemeNumber
                          key={name}
                          group="rhythm"
                          name={name}
                          label={label}
                          info={info}
                        />
                      ))}
                      <Label className="flex items-start gap-3 rounded-lg border p-4 sm:col-span-2">
                        <Checkbox
                          disabled={saving}
                          checked={editor.rhythm.initiative_queue_on_busy}
                          onCheckedChange={(checked) =>
                            state.patchQqSchemeGroup("rhythm", {
                              initiative_queue_on_busy: checked === true,
                            })
                          }
                        />
                        <span className="space-y-1">
                          <span className="block">{t("connections.initiativeQueueOnBusy")}</span>
                          <span className="block text-xs font-normal leading-5 text-muted-foreground">
                            {t("connections.initiativeQueueOnBusyHint")}
                          </span>
                        </span>
                      </Label>
                    </div>
                  </SchemeFieldCard>
                  <SchemeFieldCard
                    title={t("connections.allowedHours")}
                    description="connections.useLocalTimeEqualStartAndEndMeansAll"
                  >
                    <Label>
                      <Checkbox
                        disabled={saving}
                        checked={editor.rhythm.active_hours_enabled}
                        onCheckedChange={(checked) =>
                          state.patchQqSchemeGroup("rhythm", {
                            active_hours_enabled: checked === true,
                          })
                        }
                      />
                      {t("connections.allowedHours")}
                    </Label>
                    {/* 窄屏单列：两个 time 输入并排会被压到内容裁切，sm 起恢复两列。 */}
                    <div className="grid gap-5 sm:grid-cols-2">
                      {(["start", "end"] as const).map((side) => {
                        const key = `active_hours_${side}_minutes` as const;
                        return (
                          <Field
                            key={key}
                            label={
                              side === "start"
                                ? "connections.allowedHoursStart"
                                : "connections.allowedHoursEnd"
                            }
                          >
                            <Input
                              type="time"
                              value={localClock(editor.rhythm[key])}
                              disabled={saving || !editor.rhythm.active_hours_enabled}
                              onChange={(e) => {
                                const minutes = utcMinutes(e.target.value);
                                if (minutes !== null)
                                  state.patchQqSchemeGroup("rhythm", { [key]: minutes });
                              }}
                            />
                          </Field>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("schemes.studio.activeHoursHint")}
                    </p>
                  </SchemeFieldCard>
                  <SchemeFieldCard
                    title={t("schemes.studio.judgePrompt")}
                    description="connections.decideWhetherToSpeak"
                  >
                    <PromptEditor slot="judge" titleKey="connections.judgementTask" />
                  </SchemeFieldCard>
                </TabsContent>
              )}
              {(effectiveTab === "response" || visitedTasks.includes("response")) && (
                <TabsContent
                  value="response"
                  forceMount
                  className="m-0 space-y-6 data-[state=inactive]:hidden"
                >
                  <SchemeFieldCard
                    title={t("schemes.studio.replyStructure")}
                    description="connections.whenEnabledGenerateAReplyPerSpeakerAndAdd"
                  >
                    <Label>
                      <Checkbox
                        checked={editor.reply.split_by_speaker}
                        disabled={saving}
                        onCheckedChange={(value) =>
                          state.patchQqSchemeGroup("reply", { split_by_speaker: value === true })
                        }
                      />
                      {t("connections.answerEachSpeakerSeparately")}
                    </Label>
                  </SchemeFieldCard>
                  <SchemeFieldCard
                    title={t("schemes.studio.replyTasks")}
                    description="schemes.studio.replyTasksHint"
                  >
                    <PromptEditor
                      slot="scene"
                      titleKey="connections.sceneAndBehaviour"
                      hint="schemes.studio.sceneGlobalNote"
                    />
                    {/* 这一栏可配置。没改过时按上面的开关派生（显示即派生结果），
                      一改就写进方案的 prompt_reply，服务端取的是同一个函数的结果。 */}
                    <Field
                      label="connections.effectiveReplyTask"
                      info="connections.editTheReplyTaskItWinsOverTheSwitch"
                    >
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {editor.prompts.reply === QQ_REPLY_DEFAULT_PROMPT
                            ? t("schemes.studio.replyPromptDerived")
                            : t("schemes.studio.replyPromptCustom")}
                        </span>
                      </div>
                      <Textarea
                        className="min-h-36 font-mono text-xs leading-6"
                        disabled={saving}
                        value={qqEffectiveReplyPrompt(
                          editor.prompts.reply,
                          editor.reply.split_by_speaker,
                        )}
                        onChange={(e) =>
                          state.patchQqSchemeGroup("prompts", { reply: e.target.value })
                        }
                      />
                    </Field>
                    <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                      {responseFields.map(([name, label, info]) => (
                        <SchemeNumber
                          key={name}
                          group="rhythm"
                          name={name}
                          label={label}
                          info={info}
                        />
                      ))}
                    </div>
                    <PromptEditor slot="review" titleKey="connections.reviewTask" />
                  </SchemeFieldCard>
                </TabsContent>
              )}
              {(effectiveTab === "context_reading" || visitedTasks.includes("context_reading")) && (
                <TabsContent
                  value="context_reading"
                  forceMount
                  className="m-0 space-y-6 data-[state=inactive]:hidden"
                >
                  {/* 0052 消息关系与时间：引用模式/层数、时间呈现、时区；one_then_on_demand 下层数
                    不参与运行（禁用但配置保留），切回按层数即恢复。 */}
                  <SchemeFieldCard
                    title={t("schemes.studio.messageRelations")}
                    description="schemes.studio.messageRelationsHint"
                  >
                    <div className="grid gap-5 sm:grid-cols-2">
                      <SchemeEnum
                        group="messageSettings"
                        name="reply_mode"
                        label="connections.quoteReplyMode"
                      />
                      <SchemeNumber
                        group="messageSettings"
                        name="reply_depth"
                        label="connections.quoteDepth"
                        info="connections.quoteDepthHint"
                        // one_then_on_demand 下层数不参与运行：禁用但配置保留，切回按层数即恢复。
                        disabled={editor.messageSettings.reply_mode === "one_then_on_demand"}
                      />
                      <SchemeEnum
                        group="messageSettings"
                        name="time_display"
                        label="connections.timeDisplayMode"
                      />
                      <SchemeTimezone label="connections.timezone" />
                    </div>
                    <QqMessagePreview
                      settings={
                        invalidSchemeTimezone(useSuperstringStore.getState()) === null
                          ? editor.messageSettings
                          : null
                      }
                    />
                  </SchemeFieldCard>
                  {(["judgement", "reply"] as const).map((part) => (
                    <SchemeFieldCard
                      key={part}
                      title={
                        part === "judgement"
                          ? t("connections.judgementContext")
                          : t("connections.replyContext")
                      }
                      description="connections.recentMessagesAndOutputReserveHaveSeparateBudgetsValues"
                    >
                      <div className="grid gap-5 sm:grid-cols-2">
                        {/* 回复档的条数跟随绑定助手的「保留最近轮数」，所以它是只读的。 */}
                        {part === "reply" ? (
                          <BoundRecentTurns />
                        ) : (
                          <SchemeNumber
                            group="context"
                            name={`${part}_message_limit`}
                            label="connections.judgementRecentMessages"
                          />
                        )}
                        <SchemeNumber
                          group="context"
                          name={`${part}_window_minutes`}
                          label={
                            part === "judgement"
                              ? "connections.judgementTimeWindowMinutes"
                              : "connections.replyTimeWindowMinutes"
                          }
                        />
                        <SchemeNumber
                          group="context"
                          name={`${part}_token_budget`}
                          label={
                            part === "judgement"
                              ? "connections.judgementBudgetEstimatedBytes"
                              : "connections.replyBudgetEstimatedBytes"
                          }
                        />
                        <SchemeNumber
                          group="outputReserve"
                          name={`${part}_output_reserved`}
                          label={
                            part === "judgement"
                              ? "connections.judgementOutputReserveEstimatedBytes"
                              : "connections.replyOutputReserveEstimatedBytes"
                          }
                        />
                      </div>
                    </SchemeFieldCard>
                  ))}
                  <div className="rounded-lg bg-muted p-5 text-sm leading-6">
                    <h3 className="font-medium">
                      {t("connections.bindingsDetermineTheMaterialScope")}
                    </h3>
                    <p className="mt-2 text-muted-foreground">
                      {t("connections.judgementUsesAuthorizedMemoryAndKnowledgeRepliesRetainThe")}
                    </p>
                    <Button
                      className="mt-3"
                      variant="outline"
                      onClick={() => state.openSettingsRoute("knowledge-config")}
                    >
                      {t("connections.manageKnowledge")}
                    </Button>
                  </div>
                </TabsContent>
              )}
              {(effectiveTab === "history_compression" ||
                visitedTasks.includes("history_compression")) && (
                <TabsContent
                  value="history_compression"
                  forceMount
                  className="m-0 space-y-6 data-[state=inactive]:hidden"
                >
                  <SchemeFieldCard
                    title={t("connections.compressionAndAssembly")}
                    description="schemes.studio.compressionHint"
                  >
                    <div className="grid gap-5 sm:grid-cols-2">
                      <SchemeNumber
                        group="compression"
                        name="watermark_trigger"
                        label="connections.watermarkTriggerMessages"
                        info="connections.oldMessagesOutsideTheReplyWindowAccumulateUntilThisMany"
                      />
                      <SchemeNumber
                        group="compression"
                        name="package_limit"
                        label="connections.watermarkPackageLimit"
                        info="connections.packagesBeyondThisManyAreDroppedOldestFirst"
                      />
                      <SchemePercent
                        name="headroom_ratio"
                        label="connections.assemblyHeadroomPercent"
                        info="connections.reserveThisShareOfTheCapacityBeforeAssembling"
                      />
                    </div>
                    <PromptEditor
                      slot="compress"
                      titleKey="connections.watermarkCompressionTask"
                      hint="connections.compressTheBufferedOldMessagesIntoFactsTheStructuralRulesAre"
                    />
                  </SchemeFieldCard>
                </TabsContent>
              )}
              {(effectiveTab === "image_understanding" ||
                visitedTasks.includes("image_understanding")) && (
                <TabsContent
                  value="image_understanding"
                  forceMount
                  className="m-0 space-y-6 data-[state=inactive]:hidden"
                >
                  {/* 0052 图片输入：模式/阶段/图数/规格；普通动图沿用下方既有 rhythm 真源不重复存储。 */}
                  <SchemeFieldCard
                    title={t("schemes.studio.imageInput")}
                    description="schemes.studio.imageInputHint"
                  >
                    <div className="grid gap-5 sm:grid-cols-2">
                      <SchemeEnum
                        group="mediaInput"
                        name="mode"
                        label="connections.imageInputMode"
                        info={
                          editor.mediaInput.mode === "description"
                            ? "connections.imageMode.descriptionHint"
                            : "connections.imageMode.nativeHint"
                        }
                      />
                      <SchemeNumber
                        group="mediaInput"
                        name="max_images"
                        label="connections.maxAutoImages"
                      />
                      <SchemeNumber
                        group="mediaInput"
                        name="expression_max_dimension"
                        label="connections.expressionStillMaxDimension"
                      />
                      <OrdinaryStillSpec />
                      <SchemeNumber
                        group="mediaInput"
                        name="expression_frame_count"
                        label="connections.expressionFrameCount"
                      />
                      <SchemeNumber
                        group="mediaInput"
                        name="expression_frame_max_dimension"
                        label="connections.expressionFrameMaxDimension"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <StageSwitch phase="decision" />
                      <StageSwitch phase="evaluation" />
                      <StageSwitch phase="generation" />
                    </div>
                  </SchemeFieldCard>
                  <SchemeFieldCard
                    title={t("schemes.studio.imageParams")}
                    description="schemes.studio.imageParamsHint"
                  >
                    <div className="grid gap-5 sm:grid-cols-2">
                      {imageFields.map(([group, name, label]) => (
                        <SchemeNumber key={name} group={group} name={name} label={label} />
                      ))}
                    </div>
                  </SchemeFieldCard>
                  <SchemeFieldCard
                    title={t("connections.mediaNoteTask")}
                    description="connections.describeWhatThePictureOrVoiceActuallyContains"
                  >
                    <PromptEditor
                      slot="media"
                      titleKey="connections.mediaNoteTask"
                      hint="connections.describeWhatThePictureOrVoiceActuallyContains"
                    />
                  </SchemeFieldCard>
                </TabsContent>
              )}
              {(effectiveTab === "sticker_sending" || visitedTasks.includes("sticker_sending")) && (
                <TabsContent
                  value="sticker_sending"
                  forceMount
                  className="m-0 space-y-6 data-[state=inactive]:hidden"
                >
                  <SchemeFieldCard
                    title={t("schemes.studio.stickerParams")}
                    description="schemes.studio.stickerParamsHint"
                  >
                    <div className="grid gap-5 sm:grid-cols-2">
                      {stickerFields.map(([group, name, label]) => (
                        <SchemeNumber key={name} group={group} name={name} label={label} />
                      ))}
                    </div>
                  </SchemeFieldCard>
                  <SchemeFieldCard
                    title={t("connections.authorizedCollections")}
                    description="connections.onlyEnabledAssetsInAuthorizedCollectionsCanBeSelected"
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      {state.qqStickerCollections.map((collection) => (
                        <Label key={collection.id} className="rounded-lg border p-3">
                          <Checkbox
                            checked={editor.stickerCollectionIds.includes(collection.id)}
                            disabled={saving}
                            onCheckedChange={(value) =>
                              state.patchQqScheme({
                                stickerCollectionIds:
                                  value === true
                                    ? [...editor.stickerCollectionIds, collection.id]
                                    : editor.stickerCollectionIds.filter(
                                        (id) => id !== collection.id,
                                      ),
                              })
                            }
                          />
                          {collection.name}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {collection.asset_count}
                          </span>
                        </Label>
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => state.openSettingsRoute("qq-stickers")}
                    >
                      {t("connections.manageStickers")}
                    </Button>
                  </SchemeFieldCard>
                  <SchemeFieldCard
                    title={t("connections.stickerTask")}
                    description="connections.pickOneStickerFromTheCandidatesOutputOnlyIts"
                  >
                    <PromptEditor
                      slot="sticker"
                      titleKey="connections.stickerTask"
                      hint="connections.pickOneStickerFromTheCandidatesOutputOnlyIts"
                    />
                  </SchemeFieldCard>
                </TabsContent>
              )}
            </div>
          </ScrollArea>
        </Tabs>
      )}
      {editor && (state.error || state.feedback) && (
        <div className="shrink-0 border-t px-4 py-2">
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(state.error)}
            </p>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {translateNotice(state.feedback)}
            </p>
          )}
        </div>
      )}
      {editor && (
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-background px-4 py-3">
          <p className="mr-auto text-xs text-muted-foreground" role="status">
            {invalid
              ? t("connections.correctInvalidNumbersFirst")
              : t("connections.valueUnsavedChanges", { "0": changes.length })}
          </p>
          {invalid && invalidFields[0] && (
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                const field = invalidFields[0];
                setTask(schemeFieldTask(field));
                setFocusField(field);
              }}
            >
              <Crosshair />
              {t("schemes.studio.locateInvalid")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setPreview(true)}>
            <FileDiff />
            {t("connections.reviewChanges")}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !dirty}
            onClick={() => state.discardQqSchemeChanges()}
          >
            {t("connections.discardChanges")}
          </Button>
          <Button
            disabled={busy || invalid || !changes.length || !editor.name.trim()}
            onClick={() => void state.saveQqScheme()}
          >
            <Save />
            {t("connections.saveScheme")}
          </Button>
        </footer>
      )}
      {confirmDelete && editor && (
        <ConfirmDialog
          message={t(
            dirty ? "schemes.studio.deleteDirtyConfirm" : "schemes.studio.deleteUnusedConfirm",
            { "0": editor.name },
          )}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            const id = editor.source.id;
            setConfirmDelete(false);
            void state.deleteQqScheme(id);
          }}
        />
      )}
      {naming && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setNaming(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t(
                  naming.kind === "copy" ? "connections.saveAsANewScheme" : "connections.newScheme",
                )}
              </DialogTitle>
              <DialogDescription>
                {t("connections.aSharedSchemeMayAffectSeveralConversationsReviewIts")}
              </DialogDescription>
            </DialogHeader>
            {naming.step === "draft" ? (
              <>
                <p className="text-sm">{t("schemes.studio.draftGuardMessage")}</p>
                {state.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {translateNotice(state.error)}
                  </p>
                )}
                <DialogFooter>
                  <Button
                    variant="outline"
                    data-dialog-cancel
                    disabled={busy}
                    onClick={() => setNaming(null)}
                  >
                    {t("connections.cancel")}
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void runNaming(false)}
                  >
                    {t("workspace.discard_and_continue")}
                  </Button>
                  <Button disabled={busy || invalid} onClick={() => void runNaming(true)}>
                    {t("workspace.save_and_continue")}
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <Field label="connections.schemeName">
                  <Input
                    value={namingName}
                    disabled={busy}
                    onChange={(e) =>
                      naming.kind === "copy"
                        ? setCopyName(e.target.value)
                        : setNewName(e.target.value)
                    }
                  />
                </Field>
                {naming.kind === "copy" && (
                  <p className="text-xs text-muted-foreground">{t("schemes.studio.copyHint")}</p>
                )}
                {state.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {translateNotice(state.error)}
                  </p>
                )}
                <DialogFooter>
                  <Button variant="outline" disabled={busy} onClick={() => setNaming(null)}>
                    {t("connections.cancel")}
                  </Button>
                  <Button
                    disabled={busy || !namingName.trim()}
                    onClick={() => {
                      if (naming.kind === "new" && dirty) setNaming({ ...naming, step: "draft" });
                      else void runNaming(false);
                    }}
                  >
                    {t("connections.confirm")}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      )}
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("connections.reviewChanges")}</DialogTitle>
            <DialogDescription>
              {t("connections.theWholeSchemeIsSavedTogetherOnlyChangedFields")}
            </DialogDescription>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("connections.field")}</TableHead>
                <TableHead>{t("connections.before")}</TableHead>
                <TableHead>{t("connections.after")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((change) => {
                const label = schemeFieldLabels[change.field];
                return (
                  <TableRow key={change.field}>
                    <TableCell className="text-xs whitespace-normal break-words">
                      {label ? t(label) : <span className="font-mono">{change.field}</span>}
                    </TableCell>
                    <TableCell className="max-w-64 whitespace-pre-wrap break-words">
                      {previewValue(change.field, change.before)}
                    </TableCell>
                    <TableCell className="max-w-64 whitespace-pre-wrap break-words">
                      {previewValue(change.field, change.after)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}
