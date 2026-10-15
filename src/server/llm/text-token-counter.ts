import { Buffer } from "node:buffer";
import type { BPE } from "@huggingface/tokenizers";

export type TextTokenEncoding = "cl100k_base" | "o200k_base";
export type TextTokenCounter = {
  encoding: TextTokenEncoding;
  count(text: string): number;
};

const encoder = new TextEncoder();
// BPE needs a bijection from bytes to code points, not a text decoder.
const byteString = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");

function modelConfig(ranks: readonly (string | number[])[]): ConstructorParameters<typeof BPE>[0] {
  const pieces = ranks.map((piece) =>
    typeof piece === "string" ? encoder.encode(piece) : new Uint8Array(piece),
  );
  const vocab: Record<string, number> = Object.create(null);
  pieces.forEach((piece, rank) => {
    vocab[byteString(piece)] = rank;
  });
  const merges: [string, string][] = [];
  // Include every valid lower-rank split; priorities come from the token ranks.
  for (let rank = 256; rank < pieces.length; rank++) {
    const piece = pieces[rank];
    for (let split = 1; split < piece.length; split++) {
      const left = byteString(piece.subarray(0, split));
      const right = byteString(piece.subarray(split));
      const leftRank = vocab[left],
        rightRank = vocab[right];
      if (leftRank !== undefined && rightRank !== undefined && leftRank < rank && rightRank < rank)
        merges.push([left, right]);
    }
  }
  return {
    type: "BPE",
    vocab,
    merges,
    unk_token: null,
    end_of_word_suffix: "",
    fuse_unk: false,
    byte_fallback: false,
    ignore_merges: true,
  };
}

const counters: Partial<Record<TextTokenEncoding, Promise<TextTokenCounter>>> = {};

/** Known-encoding plain text only; request templates and media remain separate estimates. */
export async function loadTextTokenCounter(encoding: TextTokenEncoding): Promise<TextTokenCounter> {
  const current = counters[encoding];
  if (current) return current;
  const pending = createCounter(encoding);
  counters[encoding] = pending;
  return pending;
}

async function createCounter(encoding: TextTokenEncoding): Promise<TextTokenCounter> {
  const { BPE } = await import("@huggingface/tokenizers");
  const patterns = await import("gpt-tokenizer/encodingParams/constants");
  let ranks: (string | number[])[];
  let pattern: RegExp;
  switch (encoding) {
    case "cl100k_base":
      ranks = (await import("gpt-tokenizer/bpeRanks/cl100k_base")).default;
      pattern = patterns.CL100K_TOKEN_SPLIT_REGEX;
      break;
    case "o200k_base":
      ranks = (await import("gpt-tokenizer/bpeRanks/o200k_base")).default;
      pattern = patterns.O200K_TOKEN_SPLIT_REGEX;
      break;
    default:
      throw new RangeError(`Unsupported text token encoding: ${encoding}`);
  }
  const config = modelConfig(ranks);
  const model = new BPE(config);
  // Alternative splits of the same bytes share their token rank. The heap's
  // position tie-break then matches the rank table's leftmost-merge rule.
  for (const [left, right] of model.merges)
    model.bpe_ranks.set(JSON.stringify([left, right]), config.vocab[left + right]);
  model.max_length_to_cache = 0;
  return {
    encoding,
    count(text) {
      let count = 0;
      // Summation is valid only across the encoding's own pre-token boundaries,
      // not arbitrary message fragments. Special-looking text is ordinary input.
      for (const match of text.matchAll(pattern)) {
        const piece =
          Buffer.byteLength(match[0], "utf8") === match[0].length
            ? match[0]
            : Buffer.from(match[0], "utf8").toString("latin1");
        count += model.tokens_to_ids.has(piece) ? 1 : model.bpe(piece).length;
      }
      return count;
    },
  };
}
