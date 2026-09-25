// P3n/P3o: capacity check before QQ model calls; no model completion or sending.
import { z } from "zod";
import { type QqSchemeOutputReserve, QqSchemeOutputReserveSchema } from "../../shared/contracts/qq";
import type { ModelGateway } from "../llm/model-gateway";
import { estimateMessages } from "./context-builder";

export function parseQqSchemeOutputReserve(input: unknown): QqSchemeOutputReserve {
  const result = QqSchemeOutputReserveSchema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ output reserve input");
  return Object.freeze(result.data);
}

const Input = z.strictObject({
  model: z.string().min(1),
  messages: z.array(z.strictObject({ role: z.enum(["system", "user"]), content: z.string() })),
  /** Explicit output reservation: cannot guess a reply size for the user. */
  outputReserved: z.number().int().min(256).max(16384),
});
export type QqCapacityCheck =
  | { readonly kind: "allowed"; readonly inputUnits: number; readonly capacity: number }
  | { readonly kind: "unavailable" | "exceeded" };

/** A capacity probe returning null/error is a refusal, never a fallback to a made-up size. */
export async function checkQqModelCapacity(
  gateway: Pick<ModelGateway, "loadedContextCapacity">,
  input: unknown,
): Promise<QqCapacityCheck> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ capacity input");
  const { model, messages, outputReserved } = parsed.data;
  let capacity: number | null;
  try {
    capacity = await gateway.loadedContextCapacity(model);
  } catch {
    return { kind: "unavailable" };
  }
  if (capacity === null || !Number.isSafeInteger(capacity) || capacity <= 0)
    return { kind: "unavailable" };
  const inputUnits = estimateMessages(messages);
  return inputUnits + outputReserved <= capacity
    ? { kind: "allowed", inputUnits, capacity }
    : { kind: "exceeded" };
}
