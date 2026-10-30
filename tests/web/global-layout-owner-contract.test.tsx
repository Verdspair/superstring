import { readFileSync } from "node:fs";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsGroup, SettingsRow } from "../../src/web/components/settings-group";
import { Button } from "../../src/web/components/ui/button";
import { Card, CardContent } from "../../src/web/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../src/web/components/ui/tabs";
import { WorkspacePageHeader } from "../../src/web/workspace/WorkspacePageHeader";
import { render } from "./helpers/render-with-providers";

afterEach(cleanup);

it("keeps heading, back, help and long-label actions independent", () => {
  const back = vi.fn(),
    save = vi.fn();
  render(
    <WorkspacePageHeader
      location="Global scope"
      title="A long task title"
      description="Help"
      backAction={
        <Button aria-label="Back" onClick={back}>
          ←
        </Button>
      }
      actions={<Button onClick={save}>Save this long task without changing another draft</Button>}
    />,
  );
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Save this long task without changing another draft" }),
  );
  expect(back).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledOnce();
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("keeps row controls and an unboxed task card semantically unchanged", () => {
  const change = vi.fn();
  const { container } = render(
    <>
      <SettingsGroup title="Settings">
        <SettingsRow label={<label htmlFor="setting">Enabled</label>}>
          <input id="setting" type="checkbox" onChange={change} />
        </SettingsRow>
      </SettingsGroup>
      <Card presentation="plain">
        <CardContent>Task body</CardContent>
      </Card>
    </>,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
  expect(change).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-presentation="plain"]')?.textContent).toBe("Task body");
});

it("keeps tab selection and mounted drafts while only the flow changes", async () => {
  const view = render(
    <Tabs defaultValue="one">
      <TabsList presentation="workspace" flow="wrap">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one" forceMount>
        <input aria-label="Draft" defaultValue="saved draft" />
      </TabsContent>
      <TabsContent value="two">Other</TabsContent>
    </Tabs>,
  );
  const draft = screen.getByRole("textbox", { name: "Draft" });
  await userEvent.click(screen.getByRole("tab", { name: "Two" }));
  expect(screen.getByRole("tab", { name: "Two" }).getAttribute("aria-selected")).toBe("true");
  expect(draft.isConnected).toBe(true);
  view.rerender(
    <Tabs defaultValue="one">
      <TabsList presentation="workspace" flow="scroll">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one" forceMount>
        <input aria-label="Draft" defaultValue="saved draft" />
      </TabsContent>
      <TabsContent value="two">Other</TabsContent>
    </Tabs>,
  );
  expect(screen.getByRole("tab", { name: "Two" }).getAttribute("aria-selected")).toBe("true");
  expect(draft.isConnected).toBe(true);
  expect((draft as HTMLInputElement).value).toBe("saved draft");
});

it("keeps shared page geometry separate from viewport and scroll ownership", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  const geometry = css.match(/\.workspace-page\s*\{([^}]+)\}/)?.[1];
  expect(geometry).toBeTruthy();
  expect(geometry).not.toMatch(/overflow|height|display/);
  expect(geometry).toMatch(/max-width:\s*1160px/);
  expect(geometry).toMatch(/padding:\s*28px 36px 64px/);
});

it("keeps generated ScrollArea content sizing in the shared owner instead of reader shims", () => {
  for (const path of [
    "src/web/screens/conversations/ConversationActiveTraces.tsx",
    "src/web/screens/observability/InvestigationCanvas.tsx",
    "src/web/screens/runs/RunEntry.tsx",
  ]) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/data-radix-scroll-area-viewport[^\n]*block!/);
    expect(source).toContain("<ScrollArea");
  }
  const timeline = readFileSync("src/web/screens/observability/TraceTimeline.tsx", "utf8");
  expect(timeline).toContain('<ScrollArea contentSizing="intrinsic"');
  expect(timeline).toContain("min-w-[42rem]");
  expect(timeline).toContain('<ScrollBar orientation="horizontal"');
});
