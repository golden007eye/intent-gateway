// `intent pause`, `intent resume`, `intent status`, and the pause wiring serve and the panel share (ADR-0023).
//
// The local pause is chained first and holds at once; then the pause is sent to Intent Cloud through a started gateway
// (log before send). Resume needs the buyer's passkey on the confirm page's /account: the gateway never resumes Intent
// Cloud itself, so `intent resume` prints that address and clears the local pause only after the developer confirms at
// a terminal, unconfirmed until the next submit's answer.
import { loadAccountKey } from "../account/index.ts";
import type { Config } from "../config/index.ts";
import { INTENT } from "../config/index.ts";
import type { Demo } from "../demo/index.ts";
import { createGateway } from "../gateway/index.ts";
import {
  type AccountKeySource,
  confirmOrigin,
  pauseLocally,
  pauseReasonWords,
  type PauseSource,
  type PauseState,
  pauseState,
  type PauseTransport,
  resumeLocally,
  type SendDeps,
  sendPause,
  stoppedPurchases,
} from "../pause/index.ts";
import { openCompleterKeys } from "../signing/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { CliError, type Io, line } from "./io.ts";
import { ask } from "./prompt.ts";
import { activePolicy, cloudFor, rootKeys, startDemoFor } from "./setup.ts";

/** The line every pause output carries (answer 25): what a pause stops, and the only hard stop. */
export const HONEST_LINE = "`intent pause` stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off the budget in the Shop app.";

/**
 * The account key `intent init` makes in `dataDir` (src/account, ADR-0022). Without one the pause holds locally only,
 * which `intent log` and `intent status` say. Tests pass `io.accountKey`.
 */
export function accountKeyFor(io: Io, dataDir: string): AccountKeySource {
  return io.accountKey ?? (() => loadAccountKey(dataDir));
}

/**
 * The pause's send dependencies for one process: `connect` starts a gateway on `store` (meta and key statement, logged
 * like every call) the first time it is needed, and reuses it. `demo` is the demo Intent Cloud in demo mode.
 */
export function pauseDeps(io: Io, config: Config, store: Store, demo: Demo | null): SendDeps {
  const now = io.now ?? Date.now;
  let started: Promise<PauseTransport> | null = null;
  const connect = (): Promise<PauseTransport> => {
    started ??= (async () => {
      const baseUrl = demo?.cloudUrl ?? config.cloud.url;
      const pinnedRootKeys = demo?.trustKeys.rootKeys ?? (await rootKeys(config, { contacts: true }));
      const { policy } = await activePolicy(config.policyPath);
      const gateway = createGateway({
        cloud: (keySet) => cloudFor(io, store, baseUrl, { keySet, ...(io.now === undefined ? {} : { now: io.now }) }),
        store,
        completerKeys: openCompleterKeys(demo?.dataDir ?? config.dataDir, io.now === undefined ? {} : { now: io.now }),
        policy,
        pinnedRootKeys,
        logger: { warn: () => undefined },
        ...(demo === null ? {} : { demo: { confirmBaseUrl: demo.confirmBaseUrl } }),
        ...(io.now === undefined ? {} : { now: io.now }),
      });
      await gateway.start();
      const transport: PauseTransport = (request) => gateway.sendPause(request);
      return transport;
    })();
    // A start that failed is tried again on the next send.
    const attempt = started;
    attempt.catch(() => {
      if (started === attempt) started = null;
    });
    return attempt;
  };
  return { store, accountKey: accountKeyFor(io, demo?.dataDir ?? config.dataDir), connect, now };
}

/** The local pause, then one send to Intent Cloud; the lines say where it stands. */
export async function pauseAndSend(deps: SendDeps, from: PauseSource): Promise<string[]> {
  const before = pauseState(deps.store.entries());
  if (before.paused === null) await pauseLocally(deps.store, from);
  const lines = [before.paused === null ? "Paused: from now on the gateway refuses create_cart and complete_checkout." : `Already paused since ${when(before.paused.since)}.`, HONEST_LINE];
  await sendPause(deps);
  lines.push(cloudLine(pauseState(deps.store.entries())));
  lines.push(`Resume needs your passkey: run \`${INTENT} resume\`.`);
  return lines;
}

/** An entry's time as `2026-10-18 12:00:00 UTC`. */
function when(ts: string): string {
  const at = new Date(ts);
  return Number.isNaN(at.getTime()) ? ts : `${at.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Where the pause in effect stands at Intent Cloud, in one line. */
function cloudLine(state: PauseState): string {
  const c = state.cloud;
  if (state.paused?.from === "intent_cloud" && c === null) return "A `paused` answer was received from Intent Cloud.";
  if (c === null) return "Not sent to Intent Cloud yet.";
  if (c.result === "acknowledged") return "Intent Cloud: acknowledged the pause.";
  if (c.reason === "no_account_key") return `Not sent to Intent Cloud: ${pauseReasonWords(c.reason)}.`;
  if (c.result === "failed") return `A refusal of the pause was received from Intent Cloud (${pauseReasonWords(c.reason)}); it holds on this machine only. Run \`${INTENT} pause\` again to resend.`;
  return `Intent Cloud: not acknowledged yet (${pauseReasonWords(c.reason)}); retrying while \`${INTENT} serve\` runs. The pause holds here meanwhile.`;
}

export async function pauseCommand(io: Io, config: Config): Promise<number> {
  const demo = config.demo ? await startDemoFor(config, io) : null;
  const store = await openStore(config.dataDir);
  try {
    for (const text of await pauseAndSend(pauseDeps(io, config, store, demo), "cli")) line(io.stdout, text);
    return 0;
  } finally {
    await store.close();
    await demo?.close();
  }
}

export async function resumeCommand(io: Io, config: Config): Promise<number> {
  const store = await openStore(config.dataDir);
  try {
    const entries = store.entries();
    const state = pauseState(entries);
    if (state.paused === null) {
      line(io.stdout, state.unconfirmedResume === null ? "Not paused." : "Not paused here; the last resume is unconfirmed until the next submit.");
      return 0;
    }
    const origin = confirmOrigin(entries);
    line(io.stdout, `Paused since ${when(state.paused.since)}. Resume needs your passkey.`);
    line(io.stdout, origin === null ? "Open the confirm page's /account and resume there with your passkey." : `Open ${origin}/account and resume there with your passkey.`);
    if (!io.isTTY.stdin || !io.isTTY.stdout) {
      throw new CliError(`${INTENT} resume needs a terminal: after resuming with your passkey, run it again in a terminal to clear the local pause`);
    }
    const answer = await ask(io, "Type \"resumed\" once you have resumed with your passkey on that page: ");
    if (answer?.trim().toLowerCase() !== "resumed") {
      line(io.stdout, "Not resumed: the pause holds.");
      return 1;
    }
    if (!(await resumeLocally(store, "cli"))) {
      line(io.stdout, "Not paused any more.");
      return 0;
    }
    line(io.stdout, "Local pause cleared, unconfirmed: the next purchase checks with Intent Cloud, and if it still answers paused the gateway pauses again.");
    return 0;
  } finally {
    await store.close();
  }
}

export async function statusCommand(io: Io, config: Config): Promise<number> {
  const store = await openStore(config.dataDir);
  try {
    for (const text of statusLines(store, (io.now ?? Date.now)())) line(io.stdout, text);
    return 0;
  } finally {
    await store.close();
  }
}

/** `intent status`: the pause, as the panel banner says it. */
export function statusLines(store: Store, nowMs: number): string[] {
  const entries = store.entries();
  const state = pauseState(entries);
  if (state.paused === null) {
    return [state.unconfirmedResume === null ? "Not paused: purchases go ahead under the policy." : "Not paused: resumed, unconfirmed until the next submit."];
  }
  const stopped = stoppedPurchases(entries, nowMs);
  return [
    `Paused since ${when(state.paused.since)}. Resume needs your passkey.`,
    cloudLine(state),
    stopped.length === 0
      ? "Purchases stopped: none was open."
      : `Purchases stopped: ${stopped.map((p) => `approval ${p.handle}${p.totalMinor === null ? "" : ` ($${(p.totalMinor / 100).toFixed(2)})`}`).join(", ")}.`,
    `Refused since the pause: ${String(state.refusals)}.`,
    `To resume: ${INTENT} resume.`,
  ];
}
