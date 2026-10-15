import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 of bytes, or of a string's UTF-8 encoding. A string with a lone surrogate is refused,
 * because UTF-8 encoding would silently replace it with U+FFFD and two different strings would share one hash. */
export function sha256Hex(input: Uint8Array | string): string {
  if (typeof input === "string" && !input.isWellFormed()) throw new TypeError("sha256Hex: lone surrogate in string");
  return createHash("sha256").update(input).digest("hex");
}
