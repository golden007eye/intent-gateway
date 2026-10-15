// The module's HTTP reads, through the injected transport. Every failure becomes a "registry-error".
// Each read has a size cap, so a hostile or broken registry cannot make the check buffer without bound.
import { CheckFailure } from "./result.ts";
import { errorText } from "./attestation.ts";

/** The cap for a small JSON answer (a token, an attestation listing, a referrers index). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** The cap for a body that is large by nature: a packument, the package tarball, an image's bundle blobs. */
export const MAX_LARGE_BODY_BYTES = 64 * 1024 * 1024;

export async function getBytes(
  doFetch: typeof fetch,
  url: string,
  init?: RequestInit,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Buffer> {
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (err) {
    throw new CheckFailure("registry-error", `${url}: ${errorText(err)}`);
  }
  if (!res.ok) throw new CheckFailure("registry-error", `${url}: HTTP ${String(res.status)}`);
  const tooLarge = (): CheckFailure =>
    new CheckFailure("registry-error", `${url}: response is larger than ${String(maxBytes)} bytes`);
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (res.body === null) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof CheckFailure) throw err;
    throw new CheckFailure("registry-error", `${url}: ${errorText(err)}`);
  }
  return Buffer.concat(chunks);
}

export function parseJson(body: Buffer, url: string): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new CheckFailure("registry-error", `${url}: response is not JSON`);
  }
}

export async function getJson(
  doFetch: typeof fetch,
  url: string,
  init?: RequestInit,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  return parseJson(await getBytes(doFetch, url, init, maxBytes), url);
}
