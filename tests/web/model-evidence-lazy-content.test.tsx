import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InspectedContext } from "../../src/shared/contracts/agent-run";
import { selectLocale } from "../../src/web/i18n";
import { InspectedEvidence } from "../../src/web/screens/observability/ModelEvidence";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  selectLocale("zh-CN");
});

function clickTab(name: string | RegExp) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.pointerDown(tab, { button: 0, ctrlKey: false });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
}

describe("InspectedEvidence lazy panel content rendering", () => {
  it("does not evaluate source IDs on initial input render, evaluates when sources opened, and preserves count on output switch", () => {
    let sourceIdReadCount = 0;
    const sourceVersions = Array.from({ length: 1900 }, (_, index) => ({
      get id() {
        sourceIdReadCount++;
        return `source-${index}`;
      },
      revision: `rev-${index}`,
    }));

    const value: InspectedContext = {
      status: "exact",
      layout: [],
      sourceVersions,
      exactMessages: [
        {
          role: "user",
          content: [{ kind: "text", text: "Synthetic prompt input" }],
        },
      ],
      result: {
        status: "exact",
        format: "text",
        text: "Synthetic model reply text",
      },
    };

    render(<InspectedEvidence value={value} />);

    // 1. Initial render default tab is "input":
    // Input content must be visible, but sources table rows should NOT have been constructed or mapped.
    expect(screen.getByText("Synthetic prompt input")).toBeTruthy();
    expect(sourceIdReadCount).toBe(0);

    // 2. Open Sources tab:
    // Sources content is constructed; all 1900 source IDs are read and rendered.
    clickTab(/来源与版本|Sources and revisions/);
    expect(sourceIdReadCount).toBeGreaterThanOrEqual(1900);
    expect(screen.getByText("source-0")).toBeTruthy();
    expect(screen.getByText("source-1899")).toBeTruthy();

    // 3. Switch to Output tab:
    // Output content is visible; sources getter count does NOT increment again on output rerender.
    const countAfterSources = sourceIdReadCount;
    clickTab(/模型输出|Model output/);
    expect(screen.getByText("Synthetic model reply text")).toBeTruthy();
    expect(sourceIdReadCount).toBe(countAfterSources);
  });

  it("renders full content for each tab without pagination cutoff or missing rows", () => {
    const sourceVersions = Array.from({ length: 1900 }, (_, index) => ({
      id: `src-item-${index}`,
      revision: `sha-${index}`,
    }));

    const value: InspectedContext = {
      status: "exact",
      layout: [],
      sourceVersions,
      exactMessages: [
        {
          role: "user",
          content: [{ kind: "text", text: "Full input content prompt" }],
        },
      ],
      result: {
        status: "exact",
        format: "text",
        text: "Full output content reply",
      },
    };

    render(<InspectedEvidence value={value} />);

    // Verify input panel
    expect(screen.getByText("Full input content prompt")).toBeTruthy();

    // Verify output panel
    clickTab(/模型输出|Model output/);
    expect(screen.getByText("Full output content reply")).toBeTruthy();

    // Verify sources panel
    clickTab(/来源与版本|Sources and revisions/);
    expect(screen.getByText("src-item-0")).toBeTruthy();
    expect(screen.getByText("src-item-999")).toBeTruthy();
    expect(screen.getByText("src-item-1899")).toBeTruthy();
  });
});
