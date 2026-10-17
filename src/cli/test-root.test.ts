// L5 (gateway-only): the published test root is trusted for a local fake on loopback http and never for a configured
// remote host, whatever the URL looks like. rootKeys refuses it for any host isLoopbackHttp does not accept.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../config/index.ts";
import { TEST_ROOT_KEY } from "../trust/index.ts";
import { isLoopbackHttp, rootKeys } from "./setup.ts";

describe("isLoopbackHttp", () => {
  it.each(["http://127.0.0.1:8787", "http://127.0.0.1", "http://[::1]:9"])("accepts the local fake at %s", (url) => {
    expect(isLoopbackHttp(url)).toBe(true);
  });

  // Attack cases: each is, or can reach, a host on the network.
  it.each([
    "https://127.0.0.1:8787",
    "http://localhost:8787",
    "http://127.0.0.1.evil.example",
    "http://evil.example",
    "http://127.0.0.1@evil.example",
    "http://evil.example#@127.0.0.1",
    "http://127.0.0.2",
    "http://0.0.0.0",
    "http://[::ffff:7f00:1]",
    "https://staging-api.intentai.shop",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isLoopbackHttp(url)).toBe(false);
  });
});

describe("rootKeys with the test root in --trust-keys", () => {
  const file = (): string => {
    const path = join(mkdtempSync(join(tmpdir(), "l5-")), "keys.json");
    writeFileSync(path, JSON.stringify({ rootKeys: [TEST_ROOT_KEY] }));
    return path;
  };
  const config = (url: string): Config => ({ cloud: { url, trust: { kind: "file", path: file() } } }) as unknown as Config;

  it("serves a local fake", async () => {
    expect(await rootKeys(config("http://127.0.0.1:8787"), { contacts: true })).toEqual([TEST_ROOT_KEY]);
  });

  it.each(["https://intent.example", "https://127.0.0.1:8787", "http://localhost:8787"])("attack: is refused for a configured host %s", async (url) => {
    await expect(rootKeys(config(url), { contacts: true })).rejects.toThrow(/published test root key/);
  });
});
