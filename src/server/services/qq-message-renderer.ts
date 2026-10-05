// QQ 消息事实纯渲染（规格 §3/§4.1/§4.2/§5）：resolveQqDisplayName / formatQqTime /
// renderQqMessageFacts 三个纯函数。不读 Date.now、不查 store、不做网络查询：now/timezone
// 来自冻结输入，同一输入永远同输出，可 golden 钉死。输出第 1 行头部注明 now 与 timezone，
// 消息行 `msg=`＋单行 JSON、最后一行 `focus=` 单行 JSON——全部不可信内容经 JSON 单行编码，
// 伪造行头只是数据；focus 与消息行 speaker/replyTo 严格分开（§4.1 第 4 项）。
// hybrid full 集合＝每位发言者（含助手，按发送时 speaker 快照身份）最新一条＋
// focus.responseMessageIds；匿名无 QQ 身份键，按消息身份（message.id）作独立 sender
// 参与最新一条判定，不归并、不编 QQ 号。时间戳仍是原始 UTC 秒，IANA 转换只在本层。

import type {
  QqIdentity,
  QqMessageFact,
  QqMessageFocus,
  QqMessagePart,
  QqMessageSettings,
} from "../../shared/contracts/qq-message";

// ---- 姓名解析（规格 §3.1/§3.2） ----------------------------------------------------------

/**
 * 显示名：trim 后非空的群名片优先，否则 trim 后非空的个人昵称，否则「昵称未知」。
 * `legacyDisplayName` 只在两个现名都缺失且 nameState 为 legacy 时作为历史证据呈现——
 * 它是旧日志里仅存的一份名字，不冒充群名片或个人昵称，也绝不与现名并排成「双昵称」。
 * 匿名永远是「匿名群友」（不编 QQ 号、不归并成一个长期人物）；助手同样只用它自己的
 * 平台快照名，配置人设名不由本函数制造。
 */
export function resolveQqDisplayName(identity: QqIdentity): string {
  if (identity.role === "anonymous") return "匿名群友";
  const card = identity.groupCard?.trim();
  if (card) return card;
  const nickname = identity.personalNickname?.trim();
  if (nickname) return nickname;
  if (identity.nameState === "legacy") {
    const legacy = identity.legacyDisplayName?.trim();
    if (legacy) return legacy;
  }
  return "昵称未知";
}

// ---- 时间（规格 §5） ----------------------------------------------------------------------

/**
 * 按 IANA 时区取 wall-clock 字段。Intl 只负责「这个 UTC 时刻在此时区是几点」这一件事，
 * 时区名不合法直接抛（调用方的 settings 已由契约 schema 验证过）。
 */
function wallClock(
  seconds: number,
  timezone: string,
): {
  year: number;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(seconds * 1000));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  // hour12:false 在部分 ICU 里 0 点写成 "24"；归一成 "00"。
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    year: Number(get("year")),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** 相对时长：过去「N前」、未来「N后」；不出现负数前缀。 */
function relativeLabel(deltaSeconds: number): string {
  const abs = Math.abs(deltaSeconds);
  const suffix = deltaSeconds >= 0 ? "前" : "后";
  if (abs < 60) return `${abs}秒${suffix}`;
  const minutes = Math.floor(abs / 60);
  if (minutes < 60) return `${minutes}分钟${suffix}`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (restMinutes === 0) return `${hours}小时${suffix}`;
  return `${hours}小时${restMinutes}分钟${suffix}`;
}

/**
 * 一条消息的时间字符串。`display`/`timezone`/`nowSeconds` 来自冻结输入；`full` 由调用方
 * （renderQqMessageFacts 的 hybrid full 集合）决定。full_relative 恒为完整＋相对。
 */
export function formatQqTime(
  seconds: number,
  input: {
    nowSeconds: number;
    timezone: string;
    display: QqMessageSettings["time_display"];
    full: boolean;
  },
): string {
  const clock = wallClock(seconds, input.timezone);
  const full = `${clock.year}-${clock.month}-${clock.day} ${clock.hour}:${clock.minute}:${clock.second}`;
  const wantFull = input.display === "full" || input.display === "full_relative" || input.full;
  if (!wantFull) return relativeLabel(input.nowSeconds - seconds);
  if (input.display === "full_relative") {
    return `${full}（${relativeLabel(input.nowSeconds - seconds)}）`;
  }
  return full;
}

// ---- 消息区（规格 §4.1/§4.2） --------------------------------------------------------------

interface RenderedIdentity {
  role: QqIdentity["role"];
  qq: string | null;
  displayName: string;
  nameState: QqIdentity["nameState"];
  currentName?: { groupCard: string | null; personalNickname: string | null };
  legacyDisplayName?: string | null;
}

/**
 * 消息行里的发言人身份。发送时快照（当时名）就是 displayName；currentName 若提供，只作
 * 为单独字段列出——当前映射不回填成当时的名字（规格 §4.5「当前姓名只能另列」）。
 * legacyDisplayName 仅在 nameState=legacy 时保留，标明这是历史证据。
 */
function renderIdentity(identity: QqIdentity): RenderedIdentity {
  const rendered: RenderedIdentity = {
    role: identity.role,
    qq: identity.qq,
    displayName: resolveQqDisplayName(identity),
    nameState: identity.nameState,
  };
  if (identity.nameState === "legacy" && identity.legacyDisplayName !== null) {
    rendered.legacyDisplayName = identity.legacyDisplayName;
  }
  if (identity.currentName !== undefined) {
    rendered.currentName = identity.currentName;
  }
  return rendered;
}

/**
 * 有序片段：@（mention）与 face 保留原位；图像只给存在/分类＋明确的 `read:false` 标记
 * （「未读取」是渲染层能诚实说的全部——没有描述、没有 OCR、不推断已看）；unavailable
 * 是宿主明确标记的不可用段，原样保留。
 */
function renderPart(part: QqMessagePart, identityOf: (qq: string) => QqIdentity | null): unknown {
  switch (part.kind) {
    case "mention":
      return {
        kind: "mention",
        qq: part.qq,
        ...(part.qq === "all" ? {} : { identity: renderIdentityOfNullable(identityOf(part.qq)) }),
      };
    case "image":
      return { kind: "image", mediaId: part.mediaId, category: part.category, read: false };
    default:
      return part;
  }
}

function renderIdentityOfNullable(identity: QqIdentity | null): RenderedIdentity | null {
  return identity === null ? null : renderIdentity(identity);
}

/**
 * 渲染一组消息事实＋本轮焦点。输出为纯文本、按上面文件头的稳定约定组织；全部不可信内容
 * （昵称、正文）经 JSON 单行编码，不产生新的行结构。
 */
export function renderQqMessageFacts(input: {
  messages: readonly QqMessageFact[];
  focus: QqMessageFocus;
  settings: QqMessageSettings;
  nowSeconds: number;
}): string {
  const { settings, nowSeconds, focus } = input;

  // 稳定顺序：先按发生时间，同秒按 seq，再并列按 message.id 二进制字典序决胜（不依赖
  // 输入顺序）；与 latest 判据保持同一排序键——latest 永远取呈现顺序里该 sender 的最后一条。
  const ordered = [...input.messages].sort(
    (a, b) =>
      a.occurredAtSeconds - b.occurredAtSeconds ||
      a.seq - b.seq ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const senderKeyOf = (message: QqMessageFact): string =>
    message.speaker.role === "anonymous"
      ? `anon:${message.id}`
      : message.speaker.qq === null
        ? `anon:${message.id}`
        : `qq:${message.speaker.qq}`;

  // hybrid 的 full 集合：按 sender（真实 QQ；匿名按消息身份 message.id 独立，不归并、
  // 不编 QQ 号）记最新一条（含助手）；比较键与呈现排序完全一致。
  const latestBySender = new Map<string, QqMessageFact>();
  for (const message of ordered) {
    latestBySender.set(senderKeyOf(message), message);
  }
  const fullIds = new Set<string>(focus.responseMessageIds);
  for (const latest of latestBySender.values()) fullIds.add(latest.id);

  // mention 片段身份只读本条 message.mentions（发送时快照）；本条没有就显式 null，
  // 不从别条消息借旧名（规格 §4.1 每消息事实 / §4.5 不回填）。
  const identityOf = (message: QqMessageFact, qq: string): QqIdentity | null => {
    for (const mention of message.mentions) {
      if (mention.qq === qq && mention.identity !== null) return mention.identity;
    }
    return null;
  };

  const lines: string[] = [];
  const nowClock = wallClock(nowSeconds, settings.timezone);
  lines.push(
    `QQ消息事实（now=${nowClock.year}-${nowClock.month}-${nowClock.day} ` +
      `${nowClock.hour}:${nowClock.minute}:${nowClock.second}，timezone=${settings.timezone}）：` +
      "每条 msg= 后是单行 JSON；speaker 是消息发送时身份，replyTo 只给平台消息 ID，" +
      "focus 是本轮触发与应答，与消息本身严格分开。",
  );
  for (const message of ordered) {
    const speaker = renderIdentity(message.speaker);
    const mentions = message.mentions.map((m) => ({
      qq: m.qq,
      identity: m.identity === null ? null : renderIdentity(m.identity),
    }));
    const line = {
      id: message.id,
      platformMessageId: message.platformMessageId,
      seq: message.seq,
      occurredAtSeconds: message.occurredAtSeconds,
      time: formatQqTime(message.occurredAtSeconds, {
        nowSeconds,
        timezone: settings.timezone,
        display: settings.time_display,
        full: fullIds.has(message.id),
      }),
      speaker,
      parts: message.parts.map((part) => renderPart(part, (qq) => identityOf(message, qq))),
      mentions,
      ...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
      completeness: message.completeness,
    };
    // JSON.stringify 单行编码：换行等控制字符转义为数据，伪造行头造不出假消息行。
    lines.push(`msg=${JSON.stringify(line)}`);
  }
  lines.push(`focus=${JSON.stringify(focus)}`);
  return lines.join("\n");
}
