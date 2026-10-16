// The visual system of the gateway's local pages (the demo confirm page; the panel next). Plain CSS with no font,
// image or other request, so a page works offline under a `default-src 'none'; style-src 'self'` CSP. A page serves
// UI_CSS plus its own rules as its one stylesheet.
//
// The tokens carry today's look of the confirm page; a later design pass changes their values and the components,
// not the pages. Every page colour comes from a token, and dark mode redefines the same tokens.

/** Token name (without `--`) → value, per scheme. Both schemes define the same names (ui.test.ts checks it). */
export const UI_TOKENS = {
  light: {
    bg: "#fff",
    text: "#111",
    muted: "#555",
    border: "#333",
    "primary-bg": "#166534",
    "primary-text": "#fff",
    "banner-bg": "#fde68a",
    "banner-border": "#b45309",
    "banner-text": "#111",
    danger: "#b91c1c",
    sans: "system-ui,sans-serif",
  },
  dark: {
    bg: "#111",
    text: "#eee",
    muted: "#aaa",
    border: "#333",
    "primary-bg": "#166534",
    "primary-text": "#fff",
    "banner-bg": "#fde68a",
    "banner-border": "#b45309",
    "banner-text": "#111",
    danger: "#fca5a5",
    sans: "system-ui,sans-serif",
  },
} as const;

const vars = (tokens: Record<string, string>): string =>
  Object.entries(tokens)
    .map(([name, value]) => `--${name}:${value}`)
    .join(";");

/** The shared stylesheet: the tokens for both schemes, then the base rules and components that use them. */
export const UI_CSS = `:root{${vars(UI_TOKENS.light)}}
@media (prefers-color-scheme:dark){:root{${vars(UI_TOKENS.dark)}}}
body{font:16px/1.5 var(--sans);max-width:32rem;margin:2rem auto;padding:0 1rem;color:var(--text);background:var(--bg)}
.demo{background:var(--banner-bg);color:var(--banner-text);border:2px solid var(--banner-border);padding:.5rem .75rem;font-weight:700}
.hint{color:var(--muted)}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:var(--muted)}dd{margin:0}
button{font:inherit;padding:.6rem 1rem;margin:.5rem .5rem 0 0;border-radius:.4rem;border:1px solid var(--border);cursor:pointer}
.primary{background:var(--primary-bg);color:var(--primary-text)}
.error{color:var(--danger);font-weight:700}
`;
