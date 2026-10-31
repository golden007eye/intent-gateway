// app.js's live refresh, run in a VM over a small fake of the few DOM calls it makes. A refresh swaps the content
// of each changed region and keeps the region element, so a status region announces it; a reply that lacks a region
// the open page has (a cut-off body, an error page, another process on the port) changes nothing and marks the page
// stale, so a paused panel never loses its banner without saying it is not refreshing. The script is the one a
// panel serves at /app.js. It lives in test/ because src/ may not run code (no node:vm there).
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { startPanel } from "../src/panel/index.ts";
import { openStore } from "../src/store/index.ts";

let APP_JS = "";

beforeAll(async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "panel-refresh-")), "data");
  const store = await openStore(dir);
  await store.append("session", { id: "s" });
  await store.close();
  const panel = await startPanel(dir, { port: 0 });
  try {
    const { port } = new URL(panel.url);
    APP_JS = await new Promise<string>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/app.js", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => {
          resolve(body);
        });
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await panel.close();
  }
  expect(APP_JS).toContain("function refresh()");
});

interface Node {
  html: string;
}

/** A live region: its id and version, and its content as opaque child nodes. */
class Region {
  readonly attrs: Map<string, string>;
  childNodes: Node[];
  focused = 0;
  constructor(id: string, v: string, html: string) {
    this.attrs = new Map([["data-live", id], ["data-v", v]]);
    this.childNodes = [{ html }];
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  /** Only its own current children: a node swapped out is no longer inside, as in a real DOM. */
  contains(node: unknown): boolean {
    return this.childNodes.includes(node as Node);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  focus(): void {
    this.focused += 1;
  }
  querySelectorAll(): Region[] {
    return [];
  }
  replaceChildren(...nodes: Node[]): void {
    this.childNodes = nodes;
  }
  get html(): string {
    return this.childNodes.map((n) => n.html).join("");
  }
}

/** The regions of a page written as `<div data-live="id" data-v="v">text</div>` rows. */
function regions(html: string): Region[] {
  return [...html.matchAll(/data-live="([^"]+)" data-v="([^"]*)">([^<]*)</g)].map((m) => new Region(m[1] ?? "", m[2] ?? "", m[3] ?? ""));
}

function lookup(list: Region[]) {
  return {
    querySelectorAll: (sel: string) => (sel === "[data-live]" ? list : []),
    querySelector: (sel: string) => list.find((r) => sel === `[data-live="${r.getAttribute("data-live") ?? ""}"]`) ?? null,
  };
}

/** Loads app.js over `page`; `tick()` runs one refresh against `reply` and waits for it to settle. */
function load(page: string) {
  const onPage = regions(page);
  const classes = new Set<string>();
  let reply: { ok: boolean; status: number; body: string } = { ok: true, status: 200, body: page };
  const hooks: { refresh?: () => void; ready?: () => void } = {};
  const note = { textContent: "" };
  const document = {
    hidden: false,
    title: "panel",
    activeElement: null as unknown,
    body: {
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
        contains: (c: string) => classes.has(c),
      },
    },
    ...lookup(onPage),
    getElementById: (id: string) => (id === "stale-note" ? note : null),
    importNode: (n: Node) => ({ ...n }),
    addEventListener: (type: string, fn: () => void) => {
      if (type === "DOMContentLoaded") hooks.ready = fn;
    },
  };
  runInNewContext(APP_JS, {
    document,
    location: { hash: "#/overview" },
    window: { addEventListener: () => undefined, scrollTo: () => undefined },
    history: { replaceState: () => undefined },
    URLSearchParams,
    setInterval: (fn: () => void) => {
      hooks.refresh = fn;
    },
    fetch: () => Promise.resolve({ ok: reply.ok, status: reply.status, text: () => Promise.resolve(reply.body) }),
    DOMParser: class {
      parseFromString(html: string) {
        return lookup(regions(html));
      }
    },
  });
  hooks.ready?.();
  return {
    regions: onPage,
    stale: () => classes.has("stale"),
    /** The stale notice's text, the words a screen reader reads (not CSS content). */
    note: () => note.textContent,
    focusOn: (node: unknown) => {
      document.activeElement = node;
    },
    tick: async (next: typeof reply) => {
      reply = next;
      hooks.refresh?.();
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const PAGE = `<div data-live="meta" data-v="m1">updated 10:00</div><div data-live="pause" data-v="p1">Paused since 09:58</div><div data-live="view-overview" data-v="o1">overview</div>`;

describe("the live refresh", () => {
  it("swaps the content of a changed region and keeps the region itself", async () => {
    const app = load(PAGE);
    const [meta, pause] = app.regions;
    await app.tick({ ok: true, status: 200, body: PAGE.replace('data-v="p1">Paused since 09:58', 'data-v="p2">') });
    expect(app.regions[1]).toBe(pause);
    expect([pause?.html, pause?.getAttribute("data-v")]).toEqual(["", "p2"]);
    expect([meta?.html, meta?.getAttribute("data-v")]).toEqual(["updated 10:00", "m1"]);
    expect(app.stale()).toBe(false);
  });

  it("attack: a reply that lacks a region (an error page, a cut-off body) leaves the banner and marks the page stale", async () => {
    const app = load(PAGE);
    const before = app.regions.map((r) => [r.html, r.getAttribute("data-v")]);
    for (const body of [`<h1>502 Bad Gateway</h1>`, PAGE.slice(0, PAGE.indexOf('<div data-live="view-overview"')), PAGE.replace(/data-live="pause"[^<]*</, "<")]) {
      await app.tick({ ok: true, status: 200, body });
      expect(app.regions.map((r) => [r.html, r.getAttribute("data-v")])).toEqual(before);
      expect(app.stale()).toBe(true);
      expect(app.note()).toBe("Not refreshing: the panel is not answering.");
    }
    await app.tick({ ok: true, status: 200, body: PAGE.replace('data-v="m1">updated 10:00', 'data-v="m2">updated 10:01') });
    expect(app.stale()).toBe(false);
    expect(app.note()).toBe("");
    expect(app.regions[0]?.html).toBe("updated 10:01");
    expect(app.regions[1]?.html).toBe("Paused since 09:58");
  });

  it("an error status changes nothing and marks the page stale", async () => {
    const app = load(PAGE);
    await app.tick({ ok: false, status: 500, body: "" });
    expect(app.regions[1]?.html).toBe("Paused since 09:58");
    expect(app.stale()).toBe(true);
    expect(app.note()).toBe("Not refreshing: the panel is not answering.");
  });

  it("focus inside a swapped region moves to the region when that region can take it, and only then", async () => {
    const page = PAGE.replace('data-v="p1">Paused since 09:58', 'data-v="p0">Pause purchases');
    const swapped = { ok: true, status: 200, body: PAGE.replace('data-v="m1">updated 10:00', 'data-v="m2">updated 10:01') };
    // The Pause button had focus; the refresh swaps it for the banner.
    const app = load(page);
    const pause = app.regions[1];
    pause?.setAttribute("tabindex", "-1");
    const button = { html: "Pause purchases", getAttribute: () => null, id: "" };
    pause?.replaceChildren(button);
    app.focusOn(button);
    await app.tick(swapped);
    expect([pause?.html, pause?.focused]).toEqual(["Paused since 09:58", 1]);
    // Focus elsewhere (a nav link): a pause made at the CLI does not take it.
    const other = load(page);
    other.regions[1]?.setAttribute("tabindex", "-1");
    other.focusOn({ getAttribute: () => null });
    await other.tick(swapped);
    expect(other.regions[1]?.focused).toBe(0);
    // A region that cannot take focus is never focused (meta changed while focus sat in it).
    const meta = load(page);
    const time = { html: "updated 10:00", getAttribute: () => null, id: "" };
    meta.regions[0]?.replaceChildren(time);
    meta.focusOn(time);
    await meta.tick(swapped);
    expect(meta.regions[0]?.focused).toBe(0);
  });
});
