// Reads the regular files of an npm tarball (gzip + ustar, with pax and GNU long names). The tarball has already
// matched the registry's sha512 integrity, so this only has to read it, not defend against it; unsafe paths are
// still refused.
import { gunzipSync } from "node:zlib";
import { CheckFailure } from "./result.ts";

const BLOCK = 512;

const text = (b: Buffer, start: number, length: number): string => {
  const field = b.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
};

function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const recordLength = Number(data.subarray(pos, space).toString("ascii"));
    if (!Number.isInteger(recordLength) || recordLength <= 0) break;
    const record = data.subarray(space + 1, pos + recordLength - 1).toString("utf8");
    if (record.startsWith("path=")) path = record.slice(5);
    pos += recordLength;
  }
  return path;
}

/** Returns the tarball's regular files keyed by path, with the top directory (`package/`) removed. */
export function readTarGz(tgz: Buffer): Map<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz);
  } catch {
    throw new CheckFailure("tarball-integrity-mismatch", "tarball is not gzip");
  }
  const files = new Map<string, Buffer>();
  let longName: string | undefined;
  for (let pos = 0; pos + BLOCK <= tar.length; ) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(text(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const data = tar.subarray(pos + BLOCK, pos + BLOCK + size);
    pos += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x" || type === "L") {
      longName = type === "x" ? paxPath(data) : text(data, 0, data.length);
      continue;
    }
    const prefix = text(header, 345, 155);
    const path = longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    longName = undefined;
    if (type !== "0" && type !== "\0") continue;

    const parts = path.split("/").slice(1);
    if (path.startsWith("/") || parts.length === 0 || parts.some((p) => p === ".." || p === "")) {
      throw new CheckFailure("tarball-integrity-mismatch", `unsafe path in tarball: ${path}`);
    }
    files.set(parts.join("/"), data);
  }
  return files;
}
