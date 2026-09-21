export interface KnowledgeSegment {
  ordinal: number;
  start: number;
  end: number;
  body: string;
}

export const utf8Size = (text: string): number => Buffer.byteLength(text, "utf8");

/** UTF-16 half-open offsets, matching String.slice and the content contract.
 * Never split decimals, surrogate pairs or an oversized sentence to meet a budget.
 */
export function knowledgeSegments(text: string, targetBytes = 1536): KnowledgeSegment[] {
  if (!Number.isInteger(targetBytes) || targetBytes < 1) throw new Error("Invalid segment budget");
  const sentences = text.matchAll(/[\s\S]+?(?:[。！？!?]+|\.(?=\s|$)|\r\n|[\r\n]|$)/gu);
  const result: KnowledgeSegment[] = [];
  let start = 0;
  let end = 0;
  const emit = () => {
    if (end > start)
      result.push({ ordinal: result.length, start, end, body: text.slice(start, end) });
    start = end;
  };
  for (const match of sentences) {
    const next = match.index + match[0].length;
    if (end > start && utf8Size(text.slice(start, next)) > targetBytes) emit();
    end = next;
  }
  emit();
  return result;
}
