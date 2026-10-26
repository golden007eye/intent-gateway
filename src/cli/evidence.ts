// `intent evidence <approval handle> [--out <file>]`: writes one purchase's evidence pack (ADR-0018), after checking
// it exactly as `intent verify --evidence` will, so a pack that would not verify is never written. Offline.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { INTENT } from "../config/index.ts";
import { buildEvidence, EvidenceError, packText } from "../evidence/index.ts";
import { readChain } from "../store/index.ts";
import type { PinnedRootKey } from "../trust/index.ts";
import { printable, printableLines } from "../ui/index.ts";
import { formatReport, runVerifyEvidence } from "../verify/index.ts";
import { CliError, type Io, line } from "./io.ts";

/** Handles are short tokens (`ap_…`); anything else is refused before it reaches a file name. */
const HANDLE = /^[A-Za-z0-9_-]{1,80}$/;

export async function evidence(io: Io, dataDir: string, handle: string, pinnedRootKeys: readonly PinnedRootKey[], out: string | undefined): Promise<number> {
  if (!HANDLE.test(handle)) throw new CliError(`"${printable(handle)}" is not an approval handle; ${INTENT} log shows them (ap_…)`, 2);
  let chain: unknown[];
  try {
    chain = readChain(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") throw new CliError(`no chain in ${dataDir}: the gateway has sent nothing there`);
    throw error;
  }
  let text: string;
  try {
    text = packText(buildEvidence(chain, handle, pinnedRootKeys));
  } catch (error) {
    if (error instanceof EvidenceError) throw new CliError(`${error.message}; run ${INTENT} verify`);
    throw error;
  }
  const report = runVerifyEvidence({ text, pinnedRootKeys });
  if (!report.ok) {
    io.stdout.write(printableLines(formatReport(report)));
    line(io.stderr, `intent: the evidence pack for ${handle} does not verify, so it was not written`);
    return 1;
  }
  const file = resolve(io.cwd ?? process.cwd(), out ?? `evidence-${handle}.json`);
  try {
    // Never over an existing file: an earlier pack, or anything else, stays as it was.
    await writeFile(file, text, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") throw new CliError(`${file} exists; remove it or pass --out <file>`);
    throw error;
  }
  const entries = report.checks.find((c) => c.name === "evidence pack")?.details[0] ?? "";
  line(io.stdout, `evidence: wrote ${printable(file)}`);
  line(io.stdout, `  ${entries}; last entry #${String(report.head.seq)}, hash ${report.head.hash}`);
  line(io.stdout, `  Anyone can check it offline: ${INTENT} verify --evidence ${printable(file)}`);
  return 0;
}

/** `intent verify --evidence <file>`: the pack's checks only; no data dir, no network, no install self-check. */
export async function verifyEvidenceFile(io: Io, file: string, pinnedRootKeys: readonly PinnedRootKey[]): Promise<number> {
  let text: string;
  try {
    text = await readFile(resolve(io.cwd ?? process.cwd(), file), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new CliError(`--evidence ${file}: ${code === "ENOENT" ? "no such file" : `cannot read it (${String(code)})`}`, 2);
  }
  const report = runVerifyEvidence({ text, pinnedRootKeys });
  io.stdout.write(printableLines(formatReport(report)));
  return report.exitCode;
}
