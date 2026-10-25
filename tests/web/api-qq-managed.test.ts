import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";

afterEach(() => {
  vi.restoreAllMocks();
});

it("requests the first managed QR code through the protected POST route", async () => {
  const qr = { qr_payload: "synthetic-initial-qr" };
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(qr), {
      headers: { "content-type": "application/json" },
    }),
  );
  const controller = new AbortController();

  expect(await api.getQqManagedQr(controller.signal)).toEqual(qr);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith("/v2/qq/managed-component/qr", {
    signal: controller.signal,
    cache: "no-store",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
});

it("refreshes a managed QR code through its separate protected POST route", async () => {
  const qr = { qr_payload: "synthetic-refreshed-qr" };
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(qr), {
      headers: { "content-type": "application/json" },
    }),
  );
  const controller = new AbortController();

  expect(await api.refreshQqManagedQr(controller.signal)).toEqual(qr);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith("/v2/qq/managed-component/refresh-qr", {
    signal: controller.signal,
    cache: "no-store",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
});
