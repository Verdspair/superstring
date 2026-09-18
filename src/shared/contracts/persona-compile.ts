// Persona compilation — 1:1 with `services/agent_config.py:119-167`.
//
// Request validation and persistence share these compile rules. Both must apply
// the default character intensity of 60 before checking the length limit (#91).
//
// The compile ORDER is contract-visible: it determines the rendered
// `system_prompt`, which is part of the session/Turn snapshot.
//
//   identity layer  : 核心身份 > 互动边界 > 高级补充   (never scaled)
//   character layer : 沟通风格 > 示例对话             (scaled by intensity)
//
// Every present section is rendered as `## <title>\n<content>`, joined by a
// blank line; `示例对话` additionally gets the anti-overfit guard appended.
//
// Pure functions only — no I/O, no server imports.

export const MAX_COMPILED_PERSONA_LENGTH = 16000;

export const PERSONA_INTENSITY_MIN = 0;
export const PERSONA_INTENSITY_MAX = 100;
export const PERSONA_INTENSITY_DEFAULT = 60;

/** agent_config.py:16-18 — field grouping; the tuple order IS the priority. */
export const PERSONA_IDENTITY_FIELDS = [
  "core_identity",
  "interaction_boundaries",
  "advanced_instructions",
] as const;
export const PERSONA_CHARACTER_FIELDS = ["communication_style", "example_dialogues"] as const;

/** agent_config.py:20-22 */
export const EXAMPLE_DIALOGUE_GUARD =
  "以上示例仅示范语气、节奏与措辞习惯，不要复用其中的人物、事实、话题或情节。";

/** Section titles as they appear in the rendered system prompt. */
export const PERSONA_SECTION_TITLES = {
  core_identity: "核心身份",
  interaction_boundaries: "互动边界",
  advanced_instructions: "高级补充",
  communication_style: "沟通风格",
  example_dialogues: "示例对话",
} as const;

// Python string primitives
//
// The primitives live in `./py-string` so the whole contract layer shares ONE
// implementation: `common.ts` needs the same `pyStrip`/`pyLen` to reproduce
// Pydantic's raw-then-strip order, and a second copy would drift.
//
// Re-exported here because callers (and the server's `services/persona.ts`)
// already import them from this module.

import { pyLen, pyRound, pySlice, pyStrip } from "./py-string";

export { pyLen, pyRound, pySlice, pyStrip } from "./py-string";

export interface PersonaSource {
  core_identity?: string;
  communication_style?: string;
  interaction_boundaries?: string;
  example_dialogues?: string;
  advanced_instructions?: string;
}

/**
 * agent_config.py:119-129 — keep the head of the character text proportional to
 * intensity. `0` disables the section entirely, `100` keeps it whole.
 */
export function scaleCharacterText(text: string, intensity: number): string {
  if (!text) return "";
  if (intensity >= PERSONA_INTENSITY_MAX) return text;
  if (intensity <= PERSONA_INTENSITY_MIN) return "";
  const limit = Math.max(1, pyRound((pyLen(text) * intensity) / PERSONA_INTENSITY_MAX));
  return pySlice(text, limit);
}

/**
 * agent_config.py:132-167.
 * `intensity` is clamped to [0, 100]; when omitted the default (60) applies —
 * which is exactly what `validate_compiled_length` relies on (agent_config.py:112).
 */
export function compilePersona(persona: PersonaSource, intensity?: number): string {
  let strength = intensity === undefined ? PERSONA_INTENSITY_DEFAULT : Math.trunc(intensity);
  strength = Math.max(PERSONA_INTENSITY_MIN, Math.min(PERSONA_INTENSITY_MAX, strength));

  const present: Array<[string, string]> = [];

  for (const field of PERSONA_IDENTITY_FIELDS) {
    const content = pyStrip(String(persona[field] ?? ""));
    if (content) present.push([PERSONA_SECTION_TITLES[field], content]);
  }
  for (const field of PERSONA_CHARACTER_FIELDS) {
    const content = pyStrip(String(persona[field] ?? ""));
    const scaled = scaleCharacterText(content, strength);
    if (scaled) present.push([PERSONA_SECTION_TITLES[field], scaled]);
  }

  if (present.length === 0) return "";

  const rendered: string[] = [];
  for (const [title, rawContent] of present) {
    const content =
      title === PERSONA_SECTION_TITLES.example_dialogues
        ? `${rawContent}\n\n${EXAMPLE_DIALOGUE_GUARD}`
        : rawContent;
    rendered.push(`## ${title}\n${content}`);
  }
  return rendered.join("\n\n");
}

/** True when the compiled persona fits the source project's hard limit. */
export function isCompiledPersonaWithinLimit(compiled: string): boolean {
  return pyLen(compiled) <= MAX_COMPILED_PERSONA_LENGTH;
}
