import type { ModelMessage } from "../../shared/contracts/agent-run";
import type { ModelContextBudget } from "../agent/model-port";
import { estimateTokens } from "../services/token-estimate";
import type { ChatMessage } from "./chat-content";
import type { ModelTool } from "./model-gateway";
import type { StructuredOutputLevel } from "./strict-json-schema";
import type { TextTokenEncoding } from "./text-token-counter";

/**
 * 一次请求文本量的唯一计量原语。只把"实际发送的文本请求形态"序列化成一份 JSON 后整体计数，
 * 不分段求和、不套常量、不做 floor 换算；不改任何既有计量与运行时门控。
 */
export interface ContextTokenMeasureOptions {
  /** 本次实际发送的响应 schema（网关转换后的形态由调用点传入）。 */
  responseSchema?: Record<string, unknown>;
  /** 网关本次实际发送的格式，覆盖便利的 schema 包装。 */
  responseFormat?: Record<string, unknown>;
  /** 本次实际发送的 function 工具声明。 */
  tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[];
}

export interface ContextTokenMeasure {
  /** 计量方法名：序列化的 chat 文本请求估算，不是 provider 完整请求的精确 token 数。 */
  method: "serialized_chat_token_estimate";
  encoding: TextTokenEncoding;
  /** 只覆盖本次序列化生成的文本；图片成本不在其中。 */
  textTokens: number;
  /** 有图时为 `unknown`（不是 0）。 */
  mediaState: "none" | "unknown";
}

function contextTextProjection(
  messages: readonly (ModelMessage | ChatMessage)[],
  options?: ContextTokenMeasureOptions,
): { text: string; mediaState: ContextTokenMeasure["mediaState"] } {
  let mediaState: ContextTokenMeasure["mediaState"] = "none";
  const serializedMessages = messages.map((message) => {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => {
              if ("kind" in part && part.kind === "text") return part.text;
              if ("type" in part && part.type === "text") return part.text;
              mediaState = "unknown";
              return "";
            })
            .join("");
    return { role: message.role, content: text };
  });
  const request: Record<string, unknown> = { messages: serializedMessages };
  if (options?.responseFormat !== undefined) request.response_format = options.responseFormat;
  else if (options?.responseSchema !== undefined)
    request.response_format = {
      type: "json_schema",
      json_schema: { name: "superstring_result", strict: true, schema: options.responseSchema },
    };
  if (options?.tools !== undefined)
    request.tools = options.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  return { text: JSON.stringify(request), mediaState };
}

export function measureContextTokens(
  messages: readonly (ModelMessage | ChatMessage)[],
  counter: { encoding: TextTokenEncoding; count(text: string): number },
  options?: ContextTokenMeasureOptions,
): ContextTokenMeasure {
  const projection = contextTextProjection(messages, options);
  return {
    method: "serialized_chat_token_estimate",
    encoding: counter.encoding,
    textTokens: counter.count(projection.text),
    mediaState: projection.mediaState,
  };
}

/** Independent UTF-8 hard quota for the complete model-visible text projection. */
export function measureContextBytes(
  messages: readonly (ModelMessage | ChatMessage)[],
  options?: ContextTokenMeasureOptions,
): number {
  return estimateTokens(contextTextProjection(messages, options).text);
}

/** OpenAI function names cannot contain the dots used by the host action catalog. */
export function nativeToolDeclarations(tools: readonly ModelTool[]): {
  tools: ModelTool[];
  wireNames: ReadonlyMap<string, string>;
} {
  const validName = /^[A-Za-z0-9_-]{1,64}$/;
  const reserved = new Set(
    tools.filter((tool) => validName.test(tool.name)).map((tool) => tool.name),
  );
  const wireNames = new Map<string, string>();
  let nextAlias = 0;
  const declarations = tools.map((tool): ModelTool => {
    let name = tool.name;
    if (!validName.test(name)) {
      do {
        name = `ss_action_${nextAlias++}`;
      } while (reserved.has(name));
      reserved.add(name);
    }
    wireNames.set(name, tool.name);
    return name === tool.name
      ? tool
      : {
          ...tool,
          name,
          description: `${tool.description}\nHost action: ${tool.name}. Use ${name} for native function calls; keep the host name in JSON decisions.`,
        };
  });
  return { tools: declarations, wireNames };
}

/** Accept an already prepared wire schema; transport dialect selection stays with the caller. */
export function modelRequestFormat(
  schema: unknown,
  level: StructuredOutputLevel,
  tools?: readonly ModelTool[],
): Record<string, unknown> {
  return {
    ...(tools === undefined
      ? {}
      : {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
    ...(schema === undefined || level === "none"
      ? {}
      : {
          response_format:
            level === "json_object"
              ? { type: "json_object" }
              : {
                  type: "json_schema",
                  json_schema: { name: "superstring_result", strict: true, schema },
                },
        }),
  };
}

/** One logical request's chosen transport shape; process capability state stays at the gateway. */
export interface PreparedRequestFormat {
  readonly level: StructuredOutputLevel;
  readonly schema: unknown;
  readonly tools: readonly ModelTool[] | undefined;
  readonly wireNames: ReadonlyMap<string, string>;
}

export function preparedRequestMeasure(format: PreparedRequestFormat): {
  responseFormat?: Record<string, unknown>;
  tools?: readonly ModelTool[];
} {
  const fields = modelRequestFormat(format.schema, format.level, format.tools);
  return {
    ...(fields.response_format === undefined
      ? {}
      : { responseFormat: fields.response_format as Record<string, unknown> }),
    ...(format.tools === undefined ? {} : { tools: format.tools }),
  };
}

/** Measure a prepared call's text projection without creating another counting policy. */
export function measurePreparedRequest(
  messages: readonly (ModelMessage | ChatMessage)[],
  budget: ModelContextBudget | undefined,
  format?: PreparedRequestFormat,
): ContextTokenMeasure | undefined {
  if (!budget?.countText || !budget.tokenizerEncoding) return undefined;
  budget.assertCurrent();
  const measured = measureContextTokens(
    messages,
    { encoding: budget.tokenizerEncoding, count: budget.countText },
    format === undefined ? undefined : preparedRequestMeasure(format),
  );
  budget.assertCurrent();
  return measured;
}
