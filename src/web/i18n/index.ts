import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { english } from "./en";
import { translateError } from "./errors";
import { i18n, messages } from "./runtime";

export type Locale = "zh-CN" | "en";
export type MessageKey = keyof typeof english;
export const LOCALE_STORAGE_KEY = "superstring-locale";
const listeners = new Set<() => void>();
let current: Locale = readLocale();
void i18n.changeLanguage(current);
if (typeof document !== "undefined") document.documentElement.lang = current;

export function readLocale(): Locale {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY) === "en" ? "en" : "zh-CN";
  } catch {
    return "zh-CN";
  }
}
export function getLocale(): Locale {
  return current;
}
function applyLocale(locale: Locale) {
  current = locale;
  void i18n.changeLanguage(locale);
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  for (const notify of listeners) notify();
}
export function selectLocale(locale: Locale): boolean {
  if (locale !== "zh-CN" && locale !== "en") return false;
  applyLocale(locale);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}
function onStorage(event: StorageEvent) {
  if (event.key === LOCALE_STORAGE_KEY || event.key === null) applyLocale(readLocale());
}
function subscribe(notify: () => void) {
  if (listeners.size === 0 && typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
    if (listeners.size === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => "zh-CN");
}
export function formatMessage(locale: Locale, key: MessageKey, ...values: unknown[]): string {
  return i18n.t(key, {
    lng: locale,
    ns: "notices",
    ...Object.fromEntries(values.map((value, index) => [String(index), value])),
  });
}
// Store feedback remains a string for the existing public store contract. Only
// messages explicitly authored here are registered; arbitrary user text is not scanned.
const notices = new Map<string, { key: MessageKey; values: unknown[] }>();
export function msg(key: MessageKey, ...values: unknown[]): string {
  const text = formatMessage("zh-CN", key, ...values);
  notices.set(text, { key, values });
  if (notices.size > 1000) notices.delete(notices.keys().next().value as string);
  return text;
}
export function translateNotice(text: string): string {
  const entry = notices.get(text);
  if (!entry) return translateError(text, current) ?? translate(text);
  return formatMessage(
    current,
    entry.key,
    ...entry.values.map((value) =>
      typeof value === "string" && value !== text
        ? notices.has(value)
          ? translateNotice(value)
          : (translateError(value, current) ?? value)
        : value,
    ),
  );
}
export function translate(key: string, ...values: unknown[]): string {
  if (Object.hasOwn(messages, key))
    return i18n.t(key, {
      lng: current,
      ...Object.fromEntries(values.map((value, index) => [String(index), value])),
    });
  if (Object.hasOwn(english, key)) return formatMessage(current, key as MessageKey, ...values);
  return key;
}
export function useI18n(): typeof translate {
  useTranslation(undefined, { i18n, useSuspense: false });
  useLocale();
  return translate;
}
