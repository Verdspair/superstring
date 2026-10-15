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
    tokenizerEncoding?: ModelProviderModel["tokenizer_encoding"];
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
        ...(model.tokenizer_encoding === undefined
          ? {}
          : { tokenizerEncoding: model.tokenizer_encoding }),
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
      ...(model.tokenizerEncoding === undefined
        ? {}
        : { tokenizer_encoding: model.tokenizerEncoding }),
      ...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}),
    })),
  });
}
