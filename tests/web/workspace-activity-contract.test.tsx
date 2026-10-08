import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemeDirectory } from "../../src/web/screens/connections/SchemesWorkspace";
import { ModelServices } from "../../src/web/screens/environment/ModelServices";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { StickerLibrary } from "../../src/web/screens/library/StickerLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("retained workspace activity", () => {
  it("does not load hidden document or sticker libraries", async () => {
    setupLibrary();
    const knowledge = vi.fn().mockResolvedValue(true);
    const stickers = vi.fn().mockResolvedValue(undefined);
    store.setState({ loadKnowledge: knowledge, loadQqStickers: stickers });
    render(
      <>
        <KnowledgeLibrary active={false} />
        <StickerLibrary active={false} />
      </>,
    );
    await act(async () => {});
    expect(knowledge).not.toHaveBeenCalled();
    expect(stickers).not.toHaveBeenCalled();
  });
  it("does not load hidden model services or their default settings", async () => {
    const providers = vi.fn().mockResolvedValue([]);
    setupLibrary({ listModelProviders: providers });
    const organization = vi.fn().mockResolvedValue(undefined);
    const knowledge = vi.fn().mockResolvedValue(undefined);
    const qq = vi.fn().mockResolvedValue(undefined);
    store.setState({
      loadOrganization: organization,
      loadKnowledgeModel: knowledge,
      loadQqSettings: qq,
    });
    render(<ModelServices active={false} />);
    await act(async () => {});
    expect(providers).not.toHaveBeenCalled();
    expect(organization).not.toHaveBeenCalled();
    expect(knowledge).not.toHaveBeenCalled();
    expect(qq).not.toHaveBeenCalled();
  });
  it("does not load a hidden scheme directory", async () => {
    setupLibrary();
    const schemes = vi.fn().mockResolvedValue(true);
    const bindings = vi.fn().mockResolvedValue(undefined);
    store.setState({ loadQqSchemes: schemes, loadQqBindings: bindings });
    render(<SchemeDirectory active={false} />);
    await act(async () => {});
    expect(schemes).not.toHaveBeenCalled();
    expect(bindings).not.toHaveBeenCalled();
  });
});
