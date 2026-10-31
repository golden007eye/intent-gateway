// The `intent` executable as a real process (G18, ADR-0005, R3-6): `serve` (and no command) over stdio answers
// `initialize` and lists the three tools, with the bundled zip-only policy when no policy file exists;
// when it cannot start, it still lists the tools and each call says why; `approver accept` refuses when its stdin and stdout are pipes; --version and an unknown command.
import { spawn } from "node:child_process";
import { type AddressInfo, connect, createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeCloud, startFakeCloud } from "../src/cloud-fake/index.ts";
import { BUILD } from "../src/config/index.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const SHIRT = { category: "t-shirt", budget: 20, country: "US", postcode: "10001" };

/**
 * A loopback port in front of the fake Intent Cloud that refuses connections until `open()`, then pipes each one to
 * the fake; with `hold` set, an accepted connection waits until `release()`.
 */
async function gate(target: string): Promise<{ url: string; open(options?: { hold?: boolean }): Promise<void>; release(): void; held(): number; close(): Promise<void> }> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => { resolve(); }));
  const to = new URL(target);
  let hold = false;
  const waiting: (() => void)[] = [];
  const server = createServer((socket) => {
    const pipe = (): void => {
      const upstream = connect(Number(to.port), to.hostname);
      socket.pipe(upstream).pipe(socket);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    };
    if (hold) waiting.push(pipe);
    else pipe();
  });
  let listening = false;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    open: async (options = {}) => {
      hold = options.hold === true;
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      listening = true;
    },
    release: () => {
      hold = false;
      for (const pipe of waiting.splice(0)) pipe();
    },
    held: () => waiting.length,
    close: () => (listening ? new Promise<void>((resolve) => server.close(() => { resolve(); })) : Promise.resolve()),
  };
}

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
        const result = await client.callTool({ name: "find_offers", arguments: SHIRT });
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
    expect(stderr).toContain("intent: MCP over stdio is up, but the gateway could not start: each tool call tries again");
    expect(stderr).not.toContain("MCP over stdio is ready");
    expect(stderr).not.toMatch(/ECONNREFUSED|\bat .+:\d+:\d+/);
    // Each call tried the start again (one meta request per try, start + 2 calls), and no search was ever logged.
    const chain = readFileSync(join(dataDir, "audit.jsonl"), "utf8");
    expect(chain.match(/"getMeta"/g)?.length).toBe(3);
    expect(chain).not.toContain("searchCatalog");
  });

  /** An MCP client of serve over stdio, pointed at `url`; `stderr()` is what it printed so far. */
  async function stdioClient(url: string): Promise<{ client: Client; dataDir: string; stderr: () => string; chain: () => string }> {
    const dataDir = join(mkdtempSync(join(tmpdir(), "cli-retry-")), "data");
    const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, "--trust-keys", keys], env: env({ INTENT_DATA_DIR: dataDir, INTENT_CLOUD_URL: url }), stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const client = new Client({ name: "cli-test", version: "0" });
    await client.connect(transport);
    return { client, dataDir, stderr: () => stderr, chain: () => readFileSync(join(dataDir, "audit.jsonl"), "utf8") };
  }
  const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string => (result.content as { text: string }[]).map((c) => c.text).join("\n");
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(check()).toBe(true);
  };

  it("a start that failed is tried again on the next call, which searches once Intent Cloud can be reached", { timeout: 30_000 }, async () => {
    const door = await gate(fake.url);
    const { client, stderr, chain } = await stdioClient(door.url);
    try {
      await until(() => stderr().includes("MCP over stdio is up, but the gateway could not start"));
      const refused = await client.callTool({ name: "find_offers", arguments: SHIRT });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("cannot be reached");
      expect(chain()).not.toContain("searchCatalog");
      await door.open();
      const searched = await client.callTool({ name: "find_offers", arguments: SHIRT });
      expect(textOf(searched)).not.toContain("could not run this tool");
      expect(textOf(searched)).toMatch(/Sent: searchCatalog/);
      expect(chain()).toContain('"searchCatalog"');
    } finally {
      await client.close();
      await door.close();
    }
  });

  it("two calls that arrive while a start is pending share one start attempt", { timeout: 30_000 }, async () => {
    const door = await gate(fake.url);
    const { client, stderr, chain } = await stdioClient(door.url);
    try {
      await until(() => stderr().includes("MCP over stdio is up, but the gateway could not start"));
      const metas = (): number => chain().match(/"getMeta"/g)?.length ?? 0;
      expect(metas()).toBe(1);
      await door.open({ hold: true });
      const both = Promise.all([client.callTool({ name: "find_offers", arguments: SHIRT }), client.callTool({ name: "get_approval_status", arguments: {} })]);
      // Both calls are in; the one start attempt they share waits at the door with its meta request.
      await until(() => door.held() === 1 && metas() === 2);
      door.release();
      const results = await both;
      for (const result of results) expect(textOf(result)).not.toContain("could not run this tool");
      // One meta for the failed start, one for the start both calls shared, and one key statement chained.
      expect(metas()).toBe(2);
      expect(chain().match(/"kind":"keys"/g)?.length).toBe(1);
    } finally {
      await client.close();
      await door.close();
    }
  });

  it("attack (invariant 1): a policy that turns approval off refuses every call over stdio, and nothing is sent or searched", { timeout: 30_000 }, async () => {
    const policy = join(mkdtempSync(join(tmpdir(), "cli-policy-")), "policy.yaml");
    writeFileSync(policy, "version: 1\napproval: off\n");
    const { tools, texts, errors, dataDir } = await refusedStart(["--trust-keys", keys], { INTENT_CLOUD_URL: fake.url, INTENT_POLICY: policy }, 2);
    expect(tools).toEqual(["create_cart", "find_offers", "get_approval_status"]);
    expect(errors).toEqual([true, true]);
    for (const text of texts) expect(text).toMatch(/^The gateway could not run this tool: intent could not start: policy .+approval/);
    // Refused at load, before the store opens: no request was logged, so none was sent (invariant 2).
    expect(existsSync(join(dataDir, "audit.jsonl"))).toBe(false);
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
