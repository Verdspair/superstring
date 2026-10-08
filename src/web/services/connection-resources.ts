import { useCallback, useEffect, useRef, useState } from "react";
import type { McpStatusResponse } from "../../shared/contracts/mcp";
import type { SkillCatalogResponse } from "../../shared/contracts/skill";
import type { ToolDirectoryResponse } from "../../shared/contracts/tool-directory";
import type { SuperstringApi } from "../api";
import { errorText } from "../state/helpers";
import { type ReadTask, startRead } from "./read-task";

export interface ConnectionWarmOptions {
  signal?: AbortSignal;
  force?: boolean;
}

interface ResourceEntry<A> {
  data: A | null;
  error: string;
  loading: boolean;
  task: ReadTask | null;
  promise: Promise<A> | null;
  reject: ((cause: unknown) => void) | null;
  /** 当前 task 是否由预热发起：面板全部退场时不得 abort。 */
  warmOwned: boolean;
  /** 已挂载面板消费者数（entry.listeners 同步增减）。 */
  owners: number;
  listeners: Set<() => void>;
}

function createEntry<A>(): ResourceEntry<A> {
  return {
    data: null,
    error: "",
    loading: false,
    task: null,
    promise: null,
    reject: null,
    warmOwned: false,
    owners: 0,
    listeners: new Set(),
  };
}

function emitEntry<A>(entry: ResourceEntry<A>) {
  for (const listener of entry.listeners) listener();
}

function readEntry<A>(
  api: SuperstringApi,
  entry: ResourceEntry<A>,
  read: (api: SuperstringApi, signal: AbortSignal) => Promise<A>,
  { silent = false, warm = false }: { silent?: boolean; warm?: boolean } = {},
): Promise<A> {
  if (entry.task && entry.promise) return entry.promise;
  if (!silent) {
    entry.loading = true;
    entry.error = "";
    emitEntry(entry);
  }
  const promise = new Promise<A>((resolve, reject) => {
    const task = startRead((signal) => read(api, signal), {
      success: (value) => {
        // 迟到的 success/error 不得落入已替换/已取消的新 current read。
        if (entry.task !== task) return;
        entry.data = value;
        entry.error = "";
        resolve(value);
      },
      failure: (cause) => {
        if (entry.task !== task) return;
        if (entry.data === null) {
          if (!silent) entry.error = errorText(cause);
          reject(cause);
        } else {
          resolve(entry.data);
        }
      },
      settled: () => {
        // 旧 task 的 finally 不得清理替换后的新 task。
        if (entry.task !== task) return;
        entry.task = null;
        entry.promise = null;
        entry.reject = null;
        entry.warmOwned = false;
        entry.loading = false;
        emitEntry(entry);
      },
    });
    entry.task = task;
    entry.warmOwned = warm;
    entry.reject = reject;
  });
  entry.promise = promise;
  return promise;
}

function cancelEntry<A>(entry: ResourceEntry<A>) {
  const task = entry.task;
  const reject = entry.reject;
  entry.task = null;
  entry.promise = null;
  entry.reject = null;
  entry.warmOwned = false;
  entry.loading = false;
  task?.cancel();
  reject?.(new Error("connection resource read cancelled"));
  emitEntry(entry);
}

function warmEntry<A>(
  api: SuperstringApi,
  entry: ResourceEntry<A>,
  read: (api: SuperstringApi, signal: AbortSignal) => Promise<A>,
  options?: ConnectionWarmOptions,
): Promise<A> {
  if (entry.task && entry.promise) return entry.promise;
  if (entry.data !== null && !options?.force) return Promise.resolve(entry.data);
  return readEntry(api, entry, read, { warm: true });
}

// warm 的 signal 不接管共享读取：预热调用方退场不得 abort 其他消费者的在途请求。
function useSharedResource<A>(
  api: SuperstringApi,
  entry: ResourceEntry<A>,
  read: (api: SuperstringApi, signal: AbortSignal) => Promise<A>,
  active = true,
) {
  const [, render] = useState(0);
  const revalidated = useRef(false);
  useEffect(() => {
    if (!active) return;
    const listener = () => render((n) => n + 1);
    entry.listeners.add(listener);
    entry.owners += 1;
    if (entry.data !== null) {
      if (!revalidated.current && !entry.task) {
        revalidated.current = true;
        void readEntry(api, entry, read, { silent: true }).catch(() => {});
      }
    } else if (!entry.task) {
      void readEntry(api, entry, read).catch(() => {});
    }
    return () => {
      entry.owners -= 1;
      entry.listeners.delete(listener);
      // 最后一个面板消费者退场：warm 持有的读取允许完成，面板独占前台读取按原语义取消。
      if (entry.owners === 0 && entry.task && !entry.warmOwned) cancelEntry(entry);
    };
  }, [active, api, entry, read]);
  const refresh = useCallback(() => {
    if (entry.task) {
      // 在途读取归 warm 或仍有其他消费者时共享复用；面板独占前台刷新沿用原 cancel 语义。
      if (entry.warmOwned || entry.owners > 1) return;
      cancelEntry(entry);
    }
    void readEntry(api, entry, read).catch(() => {});
  }, [api, entry, read]);
  return { data: entry.data, loading: entry.loading, error: entry.error, refresh };
}

const readMcpServers = (api: SuperstringApi, signal: AbortSignal) => api.getMcpServers(signal);
const readSkills = (api: SuperstringApi, signal: AbortSignal) => api.getSkills(signal);
const readTools = (api: SuperstringApi, signal: AbortSignal) => api.getToolDirectory(signal);

const mcpEntries = new WeakMap<SuperstringApi, ResourceEntry<McpStatusResponse>>();
const skillsEntries = new WeakMap<SuperstringApi, ResourceEntry<SkillCatalogResponse>>();
const toolEntries = new WeakMap<SuperstringApi, ResourceEntry<ToolDirectoryResponse>>();

function entryFor<A>(
  entries: WeakMap<SuperstringApi, ResourceEntry<A>>,
  api: SuperstringApi,
): ResourceEntry<A> {
  let entry = entries.get(api);
  if (!entry) {
    entry = createEntry<A>();
    entries.set(api, entry);
  }
  return entry;
}

export function warmMcpServers(api: SuperstringApi, options?: ConnectionWarmOptions) {
  return warmEntry(api, entryFor(mcpEntries, api), readMcpServers, options);
}

export function warmSkills(api: SuperstringApi, options?: ConnectionWarmOptions) {
  return warmEntry(api, entryFor(skillsEntries, api), readSkills, options);
}

export function warmToolDirectory(api: SuperstringApi, options?: ConnectionWarmOptions) {
  return warmEntry(api, entryFor(toolEntries, api), readTools, options);
}

export function warmConnectionResources(api: SuperstringApi, options?: ConnectionWarmOptions) {
  return Promise.all([
    warmMcpServers(api, options),
    warmSkills(api, options),
    warmToolDirectory(api, options),
  ]).then(([mcp, skills, tools]) => ({ mcp, skills, tools }));
}

export function useMcpServersResource(api: SuperstringApi, active = true) {
  const entry = entryFor(mcpEntries, api);
  const resource = useSharedResource(api, entry, readMcpServers, active);
  const mutate = useCallback(
    (updater: (prev: McpStatusResponse | null) => McpStatusResponse | null) => {
      entry.data = updater(entry.data);
      entry.error = "";
      emitEntry(entry);
    },
    [entry],
  );
  return { ...resource, mutate };
}

export function useSkillsResource(api: SuperstringApi, active = true) {
  return useSharedResource(api, entryFor(skillsEntries, api), readSkills, active);
}

export function useToolDirectoryResource(api: SuperstringApi, active = true) {
  return useSharedResource(api, entryFor(toolEntries, api), readTools, active);
}
