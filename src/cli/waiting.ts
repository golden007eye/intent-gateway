// What a command prints while it waits, so a first run never hangs silently: on the data dir's lease, held by a
// gateway that is writing or one that stopped mid-write, and on an Intent Cloud host that took the connection but
// has not answered yet. Each says what it waits for and when the wait ends; the final message stays the caller's.
import { DEFAULT_TIMEOUT_MS } from "../disclosure/index.ts";
import type { LeaseWait } from "../store/index.ts";

/** How long a call to Intent Cloud runs before the progress line. */
export const CLOUD_NOTICE_MS = 3000;

/** The store's onWait for a command: one line naming the lock, its holder and when it frees itself. */
export function leaseNotice(say: (text: string) => void, now: () => number = Date.now): (wait: LeaseWait) => void {
  return ({ lock, holder, expiresAt }) => {
    const seconds = Math.max(1, Math.ceil((expiresAt.getTime() - now()) / 1000));
    say(
      `waiting for the data dir lock ${lock}, held by ${holder} until ${expiresAt.toISOString()}: another gateway is ` +
        `writing to this data dir, or one stopped mid-write. The lock frees itself in ${String(seconds)} s; ` +
        "if another gateway runs on this data dir, stop it or set INTENT_DATA_DIR to another folder.",
    );
  };
}

/**
 * The HTTP adapter's `slow` option for a command: once a request to Intent Cloud has gone `afterMs` without an
 * answer, says once that the command is still waiting for it, while `active()` holds (serve: only while starting).
 * The adapter's own deadline and the command's final message are unchanged.
 */
export function slowCloudNotice(
  say: (text: string) => void,
  afterMs = CLOUD_NOTICE_MS,
  active: () => boolean = () => true,
): { afterMs: number; notify: (host: string) => void } {
  let said = false;
  return {
    afterMs,
    notify: (host) => {
      if (said || !active()) return;
      said = true;
      say(`still waiting for Intent Cloud at ${host}: no answer yet (it gives up after ${String(DEFAULT_TIMEOUT_MS / 1000)} s)`);
    },
  };
}
