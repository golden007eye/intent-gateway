// `intent init`: the first run (plan G8). It checks the data dir and the chain and names the policy in force (the
// checks of `intent doctor`), offers to link Shop for one-tap purchases, and prints the line that connects an agent.
// The Shop step never blocks setup: with no Shop client set, in demo mode, with no terminal to ask at (Docker, a
// pipe) or with --yes it is skipped with a line that says so, and purchases are handed off to the merchant's checkout.
import { type Config, INTENT } from "../config/index.ts";
import { describeError } from "./errors.ts";
import { checkChain, checkDataDir, checkPolicy, LABELS, type Level } from "./doctor.ts";
import { hostConnect } from "./connect.ts";
import { type Io, line } from "./io.ts";
import { ask } from "./prompt.ts";
import { walletLink } from "./wallet.ts";
import { printable } from "../ui/index.ts";
import { hasSecret } from "../wallet/index.ts";

const HANDOFF = "purchases are handed off to the merchant's checkout";

/** Exit 0 when every check passed and the Shop step did not fail; 1 otherwise. Every step runs either way. */
export async function init(io: Io, config: Config, options: { yes: boolean }): Promise<number> {
  const levels: Level[] = [];
  const report = (level: Level, text: string): void => {
    levels.push(level);
    line(io.stdout, `${LABELS[level]}  ${printable(text)}`);
  };
  line(io.stdout, `intent init: data dir ${config.dataDir}`);
  await checkDataDir(config.dataDir, report);
  checkChain(config.dataDir, report);
  await checkPolicy(config.policyPath, report);

  const shop = await shopStep(io, config, options.yes);

  line(io.stdout);
  if (config.runtime === "container") {
    line(io.stdout, "Connect an agent: once this container's gateway serves, it prints its claude mcp add line (docker logs shows it)");
  } else {
    const args = [...(config.demo ? ["demo"] : []), ...(config.cloud.trust.kind === "file" ? ["--trust-keys", config.cloud.trust.path] : [])];
    line(io.stdout, "Connect an agent (Claude Code):");
    line(io.stdout, `  ${printable(hostConnect(INTENT, io.env, args))}`);
  }
  return shop && !levels.includes("fail") ? 0 : 1;
}

/** Offers to link Shop when it can; false only when the developer said yes and the link failed. */
async function shopStep(io: Io, config: Config, yes: boolean): Promise<boolean> {
  const later = `link it later with ${INTENT} wallet link shop`;
  if (config.demo) {
    line(io.stdout, `Shop one-tap: not offered in demo mode; ${HANDOFF}`);
    return true;
  }
  if (config.wallet.shopClientId === null) {
    line(io.stdout, `Shop one-tap: unavailable until a registered Shop client is set (INTENT_SHOP_CLIENT_ID); ${HANDOFF}`);
    return true;
  }
  if (await hasSecret(config.dataDir, "shop")) {
    line(io.stdout, `Shop one-tap: a Shop wallet is already linked (${INTENT} wallet status checks it)`);
    return true;
  }
  if (yes || !io.isTTY.stdin || !io.isTTY.stdout) {
    line(io.stdout, `Shop one-tap: skipped (${yes ? "--yes" : "no terminal to ask at"}); ${HANDOFF}; ${later}`);
    return true;
  }
  const answer = (await ask(io, "Pay in one tap with Shop? [y/N] "))?.trim().toLowerCase() ?? "";
  if (answer !== "y" && answer !== "yes") {
    line(io.stdout, `Shop one-tap: not linked; ${HANDOFF}; ${later}`);
    return true;
  }
  try {
    return (await walletLink(io, config, "shop")) === 0;
  } catch (error) {
    line(io.stderr, `intent: ${printable(describeError(error, { dataDir: config.dataDir }))}; ${HANDOFF}; ${later}`);
    return false;
  }
}
