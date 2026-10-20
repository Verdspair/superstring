import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InspectedContext } from "../../src/shared/contracts/agent-run";
import { selectLocale } from "../../src/web/i18n";
import { InspectedEvidence } from "../../src/web/screens/observability/ModelEvidence";
import { render } from "./helpers/render-with-providers";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  selectLocale("zh-CN");
});

function createBaseContext(overrides?: Partial<InspectedContext>): InspectedContext {
  return {
    status: "exact",
    layout: [],
    sourceVersions: [],
    exactMessages: [{ role: "user", content: [{ kind: "text", text: "Test prompt" }] }],
    result: { status: "exact", format: "text", text: "Model reply text" },
    ...overrides,
  };
}

describe("ModelEvidence finish_reason presentation", () => {
  it("renders finish_reason bilingual states with old absent, null, empty array, and stream [DONE] via actual tab click", () => {
    // 1. Chinese locale: verify old absent responses renders "未记录" without guessing "stop"
    selectLocale("zh-CN");
    const oldContext = createBaseContext({
      result: { status: "exact", format: "text", text: "Historical step reply" },
    });
    const { unmount: unmountOld } = render(<InspectedEvidence value={oldContext} />);

    // Click output tab using actual Testing Library tab click (no force DOM bypass)
    fireEvent.mouseDown(screen.getByRole("tab", { name: "模型输出" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText("finish_reason")).toBeTruthy();
    expect(screen.getByText("未记录")).toBeTruthy();
    expect(screen.queryByText('"stop"')).toBeNull();
    expect(screen.queryByText("stop")).toBeNull();
    unmountOld();

    // 2. English locale: verify null literal, provider did not report, and stream [DONE]
    selectLocale("en");
    const enContext = createBaseContext({
      result: {
        status: "exact",
        format: "text",
        text: "En reply",
        responses: [
          {
            transport: "stream",
            httpStatus: 200,
            finishReasons: [null, "stop"],
            doneMarker: true,
          },
          {
            transport: "complete",
            httpStatus: 200,
            finishReasons: [],
          },
        ],
      },
    });
    render(<InspectedEvidence value={enContext} />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Model output" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText("finish_reason")).toBeTruthy();
    expect(screen.getByText("null")).toBeTruthy();
    expect(screen.getByText('"stop"')).toBeTruthy();
    expect(screen.getByText("[DONE]")).toBeTruthy();
    expect(screen.getByText("Provider did not report")).toBeTruthy();
  });

  it("renders raw hostile strings safely escaped via JSON.stringify and preserves whitespace visibility without HTML injection", () => {
    selectLocale("zh-CN");
    const hostileContext = createBaseContext({
      result: {
        status: "exact",
        format: "text",
        text: "Hostile step",
        responses: [
          {
            transport: "stream",
            httpStatus: 200,
            finishReasons: [
              "<script>alert(1)</script>",
              "><img src=x onerror=alert(1)>",
              "",
              "   ",
              "tool_calls",
            ],
            doneMarker: false,
          },
        ],
      },
    });
    const { container } = render(<InspectedEvidence value={hostileContext} />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "模型输出" }), {
      button: 0,
      ctrlKey: false,
    });

    // Verbatim JSON.stringify rendering of hostile strings
    expect(screen.getByText('"<script>alert(1)</script>"')).toBeTruthy();
    expect(screen.getByText('"><img src=x onerror=alert(1)>"')).toBeTruthy();
    expect(screen.getByText('""')).toBeTruthy();
    expect(screen.getByText('"   "', { normalizer: (text) => text })).toBeTruthy();
    expect(screen.getByText('"tool_calls"')).toBeTruthy();

    // Verify raw strings are safe React text and never injected as DOM HTML elements
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders ordered multiple attempts sequentially distinguishing network failure without status from normal status", () => {
    selectLocale("zh-CN");
    const multiAttemptContext = createBaseContext({
      result: {
        status: "exact",
        format: "text",
        text: "Multi attempt reply",
        responses: [
          {
            transport: "complete",
            finishReasons: [],
          },
          {
            transport: "stream",
            httpStatus: 200,
            finishReasons: ["stop"],
            doneMarker: true,
          },
        ],
      },
    });
    render(<InspectedEvidence value={multiAttemptContext} />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "模型输出" }), {
      button: 0,
      ctrlKey: false,
    });

    // Verify sequential attempts with distinct indices and transports
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("complete")).toBeTruthy();
    expect(screen.getByText("stream")).toBeTruthy();

    // Attempt 1: network failure with no HTTP status displays "无 HTTP 响应"
    expect(screen.getByText("无 HTTP 响应")).toBeTruthy();

    // Attempt 2: HTTP 200 with raw finish_reason "stop" and stream [DONE]
    expect(screen.getByText("HTTP 200")).toBeTruthy();
    expect(screen.getByText('"stop"')).toBeTruthy();
    expect(screen.getByText("[DONE]")).toBeTruthy();
  });

  it("displays metadata-only on unavailable no_response and strictly hides finish_reason metadata when context or result is revoked or expired", () => {
    selectLocale("zh-CN");

    // Case A: metadata-only when result is unavailable with no_response
    const unavailableContext = createBaseContext({
      result: {
        status: "unavailable",
        reason: "no_response",
        responses: [
          {
            transport: "stream",
            httpStatus: 200,
            finishReasons: ["stop"],
            doneMarker: true,
          },
        ],
      },
    });
    const { unmount: unmountUnavailable } = render(
      <InspectedEvidence value={unavailableContext} />,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: "模型输出" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByText("模型未返回可保留的正文。")).toBeTruthy();
    expect(screen.getByText("finish_reason")).toBeTruthy();
    expect(screen.getByText('"stop"')).toBeTruthy();
    expect(screen.getByText("[DONE]")).toBeTruthy();
    unmountUnavailable();

    // Case B: revoked context status must completely hide metadata even if responses are provided
    const revokedContext: InspectedContext = {
      status: "revoked",
      layout: [],
      sourceVersions: [],
      result: {
        status: "revoked",
        responses: [
          {
            transport: "complete",
            httpStatus: 200,
            finishReasons: ["stop"],
          },
        ],
      },
    };
    const { unmount: unmountRevoked } = render(<InspectedEvidence value={revokedContext} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "模型输出" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.queryByText("finish_reason")).toBeNull();
    expect(screen.queryByText('"stop"')).toBeNull();
    unmountRevoked();

    // Case C: expired context status must completely hide metadata
    const expiredContext: InspectedContext = {
      status: "expired",
      layout: [],
      sourceVersions: [],
      result: {
        status: "expired",
        responses: [
          {
            transport: "complete",
            httpStatus: 200,
            finishReasons: ["stop"],
          },
        ],
      },
    };
    render(<InspectedEvidence value={expiredContext} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "模型输出" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.queryByText("finish_reason")).toBeNull();
    expect(screen.queryByText('"stop"')).toBeNull();
  });
});
