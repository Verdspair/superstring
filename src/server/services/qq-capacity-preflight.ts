// Capacity check before QQ model calls; never performs inference.
import { z } from "zod";
import type { ModelContextBudget } from "../agent/model-port";
import type { ModelGateway } from "../llm/model-gateway";
import {
  measureContextTokens,
  measurePreparedRequest,
  type PreparedRequestFormat,
} from "../llm/request-format";
import { estimateMessages } from "../modules/memory-query";
import { estimateTokens } from "./token-estimate";

const Input = z.strictObject({
  model: z.string().min(1),
  messages: z.array(z.strictObject({ role: z.enum(["system", "user"]), content: z.string() })),
  outputReserved: z.number().int().min(0).max(1048576),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
});
export type QqCapacityCheck =
  | {
      readonly kind: "allowed";
      /** Existing byte estimate, including the complete schema when supplied. */
      readonly inputUnits: number;
      readonly capacity: number;
      readonly contextBudget?: ModelContextBudget;
      readonly contextInputLimit?: number;
      readonly requestFormat?: PreparedRequestFormat;
    }
  | { readonly kind: "unavailable" | "exceeded" };

/** Missing capacity refuses; an undeclared tokenizer keeps the byte estimate. */
export async function checkQqModelCapacity(
  gateway: Pick<ModelGateway, "loadedContextCapacity"> &
    Partial<Pick<ModelGateway, "prepareContextModel">>,
  input: unknown,
  signal?: AbortSignal,
  prepareVisionRequestFormat?: (input: {
    model: string;
    responseSchema?: Record<string, unknown>;
  }) => PreparedRequestFormat,
): Promise<QqCapacityCheck> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ capacity input");
  const { model, messages, outputReserved, responseSchema } = parsed.data;
  signal?.throwIfAborted();
  let descriptor: ModelContextBudget | undefined;
  let capacity: number | null;
  try {
    descriptor = await gateway.prepareContextModel?.(model, { signal });
    capacity = descriptor
      ? descriptor.capacity
      : await gateway.loadedContextCapacity(model, { signal });
  } catch {
    signal?.throwIfAborted();
    return { kind: "unavailable" };
  }
  signal?.throwIfAborted();
  descriptor?.assertCurrent();
  if (descriptor && descriptor.model !== model) return { kind: "unavailable" };
  if (capacity === null || !Number.isSafeInteger(capacity) || capacity <= 0)
    return { kind: "unavailable" };
  const inputUnits =
    estimateMessages(messages) +
    (responseSchema ? estimateTokens(JSON.stringify(responseSchema)) : 0);
  const limit = capacity - outputReserved;
  const requestFormat = prepareVisionRequestFormat?.({ model, responseSchema });
  const counter =
    descriptor?.countText && descriptor.tokenizerEncoding
      ? { encoding: descriptor.tokenizerEncoding, count: descriptor.countText }
      : undefined;
  const measured =
    requestFormat !== undefined && descriptor !== undefined
      ? measurePreparedRequest(messages, descriptor, requestFormat)
      : undefined;
  const cost =
    measured !== undefined
      ? measured.textTokens
      : counter
        ? measureContextTokens(messages, counter, { responseSchema }).textTokens
        : inputUnits;
  return cost <= limit
    ? {
        kind: "allowed",
        inputUnits,
        capacity,
        ...(descriptor ? { contextBudget: descriptor } : {}),
        ...(counter ? { contextInputLimit: limit } : {}),
        ...(requestFormat ? { requestFormat } : {}),
      }
    : { kind: "exceeded" };
}
