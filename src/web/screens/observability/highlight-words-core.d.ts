import "highlight-words-core";

declare module "highlight-words-core" {
  // The package exports this matcher; @types currently describes only the merged findAll API.
  export function findChunks(args: FindChunksArgs): Pick<Chunk, "start" | "end">[];
}
