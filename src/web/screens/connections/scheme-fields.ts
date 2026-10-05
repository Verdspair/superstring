import type { QqSchemePrompts } from "../../../shared/contracts/qq";
import {
  QqSchemeCompressionSchema,
  QqSchemeContextSchema,
  QqSchemeMediaInputSchema,
  QqSchemeMessageSettingsSchema,
  QqSchemeOutputReserveSchema,
  QqSchemeRhythmSchema,
  QqSchemeStickersSchema,
} from "../../../shared/contracts/qq";
import { imageFields, stickerFields } from "../../features/qq/scheme-field-metadata";

export const numericGroups = {
  rhythm: QqSchemeRhythmSchema,
  context: QqSchemeContextSchema,
  compression: QqSchemeCompressionSchema,
  outputReserve: QqSchemeOutputReserveSchema,
  stickers: QqSchemeStickersSchema,
};
export type NumericGroup = keyof typeof numericGroups;

/** 0052 两个数字组：编辑器组名（camelCase）→ 数字栏的契约 schema。 */
export const numberEditorGroups = {
  ...numericGroups,
  messageSettings: QqSchemeMessageSettingsSchema,
  mediaInput: QqSchemeMediaInputSchema,
} as const;
/** 0052 数字栏所在的编辑器组（与 numericGroups 同一用法；可空长边字段由页面特判 null 原图）。 */
export type NumberEditorGroup = keyof typeof numberEditorGroups;

/** The four editing tasks of the studio; a field's task is also the tab its error is fixed on. */
export type SchemeTask = "participation" | "response" | "context" | "media";

/**
 * 每个数字输入框的 min/max/step 都从契约 schema 现读，不在这里另抄一份边界：
 * schema 改动时输入框跟着变，浏览器拦下的范围就是服务端会拒绝的范围。
 * 0052 的两组编辑器组同样按契约现读；可空字段（普通静图长边）按任务约束用 unwrap
 * 取内层数值 schema 的真实边界（不猜值），由页面特判 null 原图语义。
 */
export function fieldBounds(group: NumberEditorGroup, name: string) {
  const shape = numberEditorGroups[group].shape as Record<
    string,
    | {
        readonly minValue: number | null;
        readonly maxValue: number | null;
        readonly isInt: boolean;
        readonly def?: { readonly type?: string };
        readonly unwrap?: () => unknown;
      }
    | undefined
  >;
  let schema = shape[name];
  // 可空字段（nullable 包装）：解到内层数值 schema 读真实 min/max，不猜值。
  if (
    schema?.def?.type === "nullable" &&
    typeof (schema as { unwrap?: unknown }).unwrap === "function"
  ) {
    schema = (schema as unknown as { unwrap: () => typeof schema }).unwrap();
  }
  return {
    min: schema?.minValue ?? undefined,
    max: schema?.maxValue ?? undefined,
    // 整数契约用 step=1；契约里的小数（目前只有装配冗余的比例）交给百分比栏单独换算。
    step: schema?.isInt === false ? ("any" as const) : 1,
  };
}

/** 装配冗余在界面上是整数百分比；边界由契约的比例边界换算（0–50%）。 */
export function headroomPercentBounds() {
  const { min, max } = fieldBounds("compression", "headroom_ratio");
  return { min: Math.round((min ?? 0) * 100), max: Math.round((max ?? 0.5) * 100), step: 1 };
}

const promptTasks: Record<keyof QqSchemePrompts, SchemeTask> = {
  scene: "response",
  judge: "participation",
  reply: "response",
  review: "response",
  compress: "context",
  sticker: "media",
  media: "media",
};
const mediaRhythmNames = new Set<string>(
  [...stickerFields, ...imageFields]
    .filter(([group]) => group === "rhythm")
    .map(([, name]) => name),
);

/**
 * 一个字段在哪个页签编辑——用来在保存前把无效数字所在的页签先切出来并聚焦。
 * 0052 的两组进既有四 Tab：消息设置归「读取什么」（context），图片输入归「媒体与表达」（media）。
 */
export function schemeFieldTask(field: string): SchemeTask {
  const [group, name] = field.split(".");
  if (group === "message_settings") return "context";
  if (group === "media_input") return "media";
  if (group === "rhythm") return mediaRhythmNames.has(name) ? "media" : "participation";
  if (group === "stickers") return "media";
  if (
    group === "compression" ||
    group === "context" ||
    group === "output_reserve" ||
    group === "outputReserve"
  )
    return "context";
  if (group === "prompts") return promptTasks[name as keyof QqSchemePrompts] ?? "response";
  if (field === "reply.split_by_speaker") return "response";
  if (field === "sticker_collections.collection_ids") return "media";
  return "participation";
}

/** Stored minutes are UTC; editing and previews use the user's local clock. */
export function localClock(minutes: number) {
  const local = (minutes - new Date().getTimezoneOffset() + 1440) % 1440;
  return `${String(Math.floor(local / 60)).padStart(2, "0")}:${String(local % 60).padStart(2, "0")}`;
}
export function utcMinutes(clock: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return (hour * 60 + minute + new Date().getTimezoneOffset() + 1440) % 1440;
}

/** 0052 枚举选项的人话标签（载荷原样存契约值，只改显示）；canonical 键与字段映射同批。 */
/** 时区输入的快捷建议（真实 IANA 名称，输入自由不限于这份列表）。 */
export const TIMEZONE_SUGGESTIONS: readonly string[] = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "UTC",
];

/** 真实 IANA 名称判定：用运行环境自带 ICU，不维护时区表；空串与非法都判否。 */
export function isValidTimezone(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}
