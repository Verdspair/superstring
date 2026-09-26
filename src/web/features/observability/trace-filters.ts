import {
  type RuntimeSpanFilters,
  RuntimeSpanFiltersSchema,
} from "../../../shared/contracts/runtime-observability";
export const filterKeys = [
  "q",
  "channel",
  "stage",
  "status",
  "model",
  "conversationId",
  "agentId",
  "runId",
  "traceId",
  "from",
  "to",
] as const;
export type FilterDraft = Record<(typeof filterKeys)[number], string>;
export function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}
export function filterDraft(filters: RuntimeSpanFilters = {}): FilterDraft {
  return Object.fromEntries(
    filterKeys.map((key) => [
      key,
      key === "from" || key === "to" ? localDateTime(filters[key] ?? "") : (filters[key] ?? ""),
    ]),
  ) as FilterDraft;
}
export function parseFilterDraft(draft: FilterDraft) {
  return RuntimeSpanFiltersSchema.safeParse(
    Object.fromEntries(
      filterKeys
        .filter((key) => draft[key].trim())
        .map((key) => {
          const value = draft[key].trim();
          return [
            key,
            (key === "from" || key === "to") && Number.isFinite(new Date(value).getTime())
              ? new Date(value).toISOString()
              : value,
          ];
        }),
    ),
  );
}
export function readFilterUrl(): RuntimeSpanFilters {
  const url = new URLSearchParams(window.location.search);
  const parsed = parseFilterDraft(
    Object.fromEntries(
      filterKeys.map((key) => [key, url.get(`trace-${key}`) ?? ""]),
    ) as FilterDraft,
  );
  return parsed.success ? parsed.data : {};
}
export function writeFilterUrl(filters: RuntimeSpanFilters) {
  const url = new URL(window.location.href);
  for (const key of filterKeys) {
    const value = filters[key];
    if (value) url.searchParams.set(`trace-${key}`, value);
    else url.searchParams.delete(`trace-${key}`);
  }
  window.history.replaceState(window.history.state, "", url);
}
