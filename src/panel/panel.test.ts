// The panel's done-when criteria (plan G19): loopback-only bind, read-only routes, the exact CSP, no external
// URLs, the Host check, the private data dir, and entries.json reflecting a fixture chain and a tampered one.
//
// Under full-suite load a busy disk can stall fdatasync for seconds, so this file runs with a 20 s timeout, and the
// fixture chain is written through `fast`, an fs whose datasync is a no-op: the panel only reads, so durability is
// not under test here.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type StoreFs } from "../store/index.ts";
import { buildView, type Panel, PanelError, startPanel, type View } from "./index.ts";

const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ROUTES = ["/", "/app.js", "/app.css", "/entries.json"];

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const fast: StoreFs = {
  ...fsp,
  open: (async (...args: Parameters<typeof fsp.open>) =>
    Object.assign(await fsp.open(...args), { datasync: () => Promise.resolve() })),
};

let dir: string;
let panel: Panel | null = null;

beforeEach(async () => {
  dir = join(await fsp.mkdtemp(join(tmpdir(), "panel-")), "data");
  const store = await openStore(dir, { fs: fast });
  await store.append("disclosure", { endpoint: "/v1/offers/search", fields: ["category", "zip"], blocked: ["name"] });
  await store.append("receipt", { disclosure_seq: 0 });
  await store.append("approval_pending", { handle: "h1", approval_url: "https://confirm.example/a/h1" });
  await store.append("approval_pending", { handle: "h2", approval_url: "https://confirm.example/a/h2" });
  await store.append("approval", { handle: "h1" });
  await store.append("approver_pin", { fingerprint: "AAAA-1111" });
  await store.append("approver_flag", { fingerprint: "BBBB-2222" });
  await store.append("block", { endpoint: "/v1/carts", blocked: ["postal_address"], reason: "identity" });
  await store.close();
});

afterEach(async () => {
  await panel?.close();
  panel = null;
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** host: null sends no Host header at all. */
function call(url: string, path: string, opts: { method?: string; host?: string | null } = {}): Promise<Reply> {
  const { port, hostname } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: hostname,
        port,
        path,
        method: opts.method ?? "GET",
        setHost: false,
        headers: opts.host === null ? {} : { host: opts.host ?? `${hostname}:${port}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const start = async () => (panel = await startPanel(dir, { port: 0 }));

describe("bind", () => {
  it("listens on 127.0.0.1 only", async () => {
    const { url } = await start();
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect((await call(url, "/")).status).toBe(200);
  });

  it.each(["0.0.0.0", "::", "192.168.1.20", "localhost", "::1"])("refuses host %s", async (host) => {
    await expect(startPanel(dir, { port: 0, host })).rejects.toThrow(PanelError);
  });

  it("accepts a Config as the source", async () => {
    panel = await startPanel({ dataDir: dir }, { port: 0, host: "127.0.0.1" });
    expect((await call(panel.url, "/entries.json")).status).toBe(200);
  });
});

describe("routes", () => {
  it.each(ROUTES.flatMap((path) => ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].map((m) => [m, path])))(
    "%s %s is 405",
    async (method, path) => {
      const { url } = await start();
      const reply = await call(url, path, { method });
      expect(reply.status).toBe(405);
      expect(reply.headers.allow).toBe("GET");
    },
  );

  it("an unknown GET path is 404", async () => {
    const { url } = await start();
    expect((await call(url, "/audit.jsonl")).status).toBe(404);
    expect((await call(url, "/../audit.jsonl")).status).toBe(404);
  });

  it.each(ROUTES)("GET %s carries the constant security headers", async (path) => {
    const { url } = await start();
    const reply = await call(url, path);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-security-policy"]).toBe(EXPECTED_CSP);
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["referrer-policy"]).toBe("no-referrer");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-frame-options"]).toBe("DENY");
  });

  it("served assets contain no external URL and no inline script or style", async () => {
    const { url } = await start();
    for (const path of ["/app.js", "/app.css"]) {
      const { body } = await call(url, path);
      expect(body).not.toMatch(/https?:\/\//i);
      expect(body).not.toMatch(/\/\/[a-z0-9-]+\.[a-z]/i);
    }
    const html = (await call(url, "/")).body;
    // The page's only outside URLs are the approval link the chain holds for the waiting approval, as a link you choose
    // to open (no referrer, no opener), and chain values shown as text; no attribute makes the page load anything.
    const outside = /<a ([^>]*)href="(https?:[^"]*)"([^>]*)>/g;
    const links = [...html.matchAll(outside)];
    expect(new Set(links.map((m) => m[2]))).toEqual(new Set(["https://confirm.example/a/h2"]));
    for (const m of links) expect(`${m[1] ?? ""}${m[3] ?? ""}`).toContain('target="_blank" rel="noopener noreferrer"');
    const attributes = html.replace(outside, "").match(/\s[a-z-]+="[^"]*"/gi) ?? [];
    for (const attribute of attributes) expect(attribute).not.toMatch(/https?:|\/\/[a-z0-9-]+\.[a-z]/i);
    expect(html).not.toMatch(/<(img|iframe|object|embed|link(?![^>]*href="\/app\.css")|script(?![^>]*src="\/app\.js"))\b/i);
    expect(html).not.toMatch(/<style|style=|<script>|<script(?![^>]*\ssrc=)|\son[a-z]+=/i);
    expect((await call(url, "/app.js")).body).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it.each(["evil.example", "evil.example:80", "127.0.0.1", "127.0.0.1:1", "localhost.evil.example"])(
    "a foreign Host %j is 421",
    async (host) => {
      const { url } = await start();
      expect((await call(url, "/entries.json", { host })).status).toBe(421);
    },
  );

  it("a request with no Host header is refused (Node answers 400 before the handler)", async () => {
    const { url } = await start();
    const reply = await call(url, "/entries.json", { host: null });
    expect(reply.status).toBe(400);
    expect(reply.body).not.toContain("seq");
  });

  it("localhost:<port> is an accepted Host", async () => {
    const { url } = await start();
    expect((await call(url, "/", { host: `localhost:${new URL(url).port}` })).status).toBe(200);
  });
});

describe("data dir", () => {
  it("refuses a group- or world-readable data dir", async () => {
    chmodSync(dir, 0o755);
    await expect(startPanel(dir, { port: 0 })).rejects.toThrow(/data directory .* readable by other users \(mode 0755\)/);
  });

  it("refuses a readable file in the data dir", async () => {
    chmodSync(join(dir, "audit.jsonl"), 0o644);
    await expect(startPanel(dir, { port: 0 })).rejects.toThrow(/audit\.jsonl is readable by other users/);
  });

  it("refuses a missing data dir", async () => {
    await expect(startPanel(join(dir, "nope"), { port: 0 })).rejects.toThrow(/does not exist/);
  });
});

describe("entries.json", () => {
  const read = async () => {
    const { url } = await start();
    const reply = await call(url, "/entries.json");
    expect(reply.headers["content-type"]).toMatch(/^application\/json/);
    return JSON.parse(reply.body) as { chain: unknown; entries: { seq: number }[]; view: View };
  };

  it("reflects the fixture chain", async () => {
    const data = await read();
    expect(data.chain).toEqual({ ok: true });
    expect(data.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(data.view.rows.map((r) => [r.seq, r.kind, r.endpoint, r.fields, r.blocked, r.note])).toEqual([
      [0, "disclosure", "/v1/offers/search", ["category", "zip"], ["name"], ""],
      [1, "receipt", "", [], [], "for #0"],
      [7, "block", "/v1/carts", [], ["postal_address"], "identity"],
    ]);
    expect(data.view.pending.map((p) => [p.handle, p.approvalUrl])).toEqual([["h2", "https://confirm.example/a/h2"]]);
    expect(data.view.pin?.fingerprint).toBe("AAAA-1111");
    expect(data.view.flags.map((f) => f.fingerprint)).toEqual(["BBBB-2222"]);
  });

  it("a tampered chain shows the broken seq", async () => {
    const log = join(dir, "audit.jsonl");
    writeFileSync(log, readFileSync(log, "utf8").replace('"zip"', '"ssn"'));
    const data = await read();
    expect(data.chain).toMatchObject({ ok: false, brokenSeq: 0 });
    expect(data.view.chain).toEqual(data.chain);
  });

  it("a torn last line shows as broken and unreadable", async () => {
    const log = join(dir, "audit.jsonl");
    writeFileSync(log, readFileSync(log, "utf8") + '{"seq":8');
    const data = await read();
    expect(data.chain).toMatchObject({ ok: false, brokenSeq: 8 });
    expect(data.view.unreadable).toEqual([8]);
  });

  it("a data dir with no log yet is an empty valid chain", async () => {
    const empty = join(await fsp.mkdtemp(join(tmpdir(), "panel-")), "data");
    mkdirSync(empty, { mode: 0o700 });
    panel = await startPanel(empty, { port: 0 });
    const data = JSON.parse((await call(panel.url, "/entries.json")).body) as { view: View };
    expect(data.view).toMatchObject({ chain: { ok: true }, rows: [], pending: [], pin: null, flags: [] });
  });
});

describe("buildView", () => {
  const entry = (seq: number, kind: string, body: unknown) => ({ seq, prev: "", ts: "t", kind, body, hash: "" });

  it("a flag for the fingerprint later accepted as the pin is no longer shown", () => {
    const view = buildView([
      entry(0, "approver_pin", { fingerprint: "A" }),
      entry(1, "approver_flag", { fingerprint: "B" }),
      entry(2, "approver_pin", { fingerprint: "B" }),
    ]);
    expect(view.pin?.fingerprint).toBe("B");
    expect(view.flags).toEqual([]);
  });

  it("labels a disclosure no entry answers as `intent log` does, never as sent; one that never left as not sent", () => {
    const view = buildView([
      entry(0, "disclosure", { endpoint: "searchCatalog", fields: ["zip"] }),
      entry(1, "receipt", { disclosure_seq: 0 }),
      entry(2, "disclosure", { endpoint: "searchCatalog", fields: ["zip"] }),
      entry(3, "disclosure", { endpoint: "getMeta", fields: [] }),
      entry(4, "unacknowledged", { disclosure_seq: 3, reason: "CloudNetworkError: not sent (connection refused)" }),
    ]);
    expect(view.rows.filter((r) => r.kind === "disclosure").map((r) => [r.seq, r.note])).toEqual([
      [0, ""],
      [2, "logged, maybe sent; no answer recorded"],
      [3, "logged, not sent: no connection was made"],
    ]);
  });

  it("lists entries with unexpected bodies instead of hiding them", () => {
    const view = buildView([entry(0, "disclosure", "not an object"), entry(1, "block", { fields: [1, "x"] })]);
    expect(view.rows.map((r) => [r.endpoint, r.fields])).toEqual([
      ["", []],
      ["", ["x"]],
    ]);
  });
});

describe("the command the page names", () => {
  it("serves the approver accept command for this install, as the CLI passes it in, and the page prints it", async () => {
    panel = await startPanel(dir, { port: 0, intent: "npx -y intent-gateway@next" });
    const data = JSON.parse((await call(panel.url, "/entries.json")).body) as { intent: string };
    expect(data.intent).toBe("npx -y intent-gateway@next");
    const html = (await call(panel.url, "/")).body;
    expect(html).toContain('Accept a passkey only with <code class="cmd">npx -y intent-gateway@next approver accept</code> at a terminal');
    expect(html).toContain('<code class="cmd">npx -y intent-gateway@next log -v</code>');
  });

  it("defaults to intent when no command is passed in", async () => {
    const { url } = await start();
    expect((JSON.parse((await call(url, "/entries.json")).body) as { intent: string }).intent).toBe("intent");
  });

  it("app.js hard-codes no command: every hint takes the passed-in one", async () => {
    const { url } = await start();
    expect((await call(url, "/app.js")).body).not.toMatch(/intent (approver|verify|log|panel|serve|demo)/);
  });
});

describe("the page", () => {
  const verifyResult = { ok: true, head: { seq: 7, hash: "x" }, checks: [{ name: "chain", ok: true, details: ["8 entries, every hash links"] }] };

  it("runs verify once per chain head and again when the chain grows", async () => {
    let runs = 0;
    panel = await startPanel(dir, {
      port: 0,
      verify: () => {
        runs += 1;
        return Promise.resolve(verifyResult);
      },
    });
    expect((await call(panel.url, "/")).body).toContain("Every check passed");
    await call(panel.url, "/");
    expect(runs).toBe(1);
    const store = await openStore(dir, { fs: fast });
    await store.append("approval_pending", { handle: "h3", approval_url: "https://confirm.example/a/h3" });
    await store.close();
    await call(panel.url, "/");
    expect(runs).toBe(2);
  });

  it("still serves the page when the policy cannot be read or verify fails, and says so", async () => {
    panel = await startPanel(dir, {
      port: 0,
      policy: () => Promise.reject(new Error("POLICY_LOOSENS")),
      verify: () => Promise.reject(new Error("boom")),
    });
    const reply = await call(panel.url, "/");
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("the active policy could not be read: POLICY_LOOSENS");
    expect(reply.body).toContain("Not run here.");
  });

  it("shows REAL unless told or the chain says demo", async () => {
    const { url } = await start();
    expect((await call(url, "/")).body).toContain('<span class="pill pill-real">REAL</span>');
    await panel?.close();
    panel = await startPanel(dir, { port: 0, mode: "demo" });
    expect((await call(panel.url, "/")).body).toContain('<span class="pill">DEMO</span>');
  });

  it("an unchanged chain gives the same region versions, so a refresh replaces nothing but the clock", async () => {
    let now = Date.parse("2026-10-16T10:00:00Z");
    panel = await startPanel(dir, { port: 0, now: () => (now += 5000) });
    const versions = (html: string): Record<string, string> =>
      Object.fromEntries([...html.matchAll(/data-live="([^"]+)" data-v="([^"]+)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]));
    const a = versions((await call(panel.url, "/")).body);
    const b = versions((await call(panel.url, "/")).body);
    expect(Object.keys(a).filter((k) => a[k] !== b[k])).toEqual(["meta"]);
  });
});

// The grid of `.app` as app.css lays it out, read from the served page and stylesheet: which direct children are
// grid items, and the column and row each one takes. A small reader for the panel's own markup and flat CSS, no DOM.
describe("the layout", () => {
  const VOID = new Set(["input", "br", "img", "meta", "link", "hr", "source", "wbr"]);

  /** The direct children of `<div class="app">`, as the selector app.css places each one by. */
  function appChildren(html: string): string[] {
    const start = html.indexOf('<div class="app">') + '<div class="app">'.length;
    const out: string[] = [];
    let depth = 0;
    for (const m of html.slice(start).matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/g)) {
      const [, close, tag = "", attrs = ""] = m;
      if (close === "/") {
        if (depth === 0) break;
        depth -= 1;
        continue;
      }
      if (depth === 0) {
        const cls = /class="([^"]*)"/.exec(attrs)?.[1]?.split(" ")[0];
        out.push(tag === "main" ? "main" : tag === "nav" ? ".nav" : cls === "live" ? ".app>.live" : `.${cls ?? tag}`);
      }
      if (!VOID.has(tag) && !attrs.endsWith("/")) depth += 1;
    }
    return out;
  }

  /** The value app.css gives `prop` for `selector`, the last rule winning; `wide` drops the @media blocks. */
  function decl(css: string, wide: boolean, selector: string, prop: string): string | undefined {
    let flat = "";
    for (let i = 0; i < css.length; ) {
      if (css.startsWith("@media", i)) {
        const open = css.indexOf("{", i);
        let depth = 1;
        let j = open + 1;
        for (; depth > 0; j += 1) depth += css[j] === "{" ? 1 : css[j] === "}" ? -1 : 0;
        if (!wide && css.slice(i, open).includes("max-width:768px")) flat += css.slice(open + 1, j - 1);
        i = j;
      } else flat += css.charAt(i++);
    }
    let value: string | undefined;
    for (const [, sels = "", body = ""] of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!sels.split(",").some((s) => s.trim() === selector)) continue;
      const v = new RegExp(`(?:^|;)\\s*${prop}:([^;]+)`).exec(body)?.[1];
      if (v !== undefined) value = v.trim();
    }
    return value;
  }

  for (const [state, paused] of [["the Pause button", false], ["the paused banner", true]] as const) {
    it(`with ${state}, the brand bar and the pause region span the top and nav and main sit side by side under them`, async () => {
      if (paused) {
        const store = await openStore(dir, { fs: fast });
        await store.append("pause", { from: "panel" });
        await store.close();
      }
      panel = await startPanel(dir, { port: 0, pause: () => Promise.resolve() });
      const page = (await call(panel.url, "/")).body;
      const css = (await call(panel.url, "/app.css")).body;
      expect(page).toContain(paused ? 'class="pause-banner"' : 'class="pause-bar"');
      const children = appChildren(page);
      expect(children).toEqual([".bar", ".app>.live", ".nav", "main"]);
      for (const wide of [true, false]) {
        const row = (sel: string) => decl(css, wide, sel, "grid-row");
        const rows = decl(css, wide, ".app", "grid-template-rows")?.split(/\s+/) ?? [];
        // Each spanning child has its own row, in page order; nav and main follow, beside each other only when wide.
        for (const [i, sel] of [".bar", ".app>.live"].entries()) {
          expect([sel, decl(css, wide, sel, "grid-column")]).toEqual([sel, "1/-1"]);
          expect([sel, row(sel)]).toEqual([sel, String(i + 1)]);
        }
        expect([row(".nav"), row("main")]).toEqual(wide ? ["3", "3"] : ["3", "4"]);
        expect(rows).toEqual(wide ? ["auto", "auto", "1fr"] : ["auto", "auto", "auto", "1fr"]);
      }
    });
  }

  it("narrow, the tabs wrap instead of scrolling out of sight; a heading app.js focuses gets no focus box", async () => {
    panel = await startPanel(dir, { port: 0 });
    const css = (await call(panel.url, "/app.css")).body;
    expect(decl(css, false, ".nav ul", "flex-wrap")).toBe("wrap");
    expect(decl(css, false, ".nav ul", "overflow-x")).toBeUndefined();
    // The outline rule leaves out tabindex="-1", the headings and main that only app.js or the skip link focus.
    expect(css).not.toContain("[tabindex]:focus-visible");
    expect(decl(css, true, '[tabindex="-1"]:focus', "outline")).toBe("none");
  });
});

// app.js refreshes a live region by swapping it for the same region in the freshly served page, so a region missing
// from either page would never appear or never go. A pause or resume made at the CLI while the panel is open must
// still show: every region is in every page, and the pause region holds the banner exactly while paused.
describe("the live regions", () => {
  const ids = (html: string): string[] => [...html.matchAll(/<div class="live" data-live="([^"]+)" data-v="[^"]+">/g)].map((m) => m[1] ?? "");
  const version = (html: string): string | undefined => /data-live="pause" data-v="([^"]+)"/.exec(html)?.[1];

  /** The pause region's content: everything between its opening tag and the nav, less the region's closing tag. */
  function pauseRegion(html: string): string {
    const start = /<div class="live" data-live="pause" data-v="[^"]+">/.exec(html);
    if (start === null) throw new Error("no pause region");
    const from = start.index + start[0].length;
    return html.slice(from, html.lastIndexOf("</div>", html.indexOf('<nav class="nav"', from)));
  }

  for (const [run, pause] of [
    ["without a pause token", undefined],
    ["with the Pause button", () => Promise.resolve()],
  ] as const) {
    it(`${run}, a CLI pause and resume while the panel is open add and remove the banner, and no region comes or goes`, async () => {
      panel = await startPanel(dir, pause === undefined ? { port: 0 } : { port: 0, pause });
      const before = (await call(panel.url, "/")).body;
      expect(pauseRegion(before)).not.toContain("pause-banner");
      expect(pauseRegion(before) === "").toBe(pause === undefined);

      const store = await openStore(dir, { fs: fast });
      await store.append("pause", { from: "cli" });
      const paused = (await call(panel.url, "/")).body;
      expect(pauseRegion(paused)).toMatch(/^<div class="pause-banner"[^>]*><strong>Paused since /);

      await store.append("resume", { from: "cli", confirmed: false, pending: "next submit" });
      await store.close();
      const resumed = (await call(panel.url, "/")).body;
      expect(pauseRegion(resumed)).toBe(pauseRegion(before));

      expect(ids(before)).toContain("pause");
      expect(ids(paused)).toEqual(ids(before));
      expect(ids(resumed)).toEqual(ids(before));
      // The version follows the content, so app.js swaps the region in at the pause and again at the resume.
      expect(version(paused)).not.toBe(version(before));
      expect(version(resumed)).toBe(version(before));
    });
  }
});
