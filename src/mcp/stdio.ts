// MCP over stdin and stdout, the way `npx intent-gateway` runs (ADR-0005). stdout carries only JSON-RPC: a stray
// line there breaks the agent's connection, so console output is moved to stderr while the transport runs.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Gateway } from "../gateway/index.ts";
import { registerTools } from "./tools.ts";
import { SERVER_INFO } from "./info.ts";

export interface StdioOptions {
  /** A started gateway (call gateway.start() first). */
  gateway: Gateway;
  /** A line put first in every tool result (demo mode's banner). */
  banner?: string;
}

export interface McpHandle {
  close(): Promise<void>;
}

export async function runStdio(options: StdioOptions): Promise<McpHandle> {
  // Anything a dependency or a later change prints with console.log/info/debug goes to stderr, never stdout.
  const toStderr = (...args: unknown[]): void => {
    console.error(...args);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const server = new McpServer(SERVER_INFO);
  registerTools(server, options.gateway, options.banner === undefined ? {} : { banner: options.banner });
  await server.connect(new StdioServerTransport());
  return { close: () => server.close() };
}
