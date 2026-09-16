// Persona compilation — re-exported from the shared contract layer.
//
// The compile rules live in `shared/contracts/persona-compile.ts` so the request
// validation and the persisted system prompt cannot drift apart. They used to be
// two implementations, and the contract copy silently omitted the default
// intensity-60 scaling of the character layer (#91).
//
// See that module for the source mapping (services/agent_config.py:119-167) and
// the reasoning behind the Python-compatible string primitives.

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
