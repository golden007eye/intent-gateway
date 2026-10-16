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
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
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
  });

  it("served assets contain no external URL and no inline script or style", async () => {
    const { url } = await start();
    for (const path of ["/", "/app.js", "/app.css"]) {
      const { body } = await call(url, path);
      expect(body).not.toMatch(/https?:\/\//i);
      expect(body).not.toMatch(/\/\/[a-z0-9-]+\.[a-z]/i);
    }
    const html = (await call(url, "/")).body;
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

  it("lists entries with unexpected bodies instead of hiding them", () => {
    const view = buildView([entry(0, "disclosure", "not an object"), entry(1, "block", { fields: [1, "x"] })]);
    expect(view.rows.map((r) => [r.endpoint, r.fields])).toEqual([
      ["", []],
      ["", ["x"]],
    ]);
  });
});
