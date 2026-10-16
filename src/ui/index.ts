// The visual system the gateway's local pages share (the demo confirm page; the panel next): one stylesheet built from
// design tokens for light and dark, and the inline intent logo. Strings only: no request, no network, no DOM.
//
// Use: serve `UI_CSS + pageRules` as the page's stylesheet (style-src 'self'); page rules use the tokens
// (`var(--text)`, …) rather than colours of their own. LOGO_SVG is ready for the brand row of the design pass.
export { LOGO_SVG } from "./logo.ts";
export { UI_CSS, UI_TOKENS } from "./style.ts";
