import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { returnFromContextAllocation } from "../../src/web/features/context-allocation";
import { useSuperstringStore as store } from "../../src/web/store";
import { activeSpace } from "../../src/web/workspace/navigation";
import { SETTINGS_ROUTES } from "../../src/web/workspace/settings-routes";

beforeEach(() => {
  store.getState().resetForTests();
});

describe("models route alias and context-allocation target lifecycle", () => {
  it("keeps context-allocation as the target route and resolves it to the models space", async () => {
    expect(SETTINGS_ROUTES.some((route) => route.id === "context-allocation")).toBe(true);
    expect(
      activeSpace({
        page: "settings",
        settingsView: "workspace",
        settingsRoute: "context-allocation",
      }),
    ).toBe("models");
    expect(
      activeSpace({
        page: "settings",
        settingsView: "workspace",
        settingsRoute: "external-api",
      }),
    ).toBe("models");

    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "scheme-library",
      qqSchemesLoaded: true,
      qqBindingsLoaded: true,
    });
    // QQ 目的经聚合导航落真实方案详情：QQ 预算不再塞进模型服务页。
    store.getState().requestContextAllocation({ purpose: "qq" });

    await waitFor(() => expect(store.getState().settingsRoute).toBe("qq-scheme-config"));
    expect(store.getState().page).toBe("settings");
    expect(store.getState().settingsView).toBe("workspace");
    expect(activeSpace(store.getState())).toBe("schemes");
    // QQ 落地方案详情后 markLanded 清空定向 target（源码 navigation.ts）：默认回到 assistant，
    // 不保留过时的 qq purpose 投影。
    expect(store.getState().contextAllocationTarget.purpose).toBe("assistant");

    // 全局读取仍归模型空间：全局目标落统一上下文分配，而不是助手或方案详情。
    store.getState().requestContextAllocation({ purpose: "reading", agentId: null });
    await waitFor(() => expect(store.getState().settingsRoute).toBe("context-allocation"));
    expect(store.getState().contextAllocationTarget.purpose).toBe("reading");
    expect(activeSpace(store.getState())).toBe("models");
  });

  it("returns to external-api with the precise capacity target and clears the stale purpose target", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "external-api",
    });
    store.getState().requestContextAllocation({
      purpose: "reading",
      capacityModel: "declared-model",
      returnRoute: "external-api",
      returnLabel: "外部模型 API",
    });

    await waitFor(() => expect(store.getState().settingsRoute).toBe("context-allocation"));
    expect(store.getState().contextAllocationTarget.returnRoute).toBe("external-api");

    returnFromContextAllocation();

    await waitFor(() => expect(store.getState().settingsRoute).toBe("external-api"));
    expect(store.getState().modelCapacityTarget).toBe("declared-model");
    expect(store.getState().contextAllocationTarget.purpose).toBe("assistant");
    expect(store.getState().contextAllocationTarget.returnRoute).toBeNull();
  });
});
