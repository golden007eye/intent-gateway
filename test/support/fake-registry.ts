// Offline transport and tarball builder for supplychain tests.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export type Route = Buffer | string | object | number | (() => Response);

/** A fetch that serves `routes` by exact URL (404 otherwise) and records each URL and its headers. */
export function routedFetch(routes: Map<string, Route>): typeof fetch & { calls: { url: string; headers: Headers }[] } {
  const calls: { url: string; headers: Headers }[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: new Headers(init?.headers) });
    const route = routes.get(url);
    if (route === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (typeof route === "function") return Promise.resolve(route());
    if (typeof route === "number") return Promise.resolve(new Response("", { status: route }));
    const body = Buffer.isBuffer(route) ? new Uint8Array(route) : typeof route === "string" ? route : JSON.stringify(route);
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  return Object.assign<typeof fetch, { calls: typeof calls }>(impl, { calls });
}

function header(name: string, size: number, type = "0"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, "ascii");
  h.write("0000000\0", 108, "ascii");
  h.write("0000000\0", 116, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  h.write("00000000000\0", 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}
const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

/** An npm-style tarball: every path under `package/`; paths over 100 bytes use a pax header, as npm does. */
export function makeTarGz(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const full = `package/${path}`;
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    if (Buffer.byteLength(full) > 100) {
      const record = ` path=${full}\n`;
      let length = record.length;
      while (`${String(length)}${record}`.length !== length) length = `${String(length)}${record}`.length;
      const pax = Buffer.from(`${String(length)}${record}`, "utf8");
      blocks.push(header("PaxHeader", pax.length, "x"), pad(pax));
    }
    blocks.push(header(full.slice(0, 100), data.length), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export const sha512 = (b: Buffer): Buffer => createHash("sha512").update(b).digest();
export const sha256hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
