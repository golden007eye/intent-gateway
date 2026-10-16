// The first-run path a developer takes, against the built package: `intent demo` over stdio (as
// `claude mcp add intent -- npx -y intent-gateway demo` runs it) → find_offers → create_cart → Approve on the local
// confirm page (an HTTP POST, as the button sends) → get_approval_status approved → `intent verify --demo` exit 0.
// Called from test/build.test.ts after its build, so it never races the rebuild. TEST KEYS ONLY.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import { DEMO_BANNER } from "../src/demo/index.ts";

function env(extra: Record<string, string>): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("INTENT_")));
  return { ...base, ...extra };
}

function http(url: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: { host: u.host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

const text = (result: CallToolResult): string => result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");

export async function demoFirstRun(main: string): Promise<void> {
  const data = join(mkdtempSync(join(tmpdir(), "demo-first-run-")), "data");
  const transport = new StdioClientTransport({ command: process.execPath, args: [main, "demo"], env: env({ INTENT_DATA_DIR: data }), stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const client = new Client({ name: "demo-first-run", version: "0" });
  await client.connect(transport);
  try {
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(result.content[0]).toEqual({ type: "text", text: DEMO_BANNER });
      return text(result);
    };
    const offers = await call("find_offers", { category: "running-shoes", budget_usd: 200, zip: "94103" });
    const offer = /offer_handle: (\S+)/.exec(offers)?.[1] ?? "";
    expect(offer).not.toBe("");
    const cart = await call("create_cart", { offer_handle: offer });
    const link = /Approval link: (\S+)/.exec(cart)?.[1] ?? "";
    const handle = /approval_handle: (\S+)/.exec(cart)?.[1] ?? "";
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/confirm\/c\//);

    const page = await http(link, "GET");
    expect(page.body).toContain("Approve with demo passkey");
    const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(page.body)?.[1] ?? "";
    const form = { "content-type": "application/x-www-form-urlencoded", origin: new URL(link).origin, "sec-fetch-site": "same-origin" };
    const approved = await http(link, "POST", form, new URLSearchParams({ csrf, action: "approve" }).toString());
    expect(approved.status).toBe(200);

    expect(await call("get_approval_status", { approval_handle: handle })).toContain("Approver passkey fingerprint:");
    expect(stderr).toContain(DEMO_BANNER);
    expect(stderr).toContain("claude mcp add intent -- npx -y intent-gateway demo");
  } finally {
    await client.close();
  }

  const verify = spawnSync(process.execPath, [main, "verify", "--demo"], { env: env({ INTENT_DATA_DIR: data }), encoding: "utf8" });
  expect(verify.stdout).toMatch(/^approvals: ok$/m);
  expect(verify.stdout).toMatch(/^verify: ok\n$/m);
  expect(verify.status).toBe(0);
}
