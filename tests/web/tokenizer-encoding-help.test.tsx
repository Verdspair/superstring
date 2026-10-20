import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { LocalModelEncodings } from "../../src/web/features/models/LocalModelEncodings";
import { TokenizerEncodingHelp } from "../../src/web/features/models/TokenizerEncodingHelp";
import { selectLocale } from "../../src/web/i18n";
import { render } from "./helpers/render-with-providers";

afterEach(cleanup);

describe("TokenizerEncodingHelp", () => {
  it("renders collapsed initially in English and expands on summary click to show reference details", async () => {
    selectLocale("en");
    render(<TokenizerEncodingHelp />);

    const summary = screen.getByText("Encoding reference");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);

    fireEvent.click(summary);
    expect(details.open).toBe(true);

    expect(
      screen.getByText(
        "Confirm the actual tokenizer with the upstream model. Compatible APIs, model aliases, or local filenames alone are not proof; unknown models stay unspecified to use conservative estimates.",
      ),
    ).not.toBeNull();
    expect(screen.getByText("cl100k_base: OpenAI gpt-4 / gpt-3.5-turbo")).not.toBeNull();
    expect(
      screen.getByText("o200k_base: OpenAI gpt-4o / gpt-4.1 / gpt-5 / o1 / o3 / o4-mini"),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "gpt-oss uses o200k_harmony, which is currently unsupported here without an automatic substitute.",
      ),
    ).not.toBeNull();

    const link = screen.getByRole("link", { name: "OpenAI tiktoken model mappings" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/openai/tiktoken/blob/4e71bbe0c078468e00fefbf94b39849389f346e5/tiktoken/model.py",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("renders collapsed initially in Chinese and expands on summary click to show reference details", async () => {
    selectLocale("zh-CN");
    render(<TokenizerEncodingHelp />);

    const summary = screen.getByText("编码参考");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);

    fireEvent.click(summary);
    expect(details.open).toBe(true);

    expect(
      screen.getByText(
        "请以模型实际上游或官方说明确认分词编码。兼容 API 格式、模型别名或本地文件名本身不能作为依据；无法确认时请保留“未指定”，使用保守估算。",
      ),
    ).not.toBeNull();
    expect(screen.getByText("cl100k_base: OpenAI gpt-4 / gpt-3.5-turbo")).not.toBeNull();
    expect(
      screen.getByText("o200k_base: OpenAI gpt-4o / gpt-4.1 / gpt-5 / o1 / o3 / o4-mini"),
    ).not.toBeNull();
    expect(
      screen.getByText("gpt-oss 使用 o200k_harmony，目前在此处不受支持且不提供自动替代。"),
    ).not.toBeNull();

    const link = screen.getByRole("link", { name: "OpenAI tiktoken 模型映射参考" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/openai/tiktoken/blob/4e71bbe0c078468e00fefbf94b39849389f346e5/tiktoken/model.py",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("mounts in LocalModelEncodings and confirms help interaction does not call save or change selection, draft, or CAS", async () => {
    selectLocale("zh-CN");
    const get = vi.fn(async () => ({
      revision: "rev-orig-100",
      models: [{ name: "local-chat-model", tokenizer_encoding: "cl100k_base" as const }],
    }));
    const save = vi.fn(async (body: { expected_revision: string; models: unknown[] }) => ({
      revision: "rev-saved-101",
      models: body.models,
    }));
    const api = {
      getLocalModelEncodings: get,
      saveLocalModelEncodings: save,
    } as unknown as SuperstringApi;

    render(
      <LocalModelEncodings
        active
        apiClient={api}
        loadedModels={["local-chat-model"]}
        externalModels={[]}
      />,
    );
    await act(async () => {});

    expect(get).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();

    const select = screen.getByLabelText("文本 token 编码 · local-chat-model") as HTMLSelectElement;
    expect(select.value).toBe("cl100k_base");

    const saveButton = screen.getByRole("button", { name: "保存本地编码" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const summary = screen.getByText("编码参考");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);

    fireEvent.click(summary);
    expect(details.open).toBe(true);

    fireEvent.click(summary);
    expect(details.open).toBe(false);

    expect(save).not.toHaveBeenCalled();
    expect(select.value).toBe("cl100k_base");
    expect(saveButton.disabled).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
