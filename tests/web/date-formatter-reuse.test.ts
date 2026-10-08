import { afterEach, expect, it, vi } from "vitest";
import { formatDate } from "../../src/web/i18n/runtime";

const stamp = "2026-10-08T00:00:00Z";
afterEach(() => vi.restoreAllMocks());
it("reuses the date formatter for repeated equivalent configurations", () => {
  const expected = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(stamp));
  const formatterSpy = vi.spyOn(Intl, "DateTimeFormat");
  expect(
    formatDate(stamp, "zh-CN", { dateStyle: "long", timeStyle: "medium", timeZone: "UTC" }),
  ).toBe(expected);
  expect(
    formatDate(stamp, "zh-CN", { timeZone: "UTC", timeStyle: "medium", dateStyle: "long" }),
  ).toBe(expected);
  expect(formatterSpy).toHaveBeenCalledTimes(1);
});
it("preserves locale, timezone, default options and invalid input behavior", () => {
  for (const locale of ["zh-CN", "en"]) {
    for (const options of [
      undefined,
      {},
      { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" },
    ] as const) {
      const original = new Intl.DateTimeFormat(
        locale,
        options ?? { dateStyle: "medium", timeStyle: "short" },
      ).format(new Date(stamp));
      expect(formatDate(stamp, locale, options)).toBe(original);
    }
  }
  const options: Intl.DateTimeFormatOptions = { year: "numeric", timeZone: "UTC" };
  formatDate(stamp, "en", options);
  expect(options).toEqual({ year: "numeric", timeZone: "UTC" });
  expect(() => formatDate("invalid", "en")).toThrow(RangeError);
  expect(() => formatDate(stamp, "en", { timeZone: "invalid-zone" })).toThrow(RangeError);
});
it("keeps formatter reuse bounded when callers use many configurations", () => {
  const options: Intl.DateTimeFormatOptions = { year: "2-digit", month: "short", timeZone: "UTC" };
  const formatterSpy = vi.spyOn(Intl, "DateTimeFormat");
  formatDate(stamp, "en", options);
  for (let hour = -12; hour <= 12; hour++) {
    formatDate(stamp, "en", {
      ...options,
      timeZone: `${hour < 0 ? "-" : "+"}${String(Math.abs(hour)).padStart(2, "0")}:00`,
    });
  }
  const before = formatterSpy.mock.calls.length;
  formatDate(stamp, "en", options);
  expect(formatterSpy.mock.calls.length).toBe(before + 1);
});
