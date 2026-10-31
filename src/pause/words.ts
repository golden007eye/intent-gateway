// What the pause in effect takes to lift, in the words every surface uses (`intent pause`, `status`, `resume`,
// `doctor`, the panel banner, the agent's refusal). ADR-0023: until Intent Cloud acknowledges a pause (no account key,
// a key Intent Cloud does not know yet because no purchase was approved with it, or no connection), the local pause
// is the only stop and `intent resume` lifts it from this machine; once Intent Cloud holds it, only the passkey does.
// Pure; nothing here changes the mechanism.
import { INTENT } from "../config/index.ts";
import type { PauseState } from "./state.ts";

/**
 * Whether Intent Cloud holds the pause in effect too: it acknowledged this pause, or it answered `paused` itself (a
 * pause from another device, or a resume it did not confirm). Then resuming needs the passkey.
 */
export function heldByCloud(state: PauseState): boolean {
  if (state.paused === null) return false;
  return state.cloud?.result === "acknowledged" || (state.cloud === null && state.paused.from === "intent_cloud");
}

/**
 * What lifts the pause. Held: "Resume needs your passkey." Not acknowledged yet: it holds on this machine and can be
 * lifted from it until Intent Cloud acknowledges it; after that, only the passkey lifts it.
 */
export function liftWords(state: PauseState): string {
  if (heldByCloud(state)) return "Resume needs your passkey.";
  const when =
    state.cloud?.reason === "not_found"
      ? " (it can once your first purchase is approved)"
      : state.cloud?.reason === "no_account_key"
        ? ` (it needs an account key on this machine: run \`${INTENT} init\`)`
        : "";
  return `The pause holds on this machine; Intent Cloud has not acknowledged it yet${when}. Until it does, the pause can be lifted from this machine; after that, resuming needs your passkey.`;
}

/** What the agent is told when the developer's pause stops a step here: what lifts it, and not to retry. */
export function pausedRefusalWords(state: PauseState): string {
  const until = heldByCloud(state) ? "they resume with their passkey" : `they lift it (\`${INTENT} resume\`)`;
  return `Not sent: the developer paused purchases through intent (\`${INTENT} pause\`). Nothing is bought until ${until}; do not retry.`;
}
