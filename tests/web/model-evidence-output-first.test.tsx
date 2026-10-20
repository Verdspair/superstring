import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectedContext } from "../../src/shared/contracts/agent-run";
import { api } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { ModelEvidence } from "../../src/web/screens/observability/ModelEvidence";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

// 用户 2026-10-17 最新要求：选中步详情三行（输出/输入/来源）独立可折叠，默认全部收起，输出在最前；
// 选中即自动读取进本地内存，展开/收起只是视觉切换，不发新请求；内容全量保留，无过滤截断。
const FULL_LENGTH = 1900;
const OUTPUT_TEXT = `输出原文${"字".repeat(FULL_LENGTH - 4)}`;
const INPUT_TEXT = `输入原文${"字".repeat(FULL_LENGTH - 4)}`;
const SOURCE_COUNT = 1900;
const handle = { runId: "10000000-0000-4000-8000-0000000000a1", stepId: "step-1" };

function exactEvidence(): InspectedContext {
  return {
    status: "exact",
    layout: [],
    sourceVersions: Array.from({ length: SOURCE_COUNT }, (_, i) => ({
      id: `src-${i + 1}`,
      revision: `r${i + 1}`,
    })),
    exactMessages: [{ role: "user", content: [{ kind: "text", text: INPUT_TEXT }] }],
    result: {
      status: "exact",
      format: "text",
      text: OUTPUT_TEXT,
      responses: [
        { transport: "stream", httpStatus: 200, finishReasons: ["stop"], doneMarker: true },
      ],
    },
  };
}

function install() {
  const inspect = vi.fn(() => Promise.resolve(exactEvidence()));
  store.getState().resetForTests({ ...api, inspectRunContext: inspect } as typeof api);
  return inspect;
}

function sectionLabels() {
  return {
    output: i18n.t("observability.modelOutput"),
    input: i18n.t("observability.modelInput"),
    sources: i18n.t("observability.sourcesAndRevisions"),
  };
}

function sectionButtons() {
  const { output, input, sources } = sectionLabels();
  return {
    output: screen.getByRole("button", { name: output }),
    input: screen.getByRole("button", { name: input }),
    sources: screen.getByRole("button", { name: sources }),
  };
}

beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("model evidence output-first collapsible rows", () => {
  it("renders three independent rows default closed in output, input, sources order with distinct localized names", async () => {
    install();
    render(<ModelEvidence handle={handle} autoInspect fullEvidence />);
    await screen.findByRole("button", { name: i18n.t("observability.modelOutput") });
    const rows = sectionButtons();
    for (const button of [rows.output, rows.input, rows.sources]) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
    }
    expect(
      rows.output.compareDocumentPosition(rows.input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      rows.input.compareDocumentPosition(rows.sources) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const names = [rows.output, rows.input, rows.sources].map((button) => button.textContent);
    expect(new Set(names).size).toBe(3);
    for (const key of [
      "observability.modelOutput",
      "observability.modelInput",
      "observability.sourcesAndRevisions",
    ]) {
      expect(i18n.t(key, { lng: "en" })).not.toBe(i18n.t(key, { lng: "zh-CN" }));
    }
  });

  it("auto-reads the selected detail before any expand while every row stays closed with no body content", async () => {
    const inspect = install();
    render(<ModelEvidence handle={handle} autoInspect fullEvidence />);
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    const rows = sectionButtons();
    for (const button of [rows.output, rows.input, rows.sources]) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
    }
    expect(screen.queryByText(OUTPUT_TEXT)).toBeNull();
    expect(screen.queryByText(INPUT_TEXT)).toBeNull();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("explicitly opening each row reveals the full preserved output, input and all 1900 sources", async () => {
    install();
    render(<ModelEvidence handle={handle} autoInspect fullEvidence />);
    await waitFor(() =>
      expect(sectionButtons().output.getAttribute("aria-expanded")).toBeDefined(),
    );
    const rows = sectionButtons();
    fireEvent.click(rows.output);
    expect(rows.output.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(OUTPUT_TEXT)).toBeTruthy();
    expect(screen.getByText(i18n.t("observability.finishReason"))).toBeTruthy();
    expect(screen.getByText('"stop"')).toBeTruthy();
    fireEvent.click(rows.input);
    expect(screen.getByText(INPUT_TEXT)).toBeTruthy();
    fireEvent.click(rows.sources);
    expect(rows.sources.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(SOURCE_COUNT);
    expect(screen.getByText("src-1")).toBeTruthy();
    expect(screen.getByText(`src-${SOURCE_COUNT}`)).toBeTruthy();
  });

  it("toggling rows open and closed issues zero additional requests after the initial auto-read", async () => {
    const inspect = install();
    render(<ModelEvidence handle={handle} autoInspect fullEvidence />);
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    for (const cycle of [0, 1]) {
      const rows = sectionButtons();
      fireEvent.click(rows.output);
      fireEvent.click(rows.input);
      fireEvent.click(rows.sources);
      if (cycle === 0) {
        expect(inspect).toHaveBeenCalledTimes(1);
      }
      expect(screen.getByText(OUTPUT_TEXT)).toBeTruthy();
      expect(document.querySelectorAll("tbody tr")).toHaveLength(SOURCE_COUNT);
      fireEvent.click(rows.output);
      fireEvent.click(rows.input);
      fireEvent.click(rows.sources);
      expect(screen.queryByText(OUTPUT_TEXT)).toBeNull();
      expect(inspect).toHaveBeenCalledTimes(1);
    }
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
