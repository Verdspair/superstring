import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { ConnectionWorkspace } from "../../src/web/screens/connections/ConnectionWorkspace";
import { ModelServices } from "../../src/web/screens/environment/ModelServices";
import { LibraryWorkspace } from "../../src/web/screens/library/LibraryWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

vi.mock("../../src/web/screens/library/KnowledgeLibrary", async () => {
  const React = await import("react");
  return {
    KnowledgeLibrary: ({ active = true }: { active?: boolean }) => {
      const [draft, setDraft] = React.useState("");
      return (
        <section data-testid="knowledge-panel" data-active={active}>
          <input
            aria-label="knowledge draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div data-testid="knowledge-scroll" style={{ height: 40, overflow: "auto" }}>
            <div style={{ height: 200 }}>knowledge content</div>
          </div>
        </section>
      );
    },
  };
});
vi.mock("../../src/web/screens/library/MemoryLibrary", async () => {
  const React = await import("react");
  return {
    MemoryLibrary: ({ active = true }: { active?: boolean }) => {
      const [draft, setDraft] = React.useState("");
      return (
        <section data-testid="memory-panel" data-active={active}>
          <input
            aria-label="memory draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div data-testid="memory-scroll" style={{ height: 40, overflow: "auto" }}>
            <div style={{ height: 200 }}>memory content</div>
          </div>
        </section>
      );
    },
  };
});
vi.mock("../../src/web/screens/library/StickerLibrary", async () => {
  const React = await import("react");
  return {
    StickerLibrary: ({ active = true }: { active?: boolean }) => {
      const [draft, setDraft] = React.useState("");
      return (
        <section data-testid="stickers-panel" data-active={active}>
          <input
            aria-label="stickers draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div data-testid="stickers-scroll" style={{ height: 40, overflow: "auto" }}>
            <div style={{ height: 200 }}>sticker content</div>
          </div>
        </section>
      );
    },
  };
});
vi.mock("../../src/web/screens/connections/mcp-panel", async () => {
  const React = await import("react");
  return {
    McpPanel: ({ active = true }: { active?: boolean }) => {
      const [draft, setDraft] = React.useState("");
      return (
        <section data-testid="mcp-panel" data-active={active}>
          <input
            aria-label="mcp draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div data-testid="mcp-scroll" style={{ height: 40, overflow: "auto" }}>
            <div style={{ height: 200 }}>mcp content</div>
          </div>
        </section>
      );
    },
  };
});
vi.mock("../../src/web/screens/connections/skills-panel", async () => {
  const React = await import("react");
  return {
    SkillsPanel: ({ active = true }: { active?: boolean }) => {
      const [draft, setDraft] = React.useState("");
      return (
        <section data-testid="skills-panel" data-active={active}>
          <input
            aria-label="skills draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div data-testid="skills-scroll" style={{ height: 40, overflow: "auto" }}>
            <div style={{ height: 200 }}>skills content</div>
          </div>
        </section>
      );
    },
  };
});
vi.mock("../../src/web/screens/connections/tool-directory-panel", async () => {
  const React = await import("react");
  return {
    ToolDirectoryPanel: ({ active = true }: { active?: boolean }) => {
      const [draft, setDraft] = React.useState("");
      return (
        <section data-testid="grants-panel" data-active={active}>
          <input
            aria-label="grants draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div data-testid="grants-scroll" style={{ height: 40, overflow: "auto" }}>
            <div style={{ height: 200 }}>grants content</div>
          </div>
        </section>
      );
    },
  };
});

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests({
    ...api,
    listModelProviders: vi.fn().mockResolvedValue([]),
    testModelProvider: vi.fn().mockResolvedValue({ ok: true, models: [], error: null }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function visit(
  route:
    | "long-memory"
    | "knowledge-config"
    | "qq-stickers"
    | "mcp-servers"
    | "skill-catalog"
    | "tool-grants"
    | "models"
    | "external-api",
) {
  act(() => store.getState().openSettingsRoute(route));
}

function expectPanel(panel: string, draft: string) {
  const root = screen.getByTestId(`${panel}-panel`);
  expect((root.querySelector("input[aria-label]") as HTMLInputElement).value).toBe(draft);
}

describe("workspace panel retention", () => {
  it("retains only visited library panels with drafts and scroll positions", () => {
    store.setState({ settingsRoute: "long-memory" });
    render(<LibraryWorkspace />);
    const memoryPanel = screen.getByTestId("memory-panel");
    fireEvent.change(screen.getByRole("textbox", { name: "memory draft" }), {
      target: { value: "memory draft" },
    });
    const workspaceScroll = screen.getByTestId("library-workspace-scroll");
    workspaceScroll.scrollTop = 37;
    fireEvent.scroll(workspaceScroll);

    visit("knowledge-config");
    expect((screen.getByTestId("library-workspace-scroll") as HTMLDivElement).scrollTop).toBe(0);
    expect(memoryPanel.getAttribute("data-active")).toBe("false");
    expect(screen.queryByTestId("stickers-panel")).toBeNull();
    const knowledgePanel = screen.getByTestId("knowledge-panel");
    fireEvent.change(screen.getByRole("textbox", { name: "knowledge draft" }), {
      target: { value: "knowledge draft" },
    });
    workspaceScroll.scrollTop = 19;
    fireEvent.scroll(workspaceScroll);

    visit("qq-stickers");
    expect((screen.getByTestId("library-workspace-scroll") as HTMLDivElement).scrollTop).toBe(0);
    expect(knowledgePanel.getAttribute("data-active")).toBe("false");
    const stickerPanel = screen.getByTestId("stickers-panel");
    fireEvent.change(screen.getByRole("textbox", { name: "stickers draft" }), {
      target: { value: "sticker draft" },
    });
    workspaceScroll.scrollTop = 11;
    fireEvent.scroll(workspaceScroll);

    visit("long-memory");
    expect(screen.getByTestId("memory-panel")).toBe(memoryPanel);
    expect(screen.getByTestId("knowledge-panel")).toBe(knowledgePanel);
    expect(screen.getByTestId("stickers-panel")).toBe(stickerPanel);
    expect(memoryPanel.getAttribute("data-active")).toBe("true");
    expect(knowledgePanel.getAttribute("data-active")).toBe("false");
    expect(stickerPanel.getAttribute("data-active")).toBe("false");
    expectPanel("memory", "memory draft");
    expectPanel("knowledge", "knowledge draft");
    expectPanel("stickers", "sticker draft");
    expect((screen.getByTestId("library-workspace-scroll") as HTMLDivElement).scrollTop).toBe(37);
  });

  it("retains visited connection panels and activates only the selected panel", () => {
    store.setState({ settingsRoute: "mcp-servers" });
    render(<ConnectionWorkspace />);
    const mcpPanel = screen.getByTestId("mcp-panel");
    fireEvent.change(screen.getByRole("textbox", { name: "mcp draft" }), {
      target: { value: "mcp draft" },
    });

    visit("skill-catalog");
    expect(mcpPanel.getAttribute("data-active")).toBe("false");
    expect(screen.queryByTestId("grants-panel")).toBeNull();
    const skillsPanel = screen.getByTestId("skills-panel");
    fireEvent.change(screen.getByRole("textbox", { name: "skills draft" }), {
      target: { value: "skills draft" },
    });

    visit("tool-grants");
    expect(skillsPanel.getAttribute("data-active")).toBe("false");
    const grantsPanel = screen.getByTestId("grants-panel");
    fireEvent.change(screen.getByRole("textbox", { name: "grants draft" }), {
      target: { value: "grants draft" },
    });

    visit("mcp-servers");
    expect(screen.getByTestId("mcp-panel")).toBe(mcpPanel);
    expect(screen.getByTestId("skills-panel")).toBe(skillsPanel);
    expect(screen.getByTestId("grants-panel")).toBe(grantsPanel);
    expect(mcpPanel.getAttribute("data-active")).toBe("true");
    expect(skillsPanel.getAttribute("data-active")).toBe("false");
    expect(grantsPanel.getAttribute("data-active")).toBe("false");
    expectPanel("mcp", "mcp draft");
    expectPanel("skills", "skills draft");
    expectPanel("grants", "grants draft");
  });

  it("retains the provider editor draft and scroll across model resource aliases", async () => {
    const create = vi.fn();
    store.setState({
      settingsRoute: "models",
      refreshModels: vi.fn().mockResolvedValue(undefined),
      apiClient: { ...store.getState().apiClient, createModelProvider: create },
    });
    render(<ModelServices />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    const name = screen.getByRole("textbox", { name: "名称" });
    fireEvent.change(name, { target: { value: "Provider draft" } });
    const sheet = screen.getByRole("dialog");
    sheet.scrollTop = 37;
    fireEvent.scroll(sheet);

    visit("external-api");
    expect(screen.getByRole("dialog")).toBe(sheet);
    expect((screen.getByRole("textbox", { name: "名称" }) as HTMLInputElement).value).toBe(
      "Provider draft",
    );
    expect(sheet.scrollTop).toBe(37);
    visit("models");
    expect(screen.getByRole("dialog")).toBe(sheet);
    expect((name as HTMLInputElement).value).toBe("Provider draft");
    expect(sheet.scrollTop).toBe(37);
    expect(create).not.toHaveBeenCalled();
  });
});
