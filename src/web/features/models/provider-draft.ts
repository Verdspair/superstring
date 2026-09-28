import {
  CreateModelProviderRequestSchema,
  type ModelProviderModel,
  type ModelProviderResponse,
} from "../../../shared/contracts/models";

export interface ProviderEditor {
  source: ModelProviderResponse | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: {
    key: string;
    name: string;
    window: string;
    capabilities?: ModelProviderModel["capabilities"];
  }[];
}

export function createProviderEditor(source: ModelProviderResponse | null): ProviderEditor {
  return {
    source,
    name: source?.name ?? "",
    baseUrl: source?.base_url ?? "",
    apiKey: "",
    models:
      source?.models.map((model) => ({
        key: model.name,
        name: model.name,
        window: String(model.context_window),
        ...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}),
      })) ?? [],
  };
}

export function providerPayload(editor: ProviderEditor) {
  return CreateModelProviderRequestSchema.safeParse({
    name: editor.name.trim(),
    base_url: editor.baseUrl.trim(),
    ...(editor.apiKey ? { api_key: editor.apiKey } : {}),
    models: editor.models.map((model) => ({
      name: model.name.trim(),
      context_window: Number(model.window),
      ...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}),
    })),
  });
}
