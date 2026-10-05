// QQ 本地引用展开（计划 T04；规格 §4.3/§4.4）。
//
// `expandQqReplies` 只做纯关系遍历与预算裁剪：真实 scope/来源/登记接线由宿主注入的
// load/register/fits 提供（T04b/T05），本模块不伪造授权，也不改窗口与水位。
//
// 预算/裁剪口径（T04a fix2）：
// - 排序全部数值比较：depth 升序 → 链源窗口 seq 降序（同深保较新）→ fact.id 二进制决胜；
//   不用 magic string orderKey。
// - 所有 root.message 只携带身份/时间/关系 metadata（parts=[]）；正文只经单个目标 root 的
//   一个 textPage 供一次，in_window 同样 parts=[] 并以 targetMessageId 指向窗口消息。
// - fits 收到的是「实际最终投影候选值」QqReplyProjection{roots, sources}：含现所有关系
//   metadata、已供 page 与本次候选 page，sources 为暴露 metadata 的实际并集；
//   fits 试探不登记、不伪造 bodyRef。
// - budget 与 fits 一轮授予：fits 拒绝全额退款（不花字符预算），partial 只扣真实 page 码点。
// - 直接层零预算/全拒仍登记真实 evidence（原正文+sources）一次；同 target 复用同一 handle。

import type { Evidence, SourceRef } from "../../../shared/contracts/evidence";
import type {
  QqConversationScope,
  QqMessageFact,
  QqMessageFocus,
  QqMessageSettings,
} from "../../../shared/contracts/qq-message";
import { uniqueSources } from "../../services/source-refs";

export type QqReplyState =
  | "available"
  | "in_window"
  | "expired"
  | "missing"
  | "revoked"
  | "cycle"
  | "budget_limited"
  | "legacy_unknown";

/**
 * 受控引用目标状态（T04/T05 状态保真；规格 §4.3「不可读状态分别表达」）。
 * 状态语义由 message-projection 的 `loadQqMessageFactState` 唯一定义：
 *   * `available` — 全部来源当前可读，fact 携带完整投影；
 *   * `expired` — 调用方自己 scope 内事实快照到期（只给安全关系状态，不载正文/身份/当前名）；
 *   * `revoked` — 正文被删/到期/改写（rev drift），不回快照 text；
 *   * `legacy_unknown` — legacy 单昵称旧关系缺失；
 *   * `missing` — 未记录；跨 scope/owner 拒绝也落在这里（不可证目标存在）。
 * 除 available 外 fact 恒为 null：过期事实不能借本接口当一般资料或 SourceRef 注册。
 */
export type QqReplyTargetStatus =
  | "available"
  | "expired"
  | "revoked"
  | "legacy_unknown"
  | "missing";

export interface QqReplyTargetState {
  state: QqReplyTargetStatus;
  fact: QqMessageFact | null;
}

export interface QqReplyTextPage {
  text: string;
  offset: number;
  total: number;
  nextOffset: number | null;
  complete: boolean;
}

export interface QqReplyRoot {
  fromMessageId: string;
  targetMessageId: string;
  state: QqReplyState;
  depth: number;
  message: QqMessageFact | null;
  textPage: QqReplyTextPage | null;
  bodyRef: string | null;
}

export interface QqReplyProjection {
  roots: QqReplyRoot[];
  sources: SourceRef[];
}

export interface QqReplyInput {
  scope: QqConversationScope;
  window: readonly QqMessageFact[];
  focus: QqMessageFocus;
  settings: QqMessageSettings;
  now: string;
  remainingTextUnits: number;
  load: (id: string) => QqMessageFact | null;
  /**
   * 可选受控状态读取（T04/T05 状态保真）：宿主注入 message-projection 的
   * `loadQqMessageFactState`，同 scope 过期/撤权/旧关系缺失分别表达（§4.3），
   * 跨 scope 恒 missing。缺省（纯函数单测桩）保持按 `load` 推断的既有行为；
   * 生产 caller 必须接状态接口，不以缺省推断掩状态缺口。
   */
  loadState?: (platformMessageId: string) => QqReplyTargetState;
  /**
   * 第二参数携带登记时点的当前 QqMessageFact（宿主 locateHistory 铸真实 lazy ref 需要
   * eventKey→platformMessageId 关系）；旧单参 fixtures 兼容（TS 结构子型、JS 忽略多余实参）。
   * Evidence 契约不加字段：过期事实不进登记（available 才走到这里）。
   */
  register: (evidence: Evidence, fact: QqMessageFact) => string;
  fits: (value: QqReplyProjection, sources: readonly SourceRef[]) => boolean;
}

interface BfsNode {
  fromMessageId: string;
  platformId: string;
  depth: number;
  /** 本节点在 BFS 路径上的祖先平台 ID 集合（起点即窗口消息自身平台 ID）。 */
  path: ReadonlySet<string>;
  /** 链源窗口消息的 seq：同深保较新的排序锚（M1）。 */
  originSeq: number;
}

interface BodyCandidate {
  fact: QqMessageFact;
  rootIndex: number;
  depth: number;
  direct: boolean;
  originSeq: number;
}

const MAX_DEPTH = 8;

function codePoints(text: string): string[] {
  return Array.from(text);
}

function textBody(fact: QqMessageFact): string | null {
  const segments = fact.parts
    .filter((part) => part.kind === "text")
    .map((part) => (part.kind === "text" ? part.text : ""));
  return segments.length > 0 ? segments.join("") : null;
}

/** 关系 metadata 副本：身份/时间/来源/mentions/replyTo 保留，正文段一律剥离。 */
function metadataMessage(fact: QqMessageFact): QqMessageFact {
  return { ...fact, parts: [] };
}

/** ISO 同刻按毫秒数值比较（m1）：字符串直比会把秒精度同刻误判未过期。 */
function isExpired(fact: QqMessageFact, now: string): boolean {
  return fact.sources.some(
    (source) => source.expiresAt !== undefined && Date.parse(source.expiresAt) <= Date.parse(now),
  );
}

/** 预算排序比较器（M1，全数值）：depth 升序 → originSeq 降序（同深保较新）→
 *  fact.id 按 UTF-16 码元二进制升序决胜。 */
function compareCandidates(a: BodyCandidate, b: BodyCandidate): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.originSeq !== b.originSeq) return b.originSeq - a.originSeq;
  if (a.fact.id < b.fact.id) return -1;
  if (a.fact.id > b.fact.id) return 1;
  return 0;
}

/** Unicode 前缀二分：显式接收 body，在 maxChars 码点与 probe（fits）双重约束下
 *  找最长可装入前缀。probe 只做 fits 试探（不登记、不花预算）。 */
function fitPrefix(
  body: string,
  maxChars: number,
  probe: (page: QqReplyTextPage) => boolean,
): QqReplyTextPage {
  const chars = codePoints(body);
  const total = chars.length;
  const makePage = (n: number): QqReplyTextPage => ({
    text: chars.slice(0, n).join(""),
    offset: 0,
    total,
    nextOffset: n < total ? n : null,
    complete: n === total,
  });
  let low = 1;
  let high = Math.min(total, Math.max(maxChars, 0));
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (probe(makePage(mid))) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return makePage(best);
}

export function expandQqReplies(input: QqReplyInput): QqReplyProjection {
  const { window, settings, now, remainingTextUnits, load, loadState, register, fits } = input;

  const windowByPlatformId = new Map<string, QqMessageFact>();
  for (const fact of window) {
    if (fact.platformMessageId) windowByPlatformId.set(fact.platformMessageId, fact);
  }
  const windowFactIds = new Set(window.map((fact) => fact.id));

  const maxDepth = Math.min(Math.max(Math.floor(settings.reply_depth), 1), MAX_DEPTH);
  const oneThen = settings.reply_mode === "one_then_on_demand";

  const roots: QqReplyRoot[] = [];
  const candidates: BodyCandidate[] = [];
  /** 已展开过的 relation key：同一 from->同一 platform ID 只列一次。 */
  const seenRelations = new Set<string>();
  /** 全局「正文只供一次」：同一 target fact ID 的正文已给出或承诺给出。 */
  const bodyGiven = new Set<string>();

  const frontier: BfsNode[] = [];
  function enqueueFrom(
    fact: QqMessageFact,
    depth: number,
    path: ReadonlySet<string>,
    originSeq: number,
  ): void {
    const replyTo = fact.replyTo?.platformMessageId;
    if (!replyTo) return;
    const relationKey = `${fact.id}->${replyTo}`;
    if (seenRelations.has(relationKey)) return;
    seenRelations.add(relationKey);
    frontier.push({
      fromMessageId: fact.id,
      platformId: replyTo,
      depth,
      path,
      originSeq,
    });
  }
  for (const fact of window) {
    // cycle 路径与比较统一用平台 ID：起点即窗口消息自身平台 ID（自引可被检出）。
    enqueueFrom(fact, 1, new Set([fact.platformMessageId ?? fact.id]), fact.seq);
  }

  while (frontier.length > 0) {
    const current = [...frontier];
    frontier.length = 0;
    for (const node of current) {
      if (oneThen && node.depth > 1) continue;
      if (node.depth > maxDepth) continue;

      const root: QqReplyRoot = {
        fromMessageId: node.fromMessageId,
        targetMessageId: node.platformId,
        state: "missing",
        depth: node.depth,
        message: null,
        textPage: null,
        bodyRef: null,
      };
      roots.push(root);
      const rootIndex = roots.length - 1;
      const direct = node.depth === 1;

      // (1) 目标已在窗口：过期先拒（M4，不补载已过期窗口事实）；
      //     完整→in_window（正文在窗口本体内，root 只带 metadata 并指向窗口消息）。
      const windowFact = windowByPlatformId.get(node.platformId);
      if (windowFact && windowFactIds.has(windowFact.id)) {
        if (isExpired(windowFact, now)) {
          root.state = "expired";
          continue;
        }
        root.targetMessageId = windowFact.id;
        if (windowFact.completeness === "full") {
          root.state = "in_window";
          root.message = metadataMessage(windowFact);
          bodyGiven.add(windowFact.id);
          const pathOut = new Set(node.path);
          pathOut.add(windowFact.platformMessageId ?? windowFact.id);
          enqueueFrom(windowFact, node.depth + 1, pathOut, node.originSeq);
          continue;
        }
        // 窗口内不完整：不冒 full，不暴露窗口半身，按同一来源从 load 补足。
      }

      // (2) 路径 cycle：目标平台 ID 已出现在本 BFS 路径祖先里。
      if (node.path.has(node.platformId)) {
        root.state = "cycle";
        continue;
      }

      // 状态读取（T04/T05 状态保真）：宿主注入 loadState 时同 scope 过期/撤权/legacy
      // 分别表达（§4.3），跨 scope 恒 missing；缺省保持按 load 推断的既有行为（纯函数
      // 单测兼容；生产 caller 必须接状态接口）。available 声明仍过 forged/过期/撤权
      // 防御校验，任何变形应答 fail closed 按缺失（不触发 legacy 补足）。
      if (loadState) {
        const st = loadState(node.platformId);
        const status = st?.state ?? "missing";
        if (status === "expired" || status === "revoked" || status === "legacy_unknown") {
          root.state = status;
          root.message = null;
          continue;
        }
        const claimed = status === "available" ? (st?.fact ?? null) : null;
        const loaded =
          claimed &&
          claimed.platformMessageId === node.platformId &&
          !isExpired(claimed, now) &&
          claimed.completeness === "full"
            ? claimed
            : null;
        if (!loaded) {
          if (status === "missing" && windowFact && windowFact.completeness !== "full") {
            root.state = "legacy_unknown";
          }
          continue;
        }
        root.targetMessageId = loaded.id;
        root.message = metadataMessage(loaded);
        root.state = "available";
        if (!bodyGiven.has(loaded.id)) {
          bodyGiven.add(loaded.id);
          candidates.push({
            fact: loaded,
            rootIndex,
            depth: node.depth,
            direct,
            originSeq: node.originSeq,
          });
        }
        const pathOut = new Set(node.path);
        pathOut.add(loaded.platformMessageId ?? loaded.id);
        enqueueFrom(loaded, node.depth + 1, pathOut, node.originSeq);
        continue;
      }

      const loaded = load(node.platformId);
      if (!loaded) {
        // 窗口内不完整且补不到：旧关系缺失。
        if (windowFact && windowFact.completeness !== "full") root.state = "legacy_unknown";
        continue; // 否则保持 missing
      }
      if (loaded.platformMessageId !== node.platformId) continue; // 伪造 ID：missing
      if (isExpired(loaded, now)) {
        root.state = "expired";
        continue; // 过期：不泄私文与身份
      }
      if (loaded.completeness === "unavailable") {
        root.state = "revoked";
        continue;
      }

      // 非 legacy 场景下的不完整事实：按旧关系缺失表达，不给正文。
      if (loaded.completeness === "legacy_partial") {
        root.state = "legacy_unknown";
        root.message = null;
        continue;
      }

      // (3) 共享 target 去重：正文只供一次（legacy_partial 由同 ID full 补足也走此路径，
      //     防同一 fact 被多个引用各供一份正文）；已给过的只保留关系指向。
      root.targetMessageId = loaded.id;
      root.message = metadataMessage(loaded);
      root.state = "available";
      if (!bodyGiven.has(loaded.id)) {
        bodyGiven.add(loaded.id);
        candidates.push({
          fact: loaded,
          rootIndex,
          depth: node.depth,
          direct,
          originSeq: node.originSeq,
        });
      }
      const pathOut = new Set(node.path);
      pathOut.add(loaded.platformMessageId ?? loaded.id);
      enqueueFrom(loaded, node.depth + 1, pathOut, node.originSeq);
    }
  }

  // ---- 预算/fits 一轮授予 ---------------------------------------------------------------
  // 规格预算是字符单位：窗口先保留（in_window 不占此预算）。授予顺序（M1，数值比较）：
  // depth 升序 → 链源 seq 降序（同深保较新）→ fact.id 二进制决胜。
  // fits 拒绝全额退款；partial 只扣真实 page 码点；被裁直接层走登记路径，深层不登记。

  const sorted = candidates
    .filter((candidate) => candidate.fact.completeness === "full")
    .map((candidate) => ({ ...candidate, body: textBody(candidate.fact) }))
    .filter((candidate): candidate is BodyCandidate & { body: string } => candidate.body !== null)
    .sort(compareCandidates);

  /** 实际最终投影候选值：所有关系 metadata（parts=[]）＋已供 page＋本次候选 page；
   *  sources 为暴露 metadata 的实际并集。 */
  function projectionWith(
    candidate: BodyCandidate,
    page: QqReplyTextPage | null,
  ): QqReplyProjection {
    const snapshot = roots.map((root, index) => ({
      ...root,
      message: root.message ? metadataMessage(root.message) : null,
      textPage: index === candidate.rootIndex ? page : root.textPage,
    }));
    const sources = uniqueSources(
      snapshot.flatMap((root) => (root.message ? root.message.sources : [])),
    );
    return { roots: snapshot, sources };
  }

  let budget = Math.max(remainingTextUnits, 0);
  /** 拿到不完整 page 的候选：登记受限读取引用。 */
  const pagedIncomplete: Array<BodyCandidate & { body: string }> = [];
  /** 被裁（本轮预算/fits 拒绝、未给出任何 page）的候选：直接层仍登记受限读取引用。 */
  const cut: Array<BodyCandidate & { body: string }> = [];

  for (const candidate of sorted) {
    const root = roots[candidate.rootIndex];
    if (!root) continue;
    const chars = codePoints(candidate.body);
    const total = chars.length;
    const makePage = (n: number): QqReplyTextPage => ({
      text: chars.slice(0, n).join(""),
      offset: 0,
      total,
      nextOffset: n < total ? n : null,
      complete: n === total,
    });
    const tryGrant = (page: QqReplyTextPage): boolean => {
      const projected = projectionWith(candidate, page);
      if (!fits(projected, projected.sources)) return false;
      budget -= codePoints(page.text).length;
      root.textPage = page;
      root.state = page.complete ? "available" : "budget_limited";
      return true;
    };

    if (total <= budget) {
      if (tryGrant(makePage(total))) {
        if (total > 0 && !makePage(total).complete) pagedIncomplete.push(candidate);
        continue;
      }
      // fits 拒绝全额退款：不花预算。
      if (!candidate.direct) {
        root.state = "budget_limited";
        cut.push(candidate);
        continue;
      }
      // 直接层 fits 拒整篇：Unicode 前缀二分（一个码点都装不下则被裁）。
      let granted = false;
      const page = fitPrefix(candidate.body, total, (probePage) => {
        const projected = projectionWith(candidate, probePage);
        return fits(projected, projected.sources);
      });
      if (page.text.length > 0) {
        budget -= codePoints(page.text).length;
        root.textPage = page;
        root.state = page.complete ? "available" : "budget_limited";
        if (!page.complete) pagedIncomplete.push(candidate);
        granted = true;
      }
      if (granted) continue;
      root.state = "budget_limited";
      cut.push(candidate);
      continue;
    }

    // 整篇超预算：直接层保留预算内前缀 page；深层直接被裁。
    if (candidate.direct && budget > 0) {
      const page = fitPrefix(candidate.body, budget, (probePage) => {
        const projected = projectionWith(candidate, probePage);
        return fits(projected, projected.sources);
      });
      if (page.text.length > 0) {
        budget -= codePoints(page.text).length;
        root.textPage = page;
        root.state = "budget_limited";
        pagedIncomplete.push(candidate);
        continue;
      }
    }
    root.state = "budget_limited";
    cut.push(candidate);
  }

  // ---- 登记 bodyRef（M3）---------------------------------------------------------------
  // 给出不完整 page 的候选 ＋ 被裁直接层：登记真实 evidence（原正文＋sources）。
  // 同 target（fact.id）复用同一真实 handle，绝不返回伪造值；被裁深层不登记。
  // 注意：受限读取的最终尺寸边界（字节预算、引用上限、来源复验）由真实 registry
  // （T05c 接线）保证——本纯函数只有注入桩，无法实测真实 registry，不得声称已保证。

  const refsByFactId = new Map<string, string>();
  function registerOnce(candidate: BodyCandidate & { body: string }): string {
    const existing = refsByFactId.get(candidate.fact.id);
    if (existing !== undefined) return existing;
    const evidence: Evidence = {
      id: `qq-message:${candidate.fact.id}`,
      text: candidate.body,
      sources: candidate.fact.sources,
    };
    const ref = register(evidence, candidate.fact);
    refsByFactId.set(candidate.fact.id, ref);
    return ref;
  }

  for (const candidate of pagedIncomplete) {
    const root = roots[candidate.rootIndex];
    if (!root?.textPage || root.textPage.complete) continue;
    root.bodyRef = registerOnce(candidate);
  }
  for (const candidate of cut) {
    if (!candidate.direct) continue;
    const root = roots[candidate.rootIndex];
    if (root && !root.bodyRef) root.bodyRef = registerOnce(candidate);
  }

  // ---- 来源并集：凡暴露 metadata（含 in_window / available / budget_limited）的根，
  //      其 fact sources 全量并入；expired/missing/cycle/revoked/legacy_unknown 不暴露 → 不并入。

  const consumedSources: SourceRef[] = [];
  for (const root of roots) {
    if (root.message) consumedSources.push(...root.message.sources);
  }
  return { roots, sources: uniqueSources(consumedSources) };
}
