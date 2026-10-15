// RFC 8785 JSON Canonicalization Scheme, integer profile: the only numbers accepted are safe integers, so number
// serialisation is exact and identical in every language that shares our test vectors.

export class JcsError extends Error {
  override name = "JcsError";
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.path = path;
  }
}

/** Returns the canonical JSON text of a JSON value, or throws JcsError for a value outside the integer profile. */
export function canonicalize(value: unknown): string {
  return serialize(value, "$", new Set());
}

function serialize(value: unknown, path: string, open: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value, path);
    case "string":
      return serializeString(value, path);
    case "object":
      break;
    default:
      throw new JcsError(`${typeof value} is not a JSON value`, path);
  }
  if (open.has(value)) throw new JcsError("cyclic structure", path);
  open.add(value);
  try {
    if (Array.isArray(value)) return serializeArray(value, path, open);
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new JcsError("not a plain object", path);
    return serializeObject(value as Record<string, unknown>, path, open);
  } finally {
    open.delete(value);
  }
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new JcsError(`${String(value)} is not a JSON number`, path);
  if (!Number.isInteger(value)) throw new JcsError("non-integer number", path);
  if (!Number.isSafeInteger(value)) throw new JcsError("integer outside ±(2^53−1)", path);
  // RFC 8785 §3.2.2.3 serialises -0 as "0"; String(-0) already yields "0".
  return String(value);
}

function serializeString(value: string, path: string): string {
  if (!value.isWellFormed()) throw new JcsError("lone surrogate in string", path);
  // For a well-formed string JSON.stringify applies exactly the RFC 8785 §3.2.2.2 escaping: \b \t \n \f \r \" \\,
  // other U+0000..U+001F as lowercase \u00xx, everything else (U+007F, U+2028, astral characters) as-is.
  return JSON.stringify(value);
}

function serializeArray(value: readonly unknown[], path: string, open: Set<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new JcsError("not a plain array", path);
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const at = `${path}[${String(i)}]`;
    if (!(i in value)) throw new JcsError("sparse array hole", at);
    parts.push(serialize(value[i], at, open));
  }
  return `[${parts.join(",")}]`;
}

function serializeObject(value: Record<string, unknown>, path: string, open: Set<object>): string {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new JcsError("symbol key", path);
  // The default sort compares UTF-16 code units, which is the order RFC 8785 §3.2.3 requires.
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => {
    const at = `${path}[${JSON.stringify(key)}]`;
    return `${serializeString(key, at)}:${serialize(value[key], at, open)}`;
  });
  return `{${parts.join(",")}}`;
}
