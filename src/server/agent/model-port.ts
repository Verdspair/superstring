import type { ModelMessage } from "../../shared/contracts/agent-run";
import type { ChatMessage, ModelGateway } from "../llm/model-gateway";
import type { VisionClient, VisionImage } from "../llm/vision-client";

export interface ModelRequest {
  messages: readonly ModelMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}
export interface MultimodalRequest {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  model: string;
  prompt: string;
  images: readonly VisionImage[];
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}
/** Protocol adapters are replaceable; inference ownership always stays in AgentRuntime. */
export interface ModelPort {
  readonly defaultModel?: string;
  complete(request: ModelRequest): Promise<string>;
  streamText(request: ModelRequest): AsyncGenerator<string, void, unknown>;
  completeMultimodal(request: MultimodalRequest): Promise<string>;
}
export type TextModelGateway = Pick<ModelGateway, "complete"> &
  Partial<Pick<ModelGateway, "streamChat" | "config">>;

export function textMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (!["system", "user", "assistant"].includes(message.role)) {
      throw new Error(`Unsupported text message role: ${message.role}`);
    }
    return {
      role: message.role as ModelMessage["role"],
      content: [{ kind: "text", text: message.content }],
    };
  });
}

function gatewayMessages(messages: readonly ModelMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
      .map((part) => {
        if (part.kind !== "text") throw new Error("Use completeMultimodal for image inputs");
        return part.text;
      })
      .join(""),
  }));
}

/** Keeps existing routing, strict-schema fallback, interruption and output-limit behavior. */
export function createModelPort(options: {
  gateway?: TextModelGateway;
  vision?: VisionClient;
}): ModelPort {
  return {
    defaultModel: options.gateway?.config?.model,
    async complete(request) {
      if (!options.gateway) throw new Error("Text model gateway is not configured");
      return options.gateway.complete({ ...request, messages: gatewayMessages(request.messages) });
    },
    async *streamText(request) {
      if (!options.gateway?.streamChat)
        throw new Error("Streaming text model gateway is not configured");
      yield* options.gateway.streamChat({
        ...request,
        messages: gatewayMessages(request.messages),
      });
    },
    async completeMultimodal(request) {
      if (!options.vision) throw new Error("Vision model gateway is not configured");
      return options.vision.annotate(request);
    },
  };
}
