// The panel's views from a fixture chain: the KPIs, the purchase timeline and its drawers, approvals, policy, server
// log and verify; the page's structure (landmarks, nav, deep links), its escaping, and its wording (invariant 5:
// "acknowledged" only with a receipt; never what Intent Cloud does next).
import { describe, expect, it } from "vitest";
import { loadPolicy } from "../policy/index.ts";
import { APP_CSS, APP_JS } from "./assets.ts";
import { buildModel, type ModelInput, renderPage } from "./index.ts";
import { VIEWS } from "./render.ts";

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const kidHeader = Buffer.from(JSON.stringify({ kid: "cloud-receipt-202610" })).toString("base64url");
type Spec = [kind: string, body: Record<string, unknown>, ts: string];

function chain(specs: readonly Spec[]): unknown[] {
  return specs.map(([kind, body, ts], seq) => ({ seq, prev: `p${String(seq)}`, ts, kind, body, hash: `h${String(seq)}` }));
}
const at = (hhmm: string, day = "2026-10-16") => `${day}T${hhmm}:00.000Z`;
const disclosure = (endpoint: string, path: string, body: unknown, fields: string[] = []) => ({
  endpoint,
  method: "POST",
  path,
  fields,
  body_b64: body === null ? "" : b64(body),
  content_digest: `sha-256=:${endpoint}:`,
  keyid: "gw-k",
});
const receipt = (seq: number, status = 200) => ({ disclosure_seq: seq, status, verified: true, receipt_header: kidHeader });
const SHIP = { country: "US", postal_code: "94103" };
const CART_FIELDS = ["offer_handle", "quantity", "ship_to", "ship_to.country", "ship_to.postal_code"];

/** Yesterday's approval ($30), today's search + approved cart ($41.98), a refused search, a cart waiting ($18), an unanswered search. */
const SPECS: Spec[] = [
  ["session", { mode: "demo" }, at("08:00")],
  ["approval_pending", { handle: "ap_old", approval_url: "http://127.0.0.1:8788/confirm/c/o", total_minor: 3000, expires_at: at("08:15", "2026-10-15") }, at("08:00", "2026-10-15")],
  ["approval", { handle: "ap_old" }, at("08:01", "2026-10-15")],
  ["disclosure", disclosure("searchCatalog", "/v1/catalog/search", { category: "running shoes", budget_max: { amount_minor: 12000, currency: "USD" }, ship_to: SHIP }), at("10:26")],
  ["receipt", receipt(3), at("10:26")],
  ["block", { endpoint: "searchCatalog", fields: ["category"], blocked: ["categories.block at category"] }, at("10:26")],
  ["disclosure", disclosure("createCart", "/v1/carts", { offer_handle: "of_8Kx2abcdefghij", quantity: 1, ship_to: SHIP }, CART_FIELDS), at("10:27")],
  ["receipt", receipt(6, 201), at("10:27")],
  ["disclosure", disclosure("createApproval", "/v1/carts/ct_1/approvals", null), at("10:27")],
  ["receipt", receipt(8, 201), at("10:27")],
  ["approval_pending", { handle: "ap_shoe", approval_url: "http://127.0.0.1:8788/confirm/c/s", total_minor: 4198, expires_at: at("10:42") }, at("10:27")],
  ["disclosure", disclosure("getApproval", "/v1/approvals/ap_shoe", null), at("10:28")],
  ["receipt", receipt(11), at("10:28")],
  ["approver_pin", { fingerprint: "f502 1111 2222 8c9f", handle: "ap_shoe" }, at("10:28")],
  ["approval", { handle: "ap_shoe" }, at("10:28")],
  ["disclosure", disclosure("createCart", "/v1/carts", { offer_handle: "of_sock", quantity: 1, ship_to: SHIP }, CART_FIELDS), at("10:29")],
  ["receipt", receipt(15, 201), at("10:29")],
  ["disclosure", disclosure("createApproval", "/v1/carts/ct_2/approvals", null), at("10:29")],
  ["receipt", receipt(17, 201), at("10:29")],
  ["approval_pending", { handle: "ap_sock", approval_url: "javascript:alert(1)", total_minor: 1800, expires_at: at("10:44") }, at("10:29")],
  ["disclosure", disclosure("searchCatalog", "/v1/catalog/search", { category: "<script>alert(1)</script>" }), at("10:30")],
];

const POLICY = loadPolicy("version: 1\napproval: passkey\nspend:\n  per_order_usd: 60\n  per_day_usd: 75\n");
const VERIFY = { ok: true, head: { seq: 20, hash: "h20" }, checks: [{ name: "chain", ok: true, details: ["21 entries, every hash links"] }] };

function input(over: Partial<ModelInput> = {}): ModelInput {
  return {
    items: chain(SPECS),
    now: Date.parse(at("10:31")),
    mode: "demo",
    intent: "intent",
    policy: { policy: POLICY, source: "/data/policy.yaml" },
    verify: VERIFY,
    timeZone: "UTC",
    ...over,
  };
}

describe("buildModel: overview", () => {
  const m = buildModel(input());

  it("counts approved spend in the 24 h the daily limit uses, against the active policy's limit", () => {
    expect(m.kpis.approvedMinor).toBe(4198); // yesterday 08:01 is outside the window
    expect(m.kpis.dailyLimitMinor).toBe(7500);
    expect(buildModel(input({ policy: null, policyError: "bad yaml" })).kpis.dailyLimitMinor).toBeNull();
  });

  it("waiting approvals, and a chain URL that is not http(s) never becomes a link", () => {
    expect(m.kpis.waiting).toBe(1);
    expect(m.kpis.nextWaiting).toEqual({ text: "Running shoes · $18.00 · open approval page", url: null });
    expect(m.pending.map((p) => [p.handle, p.url])).toEqual([["ap_sock", null]]);
    expect(renderPage(m)).not.toMatch(/href="javascript:/i);
  });

  it("sent counts exclude a request with no answer; acknowledged means a receipt entry", () => {
    expect(m.kpis).toMatchObject({ sent: 6, acknowledged: 6, maybeSent: 1, unacknowledged: 0, refusedBefore: 1 });
    expect(m.kpis.refusedNote).toBe("last: excluded or blocked category, nothing sent");
    const unanswered = m.feed.find((l) => l.seq === 20);
    expect(unanswered?.text).toContain("maybe sent");
    expect(unanswered?.text).not.toContain("receipt");
  });

  it("the activity feed is newest first, in the log's words", () => {
    expect(m.feed.map((l) => [l.clock, l.label])).toEqual([
      ["10:30", "search"],
      ["10:29", "cart"],
      ["10:28", "approved"],
      ["10:28", "status"],
      ["10:27", "cart"],
      ["10:26", "refused"],
      ["10:26", "search"],
      ["2026-10-15 08:01", "approved"],
      ["2026-10-15 08:00", "cart"],
    ]);
    expect(m.feed.find((l) => l.label === "approved")?.text).toBe("Approved · $41.98 · passkey f502…8c9f ✓ · pinned as your approver");
  });
});

describe("buildModel: purchases", () => {
  const m = buildModel(input());

  it("each cart is a purchase, newest first, with its four steps", () => {
    expect(m.purchases.map((p) => [p.title, p.state])).toEqual([
      ["Running shoes · $18.00", "Waiting for you"],
      ["Running shoes · $41.98", "Approved"],
      ["Purchase · $30.00", "Approved"],
    ]);
    const [waiting, approved] = m.purchases;
    expect(waiting?.steps.map((s) => [s.name, s.state, s.note])).toEqual([
      ["Search", "done", "10:26 · receipt ✓"],
      ["Cart", "done", "10:29 · receipt ✓"],
      ["Your approval", "waiting", "waiting for you"],
      ["Agent checks", "todo", "not yet"],
    ]);
    expect(approved?.steps.map((s) => [s.name, s.state, s.drawer])).toEqual([
      ["Search", "done", "a-3"],
      ["Cart", "done", "a-6"],
      ["Your approval", "done", "a-13"],
      ["Agent checked", "done", "a-11"],
    ]);
  });

  it("a step's drawer shows the values sent field by field, what came back, the receipt kid and the digest", () => {
    const cart = m.drawers.find((d) => d.id === "a-6");
    expect(cart?.seqs).toBe("seq 6–10");
    expect(cart?.requests[0]).toMatchObject({
      endpoint: "createCart",
      sent: [
        ["offer_handle", "of_8Kx2abcdefghij"],
        ["quantity", "1"],
        ["ship_to.country", "US"],
        ["ship_to.postal_code", "94103"],
      ],
      back: [
        ["status", "201"],
        ["receipt", "cloud-receipt-202610 ✓"],
      ],
      delivery: "Intent Cloud acknowledged receiving it (signed receipt)",
      digest: "sha-256=:createCart:",
    });
    const html = renderPage(m);
    expect(html).toContain("Never sent: your name, postal address and card.");
    expect(html).toContain('<aside class="drawer" id="/purchases/a-6" aria-labelledby="dh-a-6">');
    // Every step's Details link has a drawer to open.
    for (const [, id] of html.matchAll(/data-drawer="([^"]+)"/g)) expect(html).toContain(`id="/purchases/${id ?? ""}"`);
  });

  it("refused requests are listed apart", () => {
    expect(m.refusals.map((r) => r.text)).toEqual(["Search refused before sending: excluded or blocked category · nothing sent"]);
  });
});

describe("buildModel: observations (what came back) and held values; older chains keep their fallbacks", () => {
  const observed = (seq: number, body: Record<string, unknown>): Spec => ["observed", { disclosure_seq: seq, ...(body.endpoint === "searchCatalog" ? {} : { currency: "USD" }), ...body }, at("10:31")];
  // The same flow with an observation after each receipt (inserted at the end keeps every seq the fixture names), the
  // block's held value, and the waiting sock cart rejected on the confirm page.
  const specs: Spec[] = [
    ...SPECS.map(([kind, body, ts]): Spec => (kind === "block" ? [kind, { ...body, held: { category: "alcohol" } }, ts] : [kind, body, ts])),
    observed(3, { endpoint: "searchCatalog", offers_count: 3, offers_hidden: 0, offers: [] }),
    observed(6, { endpoint: "createCart", title: "Budget Running Shoe", merchant: "Resale Hub", quantity: 1, total_minor: 4198 }),
    observed(15, { endpoint: "createCart", title: "Trail Socks 3-pack", merchant: "Hydra Goods", quantity: 1, total_minor: 1800 }),
    ["disclosure", { ...disclosure("getApproval", "/v1/approvals/ap_sock", null), method: "GET" }, at("10:32")],
    ["receipt", receipt(24), at("10:32")],
    observed(24, { endpoint: "getApproval", approval_handle: "ap_sock", state: "rejected", title: "Trail Socks 3-pack", merchant: "Hydra Goods", total_minor: 1800 }),
  ];
  const m = buildModel(input({ items: chain(specs), now: Date.parse(at("10:33")) }));

  it("a purchase is titled with what came back: product, total, merchant; a rejected one says so", () => {
    expect(m.purchases.map((p) => [p.title, p.state])).toEqual([
      ["Trail Socks 3-pack · $18.00 · Hydra Goods", "Rejected"],
      ["Budget Running Shoe · $41.98 · Resale Hub", "Approved"],
      ["Purchase · $30.00", "Approved"],
    ]);
    expect(m.purchases[0]?.steps[2]).toMatchObject({ name: "Your approval", state: "failed", note: "Intent Cloud says rejected" });
    expect(m.kpis.waiting).toBe(0);
  });

  it("the feed says how many offers came back, names the held-back category, and shows the rejection", () => {
    const texts = m.feed.map((l) => [l.label, l.text]);
    expect(texts).toContainEqual(["search", "Search · running shoes · under $120.00 · ZIP 94103 · 3 offers · receipt ✓"]);
    expect(texts).toContainEqual(["refused", 'Search refused: category "alcohol" excluded · nothing sent']);
    expect(texts).toContainEqual(["rejected", "Approval status checked · ap_sock · Trail Socks 3-pack · rejected · receipt ✓"]);
    expect(m.kpis.refusedNote).toBe('last: category "alcohol" excluded, nothing sent');
  });

  it("without observations the same chain keeps the older words", () => {
    const old = buildModel(input());
    expect(old.feed.find((l) => l.label === "refused")?.text).toBe("Search refused before sending: excluded or blocked category · nothing sent");
    expect(old.purchases[1]?.title).toBe("Running shoes · $41.98");
  });
});

describe("buildModel: approvals, policy, log, verify", () => {
  const m = buildModel(input());

  it("approvals, the pin and its seq", () => {
    expect(m.approved.map((a) => [a.handle, a.total, a.pinned])).toEqual([
      ["ap_shoe", "$41.98", true],
      ["ap_old", "$30.00", false],
    ]);
    expect(m.pin).toMatchObject({ fingerprint: "f502 1111 2222 8c9f", seq: 13 });
  });

  it("the policy view words every rule; an unreadable policy says why", () => {
    expect(m.policy?.rules).toContainEqual(["Per day (24 h)", "up to $75"]);
    expect(m.policy?.rules).toContainEqual(["Approval", "your passkey, on every purchase"]);
    const bad = buildModel(input({ policy: null, policyError: "the active policy could not be read: POLICY_LOOSENS" }));
    expect(renderPage(bad)).toContain("the active policy could not be read: POLICY_LOOSENS");
  });

  it("the server log lists every entry field by field, an unreadable line included", () => {
    const items = [...chain(SPECS), '{"seq":21'];
    const log = buildModel(input({ items })).log;
    expect(log).toHaveLength(22);
    expect(log[6]?.fields).toContainEqual(["endpoint", "createCart"]);
    expect(log[6]?.summary).toBe("logged createCart  offer_handle, quantity, ship_to.country, ship_to.postal_code");
    expect(log[21]).toMatchObject({ kind: "unreadable", tone: "bad" });
  });

  it("verify shows the result and the command for this chain", () => {
    expect(m.verifyCommand).toBe("intent verify --demo");
    expect(buildModel(input({ mode: "real" })).verifyCommand).toBe("intent verify");
    const html = renderPage(m);
    expect(html).toContain("Every check passed");
    expect(renderPage(buildModel(input({ verify: null })))).toContain("Not run here.");
  });
});

describe("buildModel: wallet destinations, refusals and wallet entries (ADR-0014)", () => {
  const TOKEN_MARKER = `[redacted sha256:${"e5c02528".padEnd(64, "0")}]`;
  const REFRESH_MARKER = `[redacted sha256:${"a1d94354".padEnd(64, "1")}]`;
  const EMAIL = "jane.buyer@example.com";
  const shopCall = (name: string, args: Record<string, unknown>, redacted: { at: string; sha256: string }[]) => ({
    endpoint: name,
    destination: "shop",
    method: "POST",
    path: "/api/mcp",
    fields: ["id", "jsonrpc", "method", "params", "params.arguments", ...Object.keys(args).map((k) => `params.arguments.${k}`), "params.name"],
    body_b64: b64({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    headers: [["authorization", TOKEN_MARKER]],
    content_digest: "sha-256=:shop:",
    redacted,
  });
  // The entries as the disclosure core writes them (src/cli/log-destinations.test.ts drives the real core).
  const WALLET_SPECS: Spec[] = [
    ["disclosure", disclosure("searchCatalog", "/v1/catalog/search", { category: "lamps", ship_to: SHIP }), at("10:20")],
    ["receipt", receipt(0), at("10:20")],
    ["wallet", { rail: "shop", action: "linked", revoked: false }, at("10:21")],
    ["session", { id: "s-1" }, at("10:22")],
    ["disclosure", shopCall("get_checkout", { checkout_id: "co_123" }, [{ at: "headers.authorization", sha256: "e5c02528".padEnd(64, "0") }]), at("10:22")],
    ["response", { disclosure_seq: 4, status: 200, body_sha256: "1".repeat(64), bytes: 31 }, at("10:22")],
    [
      "disclosure",
      shopCall("refresh", { refresh_token: REFRESH_MARKER }, [
        { at: "headers.authorization", sha256: "e5c02528".padEnd(64, "0") },
        { at: "body.params.arguments.refresh_token", sha256: "a1d94354".padEnd(64, "1") },
      ]),
      at("10:23"),
    ],
    ["response", { disclosure_seq: 6, status: 401, body_sha256: "2".repeat(64), bytes: 31 }, at("10:23")],
    // An identity block holds no value; a `held` on one (a hand-edited chain) is never shown.
    ["block", { endpoint: "search", destination: "shop", fields: ["params.arguments.note"], blocked: ["email at $.params.arguments.note"], held: { note: EMAIL } }, at("10:24")],
    ["block", { endpoint: "search", destination: "shop", fields: ["params.arguments.q"], blocked: ["a credential in the query (access_token), which the log cannot digest"] }, at("10:25")],
    ["wallet", { rail: "shop", action: "unlinked", revoked: true }, at("10:26")],
    ["wallet", { rail: "shop", action: "unlinked", revoked: false }, at("10:27")],
  ];
  const m = buildModel(input({ items: chain(WALLET_SPECS), now: Date.parse(at("10:30")) }));
  const html = renderPage(m);

  it("the overview counts Intent Cloud's requests only, and each wallet destination apart: answered, never acknowledged", () => {
    expect(m.kpis).toMatchObject({ sent: 1, acknowledged: 1, maybeSent: 0, elsewhere: [{ destination: "Shop", sent: 2, answered: 2, maybeSent: 0 }] });
    expect(html).toContain("Also sent to Shop: 2 (2 answered, unsigned)</p>");
    expect(html).not.toMatch(/maybe sent/);
  });

  it("the feed words a Shop call, both refusals with their reason and 'nothing sent', and the wallet changes", () => {
    expect(m.feed.map((l) => [l.label, l.tone, l.text])).toEqual([
      ["wallet", "plain", "Shop wallet unlinked · token not revoked (deleted here only)"],
      ["wallet", "plain", "Shop wallet unlinked · token revoked at Shop"],
      ["refused", "bad", "Shop search refused before sending: not logged as sent: a credential in the query (access_token), which the log cannot digest · nothing sent"],
      ["refused", "bad", "Shop search refused before sending: buyer identity held back · nothing sent"],
      ["call", "warn", "Shop refresh · answered 401, unsigned"],
      ["call", "plain", "Shop get_checkout · answered 200, unsigned"],
      ["start", "plain", "Gateway started"],
      ["wallet", "plain", "Shop wallet linked"],
      ["search", "plain", "Search · lamps · ZIP 94103 · receipt ✓"],
    ]);
    expect(m.refusals).toHaveLength(2);
  });

  it("the server log words the response, a Shop disclosure, a Shop block and a wallet entry", () => {
    const summaries = m.log.map((r) => [r.kind, r.tone, r.summary]);
    expect(summaries).toContainEqual(["response", "ok", "answer to #4 · status 200 · 31 bytes · unsigned"]);
    expect(summaries).toContainEqual(["disclosure", "plain", "logged to Shop get_checkout  id, jsonrpc, method, params.arguments.checkout_id, params.name"]);
    expect(summaries).toContainEqual(["block", "bad", "refused before sending to Shop search · email at $.params.arguments.note"]);
    expect(summaries).toContainEqual(["wallet", "plain", "Shop wallet unlinked · token revoked"]);
  });

  it("attack: the panel shows no buyer identity, even one a hand-edited identity block holds", () => {
    expect(html).not.toContain(EMAIL);
    expect(html).not.toContain("jane");
  });

  it("a wallet check (plan G12): what Shop reported and how many orders no purchase names, a warning when any; the server log keeps counts", () => {
    const check = (unmatched: number, total: number, complete: boolean) => ({
      rail: "shop",
      action: "checked",
      since: "2026-10-10T12:00:00.000Z",
      order_count: 3,
      unmatched_count: unmatched,
      unmatched_total_minor: total,
      complete,
    });
    const cm = buildModel(input({ items: chain([["wallet", check(2, 2149, true), at("10:21")], ["wallet", check(0, 0, false), at("10:22")]]), now: Date.parse(at("10:30")) }));
    expect(cm.feed.map((l) => [l.label, l.tone, l.text])).toEqual([
      ["wallet", "plain", "Shop wallet checked · Shop reported 3 orders since 2026-10-10 · 0 not matched to a purchase in this log (0.00 USD) · Shop had more than it returned"],
      ["wallet", "warn", "Shop wallet checked · Shop reported 3 orders since 2026-10-10 · 2 not matched to a purchase in this log (21.49 USD)"],
    ]);
    expect(cm.log.map((r) => r.summary)).toEqual(["Shop wallet checked · 3 reported · 2 unmatched · 21.49 USD", "Shop wallet checked · 3 reported · 0 unmatched · 0.00 USD · partial"]);
  });

  it("attack: the server log of a hand-edited, re-hashed chain never shows a credential in clear, in a header or in the body", () => {
    const TOKEN = "shop-access-token-SECRET-0123456789";
    const REFRESH = "shop-refresh-token-SECRET-9876543210";
    const leaked = {
      ...shopCall("refresh", { refresh_token: REFRESH, client: "intent-gateway" }, []),
      headers: [
        ["authorization", `Bearer ${TOKEN}`],
        ["x-api-key", TOKEN_MARKER],
        ["content-type", "application/json"],
      ],
    };
    const lm = buildModel(input({ items: chain([["disclosure", leaked, at("10:22")]]), now: Date.parse(at("10:30")) }));
    const fields = Object.fromEntries(lm.log[0]?.fields ?? []);
    expect(fields["headers[0] authorization"]).toBe("[a credential in clear, not shown: intent verify fails this entry]");
    expect(fields["headers[1] x-api-key"]).toBe("redacted (sha256 e5c02528…)");
    expect(fields["headers[2] content-type"]).toBe("application/json");
    expect(fields["body.params.arguments.refresh_token"]).toBe("[a credential in clear, not shown: intent verify fails this entry]");
    expect(fields["body.params.arguments.client"]).toBe("intent-gateway");
    expect(fields.body_b64).toBeUndefined();
    const page = renderPage(lm);
    for (const secret of [TOKEN, REFRESH, Buffer.from(REFRESH).toString("base64").slice(0, 16)]) expect(page).not.toContain(secret);
  });

  it("attack: a request drawer shows a redaction marker as redacted, and a credential in clear never as its value", () => {
    const leak = { refresh_token: "shop-refresh-token-SECRET", note: "ok" };
    const specs: Spec[] = [
      ["disclosure", disclosure("searchCatalog", "/v1/catalog/search", { category: "lamps", ship_to: SHIP }), at("10:20")],
      ["receipt", receipt(0), at("10:20")],
      ["disclosure", { ...disclosure("createCart", "/v1/carts", { offer_handle: "of_x", quantity: 1, token_check: REFRESH_MARKER, ...leak }, CART_FIELDS), redacted: [{ at: "headers.authorization", sha256: "e5c02528".padEnd(64, "0") }] }, at("10:21")],
      ["receipt", receipt(2, 201), at("10:21")],
    ];
    const drawer = buildModel(input({ items: chain(specs), now: Date.parse(at("10:30")) })).drawers.find((d) => d.heading === "Cart");
    const sent = Object.fromEntries(drawer?.requests[0]?.sent ?? []);
    expect(sent.token_check).toBe("redacted (sha256 a1d94354…)");
    expect(sent.refresh_token).toBe("[a credential in clear, not shown: intent verify fails this entry]");
    expect(sent["header authorization"]).toBe("redacted (sha256 e5c02528…)");
    expect(JSON.stringify(drawer)).not.toContain("shop-refresh-token-SECRET");
  });
});

describe("renderPage", () => {
  const html = renderPage(buildModel(input()));

  it("has the landmarks, one nav with every view, aria-current on the default view, and a section per address", () => {
    expect(html).toMatch(/<header class="bar">/);
    expect(html).toContain('<nav class="nav" aria-label="Panel views">');
    expect(html).toContain('<main id="main" tabindex="-1">');
    expect(html).toContain('<a class="skip" href="#main">');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('<a href="#/overview" data-route="overview" aria-current="page">');
    for (const [id, name] of VIEWS) {
      expect(html).toContain(`<a href="#/${id}" data-route="${id}"`);
      expect(html).toContain(`<section class="view" id="/${id}" data-view="${id}" aria-labelledby="h-${id}"><h1 id="h-${id}" tabindex="-1">${name}</h1>`);
    }
    expect(html.match(/<h1 /g)).toHaveLength(VIEWS.length);
    expect(html).toContain('<span class="badge">1<span class="sr-only"> waiting for you</span></span>');
  });

  it("the Activity card's header has a real link to the purchase timeline, styled as a secondary button", () => {
    expect(html).toContain(
      '<div class="panel-head"><h2 id="h-activity">Activity</h2><a class="btn btn-secondary btn-inline" href="#/purchases">View purchase timeline →</a></div>',
    );
  });

  it("DEMO for the demo chain, REAL otherwise", () => {
    expect(html).toContain('<span class="pill">DEMO</span>');
    const real = renderPage(buildModel(input({ mode: "real" })));
    expect(real).toContain('<span class="pill pill-real">REAL</span>');
    expect(real).not.toContain("DEMO");
  });

  it("escapes chain values: a value is text, never markup", () => {
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
  });

  it("has no inline script, style or event handler; it loads only /app.css and /app.js", () => {
    expect(html).not.toMatch(/<style|style=|<script>|\son[a-z]+=/i);
    expect([...html.matchAll(/<(?:script|link)\b[^>]*>/g)].map((m) => m[0])).toEqual(['<link rel="stylesheet" href="/app.css">', '<script src="/app.js" defer>']);
  });

  it("says what came back, never what Intent Cloud does next", () => {
    // Each text node on its own: a heading, a card label, a sentence.
    for (const sentence of html.split(/<[^>]+>/)) {
      if (!/Intent Cloud/.test(sentence)) continue;
      expect(sentence).not.toMatch(/\b(stores?|keeps?|deletes?|processes|uses|forwards|shares)\b/i);
    }
  });

  it("an empty chain renders every view with its empty state", () => {
    const empty = renderPage(buildModel(input({ items: [], verify: null })));
    expect(empty).toContain("No purchases yet.");
    expect(empty).toContain("Nothing is waiting for your approval.");
    expect(empty).toContain("No entries yet: the gateway has sent nothing.");
    expect(empty).toContain("$0.00</p><div class=\"bar-track\"");
  });

  it("matches the overview snapshot", () => {
    const overview = /<section class="view" id="\/overview"[\s\S]*?<\/section><section class="view" id="\/purchases"/.exec(html)?.[0] ?? "";
    expect(overview.replace(/data-v="[^"]+"/g, 'data-v=""')).toMatchSnapshot();
  });
});

describe("assets", () => {
  it("app.js routes every view, writes no HTML string, and refreshes by region", () => {
    for (const [id] of VIEWS) expect(APP_JS).toContain(`"${id}"`);
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(APP_JS).toContain("DOMParser");
    expect(APP_JS).toContain('fetch("/", { cache: "no-store" })');
    expect(APP_JS).toContain('e.key === "Escape"');
  });

  it("app.css collapses the nav to tabs at 768px and makes no request", () => {
    expect(APP_CSS).toContain("@media (max-width:768px)");
    expect(APP_CSS).not.toMatch(/url\(|@import|@font-face|https?:/i);
  });
});
