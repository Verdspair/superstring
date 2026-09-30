import { MessagesSquare } from "lucide-react";
import type { QqSchemeResponse } from "../../shared/contracts/qq";
import { qqSchemeDirty } from "../features/qq/types";
import type { SuperstringState } from "../state/types";
import type { SettingsRoute } from "./settings-routes";

/** 只有真实支持方案的应用才登记；暂不支持的应用不出现占位。 */
export interface SchemeAppEntry {
  /** Stable catalog id; never parsed for navigation. */
  id: string;
  nameKey: string;
  descriptionKey: string;
  /** Extra localized search terms (technical names users may type). */
  keywordKeys: readonly string[];
  /** The registered detail route this app's schemes live under. */
  route: SettingsRoute;
  /** App-level management destinations; only apps with real app settings register them. */
  management?: { schemes: SettingsRoute; connection: SettingsRoute; data: SettingsRoute };
  icon: typeof MessagesSquare;
}

export const SCHEME_CATALOG: readonly SchemeAppEntry[] = [
  {
    id: "qq",
    nameKey: "schemes.qq.name",
    descriptionKey: "schemes.qq.description",
    keywordKeys: ["schemes.qq.keywords"],
    route: "qq-scheme-config",
    management: { schemes: "qq-app-schemes", connection: "qq-connection", data: "qq-storage" },
    icon: MessagesSquare,
  },
] as const;

/** Route lookup is the contract: callers navigate by route, never by id. */
export function schemeAppByRoute(route: SettingsRoute): SchemeAppEntry | null {
  return SCHEME_CATALOG.find((entry) => entry.route === route) ?? null;
}

export interface SchemeRow {
  scheme: QqSchemeResponse;
  /** null until bindings were read successfully; a failed read is unknown, never 0. */
  bindings: number | null;
  /** The current editor holds unsaved changes for this scheme. */
  unsavedDraft: boolean;
}

/** How many conversations a scheme would affect; unknown until the bindings read succeeded. */
export function schemeBindingCount(
  state: Pick<SuperstringState, "qqBindings" | "qqBindingsLoaded">,
  schemeId: string,
): number | null {
  if (!state.qqBindingsLoaded) return null;
  return state.qqBindings.filter((binding) => binding.scheme_id === schemeId).length;
}

/** QQ is the only registered implementation today. */
export function schemeRowsOf(
  state: Pick<SuperstringState, "qqSchemes" | "qqBindings" | "qqBindingsLoaded" | "qqSchemeEditor">,
  app: SchemeAppEntry,
): SchemeRow[] {
  if (app.id !== "qq") return [];
  return state.qqSchemes.map((scheme) => ({
    scheme,
    bindings: schemeBindingCount(state, scheme.id),
    unsavedDraft:
      state.qqSchemeEditor?.source.id === scheme.id && qqSchemeDirty(state.qqSchemeEditor),
  }));
}
