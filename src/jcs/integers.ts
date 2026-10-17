// Integer-only JSON (contract 1.6.0 hardening amendment, item 9). JSON.parse reads `1.0` and `1e0` as the integer 1,
// so a schema that checks the parsed value cannot tell them from `1`: an amount Intent Cloud wrote as `12500.0`
// would pass as 12500. The contract has no fractional number anywhere, so a body with a number token holding a
// fraction or an exponent is refused before it is parsed. Pure.

/** The first number token in JSON text with a fraction or an exponent, or null when every number is an integer. */
export function nonIntegerToken(text: string): string | null {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      // Skip the string, escapes included: digits inside a string are text, not numbers.
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      const token = /^-?[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]*)?/.exec(text.slice(i))?.[0] ?? c;
      if (/[.eE]/.test(token)) return token;
      i += token.length;
      continue;
    }
    i += 1;
  }
  return null;
}
