// The text `intent verify` prints. Pure.
import type { Report } from "./verify.ts";

/** One line per check and detail, then the head seq and hash, then the verdict. */
export function formatReport(report: Report): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    // The self-check's lines come from supplychain and already start with "self-check:".
    if (check.name === "self-check") {
      lines.push(...check.details);
      continue;
    }
    lines.push(`${check.name}: ${check.ok ? "ok" : "FAILED"}`);
    for (const detail of check.details) lines.push(`  ${detail}`);
  }
  lines.push(`last entry: #${String(report.head.seq)}, hash ${report.head.hash}`);
  lines.push(`  ${report.headNote ?? "Compare this hash with a copy of the log taken earlier, or with your receipts."}`);
  lines.push(report.exitCode === 2 ? "verify: usage error" : `verify: ${report.ok ? "ok" : "FAILED"}`);
  return lines.join("\n") + "\n";
}
