import type { SourceRef } from "../../shared/contracts/evidence";

export function uniqueSources(sources: readonly SourceRef[]): SourceRef[] {
  const result = new Map<string, SourceRef>();
  for (const source of sources) {
    const key = JSON.stringify([source.kind, source.id, source.revision]);
    const old = result.get(key);
    if (!old) {
      result.set(key, source);
      continue;
    }
    const keepOld =
      !!old.expiresAt &&
      (!source.expiresAt || Date.parse(old.expiresAt) < Date.parse(source.expiresAt));
    result.set(key, keepOld ? old : source);
  }
  return [...result.values()];
}
