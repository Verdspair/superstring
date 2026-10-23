import { cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalPresets } from "../../src/shared/contracts/models";
import { ContextAllocationReading } from "../../src/web/screens/connections/ContextAllocationReading";
import { render } from "./helpers/render-with-providers";

describe("ContextAllocationReading", () => {
  afterEach(() => {
    cleanup();
  });

  const initialPresets: RetrievalPresets = {
    conservative: {
      candidate_limit: 10,
      max_entries: 5,
      max_tokens: 2048,
      relevance_instruction: "strict",
    },
    standard: {
      candidate_limit: 20,
      max_entries: 10,
      max_tokens: 4096,
      relevance_instruction: "standard",
    },
    broad: {
      candidate_limit: 50,
      max_entries: 20,
      max_tokens: 8192,
      relevance_instruction: "broad",
    },
  };

  it("renders memory presets and knowledge budgets with controlled edits", () => {
    const onPresetBudget = vi.fn();
    const onKnowledgeGlobalBudget = vi.fn();
    const onKnowledgeAgentBudget = vi.fn();

    render(
      <ContextAllocationReading
        presets={initialPresets}
        knowledgeGlobalBudget={50000}
        knowledgeAgentBudget={null}
        agentName="FinanceBot"
        onPresetBudget={onPresetBudget}
        onKnowledgeGlobalBudget={onKnowledgeGlobalBudget}
        onKnowledgeAgentBudget={onKnowledgeAgentBudget}
      />,
    );

    expect(screen.getByTestId("reading-section-memory")).toBeTruthy();
    expect(screen.getByTestId("reading-section-knowledge-global")).toBeTruthy();
    expect(screen.getByTestId("reading-section-knowledge-agent")).toBeTruthy();

    // Check conservative preset max_tokens byte input edit
    const conservativeInput = screen.getByTestId(
      "reading-preset-max-tokens-conservative",
    ) as HTMLInputElement;
    expect(conservativeInput.value).toBe("2048");

    fireEvent.change(conservativeInput, { target: { value: "3000" } });
    expect(onPresetBudget).toHaveBeenCalledWith("conservative", 3000);
    expect(onPresetBudget.mock.calls[0][0]).toBe("conservative");
  });

  it("handles agent knowledge budget inheritance toggle and numeric override", () => {
    const onKnowledgeAgentBudget = vi.fn();

    render(
      <ContextAllocationReading
        knowledgeGlobalBudget={65536}
        knowledgeAgentBudget={null}
        onKnowledgeAgentBudget={onKnowledgeAgentBudget}
      />,
    );

    // When null, inherit checkbox is checked, and effective value displays global value
    const inheritCheckbox = screen.getByTestId("reading-knowledge-agent-inherit-checkbox");
    expect(inheritCheckbox.getAttribute("aria-checked")).toBe("true");

    const effectiveText = screen.getByTestId("reading-knowledge-agent-effective-source");
    expect(effectiveText.textContent).toContain("65536");

    // Uncheck inherit to override
    fireEvent.click(inheritCheckbox);
    expect(onKnowledgeAgentBudget).toHaveBeenCalledWith(65536);
  });

  it("does not invent a fallback quota when overriding without a known global budget", () => {
    const onKnowledgeAgentBudget = vi.fn();

    function Host() {
      const [invalidInputs, setInvalidInputs] = useState<Record<string, string>>({});
      return (
        <ContextAllocationReading
          knowledgeGlobalBudget={null}
          knowledgeAgentBudget={null}
          onKnowledgeAgentBudget={onKnowledgeAgentBudget}
          onSaveKnowledgeAgent={() => {}}
          invalidInputs={invalidInputs}
          onInvalidInput={(key, raw) => setInvalidInputs(raw === undefined ? {} : { [key]: raw })}
        />
      );
    }
    render(<Host />);

    fireEvent.click(screen.getByTestId("reading-knowledge-agent-inherit-checkbox"));

    // No arbitrary 65536 fallback: the override stays empty and no value is emitted.
    const agentInput = screen.getByTestId(
      "reading-knowledge-agent-budget-input",
    ) as HTMLInputElement;
    expect(agentInput.value).toBe("");
    expect(onKnowledgeAgentBudget).not.toHaveBeenCalled();

    // The empty override is invalid, so the save stays blocked.
    const saveBtn = screen.getByTestId("reading-save-knowledge-agent-btn") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it("validates numeric range 1..1048576, blocks saves and reports invalidity", () => {
    const onPresetBudget = vi.fn();
    const onValidityChange = vi.fn();
    const onSaveMemory = vi.fn();

    render(
      <ContextAllocationReading
        presets={initialPresets}
        knowledgeGlobalBudget={50000}
        knowledgeAgentBudget={20000}
        onPresetBudget={onPresetBudget}
        onValidityChange={onValidityChange}
        onSaveMemory={onSaveMemory}
        canSaveMemory={true}
      />,
    );

    const standardInput = screen.getByTestId(
      "reading-preset-max-tokens-standard",
    ) as HTMLInputElement;
    fireEvent.change(standardInput, { target: { value: "-10" } });

    expect(onValidityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryValid: false,
      }),
    );

    const saveMemoryBtn = screen.getByTestId("reading-save-memory-btn") as HTMLButtonElement;
    expect(saveMemoryBtn.disabled).toBe(true);
  });

  it("reports every invalid raw to the host and clears the entry once valid", () => {
    const onInvalidInput = vi.fn();
    const onKnowledgeGlobalBudget = vi.fn();

    render(
      <ContextAllocationReading
        knowledgeGlobalBudget={50000}
        knowledgeAgentBudget={null}
        onInvalidInput={onInvalidInput}
        onKnowledgeGlobalBudget={onKnowledgeGlobalBudget}
      />,
    );

    const globalInput = screen.getByTestId(
      "reading-knowledge-global-budget-input",
    ) as HTMLInputElement;

    fireEvent.change(globalInput, { target: { value: "abc" } });
    expect(onInvalidInput).toHaveBeenLastCalledWith("knowledgeGlobal", "abc");

    fireEvent.change(globalInput, { target: { value: "60000" } });
    expect(onInvalidInput).toHaveBeenLastCalledWith("knowledgeGlobal", undefined);
    expect(onKnowledgeGlobalBudget).toHaveBeenLastCalledWith(60000);
  });

  it("shows host-owned invalid raw and blocks save until the invalid key is cleared", () => {
    const onValidityChange = vi.fn();
    const onSaveKnowledgeGlobal = vi.fn();

    const { rerender } = render(
      <ContextAllocationReading
        knowledgeGlobalBudget={50000}
        knowledgeAgentBudget={null}
        invalidInputs={{ knowledgeGlobal: "99999999999" }}
        onValidityChange={onValidityChange}
        onSaveKnowledgeGlobal={onSaveKnowledgeGlobal}
        canSaveKnowledgeGlobal={true}
      />,
    );

    const globalInput = screen.getByTestId(
      "reading-knowledge-global-budget-input",
    ) as HTMLInputElement;
    expect(globalInput.value).toBe("99999999999");
    expect(
      (screen.getByTestId("reading-save-knowledge-global-btn") as HTMLButtonElement).disabled,
    ).toBe(true);

    // Host clears the invalid entry after a valid edit; the save unlocks.
    rerender(
      <ContextAllocationReading
        knowledgeGlobalBudget={50000}
        knowledgeAgentBudget={null}
        invalidInputs={{}}
        onValidityChange={onValidityChange}
        onSaveKnowledgeGlobal={onSaveKnowledgeGlobal}
        canSaveKnowledgeGlobal={true}
      />,
    );
    expect(
      (screen.getByTestId("reading-save-knowledge-global-btn") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("keeps validity hidden-proof across purpose switches: inherited toggle drops the invalid field", () => {
    const onInvalidInput = vi.fn();
    const onKnowledgeAgentBudget = vi.fn();

    render(
      <ContextAllocationReading
        knowledgeGlobalBudget={40000}
        knowledgeAgentBudget={10000}
        invalidInputs={{ knowledgeAgent: "oops" }}
        onInvalidInput={onInvalidInput}
        onKnowledgeAgentBudget={onKnowledgeAgentBudget}
      />,
    );

    const inheritCheckbox = screen.getByTestId("reading-knowledge-agent-inherit-checkbox");
    expect(inheritCheckbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(inheritCheckbox);
    expect(onInvalidInput).toHaveBeenCalledWith("knowledgeAgent", undefined);
    expect(onKnowledgeAgentBudget).toHaveBeenCalledWith(null);
  });

  it("unmount remount keeps the host-owned invalid value visible", () => {
    const onValidityChange = vi.fn();

    const hostInvalid = { "memory:conservative": "2x48" };
    render(
      <ContextAllocationReading
        presets={initialPresets}
        knowledgeAgentBudget={null}
        invalidInputs={hostInvalid}
        onValidityChange={onValidityChange}
      />,
    );
    cleanup();

    render(
      <ContextAllocationReading
        presets={initialPresets}
        knowledgeAgentBudget={null}
        invalidInputs={hostInvalid}
        onValidityChange={onValidityChange}
      />,
    );

    const conservativeInput = screen.getByTestId(
      "reading-preset-max-tokens-conservative",
    ) as HTMLInputElement;
    expect(conservativeInput.value).toBe("2x48");
    expect(onValidityChange).toHaveBeenCalledWith(expect.objectContaining({ memoryValid: false }));
  });

  it("triggers separate save callbacks for memory, global knowledge and agent knowledge", () => {
    const onSaveMemory = vi.fn();
    const onSaveKnowledgeGlobal = vi.fn();
    const onSaveKnowledgeAgent = vi.fn();

    render(
      <ContextAllocationReading
        presets={initialPresets}
        knowledgeGlobalBudget={50000}
        knowledgeAgentBudget={20000}
        onSaveMemory={onSaveMemory}
        onSaveKnowledgeGlobal={onSaveKnowledgeGlobal}
        onSaveKnowledgeAgent={onSaveKnowledgeAgent}
        canSaveMemory={true}
        canSaveKnowledgeGlobal={true}
        canSaveKnowledgeAgent={true}
      />,
    );

    const saveMemoryBtn = screen.getByTestId("reading-save-memory-btn");
    const saveGlobalBtn = screen.getByTestId("reading-save-knowledge-global-btn");
    const saveAgentBtn = screen.getByTestId("reading-save-knowledge-agent-btn");

    fireEvent.click(saveMemoryBtn);
    expect(onSaveMemory).toHaveBeenCalledTimes(1);
    expect(onSaveKnowledgeGlobal).not.toHaveBeenCalled();

    fireEvent.click(saveGlobalBtn);
    expect(onSaveKnowledgeGlobal).toHaveBeenCalledTimes(1);

    fireEvent.click(saveAgentBtn);
    expect(onSaveKnowledgeAgent).toHaveBeenCalledTimes(1);
  });

  it("renders localized labels from the host-provided map", () => {
    render(
      <ContextAllocationReading
        presets={initialPresets}
        knowledgeAgentBudget={null}
        labels={{
          memoryTitle: "记忆预算",
          scopeAgent: "助手范围",
          modeConservative: "保守档",
          modeConservativeDesc: "最严格匹配",
          maxBytesLabel: "最大字节",
          invalidByteRange: "范围无效",
          followGlobalDefault: "跟随全局",
        }}
      />,
    );

    expect(screen.getByText("记忆预算")).toBeTruthy();
    expect(screen.getByText("助手范围")).toBeTruthy();
    expect(screen.getByText("保守档")).toBeTruthy();
    expect(screen.getByText("最严格匹配")).toBeTruthy();
    expect(screen.getAllByText("最大字节")).toHaveLength(3);
    expect(screen.getByText("跟随全局")).toBeTruthy();
  });

  it("shows the discard button only when the scope discard callback is provided and invokes it", () => {
    const onDiscardKnowledgeGlobal = vi.fn();

    const { rerender } = render(
      <ContextAllocationReading
        knowledgeGlobalBudget={50000}
        knowledgeAgentBudget={null}
        onSaveKnowledgeGlobal={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("reading-discard-knowledge-global-btn")).toBeNull();

    rerender(
      <ContextAllocationReading
        knowledgeGlobalBudget={50000}
        knowledgeAgentBudget={null}
        onSaveKnowledgeGlobal={vi.fn()}
        onDiscardKnowledgeGlobal={onDiscardKnowledgeGlobal}
      />,
    );
    fireEvent.click(screen.getByTestId("reading-discard-knowledge-global-btn"));
    expect(onDiscardKnowledgeGlobal).toHaveBeenCalledTimes(1);
  });
});
