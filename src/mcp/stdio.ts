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

/** The JSON-RPC error code the gateway answers with when it could not start (an implementation-defined server error). */
export const START_FAILED_CODE = -32000;

/**
 * When the gateway could not start but an MCP client launched it over stdio, the client would otherwise see only a
 * closed pipe. This answers every request (initialize first) with a JSON-RPC error whose message is `message`, so
 * the agent sees the reason and the next step, then resolves once initialize was answered or stdin ended.
 */
export async function answerStdioWithError(
  message: string,
  streams: { stdin: NodeJS.ReadableStream; stdout: { write(text: string): unknown } },
): Promise<void> {
  const transport = new StdioServerTransport(streams.stdin as NodeJS.ReadStream, streams.stdout as unknown as NodeJS.WriteStream);
  await new Promise<void>((resolve) => {
    const done = (): void => {
      streams.stdin.off("end", done);
      void transport.close().finally(resolve);
    };
    streams.stdin.once("end", done);
    transport.onmessage = (msg) => {
      if (!("id" in msg) || !("method" in msg)) return;
      void transport.send({ jsonrpc: "2.0", id: msg.id, error: { code: START_FAILED_CODE, message } }).then(() => {
        if (msg.method === "initialize") done();
      });
    };
    void transport.start();
  });
}
