import { streamChatV2 } from "../api";
import type { RuntimeEffects } from "./types";

export const defaultEffects: RuntimeEffects = {
  streamChatV2,
  requestId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};
