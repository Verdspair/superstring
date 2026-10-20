import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "../../components/form-field";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import type { QqGroupConfigEditor } from "../../features/qq/group-config-state";
import { useQqInput } from "../../features/qq/use-qq-input";
import { useSuperstringStore } from "../../store";
import {
  fieldBounds,
  headroomPercentBounds,
  type NumberEditorGroup,
  numberEditorGroups,
} from "./scheme-fields";

export type OverridesBag = Record<string, Record<string, unknown>>;
export const bagOf = (editor: QqGroupConfigEditor): OverridesBag =>
  editor.overrides as unknown as OverridesBag;

/**
 * 显式自定义＝该字段在稀疏差异里（值可能是 false/0/null/空集合，仍是实打实的钉住）。
 * 0052 嵌套 stages：字段名是 `stages.<phase>` 点路径时，真实位置在 `media_input.stages.<phase>`。
 */
export function overrideOf(editor: QqGroupConfigEditor, group: string, name: string) {
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

export const NUMERIC_GROUP: Record<
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

export const numberSchemaOf = (group: NumberEditorGroup, name: string) =>
  (
    numberEditorGroups[group].shape as Record<
      string,
      { safeParse: (value: unknown) => { success: boolean } } | undefined
    >
  )[name];

/** 装配冗余在界面上是整数百分比（存储是 0–0.5 的比例，与方案页同一换算）。 */
export const percentText = (ratio: number) => `${Number((ratio * 100).toFixed(2))}%`;
export const percentInputText = (ratio: number) => String(Number((ratio * 100).toFixed(2)));

/**
 * 字段状态行：显式跟随 / 显式钉住（与基线同值也是钉住）；钉住从当前基线值初始化，
 * 基线还没读到时不提供钉住入口。
 */
export function FieldState({
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
export function NumberField({
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
    <Field
      label={labelKey}
      info={infoKey}
      tooltip={infoKey ? t(infoKey) : t(`hints.qqNumber.${group}.${name}`)}
    >
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

/**
 * 数字输入：原文留在草稿里，只有契约 schema 认可的值才写回方案；无效原文不丢弃、保存被禁用。
 * min/max/step 现读契约（fieldBounds），浏览器拦下的范围就是服务端会拒绝的范围；
 * 错误用 aria-describedby 挂在同一个输入上，另有页脚的「定位」按钮把焦点送回这里。
 * 0052 的两组编辑器组同样走这里（messageSettings/mediaInput），canonical 键保持 message_settings.<key>。
 */
export function SchemeNumber({
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
    <Field
      label={label}
      info={info}
      tooltip={info ? t(info) : t(`hints.qqNumber.${group}.${name}`)}
    >
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

/** 装配冗余在界面上是整数百分比，存的是比例（5 ↔ 0.05）；边界同样来自契约（0–50）。 */
export function SchemePercent({
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
    <Field label={label} info={info} tooltip={t(info)}>
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
