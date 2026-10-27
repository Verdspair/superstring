import type { ContextMessage } from "../db/context-repository";
import { fail } from "../errors";
import { fullCasefold } from "../services/casefold-table";
import { estimateTokens } from "../services/token-estimate";

export function estimateMessages(messages: ContextMessage[]): number {
  return (
    3 +
    messages.reduce(
      (sum, message) => sum + 12 + estimateTokens(message.role) + estimateTokens(message.content),
      0,
    )
  );
}

export function contextKeywords(text: string): string[] {
  const words = fullCasefold(text).match(/[a-zA-Z0-9_]{2,}|[\u3400-\u9fff]+/g) ?? [];
  const pieces: string[] = [];
  for (const word of words) {
    const isAscii = [...word].every((char) => (char.codePointAt(0) ?? 128) <= 0x7f);
    if (word.length <= 4 || isAscii) {
      pieces.push(word);
    } else {
      for (let index = 0; index < word.length - 1; index += 1) {
        pieces.push(word.slice(index, index + 2));
      }
    }
  }
  return [...new Set(pieces)].slice(0, 24);
}

export function validateContextIds(ids: string[], allowed: string[], limit?: number): string[] {
  const permitted = new Set(allowed);
  if (ids.length !== new Set(ids).size || ids.some((id) => !permitted.has(id))) {
    fail("CONTEXT_INVALID_SELECTION", "辅助模型返回重复、未授权或候选之外的来源ID");
  }
  if (limit !== undefined && ids.length > limit) {
    fail("CONTEXT_INVALID_SELECTION", "辅助模型选择条数超过配置限制");
  }
  return ids;
}
