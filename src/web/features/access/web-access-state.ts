// 联网配置的读取、保存与自检（本机管理面 /v2/web-access）。
//
// 快照带修订号，保存按 compare-and-swap 提交：文件被别人改过时服务端回 409，面板保留草稿并
// 提示重新读取，不静默覆盖。自检的成败是通道状态而不是异常（服务端把失败也作为 200 结论返回），
// 所以结论直接返回给面板，由它贴着按钮显示——只有真正的传输/服务故障才写进动作错误。

import type { WebAccessConfig, WebAccessSnapshot, WebAccessTestResult } from "../../api";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";

export interface WebAccessState {
  webAccessSnapshot: WebAccessSnapshot | null;
  webAccessLoading: boolean;
  webAccessSaving: boolean;
  webAccessTesting: boolean;
  /** 读取/保存/自检失败的动作级文本；面板原样显示，草稿不受影响。 */
  webAccessError: string;
  /** 保存成功提示（i18n 键），面板以 role=status 渲染。 */
  webAccessNotice: string;
  loadWebAccess: () => Promise<void>;
  saveWebAccess: (config: WebAccessConfig) => Promise<boolean>;
  testWebAccess: () => Promise<WebAccessTestResult | null>;
}

export const webAccessInitial = {
  webAccessSnapshot: null as WebAccessSnapshot | null,
  webAccessLoading: false,
  webAccessSaving: false,
  webAccessTesting: false,
  webAccessError: "",
  webAccessNotice: "",
};

export function createWebAccessActions(
  set: StoreSet,
  get: StoreGet,
): Pick<WebAccessState, "loadWebAccess" | "saveWebAccess" | "testWebAccess"> {
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
        set({ webAccessSnapshot: saved, webAccessNotice: "connections.web.saved" });
        return true;
      } catch (error) {
        if (get().apiClient === api) set({ webAccessError: errorText(error) });
        return false;
      } finally {
        if (get().apiClient === api) set({ webAccessSaving: false });
      }
    },
    testWebAccess: async () => {
      if (get().webAccessTesting || get().webAccessSaving) return null;
      const api = get().apiClient;
      set({ webAccessTesting: true, webAccessError: "", webAccessNotice: "" });
      try {
        return await api.testWebAccess();
      } catch (error) {
        if (get().apiClient === api) set({ webAccessError: errorText(error) });
        return null;
      } finally {
        if (get().apiClient === api) set({ webAccessTesting: false });
      }
    },
  };
}
