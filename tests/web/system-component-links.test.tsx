import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { SystemComponents } from "../../src/web/screens/connections/system-components";
import { useSuperstringStore as store } from "../../src/web/store";
import {
  CAPABILITY_CATALOG,
  capabilityComponents,
} from "../../src/web/workspace/capability-catalog";

afterEach(cleanup);
beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests(api);
});

it("links each function to real tools and one system guide without inventing MCP services", () => {
  for (const entry of CAPABILITY_CATALOG) {
    const components = capabilityComponents(entry);
    expect(components.some((component) => component.kind === "tool")).toBe(true);
    expect(components.filter((component) => component.kind === "skill")).toHaveLength(1);
    expect(components.some((component) => component.kind === "mcp")).toBe(false);
  }
});

it("uses the common guarded navigation to open a concrete tool", () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
  });
  const entry = CAPABILITY_CATALOG.find((capability) => capability.detail === "memory");
  if (!entry) throw new Error("missing capability");
  render(<SystemComponents entry={entry} />);
  fireEvent.click(screen.getByRole("button", { name: /memory.query/ }));
  expect(store.getState()).toMatchObject({
    settingsRoute: "tool-grants",
    componentTarget: { kind: "tool", id: "memory.query" },
  });
});
