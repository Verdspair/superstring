import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSettingsResponse } from "../../src/shared/contracts/qq";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { selectLocale, translate } from "../../src/web/i18n";
import { AgentMaterials } from "../../src/web/screens/assistants/AgentMaterials";

const KnowledgeToolSettings = AgentMaterials;

import { OwnerIdentity } from "../../src/web/screens/connections/owner-identity";
import { QqConnectionTab } from "../../src/web/screens/connections/qq-app-management";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { StorageInventory } from "../../src/web/screens/connections/storage-inventory";
import { TransportSettings } from "../../src/web/screens/connections/transport-settings";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { MemoryDetail, MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { NavigationGuard } from "../../src/web/workspace/NavigationGuard";
import { memory, memoryContent, setupLibrary } from "./helpers/library-fixture";

const settings: QqSettingsResponse = {
  enabled: true,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: "ws://localhost:3000", has_token: false },
  revision: 3,
};

beforeEach(async () => {
  setupLibrary();
  await selectLocale("zh-CN");
  store.setState({ qqSettings: settings });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function isolated(view: ReactNode) {
  let commits = 0;
  render(
    <Profiler
      id="admin"
      onRender={() => {
        commits += 1;
      }}
    >
      <DesignSystemProvider>{view}</DesignSystemProvider>
    </Profiler>,
  );
  await act(async () => {});
  const before = commits;
  await act(async () => {
    store.setState({ qqStickerLoading: true });
  });
  await act(async () => {
    store.setState({ qqStickerLoading: false });
  });
  expect(commits).toBe(before);
  return () => commits;
}

describe("admin store render isolation", () => {
  it("keeps materials isolated while updating its active memory allowance", async () => {
    await isolated(<AgentMaterials />);
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "1024" } });
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(1024);
    const raw = store.getState().pageEditor?.agent.memory_retrieval_prompt;
    act(() =>
      store.getState().patchPageAgent("memory-tools", { memory_retrieval_prompt: "retired" }),
    );
    expect(store.getState().pageEditor?.draft.memory_retrieval_prompt).toBe(raw);
  });

  it("keeps knowledge reading isolated after its actual API load", async () => {
    await isolated(<KnowledgeToolSettings />);
    const editor = store.getState().knowledgeReadEditor;
    expect(editor).not.toBeNull();
    const checkboxes = screen.getAllByRole("checkbox");
    const before = checkboxes[1].getAttribute("aria-checked");
    fireEvent.click(checkboxes[1]);
    expect(checkboxes[1].getAttribute("aria-checked")).not.toBe(before);
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(!editor?.draft.enabled);
  });

  it("keeps owner identity isolated and responds to account eligibility changes", async () => {
    await isolated(<OwnerIdentity />);
    const peer = screen.getByRole("textbox") as HTMLInputElement;
    expect(peer.disabled).toBe(false);
    fireEvent.change(peer, { target: { value: "30003" } });
    await act(async () => {
      store.setState({ qqSettings: { ...settings, account_id: null } });
    });
    expect(peer.disabled).toBe(true);
    expect(peer.value).toBe("30003");
  });

  it("keeps the scheme workspace isolated and tracks its save lock", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "scheme-library",
    });
    await isolated(<SchemesWorkspace />);
    // setupLibrary 目录为空：工具条与空态各有一个真实「新建方案」入口；取文档顺序第一（工具条）。
    const create = screen.getAllByRole("button", {
      name: translate("connections.newScheme"),
    })[0] as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    await act(async () => {
      store.setState({ qqSchemeSaving: true });
    });
    expect(create.disabled).toBe(true);
  });

  it("keeps the QQ connection tab isolated and updates connection state", async () => {
    await isolated(<QqConnectionTab active={false} />);
    await act(async () => {
      store.setState({ qqConnection: { phase: "ready", reason: "Connected fixture" } });
    });
    expect(screen.getByText("Connected fixture")).toBeTruthy();
  });

  it("keeps connection fields isolated without losing the connection draft", async () => {
    await isolated(<TransportSettings />);
    const endpoint = screen.getByDisplayValue(settings.transport.endpoint!) as HTMLInputElement;
    fireEvent.change(endpoint, { target: { value: "ws://localhost:4000" } });
    expect(store.getState().qqInputs.connection?.endpoint).toBe("ws://localhost:4000");
    await act(async () => {
      store.setState({ qqAccessSaving: true });
    });
    expect(endpoint.disabled).toBe(true);
    expect(endpoint.value).toBe("ws://localhost:4000");
  });

  it("keeps inactive storage isolated but exposes relevant loading state", async () => {
    await isolated(<StorageInventory active={false} />);
    expect(
      screen.queryByRole("button", { name: translate("connections.common.refresh") }),
    ).toBeNull();
    expect(screen.queryByText(translate("connections.common.loading"))).toBeNull();
    await act(async () => {
      store.setState({ qqStorageLoading: true });
    });
    expect(screen.getByText(translate("connections.common.loading"))).toBeTruthy();
    await act(async () => {
      store.setState({ qqStorageLoading: false });
    });
    expect(screen.queryByText(translate("connections.common.loading"))).toBeNull();
  });

  it("keeps knowledge editor isolated and renders its real store-owned draft", async () => {
    await act(async () => {
      await store.getState().loadKnowledge();
      store.getState().requestKnowledgeEditor({ kind: "category-new" });
    });
    await isolated(<KnowledgeLibrary active={false} />);
    const name = screen.getByRole("dialog").querySelector("input") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "New category" } });
    expect(name.value).toBe("New category");
    expect(store.getState().knowledgeEditor).toMatchObject({ name: "New category" });
  });

  it("keeps memory detail isolated but updates its authoritative content", async () => {
    store.setState({ memoryEntryDetail: memory, memoryContent });
    await isolated(<MemoryDetail />);
    await act(async () => {
      store.setState({
        memoryContent: {
          ...memoryContent,
          content: { ...memoryContent.content, body: "Revised body" },
        },
      });
    });
    expect(screen.getByText("Revised body")).toBeTruthy();
  });

  it("keeps the manual memory dialog isolated and updates the session choices", async () => {
    let commits = 0;
    render(
      <Profiler
        id="manual-memory"
        onRender={() => {
          commits += 1;
        }}
      >
        <DesignSystemProvider>
          <MemoryLibrary />
        </DesignSystemProvider>
      </Profiler>,
    );
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", {
        name: translate("library.organize.memories.from.a.conversation"),
      }),
    );
    await act(async () => {});
    const before = commits;
    await act(async () => {
      store.setState({ qqStickerLoading: true });
    });
    expect(commits).toBe(before);
    await act(async () => {
      store.setState({ memorySessions: [{ id: "new-session", title: "Additional session" }] });
    });
    expect(screen.getByRole("option", { name: "Additional session" })).toBeTruthy();
  });

  it("keeps navigation confirmation isolated and updates the relevant QQ draft preview", async () => {
    store.setState({ navigationConfirmOpen: true });
    await isolated(<NavigationGuard />);
    await act(async () => {
      store.setState({
        qqInputs: { ...store.getState().qqInputs, stickerNewCollection: "New collection" },
      });
    });
    expect(screen.getByText("New collection")).toBeTruthy();
  });
});
