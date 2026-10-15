import { describe, expect, test } from "vitest";
import { getBytes, getJson, MAX_BODY_BYTES } from "./http.ts";
import type { CheckFailure } from "./result.ts";

const URL_ = "https://registry.example/x";
const refused = (detail: RegExp): CheckFailure =>
  expect.objectContaining({ reason: "registry-error", message: expect.stringMatching(detail) as unknown }) as CheckFailure;
const serve =
  (response: Response): typeof fetch =>
  () =>
    Promise.resolve(response);

/** A body that streams `chunks` without a content-length, then optionally errors. */
function streamed(chunks: Uint8Array[], error?: Error): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk !== undefined) controller.enqueue(chunk);
      else if (error !== undefined) controller.error(error);
      else controller.close();
    },
  });
  return new Response(body);
}

describe("getBytes size cap", () => {
  test("reads a body up to the cap", async () => {
    expect(await getBytes(serve(new Response("abc")), URL_, undefined, 3)).toEqual(Buffer.from("abc"));
    expect(await getBytes(serve(streamed([new Uint8Array(2), new Uint8Array(2)])), URL_, undefined, 4)).toHaveLength(4);
  });

  test("reads an empty body", async () => {
    expect(await getBytes(serve(new Response(null)), URL_)).toHaveLength(0);
  });

  test("refuses a declared content-length over the cap before reading", async () => {
    const response = new Response("abcd", { headers: { "content-length": "4" } });
    await expect(getBytes(serve(response), URL_, undefined, 3)).rejects.toThrow(refused(/larger than 3 bytes/));
  });

  // Attack: a registry that sends no content-length and never stops must not be buffered without bound.
  test("refuses a streamed body that passes the cap", async () => {
    const chunk = new Uint8Array(256 * 1024);
    const endless = streamed(Array.from({ length: 64 }, () => chunk));
    await expect(getBytes(serve(endless), URL_)).rejects.toThrow(
      refused(new RegExp(`larger than ${String(MAX_BODY_BYTES)} bytes`)),
    );
  });

  test("the JSON reader has the 1 MiB default cap", async () => {
    const big = `"${"a".repeat(MAX_BODY_BYTES)}"`;
    await expect(getJson(serve(new Response(big)), URL_)).rejects.toThrow(refused(/larger than/));
    expect(await getJson(serve(new Response(big)), URL_, undefined, big.length)).toHaveLength(MAX_BODY_BYTES);
  });

  test("a body that fails mid-stream is a registry-error", async () => {
    await expect(getBytes(serve(streamed([new Uint8Array(1)], new Error("reset"))), URL_)).rejects.toThrow(refused(/reset/));
  });
});
