import { ApiError } from "../api";
import type { BrowserStateStorage } from "../browser-state";
import { registerError } from "../i18n/errors";
import type { SuperstringState } from "./types";

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

export function beginProcessing(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
): void {
  set({ pendingOperations: get().pendingOperations + 1 });
}

export function endProcessing(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
): void {
  set({ pendingOperations: Math.max(0, get().pendingOperations - 1) });
}
