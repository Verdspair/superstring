import type { SpaceId } from "../workspace/navigation";
import { PRELOAD_REGISTRY } from "./preload-registry";

export interface ChunkPreloadItem {
  readonly id: string;
  readonly loadChunk: () => Promise<unknown>;
  readonly loadData?: () => Promise<unknown>;
  readonly space?: SpaceId;
}

export interface ChunkPreloadOptions {
  /** 待预载的项列表；当前工作区只跳过代码预载，保留登记的数据预热。 */
  items?: readonly ChunkPreloadItem[];
  /** 最大并发加载数，缺省为 2 */
  concurrency?: number;
  /** 当前已激活的 SpaceId (该 Space 的 Chunk 已在首屏，默认跳过) */
  currentSpace?: SpaceId;
  /** 可注入的空闲调度器，缺省使用 window.requestIdleCallback || setTimeout */
  scheduleIdle?: (callback: () => void) => () => void;
  /** 可注入的文档可见性探测器，缺省为 () => document.visibilityState === "visible" */
  isDocumentVisible?: () => boolean;
  /** 可注入的可见性事件监听目标，缺省为 typeof document !== "undefined" ? document : null */
  visibilityTarget?: EventTarget | null;
  /** 是否执行注册的数据预热，缺省为 true */
  preloadData?: boolean;
}

export interface ChunkPreloadHandle {
  /** 中止调度队列：未派发的项将不再派发；事件监听与空闲回调立即注销 */
  cancel: () => void;
}

const defaultScheduleIdle = (callback: () => void): (() => void) => {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => callback());
    return () => window.cancelIdleCallback(handle);
  }
  const timer = setTimeout(callback, 50);
  return () => clearTimeout(timer);
};

const defaultIsDocumentVisible = (): boolean => {
  return typeof document !== "undefined" ? document.visibilityState === "visible" : true;
};

const defaultVisibilityTarget = (): EventTarget | null => {
  return typeof document !== "undefined" ? document : null;
};

/**
 * 启动 Chunk 空闲调度器。
 * - 仅在 isDocumentVisible() 为 true 时派发新任务；
 * - 并发受限 (<= concurrency, 缺省 2)；
 * - 页面隐藏时暂停派发新任务，恢复可见时继续；
 * - 一旦 cancel()，队列彻底清空不再复活；
 * - 注：原生动态 import() 发出后无法被中断，调度器取消确保后续排队项不发出。
 */
export function startChunkPreload(options: ChunkPreloadOptions = {}): ChunkPreloadHandle {
  const concurrency = options.concurrency ?? 2;
  const scheduleIdle = options.scheduleIdle ?? defaultScheduleIdle;
  const isDocumentVisible = options.isDocumentVisible ?? defaultIsDocumentVisible;
  const visibilityTarget =
    options.visibilityTarget !== undefined ? options.visibilityTarget : defaultVisibilityTarget();

  const items: ChunkPreloadItem[] = options.items
    ? [...options.items]
    : PRELOAD_REGISTRY.map((entry) => ({
        id: entry.id,
        loadChunk: entry.loadChunk,
        loadData: entry.loadData,
        space: entry.space,
      }));

  const chunkQueue = items.filter(
    (item) => !options.currentSpace || item.space !== options.currentSpace,
  );
  const dataQueue =
    options.preloadData === false
      ? []
      : items.filter(
          (item) => options.currentSpace && item.space === options.currentSpace && item.loadData,
        );
  let inFlightChunks = 0;
  let inFlightData = 0;
  let canceled = false;
  let cancelIdle: (() => void) | null = null;

  const drain = () => {
    if (canceled || !isDocumentVisible()) return;
    while (inFlightData < concurrency && dataQueue.length > 0) {
      const item = dataQueue.shift();
      if (!item?.loadData) continue;
      inFlightData++;
      void item
        .loadData()
        .catch(() => {})
        .finally(() => {
          inFlightData--;
          scheduleDrain();
        });
    }
    while (inFlightChunks < concurrency && chunkQueue.length > 0) {
      const item = chunkQueue.shift();
      if (!item) break;
      inFlightChunks++;
      void item
        .loadChunk()
        .then(() => {
          if (!canceled && options.preloadData !== false && item.loadData) dataQueue.push(item);
        })
        .catch(() => {})
        .finally(() => {
          inFlightChunks--;
          scheduleDrain();
        });
    }
  };

  const scheduleDrain = () => {
    if (
      canceled ||
      !isDocumentVisible() ||
      (chunkQueue.length === 0 && dataQueue.length === 0) ||
      cancelIdle !== null
    )
      return;
    cancelIdle = scheduleIdle(() => {
      cancelIdle = null;
      drain();
    });
  };

  const handleVisibilityChange = () => {
    if (canceled) return;
    if (isDocumentVisible()) {
      scheduleDrain();
    }
  };

  if (visibilityTarget) {
    visibilityTarget.addEventListener("visibilitychange", handleVisibilityChange);
  }

  // 首屏就绪后若可见则调度启动
  if (isDocumentVisible()) {
    scheduleDrain();
  }

  const cancel = () => {
    if (canceled) return;
    canceled = true;
    chunkQueue.length = 0;
    dataQueue.length = 0;
    if (cancelIdle) {
      cancelIdle();
      cancelIdle = null;
    }
    if (visibilityTarget) {
      visibilityTarget.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };

  return {
    cancel,
  };
}
