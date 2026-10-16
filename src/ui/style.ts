// The visual system of the gateway's local pages (the demo confirm page; the panel next): the approved "Receipt"
// look, dark by design. An ink ground carries the brand row, a paper card holds the content, and amber marks demo
// mode. Plain CSS with no font, image or other request, so a page works offline under a
// `default-src 'none'; style-src 'self'` CSP. A page serves UI_CSS plus its own rules as its one stylesheet.
//
// Type: Geist and Geist Mono when the system has them, else the system stack. The fonts are not bundled: a page must
// make no request outside the gateway, and serving font files is more than a demo page needs.
//
// Components: .shell (centred column) > .top (.brand with LOGO_SVG, .pill) and .steps; .paper (the card) with
// .dash sections (dashed rule) and .lines (monospace label/value rows, .strong value); .btn .btn-primary /
// .btn-secondary; .alert (on paper); .status .status-ok/-no/-warn/-err with an ICONS svg; .next (next step box);
// .note and .foot (text on the ground); .cmd (inline command); .sr-only.

/** Token name (without `--`) → value. ui.test.ts checks every text/background pair below meets WCAG AA. */
export const UI_TOKENS = {
  ground: "#0B0C0C",
  "on-ground": "#FFFFFF",
  "on-ground-muted": "#AFC9B5",
  paper: "#FAFAF7",
  "paper-2": "#EEF0EC",
  "on-paper": "#0B0C0C",
  "on-paper-muted": "#55605A",
  rule: "#C7CEC8",
  "rule-strong": "#0B0C0C",
  line: "#4A514C",
  sage: "#AFC9B5",
  "sage-hover": "#C6DACB",
  "deep-sage": "#2F5D41",
  "deep-sage-bg": "#E3EEE6",
  "demo-bg": "#F2C46B",
  "demo-text": "#0B0C0C",
  "warn-bg": "#FFF4DF",
  "warn-text": "#6B4304",
  danger: "#A33A2A",
  "danger-bg": "#FBECE9",
  "danger-on-ground": "#F28B82",
  success: "#8BD3A0",
  "disabled-bg": "#3A3F3C",
  "disabled-text": "#A9B1AB",
  sans: 'Geist,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  mono: '"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace',
} as const;

/** The text/background pairs a page uses; each must reach 4.5:1. */
export const UI_CONTRAST_PAIRS: readonly (readonly [keyof typeof UI_TOKENS, keyof typeof UI_TOKENS])[] = [
  ["on-ground", "ground"],
  ["on-ground-muted", "ground"],
  ["danger-on-ground", "ground"],
  ["success", "ground"],
  ["on-paper", "paper"],
  ["on-paper-muted", "paper"],
  ["on-paper", "paper-2"],
  ["on-paper-muted", "paper-2"],
  ["danger", "paper"],
  ["danger", "danger-bg"],
  ["deep-sage", "paper"],
  ["deep-sage", "deep-sage-bg"],
  ["warn-text", "warn-bg"],
  ["demo-text", "demo-bg"],
  ["ground", "sage"],
  ["ground", "sage-hover"],
];

const vars = Object.entries(UI_TOKENS)
  .map(([name, value]) => `--${name}:${value}`)
  .join(";");

/** The shared stylesheet: the tokens, then the base rules and components that use them. */
export const UI_CSS = `:root{color-scheme:dark;${vars}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--ground);color:var(--on-ground);font:16px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
h1,h2,p{margin:0}
code{font-family:var(--mono)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.shell{width:100%;max-width:33rem;margin:0 auto;padding:32px 16px 28px;display:flex;flex-direction:column;gap:18px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{display:flex;align-items:center}
.logo{display:block;height:26px;width:auto}.logo .ink{fill:var(--on-ground)}.logo .leaf{fill:var(--sage)}
.pill{font:600 12px/1.4 var(--mono);color:var(--demo-text);background:var(--demo-bg);border-radius:999px;padding:4px 10px;white-space:nowrap}
.steps{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none;font:12px/1.4 var(--mono);color:var(--on-ground-muted)}
.steps li+li::before{content:"·";margin-right:8px;color:var(--on-ground-muted)}
.steps .now{color:var(--on-ground)}
.paper{background:var(--paper);color:var(--on-paper);border-radius:14px;padding:26px 24px;display:flex;flex-direction:column;gap:18px}
.dash{border-top:1.5px dashed var(--rule);padding-top:16px}
.lines{display:flex;flex-direction:column;gap:8px;margin:0;font:14px/1.45 var(--mono)}
.lines>div{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.lines dt,.lines .k{color:var(--on-paper-muted)}.lines dd{margin:0;text-align:right;overflow-wrap:anywhere}
.lines .item dt{color:var(--on-paper)}.lines .strong{font-weight:600}
.cmd{font:13px/1.5 var(--mono);background:var(--paper-2);border-radius:5px;padding:1px 5px;overflow-wrap:anywhere;color:var(--on-paper)}
.btn{display:flex;align-items:center;justify-content:center;width:100%;margin:0;border-radius:12px;font:600 16px/1.2 var(--sans);
cursor:pointer;text-align:center;transition:background-color .15s ease,border-color .15s ease,color .15s ease}
.btn:focus-visible{outline:2px solid var(--sage);outline-offset:3px}
.btn:active:not(:disabled){transform:translateY(1px)}
.btn-primary{min-height:52px;padding:15px 18px;border:0;background:var(--sage);color:var(--ground)}
.btn-primary:hover:not(:disabled){background:var(--sage-hover)}
.btn-primary:disabled{background:var(--disabled-bg);color:var(--disabled-text);cursor:not-allowed}
.btn-secondary{min-height:44px;padding:12px 18px;font-size:15px;font-weight:500;background:transparent;color:var(--on-ground);border:1px solid var(--line)}
.btn-secondary:hover{border-color:var(--on-ground-muted);background:rgba(255,255,255,.04)}
.alert{display:flex;gap:8px;align-items:flex-start;padding:12px 14px;border-radius:10px;font-size:14px;line-height:1.45}
.alert .icon{flex:none;width:18px;height:18px;margin-top:1px}
.alert-error{color:var(--danger);background:var(--danger-bg)}
.status{display:grid;place-items:center;width:48px;height:48px;border-radius:50%}
.status .icon{width:24px;height:24px}
.status-ok{color:var(--deep-sage);background:var(--deep-sage-bg)}.status-no{color:var(--on-paper-muted);background:var(--paper-2)}
.status-warn{color:var(--warn-text);background:var(--warn-bg)}.status-err{color:var(--danger);background:var(--danger-bg)}
.icon{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.next{padding:14px 16px;border-radius:10px;background:var(--paper-2);font-size:15px}
.next strong{display:block;font:600 12px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--on-paper-muted);margin-bottom:2px}
.note{font-size:12px;color:var(--on-ground-muted);text-align:center}
.foot{font-size:12px;line-height:1.5;color:var(--on-ground-muted);text-align:center}
@media (max-width:420px){.shell{padding-top:20px}.paper{padding:22px 18px}}
@media (prefers-reduced-motion:reduce){.btn{transition:none}.btn:active:not(:disabled){transform:none}}
`;

const svg = (body: string): string => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

/** Line icons (24×24, stroke currentColor), decorative: each sits next to text that says the same thing. */
export const ICONS = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  cross: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  alert: svg('<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
} as const;
