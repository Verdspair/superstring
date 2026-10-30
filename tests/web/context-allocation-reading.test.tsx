import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeSettingsUpdateSchema } from "../../src/shared/contracts/knowledge";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { selectLocale } from "../../src/web/i18n";
import { ContextAllocationReading } from "../../src/web/screens/connections/ContextAllocationReading";
import { ModelPurposes } from "../../src/web/screens/environment/ModelPurposes";
import { useSuperstringStore as store } from "../../src/web/store";

afterEach(cleanup);
const labels = {
  knowledgeGlobalTitle: "Global knowledge",
  knowledgeGlobalDesc: "Saved default quota",
  defaultBytesLabel: "Bytes",
  saveKnowledgeGlobal: "Save quota",
  refreshBaseline: "Refresh",
  discardBudget: "Discard",
  invalidPositiveByte: "Invalid bytes",
  saving: "Saving",
};
const panel = (props: Parameters<typeof ContextAllocationReading>[0]) =>
  render(<ContextAllocationReading labels={labels} {...props} />, {
    wrapper: DesignSystemProvider,
  });
describe("global knowledge quota actual owner", () => {
  it("edits and saves only the global knowledge value", () => {
    const change = vi.fn(),
      save = vi.fn();
    panel({
      knowledgeGlobalBudget: 16384,
      onKnowledgeGlobalBudget: change,
      onSaveKnowledgeGlobal: save,
    });
    fireEvent.change(screen.getByLabelText("Bytes"), { target: { value: "24000" } });
    expect(change).toHaveBeenLastCalledWith(24000);
    fireEvent.click(screen.getByRole("button", { name: "Save quota" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("reading-section-memory")).toBeNull();
    expect(screen.queryByTestId("reading-section-knowledge-agent")).toBeNull();
  });
  it("keeps raw invalid input in the domain owner and blocks saving", () => {
    const invalid = vi.fn(),
      save = vi.fn(),
      validity = vi.fn();
    panel({
      knowledgeGlobalBudget: 16384,
      invalidInputs: { knowledgeGlobal: "" },
      onInvalidInput: invalid,
      onSaveKnowledgeGlobal: save,
      onValidityChange: validity,
    });
    expect(screen.getByRole("button", { name: "Save quota" })).toHaveProperty("disabled", true);
    expect(validity).toHaveBeenLastCalledWith({ knowledgeGlobalValid: false });
    fireEvent.change(screen.getByLabelText("Bytes"), { target: { value: "0" } });
    expect(invalid).toHaveBeenLastCalledWith("knowledgeGlobal", "0");
    expect(save).not.toHaveBeenCalled();
  });
  it("refresh and discard use their original scoped callbacks", () => {
    const refresh = vi.fn(),
      discard = vi.fn();
    panel({
      knowledgeGlobalBudget: 8192,
      onRefreshKnowledgeGlobal: refresh,
      onDiscardKnowledgeGlobal: discard,
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
  });
  it("unknown budget stays blank and disabled until a valid positive quota is entered", () => {
    panel({ knowledgeGlobalBudget: null });
    expect(screen.getByLabelText("Bytes")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Save quota" })).toHaveProperty("disabled", true);
  });
});

describe("global knowledge quota shared contract and save owner", () => {
  const workspace = async () => {
    await selectLocale("zh-CN");
    const client = {
      getKnowledgeSettings: vi.fn(async () => ({
        revision: 3,
        context_budget: 2097152,
        model_name: null,
        auto_enabled: true,
      })),
      saveKnowledgeSettings: vi.fn(
        async (body: Parameters<SuperstringApi["saveKnowledgeSettings"]>[0]) => {
          const parsed = KnowledgeSettingsUpdateSchema.parse(body);
          const { expected_revision, ...settings } = parsed;
          return { ...settings, revision: expected_revision + 1 };
        },
      ),
    } as unknown as SuperstringApi;
    store.getState().resetForTests(client);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "context-allocation",
      contextAllocationTarget: { purpose: "reading", agentId: null },
    });
    render(<ModelPurposes active />, { wrapper: DesignSystemProvider });
    await waitFor(() => expect(store.getState().knowledgeModelEditor?.source.revision).toBe(3));
    return client;
  };
  it("saves values above one MiB and the largest safe integer without submitting another scope", async () => {
    const client = await workspace();
    act(() => store.getState().patchKnowledgeModel("Other model draft"));
    for (const budget of [2097153, Number.MAX_SAFE_INTEGER]) {
      fireEvent.change(screen.getByTestId("reading-knowledge-global-budget-input"), {
        target: { value: String(budget) },
      });
      const save = screen.getByTestId("reading-save-knowledge-global-btn");
      expect(save).toHaveProperty("disabled", false);
      await act(async () => fireEvent.click(save));
      expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
        expected_revision: budget === 2097153 ? 3 : 4,
        auto_enabled: true,
        context_budget: budget,
        model_name: null,
      });
      expect(store.getState().knowledgeModelEditor?.source.context_budget).toBe(budget);
      expect(store.getState().knowledgeModelEditor?.modelName).toBe("Other model draft");
      expect(save).toHaveProperty("disabled", true);
    }
  });
  it("retains invalid raw input and disables saving without changing the valid draft", async () => {
    const client = await workspace();
    const input = screen.getByTestId("reading-knowledge-global-budget-input");
    expect(input).toHaveProperty("value", "2097152");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    for (const raw of ["9007199254740992", "1.5", "0", ""]) {
      fireEvent.change(input, { target: { value: raw } });
      expect(input).toHaveProperty("value", raw);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(store.getState().allocationInvalidInputs["global:knowledge"]).toBe(raw);
      expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(2097152);
      const save = screen.getByTestId("reading-save-knowledge-global-btn");
      expect(save).toHaveProperty("disabled", true);
      await act(async () => fireEvent.click(save));
      expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
    }
  });
  it("keeps a large budget draft on conflict and retries against an explicitly refreshed revision", async () => {
    const client = await workspace();
    vi.mocked(client.saveKnowledgeSettings).mockRejectedValueOnce(
      new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict"),
    );
    fireEvent.change(screen.getByTestId("reading-knowledge-global-budget-input"), {
      target: { value: "2097153" },
    });
    await act(async () => fireEvent.click(screen.getByTestId("reading-save-knowledge-global-btn")));
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(2097153);
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(3);
    expect(store.getState().knowledgeModelError.budget).toBeTruthy();
    vi.mocked(client.getKnowledgeSettings).mockResolvedValue({
      revision: 4,
      context_budget: 2097154,
      model_name: null,
      auto_enabled: true,
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新保存基线" })));
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(2097153);
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(4);
    await act(async () => fireEvent.click(screen.getByTestId("reading-save-knowledge-global-btn")));
    expect(client.saveKnowledgeSettings).toHaveBeenCalledTimes(2);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 4,
      auto_enabled: true,
      context_budget: 2097153,
      model_name: null,
    });
  });
});
