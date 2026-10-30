import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAuxiliaryAllocation,
  GlobalAuxiliaryAllocation,
} from "../../src/shared/contracts/context-allocation";
import { ContextAllocationAuxiliary } from "../../src/web/screens/connections/ContextAllocationAuxiliary";
import { render } from "./helpers/render-with-providers";

describe("ContextAllocationAuxiliary", () => {
  it("only exposes live consolidation and research roles while preserving an old selector profile in changed payloads", () => {
    const legacy = { mode: "fixed" as const, input_limit: 333, output_reserved: 44 };
    const profiles: AgentAuxiliaryAllocation = {
      memory_consolidate: { mode: "fixed", input_limit: 1000 },
      research: { mode: "auto" },
      memory_retrieval_select: legacy,
    };
    const before = structuredClone(profiles);
    const onAgentChange = vi.fn();
    render(
      <ContextAllocationAuxiliary
        scope="agent"
        agentProfiles={profiles}
        onAgentChange={onAgentChange}
      />,
    );
    expect(screen.getByTestId("aux-card-memory_consolidate")).toBeTruthy();
    expect(screen.getByTestId("aux-card-research")).toBeTruthy();
    expect(screen.queryByTestId("aux-card-memory_retrieval_select")).toBeNull();
    expect(screen.queryByTestId("aux-input-limit-memory_retrieval_select")).toBeNull();
    fireEvent.change(screen.getByTestId("aux-input-limit-memory_consolidate"), {
      target: { value: "1200" },
    });
    expect(onAgentChange).toHaveBeenLastCalledWith({
      ...profiles,
      memory_consolidate: { mode: "fixed", input_limit: 1200 },
    });
    expect(onAgentChange.mock.calls.at(-1)?.[0].memory_retrieval_select).toEqual(legacy);
    expect(profiles).toEqual(before);
  });
  afterEach(() => {
    cleanup();
  });

  const initialAgentProfiles: AgentAuxiliaryAllocation = {
    memory_consolidate: { mode: "fixed", input_limit: 1000, output_reserved: 500 },
    memory_retrieval_select: undefined, // inherits default
    research: { mode: "auto", input_limit: null, output_reserved: 1024 },
  };

  const initialGlobalProfiles: GlobalAuxiliaryAllocation = {
    knowledge_organize: { mode: "fixed", input_limit: 2048, output_reserved: 2048 },
    qq_sticker_annotate: { mode: "auto", input_limit: null, output_reserved: 1024 },
    qq_media_describe: undefined, // inherits default
  };

  it("keeps blank, explicit null and positive limits distinct in the mounted editor", () => {
    const onAgentChange = vi.fn();
    render(
      <ContextAllocationAuxiliary
        scope="agent"
        agentProfiles={initialAgentProfiles}
        onAgentChange={onAgentChange}
      />,
    );
    const input = screen.getByTestId("aux-input-limit-memory_consolidate");
    const hintId = input.getAttribute("aria-describedby");
    expect(hintId && document.getElementById(hintId)).toBeTruthy();
    for (const [raw, value] of [
      ["", undefined],
      ["null", null],
      ["-", null],
      ["1200", 1200],
    ] as const) {
      fireEvent.change(input, { target: { value: raw } });
      expect(onAgentChange).toHaveBeenLastCalledWith({
        ...initialAgentProfiles,
        memory_consolidate: { ...initialAgentProfiles.memory_consolidate, input_limit: value },
      });
    }
  });

  it("renders both agent and global sections and handles role mode changes", () => {
    const onAgentChange = vi.fn();
    const onGlobalChange = vi.fn();

    render(
      <ContextAllocationAuxiliary
        agentProfiles={initialAgentProfiles}
        globalProfiles={initialGlobalProfiles}
        onAgentChange={onAgentChange}
        onGlobalChange={onGlobalChange}
        agentName="Test Agent"
      />,
    );

    expect(screen.getByTestId("aux-section-agent")).toBeTruthy();
    expect(screen.getByTestId("aux-section-global")).toBeTruthy();

    // Mode select for memory_consolidate
    const modeSelect = screen.getByTestId(
      "aux-mode-select-memory_consolidate",
    ) as HTMLSelectElement;
    expect(modeSelect.value).toBe("fixed");

    fireEvent.change(modeSelect, { target: { value: "auto" } });
    expect(onAgentChange).toHaveBeenCalledWith(
      expect.objectContaining({
        memory_consolidate: expect.objectContaining({ mode: "auto" }),
        // other roles preserved
        research: expect.objectContaining({ mode: "auto" }),
      }),
    );
  });

  it("handles raw invalid input drafting and reports validity to block save", () => {
    const onAgentChange = vi.fn();
    const onValidityChange = vi.fn();
    const onSaveAgent = vi.fn();

    render(
      <ContextAllocationAuxiliary
        agentProfiles={initialAgentProfiles}
        globalProfiles={initialGlobalProfiles}
        onAgentChange={onAgentChange}
        onValidityChange={onValidityChange}
        onSaveAgent={onSaveAgent}
        canSaveAgent={true}
      />,
    );

    const inputField = screen.getByTestId("aux-input-limit-memory_consolidate") as HTMLInputElement;
    expect(inputField.value).toBe("1000");

    // Enter invalid raw string (e.g. negative or non-numeric)
    fireEvent.change(inputField, { target: { value: "-50" } });

    // Should report validity invalid
    expect(onValidityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        agentValid: false,
      }),
    );

    // Save button should be disabled when invalid
    const saveAgentBtn = screen.getByTestId("aux-save-agent-btn") as HTMLButtonElement;
    expect(saveAgentBtn.disabled).toBe(true);
  });

  it("triggers separate save callbacks for agent and global scopes", () => {
    const onSaveAgent = vi.fn();
    const onSaveGlobal = vi.fn();

    render(
      <ContextAllocationAuxiliary
        agentProfiles={initialAgentProfiles}
        globalProfiles={initialGlobalProfiles}
        onSaveAgent={onSaveAgent}
        onSaveGlobal={onSaveGlobal}
        canSaveAgent={true}
        canSaveGlobal={true}
      />,
    );

    const saveAgentBtn = screen.getByTestId("aux-save-agent-btn") as HTMLButtonElement;
    const saveGlobalBtn = screen.getByTestId("aux-save-global-btn") as HTMLButtonElement;

    fireEvent.click(saveAgentBtn);
    expect(onSaveAgent).toHaveBeenCalledTimes(1);
    expect(onSaveGlobal).not.toHaveBeenCalled();

    fireEvent.click(saveGlobalBtn);
    expect(onSaveGlobal).toHaveBeenCalledTimes(1);
  });

  it("reads host-owned invalid raw first and reports every edit to the host", () => {
    const onInvalidInput = vi.fn();
    const onAgentChange = vi.fn();

    render(
      <ContextAllocationAuxiliary
        agentProfiles={initialAgentProfiles}
        globalProfiles={initialGlobalProfiles}
        invalidInputs={{ memory_consolidate_input_limit: "-50" }}
        onInvalidInput={onInvalidInput}
        onAgentChange={onAgentChange}
      />,
    );

    const inputField = screen.getByTestId("aux-input-limit-memory_consolidate") as HTMLInputElement;
    expect(inputField.value).toBe("-50");

    fireEvent.change(inputField, { target: { value: "2000" } });
    expect(onInvalidInput).toHaveBeenLastCalledWith("memory_consolidate_input_limit", undefined);
    expect(onAgentChange).toHaveBeenCalled();

    fireEvent.change(inputField, { target: { value: "-9" } });
    expect(onInvalidInput).toHaveBeenLastCalledWith("memory_consolidate_input_limit", "-9");
  });

  it("keeps a host-owned invalid value across unmount and remount", () => {
    const props = {
      agentProfiles: initialAgentProfiles,
      globalProfiles: initialGlobalProfiles,
      invalidInputs: { research_output_reserved: "0" },
    };

    render(<ContextAllocationAuxiliary {...props} />);
    expect((screen.getByTestId("aux-output-reserved-research") as HTMLInputElement).value).toBe(
      "0",
    );
    cleanup();

    render(<ContextAllocationAuxiliary {...props} />);
    expect((screen.getByTestId("aux-output-reserved-research") as HTMLInputElement).value).toBe(
      "0",
    );
  });

  it("blocks the scope save while a host-owned invalid raw is present", () => {
    const onValidityChange = vi.fn();

    render(
      <ContextAllocationAuxiliary
        agentProfiles={initialAgentProfiles}
        globalProfiles={initialGlobalProfiles}
        invalidInputs={{ knowledge_organize_input_limit: "abc" }}
        onValidityChange={onValidityChange}
      />,
    );

    const saveGlobalBtn = screen.getByTestId("aux-save-global-btn") as HTMLButtonElement;
    expect(saveGlobalBtn.disabled).toBe(true);
    expect(onValidityChange).toHaveBeenCalledWith(expect.objectContaining({ globalValid: false }));
  });
});
