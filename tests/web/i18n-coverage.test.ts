import { describe, expect, it } from "vitest";
import enNotices from "../../src/web/i18n/locales/en/notices.json";
import en from "../../src/web/i18n/locales/en/translation.json";
import zhNotices from "../../src/web/i18n/locales/zh-CN/notices.json";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

function toBaseKey(key: string): string {
  return key.replace(PLURAL_SUFFIX_RE, "");
}

function getBaseKeys(catalog: Record<string, string>): string[] {
  return Array.from(new Set(Object.keys(catalog).map(toBaseKey))).sort();
}

function getPluralBases(catalog: Record<string, string>): string[] {
  const bases = new Set<string>();
  for (const key of Object.keys(catalog)) {
    if (PLURAL_SUFFIX_RE.test(key)) {
      bases.add(toBaseKey(key));
    }
  }
  return Array.from(bases).sort();
}

// Source text and interpolation are checked by the official i18next CLI (check:i18n).
// This contract catches incomplete catalogs, including dynamically selected business labels.
describe("Locale completeness", () => {
  it.each([
    ["interface", en, zh, "en", "zh-CN"],
    ["existing state notices", enNotices, zhNotices, "en", "zh-CN"],
  ] as const)(
    "%s has nonempty translations in both languages",
    (_name: string, english: Record<string, string>, chinese: Record<
      string,
      string
    >, enLocale: string, zhLocale: string) => {
      // 1. All base keys match 100% across catalogs
      expect(getBaseKeys(english)).toEqual(getBaseKeys(chinese));

      // 2. All values in both catalogs are non-empty
      expect(Object.values(english).every((value) => value.trim().length > 0)).toBe(true);
      expect(Object.values(chinese).every((value) => value.trim().length > 0)).toBe(true);

      // 3. For every pluralized base key in English, every required Intl.PluralRules category must exist and be non-empty
      const enPlural = new Intl.PluralRules(enLocale);
      const enCategories = enPlural.resolvedOptions().pluralCategories; // ['one', 'other']
      const enPluralBases = getPluralBases(english);

      for (const baseKey of enPluralBases) {
        for (const cat of enCategories) {
          const variantKey = `${baseKey}_${cat}`;
          expect(english[variantKey]).toBeDefined();
          expect(english[variantKey].trim().length).toBeGreaterThan(0);
        }

        // Validate render sample counts 0, 1, 2
        for (const count of [0, 1, 2]) {
          const resolvedCat = enPlural.select(count);
          const resolvedKey = `${baseKey}_${resolvedCat}`;
          expect(english[resolvedKey]).toBeDefined();
          expect(english[resolvedKey].trim().length).toBeGreaterThan(0);
        }
      }

      // 4. For Chinese (no plural inflections, single 'other' category), verify fallback to base key
      const zhPlural = new Intl.PluralRules(zhLocale);
      expect(zhPlural.resolvedOptions().pluralCategories).toEqual(["other"]);
      for (const baseKey of enPluralBases) {
        expect(chinese[baseKey]).toBeDefined();
        expect(chinese[baseKey].trim().length).toBeGreaterThan(0);
      }
    },
  );
});
