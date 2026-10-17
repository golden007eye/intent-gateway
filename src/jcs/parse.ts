// JSON parsing under the integer-only profile (contract 1.6.0, Appendix A and G): plain JSON.parse reads `1.0` and
// `1e0` as the integer 1, so a binding input could not tell them apart. Here every number token that is not written
// as a safe integer (`-?(0|[1-9][0-9]*)`, within ±(2^53−1)) becomes a NonIntegerNumber, which no check accepts as a
// number and canonicalize refuses (it is not a plain object). Pure.

/** A number token outside the integer profile, kept as its source text. */
export class NonIntegerNumber {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}

const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;

type SourceReviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

/** JSON.parse, with every non-integer or unsafe number token replaced by a NonIntegerNumber. Throws as JSON.parse does. */
export function parseIntegerJson(text: string): unknown {
  const reviver: SourceReviver = (_key, value, context) => {
    if (typeof value !== "number") return value;
    const source = context?.source;
    // Without the source text (a runtime that lacks it) a number cannot be judged: fail closed.
    if (source === undefined || !INTEGER_TOKEN.test(source) || !Number.isSafeInteger(value)) return new NonIntegerNumber(source ?? String(value));
    return value;
  };
  return JSON.parse(text, reviver);
}
