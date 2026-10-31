// What the pause in effect takes to lift, in the words every surface uses (`intent pause`, `status`, `resume`,
// `doctor`, the panel banner, the agent's refusal). ADR-0023: until Intent Cloud acknowledges a pause (no account key,
// a key Intent Cloud answered it does not know yet, or no connection), the local pause is the only stop and `intent
// resume` lifts it from this machine; once Intent Cloud acknowledged it, or answered `paused` itself, only the passkey
// does. The words say what was received, never why. Pure; nothing here changes the mechanism.
import { INTENT } from "../config/index.ts";
import type { PauseState } from "./state.ts";

/**
 * Whether Intent Cloud holds the pause in effect too: it acknowledged this pause, or an answer from it said `paused`
 * (a pause from another device, a resume it did not confirm, or a cart or report it refused as paused, even after a
 * send of this pause that was not acknowledged). Then resuming needs the passkey.
 */
export function heldByCloud(state: PauseState): boolean {
  if (state.paused === null) return false;
  return state.cloud?.result === "acknowledged" || state.paused.from === "intent_cloud" || state.cloudSaidPaused;
}

/**
 * What lifts the pause. Held: "Resume needs your passkey." Not acknowledged: it holds on this machine only and can be
 * lifted here; once Intent Cloud acknowledges a pause, only the passkey lifts it.
 */
export function liftWords(state: PauseState): string {
  if (heldByCloud(state)) return "Resume needs your passkey.";
  const noKey = state.cloud?.reason === "no_account_key" ? ` This machine has no account key: \`${INTENT} init\` makes one.` : "";
  return `The pause holds on this machine only and can be lifted here: Intent Cloud has not acknowledged it.${noKey} Once Intent Cloud acknowledges a pause, resuming needs your passkey.`;
}

/** What the agent is told when the developer's pause stops a step here: what lifts it, and not to retry. */
export function pausedRefusalWords(state: PauseState): string {
  const until = heldByCloud(state) ? "they resume with their passkey" : `they lift it (\`${INTENT} resume\`)`;
  return `Not sent: the developer paused purchases through intent (\`${INTENT} pause\`). Nothing is bought until ${until}; do not retry.`;
}
