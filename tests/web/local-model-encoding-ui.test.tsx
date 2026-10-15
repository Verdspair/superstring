import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { LocalModelEncodings } from "../../src/web/features/models/LocalModelEncodings";
import { selectLocale } from "../../src/web/i18n";

afterEach(cleanup);
it("loads without writes, saves only its model encoding and clears with CAS", async () => {
  selectLocale("zh-CN");
  const get = vi.fn(async () => ({ revision: "r1", models: [] }));
  const save = vi.fn(async (body) => ({ revision: "r2", models: body.models }));
  const api = {
    getLocalModelEncodings: get,
    saveLocalModelEncodings: save,
  } as unknown as SuperstringApi;
  render(
    <LocalModelEncodings
      active
      apiClient={api}
      loadedModels={["local-a", "external-a"]}
      externalModels={["external-a"]}
    />,
  );
  await act(async () => {});
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("文本 token 编码 · external-a")).toBeNull();
  fireEvent.change(screen.getByLabelText("文本 token 编码 · local-a"), {
    target: { value: "o200k_base" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "保存本地编码" }));
  });
  expect(save).toHaveBeenCalledWith({
    expected_revision: "r1",
    models: [{ name: "local-a", tokenizer_encoding: "o200k_base" }],
  });
  fireEvent.change(screen.getByLabelText("文本 token 编码 · local-a"), { target: { value: "" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "保存本地编码" }));
  });
  expect(save).toHaveBeenLastCalledWith({ expected_revision: "r2", models: [] });
});
it("retains the draft after conflict and merges only edited fields on explicit refresh", async () => {
  selectLocale("zh-CN");
  const get = vi
    .fn()
    .mockResolvedValueOnce({ revision: "r1", models: [] })
    .mockResolvedValue({
      revision: "r2",
      models: [{ name: "local-b", tokenizer_encoding: "cl100k_base" }],
    });
  const save = vi.fn().mockRejectedValue(new Error("CONFIG_VERSION_CONFLICT"));
  const api = {
    getLocalModelEncodings: get,
    saveLocalModelEncodings: save,
  } as unknown as SuperstringApi;
  render(
    <LocalModelEncodings
      active
      apiClient={api}
      loadedModels={["local-a", "local-b"]}
      externalModels={[]}
    />,
  );
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("文本 token 编码 · local-a"), {
    target: { value: "o200k_base" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "保存本地编码" }));
  });
  expect((screen.getByLabelText("文本 token 编码 · local-a") as HTMLSelectElement).value).toBe(
    "o200k_base",
  );
  expect(screen.getByRole("status").textContent).toContain("CONFIG_VERSION_CONFLICT");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "刷新本地编码" }));
  });
  expect((screen.getByLabelText("文本 token 编码 · local-a") as HTMLSelectElement).value).toBe(
    "o200k_base",
  );
  expect((screen.getByLabelText("文本 token 编码 · local-b") as HTMLSelectElement).value).toBe(
    "cl100k_base",
  );
});
it("does not read when inactive", async () => {
  const get = vi.fn();
  const api = { getLocalModelEncodings: get } as unknown as SuperstringApi;
  render(
    <LocalModelEncodings active={false} apiClient={api} loadedModels={[]} externalModels={[]} />,
  );
  await act(async () => {});
  expect(get).not.toHaveBeenCalled();
});

it("ignores a late save after hiding the editor and reloads the authoritative snapshot", async () => {
  selectLocale("zh-CN");
  let release!: (value: {
    revision: string;
    models: { name: string; tokenizer_encoding: "o200k_base" }[];
  }) => void;
  const pending = new Promise<{
    revision: string;
    models: { name: string; tokenizer_encoding: "o200k_base" }[];
  }>((resolve) => {
    release = resolve;
  });
  const get = vi
    .fn()
    .mockResolvedValueOnce({ revision: "r1", models: [] })
    .mockResolvedValue({ revision: "r3", models: [] });
  const save = vi.fn(() => pending);
  const api = {
    getLocalModelEncodings: get,
    saveLocalModelEncodings: save,
  } as unknown as SuperstringApi;
  const view = render(
    <LocalModelEncodings active apiClient={api} loadedModels={["local-a"]} externalModels={[]} />,
  );
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("文本 token 编码 · local-a"), {
    target: { value: "o200k_base" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存本地编码" }));
  view.rerender(
    <LocalModelEncodings
      active={false}
      apiClient={api}
      loadedModels={["local-a"]}
      externalModels={[]}
    />,
  );
  await act(async () => {
    release({ revision: "r2", models: [{ name: "local-a", tokenizer_encoding: "o200k_base" }] });
  });
  expect(screen.queryByText("本地编码已保存")).toBeNull();
  view.rerender(
    <LocalModelEncodings active apiClient={api} loadedModels={["local-a"]} externalModels={[]} />,
  );
  await act(async () => {});
  expect(get).toHaveBeenCalledTimes(2);
  expect((screen.getByLabelText("文本 token 编码 · local-a") as HTMLSelectElement).value).toBe(
    "o200k_base",
  );
});

it("retains preserved draft row after loadedModel removed and server refresh removes it, allows clearing before save", async () => {
  selectLocale("zh-CN");
  const get = vi
    .fn()
    .mockResolvedValueOnce({
      revision: "r1",
      models: [{ name: "local-a", tokenizer_encoding: "cl100k_base" }],
    })
    .mockResolvedValue({
      revision: "r2",
      models: [],
    });
  const save = vi.fn(async (body) => ({ revision: "r3", models: body.models }));
  const api = {
    getLocalModelEncodings: get,
    saveLocalModelEncodings: save,
  } as unknown as SuperstringApi;
  const view = render(
    <LocalModelEncodings active apiClient={api} loadedModels={["local-a"]} externalModels={[]} />,
  );
  await act(async () => {});
  expect(save).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("文本 token 编码 · local-a"), {
    target: { value: "o200k_base" },
  });

  view.rerender(
    <LocalModelEncodings active apiClient={api} loadedModels={[]} externalModels={[]} />,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "刷新本地编码" }));
  });

  const select = screen.getByLabelText("文本 token 编码 · local-a") as HTMLSelectElement;
  expect(select).not.toBeNull();
  expect(select.value).toBe("o200k_base");
  expect(save).not.toHaveBeenCalled();

  fireEvent.change(select, { target: { value: "" } });
  expect(screen.queryByLabelText("文本 token 编码 · local-a")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("keeps a formerly local declaration visible and clearable after external ownership changes", async () => {
  selectLocale("zh-CN");
  const get = vi.fn(async () => ({
    revision: "r1",
    models: [{ name: "local-a", tokenizer_encoding: "cl100k_base" }],
  }));
  const save = vi.fn(async (body) => ({ revision: "r2", models: body.models }));
  const api = {
    getLocalModelEncodings: get,
    saveLocalModelEncodings: save,
  } as unknown as SuperstringApi;
  const view = render(
    <LocalModelEncodings active apiClient={api} loadedModels={["local-a"]} externalModels={[]} />,
  );
  await act(async () => {});
  view.rerender(
    <LocalModelEncodings active apiClient={api} loadedModels={[]} externalModels={["local-a"]} />,
  );
  const select = screen.getByLabelText("文本 token 编码 · local-a") as HTMLSelectElement;
  expect(select.value).toBe("cl100k_base");
  expect((screen.getByRole("option", { name: "o200k_base" }) as HTMLOptionElement).disabled).toBe(
    true,
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: "" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "保存本地编码" }));
  });
  expect(save).toHaveBeenCalledWith({ expected_revision: "r1", models: [] });
  expect(screen.queryByLabelText("文本 token 编码 · local-a")).toBeNull();
});
