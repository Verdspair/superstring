import type {
  LocalModelCatalogResponse,
  ModelProviderResponse,
} from "../../../shared/contracts/models";
import { msg, translate } from "../../i18n";
import { errorText } from "../../state/helpers";

export type ModelDiscovery = {
  /** Locally loaded models reported by the catalog source. */
  local: string[];
  /** Models declared by registered external providers. */
  external: string[];
  /** Provider rows from the successful read; empty when that read failed. */
  providers: ModelProviderResponse[];
  catalogFailure: string | null;
  providerFailure: string | null;
  /** Selectable names: local first, then external, deduplicated. */
  modelNames: string[];
};

// One revision per API client, shared by bootstrap and the model page, so a slower
// older discovery cannot replace a newer one from the same source.
const discoveryRevisions = new WeakMap<object, number>();

export function startModelDiscovery(
  api: object,
  catalogPromise: Promise<LocalModelCatalogResponse>,
  providersPromise: Promise<ModelProviderResponse[]>,
): { revision: number; result: Promise<ModelDiscovery> } {
  const revision = (discoveryRevisions.get(api) ?? 0) + 1;
  discoveryRevisions.set(api, revision);
  return { revision, result: discoverModels(catalogPromise, providersPromise) };
}

export function isCurrentModelDiscovery(api: object, revision: number): boolean {
  return discoveryRevisions.get(api) === revision;
}

async function discoverModels(
  catalogPromise: Promise<LocalModelCatalogResponse>,
  providersPromise: Promise<ModelProviderResponse[]>,
): Promise<ModelDiscovery> {
  const [catalogResult, providersResult] = await Promise.allSettled([
    catalogPromise,
    providersPromise,
  ]);
  const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;
  const providers = providersResult.status === "fulfilled" ? providersResult.value : [];
  const local = [...new Set(catalog?.models ?? [])];
  const external = [
    ...new Set(providers.flatMap((provider) => provider.models.map((model) => model.name))),
  ];
  const catalogFailure =
    catalogResult.status === "rejected" ? errorText(catalogResult.reason) : null;
  const providerFailure =
    providersResult.status === "rejected" ? errorText(providersResult.reason) : null;
  return {
    local,
    external,
    providers,
    catalogFailure,
    providerFailure,
    modelNames: [...new Set([...local, ...external])],
  };
}

export function modelStatusText(
  discovery: ModelDiscovery,
  options: { includeExternalCount?: boolean } = {},
): string {
  if (discovery.catalogFailure !== null) {
    return discovery.external.length
      ? msg("本地模型服务连不上：{0}；已登记的外部模型仍可选择。", discovery.catalogFailure)
      : msg("模型列表加载失败：{0}；仍可保留或手动输入模型 ID。", discovery.catalogFailure);
  }
  if (discovery.providerFailure !== null) {
    return discovery.local.length
      ? translate("外部模型列表加载失败：{0}；本地模型仍可选择。", discovery.providerFailure)
      : msg("模型列表加载失败：{0}；仍可保留或手动输入模型 ID。", discovery.providerFailure);
  }
  const parts = [
    discovery.local.length
      ? msg("LM Studio 当前报告 {0} 个已加载模型。", discovery.local.length)
      : msg("LM Studio 当前没有报告已加载模型；仍可保留或手动输入模型 ID。"),
  ];
  if (options.includeExternalCount && discovery.external.length) {
    parts.push(msg("另有 {0} 个来自外部模型 API。", discovery.external.length));
  }
  return parts.join(" ");
}
