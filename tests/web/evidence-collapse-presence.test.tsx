import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { DeliveryDetails } from "../../src/web/screens/runs/DeliveryEvidence";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

// 折叠只做视觉过渡：关闭态不读，关闭在飞读取立即取消，再次展开重新读，不跨关闭缓存正文。
describe("evidence collapse presence", () => {
  beforeEach(() => {
    void i18n.changeLanguage("zh-CN");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the delivery read owned by the open row", async () => {
    const calls: { outputId: string; signal?: AbortSignal }[] = [];
    const read = vi.fn<SuperstringApi["getDelivery"]>((outputId, signal) => {
      calls.push({ outputId, signal });
      return new Promise<Delivery>(() => {});
    });
    store.getState().resetForTests({ ...api, getDelivery: read });
    render(<DeliveryDetails outputId="out-evidence" />);

    const trigger = screen.getByRole("button", {
      name: new RegExp(i18n.t("observability.deliveryDetails")),
    });
    const body = () =>
      screen.queryByRole("region", { name: i18n.t("observability.deliveryResults") });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(body()).toBeNull();
    expect(read).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(calls[0].outputId).toBe("out-evidence");
    expect(calls[0].signal?.aborted).toBe(false);
    expect(body()).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(calls[0].signal?.aborted).toBe(true));
    expect(read).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(calls[1].signal?.aborted).toBe(false);
  });
});
