// `intent pause`, `intent resume`, `intent status`, and the pause wiring serve and the panel share (ADR-0023).
//
// The local pause is chained first and holds at once; then the pause is sent to Intent Cloud through a started gateway
// (log before send). Once Intent Cloud holds the pause, resume needs the buyer's passkey on the confirm page's /account:
// the gateway never resumes Intent Cloud itself, so `intent resume` prints that address. Until then the local pause is
// the only stop, and `intent resume` says it lifts it from this machine. Either way it clears the local pause only after
// the developer confirms at a terminal, unconfirmed until the next submit's answer. Every line says which (liftWords).
import { loadAccountKey } from "../account/index.ts";
import type { Config } from "../config/index.ts";
import { INTENT } from "../config/index.ts";
import type { Demo } from "../demo/index.ts";
import { createGateway } from "../gateway/index.ts";
import {
  type AccountKeySource,
  confirmOrigin,
  heldByCloud,
  liftWords,
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
export const HONEST_LINE = "`intent pause` stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off agent payments in the Shop app.";

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
      const transport: PauseTransport = (request, unless) => gateway.sendPause(request, unless);
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
  const lines = [
    before.paused === null ? "Paused: from now on the gateway prepares no cart and completes no purchase." : `Already paused since ${when(before.paused.since)}.`,
    HONEST_LINE,
  ];
  await sendPause(deps);
  const after = pauseState(deps.store.entries());
  lines.push(cloudLine(after), liftWords(after), `To resume: run \`${INTENT} resume\`.`);
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
  return `Intent Cloud: not acknowledged yet (${pauseReasonWords(c.reason)}). The gateway resends it while it runs.`;
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
    const account = origin === null ? "the confirm page's /account" : `${origin}/account`;
    const held = heldByCloud(state);
    line(io.stdout, `Paused since ${when(state.paused.since)}. ${liftWords(state)}`);
    if (held) line(io.stdout, `Open ${account} and resume there with your passkey.`);
    // Not acknowledged is not proof Intent Cloud never got it: if it did, the next purchase is answered paused again.
    else line(io.stdout, `If Intent Cloud received it after all, the next purchase is answered paused and pauses here again; then resume with your passkey at ${account}.`);
    if (!io.isTTY.stdin || !io.isTTY.stdout) {
      throw new CliError(
        held
          ? `${INTENT} resume needs a terminal: after resuming with your passkey, run it again in a terminal to clear the local pause`
          : `${INTENT} resume needs a terminal: run it again in a terminal to lift the pause on this machine`,
      );
    }
    const answer = await ask(io, held ? "Type \"resumed\" once you have resumed with your passkey on that page: " : "Type \"resumed\" to lift the pause on this machine: ");
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

/** `intent doctor`'s line while purchases are paused, or null when they are not. */
export function doctorPauseLine(entries: Parameters<typeof pauseState>[0]): string | null {
  const state = pauseState(entries);
  if (state.paused === null) return null;
  return `purchases: paused since ${when(state.paused.since)}. ${liftWords(state)} ${INTENT} status says more.`;
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
    `Paused since ${when(state.paused.since)}.`,
    cloudLine(state),
    liftWords(state),
    stopped.length === 0
      ? "Purchases stopped: none was open."
      : `Purchases stopped: ${stopped.map((p) => `approval ${p.handle}${p.totalMinor === null ? "" : ` ($${(p.totalMinor / 100).toFixed(2)})`}`).join(", ")}.`,
    `Refused since the pause: ${String(state.refusals)}.`,
    `To resume: ${INTENT} resume.`,
  ];
}
