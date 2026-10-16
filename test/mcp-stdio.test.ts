// The stdio transport as `npx intent-gateway` runs it, in a real child process (ADR-0005, AC-R2): an SDK client
// lists exactly the three tools, and every byte on stdout is JSON-RPC, while logs (including a console.log made after
// the transport started) go to stderr.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { SHOES } from "./support/mcp-gateway.ts";

const ENTRY = join(import.meta.dirname, "support/mcp-stdio-entry.ts");
const SUMMARY_END = /\n\nSent: .+ \/ Blocked: .+$/s;

describe("runStdio", () => {
  it("an SDK client over stdio lists exactly the three tools", { timeout: 30_000 }, async () => {
    const client = new Client({ name: "stdio-test", version: "0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], stderr: "pipe" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["create_cart", "find_offers", "get_approval_status"]);
    } finally {
      await client.close();
    }
  });

  it("stdout carries only JSON-RPC; the logs go to stderr", { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const stdoutLines: string[] = [];
    const responses = new Map<number, Record<string, unknown>>();
    const waiters = new Map<number, (message: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      stdoutLines.push(line);
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === "number") {
        responses.set(message.id, message);
        waiters.get(message.id)?.(message);
      }
    });
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };
    const request = (id: number, method: string, params: object): Promise<Record<string, unknown>> => {
      const answered = new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve));
      send({ id, method, params });
      return answered;
    };

    try {
      await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } });
      send({ method: "notifications/initialized" });
      await request(2, "tools/list", {});
      const found = await request(3, "tools/call", { name: "find_offers", arguments: SHOES });
      const result = found.result as { content: { type: string; text: string }[] };
      expect(result.content.at(-1)?.text).toMatch(SUMMARY_END);
      // A log line written while serving: the gateway's own warnings and console.log both land on stderr.
      expect(stderr).toContain("this console.log line must reach stderr");
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }

    expect(stdoutLines.length).toBeGreaterThanOrEqual(3);
    for (const line of stdoutLines) {
      const message = JSON.parse(line) as Record<string, unknown>;
      expect(message.jsonrpc).toBe("2.0");
      expect("result" in message || "error" in message || "method" in message).toBe(true);
    }
    expect(responses.get(1)?.result).toMatchObject({ serverInfo: { name: "intent-gateway" } });
    expect(stdoutLines.join("\n")).not.toContain("console.log line");
  });
});
