// 本群配置页：QQ 群相对基础方案的逐字段稀疏改写 + 本群能力停用，只写本群这一层。
// 原文先进 store（合法性由契约判定，非法留 rawTexts 并拦保存），blur 后才提示错误；换基础方案先预览 keep/reset。

import { ChevronLeft, MessageSquare, Shield } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { AgentKnowledgeReadSettings } from "../../../shared/contracts/knowledge";
import {
  type ExecutionModules,
  executionPolicy,
  type PermissionGrant,
  type PermissionResource,
  toolExecutionEnabled,
} from "../../../shared/contracts/permissions";
import {
  type QqSchemePrompts,
  type QqSchemeResponse,
  qqEffectiveReplyPrompt,
} from "../../../shared/contracts/qq";
import {
  type QqGroupCapability,
  resolveQqInteractionPair,
} from "../../../shared/contracts/qq-group-config";
import { AlertDialog } from "../../components/confirmation";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";
import { permissionResources } from "../../features/access/permission-state";
import {
  type QqGroupConfigChange,
  type QqGroupConfigEditor,
  qqGroupConfigChanges,
  qqGroupConfigDirty,
  qqGroupConfigEffectiveScheme,
  qqGroupConfigHasInvalidInputs,
} from "../../features/qq/group-config-state";
import { projectQqGroupRows } from "../../features/qq/group-directory";
import {
  imageFields,
  participationFields,
  QQ_GROUP_CAPABILITY_LABELS,
  QQ_SCHEME_ENUM_OPTION_LABELS,
  QQ_SCHEME_FIELD_LABELS,
  QQ_SCHEME_SECTIONS,
  responseFields,
  stickerFields,
  TRIGGER_LABELS,
} from "../../features/qq/scheme-field-metadata";
import { translateNotice } from "../../i18n";
import { useLiveResource } from "../../services/use-live-resource";
import { useSuperstringStore } from "../../store";
import { BindingEditor } from "./binding-editor";
import { QqMessagePreview } from "./qq-message-preview";
import { SchemeFieldCard } from "./scheme-field-shared";
import {
  fieldBounds,
  headroomPercentBounds,
  isValidTimezone,
  localClock,
  type NumberEditorGroup,
  numberEditorGroups,
  TIMEZONE_SUGGESTIONS,
  utcMinutes,
} from "./scheme-fields";

/** 契约差异是稀疏的：进出都当可索引 bag 用（组名/字段名仍由契约与渲染表格约束）。 */
type OverridesBag = Record<string, Record<string, unknown>>;
const bagOf = (editor: QqGroupConfigEditor): OverridesBag =>
  editor.overrides as unknown as OverridesBag;
const baseGroupOf = (scheme: QqSchemeResponse, group: string): Record<string, unknown> =>
  ((scheme as unknown as Record<string, unknown>)[group] ?? {}) as Record<string, unknown>;

/**
 * 显式自定义＝该字段在稀疏差异里（值可能是 false/0/null/空集合，仍是实打实的钉住）。
 * 0052 嵌套 stages：字段名是 `stages.<phase>` 点路径时，真实位置在 `media_input.stages.<phase>`。
 */
function overrideOf(editor: QqGroupConfigEditor, group: string, name: string) {
  if (group === "media_input" && name.startsWith("stages.")) {
    const phase = name.slice("stages.".length);
    const stages = bagOf(editor).media_input?.stages as Record<string, unknown> | undefined;
    if (!stages || !(phase in stages) || stages[phase] === undefined)
      return { custom: false, value: undefined as unknown };
    return { custom: true, value: stages[phase] };
  }
  const fields = bagOf(editor)[group];
  if (!fields || !(name in fields) || fields[name] === undefined)
    return { custom: false, value: undefined as unknown };
  return { custom: true, value: fields[name] };
}

const isCustomField = (editor: QqGroupConfigEditor, group: string, name: string) =>
  overrideOf(editor, group, name).custom || editor.rawTexts[`${group}.${name}`] !== undefined;

const NUMERIC_GROUP: Record<
  | "rhythm"
  | "context"
  | "compression"
  | "output_reserve"
  | "stickers"
  | "message_settings"
  | "media_input",
  NumberEditorGroup
> = {
  rhythm: "rhythm",
  context: "context",
  compression: "compression",
  output_reserve: "outputReserve",
  stickers: "stickers",
  message_settings: "messageSettings",
  media_input: "mediaInput",
};

const numberSchemaOf = (group: NumberEditorGroup, name: string) =>
  (
    numberEditorGroups[group].shape as Record<
      string,
      { safeParse: (value: unknown) => { success: boolean } } | undefined
    >
  )[name];

/** 契约级数字原文判定（0052 两组共用）：非空且过共享 schema；0 不是 null 原图的编码。 */
const schemaSafeParse = (group: string, name: string, raw: string): boolean => {
  const numeric = NUMERIC_GROUP[group as keyof typeof NUMERIC_GROUP];
  if (!numeric) return false;
  const schema = numberSchemaOf(numeric, name);
  return raw.trim() !== "" && !!schema && schema.safeParse(Number(raw)).success;
};

/** 契约级越界（含装配冗余必须按整数百分比输入）：任何一项存在就禁止保存。 */
function hasOutOfRangeOverride(editor: QqGroupConfigEditor): boolean {
  for (const [group, fields] of Object.entries(bagOf(editor))) {
    const numeric = NUMERIC_GROUP[group as keyof typeof NUMERIC_GROUP];
    if (!numeric || !fields) continue;
    for (const [name, value] of Object.entries(fields)) {
      const schema = numberSchemaOf(numeric, name);
      if (!schema || typeof value !== "number") continue;
      if (schema.safeParse(value).success === false) return true;
      if (group === "compression" && name === "headroom_ratio") {
        const pct = value * 100;
        if (Math.abs(pct - Math.round(pct)) > 1e-6) return true;
      }
    }
  }
  return false;
}

/** 装配冗余在界面上是整数百分比（存储是 0–0.5 的比例，与方案页同一换算）。 */
const percentText = (ratio: number) => `${Number((ratio * 100).toFixed(2))}%`;
const percentInputText = (ratio: number) => String(Number((ratio * 100).toFixed(2)));

/** 预览用的中性文本：百分比换算，数组顿号连接，枚举与布尔/原图读人话，其余 String()。 */
const valueTextOf = (
  t: (key: string) => string,
  group: string,
  name: string,
  value: unknown,
): string => {
  if (group === "compression" && name === "headroom_ratio" && typeof value === "number")
    return percentText(value);
  if (group === "media_input" && name === "ordinary_still_max_dimension" && value === null)
    return t("connections.ordinaryStillOriginal");
  const enumLabels = ENUM_OPTION_LABELS[`${group}.${name}`];
  if (enumLabels && typeof value === "string" && enumLabels[value]) return t(enumLabels[value]);
  if (Array.isArray(value)) return value.map(String).join("、");
  if (typeof value === "boolean") return t(value ? "connections.on" : "connections.off");
  return String(value);
};

/** 文案键唯一来源在 features/qq/scheme-field-metadata（含触发器与 0052 两组）。 */
const FIELD_LABELS: Record<string, string> = QQ_SCHEME_FIELD_LABELS;
const labelOf = (group: string, field: string) =>
  FIELD_LABELS[`${group}.${field}`] ?? `${group}.${field}`;

/** 0052 枚举选项的人话标签（载荷原样存契约值，只改显示）。 */
const ENUM_OPTION_LABELS = QQ_SCHEME_ENUM_OPTION_LABELS;

/** 上层事实：on/off 是真实开关，unread 是还没读到，后三项来自授权与审批现状。 */
type UpperFact =
  | "on"
  | "off"
  | "unread"
  | "approval"
  | "unauthorized"
  | "noActions"
  | "followsSession";

/** 12 项本群能力：状态只有「跟随上层 / 本群停用」，上层事实逐项来自真实来源。 */
interface CapabilityRow {
  id: QqGroupCapability;
  labelKey: string;
  upper:
    | { kind: "module"; module: keyof ExecutionModules }
    | { kind: "flag"; flag: "research" | "code" }
    | { kind: "read"; read: "memory" | "knowledge" }
    | { kind: "grants"; prefix: "mcp" | "skill" }
    | { kind: "followsSession" };
}
const CAPABILITY_LABELS = QQ_GROUP_CAPABILITY_LABELS;
const CAPABILITIES: readonly CapabilityRow[] = (
  [
    ["memory_read", { kind: "read", read: "memory" }],
    ["memory_organize", { kind: "module", module: "memoryJobs" }],
    // 知识整理开关（knowledgeJobs）管的是整理任务；读取是否关闭按该助手已保存的读取来源。
    ["knowledge_read", { kind: "read", read: "knowledge" }],
    ["web", { kind: "module", module: "web" }],
    ["media", { kind: "module", module: "qqMedia" }],
    ["stickers", { kind: "module", module: "qqStickers" }],
    ["tasks", { kind: "module", module: "tasks" }],
    ["research", { kind: "flag", flag: "research" }],
    ["code", { kind: "flag", flag: "code" }],
    ["mcp", { kind: "grants", prefix: "mcp" }],
    ["skills", { kind: "grants", prefix: "skill" }],
    ["history_summary", { kind: "followsSession" }],
    ["members_read", { kind: "module", module: "qqMembers" }],
  ] as const
).map(([id, upper]) => ({ id, labelKey: CAPABILITY_LABELS[id], upper }));

const UPPER_TEXT: Record<UpperFact, string> = {
  on: "capabilities.state.on",
  off: "capabilities.state.off",
  unread: "capabilities.state.unread",
  approval: "schemes.qq.groupConfig.capability.approval",
  unauthorized: "schemes.qq.groupConfig.capability.unauthorized",
  noActions: "schemes.qq.groupConfig.capability.noActions",
  followsSession: "capabilities.state.followsSession",
};

/**
 * 知识查询的已保存状态只读投影：页面作用域的显示数据（local resource），不是第二份配置草稿；
 * 只按绑定 Agent 读取，绝不经过全局 knowledgeReadEditor（那会选中别的 Agent 的编辑对象）。
 */
interface KnowledgeReadProjection {
  data: AgentKnowledgeReadSettings | null;
  loading: boolean;
  error: string;
  refresh: () => void;
}

/**
 * 字段状态行：显式跟随 / 显式钉住（与基线同值也是钉住）；钉住从当前基线值初始化，
 * 基线还没读到时不提供钉住入口。
 */
function FieldState({
  label,
  custom,
  baseText,
  currentText,
  disabled,
  canCustom,
  onFollow,
  onCustom,
}: {
  label: string;
  custom: boolean;
  baseText: string;
  currentText: string;
  disabled: boolean;
  canCustom: boolean;
  onFollow: () => void;
  onCustom: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-1.5 space-y-1">
      <NativeSelect
        size="sm"
        className="min-w-36"
        aria-label={`${label}: ${t("schemes.qq.groupConfig.fieldState")}`}
        disabled={disabled}
        data-field-state
        value={custom ? "custom" : "follow"}
        onChange={(e) => (e.target.value === "custom" ? onCustom() : onFollow())}
      >
        <option value="follow">{t("schemes.qq.groupConfig.followBadge")}</option>
        <option value="custom" disabled={!canCustom}>
          {t("schemes.qq.groupConfig.customBadge")}
        </option>
      </NativeSelect>
      <p className="text-xs text-muted-foreground">
        {custom
          ? t("schemes.qq.groupConfig.customValue", { "0": baseText, "1": currentText })
          : t("schemes.qq.groupConfig.followsBase", { "0": baseText })}
      </p>
    </div>
  );
}

/** 数字字段：原文先进 store（契约拒绝的留在 rawTexts），显示以原文优先，blur 后才提示错误。 */
function NumberField({
  editor,
  base,
  group,
  name,
  labelKey,
  infoKey,
  percent = false,
  disabled = false,
}: {
  editor: QqGroupConfigEditor;
  /** 生效基线的组包；null＝待切换目标还没读到，不显示半截数值。 */
  base: Record<string, unknown> | null;
  group:
    | "rhythm"
    | "context"
    | "compression"
    | "output_reserve"
    | "stickers"
    | "message_settings"
    | "media_input";
  name: string;
  labelKey: string;
  infoKey?: string;
  percent?: boolean;
  /** one_then_on_demand 的层数不参与运行：禁用输入，但钉住的配置值原样保稿。 */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupOverride);
  const [showError, setShowError] = useState(false);
  const numeric = NUMERIC_GROUP[group];
  const { custom, value } = overrideOf(editor, group, name);
  const baseKnown = base !== null && base[name] !== undefined;
  const baseValue = baseKnown ? Number(base[name]) : null;
  const raw = editor.rawTexts[`${group}.${name}`];
  const schema = numberSchemaOf(numeric, name);
  const bounds = percent ? headroomPercentBounds() : fieldBounds(numeric, name);
  const pinned = custom && value !== null ? Number(value) : null;
  const percentOk = pinned === null || Math.abs(pinned * 100 - Math.round(pinned * 100)) <= 1e-6;
  const outOfRange =
    custom &&
    value !== null &&
    (schema?.safeParse(value).success === false || (percent && !percentOk));
  const pinInput = pinned === null ? null : percent ? percentInputText(pinned) : String(pinned);
  const pinNote = pinned === null ? null : percent ? percentText(pinned) : String(pinned);
  const baseInput =
    baseValue === null ? null : percent ? percentInputText(baseValue) : String(baseValue);
  const baseNote =
    baseValue === null
      ? t("capabilities.state.unread")
      : percent
        ? percentText(baseValue)
        : String(baseValue);
  const display = raw ?? pinInput ?? baseInput ?? "";
  const showInvalid = showError && (raw !== undefined || outOfRange);
  const numberErrorId = useId();
  return (
    <Field label={labelKey} info={infoKey}>
      <Input
        type="number"
        inputMode="numeric"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        data-field={`${group}.${name}`}
        disabled={saving || disabled}
        value={display}
        aria-invalid={showInvalid || undefined}
        aria-describedby={showInvalid ? numberErrorId : undefined}
        onFocus={() => setShowError(false)}
        onBlur={() => setShowError(true)}
        onChange={(e) => {
          setShowError(false);
          patch(group, name, e.target.value);
        }}
      />
      <FieldState
        label={t(labelKey)}
        custom={custom}
        baseText={baseNote}
        currentText={raw ?? pinNote ?? baseNote}
        disabled={saving}
        canCustom={baseKnown}
        onFollow={() => patch(group, name, undefined)}
        onCustom={() => {
          if (baseValue !== null)
            patch(group, name, percent ? percentInputText(baseValue) : String(baseValue));
        }}
      />
      {showInvalid && (
        <p id={numberErrorId} role="alert" className="mt-1 text-xs text-destructive">
          {t("schemes.studio.integerRange", { "0": String(bounds.min), "1": String(bounds.max) })}
        </p>
      )}
    </Field>
  );
}

/** 允许时段的钟点：与方案页同一换算（本地显示、UTC 存储），只在生效基线启用时可编辑。 */
function TimeField({
  editor,
  base,
  enabled,
  name,
  labelKey,
}: {
  editor: QqGroupConfigEditor;
  base: Record<string, unknown> | null;
  enabled: boolean;
  name: "active_hours_start_minutes" | "active_hours_end_minutes";
  labelKey: string;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupOverride);
  const { custom, value } = overrideOf(editor, "rhythm", name);
  const baseKnown = base !== null && base[name] !== undefined;
  const baseValue = baseKnown ? Number(base[name]) : null;
  const current = custom ? Number(value) : (baseValue ?? 0);
  const known = custom || baseKnown;
  return (
    <Field label={labelKey}>
      <Input
        type="time"
        data-field={`rhythm.${name}`}
        value={known ? localClock(current) : ""}
        disabled={saving || !enabled}
        onChange={(e) => {
          const minutes = utcMinutes(e.target.value);
          if (minutes !== null) patch("rhythm", name, String(minutes));
        }}
      />
      <FieldState
        label={t(labelKey)}
        custom={custom}
        baseText={baseKnown ? localClock(baseValue ?? 0) : t("capabilities.state.unread")}
        currentText={known ? localClock(current) : t("capabilities.state.unread")}
        disabled={saving}
        canCustom={baseKnown}
        onFollow={() => patch("rhythm", name, undefined)}
        onCustom={() => patch("rhythm", name, String(baseValue ?? 0))}
      />
    </Field>
  );
}

/** 0052 枚举字段（引用模式/时间呈现/图片输入模式）：跟随＝不进差异；钉住＝契约原值。 */
function EnumField({
  editor,
  base,
  group,
  name,
  labelKey,
  infoKey,
}: {
  editor: QqGroupConfigEditor;
  base: Record<string, unknown> | null;
  group: "message_settings" | "media_input";
  name: string;
  labelKey: string;
  infoKey?: string;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupOverride);
  const { custom, value } = overrideOf(editor, group, name);
  const baseValue = typeof base?.[name] === "string" ? (base[name] as string) : null;
  const labels = ENUM_OPTION_LABELS[`${group}.${name}`] ?? {};
  return (
    <Field label={labelKey} info={infoKey}>
      <NativeSelect
        data-field={`${group}.${name}`}
        disabled={saving}
        value={custom ? String(value) : (baseValue ?? "")}
        onChange={(e) => patch(group, name, e.target.value)}
      >
        {!custom && baseValue === null && (
          <option value="">{t("capabilities.state.unread")}</option>
        )}
        {Object.entries(labels).map(([key, labelKey2]) => (
          <option key={key} value={key}>
            {t(labelKey2)}
          </option>
        ))}
      </NativeSelect>
      <FieldState
        label={t(labelKey)}
        custom={custom}
        baseText={baseValue === null ? t("capabilities.state.unread") : t(labels[baseValue] ?? "")}
        currentText={custom ? t(labels[String(value)] ?? "") : t(labels[baseValue ?? ""] ?? "")}
        disabled={saving}
        canCustom={baseValue !== null}
        onFollow={() => patch(group, name, undefined)}
        onCustom={() => baseValue !== null && patch(group, name, baseValue)}
      />
    </Field>
  );
}

/**
 * 0052 时区：可输入可选择的自由文本。合法 IANA 名称写进 overrides；非法原文留在 rawTexts
 * 并拦保存（state 层 parseOverrideField 同一共享 schema 拒绝），aria 关联错误，blur 后提示。
 */
function TimezoneField({
  editor,
  base,
}: {
  editor: QqGroupConfigEditor;
  base: Record<string, unknown> | null;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupOverride);
  const [showError, setShowError] = useState(false);
  const name = "timezone";
  const group = "message_settings" as const;
  const { custom, value } = overrideOf(editor, group, name);
  const baseValue = typeof base?.[name] === "string" ? (base[name] as string) : null;
  const raw = editor.rawTexts[`${group}.${name}`];
  const valid = isValidTimezone;
  const display = raw ?? (custom ? String(value) : (baseValue ?? ""));
  const invalid = raw !== undefined && !valid(raw);
  const showInvalid = showError && invalid;
  const errorId = "group-config-timezone-error";
  return (
    <Field label="connections.timezone" info="connections.timezoneHint">
      <div>
        <Input
          type="text"
          list="group-config-timezone-suggestions"
          data-field={`${group}.${name}`}
          disabled={saving}
          value={display}
          aria-invalid={showInvalid || undefined}
          aria-describedby={showInvalid ? errorId : undefined}
          onFocus={() => setShowError(false)}
          onBlur={() => setShowError(true)}
          onChange={(e) => {
            setShowError(false);
            patch(group, name, e.target.value);
          }}
        />
        <datalist id="group-config-timezone-suggestions">
          {TIMEZONE_SUGGESTIONS.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </div>
      <FieldState
        label={t("connections.timezone")}
        custom={custom}
        baseText={baseValue ?? t("capabilities.state.unread")}
        currentText={display}
        disabled={saving}
        canCustom={baseValue !== null}
        onFollow={() => patch(group, name, undefined)}
        onCustom={() => baseValue !== null && patch(group, name, baseValue)}
      />
      {showInvalid && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
          {t("connections.timezoneInvalid")}
        </p>
      )}
    </Field>
  );
}

/**
 * 0052 嵌套 stages 开关：逐阶段跟随/开/关（全关合法）；字段名是 `stages.<phase>` 点路径，
 * state 层把它写进 `media_input.stages.<phase>`；同值开也是显式钉住。
 */
function StageField({
  editor,
  base,
  phase,
  labelKey,
}: {
  editor: QqGroupConfigEditor;
  base: Record<string, unknown> | null;
  phase: "decision" | "evaluation" | "generation";
  labelKey: string;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupOverride);
  const name = `stages.${phase}`;
  const { custom, value } = overrideOf(editor, "media_input", name);
  const baseStages = (base?.stages as Record<string, unknown> | undefined) ?? {};
  const baseValue = baseStages[phase] === true;
  const boolText = (flag: boolean) => t(flag ? "connections.on" : "connections.off");
  return (
    <Field label={labelKey} info="schemes.studio.stageOffHint">
      <NativeSelect
        data-field={`media_input.${name}`}
        disabled={saving}
        value={custom ? (value === true ? "on" : "off") : "inherit"}
        onChange={(e) =>
          patch(
            "media_input",
            name,
            e.target.value === "inherit" ? undefined : e.target.value === "on",
          )
        }
      >
        <option value="inherit">{t("connections.followTheScheme")}</option>
        <option value="on">{t("connections.on")}</option>
        <option value="off">{t("connections.off")}</option>
      </NativeSelect>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {custom
          ? t("schemes.qq.groupConfig.customValue", {
              "0": boolText(baseValue),
              "1": boolText(value === true),
            })
          : t("schemes.qq.groupConfig.followsBase", { "0": boolText(baseValue) })}
      </p>
    </Field>
  );
}

/**
 * 0052 普通静图规格：显式「原图（null）/限制长边（64–2048）」二选一 + 数值输入。
 * null 是真实设置值（原图），不是 0；0 及越界数值是非法原文留底拦保存；undefined 才是取消钉住。
 */
function OrdinaryStillField({
  editor,
  base,
}: {
  editor: QqGroupConfigEditor;
  base: Record<string, unknown> | null;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupOverride);
  const [showError, setShowError] = useState(false);
  const group = "media_input" as const;
  const name = "ordinary_still_max_dimension";
  const { custom, value } = overrideOf(editor, group, name);
  const baseKnown = base !== null && name in base;
  const baseValue = baseKnown ? (base[name] as number | null) : null;
  const raw = editor.rawTexts[`${group}.${name}`];
  const bounds = fieldBounds("mediaInput", name);
  const currentValue = custom ? (value as number | null) : (baseValue ?? null);
  const limited = currentValue !== null;
  const numericValid = (text: string) =>
    text.trim() !== "" && schemaSafeParse(group, name, text) && Number(text) !== 0;
  const display = raw ?? (limited ? String(currentValue) : "");
  const showInvalid = showError && raw !== undefined && !numericValid(raw);
  const errorId = "group-config-ordinary-still-error";
  const choose = (kind: "original" | "limited") => {
    setShowError(false);
    if (kind === "original") patch(group, name, null);
    else if (!limited || currentValue === null) patch(group, name, String(bounds.min ?? 64));
  };
  return (
    // 与方案页同一结构：选择框是 Field 首个控件（标题 htmlFor 关联），数值框各自显式命名。
    <Field label="connections.ordinaryStillChoice" info="connections.ordinaryStillOriginal">
      <NativeSelect
        data-field={`${group}.${name}.choice`}
        disabled={saving}
        value={limited ? "limited" : "original"}
        onChange={(e) => choose(e.target.value === "original" ? "original" : "limited")}
      >
        <option value="original">{t("connections.ordinaryStillOriginal")}</option>
        <option value="limited">{t("connections.ordinaryStillLimited")}</option>
      </NativeSelect>
      <Input
        type="number"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        data-field={`${group}.${name}`}
        aria-label={t("connections.ordinaryStillMaxDimension")}
        disabled={saving || !limited}
        value={display}
        aria-invalid={showInvalid || undefined}
        aria-describedby={showInvalid ? errorId : undefined}
        onFocus={() => setShowError(false)}
        onBlur={() => setShowError(true)}
        onChange={(e) => {
          setShowError(false);
          patch(group, name, e.target.value);
        }}
      />
      <FieldState
        label={t("connections.ordinaryStillMaxDimension")}
        custom={custom}
        baseText={
          baseKnown
            ? baseValue === null
              ? t("connections.ordinaryStillOriginal")
              : String(baseValue)
            : t("capabilities.state.unread")
        }
        currentText={limited ? String(currentValue) : t("connections.ordinaryStillOriginal")}
        disabled={saving}
        canCustom={baseKnown}
        onFollow={() => patch(group, name, undefined)}
        onCustom={() =>
          baseKnown && patch(group, name, baseValue === null ? null : String(baseValue))
        }
      />
      {showInvalid && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
          {t("schemes.studio.integerRange", {
            "0": String(bounds.min ?? ""),
            "1": String(bounds.max ?? ""),
          })}
        </p>
      )}
    </Field>
  );
}

/** 三态字段（触发开关/布尔项）：跟随基础方案 = 不进差异；开/关 = 显式覆盖（与基线同值也算）。 */
function ThreeStateField({
  editor,
  base,
  group,
  name,
  labelKey,
  infoKey,
  disabledNoticeKey,
}: {
  editor: QqGroupConfigEditor;
  base: Record<string, unknown> | null;
  group: "triggers" | "rhythm" | "reply";
  name: string;
  labelKey: string;
  infoKey?: string;
  disabledNoticeKey?: string;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupOverride);
  const { custom, value } = overrideOf(editor, group, name);
  const baseValue = base?.[name] === true;
  const baseText =
    base === null
      ? t("capabilities.state.unread")
      : t(baseValue ? "connections.on" : "connections.off");
  const boolText = (flag: boolean) => t(flag ? "connections.on" : "connections.off");

  const schemeTriggers =
    group === "triggers" && base !== null
      ? {
          follow_up: (base as Record<string, unknown>).follow_up === true,
          chiming_in: (base as Record<string, unknown>).chiming_in === true,
        }
      : editor.source.base_scheme.triggers;
  const effectivePair =
    group === "triggers"
      ? resolveQqInteractionPair({
          scheme: schemeTriggers,
          binding: editor.source.binding.triggers,
          group: editor.overrides.triggers
            ? {
                follow_up: editor.overrides.triggers.follow_up ?? null,
                chiming_in: editor.overrides.triggers.chiming_in ?? null,
              }
            : undefined,
        })
      : null;
  const isSuppressedFollowUp =
    group === "triggers" &&
    name === "follow_up" &&
    effectivePair?.chimingIn === true &&
    effectivePair?.continuous === false &&
    (custom ? value === true : baseValue === true);

  return (
    <Field label={labelKey} info={infoKey}>
      <NativeSelect
        data-field={`${group}.${name}`}
        disabled={saving}
        value={custom ? (value === true ? "on" : "off") : "inherit"}
        onChange={(e) =>
          patch(group, name, e.target.value === "inherit" ? undefined : e.target.value === "on")
        }
      >
        <option value="inherit">{t("connections.followTheScheme")}</option>
        <option value="on">{t("connections.on")}</option>
        <option value="off">{t("connections.off")}</option>
      </NativeSelect>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {isSuppressedFollowUp
          ? t("connections.legacyChimingInPrecedenceNotice")
          : custom
            ? t("schemes.qq.groupConfig.customValue", {
                "0": baseText,
                "1": boolText(value === true),
              })
            : t("schemes.qq.groupConfig.followsBase", { "0": baseText })}
      </p>
      {disabledNoticeKey && (custom ? value === false : base !== null && !baseValue) && (
        <p className="mt-1.5 text-xs text-muted-foreground">{t(disabledNoticeKey)}</p>
      )}
    </Field>
  );
}

/** 提示词字段：原文原样保存；跟随显示里回复任务与方案页同一派生（qqEffectiveReplyPrompt）。 */
function PromptField({
  editor,
  base,
  effective,
  slot,
  labelKey,
  hintKey,
}: {
  editor: QqGroupConfigEditor;
  base: QqSchemeResponse | null;
  effective: QqSchemeResponse | null;
  slot: keyof QqSchemePrompts;
  labelKey: string;
  hintKey?: string;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupOverride);
  const { custom, value } = overrideOf(editor, "prompts", slot);
  const raw = editor.rawTexts[`prompts.${slot}`];
  const followText =
    slot === "reply"
      ? qqEffectiveReplyPrompt(
          effective?.prompts.reply ?? "",
          effective?.reply.split_by_speaker === true,
        )
      : (effective?.prompts[slot] ?? "");
  // 自定义字段保留原始输入：只有跟随显示才用派生文本。
  const display = raw ?? (custom ? String(value ?? "") : followText);
  return (
    <Field label={labelKey} info={hintKey}>
      <Textarea
        className="min-h-36 font-mono text-xs leading-6"
        data-prompt={`prompts.${slot}`}
        disabled={saving}
        value={display}
        onChange={(e) => patch("prompts", slot, e.target.value)}
      />
      <FieldState
        label={t(labelKey)}
        custom={custom}
        baseText={t("schemes.qq.groupConfig.promptBaseNote")}
        currentText={t("schemes.qq.groupConfig.promptCurrentNote")}
        disabled={saving}
        canCustom={base !== null}
        onFollow={() => patch("prompts", slot, undefined)}
        onCustom={() => patch("prompts", slot, String(base?.prompts[slot] ?? ""))}
      />
    </Field>
  );
}

/** 素材集合：整体替换且只能收窄基础方案已授权的范围（不能借本群配置扩大授权）。 */
function CollectionsField({
  editor,
  base,
}: {
  editor: QqGroupConfigEditor;
  base: Record<string, unknown> | null;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupOverride);
  const collections = useSuperstringStore((s) => s.qqStickerCollections);
  const load = useSuperstringStore((s) => s.loadQqStickers);
  useEffect(() => {
    void load();
  }, [load]);
  const { custom, value } = overrideOf(editor, "sticker_collections", "collection_ids");
  const baseKnown = base !== null && Array.isArray(base.collection_ids);
  const baseIds = (baseKnown ? base.collection_ids : []) as string[];
  const current = custom ? (value as string[]) : baseIds;
  // 基础方案撤权后原选择可能已不在授权列表里：仍算已选、可移除，但不能从界面上消失。
  const unavailableIds = baseKnown ? current.filter((id) => !baseIds.includes(id)) : [];
  const toggle = (id: string, checked: boolean) =>
    patch(
      "sticker_collections",
      "collection_ids",
      checked ? [...new Set([...current, id])] : current.filter((item) => item !== id),
    );
  return (
    <Field
      label="connections.authorizedCollections"
      info="connections.onlyEnabledAssetsInAuthorizedCollectionsCanBeSelected"
    >
      <div className="space-y-3">
        {!baseKnown && (
          <p className="text-xs text-muted-foreground">{t("capabilities.state.unread")}</p>
        )}
        {baseKnown && baseIds.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("schemes.qq.groupConfig.collectionsEmpty")}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {baseIds.map((id) => (
            <Label key={id} className="rounded-lg border p-3">
              <Checkbox
                checked={current.includes(id)}
                disabled={saving}
                aria-label={id}
                onCheckedChange={(checked) => toggle(id, checked === true)}
              />
              {collections.find((row) => row.id === id)?.name ?? id}
            </Label>
          ))}
          {unavailableIds.map((id) => (
            <Label key={id} className="rounded-lg border border-dashed p-3">
              <Checkbox
                checked
                disabled={saving}
                aria-label={id}
                onCheckedChange={() => toggle(id, false)}
              />
              <span className="min-w-0">
                {collections.find((row) => row.id === id)?.name ?? id}
                <span className="block text-xs text-muted-foreground">
                  {t("schemes.qq.groupConfig.capability.unauthorized")}
                </span>
              </span>
            </Label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("schemes.qq.groupConfig.collectionsScope")}
        </p>
        <FieldState
          label={t("connections.authorizedCollections")}
          custom={custom}
          baseText={baseKnown ? String(baseIds.length) : t("capabilities.state.unread")}
          currentText={String(current.length)}
          disabled={saving}
          canCustom={baseKnown}
          onFollow={() => patch("sticker_collections", "collection_ids", undefined)}
          onCustom={() => patch("sticker_collections", "collection_ids", [...baseIds])}
        />
      </div>
    </Field>
  );
}

/** 回复条数只读：跟随绑定助手的「保留最近轮数」，本群不可覆盖。 */
function ReadonlyReplyCount({ editor }: { editor: QqGroupConfigEditor }) {
  const { t } = useTranslation();
  const agents = useSuperstringStore((s) => s.agents);
  const agent = agents.find((row) => row.id === editor.source.binding.agent_id);
  return (
    <Field
      label="connections.replyRecentMessages"
      info="connections.followsTheBoundAssistantRecentTurns"
    >
      <p className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
        {agent ? String(agent.p5_config.recent_turns) : t("connections.followsTheBoundAssistant")}
      </p>
    </Field>
  );
}

/** 本群能力：跟随上层 / 本群停用；上层事实逐项来自已保存的真实来源，读不到就「未读取 + 重试」。 */
function CapabilityList({
  editor,
  knowledge,
}: {
  editor: QqGroupConfigEditor;
  knowledge: KnowledgeReadProjection;
}) {
  const { t } = useTranslation();
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const setCapability = useSuperstringStore((s) => s.setQqGroupCapability);
  const permissionEditor = useSuperstringStore((s) => s.permissionEditor);
  const permissionLoading = useSuperstringStore((s) => s.permissionLoading);
  const permissionError = useSuperstringStore((s) => s.permissionError);
  const loadPermission = useSuperstringStore((s) => s.loadPermissionSettings);
  const agents = useSuperstringStore((s) => s.agents);
  /** 图片理解模型未配置＝媒体读不出来（媒体不回退会话模型）；编辑器未载入时不猜。 */
  const visionConfigured = useSuperstringStore((s) =>
    s.organizationEditor
      ? (s.organizationEditor.source.vision_model_name ?? "").trim() !== ""
      : null,
  );
  useEffect(() => {
    void loadPermission();
  }, [loadPermission]);
  const agentId = editor.source.binding.agent_id;
  const snapshot = permissionEditor?.snapshot ?? null;
  const execution = snapshot ? executionPolicy(snapshot.policy) : null;
  const resources = snapshot ? permissionResources(snapshot) : [];
  /** 服务端 evaluatePermission 的界面镜像：Agent 范围不匹配＝未授权。 */
  const agentInGrant = (grant: PermissionGrant) =>
    !grant.agentIds || (agentId !== "" && grant.agentIds.includes(agentId));
  const revisionCompatible = (resource: PermissionResource, grant: PermissionGrant) =>
    !(
      (resource.approvalRequired || grant.revision !== undefined) &&
      grant.revision !== resource.revision
    );
  const factOf = (row: CapabilityRow): UpperFact => {
    if (row.upper.kind === "followsSession") return "followsSession";
    if (!execution || !snapshot) return "unread";
    if (row.upper.kind === "module") {
      const on = execution.modules[row.upper.module];
      if (row.id === "web") {
        // 联网还要求工具授权覆盖当前 Agent：模块开着不等于此 Agent 可用。
        if (!on) return "off";
        const resource = resources.find((item) => item.resource === "web");
        const grant = snapshot.policy.grants.find((item) => item.resource === "web");
        if (!resource || !grant || !agentInGrant(grant)) return "unauthorized";
        if (resource.approvalRequired && !grant.approved) return "approval";
        if (!revisionCompatible(resource, grant)) return "unauthorized";
        // 资源级暂停与逐动作暂停都要查（toolExecutionEnabled 同一份判定）：动作全暂停＝关。
        return ["web.search", "web.fetch"].some((name) => toolExecutionEnabled(execution, name))
          ? "on"
          : "off";
      }
      // 媒体/表情的本群停用同样收缩实际可用性，与模块开关一起看。
      if (row.id === "media" || row.id === "stickers")
        return editor.disabledCapabilities.includes(row.id) || !on ? "off" : "on";
      return on ? "on" : "off";
    }
    if (row.upper.kind === "flag") return execution[row.upper.flag] ? "on" : "off";
    if (row.upper.kind === "read") {
      if (row.upper.read === "memory") {
        const agent = agents.find((item) => item.id === agentId);
        if (!agent) return "unread";
        return agent.p5_config.retrieval_mode === "off" ? "off" : "on";
      }
      // 知识查询按该 Agent 已保存的读取设置：读不到＝未知（不是 off），行内可重试。
      if (!knowledge.data) return "unread";
      return knowledge.data.config.enabled ? "on" : "off";
    }
    const resourcePrefix = row.upper.prefix;
    const prefix = `${resourcePrefix}.`;
    const moduleOn = resourcePrefix === "mcp" ? execution.modules.mcp : execution.modules.skills;
    if (!moduleOn) return "off";
    const entries = resources.filter(
      (resource) => resource.resource === resourcePrefix || resource.resource.startsWith(prefix),
    );
    if (!entries.length) return "noActions";
    const grants = snapshot.policy.grants;
    const facts = entries.map((resource) => {
      const grant = grants.find((item) => item.resource === resource.resource);
      if (!grant || !agentInGrant(grant)) return { ready: false, needsApproval: false };
      const runnable = toolExecutionEnabled(execution, resource.resource);
      const needsApproval = runnable && resource.approvalRequired && !grant.approved;
      return {
        ready: runnable && !needsApproval && revisionCompatible(resource, grant),
        needsApproval,
      };
    });
    if (facts.some((fact) => fact.ready)) return "on";
    if (facts.some((fact) => fact.needsApproval)) return "approval";
    return "unauthorized";
  };
  return (
    <div className="space-y-4">
      {!execution && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
          <p
            role={permissionError ? "alert" : "status"}
            className={
              permissionError ? "text-sm text-destructive" : "text-sm text-muted-foreground"
            }
          >
            {permissionError
              ? translateNotice(permissionError)
              : t("schemes.qq.groupConfig.capability.unread")}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={permissionLoading}
            onClick={() => void loadPermission(true)}
          >
            {t("capabilities.retry")}
          </Button>
        </div>
      )}
      <ul className="space-y-2">
        {CAPABILITIES.map((row) => {
          const disabled = editor.disabledCapabilities.includes(row.id);
          const fact = factOf(row);
          return (
            <li
              key={row.id}
              data-capability={row.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{t(row.labelKey)}</span>
                <span className="block text-xs text-muted-foreground" data-upper={fact}>
                  {t(UPPER_TEXT[fact])}
                </span>
                {row.id === "media" && fact === "on" && visionConfigured === false && (
                  <span className="block text-xs text-muted-foreground">
                    {t("library.annotation.vision_model_not_configured")}
                  </span>
                )}
                {row.id === "knowledge_read" && !knowledge.data && !knowledge.loading && (
                  <span className="mt-1 flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-8 whitespace-normal"
                      data-capability-retry
                      onClick={() => knowledge.refresh()}
                    >
                      {t("capabilities.retry")}
                    </Button>
                    {knowledge.error !== "" && (
                      <span role="alert" className="text-xs text-destructive">
                        {translateNotice(knowledge.error)}
                      </span>
                    )}
                  </span>
                )}
              </span>
              {disabled && (
                <Badge variant="secondary">{t("schemes.qq.groupConfig.capability.off")}</Badge>
              )}
              <NativeSelect
                className="min-w-36"
                aria-label={t(row.labelKey)}
                disabled={saving}
                value={disabled ? "off" : "follow"}
                onChange={(e) => setCapability(row.id, e.target.value === "off")}
              >
                <option value="follow">{t("schemes.qq.groupConfig.capability.follow")}</option>
                <option value="off">{t("schemes.qq.groupConfig.capability.off")}</option>
              </NativeSelect>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{t("schemes.qq.groupConfig.capability.note")}</p>
    </div>
  );
}

/** 变更行的钉住状态：overrides 里存在该字段＝本群自定义（含与基线同值），否则＝取消钉住回到跟随。 */
function PinStateBadge({
  editor,
  group,
  field,
}: {
  editor: QqGroupConfigEditor;
  group: string;
  field: string;
}) {
  const { t } = useTranslation();
  const pinned = overrideOf(editor, group, field).custom;
  return (
    <Badge variant="outline" data-pin-state={pinned ? "custom" : "follow"}>
      {t(pinned ? "schemes.qq.groupConfig.customBadge" : "schemes.qq.groupConfig.followBadge")}
    </Badge>
  );
}

/** 变更列表：页脚预览对话框用（只列本次真正会写下的差异）。 */
function ChangeList({
  changes,
  schemeNameOf,
  editor,
}: {
  changes: readonly QqGroupConfigChange[];
  schemeNameOf: (id: string) => string;
  editor?: QqGroupConfigEditor | null;
}) {
  const { t } = useTranslation();
  // 变更项由 state 模块给出中性文本（布尔是 true/false，钉住/取消的差异见徽标）：
  // 界面按开关/选项/原图文案显示，钉住状态从草稿的 overrides 存在性现推。
  const changedValueText = (group: string, field: string, raw: string): string => {
    if (!editor) return raw;
    // 0052 嵌套 stages 与 media_input 顶层布尔同样按开/关显示（stages.<phase> 去前缀查基线）。
    const baseStages = (baseGroupOf(editor.source.base_scheme, group)?.stages ?? {}) as Record<
      string,
      unknown
    >;
    const stagePhase =
      group === "media_input" && field.startsWith("stages.")
        ? field.slice("stages.".length)
        : undefined;
    const baseField =
      baseGroupOf(editor.source.base_scheme, group)[field] ??
      (stagePhase === undefined ? undefined : baseStages[stagePhase]);
    if (typeof baseField !== "boolean") {
      // 0052 枚举与可空原图：预览按选项人话渲染，null 读「原图」。
      if (group === "media_input" && field === "ordinary_still_max_dimension" && raw === "null")
        return t("connections.ordinaryStillOriginal");
      const enumLabels = ENUM_OPTION_LABELS[`${group}.${field}`];
      if (enumLabels?.[raw]) return t(enumLabels[raw]);
      return raw;
    }
    if (raw === "true") return t("connections.on");
    if (raw === "false") return t("connections.off");
    return raw;
  };
  if (!changes.length)
    return <p className="text-sm text-muted-foreground">{t("schemes.qq.groupConfig.noChanges")}</p>;
  // 变化项按「种类 + 字段/能力/方案」构造时天然唯一，可直接做 key。
  const keyOf = (change: QqGroupConfigChange): string => {
    switch (change.kind) {
      case "override":
      case "raw":
        return `${change.kind}:${change.group}.${change.field}`;
      case "capability":
        return `capability:${change.capability}`;
      case "scheme":
        return `scheme:${change.schemeId}`;
    }
  };
  return (
    <ul className="space-y-1 text-sm">
      {changes.map((change) => (
        <li key={keyOf(change)} className="break-words">
          {change.kind === "override" && (
            <span className="flex flex-wrap items-center gap-2">
              {editor && (
                <PinStateBadge editor={editor} group={change.group} field={change.field} />
              )}
              <span>
                {t("schemes.qq.groupConfig.change.override", {
                  "0": t(labelOf(change.group, change.field)),
                  "1": changedValueText(change.group, change.field, change.before),
                  "2": changedValueText(change.group, change.field, change.after),
                })}
              </span>
            </span>
          )}
          {change.kind === "raw" && (
            <span className="text-destructive">
              {t("schemes.qq.groupConfig.change.raw", {
                "0": t(labelOf(change.group, change.field)),
                "1": change.raw,
              })}
            </span>
          )}
          {change.kind === "capability" && (
            <span>
              {t(
                change.disabled
                  ? "schemes.qq.groupConfig.change.capabilityOff"
                  : "schemes.qq.groupConfig.change.capabilityOn",
                { "0": t(CAPABILITY_LABELS[change.capability]) },
              )}
            </span>
          )}
          {change.kind === "scheme" && (
            <span>
              {t("schemes.qq.groupConfig.change.scheme", {
                "0": schemeNameOf(change.schemeId),
                "1": t(
                  change.reset
                    ? "schemes.qq.groupConfig.scheme.resetLabel"
                    : "schemes.qq.groupConfig.scheme.keepLabel",
                ),
              })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 换基础方案的真实预览：全部当前钉住（已存 + 草稿）对比目标方案值，外加 keep/reset 的处置说明。 */
function SchemeSwitchPreview({
  editor,
  target,
}: {
  editor: QqGroupConfigEditor;
  target: QqSchemeResponse | null;
}) {
  const { t } = useTranslation();
  // 嵌套 stages 展开成逐阶段叶子行（name=stages.<phase>），不产生 stages 对象父行；
  // 目标基线读取走同一嵌套路径（overrideOf/ChangeList 同一份语义），不用平铺 baseFields[name]。
  const pins: Array<{ key: string; group: string; name: string; value: unknown }> = [];
  for (const [group, fields] of Object.entries(bagOf(editor))) {
    if (group === "media_input") {
      const { stages, ...rest } = fields ?? {};
      for (const [name, value] of Object.entries(rest))
        pins.push({ key: `media_input.${name}`, group, name, value });
      for (const [phase, value] of Object.entries((stages as Record<string, unknown>) ?? {}))
        if (value !== undefined)
          pins.push({ key: `media_input.stages.${phase}`, group, name: `stages.${phase}`, value });
      continue;
    }
    for (const [name, value] of Object.entries(fields ?? {}))
      pins.push({ key: `${group}.${name}`, group, name, value });
  }
  const raws = Object.entries(editor.rawTexts);
  return (
    <div className="space-y-3">
      {!target && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("schemes.qq.groupConfig.scheme.unknownTarget")}
        </p>
      )}
      {pins.length === 0 && raws.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("schemes.qq.groupConfig.noChanges")}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {pins.map((pin) => {
            // 目标基线同样按嵌套路径取值（stages.<phase> 读 media_input.stages.<phase>）。
            const stagePhase =
              pin.group === "media_input" && pin.name.startsWith("stages.")
                ? pin.name.slice("stages.".length)
                : undefined;
            const targetFields = target ? baseGroupOf(target, pin.group) : null;
            const targetValue =
              targetFields && stagePhase !== undefined
                ? (targetFields.stages as Record<string, unknown> | undefined)?.[stagePhase]
                : targetFields
                  ? targetFields[pin.name]
                  : undefined;
            const after =
              targetFields &&
              (stagePhase !== undefined
                ? targetFields.stages !== undefined && stagePhase in (targetFields.stages as object)
                : pin.name in targetFields)
                ? valueTextOf(t, pin.group, pin.name, targetValue)
                : null;
            return (
              <li key={pin.key} data-switch-row={pin.key} className="break-words">
                <span>{t(labelOf(pin.group, pin.name))}</span>
                <span className="text-muted-foreground">{" → "}</span>
                <span>{valueTextOf(t, pin.group, pin.name, pin.value)}</span>
                <span className="text-muted-foreground">{" → "}</span>
                <span>{after ?? t("capabilities.state.unread")}</span>
              </li>
            );
          })}
          {raws.map(([key, raw]) => {
            const [group, ...rest] = key.split(".");
            return (
              <li key={`raw:${key}`} data-switch-row={key} className="break-words text-destructive">
                {t("schemes.qq.groupConfig.change.raw", {
                  "0": t(labelOf(group, rest.join("."))),
                  "1": raw,
                })}
              </li>
            );
          })}
        </ul>
      )}
      <p data-switch-note="keep" className="text-xs text-muted-foreground">
        {t("schemes.qq.groupConfig.scheme.keepNote")}
      </p>
      <p data-switch-note="reset" className="text-xs text-muted-foreground">
        {t("schemes.qq.groupConfig.scheme.resetNote")}
      </p>
    </div>
  );
}

/** 基础方案：换方案先看真实预览与差异，再显式选 keep/reset 进草稿；取消不动草稿。 */
function BaseSchemeSection({ editor }: { editor: QqGroupConfigEditor }) {
  const { t } = useTranslation();
  const schemes = useSuperstringStore((s) => s.qqSchemes);
  const saving = useSuperstringStore((s) => s.qqGroupConfigSaving);
  const patch = useSuperstringStore((s) => s.patchQqGroupConfigScheme);
  const load = useSuperstringStore((s) => s.loadQqSchemes);
  useEffect(() => {
    void load();
  }, [load]);
  const [choice, setChoice] = useState<string | null>(null);
  const baseId = editor.source.base_scheme.id;
  const selected = editor.schemeId ?? baseId;
  const schemeNameOf = (id: string) => schemes.find((row) => row.id === id)?.name ?? id;
  const choiceTarget = choice ? (schemes.find((row) => row.id === choice) ?? null) : null;
  return (
    <SchemeFieldCard
      title={t("schemes.qq.groupConfig.scheme.title")}
      description="schemes.qq.groupConfig.scheme.description"
    >
      <Field label="schemes.qq.groupConfig.scheme.switch">
        <NativeSelect
          data-field="scheme.switch"
          disabled={saving}
          value={selected}
          onChange={(e) => {
            const next = e.target.value;
            if (next === baseId) patch(undefined);
            else setChoice(next);
          }}
        >
          {!schemes.some((row) => row.id === baseId) && (
            <option value={baseId}>{editor.source.base_scheme.name}</option>
          )}
          {editor.schemeId !== undefined && !schemes.some((row) => row.id === editor.schemeId) && (
            <option value={editor.schemeId}>{schemeNameOf(editor.schemeId)}</option>
          )}
          {schemes.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {editor.schemeId !== undefined && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          {t("schemes.qq.groupConfig.scheme.pending", {
            "0": schemeNameOf(editor.schemeId),
            "1": t(
              editor.schemeChange === "reset"
                ? "schemes.qq.groupConfig.scheme.resetLabel"
                : "schemes.qq.groupConfig.scheme.keepLabel",
            ),
          })}
          <Button variant="link" size="sm" disabled={saving} onClick={() => patch(undefined)}>
            {t("schemes.qq.groupConfig.scheme.cancelPending")}
          </Button>
        </p>
      )}
      {choice && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setChoice(null);
          }}
        >
          <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {t("schemes.qq.groupConfig.scheme.confirmTitle", { "0": schemeNameOf(choice) })}
              </DialogTitle>
              <DialogDescription>
                {t("schemes.qq.groupConfig.scheme.confirmBody")}
              </DialogDescription>
            </DialogHeader>
            <SchemeSwitchPreview editor={editor} target={choiceTarget} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setChoice(null)}>
                {t("connections.cancel")}
              </Button>
              <Button
                variant="outline"
                data-switch-action="reset"
                onClick={() => {
                  patch(choice, "reset");
                  setChoice(null);
                }}
              >
                {t("schemes.qq.groupConfig.scheme.resetLabel")}
              </Button>
              <Button
                data-switch-action="keep"
                onClick={() => {
                  patch(choice, "keep");
                  setChoice(null);
                }}
              >
                {t("schemes.qq.groupConfig.scheme.keepLabel")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SchemeFieldCard>
  );
}

export function QqGroupConfigPage({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const state = useSuperstringStore(
    useShallow((s) => ({
      // 数据字段：按实际读取面窄订阅；无关 store 更新不再重渲染本页。
      agents: s.agents,
      error: s.error,
      feedback: s.feedback,
      qqBindings: s.qqBindings,
      qqBindingsLoaded: s.qqBindingsLoaded,
      qqGroupConfigBindingId: s.qqGroupConfigBindingId,
      qqGroupConfigEditor: s.qqGroupConfigEditor,
      qqGroupConfigLoading: s.qqGroupConfigLoading,
      qqGroupConfigSaving: s.qqGroupConfigSaving,
      qqSchemes: s.qqSchemes,
      summaryById: s.summaryById,
      // 动作引用稳定。
      apiClient: s.apiClient,
      discardQqGroupConfigChanges: s.discardQqGroupConfigChanges,
      loadQqBindings: s.loadQqBindings,
      openChat: s.openChat,
      openQqGroupConfig: s.openQqGroupConfig,
      patchQqGroupConfigScheme: s.patchQqGroupConfigScheme,
      refreshQqGroupConfig: s.refreshQqGroupConfig,
      openSettingsRoute: s.openSettingsRoute,
      requestConversationNavigation: s.requestConversationNavigation,
      saveQqGroupConfig: s.saveQqGroupConfig,
    })),
  );
  const editor = state.qqGroupConfigEditor;
  const bindingId = state.qqGroupConfigBindingId;
  // 编辑器可能属于上一个打开的群：绑定身份不等就整页不显示它的任何内容。
  const visibleEditor =
    editor && bindingId !== null && editor.source.binding.id === bindingId ? editor : null;
  // 知识查询的已保存状态：页面作用域的只读投影（不是第二份配置草稿），与权限读取并行；
  // 只按绑定 Agent 读取，失败保持未知（不是 off），行内重试或页头显式刷新都能重新读取。
  const knowledgeAgentId = visibleEditor?.source.binding.agent_id ?? "";
  const readKnowledgeRead = useCallback(
    () => state.apiClient.getAgentKnowledgeRead(knowledgeAgentId),
    [state.apiClient, knowledgeAgentId],
  );
  const knowledgeRead = useLiveResource(readKnowledgeRead, {
    enabled: knowledgeAgentId !== "",
    paused: !active,
  });

  useEffect(() => {
    if (!state.qqBindingsLoaded) {
      void state.loadQqBindings();
    }
  }, [state.qqBindingsLoaded, state.loadQqBindings]);

  const [tab, setTab] = useState("participation");
  const [onlyCustom, setOnlyCustom] = useState(false);
  const [preview, setPreview] = useState(false);
  const [resetAll, setResetAll] = useState(false);
  const [adminEditorOpen, setAdminEditorOpen] = useState(false);
  const changes = useMemo(
    () => (visibleEditor ? qqGroupConfigChanges(visibleEditor) : []),
    [visibleEditor],
  );
  const rangeInvalid = useMemo(
    () => (visibleEditor ? hasOutOfRangeOverride(visibleEditor) : false),
    [visibleEditor],
  );
  // 目标基线＝待切换方案（在已读列表里）否则打开时的基线；目标没读到就不假装知道基础值。
  const pendingTarget =
    visibleEditor && visibleEditor.schemeId !== undefined
      ? (state.qqSchemes.find((row) => row.id === visibleEditor.schemeId) ?? null)
      : undefined;
  const invalid =
    !!visibleEditor &&
    (qqGroupConfigHasInvalidInputs(visibleEditor, pendingTarget ?? undefined) || rangeInvalid);
  const dirty = !!visibleEditor && qqGroupConfigDirty(visibleEditor);
  // 绑定身份已改：旧草稿没有合法的保存对象，保存一律禁用，只能放弃后显式重开。
  const conflicted = !!visibleEditor?.identityConflict;
  const saving = state.qqGroupConfigSaving;
  const baseScheme = visibleEditor
    ? pendingTarget === undefined
      ? visibleEditor.source.base_scheme
      : pendingTarget
    : null;
  const effective =
    visibleEditor && baseScheme
      ? qqGroupConfigEffectiveScheme(visibleEditor, pendingTarget ?? undefined)
      : null;
  const baseBag = (group: string): Record<string, unknown> | null =>
    baseScheme ? baseGroupOf(baseScheme, group) : null;
  const agent = visibleEditor
    ? state.agents.find((row) => row.id === visibleEditor.source.binding.agent_id)
    : undefined;
  const agentName = agent?.name ?? visibleEditor?.source.binding.agent_id ?? "";
  // 返回会话要落在同一绑定、同一助手的对话上：旧助手的历史摘要不算。
  const summary = visibleEditor
    ? Object.values(state.summaryById).find(
        (row) =>
          row.sourceId === visibleEditor.source.binding.id &&
          row.agentId === visibleEditor.source.binding.agent_id,
      )
    : undefined;
  const schemeNameOf = (id: string) => state.qqSchemes.find((row) => row.id === id)?.name ?? id;
  const visible = (group: string, name: string) =>
    !onlyCustom || (!!visibleEditor && isCustomField(visibleEditor, group, name));
  const back = () => {
    state.openSettingsRoute("qq-app-groups");
  };
  const baseName = baseScheme ? baseScheme.name : (visibleEditor?.schemeId ?? "");
  const otherGroups = useMemo(() => {
    if (!state.qqBindingsLoaded) return [];
    return projectQqGroupRows({
      qqBindings: state.qqBindings,
      qqSchemes: state.qqSchemes,
      agents: state.agents,
      summaryById: state.summaryById,
    });
  }, [state.qqBindingsLoaded, state.qqBindings, state.qqSchemes, state.agents, state.summaryById]);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t("schemes.qq.groupConfigTitle")}>
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("schemes.qq.groups.backToDirectory")}
          onClick={back}
        >
          <ChevronLeft />
        </Button>
        <h1 className="text-base font-semibold">{t("schemes.qq.groupConfigTitle")}</h1>
        {visibleEditor && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline">
              {t(
                visibleEditor.source.binding.kind === "group"
                  ? "connections.group"
                  : "connections.privateChat",
              )}
            </Badge>
            <span className="font-mono">{visibleEditor.source.binding.peer_id}</span>
            {summary && <span className="max-w-40 truncate">{summary.title}</span>}
            <span>
              · {t("schemes.qq.groupConfig.account")} {visibleEditor.source.binding.account_id}
            </span>
            <span>
              · {t("schemes.qq.groupConfig.agent")} {agentName}
            </span>
            <span>
              · {t("schemes.qq.groupConfig.baseScheme")} {baseName}
            </span>
            {otherGroups.length > 1 && (
              <NativeSelect
                className="h-auto min-h-8 text-xs"
                value={visibleEditor.source.binding.id}
                aria-label={t("schemes.qq.groups.switchGroup")}
                disabled={saving || state.qqGroupConfigLoading}
                onChange={(event) => state.openQqGroupConfig(event.target.value)}
              >
                {otherGroups.map((g) => (
                  <option key={g.bindingId} value={g.bindingId}>
                    {`${g.title ? `${g.title} (${g.peerId})` : g.peerId} · ${g.accountId}`}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {visibleEditor && (
            <Button
              variant="outline"
              size="sm"
              className="h-auto min-h-8 max-w-full whitespace-normal break-words"
              disabled={saving || state.qqGroupConfigLoading}
              onClick={() => setAdminEditorOpen(true)}
            >
              <Shield className="size-3.5" />
              {t("connections.administrators")}
            </Button>
          )}
          {summary && (
            <Button
              variant="outline"
              size="sm"
              className="h-auto min-h-8 max-w-full whitespace-normal break-words"
              onClick={() => void state.requestConversationNavigation(summary.id)}
            >
              <MessageSquare className="size-3.5" />
              {t("schemes.qq.groups.viewConversation")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-8 max-w-full whitespace-normal break-words"
            disabled={saving || state.qqGroupConfigLoading}
            onClick={() => {
              void state.refreshQqGroupConfig();
              // 显式刷新同时推进知识查询的已保存状态，不留在旧读取上。
              knowledgeRead.refresh();
            }}
          >
            {t("capabilities.resources.refreshBaseline")}
          </Button>
        </div>
      </header>
      {visibleEditor?.identityConflict && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
          <p role="status" className="text-muted-foreground">
            {t("schemes.qq.groupConfig.controls.wrongAgent")}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-8 whitespace-normal"
            data-reopen-config
            disabled={saving}
            onClick={() => state.openQqGroupConfig(visibleEditor.source.binding.id)}
          >
            {t("schemes.qq.groupConfig.controls.configure")}
          </Button>
        </div>
      )}
      {visibleEditor && (state.error || state.feedback) && (
        <div className="border-b px-4 py-2 text-xs">
          {state.error ? (
            <p role="alert" className="text-destructive">
              {translateNotice(state.error)}
            </p>
          ) : (
            <p role="status" className="text-muted-foreground">
              {translateNotice(state.feedback)}
            </p>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6" data-workspace-scroll>
        {!visibleEditor ? (
          state.qqGroupConfigLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("schemes.qq.groupConfig.reading")}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-sm text-destructive">
                {state.error ? translateNotice(state.error) : t("schemes.qq.groupConfig.noTarget")}
              </p>
              {bindingId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void state.refreshQqGroupConfig()}
                >
                  {t("capabilities.retry")}
                </Button>
              )}
            </div>
          )
        ) : (
          <div className="w-full space-y-6">
            <p className="text-xs text-muted-foreground">
              {t("schemes.qq.groupConfig.scope", {
                "0": visibleEditor.source.binding.account_id,
                "1": visibleEditor.source.binding.peer_id,
                "2": agentName,
              })}
            </p>
            <BaseSchemeSection editor={visibleEditor} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Label>
                <Checkbox
                  checked={onlyCustom}
                  onCheckedChange={(checked) => setOnlyCustom(checked === true)}
                />
                {t("schemes.qq.groupConfig.onlyCustom")}
              </Label>
            </div>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:max-w-full [&_[role=tab]]:flex-none [&_[role=tab]]:whitespace-normal">
                {QQ_SCHEME_SECTIONS.map((section) => (
                  <TabsTrigger key={section.id} value={section.id}>
                    {t(section.labelKey)}
                  </TabsTrigger>
                ))}
                <TabsTrigger value="capabilities">
                  {t("schemes.qq.groupConfig.capabilities")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="participation" className="m-0 space-y-6">
                <SchemeFieldCard
                  title={t("connections.speechTriggers")}
                  description="schemes.studio.triggersHint"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {Object.entries(TRIGGER_LABELS)
                      .filter(([key]) => visible("triggers", key))
                      .map(([key, label]) => (
                        <ThreeStateField
                          key={key}
                          editor={visibleEditor}
                          base={baseBag("triggers")}
                          group="triggers"
                          name={key}
                          labelKey={label}
                        />
                      ))}
                  </div>
                </SchemeFieldCard>
                <SchemeFieldCard
                  title={t("schemes.studio.rhythmTitle")}
                  description="schemes.studio.rhythmHint"
                >
                  <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                    {visible("rhythm", "initiative_time_window_enabled") && (
                      <div className="sm:col-span-2">
                        <ThreeStateField
                          editor={visibleEditor}
                          base={baseBag("rhythm")}
                          group="rhythm"
                          name="initiative_time_window_enabled"
                          labelKey="connections.initiativeTimeWindowEnabled"
                          infoKey="connections.initiativeTimeWindowEnabledHint"
                          disabledNoticeKey="connections.initiativeTimeWindowDisabledNotice"
                        />
                      </div>
                    )}
                    {participationFields
                      .filter(([name]) => visible("rhythm", name))
                      .map(([name, label, info]) => (
                        <NumberField
                          key={name}
                          editor={visibleEditor}
                          base={baseBag("rhythm")}
                          group="rhythm"
                          name={name}
                          labelKey={label}
                          infoKey={info}
                        />
                      ))}
                    {visible("rhythm", "initiative_queue_on_busy") && (
                      <div className="sm:col-span-2">
                        <ThreeStateField
                          editor={visibleEditor}
                          base={baseBag("rhythm")}
                          group="rhythm"
                          name="initiative_queue_on_busy"
                          labelKey="connections.initiativeQueueOnBusy"
                          infoKey="connections.initiativeQueueOnBusyHint"
                        />
                      </div>
                    )}
                  </div>
                </SchemeFieldCard>
                <SchemeFieldCard
                  title={t("connections.allowedHours")}
                  description="connections.useLocalTimeEqualStartAndEndMeansAll"
                >
                  {visible("rhythm", "active_hours_enabled") && (
                    <ThreeStateField
                      editor={visibleEditor}
                      base={baseBag("rhythm")}
                      group="rhythm"
                      name="active_hours_enabled"
                      labelKey="connections.allowedHours"
                    />
                  )}
                  <div className="grid gap-5 sm:grid-cols-2">
                    {visible("rhythm", "active_hours_start_minutes") && (
                      <TimeField
                        editor={visibleEditor}
                        base={baseBag("rhythm")}
                        enabled={effective?.rhythm.active_hours_enabled === true}
                        name="active_hours_start_minutes"
                        labelKey="connections.allowedHoursStart"
                      />
                    )}
                    {visible("rhythm", "active_hours_end_minutes") && (
                      <TimeField
                        editor={visibleEditor}
                        base={baseBag("rhythm")}
                        enabled={effective?.rhythm.active_hours_enabled === true}
                        name="active_hours_end_minutes"
                        labelKey="connections.allowedHoursEnd"
                      />
                    )}
                  </div>
                </SchemeFieldCard>
                {visible("prompts", "judge") && (
                  <SchemeFieldCard
                    title={t("schemes.studio.judgePrompt")}
                    description="connections.decideWhetherToSpeak"
                  >
                    <PromptField
                      editor={visibleEditor}
                      base={baseScheme}
                      effective={effective}
                      slot="judge"
                      labelKey="connections.judgementTask"
                    />
                  </SchemeFieldCard>
                )}
              </TabsContent>
              <TabsContent value="response" className="m-0 space-y-6">
                {visible("reply", "split_by_speaker") && (
                  <SchemeFieldCard
                    title={t("schemes.studio.replyStructure")}
                    description="connections.whenEnabledGenerateAReplyPerSpeakerAndAdd"
                  >
                    <ThreeStateField
                      editor={visibleEditor}
                      base={baseBag("reply")}
                      group="reply"
                      name="split_by_speaker"
                      labelKey="connections.answerEachSpeakerSeparately"
                    />
                  </SchemeFieldCard>
                )}
                <SchemeFieldCard
                  title={t("schemes.studio.replyTasks")}
                  description="schemes.studio.replyTasksHint"
                >
                  {visible("prompts", "reply") && (
                    <PromptField
                      editor={visibleEditor}
                      base={baseScheme}
                      effective={effective}
                      slot="reply"
                      labelKey="connections.effectiveReplyTask"
                      hintKey="connections.editTheReplyTaskItWinsOverTheSwitch"
                    />
                  )}
                  {visible("prompts", "scene") && (
                    <PromptField
                      editor={visibleEditor}
                      base={baseScheme}
                      effective={effective}
                      slot="scene"
                      labelKey="connections.sceneAndBehaviour"
                    />
                  )}
                  {visible("prompts", "review") && (
                    <PromptField
                      editor={visibleEditor}
                      base={baseScheme}
                      effective={effective}
                      slot="review"
                      labelKey="connections.reviewTask"
                    />
                  )}
                  <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                    {responseFields
                      .filter(([name]) => visible("rhythm", name))
                      .map(([name, label, info]) => (
                        <NumberField
                          key={name}
                          editor={visibleEditor}
                          base={baseBag("rhythm")}
                          group="rhythm"
                          name={name}
                          labelKey={label}
                          infoKey={info}
                        />
                      ))}
                  </div>
                </SchemeFieldCard>
              </TabsContent>
              <TabsContent value="context_reading" className="m-0 space-y-6">
                {/* 0052 消息关系与时间：引用模式/层数、时间呈现、时区；one_then_on_demand 下
                    层数不参与运行（禁用但配置保留），切回按层数即恢复可编辑。 */}
                <SchemeFieldCard
                  title={t("schemes.studio.messageRelations")}
                  description="schemes.studio.messageRelationsHint"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {visible("message_settings", "reply_mode") && (
                      <EnumField
                        editor={visibleEditor}
                        base={baseBag("message_settings")}
                        group="message_settings"
                        name="reply_mode"
                        labelKey="connections.quoteReplyMode"
                      />
                    )}
                    {visible("message_settings", "reply_depth") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("message_settings")}
                        group="message_settings"
                        name="reply_depth"
                        labelKey="connections.quoteDepth"
                        infoKey="connections.quoteDepthHint"
                        disabled={effective?.message_settings.reply_mode === "one_then_on_demand"}
                      />
                    )}
                    {visible("message_settings", "time_display") && (
                      <EnumField
                        editor={visibleEditor}
                        base={baseBag("message_settings")}
                        group="message_settings"
                        name="time_display"
                        labelKey="connections.timeDisplayMode"
                      />
                    )}
                    {visible("message_settings", "timezone") && (
                      <TimezoneField editor={visibleEditor} base={baseBag("message_settings")} />
                    )}
                  </div>
                  {effective !== null && <QqMessagePreview settings={effective.message_settings} />}
                </SchemeFieldCard>
                <SchemeFieldCard
                  title={t("connections.judgementContext")}
                  description="connections.recentMessagesAndOutputReserveHaveSeparateBudgetsValues"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {visible("context", "judgement_message_limit") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("context")}
                        group="context"
                        name="judgement_message_limit"
                        labelKey="connections.judgementRecentMessages"
                      />
                    )}
                    {visible("context", "judgement_window_minutes") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("context")}
                        group="context"
                        name="judgement_window_minutes"
                        labelKey="connections.judgementTimeWindowMinutes"
                      />
                    )}
                    {visible("context", "judgement_token_budget") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("context")}
                        group="context"
                        name="judgement_token_budget"
                        labelKey="connections.judgementBudgetEstimatedBytes"
                      />
                    )}
                    {visible("output_reserve", "judgement_output_reserved") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("output_reserve")}
                        group="output_reserve"
                        name="judgement_output_reserved"
                        labelKey="connections.judgementOutputReserveEstimatedBytes"
                      />
                    )}
                  </div>
                </SchemeFieldCard>
                <SchemeFieldCard
                  title={t("connections.replyContext")}
                  description="connections.recentMessagesAndOutputReserveHaveSeparateBudgetsValues"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {/* 回复档条数跟随绑定助手（只读）；其他三项是本群可覆盖项。 */}
                    <ReadonlyReplyCount editor={visibleEditor} />
                    {visible("context", "reply_window_minutes") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("context")}
                        group="context"
                        name="reply_window_minutes"
                        labelKey="connections.replyTimeWindowMinutes"
                      />
                    )}
                    {visible("context", "reply_token_budget") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("context")}
                        group="context"
                        name="reply_token_budget"
                        labelKey="connections.replyBudgetEstimatedBytes"
                      />
                    )}
                    {visible("output_reserve", "reply_output_reserved") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("output_reserve")}
                        group="output_reserve"
                        name="reply_output_reserved"
                        labelKey="connections.replyOutputReserveEstimatedBytes"
                      />
                    )}
                  </div>
                </SchemeFieldCard>
                {/* 知识/记忆资料范围说明与跳转留在消息读取组（父验收决定 1）。 */}
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
              <TabsContent value="history_compression" className="m-0 space-y-6">
                <SchemeFieldCard
                  title={t("connections.compressionAndAssembly")}
                  description="schemes.studio.compressionHint"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {visible("compression", "watermark_trigger") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("compression")}
                        group="compression"
                        name="watermark_trigger"
                        labelKey="connections.watermarkTriggerMessages"
                        infoKey="connections.oldMessagesOutsideTheReplyWindowAccumulateUntilThisMany"
                      />
                    )}
                    {visible("compression", "package_limit") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("compression")}
                        group="compression"
                        name="package_limit"
                        labelKey="connections.watermarkPackageLimit"
                        infoKey="connections.packagesBeyondThisManyAreDroppedOldestFirst"
                      />
                    )}
                    {visible("compression", "headroom_ratio") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("compression")}
                        group="compression"
                        name="headroom_ratio"
                        labelKey="connections.assemblyHeadroomPercent"
                        infoKey="connections.reserveThisShareOfTheCapacityBeforeAssembling"
                        percent
                      />
                    )}
                  </div>
                  {visible("prompts", "compress") && (
                    <PromptField
                      editor={visibleEditor}
                      base={baseScheme}
                      effective={effective}
                      slot="compress"
                      labelKey="connections.watermarkCompressionTask"
                      hintKey="connections.compressTheBufferedOldMessagesIntoFactsTheStructuralRulesAre"
                    />
                  )}
                </SchemeFieldCard>
              </TabsContent>
              <TabsContent value="image_understanding" className="m-0 space-y-6">
                {/* 0052 图片输入：模式/逐阶段开关/图数/普通静图规格；普通动图沿用既有
                    rhythm 帧数与尺寸（下方的 imageFields），不重复存储。 */}
                <SchemeFieldCard
                  title={t("schemes.studio.imageInput")}
                  description="schemes.studio.imageInputHint"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {visible("media_input", "mode") && (
                      <EnumField
                        editor={visibleEditor}
                        base={baseBag("media_input")}
                        group="media_input"
                        name="mode"
                        labelKey="connections.imageInputMode"
                      />
                    )}
                    {visible("media_input", "max_images") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("media_input")}
                        group="media_input"
                        name="max_images"
                        labelKey="connections.maxAutoImages"
                      />
                    )}
                    {visible("media_input", "ordinary_still_max_dimension") && (
                      <OrdinaryStillField editor={visibleEditor} base={baseBag("media_input")} />
                    )}
                    {visible("media_input", "expression_max_dimension") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("media_input")}
                        group="media_input"
                        name="expression_max_dimension"
                        labelKey="connections.expressionStillMaxDimension"
                      />
                    )}
                    {visible("media_input", "expression_frame_count") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("media_input")}
                        group="media_input"
                        name="expression_frame_count"
                        labelKey="connections.expressionFrameCount"
                      />
                    )}
                    {visible("media_input", "expression_frame_max_dimension") && (
                      <NumberField
                        editor={visibleEditor}
                        base={baseBag("media_input")}
                        group="media_input"
                        name="expression_frame_max_dimension"
                        labelKey="connections.expressionFrameMaxDimension"
                      />
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {(
                      [
                        ["decision", "schemes.studio.stageDecision"],
                        ["evaluation", "schemes.studio.stageEvaluation"],
                        ["generation", "schemes.studio.stageGeneration"],
                      ] as const
                    )
                      .filter(([phase]) => visible("media_input", `stages.${phase}`))
                      .map(([phase, labelKey]) => (
                        <StageField
                          key={phase}
                          editor={visibleEditor}
                          base={baseBag("media_input")}
                          phase={phase}
                          labelKey={labelKey}
                        />
                      ))}
                  </div>
                </SchemeFieldCard>
                <SchemeFieldCard
                  title={t("schemes.studio.imageParams")}
                  description="schemes.studio.imageParamsHint"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {imageFields
                      .filter(([group, name]) => visible(group, name))
                      .map(([group, name, label]) => (
                        <NumberField
                          key={name}
                          editor={visibleEditor}
                          base={baseBag(group)}
                          group={group === "rhythm" ? "rhythm" : "stickers"}
                          name={name}
                          labelKey={label}
                        />
                      ))}
                  </div>
                </SchemeFieldCard>
                <SchemeFieldCard
                  title={t("connections.mediaNoteTask")}
                  description="connections.describeWhatThePictureOrVoiceActuallyContains"
                >
                  {visible("prompts", "media") && (
                    <PromptField
                      editor={visibleEditor}
                      base={baseScheme}
                      effective={effective}
                      slot="media"
                      labelKey="connections.mediaNoteTask"
                      hintKey="connections.describeWhatThePictureOrVoiceActuallyContains"
                    />
                  )}
                </SchemeFieldCard>
              </TabsContent>
              <TabsContent value="sticker_sending" className="m-0 space-y-6">
                <SchemeFieldCard
                  title={t("schemes.studio.stickerParams")}
                  description="schemes.studio.stickerParamsHint"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    {stickerFields
                      .filter(([group, name]) => visible(group, name))
                      .map(([group, name, label]) => (
                        <NumberField
                          key={name}
                          editor={visibleEditor}
                          base={baseBag(group)}
                          group={group === "rhythm" ? "rhythm" : "stickers"}
                          name={name}
                          labelKey={label}
                        />
                      ))}
                  </div>
                </SchemeFieldCard>
                {visible("sticker_collections", "collection_ids") && (
                  <SchemeFieldCard
                    title={t("connections.authorizedCollections")}
                    description="connections.onlyEnabledAssetsInAuthorizedCollectionsCanBeSelected"
                  >
                    <CollectionsField
                      editor={visibleEditor}
                      base={baseBag("sticker_collections")}
                    />
                  </SchemeFieldCard>
                )}
                <SchemeFieldCard
                  title={t("connections.stickerTask")}
                  description="connections.pickOneStickerFromTheCandidatesOutputOnlyIts"
                >
                  {visible("prompts", "sticker") && (
                    <PromptField
                      editor={visibleEditor}
                      base={baseScheme}
                      effective={effective}
                      slot="sticker"
                      labelKey="connections.stickerTask"
                      hintKey="connections.pickOneStickerFromTheCandidatesOutputOnlyIts"
                    />
                  )}
                </SchemeFieldCard>
              </TabsContent>
              <TabsContent value="capabilities" className="m-0 space-y-6">
                <SchemeFieldCard
                  title={t("schemes.qq.groupConfig.capabilities")}
                  description="schemes.qq.groupConfig.capability.description"
                >
                  <CapabilityList editor={visibleEditor} knowledge={knowledgeRead} />
                </SchemeFieldCard>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
      {visibleEditor && (
        <footer className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
          <span
            role="status"
            className="order-last w-full text-xs text-muted-foreground sm:order-none sm:w-auto"
          >
            {invalid
              ? t("schemes.qq.groupConfig.invalid")
              : dirty
                ? t("schemes.qq.groupConfig.changeCount", { "0": String(changes.length) })
                : t("schemes.qq.groupConfig.noChanges")}
          </span>
          <Button
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal break-words"
            disabled={saving || !dirty}
            onClick={() => state.discardQqGroupConfigChanges()}
          >
            {t("schemes.qq.groupConfig.discard")}
          </Button>
          <Button
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal break-words"
            disabled={saving || !dirty}
            onClick={() => setPreview(true)}
          >
            {t("schemes.qq.groupConfig.preview")}
          </Button>
          <Button
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal break-words"
            disabled={saving || !dirty}
            onClick={() => setResetAll(true)}
          >
            {t("schemes.qq.groupConfig.resetAll")}
          </Button>
          <Button
            className="ml-auto h-auto min-h-8 max-w-full whitespace-normal break-words"
            disabled={saving || invalid || !dirty || conflicted}
            onClick={() => void state.saveQqGroupConfig()}
          >
            {saving ? t("workspace.saving") : t("schemes.qq.groupConfig.save")}
          </Button>
        </footer>
      )}
      {preview && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPreview(false);
          }}
        >
          <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("schemes.qq.groupConfig.previewTitle")}</DialogTitle>
              <DialogDescription>{t("schemes.qq.groupConfig.previewNote")}</DialogDescription>
            </DialogHeader>
            <ChangeList changes={changes} schemeNameOf={schemeNameOf} editor={visibleEditor} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setPreview(false)}>
                {t("connections.cancel")}
              </Button>
              <Button
                disabled={saving || invalid || !dirty || conflicted}
                onClick={() => {
                  setPreview(false);
                  void state.saveQqGroupConfig();
                }}
              >
                {t("schemes.qq.groupConfig.save")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {resetAll && (
        <AlertDialog
          title={t("schemes.qq.groupConfig.resetAllTitle")}
          busy={saving}
          onCancel={() => setResetAll(false)}
        >
          <p className="text-sm">{t("schemes.qq.groupConfig.resetAllBody")}</p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              data-dialog-cancel
              disabled={saving}
              onClick={() => setResetAll(false)}
            >
              {t("connections.cancel")}
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                state.patchQqGroupConfigScheme(undefined, "reset");
                setResetAll(false);
              }}
            >
              {t("schemes.qq.groupConfig.resetAllConfirm")}
            </Button>
          </div>
        </AlertDialog>
      )}
      {adminEditorOpen && visibleEditor && (
        <BindingEditor
          conversation={{
            account_id: visibleEditor.source.binding.account_id,
            kind: visibleEditor.source.binding.kind,
            peer_id: visibleEditor.source.binding.peer_id,
            messages: 0,
            last_at_seconds: 0,
            binding_id: visibleEditor.source.binding.id,
          }}
          binding={
            state.qqBindings.find((b) => b.id === visibleEditor.source.binding.id) ??
            visibleEditor.source.binding
          }
          initialSection="administrators"
          onClose={() => setAdminEditorOpen(false)}
        />
      )}
    </section>
  );
}
