// Smoke test of a built Docker image (G24; AC-R2, ADR-0005), run by CI's package job and by hand:
//   node test/image-smoke.ts <image> [--mcp-port 8787]
// It needs Docker and runs these containers, removing each (and its volume) afterwards:
// No step reaches the real Intent Cloud host: steps 1-2 use a fake on the host, 5-6 make the staging host unreachable.
// 1. No configuration beyond a mounted policy file, against a fake Intent Cloud on the host (host network, with its
//    test root key mounted): the entrypoint makes a 43-character token in /data/http-token (0600,
//    owned by uid 1000) and prints it once; MCP `initialize` on /mcp works with it and gets 401 without it or with
//    a wrong one; the healthcheck turns healthy without the token; after a restart the token is reused and not
//    printed again.
// 2. No policy file at all: the bundled default policy applies and `initialize` works.
// 3. A bind-mounted data dir owned by another user: the entrypoint refuses with the --user fix.
// 4. The demo exactly as documented: `-p 127.0.0.1:<mcp>:8787 -p 127.0.0.1:8788:8788 -e INTENT_DEMO=1`, then
//    find_offers → create_cart → Approve (a POST from the host to the mapped confirm page) → approved, and
//    `docker exec … intent verify --demo` passes.
// 5. The first run as documented but without INTENT_DEMO, with the staging host refusing (--add-host to the
//    container itself): the container exits 1 with no connect line, a plain line that the host cannot be reached
//    and nothing was sent, and a hint to re-run it with -e INTENT_DEMO=1 (not `docker exec`, it has exited); the
//    next start that serves, on the same volume, prints the token it made.
// 6. With no network at all (--network none): the same line, naming the DNS failure.
// TEST KEYS ONLY. Not part of the npm package or the image.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startFakeCloud } from "../src/cloud-fake/index.ts";
import { DEMO_BANNER } from "../src/demo/index.ts";

const imageArg = process.argv[2];
if (imageArg === undefined || imageArg.startsWith("-")) {
  process.stderr.write("usage: node test/image-smoke.ts <image> [--mcp-port 8787]\n");
  process.exit(2);
}
const image: string = imageArg;
const portArg = process.argv.indexOf("--mcp-port");
const mcpPort = portArg === -1 ? 8787 : Number(process.argv[portArg + 1]);
const POLICY = "version: 1\napproval: passkey\n";
const TOKEN_LINE = /^ {2}claude mcp add intent --transport http http:\/\/127\.0\.0\.1:8787\/mcp --header "Authorization: Bearer ([A-Za-z0-9_-]{43})"$/m;

const containers: string[] = [];
const outcome = { failed: false };

function check(ok: boolean, what: string, detail = ""): void {
  process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail !== "" ? `\n      ${detail}` : ""}\n`);
  if (!ok) outcome.failed = true;
}

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function logs(id: string): string {
  const r = spawnSync("docker", ["logs", id], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
}

function run(args: string[]): string {
  const id = docker("run", "-d", ...args).trim();
  containers.push(id);
  return id;
}

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function initialize(url: string, auth: string | null): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (auth !== null) headers.authorization = auth;
  const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "image-smoke", version: "0" } } };
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 0, body: "" };
  }
}

function tmpFile(name: string, text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "image-smoke-")), name);
  writeFileSync(path, text, { mode: 0o644 });
  return path;
}

async function tokenAndPolicy(): Promise<void> {
  const cloud = await startFakeCloud({});
  try {
    const keys = tmpFile("keys.json", JSON.stringify({ rootKeys: [cloud.keys.rootPin] }));
    const policy = tmpFile("policy.yaml", POLICY);
    const port = String(mcpPort + 10);
    const id = run([
      "--network", "host",
      "-e", `INTENT_CLOUD_URL=${cloud.url}`,
      "-e", `INTENT_HTTP_PORT=${port}`,
      "-v", `${policy}:/data/policy.yaml:ro`,
      "-v", `${keys}:/keys.json:ro`,
      image, "--trust-keys", "/keys.json",
    ]);
    const url = `http://127.0.0.1:${port}/mcp`;
    const token = await until("the token line", () => TOKEN_LINE.exec(logs(id))?.[1]);
    check(token.length === 43, "first start prints a 43-character token once, in the claude mcp add line");
    check(logs(id).includes("so it is also kept in this container's log (docker logs)") && logs(id).includes("set INTENT_QUIET_TOKEN=1 to never print it"), "the first start says the token stays in the container log");
    await until("the server", async () => ((await initialize(url, null)).status === 0 ? undefined : true));
    const ok = await initialize(url, `Bearer ${token}`);
    check(ok.status === 200 && ok.body.includes('"name":"intent-gateway"'), "initialize with the token: 200 from intent-gateway", ok.body);
    check((await initialize(url, null)).status === 401, "initialize without a token: 401");
    check((await initialize(url, `Bearer ${"x".repeat(43)}`)).status === 401, "initialize with a wrong token: 401");
    const file = docker("exec", id, "stat", "-c", "%a %u %s", "/data/http-token").trim();
    check(file === "600 1000 44", "/data/http-token is 0600, owned by uid 1000, the token and a newline", file);
    check(docker("exec", id, "cat", "/data/http-token").trim() === token, "docker exec <c> cat /data/http-token gives the token");
    const log = spawnSync("docker", ["exec", id, "intent", "log"], { encoding: "utf8" });
    check(log.status === 0 && log.stdout.includes("every hash links"), "docker exec <c> intent log reads the chain with no token", log.stdout + log.stderr);
    check(!logs(id).includes("bundled"), "the mounted policy file is used, not a bundled default");
    const health = await until("the healthcheck", () => {
      const s = docker("inspect", "-f", "{{.State.Health.Status}}", id).trim();
      return s === "starting" ? undefined : s;
    }, 60_000);
    check(health === "healthy", "the healthcheck passes without the token", health);

    docker("restart", id);
    await until("the second start", () => (logs(id).includes("using the HTTP token in /data/http-token") ? true : undefined));
    await until("the server after restart", async () => ((await initialize(url, null)).status === 401 ? true : undefined));
    const all = logs(id);
    check(all.split(token).length - 1 === 1, "a restart reuses the token and does not print it again");
    // --network host: HOSTNAME is the host's name, not the container id, so the commands keep <container>.
    check(all.includes("read it with: docker exec <container> cat /data/http-token"), "a restart says how to read the token");
    check(
      all.includes('  claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer $(docker exec <container> cat /data/http-token)"'),
      "a restart prints the connect line again, reading the token from the container instead of printing it",
    );
    check((await initialize(url, `Bearer ${token}`)).status === 200, "initialize with the same token after a restart: 200");
  } finally {
    await cloud.close();
  }
}

async function defaultPolicy(): Promise<void> {
  const cloud = await startFakeCloud({});
  try {
    const keys = tmpFile("keys.json", JSON.stringify({ rootKeys: [cloud.keys.rootPin] }));
    const port = String(mcpPort + 11);
    const id = run(["--network", "host", "-e", `INTENT_CLOUD_URL=${cloud.url}`, "-e", `INTENT_HTTP_PORT=${port}`, "-v", `${keys}:/keys.json:ro`, image, "--trust-keys", "/keys.json"]);
    const token = await until("the token line", () => TOKEN_LINE.exec(logs(id))?.[1]);
    const url = `http://127.0.0.1:${port}/mcp`;
    const status = await until("the server", async () => {
      const s = (await initialize(url, `Bearer ${token}`)).status;
      return s === 0 ? undefined : s;
    });
    check(status === 200 && /No policy file found; using the bundled zip-only policy/.test(logs(id)), "with no policy file the bundled zip-only default applies and initialize works");
    // The commit `policy show` names is the one the image label records; a plain build (no BUILD_COMMIT) names none.
    const shown = docker("exec", id, "intent", "policy", "show");
    const revision = docker("inspect", "-f", '{{index .Config.Labels "org.opencontainers.image.revision"}}', image).trim();
    const expected = revision === "" ? "commit unknown (local build without BUILD_COMMIT)" : `built from commit ${revision}`;
    check(new RegExp(`^gateway: \\S+, ${expected.replace(/[()]/g, "\\$&")}$`, "m").test(shown), `policy show says: ${expected}`, shown);
  } finally {
    await cloud.close();
  }
}

function foreignDataDir(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "image-smoke-data-"));
  const r = spawnSync("docker", ["run", "--rm", "--user", "4242:4242", "-v", `${dir}:/data`, image], { encoding: "utf8", timeout: 60_000 });
  check(r.status === 1 && r.stderr.includes('docker run --user "$(id -u):$(id -g)"'), "a data dir owned by another uid is refused with the --user fix", r.stderr);
  return Promise.resolve();
}

function quietToken(): Promise<void> {
  const id = run(["-p", `127.0.0.1:${String(mcpPort + 20)}:8787`, "-e", "INTENT_DEMO=1", "-e", "INTENT_QUIET_TOKEN=1", image]);
  return until("the quiet start", () => (logs(id).includes("not printed: INTENT_QUIET_TOKEN=1") ? true : undefined)).then(() => {
    const token = docker("exec", id, "cat", "/data/http-token").trim();
    check(token.length === 43 && !logs(id).includes(token), "INTENT_QUIET_TOKEN=1 never prints the token");
  }).then(async () => {
    const line = `--header "Authorization: Bearer $(docker exec ${id.slice(0, 12)} cat /data/http-token)"`;
    const found = await until("the quiet connect line", () => (logs(id).includes(line) ? true : undefined)).catch(() => false);
    check(found, "INTENT_QUIET_TOKEN=1 still prints a connect line, which reads the token from this container by its id", logs(id));
  });
}

async function demo(): Promise<void> {
  const id = run(["-p", `127.0.0.1:${String(mcpPort)}:8787`, "-p", "127.0.0.1:8788:8788", "-e", "INTENT_DEMO=1", image]);
  const token = await until("the token line", () => TOKEN_LINE.exec(logs(id))?.[1]);
  const url = new URL(`http://127.0.0.1:${String(mcpPort)}/mcp`);
  await until("the demo server", async () => ((await initialize(url.href, null)).status === 401 ? true : undefined), 60_000);
  check(logs(id).includes(DEMO_BANNER), "the demo banner is in the container log");
  const short = id.slice(0, 12);
  await until("the demo next steps", () => (logs(id).includes("Re-check what was sent afterwards with:") ? true : undefined));
  check(logs(id).split("\n").filter((l) => l.includes("claude mcp add --") || l.includes("claude mcp add intent")).length === 1, "the demo log has exactly one connect line", logs(id));
  check(!logs(id).includes("<token>") && !logs(id).includes("<container>"), "the demo log has no <token> or <container> placeholder", logs(id));
  check(logs(id).includes("Add the demo gateway to Claude Code with the claude mcp add line above."), "the demo next steps point at that line");
  check(logs(id).includes(`docker exec ${short} intent verify --demo`), "the demo log names this container by its id (HOSTNAME)");
  check(logs(id).includes(`intent-gateway: serving; stop it with docker stop ${short}\n`) && !logs(id).includes("Ctrl-C"), "a detached container says docker stop, not Ctrl-C", logs(id));
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "image-smoke", version: "0" });
  await client.connect(transport as Transport);
  try {
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    };
    const offers = await call("find_offers", { category: "running-shoes", budget_usd: 200, zip: "94103" });
    const offer = /offer_handle: (\S+)/.exec(offers)?.[1];
    check(offer !== undefined, "find_offers returns offers", offers);
    const cart = await call("create_cart", { offer_handle: offer ?? "" });
    const link = /Approval link: (\S+)/.exec(cart)?.[1] ?? "";
    const handle = /approval_handle: (\S+)/.exec(cart)?.[1] ?? "";
    check(/^http:\/\/127\.0\.0\.1:8788\/confirm\/c\//.test(link), "create_cart gives an approval link on the mapped confirm port", cart);
    const page = await fetch(link);
    const html = await page.text();
    const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? "";
    check(page.status === 200 && html.includes(" with demo passkey</button>"), "the host's browser reaches the confirm page");
    check(html.includes(`docker exec ${short} cat /data/demo/approval-code`), "the confirm page says how to read the demo code from this container", html);
    const code = docker("exec", id, "cat", "/data/demo/approval-code").trim();
    check(/^[0-9]{6}$/.test(code) && logs(id).includes(`Demo code for the confirm page: ${code} `), "the demo code is in the container log and its file");
    const approve = await fetch(link, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://127.0.0.1:8788", "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ csrf, action: "approve", code }).toString(),
    });
    const approved = await approve.text();
    check(approve.status === 200, "Approve (a POST from the host) succeeds", String(approve.status));
    check(approved.split("Approved with the demo passkey").length - 1 === 1 && approved.includes("<h1>Approved</h1>"), "the result page says it was approved once", approved);
    const status = await call("get_approval_status", { approval_handle: handle });
    check(/approved/i.test(status) && status.includes("Approver passkey fingerprint:"), "get_approval_status says approved", status);
  } finally {
    await client.close();
  }
  const verify = spawnSync("docker", ["exec", id, "intent", "verify", "--demo"], { encoding: "utf8" });
  check(verify.status === 0 && /^verify: ok$/m.test(verify.stdout), "docker exec <c> intent verify --demo passes", verify.stdout + verify.stderr);
}

async function stagingUnreachable(): Promise<void> {
  const volume = `image-smoke-${String(process.pid)}`;
  volumes.push(volume);
  // The staging host's name points at the container itself, where nothing listens on 443: a refused connection,
  // whatever the real host's state, so this step never reaches the network.
  const id = run(["-p", `127.0.0.1:${String(mcpPort + 30)}:8787`, "--add-host", "staging-api.intentai.shop:127.0.0.1", "-v", `${volume}:/data`, image]);
  const exit = await until("the container to exit", () => {
    const s = docker("inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", id).trim();
    return s.startsWith("exited") ? s : undefined;
  });
  const first = logs(id);
  check(exit === "exited 1", "with the staging host unreachable and no INTENT_DEMO the container exits 1", exit);
  check(!first.includes("claude mcp add"), "a container that cannot start prints no connect line (and no token)", first);
  check(
    first.includes("intent: Intent Cloud at staging-api.intentai.shop cannot be reached (connection refused); nothing was sent. Staging may not be open yet;"),
    "it says plainly that the staging host cannot be reached and that nothing was sent",
    first,
  );
  check(first.includes(`docker rm ${id.slice(0, 12)} && docker run -d --name intent -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 -e INTENT_DEMO=1 -v intent-data:/data intent-gateway`), "the hint re-runs the container with -e INTENT_DEMO=1", first);
  const failure = first.split("\n").find((l) => l.startsWith("intent: ")) ?? "";
  check(!failure.includes("docker exec"), "the failure line names no docker exec into the exited container", failure);
  check(!/ECONNREFUSED|ENOTFOUND|getaddrinfo|\n\s+at /.test(first), "no error code and no stack in the log", first);
  const next = run(["-p", `127.0.0.1:${String(mcpPort + 30)}:8787`, "-e", "INTENT_DEMO=1", "-v", `${volume}:/data`, image]);
  const token = await until("the token line on the first start that serves", () => TOKEN_LINE.exec(logs(next))?.[1]);
  check(token === docker("exec", next, "cat", "/data/http-token").trim(), "the first start that serves prints the token made by the one that failed", logs(next));
  check(!logs(next).includes("using the HTTP token in"), "the start that prints the token does not also say how to read it from the container", logs(next));
}

function noNetwork(): Promise<void> {
  // No network at all: the host name cannot be looked up. The same plain line, with the DNS failure named.
  const r = spawnSync("docker", ["run", "--rm", "--network", "none", image], { encoding: "utf8", timeout: 90_000 });
  check(
    r.status === 1 && /intent: Intent Cloud at staging-api\.intentai\.shop cannot be reached \(DNS: [a-z ]+\); nothing was sent\. Staging may not be open yet; try everything locally: re-run the container in demo mode: docker rm /.test(r.stderr),
    "with no network the container exits 1 naming the DNS failure and the demo re-run",
    r.stderr,
  );
  return Promise.resolve();
}

const volumes: string[] = [];
try {
  for (const step of [tokenAndPolicy, defaultPolicy, foreignDataDir, quietToken, demo, stagingUnreachable, noNetwork]) {
    try {
      await step();
    } catch (error) {
      check(false, step.name, error instanceof Error ? error.message : String(error));
      for (const id of containers) process.stdout.write(`--- logs ${id.slice(0, 12)}\n${logs(id)}\n`);
    }
  }
} finally {
  for (const id of containers) spawnSync("docker", ["rm", "-f", id]);
  for (const volume of volumes) spawnSync("docker", ["volume", "rm", "-f", volume]);
}
process.stdout.write(outcome.failed ? "image-smoke: FAILED\n" : "image-smoke: ok\n");
process.exit(outcome.failed ? 1 : 0);
