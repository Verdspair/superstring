// The sticker library surface (§9.2, P5d).
//
// The page is where §9.1's sequence becomes visible, so the cases below follow it: an import lands
// DISABLED and opens for review, "保存整理" writes content without enabling, enabling is its own
// action and shows what it reaches, and the undecided operations (delete, replace, batch) have no
// control to click — a button that existed would invite the user to try one.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QqStickerAssetResponse,
  QqStickerCollectionResponse,
} from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { SettingsBody } from "../../src/web/app/SettingsSidebar";
import { StickerLibrary } from "../../src/web/features/qq/StickerLibrary";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-24T00:00:00.000Z";
const collection: QqStickerCollectionResponse = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "日常",
  description: null,
  revision: 1,
  asset_count: 1,
};
const asset = (overrides: Partial<QqStickerAssetResponse> = {}): QqStickerAssetResponse => ({
  id: "22222222-2222-4222-8222-222222222222",
  name: "问好",
  description: null,
  description_draft: null,
  tags: [],
  tags_draft: [],
  usage_note: null,
  media_type: "image",
  byte_size: 512,
  width: 64,
  height: 64,
  enabled: false,
  collection_ids: [collection.id],
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});
const impact = {
  asset_id: asset().id,
  collection_ids: [collection.id],
  schemes: [
    { id: "33333333-3333-4333-8333-333333333333", name: "聊天", collection_ids: [collection.id] },
  ],
  bindings: [
    {
      scheme_id: "33333333-3333-4333-8333-333333333333",
      account_id: "10001",
      conversation_kind: "group" as const,
      peer_id: "30003",
      paused: true,
    },
  ],
};

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    listQqStickerCollections: vi.fn().mockResolvedValue([collection]),
    listQqStickerAssets: vi.fn().mockResolvedValue([asset()]),
    getQqStickerImpact: vi.fn().mockResolvedValue(impact),
    createQqStickerCollection: vi.fn().mockResolvedValue({
      ...collection,
      id: "44444444-4444-4444-8444-444444444444",
      name: "节日",
      asset_count: 0,
    }),
    updateQqStickerCollection: vi
      .fn()
      .mockResolvedValue({ ...collection, name: "常用", revision: 2 }),
    importQqStickerFile: vi
      .fn()
      .mockResolvedValue({ kind: "rejected", reason: "unsupported_format" }),
    updateQqStickerAsset: vi.fn().mockResolvedValue(asset({ description: "挥手打招呼" })),
    setQqStickerCollections: vi.fn().mockResolvedValue(asset()),
    setQqStickerEnabled: vi.fn().mockResolvedValue(asset({ enabled: true })),
    bulkUpdateQqStickers: vi.fn().mockResolvedValue({ assets: [asset()] }),
    annotateQqSticker: vi
      .fn()
      .mockResolvedValue({ kind: "rejected", reason: "model_not_configured" }),
    ...overrides,
  } as unknown as typeof api;
}

async function renderPage(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "qq-stickers" });
  const view = render(<StickerLibrary />);
  await act(async () => {});
  return { fake, view };
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("素材库页面", () => {
  it("读取集合与素材，并说明作用域与启用后的条件", async () => {
    await renderPage();
    expect(screen.getByText("日常")).toBeTruthy();
    expect(screen.getByText("问好")).toBeTruthy();
    expect(screen.getByText("已停用")).toBeTruthy();
    expect(screen.getByText(/不随当前助手切换/)).toBeTruthy();
    expect(screen.queryByText("已启用")).toBeNull();
  });

  it("被拒的文件说出是哪一种原因，且不新增素材", async () => {
    const { fake } = await renderPage();
    const input = screen.getByLabelText("选择图片文件") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "错的文件.pdf")] } });
    expect(await screen.findByText(/这个格式不在支持范围内/)).toBeTruthy();
    expect(
      (fake.listQqStickerAssets as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
    expect(screen.queryByText("错的文件.pdf")).toBeNull();
  });

  it("导入成功即选中它，且仍是停用状态", async () => {
    const imported = asset({
      id: "55555555-5555-4555-8555-555555555555",
      name: "微笑.png",
      enabled: false,
    });
    const { fake } = await renderPage({
      importQqStickerFile: vi.fn().mockResolvedValue({ kind: "imported", asset: imported }),
    } as Partial<typeof api>);
    const input = screen.getByLabelText("选择图片文件") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "微笑.png")] } });
    expect(await screen.findByText("微笑.png")).toBeTruthy();
    // §9.1: the import itself never enables; the detail panel opened for the review instead.
    expect(screen.getAllByText("已停用").length).toBeGreaterThan(0);
    expect(fake.setQqStickerEnabled).not.toHaveBeenCalled();
  });

  it("保存整理只写内容，不改变启用状态", async () => {
    const { fake } = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /问好/ }));
    const description = await screen.findByLabelText("内容说明");
    fireEvent.change(description, { target: { value: "挥手打招呼" } });
    fireEvent.change(screen.getByLabelText("标签"), { target: { value: "日常, 问候" } });
    fireEvent.click(screen.getByRole("button", { name: "保存整理" }));
    await act(async () => {});
    expect(fake.updateQqStickerAsset).toHaveBeenCalledWith(asset().id, {
      name: "问好",
      description: "挥手打招呼",
      tags: ["日常", "问候"],
      usage_note: null,
    });
    expect(fake.setQqStickerCollections).toHaveBeenCalledWith(asset().id, {
      collection_ids: [collection.id],
    });
    expect(fake.setQqStickerEnabled).not.toHaveBeenCalled();
    expect(await screen.findByText("已保存素材整理")).toBeTruthy();
  });

  it("保存并启用同时开放使用，并展示影响范围", async () => {
    const { fake } = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /问好/ }));
    fireEvent.change(await screen.findByLabelText("名称"), { target: { value: "问好呀" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并启用" }));
    await act(async () => {});
    expect(fake.setQqStickerEnabled).toHaveBeenCalledWith(asset().id, true);
    expect(await screen.findByText("已保存并启用")).toBeTruthy();
    // The enabled asset's reach: the scheme that authorizes it and the paused conversation it
    // would reach, which §9.1 asks the surface to show.
    const reach = await screen.findByText(/授权它的方案/);
    expect(reach.textContent).toContain("聊天");
    expect(screen.getByText(/已暂停/)).toBeTruthy();
  });

  it("启用与停用是各自的动作", async () => {
    const { fake } = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /问好/ }));
    fireEvent.click(await screen.findByRole("button", { name: "启用素材" }));
    await act(async () => {});
    expect(fake.setQqStickerEnabled).toHaveBeenCalledWith(asset().id, true);
    expect(await screen.findByText("已启用素材")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
  });

  it("新建与重命名集合都走比较交换", async () => {
    const { fake } = await renderPage();
    fireEvent.change(screen.getByLabelText("新建集合"), { target: { value: "节日" } });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    await act(async () => {});
    expect(fake.createQqStickerCollection).toHaveBeenCalledWith({ name: "节日" });
    expect(await screen.findByText("节日")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重命名集合：日常" }));
    fireEvent.change(screen.getByLabelText("集合名称"), { target: { value: "常用" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await act(async () => {});
    expect(fake.updateQqStickerCollection).toHaveBeenCalledWith(collection.id, {
      name: "常用",
      expected_revision: 1,
    });
  });

  it("列表给首帧、详情给原图（动图在这里播）", async () => {
    await renderPage();
    const thumb = document.querySelector(".qq-sticker-thumb") as HTMLImageElement | null;
    expect(thumb?.getAttribute("src")).toBe(`/qq/stickers/${asset().id}/preview?still=1`);
    fireEvent.click(screen.getByRole("button", { name: /问好/ }));
    const preview = (await screen.findByAltText("问好")) as HTMLImageElement;
    expect(preview.getAttribute("src")).toBe(`/qq/stickers/${asset().id}/preview`);
  });

  it("批量归类与启用：一次提交，选择保留给下一次操作", async () => {
    const updated = asset({ enabled: true, tags: ["问候"], collection_ids: [collection.id] });
    const { fake } = await renderPage({
      bulkUpdateQqStickers: vi.fn().mockResolvedValue({ assets: [updated] }),
    } as Partial<typeof api>);
    fireEvent.click(screen.getByLabelText("选择问好"));
    expect(await screen.findByText(/已选择/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("归类集合"), { target: { value: collection.id } });
    fireEvent.click(screen.getByRole("button", { name: "加入集合" }));
    await act(async () => {});
    expect(fake.bulkUpdateQqStickers).toHaveBeenCalledWith({
      asset_ids: [asset().id],
      add_collection_ids: [collection.id],
    });
    expect(await screen.findByText("已更新1个素材")).toBeTruthy();
    // The selection survives, so the next batch operation applies to the same set.
    expect(screen.getByText(/已选择/)).toBeTruthy();
  });

  it("批量标签按值增删，停用要先确认", async () => {
    const { fake } = await renderPage();
    fireEvent.click(screen.getByLabelText("选择问好"));
    fireEvent.change(screen.getByLabelText("批量标签"), { target: { value: "问候" } });
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    await act(async () => {});
    expect(fake.bulkUpdateQqStickers).toHaveBeenCalledWith({
      asset_ids: [asset().id],
      tags: { add: ["问候"], remove: [] },
    });
    fireEvent.click(screen.getByRole("button", { name: "停用所选" }));
    expect(screen.getByText(/停用所选会阻止它们尚未提交的发送/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认停用" }));
    await act(async () => {});
    expect(fake.bulkUpdateQqStickers).toHaveBeenLastCalledWith({
      asset_ids: [asset().id],
      enabled: false,
    });
  });

  it("生成说明和标签：草稿只入草稿位，填进编辑器后仍需保存", async () => {
    const annotated = asset({
      description: null,
      description_draft: "一只猫在笑",
      tags: [],
      tags_draft: ["微笑", "猫"],
    });
    const { fake } = await renderPage({
      annotateQqSticker: vi.fn().mockResolvedValue({ kind: "annotated", asset: annotated }),
    } as Partial<typeof api>);
    fireEvent.click(screen.getByRole("button", { name: /问好/ }));
    fireEvent.click(await screen.findByRole("button", { name: "生成说明和标签" }));
    await act(async () => {});
    expect(fake.annotateQqSticker).toHaveBeenCalledWith(asset().id);
    // §9.2: what the model wrote is a DRAFT, shown as one, and nothing is saved yet.
    expect(await screen.findByText("模型草稿（未审核）")).toBeTruthy();
    expect(screen.getByText(/建议标签/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /把草稿填入编辑器/ }));
    expect((screen.getByLabelText("内容说明") as HTMLTextAreaElement).value).toBe("一只猫在笑");
    expect((screen.getByLabelText("标签") as HTMLInputElement).value).toBe("微笑、猫");
    // The save button is live now, which is the only thing that makes the drafts the user's own.
    expect((screen.getByRole("button", { name: "保存整理" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("未配置图片理解模型时说清楚，而不是静默失败", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /问好/ }));
    fireEvent.click(await screen.findByRole("button", { name: "生成说明和标签" }));
    await act(async () => {});
    expect(await screen.findByText(/还没有配置图片理解模型/)).toBeTruthy();
    expect(screen.queryByText("模型草稿（未审核）")).toBeNull();
  });

  it("不提供删除、替换或批量操作的控制", async () => {
    await renderPage();
    expect(screen.queryByText(/删除/)).toBeNull();
    expect(screen.queryByText(/替换/)).toBeNull();
    expect(screen.queryByText(/批量/)).toBeNull();
    expect(screen.queryByText(/生成说明/)).toBeNull();
  });
});

describe("接入下的 QQ 资源", () => {
  it("全部 QQ 资源移入接入，保留原配置入口", () => {
    store.getState().resetForTests(client());
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-stickers",
    });
    render(
      <SettingsBody>
        <span>content</span>
      </SettingsBody>,
    );
    expect(screen.getByText("接入")).toBeTruthy();
    // It is a section caption, not an entry: the three links below are what gets clicked, so the
    // caption must not be a button (2026-09-25, after it read as a button that did nothing).
    expect(screen.getByText("接入").closest("button")).toBeNull();
    expect(screen.getByRole("button", { name: /表情素材/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /聊天方案/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /存储与诊断/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "运行模式与连接" })).toBeTruthy();
    expect(screen.queryByText("未开放")).toBeNull();
  });
});
