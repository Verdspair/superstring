import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import enNotices from "./locales/en/notices.json";
import en from "./locales/en/translation.json";
import zhNotices from "./locales/zh-CN/notices.json";
import zh from "./locales/zh-CN/translation.json";
export const messages = zh;

/** UI uses stable keys. Legacy notices remain at the state boundary until their own migration. */
export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: "zh-CN",
  fallbackLng: "en",
  supportedLngs: ["zh-CN", "en"],
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  defaultNS: "translation",
  ns: ["translation", "notices"],
  resources: {
    "zh-CN": { translation: zh, notices: zhNotices },
    en: { translation: en, notices: enNotices },
  },
  interpolation: { escapeValue: false, prefix: "{", suffix: "}" },
});

const DATE_FORMATTER_LIMIT = 16;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatDate(
  value: Date | number | string,
  locale: string,
  options?: Intl.DateTimeFormatOptions,
) {
  const resolvedOptions = options ?? { dateStyle: "medium", timeStyle: "short" };
  const key = JSON.stringify([
    locale,
    Object.entries(resolvedOptions)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  ]);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, resolvedOptions);
    if (dateFormatters.size === DATE_FORMATTER_LIMIT) {
      const oldest = dateFormatters.keys().next().value;
      if (oldest !== undefined) dateFormatters.delete(oldest);
    }
    dateFormatters.set(key, formatter);
  }
  return formatter.format(new Date(value));
}
