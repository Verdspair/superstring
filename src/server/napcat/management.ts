import type {
  QqManagedConfig,
  QqManagedConfigSnapshot,
  QqManagedStatus,
} from "../../shared/contracts/qq-managed";
import type { FileNapCatConfigStore } from "./config";

export interface NapCatManagementPort {
  readConfig(): QqManagedConfigSnapshot;
  replaceConfig(expectedRevision: string, config: QqManagedConfig): QqManagedConfigSnapshot;
  snapshot(): QqManagedStatus;
}

/** Saving a preference is independent of native activation and QQ business settings. */
export function createNapCatManagement(
  store: Pick<FileNapCatConfigStore, "read" | "replace">,
): NapCatManagementPort {
  return {
    readConfig: () => store.read(),
    replaceConfig: (expectedRevision, config) => store.replace(expectedRevision, config),
    snapshot: () => ({
      process: "unavailable",
      apply: "blocked",
      unavailable_reason: "native_validation_required",
    }),
  };
}
