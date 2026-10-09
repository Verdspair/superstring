import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

const permissionsFixture = {
  revision: "pr-1",
  policy: {
    version: 1,
    grants: [],
    execution: {
      research: false,
      code: false,
      modules: {
        mcp: false,
        skills: false,
        web: true,
        tasks: true,
        memoryJobs: true,
        knowledgeJobs: true,
        qqMedia: true,
        qqStickers: true,
        qqMembers: true,
      },
      maintenance: { memoryTimeoutSeconds: 3600, knowledgeTimeoutSeconds: 3600 },
      telemetry: { retentionDays: 14 },
      pausedTools: [],
      tasks: { concurrency: 2, retentionHours: 24, leaseSeconds: 30, pollMs: 500 },
      researchLimits: { maxPerRun: 2, maxSteps: 6, deadlineMs: 60_000, maxConclusionChars: 4_000 },
      codeLimits: {
        timeoutMs: 20_000,
        maxCalls: 32,
        concurrency: 3,
        memoryBytes: 33_554_432,
        maxTransferBytes: 1_048_576,
        maxConclusionChars: 4_000,
      },
      loop: {
        maxSteps: 16,
        readBatch: 3,
        noProgress: 3,
        concurrency: 4,
        modelConcurrency: 1,
        providerConcurrency: 1,
      },
      qq: { retryDelayMs: 15_000, maxAttempts: 3, deliveryTtlSeconds: 120 },
    },
  },
  resources: [],
};

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests({
    ...api,
    getPermissions: vi.fn().mockResolvedValue(permissionsFixture),
    getToolDirectory: vi.fn().mockResolvedValue({ tools: [] }),
    getSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
  } as unknown as typeof api);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("system capability directory retention", () => {
  it("retains directory search query, DOM element and scroll when navigating to detail and back", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    const { container } = render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    // 1. Enter query in directory search input
    const searchInput = screen.getByRole("textbox", {
      name: "搜索能力、关键词或技术名",
    }) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "联网" } });
    expect(searchInput.value).toBe("联网");

    // 2. Set scroll position on directory scroll container
    const scrollContainer = container.querySelector("[data-workspace-scroll]") as HTMLElement;
    expect(scrollContainer).toBeTruthy();
    scrollContainer.scrollTop = 120;

    // 3. Open one capability detail
    const webButton = screen.getByRole("button", { name: /^联网/ });
    fireEvent.click(webButton);
    await act(async () => {});

    expect(store.getState().settingsRoute).toBe("web-access");
    expect(screen.getByRole("button", { name: "返回系统能力" })).toBeTruthy();

    // 4. Directory should still be in DOM (hidden while detail is visible), keeping input and scroll
    const directorySection = container.querySelector(
      'section[aria-label="系统能力"]',
    ) as HTMLElement;
    expect(directorySection).toBeTruthy();
    expect(directorySection.hidden).toBe(true);

    // 5. Navigate back to directory
    const backButton = screen.getByRole("button", { name: "返回系统能力" });
    fireEvent.click(backButton);
    await act(async () => {});

    expect(store.getState().settingsRoute).toBe("system-capabilities");
    expect(directorySection.hidden).toBe(false);

    // 6. Same query and scroll position retained without re-mounting
    const retainedInput = screen.getByRole("textbox", {
      name: "搜索能力、关键词或技术名",
    }) as HTMLInputElement;
    expect(retainedInput).toBe(searchInput);
    expect(retainedInput.value).toBe("联网");
    expect(scrollContainer.scrollTop).toBe(120);
  });
});
