#!/usr/bin/env node
// The `intent` and `intent-gateway` executables. Everything else lives in src/cli; this file only binds the process.
import { realpathSync } from "node:fs";
import { main } from "./cli/index.ts";

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  const outcome = await main(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY },
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
