import { Copy, Crosshair, FileDiff, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type QqSchemePrompts, qqEffectiveReplyPrompt } from "../../../shared/contracts/qq";
import { ConfirmDialog } from "../../components/confirmation";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
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
import { qqSchemeChanges, qqSchemeDirty } from "../../features/qq/types";
import { useQqInput } from "../../features/qq/use-qq-input";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { TRIGGER_LABELS } from "./binding-editor";
import { QqMessagePreview } from "./qq-message-preview";
import {
  fieldBounds,
  headroomPercentBounds,
  imageFields,
  localClock,
  type NumberEditorGroup,
  numberEditorGroups,
  participationFields,
  type SchemeTask,
  schemeFieldTask,
  stickerFields,
  utcMinutes,
} from "./scheme-fields";

/** Only these fields are switches; text that reads "true"/"开"/"关" is the user's own content. */
const schemeBooleanFields: ReadonlySet<string> = new Set([
  ...Object.keys(TRIGGER_LABELS).map((key) => `triggers.${key}`),
  "rhythm.active_hours_enabled",
  "reply.split_by_speaker",
  // 0052 的 stages 布尔同样按开/关渲染（人话，不出现 true/false）。
  "media_input.stages.decision",
  "media_input.stages.evaluation",
  "media_input.stages.generation",
]);

const schemeFieldLabels: Readonly<Record<string, string>> = {
  name: "connections.schemeName",
  description: "connections.description",
  ...Object.fromEntries(
    Object.entries(TRIGGER_LABELS).map(([key, label]) => [`triggers.${key}`, label]),
  ),
  ...Object.fromEntries(participationFields.map(([name, label]) => [`rhythm.${name}`, label])),
  ...Object.fromEntries(
    [...stickerFields, ...imageFields].map(([group, name, label]) => [`${group}.${name}`, label]),
  ),
  "rhythm.active_hours_enabled": "connections.allowedHours",
  "rhythm.active_hours_start_minutes": "connections.allowedHoursStart",
  "rhythm.active_hours_end_minutes": "connections.allowedHoursEnd",
  "context.judgement_message_limit": "connections.judgementRecentMessages",
  "context.judgement_window_minutes": "connections.judgementTimeWindowMinutes",
  "context.judgement_token_budget": "connections.judgementBudgetEstimatedBytes",
  "context.reply_message_limit": "connections.replyRecentMessages",
  "context.reply_window_minutes": "connections.replyTimeWindowMinutes",
  "context.reply_token_budget": "connections.replyBudgetEstimatedBytes",
  "compression.watermark_trigger": "connections.watermarkTriggerMessages",
  "compression.package_limit": "connections.watermarkPackageLimit",
  "compression.headroom_ratio": "connections.assemblyHeadroomPercent",
  "output_reserve.judgement_output_reserved": "connections.judgementOutputReserveEstimatedBytes",
  "output_reserve.reply_output_reserved": "connections.replyOutputReserveEstimatedBytes",
  "sticker_collections.collection_ids": "connections.authorizedCollections",
  "prompts.scene": "connections.sceneAndBehaviour",
  "prompts.judge": "connections.judgementTask",
  "prompts.reply": "connections.effectiveReplyTask",
  "prompts.review": "connections.reviewTask",
  "prompts.sticker": "connections.stickerTask",
  "prompts.media": "connections.mediaNoteTask",
  "prompts.compress": "connections.watermarkCompressionTask",
  "reply.split_by_speaker": "connections.answerEachSpeakerSeparately",
  // 0052 两组（与 draft-state 的全局标签映射同批；值行仍按 previewValue 特判）。
  "message_settings.reply_mode": "connections.quoteReplyMode",
  "message_settings.reply_depth": "connections.quoteDepth",
  "message_settings.time_display": "connections.timeDisplayMode",
  "message_settings.timezone": "connections.timezone",
  "media_input.mode": "connections.imageInputMode",
  "media_input.stages.decision": "schemes.studio.stageDecision",
  "media_input.stages.evaluation": "schemes.studio.stageEvaluation",
  "media_input.stages.generation": "schemes.studio.stageGeneration",
  "media_input.max_images": "connections.maxAutoImages",
  "media_input.ordinary_still_max_dimension": "connections.ordinaryStillMaxDimension",
  "media_input.expression_max_dimension": "connections.expressionStillMaxDimension",
  "media_input.expression_frame_count": "connections.expressionFrameCount",
  "media_input.expression_frame_max_dimension": "connections.expressionFrameMaxDimension",
};

/**
 * 页内分组：细边框 + 淡标题带，标题下写明这个组的作用范围、单位与影响；
 * 视觉上沿用现有 Card（与设置页的 SettingsGroup 同一套层次），不新增样式系统。
 */
function StudioGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Card size="sm" className="min-w-0 gap-0 pt-0">
      <CardHeader className="border-b bg-muted/50">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <CardDescription className="text-xs">{t(description)}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-5 pt-3">{children}</CardContent>
    </Card>
  );
}

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
const schemeEnumLabels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "message_settings.reply_mode": {
    one_then_on_demand: "connections.quoteMode.one_then_on_demand",
    configured_depth: "connections.quoteMode.configured_depth",
  },
  "message_settings.time_display": {
    full: "connections.timeDisplay.full",
    full_relative: "connections.timeDisplay.full_relative",
    hybrid: "connections.timeDisplay.hybrid",
  },
  "media_input.mode": {
    native: "connections.imageMode.native",
    description: "connections.imageMode.description",
  },
};

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
  const {
    qqSchemeEditor: editor,
    qqSchemeSaving: saving,
    patchQqSchemeGroup: patch,
  } = useSuperstringStore();
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
  const {
    qqSchemeEditor: editor,
    qqSchemeSaving: saving,
    patchQqSchemeGroup: patch,
  } = useSuperstringStore();
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
  const {
    qqSchemeEditor: editor,
    qqSchemeSaving: saving,
    patchQqSchemeGroup: patch,
  } = useSuperstringStore();
  const [texts, setTexts] = useQqInput("schemeTexts");
  const [invalid, setInvalid] = useQqInput("schemeInvalid");
  if (!editor) return null;
  const id = "message_settings.timezone";
  const inputId = `scheme-field-${id}`;
  const errorId = `${inputId}-error`;
  const raw = texts[id];
  const valid = (value: string) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
      return true;
    } catch {
      return false;
    }
  };
  const suggestions = [
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Asia/Hong_Kong",
    "Asia/Singapore",
    "Europe/London",
    "America/New_York",
    "UTC",
  ];
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
        {suggestions.map((zone) => (
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
  const { qqSchemeEditor: editor, qqSchemeSaving: saving, patchQqScheme } = useSuperstringStore();
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
  const {
    qqSchemeEditor: editor,
    qqSchemeSaving: saving,
    patchQqSchemeGroup: patch,
  } = useSuperstringStore();
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
  const { qqSchemeEditor: editor, qqBindings, agents, loadQqBindings } = useSuperstringStore();
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
  const {
    qqSchemeEditor: editor,
    qqSchemeSaving: saving,
    patchQqSchemeGroup: patch,
  } = useSuperstringStore();
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
  const { qqSchemeEditor, qqSchemeSaving, patchQqSchemeGroup } = useSuperstringStore();
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

export function SchemeStudio() {
  const { t } = useTranslation();
  const state = useSuperstringStore();
  const { loadQqSchemes, loadQqStickers, qqSchemeEditor: editor, qqSchemeSaving: saving } = state;
  const [task, setTask] = useState<SchemeTask>("participation");
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
    void loadQqSchemes();
    void loadQqStickers();
  }, [loadQqSchemes, loadQqStickers]);
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
      ...invalidSchemeInputs(state).map(([field]) => field),
    ]),
  ];
  const invalid = invalidFields.length > 0;
  const dirty = qqSchemeDirty(editor) || invalid;
  const selectedUsage =
    state.qqSchemeUsage && state.qqSchemeUsage.schemeId === editor?.source.id
      ? state.qqSchemeUsage.bindings
      : null;
  const usageText =
    selectedUsage === null
      ? t("connections.unknown")
      : t("connections.usedByValueConversations", { "0": selectedUsage });
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
        <Button
          variant="outline"
          size="sm"
          data-scheme-usage
          disabled={!editor || busy}
          onClick={() => state.requestQqSchemeNavigation(editor?.source.id ?? "", "bindings")}
        >
          {usageText}
        </Button>
        {editor && selectedUsage === null && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void state.loadQqSchemes()}
            >
              {t("capabilities.retry")}
            </Button>
            {state.qqSchemeUsageError && (
              <span className="text-xs text-destructive">
                {translateNotice(state.qqSchemeUsageError)}
              </span>
            )}
          </>
        )}
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
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || invalid || !changes.length || !editor?.name.trim()}
            onClick={() => void state.saveQqScheme()}
          >
            <Save />
            {/* 与页脚「保存方案」同源同范围；页首用短标签，避免两个同名按钮让读屏与测试无法区分。 */}
            {t("workspace.save")}
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
          className="min-h-0 flex-1 gap-0"
        >
          <div className="border-b px-4 py-3">
            <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-7">
              <TabsTrigger value="participation">{t("connections.whenToParticipate")}</TabsTrigger>
              <TabsTrigger value="response">{t("connections.howToRespond")}</TabsTrigger>
              <TabsTrigger value="context">{t("connections.whatToRead")}</TabsTrigger>
              <TabsTrigger value="media">{t("connections.mediaAndExpression")}</TabsTrigger>
            </TabsList>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="min-w-0 space-y-6 px-4 py-6">
              <TabsContent value="participation" className="m-0 space-y-6">
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
                <StudioGroup
                  title={t("connections.speechTriggers")}
                  description="schemes.studio.triggersHint"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    {Object.entries(TRIGGER_LABELS).map(([key, label]) => (
                      <Label key={key} className="flex items-start gap-3 rounded-lg border p-4">
                        <Checkbox
                          disabled={saving}
                          checked={editor.triggers[key as keyof typeof TRIGGER_LABELS]}
                          onCheckedChange={(value) =>
                            state.patchQqSchemeGroup("triggers", { [key]: value === true })
                          }
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
                </StudioGroup>
                <StudioGroup
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
                  </div>
                </StudioGroup>
                <StudioGroup
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
                </StudioGroup>
                <StudioGroup
                  title={t("schemes.studio.judgePrompt")}
                  description="connections.decideWhetherToSpeak"
                >
                  <PromptEditor slot="judge" titleKey="connections.judgementTask" />
                </StudioGroup>
              </TabsContent>
              <TabsContent value="response" className="m-0 space-y-6">
                <StudioGroup
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
                </StudioGroup>
                <StudioGroup
                  title={t("schemes.studio.replyTasks")}
                  description="schemes.studio.replyTasksHint"
                >
                  {/* 这一栏可配置。没改过时按上面的开关派生（显示即派生结果），
                      一改就写进方案的 prompt_reply，服务端取的是同一个函数的结果。 */}
                  <Field
                    label="connections.effectiveReplyTask"
                    info="connections.editTheReplyTaskItWinsOverTheSwitch"
                  >
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
                  <PromptEditor slot="scene" titleKey="connections.sceneAndBehaviour" />
                  <PromptEditor slot="review" titleKey="connections.reviewTask" />
                </StudioGroup>
              </TabsContent>
              <TabsContent value="context" className="m-0 space-y-6">
                {/* 0052 消息关系与时间：引用模式/层数、时间呈现、时区；one_then_on_demand 下层数
                    不参与运行（禁用但配置保留），切回按层数即恢复。 */}
                <StudioGroup
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
                </StudioGroup>
                {(["judgement", "reply"] as const).map((part) => (
                  <StudioGroup
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
                  </StudioGroup>
                ))}
                <StudioGroup
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
                </StudioGroup>
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
              <TabsContent value="media" className="m-0 space-y-6">
                {/* 0052 图片输入：模式/阶段/图数/规格；普通动图沿用下方既有 rhythm 真源不重复存储。 */}
                <StudioGroup
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
                </StudioGroup>
                <StudioGroup
                  title={t("schemes.studio.imageParams")}
                  description="schemes.studio.imageParamsHint"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {imageFields.map(([group, name, label]) => (
                      <SchemeNumber key={name} group={group} name={name} label={label} />
                    ))}
                  </div>
                </StudioGroup>
                <StudioGroup
                  title={t("schemes.studio.stickerParams")}
                  description="schemes.studio.stickerParamsHint"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {stickerFields.map(([group, name, label]) => (
                      <SchemeNumber key={name} group={group} name={name} label={label} />
                    ))}
                  </div>
                </StudioGroup>
                <StudioGroup
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
                  <Button variant="outline" onClick={() => state.openSettingsRoute("qq-stickers")}>
                    {t("connections.manageStickers")}
                  </Button>
                </StudioGroup>
                <StudioGroup
                  title={t("schemes.studio.mediaPrompts")}
                  description="schemes.studio.mediaPromptsHint"
                >
                  <PromptEditor
                    slot="sticker"
                    titleKey="connections.stickerTask"
                    hint="connections.pickOneStickerFromTheCandidatesOutputOnlyIts"
                  />
                  <PromptEditor
                    slot="media"
                    titleKey="connections.mediaNoteTask"
                    hint="connections.describeWhatThePictureOrVoiceActuallyContains"
                  />
                </StudioGroup>
              </TabsContent>
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
