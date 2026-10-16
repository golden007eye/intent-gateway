// The `intent` CLI through its Io seam (G18; AC-P2, AC-D1, AC-T3, ADR-0011): golden `intent log`, `policy test`
// exit codes, `policy add` diff-before-write, `approver accept` (TTY refusal, wrong and right fingerprint),
// `doctor` (contract mismatch, unreachable host, a healthy fake Intent Cloud), one-line errors with a fix, --help.
// The real process (stdio serve, pipes) is tested in test/cli.test.ts.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeCloud, startFakeCloud } from "../cloud-fake/index.ts";
import { BUILD, ConfigError } from "../config/index.ts";
import { CONTRACT_VERSION, type CredentialPublicKey } from "../contract/index.ts";
import { CONTAINER_CONFIRM_PORT } from "../demo/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  type DisclosedCloud,
  DisclosureBlockedError,
  DisclosureDiscardedError,
  DisclosureNoKeysError,
} from "../disclosure/index.ts";
import { GatewayNotStartedError, GatewayStartError } from "../gateway/index.ts";
import { LibraryError } from "../library/index.ts";
import { McpHttpError } from "../mcp/index.ts";
import { PanelError } from "../panel/index.ts";
import { PolicyError } from "../policy/index.ts";
import { type Entry, openStore, readChain, StoreCorruptError, StoreFencedError, StoreUnsafeError } from "../store/index.ts";
import { approverFingerprint } from "../trust/index.ts";
import { CliError, describeError, formatLog, help, type Io, main } from "./index.ts";

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
async function writeChain(dir: string, extra: (append: (kind: Entry["kind"], body: unknown) => Promise<unknown>) => Promise<void> = async () => {}): Promise<void> {
  const store = await openStore(dir, { clock: () => TS });
  const append = (kind: Entry["kind"], body: unknown) => store.append(kind, body);
  await append("keys", { statement: { kid: "cloud-root-1", expires_at: "2027-01-13T00:00:00Z" } });
  await append("disclosure", {
    endpoint: "searchCatalog",
    method: "POST",
    path: "/v1/search",
    fields: ["budget_max", "budget_max.amount_minor", "budget_max.currency", "category", "ship_to", "ship_to.country", "ship_to.postal_code"],
  });
  await append("receipt", { disclosure_seq: 1, status: 200, verified: true });
  await append("block", { endpoint: "searchCatalog", fields: ["category", "note"], blocked: ["email at $.note"] });
  await append("disclosure", { endpoint: "createCart", fields: ["offer_handle", "quantity"] });
  await append("unacknowledged", { disclosure_seq: 4, reason: "CloudNetworkError: timeout" });
  await append("disclosure", { endpoint: "createApproval", fields: [] });
  await append("discarded", { disclosure_seq: 6, reason: "200 without a receipt" });
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

  it("an unknown command also prints the help", async () => {
    const result = await setup().run(["frobnicate"]);
    expect(result.err).toContain('intent: unknown command "frobnicate"');
    expect(result.err).toContain(help());
  });

  it.each([[["log", "--bogus"]], [["log", "--http"]], [["log", "extra"]], [["policy", "add"]]])("refuses %j with one usage line and exit 2", async (argv) => {
    const result = await setup().run(argv);
    expect(result.code).toBe(2);
    expect(result.err.trimEnd().split("\n")).toHaveLength(1);
    expect(result.err).toMatch(/intent --help/);
  });
});

describe("intent log (golden)", () => {
  it("prints the chain field by field", async () => {
    const s = setup();
    await writeChain(s.dir, async (append) => {
      await append("approver_flag", { fingerprint: "bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222" });
    });
    const result = await s.run(["log"]);
    expect(result).toMatchObject({ code: 0, err: "" });
    expect(result.out).toBe(
      [
        "#0    2026-10-15T12:00:00.000Z  key statement  cloud-root-1 signed keys valid until 2027-01-13T00:00:00Z",
        "#1    2026-10-15T12:00:00.000Z  sent           searchCatalog: budget_max.amount_minor, budget_max.currency, category, ship_to.country, ship_to.postal_code",
        "#2    2026-10-15T12:00:00.000Z  receipt        #1: Intent Cloud acknowledged receiving it (status 200, signature verified)",
        "#3    2026-10-15T12:00:00.000Z  blocked        searchCatalog: held back email at $.note; nothing was sent",
        "#4    2026-10-15T12:00:00.000Z  sent           createCart: offer_handle, quantity",
        "#5    2026-10-15T12:00:00.000Z  no receipt     #4: CloudNetworkError: timeout; it may or may not have arrived",
        "#6    2026-10-15T12:00:00.000Z  sent           createApproval: no body fields",
        "#7    2026-10-15T12:00:00.000Z  discarded      #6: 200 without a receipt; the response was not used",
        "#8    2026-10-15T12:00:00.000Z  approval asked ap_one for $45.99: https://confirm.example/a/ap_one",
        "#9    2026-10-15T12:00:00.000Z  approver pin   aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111 aaaa 1111",
        "#10   2026-10-15T12:00:00.000Z  approved       ap_one: passkey proof verified",
        "#11   2026-10-15T12:00:00.000Z  FLAGGED        bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 bbbb 2222 is not the pinned approver; if it is your passkey, run intent approver accept",
        "",
        "12 entries, every hash links, head seq 11. intent verify re-checks the receipts and approvals.",
        "",
      ].join("\n"),
    );
  });

  it("says what to do on an empty or missing chain", async () => {
    const result = await setup().run(["log"]);
    expect(result).toEqual({ code: 0, err: "", out: "No entries yet: the gateway has sent nothing. Start it with intent serve, or try intent demo.\n" });
  });

  it("reports a broken chain and an unreadable line instead of hiding them", () => {
    const entry = { seq: 0, prev: "0".repeat(64), ts: "2026-10-15T12:00:00.000Z", kind: "disclosure", body: { endpoint: "getMeta", fields: [] }, hash: "f".repeat(64) };
    const text = formatLog([entry, "torn"]);
    expect(text).toContain("line 2: not an entry (a torn or edited line); run intent verify");
    expect(text).toMatch(/the chain breaks at seq 0 .*; run intent verify\n$/);
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

  it("an unknown library policy is one line with its fix", async () => {
    const result = await setup().run(["policy", "add", "no-such-policy", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^intent: policy library: no-such-policy is not in the bundled index; see the names in the policies\/ folder/);
    expect(result.err.trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("intent policy show", () => {
  it("names the bundled default when there is no file", async () => {
    const result = await setup().run(["policy", "show"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^no policy file at .+: the gateway uses the bundled zip-only policy$/m);
    expect(result.out).toContain("ship_to: postcode_only");
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
      new RegExp(`^FAIL {2}contract mismatch: .+ serves contract 1\\.4\\.0 .+this gateway implements ${CONTRACT_VERSION.replaceAll(".", "\\.")} .+; update the gateway \\(npx -y intent-gateway@latest\\)`, "m"),
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
    expect(result.out).toMatch(/^ok {4}lease: /m);
    expect(result).toMatchObject({ code: 0 });
    // Its requests are in the disclosure log like any other, and the chain now reports its head.
    const kinds = (readChain(s.dir) as Entry[]).map((e) => e.kind);
    expect(kinds).toEqual(["disclosure", "receipt", "disclosure", "receipt", "keys"]);
    expect((await s.run(["doctor", "--trust-keys", trustFile(fake)])).out).toMatch(/^ok {4}chain: 5 entries, every hash links; head seq 4 hash [0-9a-f]{64}$/m);
  });

  it("names the fix for an unpinned host, an unreachable host and a readable data dir", async () => {
    const s = setup({ INTENT_CLOUD_URL: "http://127.0.0.1:9" });
    const unpinned = await s.run(["doctor"]);
    expect(unpinned.code).toBe(1);
    expect(unpinned.out).toMatch(/^FAIL {2}root key: configuration: 127\.0\.0\.1:9 is not a pinned Intent Cloud host; pass --trust-keys <path>.+; or run intent demo/m);

    fake = await startFakeCloud({});
    const unreachable = await s.run(["doctor", "--trust-keys", trustFile(fake)]);
    expect(unreachable.out).toMatch(/^FAIL {2}could not reach http:\/\/127\.0\.0\.1:9: .+; check your connection or INTENT_CLOUD_URL/m);

    const { chmodSync } = await import("node:fs");
    chmodSync(s.dir, 0o755);
    const readable = await s.run(["doctor", "--trust-keys", trustFile(fake)]);
    expect(readable.out).toMatch(new RegExp(`^FAIL {2}data dir: other users can read it \\(mode 755\\); run chmod 700 ${s.dir}$`, "m"));
  });
});

describe("intent verify and intent panel", () => {
  it("verify prints the report and exits with its code (running from source: no install to self-check)", async () => {
    const fake = await startFakeCloud({});
    try {
      const s = setup({ INTENT_CLOUD_URL: fake.url });
      await s.run(["doctor", "--trust-keys", trustFile(fake)]);
      const result = await s.run(["verify", "--trust-keys", trustFile(fake)]);
      expect(result.out).toMatch(/^chain: ok$/m);
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
    const result = await setup().run(["verify"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^intent: configuration: this build has no trusted root key for .+ yet; staging opens with the first preview release\. Try everything locally now with intent demo, or pass --trust-keys <file> for a self-hosted Intent Cloud\n$/);
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
    expect(result.out).toMatch(/^panel: http:\/\/127\.0\.0\.1:\d+\/ \(read-only; Ctrl-C stops it\)\n$/);
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
  it("with no configuration, refuses the unpinned default host, says why and points at intent demo and --trust-keys", async () => {
    const result = await setup().run([], { tty: true });
    expect(result.code).toBe(1);
    expect(result.err).toBe("intent: configuration: this build has no trusted root key for staging-api.intentai.shop yet; staging opens with the first preview release. Try everything locally now with intent demo, or pass --trust-keys <file> for a self-hosted Intent Cloud\n");
    expect(result.out).toBe("");
  });

  it("started by an MCP client (stdin not a terminal), answers initialize with the same reason as a JSON-RPC error", async () => {
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    const result = await setup().run([], { input: `${JSON.stringify(initialize)}\n` });
    expect(result.code).toBe(1);
    expect(result.err).toBe("intent: configuration: this build has no trusted root key for staging-api.intentai.shop yet; staging opens with the first preview release. Try everything locally now with intent demo, or pass --trust-keys <file> for a self-hosted Intent Cloud\n");
    expect(JSON.parse(result.out)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "intent-gateway could not start: configuration: this build has no trusted root key for staging-api.intentai.shop yet; staging opens with the first preview release. Try everything locally now with intent demo, or pass --trust-keys <file> for a self-hosted Intent Cloud" },
    });
    // --http and a terminal print to stderr only; stdout stays empty.
    expect((await setup().run(["serve", "--http"], { input: `${JSON.stringify(initialize)}\n` })).out).toBe("");
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
      expect(result.err).toMatch(/^intent-gateway: No policy file found; using the bundled zip-only policy: the only detail about you it sends is your ZIP code\. Change it with `intent policy add <name>`\.\n/);
      expect(result.err).toMatch(/\nintent: could not start: contract mismatch: .+; run intent doctor to see each check\n$/);
    } finally {
      await fake.close();
    }
  });

  it("--demo on log, doctor and verify reads <data>/demo with the test root, starts nothing and needs no config", async () => {
    const s = setup();
    await writeChain(join(s.dir, "demo"));
    await writeChain(s.dir, async (append) => {
      await append("approver_flag", { fingerprint: "real chain" });
    });
    const log = await s.run(["log", "--demo"]);
    expect(log.code).toBe(0);
    expect(log.out).toMatch(/11 entries, every hash links/);
    expect(log.out).not.toContain("real chain");
    const doctor = await s.run(["doctor", "--demo"]);
    expect(doctor.out).toContain(`intent doctor: data dir ${join(s.dir, "demo")}`);
    expect(doctor.out).toMatch(/^ok {4}root key: .+ \(the published test key; demo mode only\)$/m);
    expect(doctor.code).toBe(0);
    // The hand-written chain's entries carry no receipts, so verify fails; it ran against the demo dir and test root.
    const verify = await s.run(["verify", "--demo"]);
    expect(verify.out).toMatch(/^chain: ok\n {2}11 entries/m);
    expect(verify.out).toContain("self-check: skipped on request (demo mode)");
    // INTENT_DEMO=1 (the image's switch) is the same as --demo.
    const env = setup({ INTENT_DEMO: "1" });
    await writeChain(join(env.dir, "demo"));
    expect((await env.run(["log"])).out).toMatch(/11 entries, every hash links/);
  });

  // The Docker image: `docker run -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 -e INTENT_DEMO=1 <image>`.
  // (test/image-smoke.ts drives the confirm page through the real port mapping.)
  it("in the container, the demo prints the host's 127.0.0.1 URL without the token, with approval links on 8788", async () => {
    const token = "t".repeat(43);
    const port = String(40_000 + Math.floor(Math.random() * 10_000));
    const s = setup({ INTENT_RUNTIME: "container", INTENT_DEMO: "1", INTENT_HTTP_HOST: "0.0.0.0", INTENT_HTTP_PORT: port, INTENT_HTTP_TOKEN: token });
    const result = await s.run(["serve", "--http"]);
    expect(result.code).toBe(0);
    expect(result.err).toContain(`claude mcp add --transport http intent http://127.0.0.1:${port}/mcp --header "Authorization: Bearer <token>"`);
    expect(result.err).not.toContain(token);
    expect(CONTAINER_CONFIRM_PORT).toBe(8788);
  });

  it("outside the container, serve --http names $INTENT_HTTP_TOKEN and the address it is bound to", async () => {
    const fake = await startFakeCloud({});
    try {
      const port = String(40_000 + Math.floor(Math.random() * 10_000));
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
    expect(text).toContain(`\n${intent} policy add strict-default`);
    expect(text).not.toMatch(/^ {2}intent /m);
  });
});

describe("intent demo --http (devrun F-c)", () => {
  it("serves the demo over HTTP like serve --http --demo, with the code on stderr only", async () => {
    const port = String(40_000 + Math.floor(Math.random() * 10_000));
    const s = setup({ INTENT_HTTP_PORT: port });
    const result = await s.run(["demo", "--http"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toContain(`  claude mcp add --transport http intent http://127.0.0.1:${port}/mcp`);
    const code = /Demo code for the confirm page: ([0-9]{6}) /.exec(result.err)?.[1];
    expect(code).toBeDefined();
    expect(readFileSync(join(s.dir, "demo", "approval-code"), "utf8")).toBe(`${code ?? ""}\n`);
    expect(help()).toContain("demo [--http]");
  });
});

describe("doctor checks the Node version (devrun F-a)", () => {
  it.each([
    ["24.15.0", "ok"],
    ["24.20.1", "ok"],
    ["26.0.0", "ok"],
    ["27.1.0", "ok"],
    ["24.2.0", "WARN"],
    ["25.8.0", "WARN"],
    ["22.22.2", "WARN"],
  ])("Node %s: %s", async (nodeVersion, level) => {
    const result = await setup().run(["doctor", "--demo"], { io: { nodeVersion } });
    if (level === "ok") expect(result.out).toContain(`ok    node: ${nodeVersion}\n`);
    else {
      expect(result.out).toContain(
        `WARN  node: ${nodeVersion} is not supported; the gateway needs Node 24 LTS (24.15 or later) or 26+. Install Node 24 LTS (for example nvm install 24) and run it again\n`,
      );
    }
    expect(result.code).toBe(0);
  });
});
