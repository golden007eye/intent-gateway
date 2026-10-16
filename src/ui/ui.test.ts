// The shared visual system: every text colour meets WCAG AA on its background, the CSS declares every token, and
// nothing in it, the logo or the icons makes a request (the pages run offline under `default-src 'none'`).
import { describe, expect, it } from "vitest";
import { ICONS, LOGO_SVG, UI_CONTRAST_PAIRS, UI_CSS, UI_TOKENS } from "./index.ts";

/** WCAG 2 relative luminance of `#RRGGBB`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("ui", () => {
  it("meets WCAG AA (4.5:1) for every text/background pair", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    for (const [fg, bg] of UI_CONTRAST_PAIRS) {
      expect(contrast(UI_TOKENS[fg], UI_TOKENS[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("declares every token in UI_CSS", () => {
    for (const [name, value] of Object.entries(UI_TOKENS)) expect(UI_CSS).toContain(`--${name}:${value}`);
  });

  it("makes no request: no url(), @import, @font-face or http in the CSS, no URL in the logo or icons", () => {
    expect(UI_CSS).not.toMatch(/url\(|@import|@font-face|https?:/i);
    expect(LOGO_SVG).toMatch(/^<svg [^>]*role="img" aria-label="intent">/);
    for (const svg of [LOGO_SVG, ...Object.values(ICONS)]) expect(svg).not.toMatch(/https?:|href|<image|<script|\son[a-z]+=|style=/i);
  });
});
