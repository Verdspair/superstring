import { expect, it } from "vitest";
import { api } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";

it("does not carry a component detail into a reset API session", () => {
  store.getState().resetForTests(api);
  store.setState({ componentTarget: { kind: "skill", id: "system-evidence-reading" } });
  store.getState().resetForTests(api);
  expect(store.getState().componentTarget).toBeNull();
});
