// Small terminal helpers: one line of input, and a line diff for showing a policy change before it is written.
import { createInterface } from "node:readline";
import type { Io } from "./io.ts";

/** Writes `question` to stdout and resolves with the next line of stdin, or null if stdin ends first. */
export function ask(io: Io, question: string): Promise<string | null> {
  io.stdout.write(question);
  return new Promise((resolve) => {
    const reader = createInterface({ input: io.stdin, terminal: false });
    let answer: string | null = null;
    reader.once("line", (text) => {
      answer = text;
      reader.close();
    });
    reader.once("close", () => {
      resolve(answer);
    });
  });
}

/** A line diff of `before` → `after`: every line, prefixed "  " (kept), "- " (removed) or "+ " (added). */
export function diffLines(before: string, after: string): string[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // Longest common subsequence table, from the end; policy files are a few dozen lines.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i++] ?? ""}`);
      j++;
    } else if (i < a.length && (j === b.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      out.push(`- ${a[i++] ?? ""}`);
    } else {
      out.push(`+ ${b[j++] ?? ""}`);
    }
  }
  return out;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}
