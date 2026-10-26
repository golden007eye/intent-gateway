// The `intent` executable as a real process (G18, ADR-0005, R3-6): `serve` (and no command) over stdio answers
// `initialize` and lists the three tools, with the bundled zip-only policy when no policy file exists;
// `approver accept` refuses when its stdin and stdout are pipes; --version and an unknown command.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeCloud, startFakeCloud } from "../src/cloud-fake/index.ts";
import { BUILD } from "../src/config/index.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");

let fake: FakeCloud;
let keys: string;

beforeAll(async () => {
  fake = await startFakeCloud({});
  keys = join(mkdtempSync(join(tmpdir(), "cli-keys-")), "keys.json");
  writeFileSync(keys, JSON.stringify({ rootKeys: [fake.keys.rootPin] }));
});

afterAll(async () => {
  await fake.close();
});

/** The process environment without any INTENT_* the developer's shell may carry, plus `extra`. */
function env(extra: Record<string, string>): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("INTENT_")));
  return { ...base, ...extra };
}

function exec(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { stdio: ["pipe", "pipe", "pipe"], env: env(extra) });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.stdin.end("0000 0000\n");
    child.once("exit", (code) => { resolve({ code, stdout, stderr }); });
  });
}

describe("intent as a process", () => {
  it.each([[["serve"]], [[]]])("%j over stdio answers initialize and lists the three tools", { timeout: 30_000 }, async (command) => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "cli-serve-")), "data");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, ...command, "--trust-keys", keys],
      env: env({ INTENT_CLOUD_URL: fake.url, INTENT_DATA_DIR: dataDir }),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const client = new Client({ name: "cli-test", version: "0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "intent-gateway", version: BUILD.version });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["create_cart", "find_offers", "get_approval_status"]);
      expect(stderr).toContain("No policy file found; using the bundled zip-only policy: the only detail about you it sends is your ZIP code.");
      expect(stderr).toContain("MCP over stdio is ready");
    } finally {
      await client.close();
    }
  });

  /** Starts the gateway as an MCP client would and returns the initialize failure and stderr. */
  async function failedStart(args: string[], extra: Record<string, string>): Promise<{ message: string; stderr: string }> {
    const dataDir = join(mkdtempSync(join(tmpdir(), "cli-nostart-")), "data");
    const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, ...args], env: env({ INTENT_DATA_DIR: dataDir, ...extra }), stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const client = new Client({ name: "cli-test", version: "0" });
    const failure = await client.connect(transport).then(
      () => null,
      (error: unknown) => error,
    );
    await client.close();
    expect(failure).toBeInstanceOf(Error);
    return { message: (failure as Error).message, stderr };
  }

  it("with an Intent Cloud host that refuses, an MCP client's initialize fails with the reason and the next steps", { timeout: 30_000 }, async () => {
    // A loopback port with nothing listening: the real process, and no network beyond this machine.
    const { message, stderr } = await failedStart(["--trust-keys", keys], { INTENT_CLOUD_URL: "http://127.0.0.1:9" });
    // Run as `node src/main.ts`, the next step names that invocation, not a bare `intent` that is not on PATH.
    const reason =
      "Intent Cloud at 127.0.0.1:9 cannot be reached (connection refused); nothing was sent. " +
      `Check your connection and INTENT_CLOUD_URL, or try everything locally with node ${realpathSync(MAIN)} demo`;
    expect(message).toContain(`intent could not start: ${reason}`);
    expect(stderr).toContain(`intent: ${reason}\n`);
    expect(stderr).not.toMatch(/ECONNREFUSED|\bat .+:\d+:\d+/);
  });

  it("with an unpinned host and no --trust-keys, initialize fails naming --trust-keys and the demo", { timeout: 30_000 }, async () => {
    const { message } = await failedStart([], { INTENT_CLOUD_URL: "https://cloud.example" });
    expect(message).toContain(
      `intent could not start: configuration: cloud.example is not a pinned Intent Cloud host; pass --trust-keys <path> to trust its root key; or run node ${realpathSync(MAIN)} demo to try the gateway with no setup`,
    );
  });

  it("approver accept with pipes for stdin and stdout refuses (exit 2)", { timeout: 30_000 }, async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "cli-pipe-")), "data");
    const result = await exec(["approver", "accept"], { INTENT_DATA_DIR: dataDir });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^intent: approver accept needs a person at a terminal/);
  });

  it("--version prints the version; an unknown command prints one line naming --help and exits 2", { timeout: 30_000 }, async () => {
    expect(await exec(["--version"])).toEqual({ code: 0, stdout: `${BUILD.version}\n`, stderr: "" });
    const unknown = await exec(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/^intent: unknown command "frobnicate"; run .+ --help for the list\n$/);
  });
});
