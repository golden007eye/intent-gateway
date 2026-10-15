#!/usr/bin/env node
// The `intent` command. For now it only reports its version; the CLI module replaces this later.
import { readFileSync, realpathSync } from "node:fs";

// package.json sits one level above both src/main.ts and dist/main.js.
export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(args: readonly string[]): Outcome {
  if (args.length === 1 && args[0] === "--version") return { code: 0, stdout: `${version()}\n`, stderr: "" };
  return { code: 2, stdout: "", stderr: "usage: intent --version\n" };
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
