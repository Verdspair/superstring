import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../src/web/components/ui/tabs";
import { render } from "./helpers/render-with-providers";

afterEach(cleanup);

describe("Tabs orientation", () => {
  it("forwards vertical orientation and selects the next tab with ArrowDown", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="one" orientation="vertical">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">One content</TabsContent>
        <TabsContent value="two">Two content</TabsContent>
      </Tabs>,
    );

    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe("vertical");

    const first = screen.getByRole("tab", { name: "One" });
    const second = screen.getByRole("tab", { name: "Two" });
    await user.click(first);
    await user.keyboard("{ArrowDown}");

    await waitFor(() => expect(second.getAttribute("aria-selected")).toBe("true"));
    expect(first.getAttribute("aria-selected")).toBe("false");
  });

  it("keeps the default horizontal orientation and selects the next tab with ArrowRight", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">One content</TabsContent>
        <TabsContent value="two">Two content</TabsContent>
      </Tabs>,
    );

    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe("horizontal");

    const first = screen.getByRole("tab", { name: "One" });
    const second = screen.getByRole("tab", { name: "Two" });
    await user.click(first);
    await user.keyboard("{ArrowRight}");

    await waitFor(() => expect(second.getAttribute("aria-selected")).toBe("true"));
    expect(first.getAttribute("aria-selected")).toBe("false");
  });

  it("keeps tab state and keyboard selection when the trigger has a tooltip", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one" tooltip="About one">
            One
          </TabsTrigger>
          <TabsTrigger value="two" tooltip="About two">
            Two
          </TabsTrigger>
        </TabsList>
        <TabsContent value="one">One content</TabsContent>
        <TabsContent value="two">Two content</TabsContent>
      </Tabs>,
    );
    const first = screen.getByRole("tab", { name: "One" });
    const second = screen.getByRole("tab", { name: "Two" });
    await user.click(first);
    expect(first.getAttribute("data-state")).toBe("active");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(second.getAttribute("aria-selected")).toBe("true"));
    expect(second.getAttribute("data-state")).toBe("active");
    expect(first.getAttribute("data-state")).toBe("inactive");
  });
});
