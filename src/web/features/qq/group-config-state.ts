// 本群配置编辑草稿：相对基础方案的逐字段稀疏改写 + 本群停用的系统能力。
//
// 不变量：进 overrides 的字段一律是显式自定义——与基线同值（含 false/0/空集合）也算，取消只有
// undefined 一条路；非法输入原文进 rawTexts 并拦住保存；保存是一次三段比较交换；显式刷新按
// "本地改没改过"三路合并（没改跟新答案、改过含删除保留），绑定身份变化只保旧草稿并标记冲突。

import type { QqBindingResponse, QqSchemeResponse } from "../../../shared/contracts/qq";
import {
  mergeQqGroupScheme,
  type QqGroupCapability,
  type QqGroupConfigResponse,
  type QqGroupSchemeOverrides,
  QqGroupSchemeOverridesSchema,
  type UpdateQqGroupConfigRequest,
} from "../../../shared/contracts/qq-group-config";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";

export type QqGroupConfigGroupKey =
  | "triggers"
  | "rhythm"
  | "context"
  | "compression"
  | "output_reserve"
  | "stickers"
  | "sticker_collections"
  | "prompts"
  | "reply";

/**
 * 一次编辑传入的值：开关传 boolean；数字字段传输入框原文（非法进 rawTexts，保存被拦）；
 * 集合传 id 数组；提示词传文本。`undefined`＝取消该字段的自定义（回到跟随基线）；
 * 传错类型一律忽略，不写入半截状态。
 */
export type QqGroupConfigPatchValue = string | boolean | readonly string[] | undefined;

export interface QqGroupConfigEditor {
  /** 最近一次读取/保存的服务端答案，保存基线的唯一来源。 */
  source: QqGroupConfigResponse;
  /** 稀疏改写：只有显式自定义的字段在这里；空组不保留；退役字段永不写入。 */
  overrides: QqGroupSchemeOverrides;
  /** 非法输入原文（`group.field` → 输入框原文，原样不 trim）：保存前必须先修正，刷新/切页都不丢。 */
  rawTexts: Record<string, string>;
  /** 本群停用的能力；与 source.disabled_capabilities 的差集就是未保存的能力改动。 */
  disabledCapabilities: QqGroupCapability[];
  /** 待切换的基础方案；与当前基线相同＝没有待办。 */
  schemeId?: string;
  /** 换基线时已选的处置：keep 保留本群自定义，reset 全部跟随新方案。确认前不写入。 */
  schemeChange?: "keep" | "reset";
  /** reset 预览清空前的上一份自定义与非法原文：取消待办或改选 keep 时原样还原。 */
  previousOverrides?: QqGroupSchemeOverrides;
  previousRawTexts?: Record<string, string>;
  /** 显式刷新发现绑定身份（Agent/账号/会话）已变：草稿与旧基线原样保留，等待重新打开。 */
  identityConflict?: boolean;
}

export const qqGroupConfigInitial = {
  qqGroupConfigEditor: null as QqGroupConfigEditor | null,
  /** 本群配置页当前指向的绑定 id：页面参数稳定（保存/刷新期间不抖动），失败后仍可原位重试。 */
  qqGroupConfigBindingId: null as string | null,
  qqGroupConfigLoading: false,
  qqGroupConfigSaving: false,
  /** 读取代次：晚到的旧读取不得覆盖更新的读取。 */
  qqGroupConfigReadId: 0,
  /** 写入代次：旧操作的响应/错误/finally 据此判定自己是否已被替换。 */
  qqGroupConfigOperationId: 0,
};

export interface QqGroupConfigState {
  qqGroupConfigEditor: QqGroupConfigEditor | null;
  qqGroupConfigBindingId: string | null;
  qqGroupConfigLoading: boolean;
  qqGroupConfigSaving: boolean;
  qqGroupConfigReadId: number;
  qqGroupConfigOperationId: number;
  /** 同身份重复打开不重读；目录同一 id 已换 Agent 时干净才重读，脏草稿保留并标记冲突。 */
  selectQqGroupConfig: (bindingId: string) => Promise<boolean>;
  /** 显式刷新保存基线：重读后按"本地改没改过"合并，不提交草稿，不自动重试保存。 */
  refreshQqGroupConfig: () => Promise<boolean>;
  patchQqGroupOverride: (
    group: QqGroupConfigGroupKey,
    name: string,
    value: QqGroupConfigPatchValue,
  ) => void;
  setQqGroupCapability: (capability: QqGroupCapability, disabled: boolean) => void;
  /** 换基础方案：undefined＝取消待办并还原 reset 预览前的草稿；reset＝本群自定义全部跟随（能力停用不重置；同基线的 reset 直接清空不留还原）。 */
  patchQqGroupConfigScheme: (schemeId: string | undefined, change?: "keep" | "reset") => void;
  /** 只提交本群：一次 PUT 带三段 revision 与稀疏改写；无改动不发 PUT；409 保稿。 */
  saveQqGroupConfig: () => Promise<boolean>;
  /** 放弃本群草稿：全部回到基线（含非法原文），不触碰其他资料草稿。 */
  discardQqGroupConfigChanges: () => void;
  /** 另一处保存了本群绑定后，只有「仅 paused 前进」的已知写结果才推进本编辑基线；其余留给 CAS 如实冲突。 */
  syncQqGroupConfigBinding: (binding: QqBindingResponse) => void;
}

/** 退役控件不参与覆盖；契约也不会带出它们。 */
const RETIRED_OVERRIDE_FIELDS = new Set([
  "rhythm.judgement_interval_turns",
  "context.reply_message_limit",
]);

/** 稀疏改写按组存取；进出各转一次，组名/字段名仍由契约约束。 */
type OverridesBag = Record<string, Record<string, unknown>>;
const bagOf = (overrides: QqGroupSchemeOverrides): OverridesBag =>
  overrides as unknown as OverridesBag;
const overridesOf = (bag: OverridesBag): QqGroupSchemeOverrides =>
  bag as unknown as QqGroupSchemeOverrides;

const baseGroupOf = (scheme: QqSchemeResponse, group: string): Record<string, unknown> | null => {
  const value = (scheme as unknown as Record<string, unknown>)[group];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
};

/** 数组按集合比较（集合字段与顺序无关）；其余严格相等。 */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    const left = a.map(String).sort();
    const right = b.map(String).sort();
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return a === b;
};

/** 预览用的中性文本：布尔读 `true`/`false`，数组读顿号连接，其余 String()。 */
const valueText = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).sort().join("、") : String(value);

/** 装配冗余在界面上是百分比（存储是 0–0.5 的比例，与方案页同一换算）。 */
const changeValueText = (group: string, name: string, value: unknown): string =>
  group === "compression" && name === "headroom_ratio" && typeof value === "number"
    ? `${Number((value * 100).toFixed(2))}%`
    : valueText(value);

const copyValue = (value: unknown): unknown => (Array.isArray(value) ? [...value] : value);

/** 只保留基础方案里存在且未退役的字段；空组不保留（稀疏）。 */
function sanitizeOverrides(
  overrides: QqGroupSchemeOverrides,
  scheme: QqSchemeResponse,
): QqGroupSchemeOverrides {
  const bag = bagOf(overrides);
  const next: OverridesBag = {};
  for (const [group, fields] of Object.entries(bag)) {
    if (!fields || typeof fields !== "object") continue;
    const base = baseGroupOf(scheme, group);
    if (!base) continue;
    const copied: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (RETIRED_OVERRIDE_FIELDS.has(`${group}.${name}`)) continue;
      if (!(name in base)) continue;
      copied[name] = copyValue(value);
    }
    if (Object.keys(copied).length) next[group] = copied;
  }
  return overridesOf(next);
}

function withOverride(
  overrides: QqGroupSchemeOverrides,
  group: string,
  name: string,
  value: unknown,
): QqGroupSchemeOverrides {
  const bag = bagOf(overrides);
  const next: OverridesBag = { ...bag, [group]: { ...(bag[group] ?? {}), [name]: value } };
  return overridesOf(next);
}

function withoutOverride(
  overrides: QqGroupSchemeOverrides,
  group: string,
  name: string,
): QqGroupSchemeOverrides {
  const bag = bagOf(overrides);
  const fields = bag[group];
  if (!fields || !(name in fields)) return overrides;
  const rest = { ...fields };
  delete rest[name];
  const next: OverridesBag = { ...bag };
  if (Object.keys(rest).length) next[group] = rest;
  else delete next[group];
  return overridesOf(next);
}

function withoutRaw(rawTexts: Record<string, string>, key: string): Record<string, string> {
  if (!(key in rawTexts)) return rawTexts;
  const { [key]: _fixed, ...rest } = rawTexts;
  return rest;
}

/** 素材集合是组级整体替换字段，不是一个可合并成员。 */
function withGroup(
  overrides: QqGroupSchemeOverrides,
  group: string,
  value: Record<string, unknown>,
): QqGroupSchemeOverrides {
  return overridesOf({ ...bagOf(overrides), [group]: value });
}

function withoutGroup(overrides: QqGroupSchemeOverrides, group: string): QqGroupSchemeOverrides {
  const bag = bagOf(overrides);
  if (!(group in bag)) return overrides;
  const next = { ...bag };
  delete next[group];
  return overridesOf(next);
}

/** 除素材集合（整体替换、可省略）以外的差异组；单字段候选过 schema 时用空组占位。 */
const OVERRIDE_GROUPS = [
  "triggers",
  "rhythm",
  "context",
  "compression",
  "output_reserve",
  "stickers",
  "prompts",
  "reply",
] as const;

/**
 * 单字段候选过共享契约（不自抄边界数值）：只放这一个字段，其余组空占位——空组本身就是合法输入，
 * 归一化时会被去掉，不会污染结果；失败即该字段非法，成功取归一化后的值。
 */
function parseOverrideField(
  group: string,
  name: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  const candidate: Record<string, unknown> = {};
  for (const key of OVERRIDE_GROUPS) candidate[key] = {};
  candidate[group] = { [name]: value };
  const parsed = QqGroupSchemeOverridesSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false };
  const field = (parsed.data as unknown as OverridesBag)[group]?.[name];
  return { ok: true, value: field === undefined ? value : field };
}

export function qqGroupConfigEditorFrom(response: QqGroupConfigResponse): QqGroupConfigEditor {
  return {
    source: response,
    overrides: sanitizeOverrides(response.overrides, response.base_scheme),
    rawTexts: {},
    disabledCapabilities: [...response.disabled_capabilities],
  };
}

/**
 * 本群生效值 = 基础方案 + 本群稀疏改写（与 shared 的合并规则同一份）。
 * 待切换基础方案时传入目标方案（按 schemeId 匹配），预览和保存的目标一致；source 基线不推进。
 */
export const qqGroupConfigEffectiveScheme = (
  editor: QqGroupConfigEditor | null,
  targetScheme?: QqSchemeResponse,
): QqSchemeResponse | null => {
  if (!editor) return null;
  const pending = editor.schemeId;
  const scheme =
    pending !== undefined && targetScheme?.id === pending
      ? targetScheme
      : editor.source.base_scheme;
  return mergeQqGroupScheme(scheme, editor.overrides);
};

export type QqGroupConfigChange =
  | {
      readonly kind: "override";
      readonly group: QqGroupConfigGroupKey;
      readonly field: string;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: "raw";
      readonly group: QqGroupConfigGroupKey;
      readonly field: string;
      readonly raw: string;
    }
  | {
      readonly kind: "capability";
      readonly capability: QqGroupCapability;
      readonly disabled: boolean;
    }
  | {
      readonly kind: "scheme";
      readonly schemeId: string;
      readonly schemeName: string;
      readonly reset: boolean;
    };

/**
 * 一次保存真正会写下的差异：字段的存在性与值一起比——钉住（含与基线同值）和取消钉住都是改动，
 * 只有两边"是否钉住"与数值都相同才跳过。行的值按生效值显示（未钉住时是基线值）；非法原文另有
 * raw 行（保存前必须先修正）；能力停用列相对记录的差集；方案行由调用方给出名字。
 */
export function qqGroupConfigChanges(
  editor: QqGroupConfigEditor | null,
  schemeName?: (id: string) => string | undefined,
): readonly QqGroupConfigChange[] {
  if (!editor) return [];
  const changes: QqGroupConfigChange[] = [];
  const localBag = bagOf(editor.overrides);
  const recordBag = bagOf(sanitizeOverrides(editor.source.overrides, editor.source.base_scheme));
  const base = editor.source.base_scheme;
  for (const group of new Set([...Object.keys(recordBag), ...Object.keys(localBag)])) {
    const groupBase = baseGroupOf(base, group);
    if (!groupBase) continue;
    const recordFields = recordBag[group] ?? {};
    const localFields = localBag[group] ?? {};
    for (const name of new Set([...Object.keys(recordFields), ...Object.keys(localFields)])) {
      if (!(name in groupBase)) continue;
      // 非法原文的字段由 raw 行呈现（且保存被拦）；不再叠一条数值行。
      if (`${group}.${name}` in editor.rawTexts) continue;
      const recorded = name in recordFields;
      const pinned = name in localFields;
      if (recorded === pinned && (!recorded || sameValue(recordFields[name], localFields[name])))
        continue;
      const before = recorded ? recordFields[name] : groupBase[name];
      const after = pinned ? localFields[name] : groupBase[name];
      changes.push({
        kind: "override",
        group: group as QqGroupConfigGroupKey,
        field: name,
        before: changeValueText(group, name, before),
        after: changeValueText(group, name, after),
      });
    }
  }
  for (const [key, raw] of Object.entries(editor.rawTexts)) {
    const [group, ...rest] = key.split(".");
    changes.push({
      kind: "raw",
      group: group as QqGroupConfigGroupKey,
      field: rest.join("."),
      raw,
    });
  }
  for (const capability of editor.disabledCapabilities)
    if (!editor.source.disabled_capabilities.includes(capability))
      changes.push({ kind: "capability", capability, disabled: true });
  for (const capability of editor.source.disabled_capabilities)
    if (!editor.disabledCapabilities.includes(capability))
      changes.push({ kind: "capability", capability, disabled: false });
  if (editor.schemeId !== undefined && editor.schemeId !== editor.source.base_scheme.id) {
    changes.push({
      kind: "scheme",
      schemeId: editor.schemeId,
      schemeName: schemeName?.(editor.schemeId) ?? editor.schemeId,
      reset: editor.schemeChange === "reset",
    });
  }
  return changes;
}

export function qqGroupConfigDirty(editor: QqGroupConfigEditor | null): boolean {
  return qqGroupConfigChanges(editor).length > 0;
}

/** 非法输入未修正前不允许保存（统一保存与页内保存共用同一条判定）。 */
export function qqGroupConfigHasInvalidInputs(editor: QqGroupConfigEditor | null): boolean {
  return !!editor && Object.keys(editor.rawTexts).length > 0;
}

function patchOverrideFields(
  editor: QqGroupConfigEditor,
  group: QqGroupConfigGroupKey,
  name: string,
  value: QqGroupConfigPatchValue,
): QqGroupConfigEditor {
  const key = `${group}.${name}`;
  if (RETIRED_OVERRIDE_FIELDS.has(key)) return editor;
  const base = baseGroupOf(editor.source.base_scheme, group);
  if (!base || !(name in base)) return editor;
  if (group === "sticker_collections") {
    if (value === undefined)
      return {
        ...editor,
        overrides: withoutGroup(editor.overrides, group),
        rawTexts: withoutRaw(editor.rawTexts, key),
      };
    if (!Array.isArray(value)) return editor;
    const parsed = parseOverrideField(group, name, [...value]);
    if (!parsed.ok || !Array.isArray(parsed.value)) return editor;
    return {
      ...editor,
      overrides: withGroup(editor.overrides, group, { collection_ids: [...parsed.value] }),
      rawTexts: withoutRaw(editor.rawTexts, key),
    };
  }
  if (value === undefined)
    return {
      ...editor,
      overrides: withoutOverride(editor.overrides, group, name),
      rawTexts: withoutRaw(editor.rawTexts, key),
    };
  const baseValue = base[name];
  let candidate: unknown;
  if (typeof baseValue === "boolean") {
    if (typeof value !== "boolean") return editor;
    candidate = value;
  } else if (typeof baseValue === "number") {
    if (typeof value !== "string") return editor;
    // 原文原样留底（不 trim）：空串/非有限数直接按非法原文处理；其余交给共享契约判边界与整数性。
    const text = value;
    const trimmed = text.trim();
    const numeric = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(numeric)) {
      return {
        ...editor,
        overrides: withoutOverride(editor.overrides, group, name),
        rawTexts: { ...editor.rawTexts, [key]: text },
      };
    }
    // 百分比输入须为整数，比例存储契约本身没有这个界面约束。
    if (key === "compression.headroom_ratio" && !Number.isInteger(numeric)) {
      return {
        ...editor,
        overrides: withoutOverride(editor.overrides, group, name),
        rawTexts: { ...editor.rawTexts, [key]: text },
      };
    }
    candidate = key === "compression.headroom_ratio" ? numeric / 100 : numeric;
  } else if (typeof baseValue === "string") {
    if (typeof value !== "string") return editor;
    candidate = value;
  } else return editor;
  const parsed = parseOverrideField(group, name, candidate);
  if (!parsed.ok) {
    // 契约拒绝的输入（越界、非整数、空白提示词等）不写半截值：只留原文，保存被拦。
    return {
      ...editor,
      overrides: withoutOverride(editor.overrides, group, name),
      rawTexts: { ...editor.rawTexts, [key]: typeof value === "string" ? value : valueText(value) },
    };
  }
  return {
    ...editor,
    overrides: withOverride(editor.overrides, group, name, parsed.value),
    rawTexts: withoutRaw(editor.rawTexts, key),
  };
}

/** 绑定身份四元组：它们一变，这就不再是同一份草稿的保存对象。 */
const sameBindingIdentity = (a: QqBindingResponse, b: QqBindingResponse): boolean =>
  a.agent_id === b.agent_id &&
  a.account_id === b.account_id &&
  a.kind === b.kind &&
  a.peer_id === b.peer_id;

/** 除 paused 与 revision 外逐字段等价：只有这种写结果才敢当作「已知的暂停写」推进基线。 */
const sameBindingExceptPause = (a: QqBindingResponse, b: QqBindingResponse): boolean =>
  a.account_id === b.account_id &&
  a.kind === b.kind &&
  a.peer_id === b.peer_id &&
  a.share_web_memory === b.share_web_memory &&
  a.memory_batch_size === b.memory_batch_size &&
  a.pending_observations === b.pending_observations &&
  a.authority_revision === b.authority_revision &&
  a.triggers.direct_reply === b.triggers.direct_reply &&
  a.triggers.follow_up === b.triggers.follow_up &&
  a.triggers.chiming_in === b.triggers.chiming_in &&
  a.triggers.idle_topic === b.triggers.idle_topic &&
  a.attention.mode === b.attention.mode &&
  sameValue(a.attention.members, b.attention.members);

/**
 * 显式刷新的三路合并，基线＝打开或上次刷新时的记录（editor.source.overrides）：
 * 没动过的字段跟随最新答案（含对方新增/取消的钉住），动过（含删除）的保留，非法原文保留。
 * 绑定身份（Agent/账号/会话）变化时不合并也不换基线：保留旧草稿并标记 identityConflict，
 * 绝不把旧草稿的基线换成新的身份。能力停用按既有的"用户已改方向"合并。
 */
export function mergeQqGroupConfigEditor(
  editor: QqGroupConfigEditor,
  fresh: QqGroupConfigResponse,
): QqGroupConfigEditor {
  if (!sameBindingIdentity(editor.source.binding, fresh.binding))
    return { ...editor, identityConflict: true };
  const recordBag = bagOf(sanitizeOverrides(editor.source.overrides, editor.source.base_scheme));
  const localBag = bagOf(editor.overrides);
  const freshBag = bagOf(sanitizeOverrides(fresh.overrides, fresh.base_scheme));
  const next: OverridesBag = {};
  const groups = new Set([
    ...Object.keys(recordBag),
    ...Object.keys(localBag),
    ...Object.keys(freshBag),
  ]);
  for (const group of groups) {
    const base = baseGroupOf(fresh.base_scheme, group);
    if (!base) continue;
    const recordFields = recordBag[group] ?? {};
    const localFields = localBag[group] ?? {};
    const freshFields = freshBag[group] ?? {};
    for (const name of new Set([
      ...Object.keys(recordFields),
      ...Object.keys(localFields),
      ...Object.keys(freshFields),
    ])) {
      if (!(name in base) || RETIRED_OVERRIDE_FIELDS.has(`${group}.${name}`)) continue;
      const localChanged =
        name in recordFields !== name in localFields ||
        (name in recordFields && !sameValue(recordFields[name], localFields[name]));
      const takeFrom = localChanged ? localFields : freshFields;
      if (name in takeFrom)
        next[group] = { ...(next[group] ?? {}), [name]: copyValue(takeFrom[name]) };
    }
  }
  const userDisabled = editor.disabledCapabilities.filter(
    (capability) => !editor.source.disabled_capabilities.includes(capability),
  );
  const userEnabled = editor.source.disabled_capabilities.filter(
    (capability) => !editor.disabledCapabilities.includes(capability),
  );
  return {
    source: fresh,
    overrides: overridesOf(next),
    rawTexts: { ...editor.rawTexts },
    disabledCapabilities: [
      ...new Set([
        ...fresh.disabled_capabilities.filter((capability) => !userEnabled.includes(capability)),
        ...userDisabled,
      ]),
    ],
    schemeId: editor.schemeId,
    schemeChange: editor.schemeChange,
    previousOverrides: editor.previousOverrides,
    previousRawTexts: editor.previousRawTexts,
  };
}

export function createQqGroupConfigActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  QqGroupConfigState,
  | "selectQqGroupConfig"
  | "refreshQqGroupConfig"
  | "patchQqGroupOverride"
  | "setQqGroupCapability"
  | "patchQqGroupConfigScheme"
  | "saveQqGroupConfig"
  | "discardQqGroupConfigChanges"
  | "syncQqGroupConfigBinding"
> {
  const report = (error: unknown) => set({ error: errorText(error), feedback: "" });
  // 模块级令牌（与方案/访问模块同一模式）：`resetForTests` 会把 store 里的代次清零，
  // 单靠代次无法区分「重置后新操作恰好拿到同一编号」；令牌不随重置回收。
  let readToken = 0;
  let operationToken = 0;
  const beginRead = () => {
    const state = get();
    readToken += 1;
    const operation = {
      api: state.apiClient,
      id: state.qqGroupConfigReadId + 1,
      token: readToken,
    };
    set({
      qqGroupConfigReadId: operation.id,
      qqGroupConfigLoading: true,
      error: null,
    });
    return operation;
  };
  const isCurrentRead = (operation: ReturnType<typeof beginRead>) =>
    get().qqGroupConfigReadId === operation.id && readToken === operation.token;
  const isCurrentReadApi = (operation: ReturnType<typeof beginRead>) =>
    get().apiClient === operation.api && isCurrentRead(operation);
  const beginOperation = () => {
    const state = get();
    operationToken += 1;
    const operation = {
      api: state.apiClient,
      editor: state.qqGroupConfigEditor,
      id: state.qqGroupConfigOperationId + 1,
      token: operationToken,
    };
    set({
      qqGroupConfigSaving: true,
      qqGroupConfigOperationId: operation.id,
      // 变更开始即作废在途读取：旧答案晚到不得覆盖刚写入的结果，也不留悬空的 loading。
      qqGroupConfigReadId: state.qqGroupConfigReadId + 1,
      qqGroupConfigLoading: false,
      error: null,
      feedback: "",
    });
    return operation;
  };
  const isCurrentOperation = (operation: ReturnType<typeof beginOperation>) =>
    get().qqGroupConfigOperationId === operation.id && operationToken === operation.token;
  const isCurrentApi = (operation: ReturnType<typeof beginOperation>) =>
    get().apiClient === operation.api && isCurrentOperation(operation);
  return {
    selectQqGroupConfig: async (bindingId) => {
      const state = get();
      if (state.qqGroupConfigSaving) return false;
      // 同一群不隐式重读：编辑器就是草稿，重读会推进脏基线（显式刷新才合并）。
      const editor = state.qqGroupConfigEditor;
      if (
        state.qqGroupConfigBindingId === bindingId &&
        editor !== null &&
        editor.source.binding.id === bindingId
      ) {
        const catalogAgent = state.qqBindingsLoaded
          ? state.qqBindings.find((row) => row.id === bindingId)?.agent_id
          : undefined;
        // 同一 id 在目录里已换 Agent：脏草稿保留并标记冲突，绝不隐式把基线读成新身份；干净才重读。
        if (catalogAgent === undefined || catalogAgent === editor.source.binding.agent_id)
          return true;
        if (qqGroupConfigDirty(editor)) {
          set({ qqGroupConfigEditor: { ...editor, identityConflict: true } });
          return false;
        }
      }
      set({ qqGroupConfigBindingId: bindingId });
      const operation = beginRead();
      try {
        const fresh = await operation.api.getQqGroupConfig(bindingId);
        if (!isCurrentReadApi(operation)) return false;
        set({
          qqGroupConfigEditor: qqGroupConfigEditorFrom(fresh),
          qqGroupConfigLoading: false,
        });
        return true;
      } catch (error) {
        if (isCurrentReadApi(operation)) {
          // 打开别的群失败：不把上一群的编辑器留给这一群显示，失败态由绑定 id + error 呈现。
          const current = get().qqGroupConfigEditor;
          set({
            error: errorText(error),
            feedback: "",
            qqGroupConfigEditor: current?.source.binding.id === bindingId ? current : null,
          });
        }
        return false;
      } finally {
        if (isCurrentRead(operation)) set({ qqGroupConfigLoading: false });
      }
    },
    refreshQqGroupConfig: async () => {
      const state = get();
      const bindingId =
        state.qqGroupConfigBindingId ?? state.qqGroupConfigEditor?.source.binding.id;
      if (!bindingId || state.qqGroupConfigSaving) return false;
      const wasDirty = qqGroupConfigDirty(state.qqGroupConfigEditor);
      const operation = beginRead();
      try {
        const fresh = await operation.api.getQqGroupConfig(bindingId);
        if (!isCurrentReadApi(operation)) return false;
        set((current) => {
          const editor = current.qqGroupConfigEditor;
          if (!editor || editor.source.binding.id !== fresh.binding.id)
            return {
              qqGroupConfigEditor: qqGroupConfigEditorFrom(fresh),
              qqGroupConfigLoading: false,
            };
          const merged = mergeQqGroupConfigEditor(editor, fresh);
          return {
            qqGroupConfigEditor: merged,
            qqGroupConfigLoading: false,
            ...(wasDirty || merged.identityConflict
              ? { feedback: msg("刷新不提交草稿；冲突后请核对最新值再保存。") }
              : {}),
          };
        });
        return true;
      } catch (error) {
        if (isCurrentReadApi(operation)) report(error);
        return false;
      } finally {
        if (isCurrentRead(operation)) set({ qqGroupConfigLoading: false });
      }
    },
    patchQqGroupOverride: (group, name, value) => {
      if (get().qqGroupConfigSaving) return;
      set((state) => {
        const editor = state.qqGroupConfigEditor;
        if (!editor) return {};
        const next = patchOverrideFields(editor, group, name, value);
        // reset 预览已清空旧 body：此后新增的字段改写改按 keep 保存，新字段不会被 reset 语义丢掉。
        if (
          next.overrides !== editor.overrides &&
          editor.schemeId !== undefined &&
          editor.schemeChange === "reset"
        )
          return {
            qqGroupConfigEditor: {
              ...next,
              schemeChange: "keep",
              previousOverrides: undefined,
              previousRawTexts: undefined,
            },
          };
        return { qqGroupConfigEditor: next };
      });
    },
    setQqGroupCapability: (capability, disabled) => {
      if (get().qqGroupConfigSaving) return;
      set((state) => {
        const editor = state.qqGroupConfigEditor;
        if (!editor) return {};
        const next = new Set(editor.disabledCapabilities);
        if (disabled) next.add(capability);
        else next.delete(capability);
        const base = editor.source.disabled_capabilities;
        // 保持基线顺序在前：停用再启用回到与基线一致时天然不是草稿。
        return {
          qqGroupConfigEditor: {
            ...editor,
            disabledCapabilities: [
              ...base.filter((item) => next.has(item)),
              ...[...next].filter((item) => !base.includes(item)),
            ],
          },
        };
      });
    },
    patchQqGroupConfigScheme: (schemeId, change = "keep") => {
      if (get().qqGroupConfigSaving) return;
      set((state) => {
        const editor = state.qqGroupConfigEditor;
        if (!editor) return {};
        const baseId = editor.source.base_scheme.id;
        if (schemeId === undefined || schemeId === baseId)
          // 目标就是当前基线：reset＝明确「全部跟随」直接清空（不留还原）；keep＝取消待办并还原预览前草稿。
          return {
            qqGroupConfigEditor: {
              ...editor,
              schemeId: undefined,
              schemeChange: undefined,
              ...(change === "reset"
                ? { overrides: overridesOf({}), rawTexts: {} }
                : {
                    overrides: editor.previousOverrides ?? editor.overrides,
                    rawTexts: editor.previousRawTexts ?? editor.rawTexts,
                  }),
              previousOverrides: undefined,
              previousRawTexts: undefined,
            },
          };
        if (change === "reset")
          return {
            qqGroupConfigEditor: {
              ...editor,
              schemeId,
              schemeChange: "reset",
              // 首次清空前留底；连续换目标不覆盖首次留底，取消时回到最初的草稿。
              previousOverrides: editor.previousOverrides ?? editor.overrides,
              previousRawTexts: editor.previousRawTexts ?? editor.rawTexts,
              overrides: overridesOf({}),
              rawTexts: {},
            },
          };
        return {
          qqGroupConfigEditor: {
            ...editor,
            schemeId,
            schemeChange: "keep",
            // 改选 keep：还原 reset 预览清空的草稿，只留下「换目标」这一件待办。
            overrides: editor.previousOverrides ?? editor.overrides,
            rawTexts: editor.previousRawTexts ?? editor.rawTexts,
            previousOverrides: undefined,
            previousRawTexts: undefined,
          },
        };
      });
    },
    saveQqGroupConfig: async () => {
      const state = get();
      const editor = state.qqGroupConfigEditor;
      if (!editor || state.qqGroupConfigSaving) return false;
      if (qqGroupConfigHasInvalidInputs(editor)) {
        set({ error: msg("请先修正方案中的无效数字，再保存。"), feedback: "" });
        return false;
      }
      // 与其它草稿保存同一习惯：没有改动就不发空 PUT，也不动任何基线。
      if (!qqGroupConfigDirty(editor)) return true;
      const switching =
        editor.schemeId !== undefined && editor.schemeId !== editor.source.base_scheme.id;
      let expectedSchemeRevision = editor.source.base_scheme.revision;
      if (switching) {
        // expected_scheme_revision 指目标基线：换基线时是目标方案的 revision，不是旧基线的。
        const target = state.qqSchemes.find((row) => row.id === editor.schemeId);
        if (!target) {
          set({ error: msg("操作失败，请重试。"), feedback: "" });
          return false;
        }
        expectedSchemeRevision = target.revision;
      }
      const input: UpdateQqGroupConfigRequest = {
        // Agent 身份取自打开时的绑定快照：绑定被改绑后这里仍是旧 Agent，服务端据此判冲突。
        agent_id: editor.source.binding.agent_id,
        expected_binding_revision: editor.source.binding.revision,
        expected_scheme_revision: expectedSchemeRevision,
        expected_revision: editor.source.revision,
        // 稀疏提交：只带显式自定义的组，不补空组骨架（契约按组可选、空组会被归一化掉）。
        overrides: editor.overrides,
        disabled_capabilities: [...editor.disabledCapabilities],
        ...(switching
          ? { scheme_id: editor.schemeId as string, scheme_change: editor.schemeChange ?? "keep" }
          : {}),
      };
      const operation = beginOperation();
      try {
        const saved = await operation.api.saveQqGroupConfig(editor.source.binding.id, input);
        if (!isCurrentApi(operation)) return false;
        set((current) => ({
          // 保存成功的行进入绑定目录：卡片与「使用会话」不继续显示旧 revision/旧方案。
          qqBindings: current.qqBindings.map((row) =>
            row.id === saved.binding.id ? saved.binding : row,
          ),
          feedback: msg("已保存"),
          // 响应晚到且编辑器已被替换（含切到别的群）：只更新目录行，不覆盖新会话的草稿。
          ...(current.qqGroupConfigEditor === editor
            ? { qqGroupConfigEditor: qqGroupConfigEditorFrom(saved) }
            : {}),
        }));
        return true;
      } catch (error) {
        if (isCurrentApi(operation)) report(error);
        return false;
      } finally {
        if (isCurrentOperation(operation)) set({ qqGroupConfigSaving: false });
      }
    },
    discardQqGroupConfigChanges: () => {
      set((state) => {
        const editor = state.qqGroupConfigEditor;
        if (!editor) return {};
        const rebuilt = qqGroupConfigEditorFrom(editor.source);
        return {
          // 冲突标记描述的是旧基线本身，放弃草稿并不能让它变新。
          qqGroupConfigEditor: editor.identityConflict
            ? { ...rebuilt, identityConflict: true }
            : rebuilt,
          error: null,
          feedback: "",
        };
      });
    },
    syncQqGroupConfigBinding: (binding) => {
      set((state) => {
        // 保存进行中：基线属于在途请求，任何推进都会让编辑器的 CAS 与请求脱节。
        if (state.qqGroupConfigSaving) return {};
        const editor = state.qqGroupConfigEditor;
        if (!editor) return {};
        const snapshot = editor.source.binding;
        // 只认「同一行、同一 Agent、同一方案、revision 前进、且除 paused 外逐字段等价」的已知写结果
        // （即时启停）；触发条件等任一字段变了就不推进基线，让旧编辑按 CAS 如实冲突，由用户显式刷新。
        if (
          snapshot.id !== binding.id ||
          snapshot.agent_id !== binding.agent_id ||
          snapshot.scheme_id !== binding.scheme_id ||
          binding.revision < snapshot.revision ||
          !sameBindingExceptPause(snapshot, binding)
        )
          return {};
        return {
          qqGroupConfigEditor: { ...editor, source: { ...editor.source, binding } },
        };
      });
    },
  };
}
