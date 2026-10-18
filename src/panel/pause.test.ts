// The panel's only write, the Pause button (ADR-0023): POST /pause with this run's token in a header, from the panel's
// own origin. Without the token, from another origin, cross-site, or by GET, nothing happens.
import * as fsp from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../store/index.ts";
import { type Panel, startPanel } from "./index.ts";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

let dir: string;
let panel: Panel | null = null;
let pauses = 0;

beforeEach(async () => {
  dir = join(await fsp.mkdtemp(join(tmpdir(), "panel-pause-")), "data");
  const store = await openStore(dir);
  await store.append("session", { id: "s" });
  await store.close();
  pauses = 0;
});

afterEach(async () => {
  await panel?.close();
  panel = null;
});

function call(url: string, path: string, method: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const { port, hostname } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function withPause(): Promise<{ url: string; token: string; origin: string }> {
  panel = await startPanel(dir, { port: 0, pause: () => Promise.resolve(void (pauses += 1)) });
  const page = await call(panel.url, "/", "GET");
  const token = /<meta name="intent-panel-token" content="([^"]+)">/.exec(page.body)?.[1];
  if (token === undefined) throw new Error("no token in the page");
  expect(page.body).toContain("data-pause");
  return { url: panel.url, token, origin: new URL(panel.url).origin };
}

describe("the Pause button", () => {
  it("pauses with this run's token from the panel's own origin", async () => {
    const { url, token, origin } = await withPause();
    const reply = await call(url, "/pause", "POST", { "x-intent-panel-token": token, origin, "sec-fetch-site": "same-origin" });
    expect(reply.status).toBe(200);
    expect(pauses).toBe(1);
  });

  it("attack: no token, a wrong token, another origin, no origin, a cross-site fetch, or a GET has no effect", async () => {
    const { url, token, origin } = await withPause();
    const refused = [
      { origin },
      { "x-intent-panel-token": "A".repeat(token.length), origin },
      { "x-intent-panel-token": token, origin: "http://evil.example" },
      { "x-intent-panel-token": token, origin: "http://127.0.0.1:1" },
      { "x-intent-panel-token": token },
      { "x-intent-panel-token": token, origin, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of refused) expect((await call(url, "/pause", "POST", headers)).status).toBe(403);
    expect((await call(url, "/pause", "GET", { "x-intent-panel-token": token, origin })).status).toBe(404);
    expect((await call(url, "/pause?token=" + token, "GET")).status).toBe(404);
    expect(pauses).toBe(0);
  });

  it("each panel run has its own token, and a panel without a pause action has no button and takes no POST", async () => {
    const first = await withPause();
    await panel?.close();
    const second = await withPause();
    expect(second.token).not.toBe(first.token);
    await panel?.close();
    panel = await startPanel(dir, { port: 0 });
    const page = await call(panel.url, "/", "GET");
    expect(page.body).not.toContain("intent-panel-token");
    expect(page.body).not.toContain("data-pause");
    expect((await call(panel.url, "/pause", "POST", { origin: new URL(panel.url).origin })).status).toBe(405);
  });

  it("while paused the banner says since when, that resume needs the passkey, and hides the button", async () => {
    const store = await openStore(dir);
    await store.append("pause", { from: "panel" });
    await store.close();
    panel = await startPanel(dir, { port: 0, pause: () => Promise.resolve() });
    const page = await call(panel.url, "/", "GET");
    expect(page.body).toMatch(/Paused since [^<]+\. Resume needs your passkey\./);
    expect(page.body).not.toContain("data-pause");
    expect(page.body).toContain("No open purchase was waiting.");
  });
});
