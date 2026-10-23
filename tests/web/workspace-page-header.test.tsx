import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, type Locale, selectLocale, translate } from "../../src/web/i18n";
import { WorkspacePageHeader } from "../../src/web/workspace/WorkspacePageHeader";
import { render } from "./helpers/render-with-providers";

// The header is presentation-only, so this synthetic copy is the contract under test.
const LOCATION = "Apps · Schemes";
const TITLE = "QQ Schemes";
const DESCRIPTION = "Scheme edits stay in the draft until an explicit save.";

const initialLocale = getLocale();
const locales: Locale[] = ["zh-CN", "en"];

afterEach(() => {
  cleanup();
  selectLocale(initialLocale);
});

const helpName = () => translate("hints.field.learnAbout", TITLE);

describe("WorkspacePageHeader", () => {
  it.each(locales)("%s shows the location and one level-one title anchor", (locale) => {
    selectLocale(locale);
    render(<WorkspacePageHeader location={LOCATION} title={TITLE} description={DESCRIPTION} />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: TITLE }).textContent).toBe(TITLE);
    expect(screen.getByText(LOCATION).closest("h1")).toBeNull();
  });

  it.each(locales)("%s keeps the root description out of permanent body content", (locale) => {
    selectLocale(locale);
    render(<WorkspacePageHeader location={LOCATION} title={TITLE} description={DESCRIPTION} />);

    expect(screen.queryByText(DESCRIPTION)).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("button", { name: helpName() })).toBeTruthy();
  });

  it("localizes the help control label through hints.field.learnAbout", () => {
    selectLocale("en");
    const enLabel = helpName();
    selectLocale("zh-CN");
    const zhLabel = helpName();

    expect(enLabel).not.toBe(zhLabel);
    for (const label of [enLabel, zhLabel]) {
      expect(label).toContain(TITLE);
      expect(label).not.toMatch(/learnAbout|\{0\}/);
    }

    for (const [locale, label] of [
      ["en", enLabel],
      ["zh-CN", zhLabel],
    ] as const) {
      selectLocale(locale);
      const view = render(
        <WorkspacePageHeader location={LOCATION} title={TITLE} description={DESCRIPTION} />,
      );
      const help = screen.getByRole("button", { name: label });
      expect(help.tagName).toBe("BUTTON");
      expect(help.getAttribute("type")).toBe("button");
      view.unmount();
    }
  });

  it("opens the description on keyboard focus and closes it with Escape", async () => {
    const user = userEvent.setup();
    selectLocale("zh-CN");
    render(<WorkspacePageHeader location={LOCATION} title={TITLE} description={DESCRIPTION} />);

    const help = screen.getByRole("button", { name: helpName() });
    await user.tab();
    expect(document.activeElement).toBe(help);

    expect((await screen.findByRole("tooltip")).textContent).toBe(DESCRIPTION);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(screen.queryByText(DESCRIPTION)).toBeNull();
  });

  it("opens the description on hover and hides it when the pointer leaves", async () => {
    const user = userEvent.setup();
    selectLocale("en");
    render(<WorkspacePageHeader location={LOCATION} title={TITLE} description={DESCRIPTION} />);

    const help = screen.getByRole("button", { name: helpName() });
    await user.hover(help);
    expect((await screen.findByRole("tooltip")).textContent).toBe(DESCRIPTION);

    await user.unhover(help);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("toggles the description on click instead of leaving it visible", async () => {
    const user = userEvent.setup();
    selectLocale("en");
    render(<WorkspacePageHeader location={LOCATION} title={TITLE} description={DESCRIPTION} />);

    const help = screen.getByRole("button", { name: helpName() });
    await user.click(help);
    expect((await screen.findByRole("tooltip")).textContent).toBe(DESCRIPTION);

    await user.click(help);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(screen.queryByText(DESCRIPTION)).toBeNull();
  });

  it("keeps header actions independent from the help tooltip", async () => {
    const user = userEvent.setup();
    selectLocale("en");
    const onRefresh = vi.fn();
    render(
      <WorkspacePageHeader
        location={LOCATION}
        title={TITLE}
        description={DESCRIPTION}
        actions={
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
        }
      />,
    );

    const action = screen.getByRole("button", { name: "Refresh" });
    const help = screen.getByRole("button", { name: helpName() });

    await user.click(action);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByText(DESCRIPTION)).toBeNull();
    expect(help.getAttribute("aria-label")).toBe(helpName());

    await user.click(help);
    expect((await screen.findByRole("tooltip")).textContent).toBe(DESCRIPTION);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it.each(locales)("keeps an optional back action beside the location and help", async (locale) => {
    selectLocale(locale);
    const onBack = vi.fn();
    const { container } = render(
      <WorkspacePageHeader
        location={LOCATION}
        title={TITLE}
        description={DESCRIPTION}
        backAction={
          <button type="button" onClick={onBack}>
            Back
          </button>
        }
      />,
    );

    const header = container.querySelector("header");
    const location = screen.getByText(LOCATION);
    const back = screen.getByRole("button", { name: "Back" });
    const title = screen.getByRole("heading", { level: 1, name: TITLE });
    const help = screen.getByRole("button", { name: helpName() });

    expect(header?.contains(back)).toBe(true);
    expect(back.parentElement).toBe(location.parentElement);
    expect(back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(help.getAttribute("aria-label")).toBe(helpName());

    const user = userEvent.setup();
    await user.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.hover(help);
    expect((await screen.findByRole("tooltip")).textContent).toBe(DESCRIPTION);
  });

  it.each(locales)("keeps the root header anchors in reading order for %s", (locale) => {
    selectLocale(locale);
    const { container } = render(
      <WorkspacePageHeader
        location={LOCATION}
        title={TITLE}
        description={DESCRIPTION}
        actions={<button type="button">Refresh</button>}
      />,
    );

    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    const location = screen.getByText(LOCATION);
    const title = screen.getByRole("heading", { level: 1, name: TITLE });
    const help = screen.getByRole("button", { name: helpName() });

    expect(header?.contains(location)).toBe(true);
    expect(location.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Help belongs to the title row; the page action is a separate control.
    expect(title.parentElement?.contains(help)).toBe(true);
    expect(help.closest("h1")).toBeNull();
  });
});

it("dismisses click-pinned help when another part of the page is pressed", async () => {
  const user = userEvent.setup();
  render(
    <>
      <WorkspacePageHeader location={LOCATION} title={TITLE} description={DESCRIPTION} />
      <button type="button">Outside</button>
    </>,
  );
  await user.click(screen.getByRole("button", { name: helpName() }));
  expect(await screen.findByRole("tooltip")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Outside" }));
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});
