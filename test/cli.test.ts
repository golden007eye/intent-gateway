// The `intent` executable as a real process (G18, ADR-0005, R3-6): `serve` (and no command) over stdio answers
// `initialize` and lists the three tools, with the bundled zip-only policy when no policy file exists;
// when it cannot start, it still lists the tools and each call says why; `approver accept` refuses when its stdin and stdout are pipes; --version and an unknown command.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

  /**
   * Starts the gateway as an MCP client would when it cannot start, lists the tools, calls find_offers `calls` times,
   * and returns each result's text, stderr and the data dir.
   */
  async function refusedStart(args: string[], extra: Record<string, string>, calls = 1): Promise<{ tools: string[]; texts: string[]; errors: boolean[]; stderr: string; dataDir: string }> {
    const dataDir = join(mkdtempSync(join(tmpdir(), "cli-nostart-")), "data");
    const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, ...args], env: env({ INTENT_DATA_DIR: dataDir, ...extra }), stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const client = new Client({ name: "cli-test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const texts: string[] = [];
      const errors: boolean[] = [];
      for (let i = 0; i < calls; i++) {
        const result = await client.callTool({ name: "find_offers", arguments: { category: "t-shirt", budget_max: 20, ship_to: { country: "US", postal_code: "10001" } } });
        texts.push((result.content as { type: string; text: string }[]).map((c) => c.text).join("\n"));
        errors.push(result.isError === true);
      }
      return { tools: tools.map((t) => t.name).sort(), texts, errors, stderr, dataDir };
    } finally {
      await client.close();
    }
  }

  it("with an Intent Cloud host that cannot be reached, the server still lists its tools and each call says why (attack: nothing searched)", { timeout: 30_000 }, async () => {
    // A loopback port with nothing listening: the real process, and no network beyond this machine.
    const { tools, texts, errors, stderr, dataDir } = await refusedStart(["--trust-keys", keys], { INTENT_CLOUD_URL: "http://127.0.0.1:9" }, 2);
    expect(tools).toEqual(["create_cart", "find_offers", "get_approval_status"]);
    // Run as `node src/main.ts`, the next step names that invocation, not a bare `intent` that is not on PATH.
    const reason =
      "Intent Cloud at 127.0.0.1:9 cannot be reached (connection refused); nothing was sent. " +
      `Check your connection and INTENT_CLOUD_URL, or try everything locally with node ${realpathSync(MAIN)} demo`;
    for (const text of texts) expect(text).toBe(`The gateway could not run this tool: ${reason}. Run \`node ${realpathSync(MAIN)} doctor\` to see each check.`);
    expect(errors).toEqual([true, true]);
    expect(stderr).toContain(`intent: ${reason}\n`);
    expect(stderr).toContain("intent: the MCP server runs anyway: each tool call tries the start again");
    expect(stderr).not.toMatch(/ECONNREFUSED|\bat .+:\d+:\d+/);
    // Each call tried the start again (one meta request per try, start + 2 calls), and no search was ever logged.
    const chain = readFileSync(join(dataDir, "audit.jsonl"), "utf8");
    expect(chain.match(/"getMeta"/g)?.length).toBe(3);
    expect(chain).not.toContain("searchCatalog");
  });

  it("with an unpinned host and no --trust-keys, the tools are listed and each call names --trust-keys and the demo", { timeout: 30_000 }, async () => {
    const { tools, texts, errors } = await refusedStart([], { INTENT_CLOUD_URL: "https://cloud.example" });
    expect(tools).toEqual(["create_cart", "find_offers", "get_approval_status"]);
    expect(errors).toEqual([true]);
    expect(texts[0]).toBe(
      `The gateway could not run this tool: intent could not start: configuration: cloud.example is not a pinned Intent Cloud host; pass --trust-keys <path> to trust its root key; or run node ${realpathSync(MAIN)} demo to try the gateway with no setup`,
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
