// `intent init`: the first run (plan G8). It checks the data dir and the chain and names the policy in force (the
// checks of `intent doctor`), makes the account key once (ADR-0021), offers to link Shop for one-tap purchases, and
// prints the line that connects an agent.
// The Shop step never blocks setup: in demo mode, with no terminal to ask at (Docker, a
// pipe) or with --yes it is skipped with a line that says so, and purchases are handed off to the merchant's checkout.
import { stat } from "node:fs/promises";
import { AccountKeyError, ensureAccountKey } from "../account/index.ts";
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
  await accountKeyStep(config.dataDir, report);

  const shop = await shopStep(io, config, options.yes);

  line(io.stdout);
  if (config.runtime === "container") {
    line(io.stdout, "Connect an agent: once this container's gateway serves, it prints its claude mcp add line (docker logs shows it)");
  } else {
    const args = [...(config.demo ? ["demo"] : []), ...(config.cloud.trust.kind === "file" ? ["--trust-keys", config.cloud.trust.path] : [])];
    line(io.stdout, "Connect an agent (Claude Code):");
    line(io.stdout, `  ${printable(hostConnect(INTENT, io.env, args))}`);
    // The line never carries INTENT_WALLET_KEY (a secret), so an agent's gateway would not open the vault without it.
    if (config.wallet.key.kind === "env") {
      line(
        io.stdout,
        "The wallet key comes from INTENT_WALLET_KEY, which this line leaves out: set INTENT_WALLET_KEY_FILE to a file holding it (preferred), or add INTENT_WALLET_KEY to your MCP config yourself",
      );
    }
  }
  return shop && !levels.includes("fail") ? 0 : 1;
}

/**
 * Makes the account key when there is none, and never replaces one (ADR-0021). Only its path and thumbprint are
 * printed; the key stays in its file.
 */
async function accountKeyStep(dataDir: string, report: (level: Level, text: string) => void): Promise<void> {
  try {
    const { key, created } = await ensureAccountKey(dataDir);
    const mode = (await stat(key.path)).mode & 0o777;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      report("fail", `account key: other users can read ${key.path} (mode ${mode.toString(8)}); run chmod 600 ${key.path}`);
      return;
    }
    report("ok", `account key: ${created ? "made" : "kept"} ${key.path} (thumbprint ${key.thumbprint})`);
  } catch (error) {
    if (!(error instanceof AccountKeyError)) {
      report("fail", `account key: ${describeError(error, { dataDir })}`);
      return;
    }
    report("fail", `account key: ${error.message}`);
  }
}

/** Offers to link Shop when it can; false only when the developer said yes and the link failed. */
async function shopStep(io: Io, config: Config, yes: boolean): Promise<boolean> {
  const later = `link it later with ${INTENT} wallet link shop`;
  if (config.demo) {
    line(io.stdout, `Shop one-tap: not offered in demo mode; ${HANDOFF}`);
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
