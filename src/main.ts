#!/usr/bin/env node
// The `intent` and `intent-gateway` executables. Everything else lives in src/cli; this file only binds the process.
// The Node check runs first and the CLI loads only after it, so an unsupported Node gets one line, not a stack trace.
import { realpathSync } from "node:fs";
import { nodeSupported, unsupportedNodeLine } from "./runtime/index.ts";

const executable = process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename;
if (executable && !nodeSupported(process.versions.node)) {
  // exitCode, not exit(): stderr may be an asynchronous pipe, and the line must get out.
  process.stderr.write(`${unsupportedNodeLine(process.versions.node)}\n`);
  process.exitCode = 1;
} else if (executable) {
  const { main } = await import("./cli/index.ts");
  const outcome = await main(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY },
    ...(process.stdout.isTTY ? { columns: process.stdout.columns } : {}),
  });
  process.exitCode = outcome.code;
  const { stop } = outcome;
  if (stop !== undefined) {
    const end = (): void => {
      void stop().finally(() => process.exit());
    };
    process.once("SIGINT", end);
    process.once("SIGTERM", end);
  }
}
