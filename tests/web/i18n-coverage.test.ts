import { describe, expect, it } from "vitest";
import enNotices from "../../src/web/i18n/locales/en/notices.json";
import en from "../../src/web/i18n/locales/en/translation.json";
import zhNotices from "../../src/web/i18n/locales/zh-CN/notices.json";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";

// Source text and interpolation are checked by the official i18next CLI (check:i18n).
// This contract catches incomplete catalogs, including dynamically selected business labels.
describe("Locale completeness", () => {
  it.each([
    ["interface", en, zh],
    ["existing state notices", enNotices, zhNotices],
  ] as const)("%s has nonempty translations in both languages", (_name, english, chinese) => {
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    expect(Object.values(english).every((value) => value.trim().length > 0)).toBe(true);
    expect(Object.values(chinese).every((value) => value.trim().length > 0)).toBe(true);
  });
});
