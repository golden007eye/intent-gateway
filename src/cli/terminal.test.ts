// Attack cases for merchant-controlled text in the terminal (review of F-y, F1): a product title or merchant name
// Intent Cloud returned reaches the chain verbatim, and every CLI view of the chain prints it. Each view must show
// escape sequences, bidi overrides and line breaks as visible text, never pass them to the terminal.
// Also: a split-card false positive shows "withheld", never a fake $0.00 (F3), and the receipt tick is not placed
// as if it vouched for the returned state (F4).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { observeCart, observeSearch, observeStatus } from "../observation/index.ts";
import { buildModel, renderPage } from "../panel/index.ts";
import { loadPolicy } from "../policy/index.ts";
import { type Entry, openStore } from "../store/index.ts";
import type { Io } from "./io.ts";
import { formatJson, formatLog, formatVerbose, logCommand, readLog } from "./log.ts";
import { main } from "./main.ts";
import { printable, printableJson, printableLines } from "../ui/index.ts";

const ESC = "\u001b";
const BEL = "\u0007";
const CLEAR = `${ESC}[2J`;
const OSC52 = `${ESC}]52;c;cm0gLXJmIH4=${BEL}`;
const OSC8 = `${ESC}]8;;https://evil.example${BEL}CLICK${ESC}]8;;${BEL}`;
const RLO = "\u202e";
/** A newline followed by what looks like a timeline row of its own: a fake approval. */
const FAKE_ROW = "\n17:30:00  approved  $9999.00 · passkey a295…1de0 (pinned)               ✓ passkey proof checked";
const EVIL_TITLE = `Shoe${OSC8}${CLEAR}${OSC52}${FAKE_ROW}`;
const EVIL_MERCHANT = `M${ESC}[31m${RLO}evil`;

/** Every character a terminal acts on, or that reorders text: none may reach the output raw. */
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001a\u001c-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// eslint-disable-next-line no-control-regex
const NON_SGR_ESC = /\u001b(?!\[[0-9;]*m)/;

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const TS = Date.parse("2026-10-16T17:26:37.000Z");

function disclosure(endpoint: string, method: string, path: string, body: unknown) {
  return { endpoint, method, path, fields: [], body_b64: body === null ? "" : b64(body), content_digest: "sha-256=:x:", keyid: "gw-k" };
}

/** A search, a cart and a status check whose observations carry the merchant's text, as the gateway writes them. */
async function evilChain(dir: string, from = TS): Promise<void> {
  let second = 0;
  const store = await openStore(dir, { clock: () => from + (second += 1000) });
  const append = (kind: Entry["kind"], body: unknown) => store.append(kind, body);
  const offer = { offer_handle: "of_aaaaaaaa1", title: EVIL_TITLE, merchant: { name: EVIL_MERCHANT, domain: "shop.example" }, price: { amount_minor: 4000, currency: "USD" }, shipping: { amount_minor: 199, currency: "USD" } };
  const search = await append("disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", { category: "shoes" }));
  await append("receipt", { disclosure_seq: search.seq, status: 200, verified: true });
  await append("observed", observeSearch(search.seq, { offers: [offer] } as never, 0));
  const cart = await append("disclosure", disclosure("createCart", "POST", "/v1/carts", { offer_handle: "of_aaaaaaaa1", quantity: 1 }));
  await append("receipt", { disclosure_seq: cart.seq, status: 201, verified: true });
  await append("observed", observeCart(cart.seq, { item: { title: EVIL_TITLE }, merchant: { name: EVIL_MERCHANT }, quantity: 1, total: { amount_minor: 4199, currency: "USD" } } as never));
  const status = await append("disclosure", disclosure("getApproval", "GET", "/v1/approvals/ap_evil0001", null));
  await append("receipt", { disclosure_seq: status.seq, status: 200, verified: true });
  await append("observed", observeStatus(status.seq, "ap_evil0001", { state: "approved", display: { title: EVIL_TITLE, merchant: EVIL_MERCHANT, total: { amount_minor: 4199, currency: "USD" } } } as never));
  await append("approver_pin", { fingerprint: `aaaa${CLEAR}bbbb${FAKE_ROW}` });
  await store.close();
}

function newDir(): string {
  return join(mkdtempSync(join(tmpdir(), "terminal-")), "data");
}

function expectInert(out: string): void {
  expect(out).not.toMatch(RAW_CONTROL);
  expect(out).not.toMatch(NON_SGR_ESC);
  expect(out).not.toContain(CLEAR);
  expect(out).not.toContain(`${ESC}]52`);
  expect(out).not.toContain(`${ESC}]8`);
  // The fake row never starts a line of its own.
  expect(out.split("\n").some((l) => l.startsWith("17:30:00"))).toBe(false);
}

function io(env: Record<string, string>, out: string[], err: string[] = []): Io {
  return { env, stdin: new PassThrough(), stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, isTTY: { stdin: false, stdout: false } };
}

describe("printable", () => {
  it.each([
    ["ESC[2J (clear screen)", CLEAR, "\\u{1b}[2J"],
    ["OSC 52 (clipboard)", OSC52, "\\u{1b}]52;c;cm0gLXJmIH4=\\u{7}"],
    ["OSC 8 (hidden link)", OSC8, "\\u{1b}]8;;https://evil.example\\u{7}CLICK\\u{1b}]8;;\\u{7}"],
    ["a bidi override", `abc${RLO}def`, "abc\\u{202e}def"],
    ["a C1 CSI", "a\u009b2Jb", "a\\u{9b}2Jb"],
    ["DEL", "a\u007fb", "a\\u{7f}b"],
    ["a zero-width joiner and an isolate", "a\u200db\u2066c", "a\\u{200d}b\\u{2066}c"],
    ["a run of line breaks", "a\r\n\nb\u2028c", "a\\nb\\nc"],
    ["a tab", "a\tb", "a\\u{9}b"],
    ["a lone surrogate", "a\ud800b", "a\\u{d800}b"],
  ])("shows %s as text", (_, input, shown) => {
    expect(printable(input)).toBe(shown);
  });

  it("leaves printable text alone, accents, symbols and emoji included, and is idempotent", () => {
    const text = 'Laufschuh „Größe" 𝄞 — ✓ → ☕ $41.98 · ×1';
    expect(printable(text)).toBe(text);
    expect(printable(printable(EVIL_TITLE))).toBe(printable(EVIL_TITLE));
  });

  it("printableLines keeps the line breaks between lines; printableJson stays valid JSON with the same value", () => {
    expect(printableLines(`a${ESC}b\nc`)).toBe("a\\u{1b}b\nc");
    const json = printableJson(JSON.stringify({ t: `x\u0085${RLO}\u{e0001}y` }));
    expect(json).not.toMatch(/[\u0085\u202e]/u);
    expect((JSON.parse(json) as { t: string }).t).toBe(`x\u0085${RLO}\u{e0001}y`);
  });
});

describe("attack: merchant text in every chain view", () => {
  it("intent log (default timeline, colour on) shows the escapes as text and keeps the fake row inline", async () => {
    const dir = newDir();
    await evilChain(dir);
    const out = formatLog(readLog(dir), { style: { color: true, utc: true } });
    expectInert(out);
    expect(out).toContain("\\u{1b}[2J");
    expect(out).toContain("\\u{1b}]52;c;");
    expect(out).toContain("\\u{202e}");
    expect(out).toContain("\\n17:30:00  approved");
  });

  it("intent log -v and --json", async () => {
    const dir = newDir();
    await evilChain(dir);
    const items = readLog(dir);
    expectInert(formatVerbose(items, { style: { color: true, utc: true } }));
    const json = formatJson(items);
    expectInert(json);
    // Still the merchant's text, byte for byte, for a script that parses it.
    const lines = json.trimEnd().split("\n").map((l) => JSON.parse(l) as { facts: { title?: string } });
    expect(lines.some((l) => l.facts.title === EVIL_TITLE)).toBe(true);
  });

  it("intent log --follow", async () => {
    const dir = newDir();
    await evilChain(dir);
    const out: string[] = [];
    const outcome = logCommand({ ...io({}, out), followMs: 10 }, dir, { verbose: false, json: false, follow: true, filter: {}, style: { color: false, utc: true } });
    const start = out.join("").length;
    await evilChain(dir, TS + 3_600_000);
    for (let i = 0; i < 200 && out.join("").length === start; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    await outcome.stop?.();
    const tail = out.join("").slice(start);
    expect(tail).toContain("Shoe");
    expectInert(tail);
  });

  it("intent verify and intent approver list", async () => {
    const dir = newDir();
    await evilChain(dir);
    const out: string[] = [];
    const err: string[] = [];
    await main(["approver", "list"], io({ INTENT_DATA_DIR: dir }, out, err));
    expect(out.join("")).toContain("aaaa\\u{1b}[2Jbbbb\\n17:30:00");
    await main(["verify", "--skip-install-check"], io({ INTENT_DATA_DIR: dir }, out, err));
    expectInert(out.join("") + err.join(""));
  });

  it("the panel writes the same values as text: no control character reaches the page", async () => {
    const dir = newDir();
    await evilChain(dir);
    const html = renderPage(
      buildModel({
        items: readLog(dir),
        now: TS + 60_000,
        mode: "real",
        intent: "intent",
        policy: { policy: loadPolicy("version: 1\napproval: passkey\n"), source: "/data/policy.yaml" },
        verify: { ok: true, head: { seq: 0, hash: "h" }, checks: [] },
        timeZone: "UTC",
      }),
    );
    expect(html).toContain("Shoe\\u{1b}]8;;https://evil.example\\u{7}CLICK");
    expect(html).toContain("\\u{202e}evil");
    expect(html).not.toMatch(RAW_CONTROL);
    expect(html).not.toContain(ESC);
    // The fake row stays inside the title's text node.
    expect(html).toContain("\\n17:30:00  approved");
  });
});

describe("withheld numbers and the receipt tick (F3, F4)", () => {
  /** poc2: an offer's price and shipping read together as a card number, so the observation withholds the offer's numbers. */
  async function splitCardChain(dir: string): Promise<void> {
    const store = await openStore(dir, { clock: () => TS });
    const search = await store.append("disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", { category: "shoes" }));
    await store.append("receipt", { disclosure_seq: search.seq, status: 200, verified: true });
    const offer = { offer_handle: "of_aaaa1", title: "t", merchant: { name: "m" }, price: { amount_minor: 411111111, currency: "USD" }, shipping: { amount_minor: 1111111, currency: "USD" } };
    const observed = observeSearch(search.seq, { offers: [offer] } as never, 0);
    expect(observed.withheld?.length).toBeGreaterThan(0);
    await store.append("observed", observed);
    const cart = await store.append("disclosure", disclosure("createCart", "POST", "/v1/carts", { offer_handle: "of_aaaa1", quantity: 1 }));
    await store.append("receipt", { disclosure_seq: cart.seq, status: 201, verified: true });
    await store.append("observed", { disclosure_seq: cart.seq, endpoint: "createCart", title: "Shoe", merchant: "Shop", quantity: 1, total_minor: 0, currency: "USD", withheld: ["$.total_minor"] });
    await store.close();
  }

  it("intent log and -v show a withheld price, shipping or total as withheld, never $0.00", async () => {
    const dir = newDir();
    await splitCardChain(dir);
    const items = readLog(dir);
    const timeline = formatLog(items, { style: { color: false, utc: true } });
    expect(timeline).toContain("Shoe ×1 · total withheld · Shop");
    const verbose = formatVerbose(items, { style: { color: false, utc: true } });
    expect(verbose).toContain("withheld + withheld shipping");
    expect(verbose).toContain("cart: Shoe x1, total withheld, Shop");
    for (const out of [timeline, verbose]) expect(out).not.toContain("$0.00");
  });

  it("the panel shows a withheld total as withheld, never $0.00", async () => {
    const dir = newDir();
    await splitCardChain(dir);
    const html = renderPage(
      buildModel({
        items: readLog(dir),
        now: TS + 60_000,
        mode: "real",
        intent: "intent",
        policy: { policy: loadPolicy("version: 1\napproval: passkey\n"), source: "/data/policy.yaml" },
        verify: { ok: true, head: { seq: 0, hash: "h" }, checks: [] },
        timeZone: "UTC",
      }),
    );
    expect(html).toContain("Shoe · total withheld · Shop");
    // ("Approved today: $0.00" is the day's real sum; no cart or entry shows the withheld 0.)
    expect(html).not.toMatch(/Shoe[^<]*\$0\.00|came back for #3[^<]*\$0\.00/);
  });

  it("a returned state reads as what Intent Cloud says, then the receipt, never the tick right after the state", async () => {
    const dir = newDir();
    await evilChain(dir);
    const out = formatLog(readLog(dir), { style: { color: false, utc: true } });
    expect(out).toContain("→ Intent Cloud says approved · ✓ receipt");
    expect(out).toContain("→ 1 offer · ✓ receipt");
    expect(out).not.toMatch(/→ approved {2}✓/);
  });
});
