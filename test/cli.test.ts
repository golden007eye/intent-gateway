// The `intent` executable as a real process (G18, ADR-0005, R3-6): `serve` (and no command) over stdio answers
// `initialize` and lists the three tools, with the bundled zip-only policy when no policy file exists;
// `approver accept` refuses when its stdin and stdout are pipes; --version and an unknown command.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
      expect(stderr).toContain("No policy file found; using the bundled zip-only policy: only your ZIP code leaves this machine.");
      expect(stderr).toContain("MCP over stdio is ready");
    } finally {
      await client.close();
    }
  });

  it("approver accept with pipes for stdin and stdout refuses (exit 2)", { timeout: 30_000 }, async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "cli-pipe-")), "data");
    const result = await exec(["approver", "accept"], { INTENT_DATA_DIR: dataDir });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^intent: approver accept needs a person at a terminal/);
  });

  it("--version prints the version; an unknown command prints the help and exits 2", { timeout: 30_000 }, async () => {
    expect(await exec(["--version"])).toEqual({ code: 0, stdout: `${BUILD.version}\n`, stderr: "" });
    const unknown = await exec(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/^intent: unknown command "frobnicate"\n\nintent-gateway: /);
  });
});
