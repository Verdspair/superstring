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

it("passes the accounts AbortSignal to the real no-store GET without converting 503 to an empty list", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ accounts: [] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  const controller = new AbortController();
  expect(await api.listQqManagedAccounts(controller.signal)).toEqual({ accounts: [] });
  expect(fetcher).toHaveBeenCalledWith("/v2/qq/managed-component/accounts", {
    signal: controller.signal,
    cache: "no-store",
  });
  fetcher.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ error: { code: "NAPCAT_LOGIN_UNAVAILABLE", message: "Unavailable" } }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    ),
  );
  await expect(api.listQqManagedAccounts(controller.signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("keeps account cancellation attached through response-body reading", async () => {
  let aborted = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            stream.error(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      },
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
  });
  const controller = new AbortController();
  const read = api.listQqManagedAccounts(controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(read).rejects.toThrow();
  expect(aborted).toBe(true);
});
