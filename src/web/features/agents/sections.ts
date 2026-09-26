import type { SectionKey } from "../../store";

/** Compatibility labels used by persisted draft notices; presentation owns its own hierarchy. */
const sectionLetters: Record<SectionKey, string> = {
  A: "A",
  D: "B",
  E: "C",
  G: "D",
  B: "E",
  knowledge: "F",
  C: "G",
  F: "H",
  H: "I",
};
export function sectionLetter(key: SectionKey): string {
  return sectionLetters[key] ?? key;
}
