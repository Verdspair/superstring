import { ApiError } from "../api";
import type { BrowserStateStorage } from "../browser-state";
import { registerError } from "../i18n/errors";

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return registerError(error.code, error.message);
  if (error instanceof Error) return error.message;
  return String(error);
}

export function persistBrowserState(
  storage: BrowserStateStorage | null,
  storageKey: string,
  value: string | null,
): void {
  void storage?.write(storageKey, value).catch(() => undefined);
}
