// 保存按修订号做 compare-and-swap：冲突保留草稿并提示重读，不静默覆盖。

import type { WebAccessConfig, WebAccessSnapshot, WebAccessTestResult } from "../../api";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";

export interface WebAccessState {
  webAccessSnapshot: WebAccessSnapshot | null;
  webAccessLoading: boolean;
  webAccessSaving: boolean;
  webAccessTesting: boolean;
  /** 端点草稿；null＝跟随已保存基线。 */
  webAccessDraft: string | null;
  /** 读取/保存/自检失败的动作级文本；面板原样显示，草稿不受影响。 */
  webAccessError: string;
  /** 保存成功提示（i18n 键），面板以 role=status 渲染。 */
  webAccessNotice: string;
  loadWebAccess: () => Promise<void>;
  saveWebAccess: (config: WebAccessConfig) => Promise<boolean>;
  saveWebAccessDraft: () => Promise<boolean>;
  patchWebAccessDraft: (value: string) => void;
  discardWebAccessDraft: () => void;
  testWebAccess: () => Promise<WebAccessTestResult | null>;
}

export const webAccessInitial = {
  webAccessSnapshot: null as WebAccessSnapshot | null,
  webAccessLoading: false,
  webAccessSaving: false,
  webAccessTesting: false,
  webAccessDraft: null as string | null,
  webAccessError: "",
  webAccessNotice: "",
};

/** 端点草稿是否有未保存修改；null 草稿跟随基线，永不算脏。 */
export function webAccessDraftDirty(
  snapshot: WebAccessSnapshot | null,
  draft: string | null,
): boolean {
  if (draft === null) return false;
  return draft.trim() !== (snapshot?.config.searxngEndpoint ?? "");
}

export function createWebAccessActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  WebAccessState,
  | "loadWebAccess"
  | "saveWebAccess"
  | "saveWebAccessDraft"
  | "patchWebAccessDraft"
  | "discardWebAccessDraft"
  | "testWebAccess"
> {
  // 单调序号 + abort：后发起的读取替换先前的，迟到响应不得覆盖新快照（对照权限设置切片）。
  let sequence = 0;
  let read: AbortController | null = null;
  return {
    loadWebAccess: async () => {
      if (get().webAccessSaving) return;
      read?.abort();
      const controller = new AbortController();
      read = controller;
      const token = ++sequence;
      const api = get().apiClient;
      set({ webAccessLoading: true, webAccessError: "", webAccessNotice: "" });
      try {
        const snapshot = await api.getWebAccess(controller.signal);
        if (token !== sequence || get().apiClient !== api) return;
        // 读取（含冲突后的重新读取）不丢草稿：成功后的基线才在保存成功时把输入收回来。
        set({ webAccessSnapshot: snapshot });
      } catch (error) {
        if (token === sequence && !controller.signal.aborted && get().apiClient === api)
          set({ webAccessError: errorText(error) });
      } finally {
        if (token === sequence && get().apiClient === api) set({ webAccessLoading: false });
      }
    },
    saveWebAccess: async (config) => {
      const snapshot = get().webAccessSnapshot;
      if (!snapshot || get().webAccessSaving || get().webAccessTesting) return false;
      // 保存开始即作废在途的读取；它的 finally 不会再动 loading 标志。
      read?.abort();
      ++sequence;
      const api = get().apiClient;
      set({
        webAccessSaving: true,
        webAccessLoading: false,
        webAccessError: "",
        webAccessNotice: "",
      });
      try {
        const saved = await api.saveWebAccess({ expectedRevision: snapshot.revision, config });
        if (get().apiClient !== api) return false;
        set({
          webAccessSnapshot: saved,
          webAccessDraft: null,
          webAccessNotice: "connections.web.saved",
        });
        return true;
      } catch (error) {
        if (get().apiClient === api) set({ webAccessError: errorText(error) });
        return false;
      } finally {
        if (get().apiClient === api) set({ webAccessSaving: false });
      }
    },
    saveWebAccessDraft: async () => {
      const draft = get().webAccessDraft;
      if (draft === null) return true;
      const trimmed = draft.trim();
      const snapshot = get().webAccessSnapshot;
      // 与基线相等（含只差空白）时不产生写入，也不推进修订号。
      if (snapshot && trimmed === (snapshot.config.searxngEndpoint ?? "")) {
        set({ webAccessDraft: null });
        return true;
      }
      // 空草稿＝仅用内置 Bing（与服务端约定：缺 searxngEndpoint 即未配置）。
      return get().saveWebAccess(
        trimmed === "" ? { version: 1 } : { version: 1, searxngEndpoint: trimmed },
      );
    },
    patchWebAccessDraft: (value) => {
      if (get().webAccessSaving || get().webAccessTesting) return;
      // 保存提示只代表上一次保存：继续编辑即视为新一轮未保存修改。
      set({ webAccessDraft: value, webAccessNotice: "" });
    },
    discardWebAccessDraft: () => {
      if (get().webAccessSaving || get().webAccessTesting) return;
      set({ webAccessDraft: null, webAccessNotice: "" });
    },
    testWebAccess: async () => {
      if (get().webAccessTesting || get().webAccessSaving) return null;
      const api = get().apiClient;
      const revision = get().webAccessSnapshot?.revision;
      set({ webAccessTesting: true, webAccessError: "", webAccessNotice: "" });
      try {
        const result = await api.testWebAccess();
        // 迟到结果不作数：换过 api 或配置已被替换时不能再当作本次自检结论。
        if (get().apiClient !== api || get().webAccessSnapshot?.revision !== revision) return null;
        return result;
      } catch (error) {
        if (get().apiClient === api) set({ webAccessError: errorText(error) });
        return null;
      } finally {
        if (get().apiClient === api) set({ webAccessTesting: false });
      }
    },
  };
}
