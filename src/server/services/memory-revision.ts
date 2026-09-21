import type { MemoryCorrection } from "../../shared/contracts";

export interface RejectedMemory extends Record<string, unknown> {
  name: string;
  summary: string;
  body: string;
}
interface CorrectionMetadata {
  replaces: string;
  rejected: RejectedMemory[];
}

export function memoryMetadata(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function correctionMetadata(raw: string): CorrectionMetadata | null {
  const value = memoryMetadata(raw).content_correction as CorrectionMetadata | undefined;
  return value && typeof value.replaces === "string" && Array.isArray(value.rejected)
    ? value
    : null;
}

export function isCorrectionRetired(raw: string): boolean {
  return memoryMetadata(raw).correction_retired === true;
}

export function correctionSnapshot(
  raw: string,
  replaces: string,
  rejected: RejectedMemory[],
): string {
  const metadata = memoryMetadata(raw);
  delete metadata.correction_retired;
  return JSON.stringify({ ...metadata, content_correction: { replaces, rejected } });
}

export function correctionFields(input: MemoryCorrection) {
  return {
    name: input.name,
    summary: input.summary,
    tags: JSON.stringify(input.tags),
    body: input.body,
  };
}
