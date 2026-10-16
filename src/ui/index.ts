// The visual system the gateway's local pages share (the demo confirm page and the panel): the "Receipt" look as
// one stylesheet built from design tokens, the inline intent logo and line icons. Strings only: no request, no
// network, no DOM.
//
// Use: serve `UI_CSS + pageRules` as the page's stylesheet (style-src 'self'); page rules use the tokens
// (`var(--paper)`, …) rather than colours of their own. Put LOGO_SVG in `.brand`; the class names are listed at the
// top of style.ts.
export { LOGO_SVG } from "./logo.ts";
export { ICONS, UI_CONTRAST_PAIRS, UI_CSS, UI_TOKENS } from "./style.ts";
