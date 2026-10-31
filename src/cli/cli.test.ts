// The `intent` CLI through its Io seam (G18; AC-P2, AC-D1, AC-T3, ADR-0011): golden `intent log`, `policy test`
// exit codes, `policy add` diff-before-write, `approver accept` (TTY refusal, wrong and right fingerprint),
// `doctor` (contract mismatch, unreachable host, a healthy fake Intent Cloud), one-line errors with a fix, --help.
// The real process (stdio serve, pipes) is tested in test/cli.test.ts.
import { createHash, generateKeyPairSync } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeCloud, freePort, noDnsAgent, startFakeCloud, startSilentHost } from "../cloud-fake/index.ts";
import { BUILD, ConfigError, PINNED_HOSTS } from "../config/index.ts";
import { CONTRACT_VERSION, type CredentialPublicKey } from "../contract/index.ts";
import { DEMO_CONFIRM_PORT, startDemo } from "../demo/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  connectCloud,
  type DisclosedCloud,
  DisclosureBlockedError,
  DisclosureRefusedError,
  DisclosureDiscardedError,
  DisclosureNoKeysError,
} from "../disclosure/index.ts";
import { DEMO_SESSION, GatewayNotStartedError, GatewayStartError } from "../gateway/index.ts";
import { LibraryError } from "../library/index.ts";
import { McpHttpError } from "../mcp/index.ts";
import { PanelError } from "../panel/index.ts";
import { PolicyError } from "../policy/index.ts";
import { type Entry, openStore, readChain, StoreCorruptError, StoreFencedError, StoreUnsafeError } from "../store/index.ts";
import { approverFingerprint } from "../trust/index.ts";
import { CliError, describeError, formatLog, help, type Io, main } from "./index.ts";
import { formatVerbose } from "./log.ts";
import { slowCloudNotice } from "./waiting.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const BUILD_SHA = "b".repeat(40);
const POLICIES = new URL("../../policies/", import.meta.url);
const TS = Date.parse("2026-10-15T12:00:00.000Z");

interface Run {
  code: number;
  out: string;
  err: string;
  stop?: () => Promise<void>;
}

interface Setup {
  dir: string;
  env: Record<string, string>;
  run(argv: string[], options?: { input?: string; tty?: boolean; io?: Partial<Io> }): Promise<Run>;
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

// Every listener a test opens through INTENT_HTTP_PORT or INTENT_DEMO_CONFIRM_PORT gets a port from freePort: checked
// free, and outside the kernel's ephemeral range, so neither a process holding 8788 nor a listen(0) in another test
// worker can take it before the CLI binds it.
const freePortText = async (): Promise<string> => String(await freePort());

function setup(env: Record<string, string> = {}): Setup {
  const dir = join(mkdtempSync(join(tmpdir(), "cli-")), "data");
  const fullEnv = { INTENT_DATA_DIR: dir, ...env };
  return {
    dir,
    env: fullEnv,
    async run(argv, options = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const stdin = new PassThrough();
      if (options.input !== undefined) stdin.end(options.input);
      const tty = options.tty ?? false;
      const io: Io = {
        env: fullEnv,
        stdin,
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
        isTTY: { stdin: tty, stdout: tty },
        library: { buildCommit: BUILD_SHA },
        ...options.io,
      };
      const outcome = await main(argv, io);
      if (outcome.stop !== undefined) stops.push(outcome.stop);
      return { code: outcome.code, out: out.join(""), err: err.join(""), ...(outcome.stop === undefined ? {} : { stop: outcome.stop }) };
    },
  };
}

/** A chain with one entry of every kind `intent log` describes, at a fixed time. */
async function writeChain(
  dir: string,
  extra: (append: (kind: Entry["kind"], body: unknown) => Promise<unknown>) => Promise<void> = async () => {},
  { demo = false }: { demo?: boolean } = {},
): Promise<void> {
  const store = await openStore(dir, { clock: () => TS });
  const append = (kind: Entry["kind"], body: unknown) => store.append(kind, body);
  // A demo chain starts with the demo session entry; the seqs below move up by one.
  const o = demo ? 1 : 0;
  if (demo) await append("session", DEMO_SESSION);
  await append("keys", { statement: { kid: "cloud-root-1", expires_at: "2027-01-13T00:00:00Z" } });
  await append("disclosure", {
    endpoint: "searchCatalog",
    method: "POST",
    path: "/v1/search",
    fields: ["budget_max", "budget_max.amount_minor", "budget_max.currency", "category", "ship_to", "ship_to.country", "ship_to.postal_code"],
  });
  await append("receipt", { disclosure_seq: 1 + o, status: 200, verified: true });
  await append("block", { endpoint: "searchCatalog", fields: ["category", "note"], blocked: ["email at $.note"] });
  await append("disclosure", { endpoint: "createCart", fields: ["offer_handle", "quantity"] });
  await append("unacknowledged", { disclosure_seq: 4 + o, reason: "CloudNetworkError: timeout" });
  await append("disclosure", { endpoint: "createApproval", fields: [] });
  await append("discarded", { disclosure_seq: 6 + o, reason: "200 without a receipt" });
  await append("approval_pending", { handle: "ap_one", approval_url: "https://confirm.example/a/ap_one", total_minor: 4599 });
  await append("approver_pin", { fingerprint: "aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111" });
  await append("approval", { handle: "ap_one" });
  await extra(append);
  await store.close();
}

function es256(): CredentialPublicKey {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return { kty: "EC", crv: "P-256", x: String(jwk.x), y: String(jwk.y), alg: "ES256" };
}

function trustFile(fake: FakeCloud): string {
  const path = join(mkdtempSync(join(tmpdir(), "cli-keys-")), "keys.json");
  writeFileSync(path, JSON.stringify({ rootKeys: [fake.keys.rootPin] }));
  return path;
}

/**
 * The real disclosed cloud, with a host-name lookup that answers as for a host with no DNS record (ENOTFOUND), as
 * the staging host has before it opens. So no test needs the real host, or any network.
 */
const noDns: Partial<Io> = { connect: (http, store, options) => connectCloud({ ...http, agentFactory: noDnsAgent }, store, options) };

/** The real disclosed cloud with a 200 ms timeout, for a host that accepts a connection and never answers. */
const impatient: Partial<Io> = { connect: (http, store, options) => connectCloud({ ...http, timeoutMs: 200 }, store, options) };

/** A host pinned with no root key, as a host is before its release commits one; added only for `run`. */
async function withEmptyPin<T>(run: () => Promise<T>): Promise<T> {
  const pins = PINNED_HOSTS as Record<string, { rootKeys: unknown[] }>;
  pins["empty-pin.example"] = { rootKeys: [] };
  try {
    return await run();
  } finally {
    delete pins["empty-pin.example"];
  }
}

const EMPTY_PIN_HINT =
  "configuration: this build has no trusted root key for empty-pin.example yet. Try everything locally now with intent demo, or pass --trust-keys <file> for a self-hosted Intent Cloud";
const STAGING_DNS =
  "Intent Cloud at staging-api.intentai.shop cannot be reached (DNS: not found); nothing was sent. Check your network, or try everything locally with intent demo";
/** What a one-line error must never carry: an error code, a syscall name or a stack frame. */
const RAW = /ENOTFOUND|ECONNREFUSED|getaddrinfo|EAI_|\bat .+:\d+:\d+/;

describe("--version and --help", () => {
  it("prints the build version", async () => {
    expect(await setup().run(["--version"])).toMatchObject({ code: 0, out: `${BUILD.version}\n`, err: "" });
  });

  it("prints the short, example-led help", async () => {
    const result = await setup().run(["--help"]);
    expect(result).toMatchObject({ code: 0, err: "" });
    expect(result.out).toBe(help());
    expect(help()).toMatchSnapshot();
    expect(help().split("\n").length).toBeLessThan(40);
  });

  it.each([[["frobnicate"]], [["policy"]], [["policy", "nope"]], [["approver"]]])("refuses %j with exit 2", async (argv) => {
    const result = await setup().run(argv);
    expect(result.code).toBe(2);
    expect(result.err.split("\n")[0]).toMatch(/^intent: .*(intent --help|unknown command)/);
  });

  it("an unknown command is one line that names --help, not the whole help", async () => {
    const result = await setup().run(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.err).toBe('intent: unknown command "frobnicate"; run intent --help for the list\n');
  });

  it.each([[["log", "--bogus"]], [["log", "--http"]], [["log", "extra"]], [["policy", "add"]]])("refuses %j with one usage line and exit 2", async (argv) => {
    const result = await setup().run(argv);
    expect(result.code).toBe(2);
    expect(result.err.trimEnd().split("\n")).toHaveLength(1);
    expect(result.err).toMatch(/intent --help/);
  });
});

describe("an unknown option is one line in our words (F-h)", () => {
  const commands: string[][] = [[], ["serve"], ["demo"], ["log"], ["verify"], ["panel"], ["doctor"], ["policy", "test", "x.yaml"], ["policy", "add", "zip-only"], ["policy", "show"], ["approver", "list"], ["approver", "accept"]];
  it.each(commands)("%s --bogus", async (...words) => {
    const result = await setup().run([...words, "--bogus"]);
    const command = words.filter((w) => !w.includes(".") && w !== "zip-only").join(" ") || "serve";
    expect(result.code).toBe(2);
    expect(result.err).toBe(`intent: unknown option --bogus for ${command}; run intent --help\n`);
  });

  it("names a short option, another command's option, and a missing or unwanted value without parseArgs' advice", async () => {
    const s = setup();
    expect((await s.run(["demo", "-x"])).err).toBe("intent: unknown option -x for demo; run intent --help\n");
    expect((await s.run(["log", "--http"])).err).toBe("intent: unknown option --http for log; run intent --help\n");
    expect((await s.run(["panel", "--port"])).err).toBe("intent: option --port for panel needs a value; run intent --help\n");
    expect((await s.run(["demo", "--http=1"])).err).toBe("intent: option --http for demo takes no value; run intent --help\n");
    for (const argv of [["demo", "--bogus"], ["panel", "--port"], ["demo", "-x"]]) {
      expect((await s.run(argv)).err).not.toMatch(/Unknown option|place it at the end|'--'|-- "/);
    }
  });
});

describe("intent verify with no chain yet (F-h)", () => {
  it("verify --demo before anything was sent passes the chain part and says how to start", async () => {
    const result = await setup().run(["verify", "--demo"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toMatch(/^log: ok\n {2}No entries yet: the gateway has sent nothing\. Start it with intent serve, or try intent demo\.\n/);
    expect(result.out).toMatch(/\nverify: ok\n$/);
    expect(result.out).not.toMatch(/ENOENT|usage|FAILED/);
  });

  it("attack: a chain that is there but unreadable still fails as a usage error", async () => {
    const s = setup();
    mkdirSync(join(s.dir, "demo", "audit.jsonl"), { recursive: true });
    const result = await s.run(["verify", "--demo"]);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/^usage: FAILED\n {2}cannot read the chain in /);
  });

  it("without --demo it checks the real chain against the pinned root key, offline", async () => {
    const result = await setup().run(["verify", "--skip-install-check"]);
    expect(result.out).toMatch(/^key statements: ok\n {2}0 recorded, checked offline against the pinned root key\n/m);
    expect(result.code).toBe(0);
    // A host with no root key pinned still needs one.
    expect((await withEmptyPin(() => setup({ INTENT_CLOUD_URL: "https://empty-pin.example" }).run(["verify"]))).code).not.toBe(0);
  });
});

describe("a policy that shares no ZIP says that search cannot work (F-h)", () => {
  const NOTE = /note: with this policy the gateway sends no ZIP code, so it blocks every find_offers before sending and no cart can be made; agents will see every search blocked/;

  it("policy add strict-default shows the note with the diff, before asking", async () => {
    const s = setup();
    const result = await s.run(["policy", "add", "strict-default"], { tty: true, input: "n\n" });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(NOTE);
    expect(result.out.indexOf("note:")).toBeLessThan(result.out.indexOf("Apply this change?"));
    expect(result.out.indexOf("+ ")).toBeLessThan(result.out.indexOf("note:"));
  });

  it("policy add of a policy that keeps the ZIP has no note", async () => {
    const result = await setup().run(["policy", "add", "per-order-60", "--yes"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/note:/);
  });

  it("policy show and doctor say it too (doctor as a warning, not a failure)", async () => {
    const s = setup();
    // In demo mode, so doctor has nothing else to fail on.
    const added = await s.run(["policy", "add", "strict-default", "--yes", "--demo"]);
    expect(added).toMatchObject({ code: 0, err: "" });
    const shown = await s.run(["policy", "show", "--demo"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toMatch(NOTE);
    expect(shown.out).toMatch(/to search again, delete .+policy\.yaml and run intent policy add per-order-20/);
    const doctor = await s.run(["doctor", "--demo"]);
    expect(doctor.out).toMatch(/^WARN {2}policy: with this policy the gateway sends no ZIP code/m);
    expect(doctor.out).not.toMatch(/^FAIL/m);
    const plain = await setup().run(["policy", "show"]);
    expect(plain.out).not.toMatch(/note:/);
  });

  it("a policy.lock that no longer describes policy.yaml: doctor names the fix once (QA on preview.6 printed it twice)", async () => {
    const s = setup();
    const added = await s.run(["policy", "add", "per-order-60", "--yes", "--demo"]);
    const policyPath = /applied: (.+policy\.yaml) now includes/.exec(added.out)?.[1];
    expect(policyPath).toBeDefined();
    appendFileSync(policyPath ?? "", "# edited by hand\n");
    const doctor = await s.run(["doctor", "--demo"]);
    const warn = doctor.out.split("\n").find((l) => l.startsWith("WARN  policy lock:")) ?? "";
    expect(warn).toContain("policy.lock does not describe policy.yaml");
    expect(warn.match(/\brun /g)).toHaveLength(1);
    expect(warn).toMatch(/; run intent policy add <name> again$/);
  });
});

describe("intent log (golden)", () => {
  it("prints one line per action with what it sent and its outcome, then what was sent, the counts and where the details are", async () => {
    const s = setup({ HOME: "/home/dev" });
    await writeChain(s.dir, async (append) => {
      await append("approver_flag", { fingerprint: "bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222" });
    });
    const result = await s.run(["log", "--utc"]);
    expect(result).toMatchObject({ code: 0, err: "" });
    expect(result.out.replace(s.dir, "<data>")).toMatchInlineSnapshot(`
      "intent log · real · <data> · 12 entries

      Thursday 15 October 2026 (UTC)
      12:00:00  keys      keys signed by cloud-root-1 · valid until 2027-01-13  ✓ recorded
      12:00:00  search    budget_max.amount_minor, budget_max.currency, category, ship_to.country, ship_to.postal_code  ✓ receipt
      12:00:00  blocked   search: an email address in note                      ✗ nothing sent
      12:00:00  cart      at most $45.99                                        ✗ answer discarded: no valid receipt
      12:00:00  pinned    passkey aaaa…1111 is the approver now                 ✓ pinned
      12:00:00  approved  $45.99 · passkey aaaa…1111 (pinned)                   ✓ passkey proof checked
      12:00:00  flagged   passkey bbbb…2222                                     ✗ not the pinned approver: not approved (intent approver accept)

      Sent to Intent Cloud only: category, budget, offer, quantity, ZIP code, country.
      Not checked: 3 requests have no logged bytes.

      7 actions · 1 search · 1 cart · 1 approval · 1 blocked · 1 flagged · 1 receipt · 1 sent without receipt · 1 discarded
      Details: intent log -v · Machine-readable: intent log --json · Integrity: intent verify
      "
    `);
  });

  it("on a demo chain, says DEMO in the header and names the local demo Intent Cloud and its test keys in -v", async () => {
    const s = setup();
    await writeChain(join(s.dir, "demo"), undefined, { demo: true });
    const result = await s.run(["log", "--demo"]);
    expect(result).toMatchObject({ code: 0, err: "" });
    expect(result.out.split("\n")[0]).toMatch(/^intent log · DEMO \(test keys\) · .+\/demo · 12 entries$/);
    expect(result.out).toContain("Details: intent log --demo -v · Machine-readable: intent log --demo --json · Integrity: intent verify --demo\n");
    const verbose = await s.run(["log", "--demo", "-v"]);
    expect(verbose.out).toContain("#2: the local demo Intent Cloud acknowledged receiving it (demo chain, test keys) (status 200, signature verified)");
    expect(verbose.out).not.toMatch(/: Intent Cloud acknowledged/);
  });

  it("attack: a demo session entry that is not the first entry does not relabel a real chain's receipts", async () => {
    const s = setup();
    await writeChain(s.dir, async (append) => {
      await append("session", DEMO_SESSION);
    });
    const result = await s.run(["log"]);
    expect(result.out.split("\n")[0]).toContain("· real ·");
    expect(result.out).not.toContain("DEMO");
    const verbose = await s.run(["log", "-v"]);
    expect(verbose.out).toContain("#1: Intent Cloud acknowledged receiving it (status 200, signature verified)\n");
    expect(verbose.out).not.toContain("demo Intent Cloud");
  });

  it("names a signature-counter flag as such, not as another passkey", async () => {
    const s = setup();
    await writeChain(s.dir, async (append) => {
      await append("approver_flag", { fingerprint: "aaaa 1111", reason: "sign_count" });
    });
    const result = await s.run(["log"]);
    expect(result.out).toMatch(/ flagged {3}passkey aaaa 1111 +✗ signature counter did not go up: not approved\n/);
    expect(result.out).not.toContain("not the pinned approver");
  });

  it("lists a send with no answer recorded (the gateway stopped mid-request) as maybe sent, not as sent (F-l)", async () => {
    const s = setup();
    await writeChain(s.dir, async (append) => {
      await append("disclosure", { endpoint: "searchCatalog", fields: ["category", "ship_to", "ship_to.postal_code"] });
    });
    const result = await s.run(["log"]);
    expect(result.out).toMatch(/ search {4}category, ship_to\.postal_code +⚠ maybe sent, no answer recorded\n/);
    expect(result.out).toMatch(/ · 1 maybe sent( ·|\n)/);
    expect(result.out).toContain("Sent to Intent Cloud only (1 request maybe sent): ");
    // Answered sends keep their receipt.
    expect(result.out).toMatch(/ search {4}budget_max\.amount_minor, .+ +✓ receipt\n/);
  });

  it("ASCII symbols when the locale is not UTF-8; cuts lines to a terminal's width with an ellipsis", async () => {
    const s = setup();
    await writeChain(s.dir);
    const ascii = await s.run(["log"], { io: { env: { ...s.env, LANG: "C" } } });
    expect(ascii.out).not.toMatch(/[✓⚠✗→·…]/);
    expect(ascii.out).toMatch(/ blocked {3}search: an email address in note +x nothing sent\n/);
    const narrow = await s.run(["log", "--no-color"], { tty: true, io: { columns: 60 } });
    const lines = narrow.out.trimEnd().split("\n");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(60);
    expect(narrow.out).toMatch(/…/);
    // The outcome survives the cut: the values give way first.
    expect(narrow.out).toMatch(/ blocked {3}.*✗ nothing sent\n/);
  });

  it("says what to do on an empty or missing chain", async () => {
    const result = await setup().run(["log"]);
    expect(result).toEqual({ code: 0, err: "", out: "No entries yet: the gateway has sent nothing. Start it with intent serve, or try intent demo.\n" });
  });

  it("reports a broken chain and an unreadable line instead of hiding them", () => {
    const entry = { seq: 0, prev: "0".repeat(64), ts: "2026-10-15T12:00:00.000Z", kind: "disclosure", body: { endpoint: "getMeta", fields: [] }, hash: "f".repeat(64) };
    const text = formatLog([entry, "torn"]);
    expect(text).toMatch(/ broken {4}line 2 is not an entry \(torn or edited\) +✗ run intent verify\n/);
    expect(text).toContain("✗ the chain breaks at seq 0 (hash does not match the entry); run intent verify\n");
  });

  it("runs with no configuration at all: the unpinned default host does not matter offline", async () => {
    const s = setup();
    await writeChain(s.dir);
    expect(s.env.INTENT_CLOUD_URL).toBeUndefined();
    expect((await s.run(["log"])).code).toBe(0);
  });
});

describe("intent policy test", () => {
  const cases = (name: string): string => new URL(`${name}/cases.yaml`, POLICIES).pathname;

  it("exit 0 when every case passes against the active policy (bundled zip-only without a file)", async () => {
    const result = await setup().run(["policy", "test", cases("zip-only")]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/against the bundled zip-only policy/);
  });

  it("exit 1 when a case fails, naming what was expected and what happened", async () => {
    // zip-only's cases expect a ZIP to be sent; strict-default sends no ship-to at all.
    const s = setup();
    const result = await s.run(["policy", "test", cases("zip-only"), "--policy", new URL("strict-default/policy.yaml", POLICIES).pathname]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^FAIL {2}.+: expected send, got blocked by share\.ship_to$/m);
  });

  it("--policy tests another policy file", async () => {
    const s = setup();
    const result = await s.run(["policy", "test", cases("strict-default"), "--policy", new URL("strict-default/policy.yaml", POLICIES).pathname]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^ok {4}a small cart is sent$/m);
    expect(result.out).toMatch(/5 passed, 0 failed\n$/);
  });

  it("exit 2 for a cases file that is missing or not cases, and for a policy that does not load", async () => {
    const s = setup();
    const missing = await s.run(["policy", "test", "/nope/cases.yaml"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/^intent: the cases file \/nope\/cases.yaml cannot be read \(ENOENT\); check the path\n$/);

    const bad = join(s.dir, "..", "bad-cases.yaml");
    writeFileSync(bad, "- name: x\n");
    expect((await s.run(["policy", "test", bad])).err).toMatch(/^intent: cases .+; see policies\/strict-default\/cases.yaml for the format\n$/);

    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, "policy.yaml"), "version: 1\napproval: off\n");
    const loosens = await s.run(["policy", "test", cases("zip-only")]);
    expect(loosens.code).toBe(2);
    expect(loosens.err).toMatch(/^intent: policy .+policy\.yaml: approval: .+; fix that line, or delete the file/);
  });
});

describe("intent policy add", () => {
  it("shows the diff and, with stdin not a terminal and no --yes, writes nothing and exits 2", async () => {
    const s = setup();
    const result = await s.run(["policy", "add", "no-history"]);
    expect(result.code).toBe(2);
    expect(result.out).toContain("(new file)\n+ version: 1\n");
    expect(result.err).toMatch(/^intent: not applied: stdin is not a terminal.+re-run with --yes to apply it\n$/);
    expect(existsSync(join(s.dir, "policy.yaml"))).toBe(false);
  });

  it("with --yes writes meet(current, library) after showing the change as removed and added lines", async () => {
    const s = setup();
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, "policy.yaml"), "version: 1\napproval: passkey\nspend:\n  per_order_usd: 100\n");
    const result = await s.run(["policy", "add", "per-order-60", "--yes"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^- {3}per_order_usd: 100$/m);
    expect(result.out).toMatch(/^\+ {3}per_order_usd: 60$/m);
    expect(result.out).toMatch(/applied: .+policy\.yaml now includes per-order-60; policy\.lock records the library bundled with this gateway \(commit b{40}\)/);
    expect(readFileSync(join(s.dir, "policy.yaml"), "utf8")).toMatch(/per_order_usd: 60/);
  });

  it("at a terminal asks first: no applies nothing, yes applies", async () => {
    const s = setup();
    const no = await s.run(["policy", "add", "no-history"], { tty: true, input: "n\n" });
    expect(no.code).toBe(1);
    expect(no.out).toContain("Apply this change? [y/N] not applied; nothing was written");
    expect(existsSync(join(s.dir, "policy.yaml"))).toBe(false);
    const yes = await s.run(["policy", "add", "no-history"], { tty: true, input: "y\n" });
    expect(yes.code).toBe(0);
    expect(existsSync(join(s.dir, "policy.yaml"))).toBe(true);
  });

  it("an unchanged policy is not asked about, only recorded", async () => {
    const s = setup();
    await s.run(["policy", "add", "no-history", "--yes"]);
    const again = await s.run(["policy", "add", "no-history"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("no change:");
  });

  it("in a build whose commit is unknown (plain docker build) applies the bundled policy and says the commit is unknown (F-j)", async () => {
    const s = setup();
    const unknown = { io: { library: { buildCommit: null, dirty: null } } };
    const said = "the library bundled with this gateway (commit unknown: a local build without BUILD_COMMIT)";
    const added = await s.run(["policy", "add", "per-order-60", "--yes", "--demo"], unknown);
    expect(added).toMatchObject({ code: 0, err: "" });
    expect(added.out).toContain(`policy add per-order-60, from ${said}, into `);
    expect(added.out).toContain(`policy.lock records ${said}\n`);
    const shown = await s.run(["policy", "show", "--demo"], unknown);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`lock: per-order-60 from ${said}\n`);
    const doctor = await s.run(["doctor", "--demo"], unknown);
    expect(doctor.out).toMatch(new RegExp(`^ok {4}policy: .+policy\\.yaml, from library policy per-order-60 in ${said.replace(/[()]/g, "\\$&")}$`, "m"));
    expect(doctor.out).not.toMatch(/^(FAIL|WARN)/m);
  });

  it("in the container says to restart the container, not to run docker exec … intent serve (F-j)", async () => {
    const s = setup({ INTENT_RUNTIME: "container", INTENT_DEMO: "1", HOSTNAME: "0123456789ab" });
    const added = await s.run(["policy", "add", "per-order-60", "--yes"]);
    expect(added.code).toBe(0);
    expect(added.out).toContain("a running gateway reads its policy at start: run docker restart 0123456789ab to use it\n");
  });

  it("running from source refuses the bundled library in one line that says the fix once", async () => {
    const result = await setup().run(["policy", "add", "per-order-60", "--yes"], { io: { library: { buildCommit: null } } });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      "intent: policy library: this gateway runs from source, so its bundled policies have no build commit to record; pass --commit <sha> of a signed commit on main to take the policy from GitHub\n",
    );
  });

  it("an unknown library policy is one line with its fix", async () => {
    const result = await setup().run(["policy", "add", "no-such-policy", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^intent: policy library: no-such-policy is not in the library bundled with this gateway, which has block-dropship, daily-40, .*per-order-20.*, zip-only; pick a library policy, such as per-order-20 or weekly-40\n/);
    expect(result.err.trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("intent policy show", () => {
  it("names the bundled default when there is no file", async () => {
    const result = await setup().run(["policy", "show"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^no policy file at .+: the gateway uses the bundled zip-only policy$/m);
    expect(result.out).toContain("ship_to: postcode_only");
    expect(result.out).toMatch(/^completion modes allowed: handoff, one_tap$/m);
    // From source there is no build-info.json, so no commit is claimed.
    expect(result.out).toMatch(/^gateway: \S+, no commit \(running from source\)$/m);
  });

  it("shows the lock written by policy add, and exit 1 once policy.yaml was edited after it", async () => {
    const s = setup();
    await s.run(["policy", "add", "no-history", "--yes"]);
    const shown = await s.run(["policy", "show"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toMatch(/^lock: no-history from the library bundled with this gateway \(commit b{40}\)$/m);
    writeFileSync(join(s.dir, "policy.yaml"), `${readFileSync(join(s.dir, "policy.yaml"), "utf8")}# edited\n`);
    const stale = await s.run(["policy", "show"]);
    expect(stale.code).toBe(1);
    expect(stale.out).toMatch(/^lock: policy library: policy\.lock does not describe policy\.yaml.+run intent policy add <name> again$/m);
  });

  it("names the completion modes a narrowed policy allows", async () => {
    const s = setup();
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, "policy.yaml"), "version: 1\napproval: passkey\ncompletion: [handoff]\n");
    const shown = await s.run(["policy", "show"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toMatch(/^completion modes allowed: handoff$/m);
    expect(shown.out).not.toContain("refuses every cart");
    writeFileSync(join(s.dir, "policy.yaml"), "version: 1\napproval: passkey\ncompletion: [one_tap]\n");
    const oneTap = await s.run(["policy", "show"]);
    expect(oneTap.out).toMatch(/^note: .*refuses every cart until one-tap purchases arrive$/m);
  });

  it("policy add refuses a library policy that shares no completion mode (exit 2), and writes nothing", async () => {
    const s = setup();
    mkdirSync(s.dir, { recursive: true });
    const current = "version: 1\napproval: passkey\ncompletion: [one_tap]\n";
    writeFileSync(join(s.dir, "policy.yaml"), current);
    const root = join(dirname(s.dir), "policies");
    const library = "version: 1\napproval: passkey\ncompletion: [handoff]\n";
    mkdirSync(join(root, "handoff-only"), { recursive: true });
    writeFileSync(join(root, "handoff-only", "policy.yaml"), library);
    const hash = createHash("sha256").update(library, "utf8").digest("hex");
    writeFileSync(join(root, "index.json"), JSON.stringify({ version: 1, policies: { "handoff-only": { sha256: hash } } }));
    const result = await s.run(["policy", "add", "handoff-only", "--yes"], {
      io: { library: { buildCommit: BUILD_SHA, bundledRoot: pathToFileURL(`${root}/`) } },
    });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(
      /^intent: policy .+policy\.yaml: completion: `handoff-only` allows only handoff and policy\.yaml allows only one_tap; widen `completion` in policy\.yaml or pick another library policy$/m,
    );
    expect(result.err).not.toContain("fix that line");
    expect(readFileSync(join(s.dir, "policy.yaml"), "utf8")).toBe(current);
    expect(existsSync(join(s.dir, "policy.lock"))).toBe(false);
  });
});

describe("intent approver", () => {
  async function flagged(s: Setup): Promise<{ key: CredentialPublicKey; fingerprint: string }> {
    const key = es256();
    const fingerprint = approverFingerprint(key);
    await writeChain(s.dir, async (append) => {
      await append("approver_flag", { fingerprint, credential_id: "Y3JlZC0y", credential_public_key: key });
    });
    return { key, fingerprint };
  }

  const pins = (dir: string): Entry[] => (readChain(dir) as Entry[]).filter((e) => e.kind === "approver_pin");

  it("accept refuses without a terminal (exit 2), before reading anything", async () => {
    const s = setup();
    await flagged(s);
    for (const isTTY of [
      { stdin: false, stdout: false },
      { stdin: true, stdout: false },
      { stdin: false, stdout: true },
    ]) {
      const result = await s.run(["approver", "accept"], { input: "whatever\n", io: { isTTY } });
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/^intent: approver accept needs a person at a terminal \(stdin and stdout must be a TTY\); run it yourself/);
    }
    expect(pins(s.dir)).toHaveLength(1);
  });

  it("accept refuses a wrong fingerprint (exit 1) and writes nothing", async () => {
    const s = setup();
    const { fingerprint } = await flagged(s);
    const wrong = fingerprint.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const result = await s.run(["approver", "accept"], { tty: true, input: `${wrong}\n` });
    expect(result.code).toBe(1);
    expect(result.out).toContain(`  flagged: ${fingerprint}`);
    expect(result.out).toContain("the fingerprint does not match; nothing was written");
    expect(pins(s.dir)).toHaveLength(1);
  });

  it("accept with stdin ending before an answer writes nothing", async () => {
    const s = setup();
    await flagged(s);
    expect((await s.run(["approver", "accept"], { tty: true, input: "" })).code).toBe(1);
    expect(pins(s.dir)).toHaveLength(1);
  });

  it("accept with the right fingerprint (any case, any spacing) appends an approver_pin from the flag entry", async () => {
    const s = setup();
    const { key, fingerprint } = await flagged(s);
    const typed = ` ${fingerprint.toUpperCase().replaceAll(" ", "")}  `;
    const result = await s.run(["approver", "accept"], { tty: true, input: `${typed}\n` });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/pinned .+ \(entry #12\)/);
    const pin = pins(s.dir).at(-1);
    expect(pin?.body).toEqual({ fingerprint, credential_id: "Y3JlZC0y", credential_public_key: key });
    // Nothing is left to accept, and list shows the new pin as current.
    expect((await s.run(["approver", "accept"], { tty: true, input: `${fingerprint}\n` })).code).toBe(1);
    const list = await s.run(["approver", "list"]);
    expect(list.out).toContain(`#12 2026-`);
    expect(list.out).toContain("flagged passkeys: none");
  });

  it("list shows pins and open flags with the next step", async () => {
    const s = setup();
    const { fingerprint } = await flagged(s);
    const result = await s.run(["approver", "list"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`#11 2026-10-15T12:00:00.000Z  ${fingerprint}`);
    expect(result.out).toContain("if one is your passkey, run intent approver accept at a terminal");
    expect((await setup().run(["approver", "list"])).out).toMatch(/^no approver pin yet/);
  });

  it("accept refuses a broken chain", async () => {
    const s = setup();
    await flagged(s);
    const file = join(s.dir, "audit.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace("ap_one", "ap_two"));
    const result = await s.run(["approver", "accept"], { tty: true, input: "x\n" });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^intent: the local hash chain breaks at seq \d+ .+; run intent verify\n$/);
  });
});

describe("intent doctor", () => {
  let fake: FakeCloud | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("reports a contract mismatch with its fix (exit 1)", async () => {
    fake = await startFakeCloud({});
    const s = setup({ INTENT_CLOUD_URL: fake.url });
    const stub = {
      meta: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: { contract_version: "1.4.0", contract_sums_sha256: "0".repeat(64), rule_versions: ["recheck-v1"], limits: {} },
          contractVersion: "1.4.0",
        }),
    } as unknown as DisclosedCloud;
    const result = await s.run(["doctor", "--trust-keys", trustFile(fake)], { io: { connect: () => stub } });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(
      // A preview version: the update command names the `next` dist-tag the release publishes it under.
      new RegExp(`^FAIL {2}contract mismatch: .+ serves contract 1\\.4\\.0 .+this gateway implements ${CONTRACT_VERSION.replaceAll(".", "\\.")} .+; update the gateway \\(npx -y intent-gateway@next\\)`, "m"),
    );
    expect(result.out).toMatch(/^doctor: 1 problem; each line above says the fix\n$/m);
  });

  it("passes against a healthy Intent Cloud: contract, key statement and days to expiry, chain, policy", async () => {
    fake = await startFakeCloud({});
    const s = setup({ INTENT_CLOUD_URL: fake.url });
    const result = await s.run(["doctor", "--trust-keys", trustFile(fake)]);
    expect(result.out).toMatch(/^ok {4}contract: .+ serves .+, and its SHA256SUMS matches this gateway's$/m);
    expect(result.out).toMatch(/^ok {4}key statement: signed by cloud-root-1, valid until .+ \(\d+ days\)$/m);
    expect(result.out).toMatch(/^ok {4}policy: the bundled zip-only/m);
    expect(result.out).toMatch(/^ok {4}write lock: /m);
    expect(result).toMatchObject({ code: 0 });
    // Its requests are in the disclosure log like any other, and the chain now reports its head.
    const kinds = (readChain(s.dir) as Entry[]).map((e) => e.kind);
    expect(kinds).toEqual(["session", "disclosure", "receipt", "disclosure", "receipt", "keys"]);
    expect((await s.run(["doctor", "--trust-keys", trustFile(fake)])).out).toMatch(/^ok {4}log: 6 entries, each linked to the one before; last entry #5, hash [0-9a-f]{64}$/m);
  });

  it("names the fix for an unpinned host, an unreachable host and a readable data dir", async () => {
    const s = setup({ INTENT_CLOUD_URL: "http://127.0.0.1:9" });
    const unpinned = await s.run(["doctor"]);
    expect(unpinned.code).toBe(1);
    expect(unpinned.out).toMatch(/^FAIL {2}root key: configuration: 127\.0\.0\.1:9 is not a pinned Intent Cloud host; pass --trust-keys <path>.+; or run intent demo/m);

    fake = await startFakeCloud({});
    const refused = await s.run(["doctor", "--trust-keys", trustFile(fake)]);
    expect(refused.out).toContain(
      "\nFAIL  Intent Cloud at 127.0.0.1:9 cannot be reached (connection refused); nothing was sent. Check your connection and INTENT_CLOUD_URL, or try everything locally with intent demo\n",
    );
    expect(refused.out).not.toMatch(RAW);

    const { chmodSync } = await import("node:fs");
    chmodSync(s.dir, 0o755);
    const readable = await s.run(["doctor", "--trust-keys", trustFile(fake)]);
    expect(readable.out).toMatch(new RegExp(`^FAIL {2}data dir: other users can read it \\(mode 755\\); run chmod 700 ${s.dir}$`, "m"));
  });

  it("attack (L5): the published test root is refused for a host on the network, before anything is sent", async () => {
    fake = await startFakeCloud({});
    const s = setup({ INTENT_CLOUD_URL: "https://intent.example" });
    let connected = 0;
    const serve = await s.run(["serve", "--trust-keys", trustFile(fake)], { input: "", io: { connect: () => (connected++, ({}) as never) } });
    expect(serve.code).toBe(2);
    expect(serve.err).toMatch(/holds the published test root key .*not for https:\/\/intent\.example/);
    expect(connected).toBe(0);
    const doctor = await s.run(["doctor", "--trust-keys", trustFile(fake)]);
    expect(doctor.out).toMatch(/^FAIL {2}root key: .*published test root key/m);
    // Reading the local chain trusts no host, so verify still runs with it.
    expect((await s.run(["verify", "--trust-keys", trustFile(fake), "--skip-install-check"])).err).not.toMatch(/published test root/);
  });

  it("with no configuration and no DNS record for staging, the pinned key is ok and the Intent Cloud line says what to do", async () => {
    const s = setup();
    const result = await s.run(["doctor"], { io: noDns });
    expect(result.out).toMatch(/^ok {4}root key: cloud-root-1 \(pinned in this build\)$/m);
    expect(result.out).toContain(`\nFAIL  ${STAGING_DNS}\n`);
    expect(result.out).not.toMatch(RAW);
    expect(result.code).toBe(1);
    // Logged before the send, which never left: the log says so instead of "sent" (invariant 5).
    const log = formatVerbose(readChain(s.dir));
    expect(log).toMatch(/^ {2}#1 {4}logged {9}getMeta: no body fields \(not sent: no connection was made\)$/m);
    expect(log).toMatch(/^ {2}#2 {4}not sent {7}#1: CloudNetworkError: not sent \(DNS: not found\); it never left this machine$/m);
    expect(formatLog(readChain(s.dir))).toMatch(/ start {5}gateway started · key reads +⚠ not sent: no connection was made\n/);
    const verify = await s.run(["verify", "--skip-install-check"]);
    expect(verify.out).toContain("  sent: 0\n  logged but not sent (no connection was made): 1\n");
    expect(verify.out).toContain("  sent, not acknowledged: 0\n");
  });

  it("staging that answers its first request with an HTTP error (an edge with no Intent Cloud behind it) says so plainly", async () => {
    const stub = { meta: () => Promise.resolve({ ok: false, status: 503, body: null, contractVersion: null, retryAfter: null }) } as unknown as DisclosedCloud;
    const line = "Intent Cloud at staging-api.intentai.shop answered HTTP 503 to the gateway's first request (meta, no body fields). Check your network, or try everything locally with intent demo";
    const doctor = await setup().run(["doctor"], { io: { connect: () => stub } });
    expect(doctor.out).toContain(`\nFAIL  ${line}\n`);
    const serve = await setup().run(["serve"], { input: "", io: { connect: () => stub } });
    expect(serve.code).toBe(1);
    // A start that fails prints no policy line, only the error (F-l).
    expect(serve.err).toBe(`intent: ${line}\n`);
  });

  it("in the container, an unreachable staging host's next step re-runs the container in demo mode (F-h)", async () => {
    const result = await setup({ INTENT_RUNTIME: "container", HOSTNAME: "d3394f0ffd41" }).run(["doctor"], { io: noDns });
    expect(result.out).toContain(
      "\nFAIL  Intent Cloud at staging-api.intentai.shop cannot be reached (DNS: not found); nothing was sent. Check your network, or " +
        "try everything locally: re-run the container in demo mode: docker rm d3394f0ffd41 && " +
        "docker run -d --name intent -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 -e INTENT_DEMO=1 -v intent-data:/data intent-gateway\n",
    );
  });

  it("a host that accepts and never answers: the request may have reached it, and the log keeps it as sent", async () => {
    const silent = await startSilentHost();
    try {
      fake = await startFakeCloud({});
      const port = new URL(silent.url).port;
      const s = setup({ INTENT_CLOUD_URL: silent.url });
      const result = await s.run(["doctor", "--trust-keys", trustFile(fake)], { io: impatient });
      expect(result.out).toContain(
        `\nFAIL  Intent Cloud at 127.0.0.1:${port} cannot be reached (no complete response within 200 ms); the request may have reached it ` +
          "(logged as sent, not acknowledged). Check your connection and INTENT_CLOUD_URL, or try everything locally with intent demo\n",
      );
      expect(formatVerbose(readChain(s.dir))).toMatch(/^ {2}#2 {4}no receipt {5}#1: CloudNetworkError: timeout; it may or may not have arrived$/m);
      expect(formatLog(readChain(s.dir))).toMatch(/ start {5}gateway started · key reads +⚠ sent, no receipt\n/);
    } finally {
      await silent.close();
    }
  });

  it("a host that accepts and never answers: serve and doctor say they still wait, then keep the final message (F-l)", async () => {
    const silent = await startSilentHost();
    try {
      fake = await startFakeCloud({});
      const port = new URL(silent.url).port;
      const io: Partial<Io> = { connect: (http, store, options) => connectCloud({ ...http, timeoutMs: 400 }, store, options), cloudNoticeMs: 50 };
      const waiting = `still waiting for Intent Cloud at 127.0.0.1:${port}: no answer yet (it gives up after 400 ms)`;
      const serve = await setup({ INTENT_CLOUD_URL: silent.url }).run(["serve", "--trust-keys", trustFile(fake)], { input: "", io });
      expect(serve.code).toBe(1);
      expect(serve.err).toMatch(new RegExp(`^intent: ${waiting.replace(/[().]/g, "\\$&")}\\nintent: .*no complete response within 400 ms.*\\n$`));
      const doctor = await setup({ INTENT_CLOUD_URL: silent.url }).run(["doctor", "--trust-keys", trustFile(fake)], { io });
      expect(doctor.err).toBe(`intent doctor: ${waiting}\n`);
      expect(doctor.out).toContain(`\nFAIL  Intent Cloud at 127.0.0.1:${port} cannot be reached (no complete response within 400 ms)`);
    } finally {
      await silent.close();
    }
  });

  it("an answer within the notice time prints no waiting line", async () => {
    fake = await startFakeCloud({});
    const s = setup({ INTENT_CLOUD_URL: fake.url });
    const result = await s.run(["doctor", "--trust-keys", trustFile(fake)]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });

  it("a data dir lock left by a gateway killed mid-write: says within a second what it waits for, then goes on (F-l)", async () => {
    fake = await startFakeCloud({});
    const s = setup({ INTENT_CLOUD_URL: fake.url });
    mkdirSync(s.dir, { recursive: true, mode: 0o700 });
    const expires = Date.now() + 3000;
    writeFileSync(join(s.dir, "audit.lock"), JSON.stringify({ token: "killed", holder: "box:999999", expires_at: expires }));
    const started = Date.now();
    const result = await s.run(["doctor", "--trust-keys", trustFile(fake)]);
    expect(result.code).toBe(0);
    // It waited for the expiry: the lease is never taken over early because its pid looks dead.
    expect(Date.now()).toBeGreaterThanOrEqual(expires);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(result.err).toMatch(
      new RegExp(
        `^intent doctor: waiting for the data dir lock ${join(s.dir, "audit.lock")}, held by box:999999 until ${new Date(expires).toISOString()}: ` +
          "another gateway is writing to this data dir, or one stopped mid-write\\. The lock frees itself in [12] s; " +
          "if another gateway runs on this data dir, stop it or set INTENT_DATA_DIR to another folder\\.\\n$",
      ),
    );
  });
});

describe("intent verify and intent panel", () => {
  it("verify prints the report and exits with its code (running from source: no install to self-check)", async () => {
    const fake = await startFakeCloud({});
    try {
      const s = setup({ INTENT_CLOUD_URL: fake.url });
      await s.run(["doctor", "--trust-keys", trustFile(fake)]);
      const result = await s.run(["verify", "--trust-keys", trustFile(fake)]);
      expect(result.out).toMatch(/^log: ok$/m);
      expect(result.out).toMatch(/^verify: ok\n$/m);
      expect(result.out).toContain("self-check: not run: this install is not a published release (no build-info.json: running from source)");
      expect(result.code).toBe(0);
      const offline = await s.run(["verify", "--trust-keys", trustFile(fake), "--skip-install-check"]);
      expect(offline.out).toContain("self-check: skipped on request (--skip-install-check); npm provenance and the image signature were not checked");
      expect(offline.code).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it("verify without a root key is a usage error naming --trust-keys", async () => {
    const result = await withEmptyPin(() => setup({ INTENT_CLOUD_URL: "https://empty-pin.example" }).run(["verify"]));
    expect(result.code).toBe(1);
    expect(result.err).toBe(`intent: ${EMPTY_PIN_HINT}\n`);
  });

  it("verify --image needs --version, and --install takes only npm (exit 2)", async () => {
    const keys = join(mkdtempSync(join(tmpdir(), "cli-k-")), "k.json");
    writeFileSync(keys, JSON.stringify({ rootKeys: [{ kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) } }] }));
    const s = setup();
    expect(await s.run(["verify", "--trust-keys", keys, "--image", "ghcr.io/x/y:1"])).toMatchObject({ code: 2 });
    expect((await s.run(["verify", "--trust-keys", keys, "--install", "pip"])).err).toMatch(/--install takes npm/);
  });

  it("a malformed --trust-keys file is one line with the expected format", async () => {
    const keys = join(mkdtempSync(join(tmpdir(), "cli-k-")), "k.json");
    writeFileSync(keys, JSON.stringify({ keys: [] }));
    const result = await setup().run(["verify", "--trust-keys", keys]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/^intent: --trust-keys .+ is not a root key file; it must be \{"rootKeys":/);
  });

  it("panel prints its URL and stops", async () => {
    const s = setup();
    await writeChain(s.dir);
    const result = await s.run(["panel"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^panel: http:\/\/127\.0\.0\.1:\d+\/ \(read-only but for the Pause button; Ctrl-C stops it\)\n$/);
    await result.stop?.();
    stops.pop();
  });

  it("panel before the data dir exists says to start the gateway once", async () => {
    const result = await setup().run(["panel", "--port", "0"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^intent: panel: the data directory .+ does not exist; start the gateway once to create it\n$/);
  });
});

describe("serve failures", () => {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

  it("with no configuration and no DNS record for staging, says so in one line, names intent demo, and sent nothing", async () => {
    const s = setup();
    const result = await s.run([], { tty: true, io: noDns });
    expect(result.code).toBe(1);
    expect(result.err.split("\n").at(-2)).toBe(`intent: ${STAGING_DNS}`);
    expect(result.err).not.toMatch(RAW);
    expect(result.out).toBe("");
    // The meta request was logged before the send and is recorded as never having left.
    expect((readChain(s.dir) as Entry[]).map((e) => [e.kind, (e.body as { reason?: string }).reason])).toEqual([
      ["session", undefined],
      ["disclosure", undefined],
      ["unacknowledged", "CloudNetworkError: not sent (DNS: not found)"],
    ]);
  });

  it("started by an MCP client (stdin not a terminal), answers initialize with the same reason as a JSON-RPC error", async () => {
    const result = await setup().run([], { input: `${JSON.stringify(initialize)}\n`, io: noDns });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`intent: ${STAGING_DNS}\n`);
    expect(JSON.parse(result.out)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `intent could not start: ${STAGING_DNS}` } });
    // --http and a terminal print to stderr only; stdout stays empty.
    expect((await setup().run(["serve", "--http"], { input: `${JSON.stringify(initialize)}\n`, io: noDns })).out).toBe("");
  });

  it("in the container, an unreachable staging host says to re-run it in demo mode, never docker exec into it (F-h)", async () => {
    const result = await setup({ INTENT_RUNTIME: "container", HOSTNAME: "d3394f0ffd41" }).run(["serve", "--http"], { io: noDns });
    expect(result.code).toBe(1);
    // Only the error: the policy line ("Change it with docker exec …") waits until the gateway is serving (F-l).
    expect(result.err).toMatch(/^intent: Intent Cloud at staging-api\.intentai\.shop cannot be reached \(DNS: not found\); nothing was sent\. Check your network, or try everything locally: re-run the container in demo mode: docker rm d3394f0ffd41 && docker run -d --name intent .+ -e INTENT_DEMO=1 .+\n$/);
    expect(result.err).not.toContain("policy add");
    expect(result.err).not.toContain("docker exec");
    expect(result.err).not.toContain("claude mcp add");
  });

  it("refuses a host with no root key pinned before sending anything, says why and points at intent demo and --trust-keys", async () => {
    await withEmptyPin(async () => {
      const s = setup({ INTENT_CLOUD_URL: "https://empty-pin.example" });
      const result = await s.run([], { tty: true });
      expect(result.code).toBe(1);
      expect(result.err).toBe(`intent: ${EMPTY_PIN_HINT}\n`);
      expect(result.out).toBe("");
      const mcp = await s.run([], { input: `${JSON.stringify(initialize)}\n` });
      expect(JSON.parse(mcp.out)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `intent could not start: ${EMPTY_PIN_HINT}` } });
      expect(existsSync(join(s.dir, "audit.jsonl"))).toBe(false);
    });
  });

  it("a contract mismatch at start is one line naming intent doctor", async () => {
    const fake = await startFakeCloud({});
    try {
      const s = setup({ INTENT_CLOUD_URL: fake.url });
      const stub = {
        meta: () => Promise.resolve({ ok: true, status: 200, body: { contract_version: "9.9.9", contract_sums_sha256: "0".repeat(64) }, contractVersion: "9.9.9" }),
      } as unknown as DisclosedCloud;
      const result = await s.run(["serve", "--trust-keys", trustFile(fake)], { input: "", io: { connect: () => stub } });
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/^intent: could not start: contract mismatch: .+; run intent doctor to see each check\n$/);
    } finally {
      await fake.close();
    }
  });

  it("--demo on log, doctor and verify reads <data>/demo with the test root, starts nothing and needs no config", async () => {
    const s = setup();
    await writeChain(join(s.dir, "demo"), undefined, { demo: true });
    await writeChain(s.dir, async (append) => {
      await append("approver_flag", { fingerprint: "real chain" });
    });
    const log = await s.run(["log", "--demo"]);
    expect(log.code).toBe(0);
    expect(log.out).toMatch(/ · 12 entries\n/);
    expect(log.out).not.toContain("real chain");
    const doctor = await s.run(["doctor", "--demo"]);
    expect(doctor.out).toContain(`intent doctor: data dir ${join(s.dir, "demo")}`);
    expect(doctor.out).toMatch(/^ok {4}root key: .+ \(the published test key; demo mode only\)$/m);
    // The line holds no command: inside the container the demo is already serving, so "run demo" would mislead.
    expect(doctor.out).toMatch(/^ok {4}Intent Cloud: the demo gateway runs its own on 127\.0\.0\.1 while it is serving; nothing to reach$/m);
    expect(doctor.code).toBe(0);
    // The hand-written chain's entries carry no receipts, so verify fails; it ran against the demo dir and test root.
    const verify = await s.run(["verify", "--demo"]);
    expect(verify.out).toMatch(/^log: ok\n {2}12 entries/m);
    expect(verify.out).toContain("self-check: skipped on request (demo mode)");
    // INTENT_DEMO=1 (the image's switch) is the same as --demo.
    const env = setup({ INTENT_DEMO: "1" });
    await writeChain(join(env.dir, "demo"), undefined, { demo: true });
    expect((await env.run(["log"])).out).toMatch(/ · 12 entries\n/);
  });

  it("attack: doctor never writes a real keys entry into a demo chain, and --demo refuses a real chain", async () => {
    const fake = await startFakeCloud({});
    try {
      const demoDir = join(setup().dir, "demo");
      await writeChain(demoDir, undefined, { demo: true });
      const before = readFileSync(join(demoDir, "audit.jsonl"), "utf8");
      // The demo data dir named as the real one, without --demo: the cloud check is refused, nothing is appended.
      const mixed = await setup({ INTENT_CLOUD_URL: fake.url, INTENT_DATA_DIR: demoDir }).run(["doctor", "--trust-keys", trustFile(fake)]);
      expect(mixed.code).toBe(1);
      expect(mixed.out).toMatch(/^FAIL {2}Intent Cloud not checked: .+ holds a demo chain \(test keys, sample catalog\); run intent doctor --demo/m);
      expect(mixed.out).not.toMatch(/contract: |key statement: /);
      expect(readFileSync(join(demoDir, "audit.jsonl"), "utf8")).toBe(before);

      // A real chain where demo mode looks: refused too.
      const r = setup();
      await writeChain(join(r.dir, "demo"));
      const real = await r.run(["doctor", "--demo"]);
      expect(real.code).toBe(1);
      expect(real.out).toMatch(/^FAIL {2}chain mode: .+ holds a real chain; demo mode uses its own data dir/m);
    } finally {
      await fake.close();
    }
  });

  // The Docker image: `docker run -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 -e INTENT_DEMO=1 <image>`.
  // (test/image-smoke.ts drives the confirm page through the real port mapping.)
  it("in the container, the demo prints no second connect line (the entrypoint's is the one) and never the token", async () => {
    const token = "t".repeat(43);
    const port = await freePortText();
    // The image's default confirm port is 8788 (DEMO_CONFIRM_PORT, no fallback there); a free one here, so that a demo
    // another test file runs on 8788 at the same time cannot collide with this one.
    const confirm = await freePortText();
    const env = { INTENT_RUNTIME: "container", INTENT_DEMO: "1", INTENT_HTTP_HOST: "0.0.0.0", INTENT_HTTP_PORT: port, INTENT_HTTP_TOKEN: token };
    const s = setup({ ...env, INTENT_DEMO_CONFIRM_PORT: confirm });
    const result = await s.run(["serve", "--http"]);
    expect(result.code).toBe(0);
    // The agent connects on the server; only the confirm page needs forwarding to the laptop's browser.
    expect(result.err).toContain(`Approval links open the demo confirm page at http://127.0.0.1:${confirm} (over SSH, forward it: ssh -L ${confirm}:127.0.0.1:${confirm} <host>)\n`);
    expect(result.err).toContain("Add the demo gateway to Claude Code with the claude mcp add line above.\n");
    expect(result.err).not.toContain("claude mcp add --transport");
    expect(result.err).not.toContain("<token>");
    expect(result.err).not.toContain(token);
    expect(DEMO_CONFIRM_PORT).toBe(8788);
    // A detached container has no Ctrl-C: the last line says how to stop it (F-i).
    expect(result.err).toMatch(/\nintent: serving; stop it with docker stop (<container>|[0-9a-f]{12})\n$/);
    expect(result.err).not.toContain("Ctrl-C");
  });

  it("outside the container, serve --http names $INTENT_HTTP_TOKEN and the address it is bound to", async () => {
    const fake = await startFakeCloud({});
    try {
      const port = await freePortText();
      const token = "u".repeat(43);
      const s = setup({ INTENT_CLOUD_URL: fake.url, INTENT_HTTP_PORT: port, INTENT_HTTP_TOKEN: token });
      const result = await s.run(["serve", "--http", "--trust-keys", trustFile(fake)]);
      expect(result.code).toBe(0);
      expect(result.err).toContain(`claude mcp add --transport http intent http://127.0.0.1:${port}/mcp --header "Authorization: Bearer $INTENT_HTTP_TOKEN"`);
      expect(result.err).not.toContain(token);
    } finally {
      await fake.close();
    }
  });

  it("in the container, serve --http prints no connect line with a placeholder token: it points at the entrypoint's", async () => {
    const fake = await startFakeCloud({});
    try {
      const port = await freePortText();
      const token = "v".repeat(43);
      const s = setup({ INTENT_RUNTIME: "container", INTENT_CLOUD_URL: fake.url, INTENT_HTTP_HOST: "0.0.0.0", INTENT_HTTP_PORT: port, INTENT_HTTP_TOKEN: token });
      const result = await s.run(["serve", "--http", "--trust-keys", trustFile(fake)]);
      expect(result.code).toBe(0);
      expect(result.err).toContain(`MCP over HTTP at http://127.0.0.1:${port}/mcp\n`);
      // Once, with the address to connect to: never the 0.0.0.0 the container listens on.
      expect(result.err.split("MCP over HTTP at").length - 1).toBe(1);
      expect(result.err).not.toContain("0.0.0.0");
      expect(result.err).toContain("connect an agent with the claude mcp add line above\n");
      expect(result.err).not.toContain("claude mcp add --transport");
      expect(result.err).not.toContain(token);
    } finally {
      await fake.close();
    }
  });

  it("in the container, the token the entrypoint made is printed only once the gateway serves (F-h)", async () => {
    const token = "w".repeat(43);
    const port = await freePortText();
    const env = { INTENT_RUNTIME: "container", INTENT_HTTP_HOST: "0.0.0.0", INTENT_HTTP_PORT: port, INTENT_HTTP_TOKEN: token };
    const s = setup(env);
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, "http-token"), `${token}\n`);
    writeFileSync(join(s.dir, "http-token.unshown"), "");
    // Staging unreachable and no demo: the start fails, prints no connect line, and keeps the token for the next start.
    const failed = await s.run(["serve", "--http"], { io: noDns });
    expect(failed.code).not.toBe(0);
    expect(failed.err).not.toContain("claude mcp add");
    expect(failed.err).not.toContain(token);
    expect(failed.err).toContain("-e INTENT_DEMO=1");
    expect(failed.err).not.toContain("docker exec");
    // Nor the policy line: "Change it with docker exec … policy add" names a container that is not running (F-l).
    expect(failed.err).not.toContain("policy add");
    expect(existsSync(join(s.dir, "http-token.unshown"))).toBe(true);
    // The next start serves (the demo, on the same data dir): the token is printed, once, after the server is up.
    // A free confirm port, not the image's 8788: a demo running elsewhere on this machine must not fail this test.
    const confirm = await freePortText();
    const served = await setup({ ...env, INTENT_DATA_DIR: s.dir, INTENT_DEMO: "1", INTENT_DEMO_CONFIRM_PORT: confirm }).run(["serve", "--http"]);
    expect(served.code).toBe(0);
    expect(served.err).toContain(`  claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer ${token}"\n`);
    expect(served.err.split(token).length - 1).toBe(1);
    // Serving, it says which policy applies, after the server is up.
    const policyAt = served.err.indexOf("No policy file found; using the bundled zip-only policy");
    expect(policyAt).toBeGreaterThan(served.err.indexOf("MCP over HTTP at"));
    expect(served.err).toMatch(/Change it with `.*policy add <name>`\.\n/);
    expect(existsSync(join(s.dir, "http-token.unshown"))).toBe(false);
  });

  it("INTENT_DEBUG=1 adds the stack trace; without it there is none", async () => {
    const quiet = await setup().run(["policy", "test", "/nope.yaml"]);
    expect(quiet.err).not.toMatch(/\n\s+at /);
    const loud = await setup({ INTENT_DEBUG: "1" }).run(["policy", "test", "/nope.yaml"]);
    expect(loud.err).toMatch(/\n\s+at /);
  });
});

describe("describeError: every error class is one line with a fix", () => {
  const FIX = /run |set |unset |pass |check |update |fix |remove |try |delete |chmod |start |re-run|report it/;
  const request = { operation: "getMeta" as const, method: "GET" as const, path: "/v1/meta", headers: [], body: new Uint8Array() };
  const cases: [string, unknown][] = [
    ["CliError", new CliError("x failed; run intent doctor")],
    ["ConfigError", new ConfigError("INTENT_HTTP_PORT must be a port number 1-65535, got \"x\"")],
    ["GatewayStartError", new GatewayStartError("contract mismatch")],
    ["GatewayNotStartedError", new GatewayNotStartedError("the gateway has not started")],
    ["PolicyError", new PolicyError("POLICY_LOOSENS", "approval", "must be passkey\nsecond line")],
    ["LibraryError", new LibraryError("HASH_MISMATCH", "bad hash")],
    ["StoreUnsafeError", new StoreUnsafeError("the data dir /d is a symbolic link")],
    ["StoreCorruptError", new StoreCorruptError("seq 3: hash mismatch")],
    ["StoreFencedError", new StoreFencedError("lease lost")],
    ["CloudNetworkError", new CloudNetworkError("timeout", request, "no answer in 30 s")],
    ["CloudRequestError", new CloudRequestError("bad base URL")],
    ["DisclosureDiscardedError", new DisclosureDiscardedError(4, 200, "no receipt")],
    ["DisclosureBlockedError", new DisclosureBlockedError("searchCatalog", [])],
    ["DisclosureRefusedError", new DisclosureRefusedError("revoke", ["a credential in the query (access_token), which the log cannot digest"])],
    ["DisclosureNoKeysError", new DisclosureNoKeysError("no verified key statement yet")],
    ["McpHttpError", new McpHttpError("the HTTP token is too short")],
    ["PanelError", new PanelError("the data directory /d does not exist; start the gateway once to create it")],
    ["EADDRINUSE", Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:8787"), { code: "EADDRINUSE" })],
    ["EACCES", Object.assign(new Error("EACCES: permission denied, open '/d/audit.jsonl'"), { code: "EACCES" })],
    ["ENOENT", Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })],
    ["anything else", new TypeError("boom")],
    ["a thrown string", "boom"],
  ];

  it.each(cases)("%s", (_name, error) => {
    const text = describeError(error, { dataDir: "/d", policyPath: "/d/policy.yaml", cloudUrl: "https://cloud.example" });
    expect(text).not.toContain("\n");
    expect(text).toMatch(FIX);
  });
});

describe("printed commands name the invocation that works for this install (devrun F-b, F-d)", () => {
  it.each([["node /home/dev/intent-gateway/dist/main.js"], ["npx -y file:/home/dev/intent-gateway.tgz"], ["npx -y intent-gateway@next"]])("help for %s", (intent) => {
    const text = help(intent);
    expect(text).toContain(`\n  ${intent} demo\n`);
    expect(text).toContain(`  claude mcp add intent -- ${intent} demo     the demo`);
    // A long invocation (a path) is named once above the list; a short one leads every line.
    if (intent.length > 30) expect(text).toContain(`Commands (run each as: ${intent} <command>):\n  serve [--http]  `);
    else expect(text).toContain(`\n  ${intent} verify `);
    expect(text).toContain(`\n${intent} policy add per-order-20`);
    // strict-default shares no ZIP, so no search works under it: help never suggests it (F-h).
    expect(text).not.toContain("strict-default");
    expect(text).not.toMatch(/^ {2}intent /m);
  });
});

describe("intent demo --http (devrun F-c)", () => {
  it("serves the demo over HTTP like serve --http --demo, with the code on stderr only", async () => {
    const port = await freePortText();
    const s = setup({ INTENT_HTTP_PORT: port, INTENT_DEMO_CONFIRM_PORT: await freePortText() });
    const result = await s.run(["demo", "--http"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toContain(`  claude mcp add --transport http intent http://127.0.0.1:${port}/mcp`);
    const code = /Demo code for the confirm page: ([0-9]{6}) /.exec(result.err)?.[1];
    expect(code).toBeDefined();
    expect(readFileSync(join(s.dir, "demo", "approval-code"), "utf8")).toBe(`${code ?? ""}\n`);
    expect(help()).toContain("demo [--http]");
    expect(result.err).toMatch(/\nintent: serving until Ctrl-C\n$/);
    expect(result.err).not.toContain("docker stop");
  });
});

describe("the demo confirm page's port, for an ssh -L forward set up in advance (F-n)", () => {
  const tmpData = (): string => join(mkdtempSync(join(tmpdir(), "cli-port-")), "data");
  /** Holds 127.0.0.1:<port> with another demo until the test ends; when something else already holds it, it is taken all the same. */
  const hold = async (port: number): Promise<void> => {
    try {
      const other = await startDemo({ dataDir: tmpData(), port });
      stops.push(() => other.close());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  };
  const confirmLine = (port: number | string): string =>
    `Approval links open the demo confirm page at http://127.0.0.1:${String(port)} (over SSH, forward it: ssh -L ${String(port)}:127.0.0.1:${String(port)} <host>)\n`;

  it("defaults to 8788 and prints the address and the ssh -L line with the next steps", async () => {
    expect(DEMO_CONFIRM_PORT).toBe(8788);
    const result = await setup({ INTENT_HTTP_PORT: await freePortText() }).run(["demo", "--http"]);
    expect(result.code, result.err).toBe(0);
    // 8788 is the default; only when something else on this machine already holds it does the fallback line appear.
    if (result.err.includes("Port 8788 is taken")) expect(result.err).not.toContain(confirmLine(8788));
    else expect(result.err).toContain(confirmLine(8788));
    expect(result.err).toMatch(/then ask the agent to check the approval status\.\n(Port 8788 .+\n)?Approval links open .+\nDemo code for the confirm page: /);
  });

  it("falls back to a free port when 8788 is taken (a second demo), and says so", async () => {
    await hold(8788);
    const result = await setup({ INTENT_HTTP_PORT: await freePortText() }).run(["demo", "--http"]);
    expect(result.code, result.err).toBe(0);
    const port = /^Port 8788 is taken \(another demo running\?\), so the confirm page uses ([0-9]+); set INTENT_DEMO_CONFIRM_PORT to choose one\.$/m.exec(result.err)?.[1];
    expect(port).toBeDefined();
    expect(port).not.toBe("8788");
    expect(result.err).toContain(confirmLine(port ?? ""));
  });

  it("INTENT_DEMO_CONFIRM_PORT chooses the port, over stdio too", async () => {
    const port = await freePort();
    const result = await setup({ INTENT_DEMO_CONFIRM_PORT: String(port) }).run(["demo"]);
    expect(result.code).toBe(0);
    expect(result.err).toContain(confirmLine(port));
    expect(result.err).not.toContain("is taken");
  });

  it("a taken INTENT_DEMO_CONFIRM_PORT fails in one line naming it; it never falls back to another port", async () => {
    const port = await freePort();
    await hold(port);
    const result = await setup({ INTENT_DEMO_CONFIRM_PORT: String(port), INTENT_HTTP_PORT: await freePortText() }).run(["demo", "--http"]);
    expect(result).toMatchObject({ code: 1, out: "" });
    expect(result.err).toBe(
      `intent: the demo confirm page cannot listen on port ${String(port)} (INTENT_DEMO_CONFIRM_PORT): that port is taken; stop what uses it or set INTENT_DEMO_CONFIRM_PORT to another port\n`,
    );
  });

  it.each(["0", "65536", "80a", "", "8788 "])("refuses INTENT_DEMO_CONFIRM_PORT=%j before starting anything", async (value) => {
    const result = await setup({ INTENT_DEMO_CONFIRM_PORT: value }).run(["demo", "--http"]);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toMatch(value === "" ? /INTENT_DEMO_CONFIRM_PORT is set but empty/ : /INTENT_DEMO_CONFIRM_PORT must be a port number 1-65535, got /);
    expect(result.err.split("\n")).toHaveLength(2);
  });

  it("is listed under Settings in --help", () => {
    expect(help()).toContain("INTENT_DEMO_CONFIRM_PORT (demo confirm page, default 8788)");
  });
});

describe("doctor checks the Node version (devrun F-a)", () => {
  it.each([
    ["22.22.2", "ok"],
    ["22.23.3", "ok"],
    ["24.15.0", "ok"],
    ["24.20.1", "ok"],
    ["26.0.0", "ok"],
    ["27.1.0", "ok"],
    ["22.17.1", "WARN"],
    ["24.2.0", "WARN"],
    ["25.8.0", "WARN"],
  ])("Node %s: %s", async (nodeVersion, level) => {
    const result = await setup().run(["doctor", "--demo"], { io: { nodeVersion } });
    if (level === "ok") expect(result.out).toContain(`ok    node: ${nodeVersion}\n`);
    else {
      expect(result.out).toContain(
        `WARN  node: ${nodeVersion} is not supported; the gateway needs Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+. Install Node 24 LTS: nvm install 24, fnm install 24, brew install node@24 (then put $(brew --prefix node@24)/bin first on PATH), or the installer at https://nodejs.org/en/download; then run it again from a new terminal.\n`,
      );
    }
    expect(result.code).toBe(0);
  });
});

describe("slowCloudNotice", () => {
  it("names the adapter's own deadline, once", () => {
    const said: string[] = [];
    const slow = slowCloudNotice((t) => said.push(t), 10);
    slow.notify("cloud.example", 5000);
    slow.notify("cloud.example", 5000);
    const other = slowCloudNotice((t) => said.push(t), 10);
    other.notify("cloud.example", 1500);
    expect(said).toEqual([
      "still waiting for Intent Cloud at cloud.example: no answer yet (it gives up after 5 s)",
      "still waiting for Intent Cloud at cloud.example: no answer yet (it gives up after 1500 ms)",
    ]);
  });
});

describe("intent log: session entries", () => {
  it("names the demo chain and each gateway session by its local id", () => {
    const entry = (seq: number, body: unknown) => ({ seq, prev: "", ts: "t", kind: "session", body, hash: "" });
    const items = [entry(0, { mode: "demo" }), entry(1, { id: "abc" })];
    expect(formatLog(items).split("\n")[0]).toContain("· DEMO (test keys) ·");
    expect(formatLog(items)).toMatch(/ start {5}gateway started +✓ recorded\n/);
    expect(formatVerbose(items)).toContain("session        gateway session abc started (a local id, never sent)");
  });
});
