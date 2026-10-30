import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { ConnectionWorkspace } from "../../src/web/screens/connections/ConnectionWorkspace";
import { Preferences } from "../../src/web/screens/environment/Preferences";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each([
  "capability-memory",
  "capability-knowledge",
  "session-history",
  "media-tools",
  "qq-member-tools",
] as const)("%s has one owning page title without implicitly loading an Agent", async (route) => {
  const getAgent = vi.fn();
  setupLibrary({
    getAgent,
    getPermissions: vi.fn().mockRejectedValue(new Error("read unavailable")),
    getToolDirectory: vi.fn().mockResolvedValue({ tools: [] }),
    getSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
  });
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: route });
  render(<CapabilitiesWorkspace active={false} />);
  await act(async () => {});
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(getAgent).not.toHaveBeenCalled();
});
it("preferences is content inside its existing sheet viewport, not another full-height scroll root", () => {
  setupLibrary();
  const { container } = render(<Preferences active={false} />);
  const content = container.firstElementChild;
  expect(content?.className).not.toMatch(/h-full|overflow-y-auto/);
  expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(0);
});
it("retains extension panels without creating a second set of metadata requests", async () => {
  const getSkills = vi.fn().mockResolvedValue({ skills: [] });
  const getMcpServers = vi.fn().mockResolvedValue({ servers: [] });
  setupLibrary({
    getSkills,
    getMcpServers,
    getPermissions: vi.fn().mockRejectedValue(new Error("unavailable")),
  });
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "skill-catalog" });
  const view = render(<ConnectionWorkspace active={false} />);
  await act(async () => {});
  expect(getSkills).not.toHaveBeenCalled();
  expect(getMcpServers).not.toHaveBeenCalled();
  view.rerender(<ConnectionWorkspace active={false} />);
  expect(getSkills).not.toHaveBeenCalled();
  expect(api).toBeTruthy();
});
