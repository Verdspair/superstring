import type {
  ConversationEventView,
  ConversationSummary,
} from "../../shared/contracts/conversation";
import type { RuntimeTrace, RuntimeTracesPage } from "../../shared/contracts/runtime-observability";
import type { BrowserStateStorage } from "../browser-state";
import type { ChatItem } from "../state/types";

export const CACHE_LIMITS = {
  MAX_DIRECTORY_ITEMS: 200,
  MAX_CHAT_MESSAGES: 200,
  MAX_QQ_EVENTS: 200,
  MAX_TRACE_ITEMS: 100,
  MAX_TOTAL_BYTES: 4 * 1024 * 1024,
} as const;

export const CACHE_KEYS = {
  DIRECTORY: "superstring:cache:directory",
  CHAT_PREFIX: "superstring:cache:webchat:",
  QQ_EVENTS_PREFIX: "superstring:cache:qqevents:",
  TRACES_PREFIX: "superstring:cache:traces:",
  ALL_PREFIX: "superstring:cache:",
} as const;

// 命名空间写入代次追踪：用于 pre-commit stale 检查，避免迟到写入在 purge 或新写入后复活
const writeGenerations = new Map<string, number>();

function nextGeneration(key: string): number {
  const next = (writeGenerations.get(key) ?? 0) + 1;
  writeGenerations.set(key, next);
  return next;
}

function invalidateGeneration(key: string): void {
  writeGenerations.set(key, (writeGenerations.get(key) ?? 0) + 1);
}

// 提交后基于 sessionStorage 中实际存在的 Base64 密文字符串字节（UTF-16 chars * 2）严格执行总帽
function enforceTotalCacheBudget(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    let totalBytes = 0;
    const entries: { key: string; length: number }[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(CACHE_KEYS.ALL_PREFIX)) {
        const v = sessionStorage.getItem(k);
        const len = (k.length + (v ? v.length : 0)) * 2;
        totalBytes += len;
        entries.push({ key: k, length: len });
      }
    }
    // 超出总存储预算时依次淘汰缓存项，计入密文和键实际占用。
    while (totalBytes > CACHE_LIMITS.MAX_TOTAL_BYTES && entries.length > 0) {
      const victim = entries.shift();
      if (!victim) break;
      sessionStorage.removeItem(victim.key);
      invalidateGeneration(victim.key);
      totalBytes -= victim.length;
    }
  } catch {
    // Non-fatal
  }
}

// 单一内部窄保存入口：传递 pre-commit guard，并在真实 setItem 之后统一执行真实总配额收口
async function commitCacheEntry(
  storage: BrowserStateStorage | null,
  key: string,
  payload: unknown,
  isStale: () => boolean = () => false,
): Promise<void> {
  if (!storage || isStale()) return;
  const gen = nextGeneration(key);
  try {
    const serialized = JSON.stringify(payload);
    await storage.write(
      key,
      serialized,
      () => writeGenerations.get(key) !== gen || isStale(), // encrypt 完成后、setItem 之前的原子失效拦截
    );
    enforceTotalCacheBudget();
  } catch {
    // Non-fatal
  }
}

// ---- 1. 会话目录缓存 -------------------------------------------------------------
export interface CachedDirectory {
  revision: number;
  items: ConversationSummary[];
  cachedAt: number;
}

export async function saveDirectoryCache(
  storage: BrowserStateStorage | null,
  items: ConversationSummary[],
  revision: number,
): Promise<void> {
  const capped = items.slice(0, CACHE_LIMITS.MAX_DIRECTORY_ITEMS);
  const payload: CachedDirectory = { revision, items: capped, cachedAt: Date.now() };
  await commitCacheEntry(storage, CACHE_KEYS.DIRECTORY, payload);
}

export async function loadDirectoryCache(
  storage: BrowserStateStorage | null,
): Promise<CachedDirectory | null> {
  if (!storage) return null;
  try {
    const raw = await storage.read(CACHE_KEYS.DIRECTORY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedDirectory;
    if (!parsed || typeof parsed.revision !== "number" || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function removeDirectoryCache(storage: BrowserStateStorage | null): Promise<void> {
  if (!storage) return;
  const key = CACHE_KEYS.DIRECTORY;
  invalidateGeneration(key);
  try {
    await storage.remove?.(key);
  } catch {
    // Non-fatal
  }
}

// ---- 2. Web 聊天会话缓存 ---------------------------------------------------------
export interface CachedWebChat {
  sessionId: string;
  agentId: string | null;
  loadRevision: number;
  messages: ChatItem[];
  cachedAt: number;
}

export async function saveWebChatCache(
  storage: BrowserStateStorage | null,
  sessionId: string,
  agentId: string | null,
  loadRevision: number,
  messages: ChatItem[],
): Promise<void> {
  if (!sessionId) return;
  // 仅存已完成消息，不存 optimistic/streaming/pending
  const completed = messages
    .filter((m) => m.status === "completed" && !m.id.startsWith("optimistic-"))
    .slice(-CACHE_LIMITS.MAX_CHAT_MESSAGES);
  const payload: CachedWebChat = {
    sessionId,
    agentId,
    loadRevision,
    messages: completed,
    cachedAt: Date.now(),
  };
  await commitCacheEntry(storage, `${CACHE_KEYS.CHAT_PREFIX}${sessionId}`, payload);
}

export async function loadWebChatCache(
  storage: BrowserStateStorage | null,
  sessionId: string,
  currentAgentId: string | null,
): Promise<CachedWebChat | null> {
  if (!storage || !sessionId) return null;
  try {
    const raw = await storage.read(`${CACHE_KEYS.CHAT_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedWebChat;
    if (
      !parsed ||
      parsed.sessionId !== sessionId ||
      (currentAgentId !== null && parsed.agentId !== currentAgentId) ||
      !Array.isArray(parsed.messages)
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function removeWebChatCache(
  storage: BrowserStateStorage | null,
  sessionId: string,
): Promise<void> {
  if (!storage || !sessionId) return;
  const key = `${CACHE_KEYS.CHAT_PREFIX}${sessionId}`;
  invalidateGeneration(key);
  try {
    await storage.remove?.(key);
  } catch {
    // Non-fatal
  }
}

// ---- 3. QQ 会话事件缓存 -----------------------------------------------------------
export interface CachedQqEvents {
  conversationId: string;
  agentId: string | null;
  bindingEpoch: number | null;
  items: ConversationEventView[];
  cachedAt: number;
}

export async function saveQqEventsCache(
  storage: BrowserStateStorage | null,
  conversationId: string,
  agentId: string | null,
  bindingEpoch: number | null,
  items: ConversationEventView[],
): Promise<void> {
  if (!conversationId) return;
  const capped = items.slice(-CACHE_LIMITS.MAX_QQ_EVENTS);
  const payload: CachedQqEvents = {
    conversationId,
    agentId,
    bindingEpoch,
    items: capped,
    cachedAt: Date.now(),
  };
  await commitCacheEntry(storage, `${CACHE_KEYS.QQ_EVENTS_PREFIX}${conversationId}`, payload);
}

export async function loadQqEventsCache(
  storage: BrowserStateStorage | null,
  conversationId: string,
  currentAgentId: string | null,
  currentEpoch: number | null,
): Promise<ConversationEventView[] | null> {
  if (!storage || !conversationId) return null;
  // 缺 scope (agentId 或 bindingEpoch 为 null) 一律拒水合
  if (currentAgentId === null || currentEpoch === null) return null;
  try {
    const raw = await storage.read(`${CACHE_KEYS.QQ_EVENTS_PREFIX}${conversationId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedQqEvents;
    // 严格匹配 scope：必须与当前 summary (agentId, bindingEpoch) 完全一致
    if (
      !parsed ||
      parsed.conversationId !== conversationId ||
      parsed.agentId !== currentAgentId ||
      parsed.bindingEpoch !== currentEpoch ||
      !Array.isArray(parsed.items)
    )
      return null;

    const now = Date.now();
    // 来源带真实 expiresAt 已知到期的项目执行脱敏，对齐真实 redactEvent 语义（不造顶层 expiresAt）
    const sanitized = parsed.items.map((item) => {
      const isExpired =
        (item.source?.expiresAt && now >= Date.parse(item.source.expiresAt)) ||
        (Array.isArray(item.sources) &&
          item.sources.some((s) => s.expiresAt && now >= Date.parse(s.expiresAt)));
      if (isExpired) {
        return {
          ...item,
          text: null,
          contentState: "expired" as const,
          media: item.media.map((m) => ({
            ...m,
            description: null,
            availability: "unavailable" as const,
          })),
          qqMessageFacts: [],
        };
      }
      return item;
    });
    return sanitized;
  } catch {
    return null;
  }
}

export async function removeQqEventsCache(
  storage: BrowserStateStorage | null,
  conversationId: string,
): Promise<void> {
  if (!storage || !conversationId) return;
  const key = `${CACHE_KEYS.QQ_EVENTS_PREFIX}${conversationId}`;
  invalidateGeneration(key);
  try {
    await storage.remove?.(key);
  } catch {
    // Non-fatal
  }
}

// ---- 4. 运行观测链路缓存 ---------------------------------------------------------
export interface CachedTraces {
  scopeKey: string;
  summary: RuntimeTracesPage["summary"] | null;
  items: RuntimeTrace[];
  cachedAt: number;
}

export async function saveTracesCache(
  storage: BrowserStateStorage | null,
  scopeKey: string,
  summary: RuntimeTracesPage["summary"] | null,
  items: RuntimeTrace[],
): Promise<void> {
  if (!scopeKey) return;
  const capped = items.slice(0, CACHE_LIMITS.MAX_TRACE_ITEMS);
  const payload: CachedTraces = {
    scopeKey,
    summary,
    items: capped,
    cachedAt: Date.now(),
  };
  await commitCacheEntry(storage, `${CACHE_KEYS.TRACES_PREFIX}${scopeKey}`, payload);
}

/** Prewarm only an absent preview; any later authoritative write or purge wins. */
export async function warmTracesCache(
  storage: BrowserStateStorage,
  scopeKey: string,
  read: () => Promise<RuntimeTracesPage>,
  isCurrent: () => boolean,
): Promise<void> {
  const key = `${CACHE_KEYS.TRACES_PREFIX}${scopeKey}`;
  const generation = writeGenerations.get(key);
  if (await loadTracesCache(storage, scopeKey)) return;
  const staleBeforeCommit = () => !isCurrent() || writeGenerations.get(key) !== generation;
  if (staleBeforeCommit()) return;
  const page = await read();
  if (staleBeforeCommit()) return;
  await commitCacheEntry(
    storage,
    key,
    {
      scopeKey,
      summary: page.summary,
      items: page.items.slice(0, CACHE_LIMITS.MAX_TRACE_ITEMS),
      cachedAt: Date.now(),
    },
    () => !isCurrent(),
  );
}

export async function loadTracesCache(
  storage: BrowserStateStorage | null,
  scopeKey: string,
): Promise<{ summary: RuntimeTracesPage["summary"] | null; items: RuntimeTrace[] } | null> {
  if (!storage || !scopeKey) return null;
  try {
    const raw = await storage.read(`${CACHE_KEYS.TRACES_PREFIX}${scopeKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedTraces;
    if (!parsed || parsed.scopeKey !== scopeKey || !Array.isArray(parsed.items)) return null;
    return { summary: parsed.summary, items: parsed.items };
  } catch {
    return null;
  }
}

export async function removeTracesCache(
  storage: BrowserStateStorage | null,
  scopeKey: string,
): Promise<void> {
  if (!storage || !scopeKey) return;
  const key = `${CACHE_KEYS.TRACES_PREFIX}${scopeKey}`;
  invalidateGeneration(key);
  try {
    await storage.remove?.(key);
  } catch {
    // Non-fatal
  }
}

export async function clearAllCaches(storage: BrowserStateStorage | null): Promise<void> {
  if (!storage || typeof sessionStorage === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(CACHE_KEYS.ALL_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      invalidateGeneration(k);
      await storage.remove?.(k);
    }
  } catch {
    // Non-fatal
  }
}
