import { streamChat } from "../api";
import type { RuntimeEffects } from "./types";

export const defaultEffects: RuntimeEffects = {
  streamChat,
  requestId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};
