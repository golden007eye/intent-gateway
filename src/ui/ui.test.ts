// The shared visual system: both schemes define the same tokens, every page colour in UI_CSS comes from a token, and
// nothing in it or in the logo makes a request (the pages run offline under `default-src 'none'`).
import { describe, expect, it } from "vitest";
import { LOGO_SVG, UI_CSS, UI_TOKENS } from "./index.ts";

describe("ui", () => {
  it("defines the same tokens for light and dark, and declares both in UI_CSS", () => {
    expect(Object.keys(UI_TOKENS.dark).sort()).toEqual(Object.keys(UI_TOKENS.light).sort());
    expect(UI_CSS).toContain("@media (prefers-color-scheme:dark)");
    for (const name of Object.keys(UI_TOKENS.light)) expect(UI_CSS).toContain(`--${name}:`);
  });

  it("uses colours only through tokens outside the token blocks", () => {
    const rules = UI_CSS.split("\n").filter((line) => !line.includes("--") || line.includes("var(--"));
    expect(rules.filter((line) => !line.startsWith(":root") && !line.startsWith("@media")).join("\n")).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl/i);
  });

  it("makes no request: no url(), @import or http in the CSS, no URL in the logo", () => {
    expect(UI_CSS).not.toMatch(/url\(|@import|https?:/i);
    expect(LOGO_SVG).toMatch(/^<svg [^>]*role="img" aria-label="intent">/);
    expect(LOGO_SVG).not.toMatch(/https?:|href|<image|<script|\son[a-z]+=/i);
  });
});
