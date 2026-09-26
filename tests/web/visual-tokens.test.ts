import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES } from "../../src/shared/appearance";

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
const tokens = readFileSync("src/web/styles/tokens.css", "utf8");
function modeColors(token: string): [string, string] {
  const match = tokens.match(
    new RegExp(`${token}: light-dark\\((#[a-f\\d]{6}), (#[a-f\\d]{6})\\)`),
  );
  if (!match) throw new Error(`Missing light/dark color pair: ${token}`);
  return [match[1], match[2]];
}

describe("workspace theme readability", () => {
  it.each(THEMES)("$id maintains readable primary actions in both modes", (theme) => {
    const foreground = modeColors("--ss-on-accent");
    expect(contrast(theme.color, foreground[0])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.dark, foreground[1])).toBeGreaterThanOrEqual(4.5);
  });

  it("primary and secondary text remain readable on all permanent surfaces", () => {
    for (const surface of ["--ss-canvas", "--ss-navigation", "--ss-surface", "--ss-inset"]) {
      for (const text of ["--ss-text", "--ss-text-secondary"]) {
        const background = modeColors(surface);
        const foreground = modeColors(text);
        for (const mode of [0, 1]) {
          expect(
            contrast(background[mode], foreground[mode]),
            `${surface} / ${text} / ${mode}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("error, success and warning text remain readable on their surfaces", () => {
    for (const status of ["danger", "success", "warning"]) {
      const foreground = modeColors(`--ss-${status}`);
      const background = modeColors(`--ss-${status}-soft`);
      for (const mode of [0, 1]) {
        expect(contrast(background[mode], foreground[mode])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
