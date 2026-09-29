import type { ActionDescription } from "./agent-specs";
import type { BuiltInAction } from "./built-in-actions";

export interface ToolDescriptor extends Omit<ActionDescription, "effect"> {
  readonly effect: "read" | "write";
  readonly sandboxCallable: boolean;
}
export interface ToolCatalog {
  get(name: string): ToolDescriptor | undefined;
  sandboxable(): readonly ToolDescriptor[];
  advertised(): readonly ActionDescription[];
}
export function describeTool(action: BuiltInAction): ToolDescriptor {
  const effect = action.description.effect ?? "write";
  return Object.freeze({
    ...action.description,
    effect,
    sandboxCallable: effect === "read" && action.sandboxCallable !== false,
  });
}
export function createToolCatalog(actions: readonly BuiltInAction[]): ToolCatalog {
  const descriptors = Object.freeze(actions.map(describeTool));
  const byName = new Map<string, ToolDescriptor>();
  for (const descriptor of descriptors) {
    if (byName.has(descriptor.name)) throw new Error(`TOOL_CATALOG_DUPLICATE: ${descriptor.name}`);
    byName.set(descriptor.name, descriptor);
  }
  return {
    get: (name) => byName.get(name),
    sandboxable: () => descriptors.filter((descriptor) => descriptor.sandboxCallable),
    advertised: () => actions.map((action) => ({ ...action.description })),
  };
}
export function advertisedActions(catalog: ToolCatalog): readonly ActionDescription[] {
  return catalog.advertised();
}
