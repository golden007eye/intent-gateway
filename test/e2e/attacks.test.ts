// E2 attacks (plan §5.3 G22, AC-T3), on the built package's stdio MCP server against the fake Intent Cloud, through a
// man-in-the-middle proxy. Each attack ends with what get_approval_status (or the tool) says and the exit code of
// `node dist/main.js verify`:
//   tampered proof → not verified, nothing chained, verify 0 (the chain is honest about it);
//   another approval's proof replayed by the network → not verified, verify 0; the same proof chained twice → verify 1;
//   a 2xx without a receipt (dropped, or forged) → the answer is discarded, verify 1;
//   a second passkey → flagged, not approved, verify 0; `approver accept` refuses without a terminal, and accepting
//   the fingerprint at a terminal (the CLI's Io seam) approves it;
//   an identity field in a tool input → refused with 0 sends, the value never reaches the chain, verify 0.
// No policy file exists, so these runs also use the default zip-only policy.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main as cli } from "../../src/cli/index.ts";
import { type FakeCloud, SoftPasskey, startFakeCloud } from "../../src/cloud-fake/index.ts";
import { openStore } from "../../src/store/index.ts";
import {
  buildPackage,
  chain,
  count,
  env,
  field,
  type Gateway,
  offerHandle,
  type Proxy,
  startGateway,
  startProxy,
  tempDir,
  trustKeysFile,
  verify,
} from "./support.ts";

let main: string;
let fake: FakeCloud;
let proxy: Proxy;
let keys: string;
const open: Gateway[] = [];

beforeAll(async () => {
  main = buildPackage();
  fake = await startFakeCloud({});
  proxy = await startProxy(fake.url);
  keys = trustKeysFile(fake);
}, 120_000);

afterEach(async () => {
  fake.tamper.reset();
  for (const gateway of open.splice(0)) await gateway.close();
});

afterAll(async () => {
  await proxy.close();
  await fake.close();
});

async function gateway(): Promise<{ gateway: Gateway; dataDir: string }> {
  const dataDir = join(tempDir("e2e-attack-"), "data");
  const started = await startGateway(main, { cloudUrl: proxy.url, keys, dataDir });
  open.push(started);
  return { gateway: started, dataDir };
}

const SEARCH = { category: "running-shoes", budget: 200, country: "US", postcode: "94103" };

/** find_offers → create_cart for `title`; returns the approval handle (still pending). */
async function pending(g: Gateway, title: string): Promise<string> {
  const offers = await g.call("find_offers", SEARCH);
  const cart = await g.call("create_cart", { offer_handle: offerHandle(offers, title) });
  return field(cart, "approval_handle");
}

/** A purchase approved by `passkey` and confirmed by the gateway. */
async function approved(g: Gateway, title: string, passkey: SoftPasskey): Promise<string> {
  const handle = await pending(g, title);
  expect(fake.approveWithPasskey(handle, passkey).status).toBe(200);
  expect(await g.call("get_approval_status", { approval_handle: handle })).toMatch(/^Approved: /);
  return handle;
}

describe("attack: a tampered proof", () => {
  it("is not verified and nothing is chained as an approval; verify exit 0", { timeout: 60_000 }, async () => {
    const { gateway: g, dataDir } = await gateway();
    expect(g.stderr()).toContain("No policy file found; using the bundled zip-only policy");
    const handle = await pending(g, "Trail Runner 3");
    fake.approveWithPasskey(handle, new SoftPasskey());
    fake.tamper.proofHash();
    const status = await g.call("get_approval_status", { approval_handle: handle });
    expect(status).toMatch(/^The approval could not be verified \(.+\)\. The purchase is not approved\./);
    await g.close();

    const entries = chain(dataDir);
    expect(count(entries, "approval")).toBe(0);
    expect(count(entries, "approver_pin")).toBe(0);
    expect(entries.at(-1)).toMatchObject({ kind: "block", body: { endpoint: "getApproval", fields: ["proof"] } });
    const report = verify(main, dataDir, keys);
    expect(report.out).toMatch(/^verify: ok$/m);
    expect(report.code).toBe(0);
  });
});

describe("attack: a replayed approval", () => {
  it("another approval's proof served by the network for this one is not verified; verify exit 0", { timeout: 60_000 }, async () => {
    const { gateway: g, dataDir } = await gateway();
    const passkey = new SoftPasskey();
    const first = await approved(g, "Trail Runner 3", passkey);
    const second = await pending(g, "Road Runner 2");
    proxy.replay(second, first);
    const status = await g.call("get_approval_status", { approval_handle: second });
    expect(status).toMatch(/^The approval could not be verified \(handle_mismatch.*\)\. The purchase is not approved\./);
    await g.close();

    expect(count(chain(dataDir), "approval")).toBe(1);
    const report = verify(main, dataDir, keys);
    expect(report.out).toMatch(/^verify: ok$/m);
    expect(report.code).toBe(0);
  });

  it("the same proof chained a second time fails verify (exit 1, replay)", { timeout: 60_000 }, async () => {
    const { gateway: g, dataDir } = await gateway();
    await approved(g, "Trail Runner 3", new SoftPasskey());
    await g.close();

    const approval = chain(dataDir).find((e) => e.kind === "approval");
    const store = await openStore(dataDir);
    try {
      await store.append("approval", approval?.body);
    } finally {
      await store.close();
    }
    const report = verify(main, dataDir, keys);
    expect(report.out).toMatch(/does not verify \(step null: replay\)/);
    expect(report.out).toMatch(/^verify: FAILED$/m);
    expect(report.code).toBe(1);
  });
});

describe("attack: a 2xx without a valid receipt", () => {
  it.each([
    ["dropped", (): void => {
      fake.tamper.dropReceipt();
    }],
    ["forged", (): void => {
      fake.tamper.receiptSignature();
    }],
  ])("a %s receipt: the answer is discarded, not shown; verify exit 1", { timeout: 60_000 }, async (_, tamper) => {
    const { gateway: g, dataDir } = await gateway();
    tamper();
    const offers = await g.call("find_offers", SEARCH);
    expect(offers).toMatch(/^Intent Cloud's answer carried no valid receipt, so the gateway discarded it\./);
    expect(offers).not.toContain("offer_handle");
    await g.close();

    expect(count(chain(dataDir), "discarded")).toBe(1);
    const report = verify(main, dataDir, keys);
    expect(report.out).toMatch(/discarded: a response to .+ came without a valid receipt/);
    expect(report.out).toMatch(/^verify: FAILED$/m);
    expect(report.code).toBe(1);
  });
});

describe("attack: a second passkey approves", () => {
  it("is flagged, not approved (verify exit 0); approver accept refuses a pipe and, at a terminal, approves it", { timeout: 60_000 }, async () => {
    const { gateway: g, dataDir } = await gateway();
    await approved(g, "Trail Runner 3", new SoftPasskey());
    const second = await pending(g, "Road Runner 2");
    expect(fake.tamper.secondCredential(second).outcome.status).toBe(200);
    const flagged = await g.call("get_approval_status", { approval_handle: second });
    expect(flagged).toMatch(/^Not approved: a passkey other than the pinned approver signed this purchase/);
    expect(flagged).toContain(`node ${realpathSync(main)} approver accept`);
    const fingerprint = /fingerprint ([0-9a-f]{4}(?: [0-9a-f]{4}){15})/.exec(flagged)?.[1] ?? "";
    expect(fingerprint).not.toBe("");
    expect(count(chain(dataDir), "approver_flag")).toBe(1);
    expect(count(chain(dataDir), "approval")).toBe(1);
    const flaggedReport = verify(main, dataDir, keys);
    expect(flaggedReport.out).toMatch(/^verify: ok$/m);
    expect(flaggedReport.code).toBe(0);

    // An agent with shell access runs the built CLI through pipes: refused, nothing written.
    const piped = spawnSync(process.execPath, [main, "approver", "accept"], { env: env({ INTENT_DATA_DIR: dataDir }), input: `${fingerprint}\n`, encoding: "utf8" });
    expect(piped.stderr).toMatch(/approver accept needs a person at a terminal/);
    expect(piped.status).toBe(2);
    expect(count(chain(dataDir), "approver_pin")).toBe(1);

    // The developer at a terminal types the fingerprint (the CLI's Io seam stands in for the TTY).
    const out: string[] = [];
    const stdin = new PassThrough();
    stdin.end(`${fingerprint}\n`);
    const accepted = await cli(["approver", "accept"], {
      env: { INTENT_DATA_DIR: dataDir },
      stdin,
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => out.push(t) },
      isTTY: { stdin: true, stdout: true },
    });
    expect(out.join("")).toContain(`pinned ${fingerprint}`);
    expect(accepted.code).toBe(0);

    const status = await g.call("get_approval_status", { approval_handle: second });
    expect(status).toMatch(/^Approved: /);
    expect(status).toContain(`Approver passkey fingerprint: ${fingerprint}`);
    await g.close();

    expect(count(chain(dataDir), "approval")).toBe(2);
    const report = verify(main, dataDir, keys);
    expect(report.out).toMatch(/^verify: ok$/m);
    expect(report.code).toBe(0);
  });
});

describe("attack: identity in a tool input", () => {
  it("an email in find_offers and a card number in create_cart are refused with 0 sends; verify exit 0", { timeout: 60_000 }, async () => {
    const { gateway: g, dataDir } = await gateway();
    const offers = await g.call("find_offers", SEARCH);
    const offer = offerHandle(offers, "Trail Runner 3");
    const before = chain(dataDir);

    const search = await g.call("find_offers", { ...SEARCH, email: "jane.doe@mail.example" });
    expect(search).toMatch(/^Not sent: /);
    expect(search).toMatch(/\/ Blocked: .*email/);
    const cart = await g.call("create_cart", { offer_handle: offer, card_number: "4111111111111111" });
    expect(cart).toMatch(/^Not sent: /);
    await g.close();

    const after = chain(dataDir);
    expect(count(after, "disclosure")).toBe(count(before, "disclosure"));
    expect(count(after, "block")).toBe(count(before, "block") + 2);
    const log = readFileSync(join(dataDir, "audit.jsonl"), "utf8");
    expect(log).not.toContain("jane.doe");
    expect(log).not.toContain("4111111111111111");
    const report = verify(main, dataDir, keys);
    expect(report.out).toMatch(/^verify: ok$/m);
    expect(report.code).toBe(0);
  });
});
