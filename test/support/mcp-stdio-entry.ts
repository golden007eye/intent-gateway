// The stdio MCP server against the fake Intent Cloud, spawned by test/mcp-stdio.test.ts: `node test/support/mcp-stdio-entry.ts`.
// After the transport is up it prints a console.log line on purpose: runStdio must send it to stderr, not stdout.
// TEST KEYS ONLY.
import { runStdio } from "../../src/mcp/index.ts";
import { startTestGateway } from "./mcp-gateway.ts";

const test = await startTestGateway();
await runStdio({ gateway: test.gateway });
console.log("intent-gateway test entry: this console.log line must reach stderr");

const stop = (): void => {
  void test.close().then(() => process.exit(0));
};
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
