// The one output sanitiser. Every value the CLI prints, and the panel writes, that it did not write itself (a chain entry's
// strings: a product title or merchant name Intent Cloud returned, a held-back category, a reason, a timestamp; an
// error message carrying a server's words) passes through `printable` before it is printed. Merchant text reaches
// the chain verbatim, so without this a title could clear the screen (ESC[2J), write the clipboard (OSC 52), hide a
// link (OSC 8), reorder what is shown (bidi overrides) or print a fake timeline row (an embedded newline).
//
// `printable` makes each such character visible instead: C0 controls, DEL, C1 controls, format characters (Unicode
// Cf: bidi controls, zero-width characters) and lone surrogates become `\u{1b}`-style text, and each run of line
// breaks (CR, LF, VT, FF, NEL, U+2028, U+2029) becomes a single literal `\n`, so one value stays on one line. The
// CLI's own colour codes are added after it, around text it already made printable; the panel escapes the result
// for HTML (a bidi override would reorder a page as it does a terminal). Pure.

const LINE_BREAKS = /[\r\n\v\f\u0085\u2028\u2029]+/gu;
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/gu;

/** `text` as one line of plain characters: every control, format or line-break character shown as an escape. */
export function printable(text: string): string {
  return text.replace(LINE_BREAKS, "\\n").replace(UNPRINTABLE, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
}

/** Each line of `text` made printable, its line breaks kept: for output whose lines hold no colour codes. */
export function printableLines(text: string): string {
  return text.split("\n").map(printable).join("\n");
}

/** A JSON line safe to print: JSON.stringify already escapes C0; this also escapes DEL, C1 and Cf, as `\uXXXX`. */
export function printableJson(json: string): string {
  const unit = (u: number): string => `\\u${u.toString(16).padStart(4, "0")}`;
  return json.replace(/[\u007f-\u009f\u2028\u2029\p{Cf}\p{Cs}]/gu, (c) => Array.from({ length: c.length }, (_, i) => unit(c.charCodeAt(i))).join(""));
}
