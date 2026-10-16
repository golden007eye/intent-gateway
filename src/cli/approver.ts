// `intent approver list | accept` (ADR-0011). accept makes a flagged passkey the approver pin, and needs a person
// at a terminal: it refuses unless stdin and stdout are both TTYs, and the person must type the fingerprint the
// panel shows. The TTY check raises the bar for an agent with shell access; it is not a guarantee (an agent that
// opens a pseudo-terminal passes it), which is why paying by hand at the merchant stays the backstop.
import { INTENT } from "../config/index.ts";
import { CredentialPublicKey } from "../contract/index.ts";
import { type Entry, openStore, verifyChain } from "../store/index.ts";
import { approverFingerprint } from "../trust/index.ts";
import { CliError, type Io, line } from "./io.ts";
import { readLog } from "./log.ts";
import { ask } from "./prompt.ts";

type Body = Record<string, unknown>;

interface Approver {
  entry: Entry;
  fingerprint: string;
}

function approvers(entries: readonly Entry[], kind: "approver_pin" | "approver_flag"): Approver[] {
  return entries
    .filter((e) => e.kind === kind)
    .map((entry) => {
      const fingerprint = (entry.body as Body | null)?.fingerprint;
      return { entry, fingerprint: typeof fingerprint === "string" ? fingerprint : "" };
    });
}

/** The chain's entries, refusing a broken chain: a pin decision must not rest on entries that do not link. */
function chainEntries(dataDir: string): Entry[] {
  const items = readLog(dataDir);
  const chain = verifyChain(items);
  if (!chain.ok) {
    throw new CliError(`the local hash chain breaks at seq ${String(chain.brokenSeq)} (${chain.reason}); run ${INTENT} verify`);
  }
  return items as Entry[];
}

/** Flags after the current pin whose fingerprint is not the pin's, latest last. */
function openFlags(entries: readonly Entry[]): { pin: Approver | undefined; flags: Approver[] } {
  const pin = approvers(entries, "approver_pin").at(-1);
  const flags = approvers(entries, "approver_flag").filter(
    (f) => f.fingerprint !== pin?.fingerprint && f.entry.seq > (pin?.entry.seq ?? -1),
  );
  return { pin, flags };
}

export function approverList(io: Io, dataDir: string): number {
  const entries = chainEntries(dataDir);
  const pins = approvers(entries, "approver_pin");
  const { flags } = openFlags(entries);
  if (pins.length === 0) {
    line(io.stdout, "no approver pin yet: the first passkey whose Approval the gateway verifies becomes the pin");
  } else {
    line(io.stdout, "approver pins (the last one is current):");
    for (const p of pins) line(io.stdout, `  #${String(p.entry.seq)} ${p.entry.ts}  ${p.fingerprint}`);
  }
  if (flags.length === 0) {
    line(io.stdout, "flagged passkeys: none");
  } else {
    line(io.stdout, "flagged passkeys (approved a purchase but are not the pin):");
    for (const f of flags) line(io.stdout, `  #${String(f.entry.seq)} ${f.entry.ts}  ${f.fingerprint}`);
    line(io.stdout, `if one is your passkey, run ${INTENT} approver accept at a terminal`);
  }
  return 0;
}

/** Lowercase, no spaces: how a typed fingerprint is compared with the computed one. */
export function normaliseFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/** Exit 2 without a terminal; 1 when there is nothing to accept or the fingerprint does not match; 0 once pinned. */
export async function approverAccept(io: Io, dataDir: string): Promise<number> {
  if (!io.isTTY.stdin || !io.isTTY.stdout) {
    throw new CliError(
      "approver accept needs a person at a terminal (stdin and stdout must be a TTY); run it yourself in an interactive terminal, not from an agent or a pipe",
      2,
    );
  }
  const { pin, flags } = openFlags(chainEntries(dataDir));
  const flag = flags.at(-1);
  if (flag === undefined) {
    line(io.stdout, `no flagged passkey to accept; ${INTENT} approver list shows the pin and its history`);
    return 1;
  }
  const body = (flag.entry.body ?? {}) as Body;
  const key = CredentialPublicKey.safeParse(body.credential_public_key);
  if (!key.success || typeof body.credential_id !== "string") {
    throw new CliError(`the approver_flag entry #${String(flag.entry.seq)} has no usable passkey public key; run ${INTENT} verify`);
  }
  const fingerprint = approverFingerprint(key.data);

  line(io.stdout, `A passkey that is not the approver pin approved a purchase (entry #${String(flag.entry.seq)}, ${flag.entry.ts}).`);
  line(io.stdout, `  flagged: ${fingerprint}`);
  line(io.stdout, `  pinned:  ${pin?.fingerprint ?? "(none)"}`);
  line(io.stdout, `Accept it only if it is your own passkey: compare it with the panel (${INTENT} panel) and your passkey manager.`);
  const typed = await ask(io, "Type the flagged fingerprint to make it the approver pin: ");
  if (typed === null || normaliseFingerprint(typed) !== normaliseFingerprint(fingerprint)) {
    line(io.stdout, "the fingerprint does not match; nothing was written");
    return 1;
  }
  const store = await openStore(dataDir);
  try {
    const entry = await store.append("approver_pin", {
      fingerprint,
      credential_id: body.credential_id,
      credential_public_key: key.data,
    });
    line(io.stdout, `pinned ${fingerprint} (entry #${String(entry.seq)}); Approvals from this passkey are now accepted`);
  } finally {
    await store.close();
  }
  return 0;
}
