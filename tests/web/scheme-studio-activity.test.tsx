import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("scheme studio activity", () => {
  it("does not load the scheme catalog or sticker collections while inactive", async () => {
    setupLibrary();
    const schemes = vi.fn().mockResolvedValue(true);
    const stickers = vi.fn().mockResolvedValue(undefined);
    store.setState({ loadQqSchemes: schemes, loadQqStickers: stickers });

    const view = render(<SchemeStudio active={false} />);
    await act(async () => {});
    expect(schemes).toHaveBeenCalledTimes(0);
    expect(stickers).toHaveBeenCalledTimes(0);

    view.rerender(<SchemeStudio active />);
    await act(async () => {});
    expect(schemes).toHaveBeenCalledTimes(1);
    expect(stickers).toHaveBeenCalledTimes(1);
  });
});
