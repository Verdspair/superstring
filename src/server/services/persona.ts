// Persona compilation — re-exported from the shared contract layer.
// Request validation and persistence share shared/contracts/persona-compile.ts
// including default intensity-60 scaling (#91).
// See that module for the mapping and
// the reasoning behind the code-point string primitives.

export {
  compilePersona,
  EXAMPLE_DIALOGUE_GUARD,
  isCompiledPersonaWithinLimit,
  MAX_COMPILED_PERSONA_LENGTH,
  PERSONA_CHARACTER_FIELDS,
  PERSONA_IDENTITY_FIELDS,
  PERSONA_INTENSITY_DEFAULT,
  PERSONA_INTENSITY_MAX,
  PERSONA_INTENSITY_MIN,
  PERSONA_SECTION_TITLES,
  type PersonaSource,
  scaleCharacterText,
} from "../../shared/contracts/persona-compile";
