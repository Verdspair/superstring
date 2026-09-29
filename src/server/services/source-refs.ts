import type { SourceRef } from "../../shared/contracts/evidence";

export function uniqueSources(sources: readonly SourceRef[]): SourceRef[] {
  const result = new Map<string, SourceRef>();
  for (const source of sources) {
    const key = JSON.stringify([source.kind, source.id, source.revision]);
    const old = result.get(key);
    result.set(
      key,
      old?.expiresAt && (!source.expiresAt || old.expiresAt < source.expiresAt) ? old : source,
    );
  }
  return [...result.values()];
}
