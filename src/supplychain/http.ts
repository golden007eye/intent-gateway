// The module's HTTP reads, through the injected transport. Every failure becomes a "registry-error".
import { CheckFailure } from "./result.ts";
import { errorText } from "./attestation.ts";

export async function getBytes(doFetch: typeof fetch, url: string, init?: RequestInit): Promise<Buffer> {
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (err) {
    throw new CheckFailure("registry-error", `${url}: ${errorText(err)}`);
  }
  if (!res.ok) throw new CheckFailure("registry-error", `${url}: HTTP ${String(res.status)}`);
  return Buffer.from(await res.arrayBuffer());
}

export function parseJson(body: Buffer, url: string): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new CheckFailure("registry-error", `${url}: response is not JSON`);
  }
}

export async function getJson(doFetch: typeof fetch, url: string, init?: RequestInit): Promise<unknown> {
  return parseJson(await getBytes(doFetch, url, init), url);
}
