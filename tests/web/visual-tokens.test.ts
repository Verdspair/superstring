import { afterEach, describe, expect, it } from "vitest";
import { THEMES } from "../../src/shared/appearance";
import { applyTheme } from "../../src/web/appearance";

function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (channels?.length !== 3) throw new Error(`Invalid color ${hex}`);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
function appliedModeColors(token: string): [string, string] {
  const value = document.documentElement.style.getPropertyValue(token);
  const match = value.match(/light-dark\((#[a-f\d]{6}), (#[a-f\d]{6})\)/i);
  if (!match) throw new Error(`Missing light/dark color pair: ${token}`);
  return [match[1], match[2]];
}

afterEach(() => applyTheme("slate"));

describe("workspace theme readability", () => {
  it.each(THEMES)("$id maintains readable primary actions in both modes", (theme) => {
    applyTheme(theme.id);
    for (const role of ["primary", "sidebar-primary"]) {
      const backgrounds = appliedModeColors(`--${role}`);
      const foregrounds = appliedModeColors(`--${role}-foreground`);
      for (const mode of [0, 1]) {
        expect(
          contrast(backgrounds[mode], foregrounds[mode]),
          `${role} / ${mode}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
