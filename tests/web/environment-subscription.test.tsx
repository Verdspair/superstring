import { act, cleanup, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelServices } from "../../src/web/screens/environment/ModelServices";
import { Preferences } from "../../src/web/screens/environment/Preferences";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("environment subscription boundaries", () => {
  it.each([
    { name: "model services", Component: ModelServices },
    { name: "preferences", Component: Preferences },
  ])("does not commit $name for unrelated QQ background updates", async ({ Component }) => {
    setupLibrary({
      listModelProviders: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue({
        provider: "lm_studio",
        status: "empty",
        models: [],
        default_model: "model",
      }),
    });
    store.setState({ loadOrganization: vi.fn().mockResolvedValue(undefined) });
    let commits = 0;
    render(
      <Profiler
        id="environment"
        onRender={() => {
          commits++;
        }}
      >
        <Component />
      </Profiler>,
    );
    await act(async () => {});
    const settled = commits;
    for (let i = 0; i < 5; i++)
      await act(async () => {
        store.setState({ qqStickerLoading: i % 2 === 0 });
      });
    expect(commits).toBe(settled);
  });
});
