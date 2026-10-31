// `intent serve` (and `intent-gateway` with no arguments): the MCP server over stdio, or Streamable HTTP with
// --http. Order: config → policy → store → disclosed cloud → gateway.start() (contract and key statement) → transport.
// In demo mode (`intent demo`, `--demo`) the same gateway runs against the in-process demo Intent Cloud with the
// published test root pinned, the store in `<data>/demo`, approval links on the local confirm page, and the demo
// banner on stderr and on every tool result.
import { ensureAccountKey } from "../account/index.ts";
import { type Config, DOCKER_EXEC, DOCKER_STOP, INTENT } from "../config/index.ts";
import { DEMO_BANNER, type Demo, nextSteps } from "../demo/index.ts";
import { createGateway, type Gateway } from "../gateway/index.ts";
import { runHttp, runStdio } from "../mcp/index.ts";
import { openCompleterKeys } from "../signing/index.ts";
import { openStore } from "../store/index.ts";
import { containerConnect } from "./connect.ts";
import { describeError, errorContext } from "./errors.ts";
import { type Io, line, type Outcome } from "./io.ts";
import { activePolicy, cloudFor, rootKeys } from "./setup.ts";
import { leaseNotice, slowCloudNotice } from "./waiting.ts";
import { oneTapFor } from "./wallet.ts";
import { startPauseRetry } from "../pause/index.ts";
import { accountKeyFor } from "./pause.ts";

/**
 * `lazyStart`: an MCP client started this process over stdio. A start that fails (Intent Cloud unreachable, a contract
 * mismatch, a key statement that does not verify) then does not end the process: the tools are listed, each call tries
 * the start again first, and until it succeeds every call is refused with the reason, so the agent can tell the user
 * instead of seeing a dead server. Nothing is trusted or sent for a search until a start succeeds (fail closed).
 */
export async function serve(io: Io, config: Config, options: { http: boolean; demo: Demo | null; lazyStart?: boolean }): Promise<Outcome> {
  const { demo } = options;
  const say = (text: string): void => {
    line(io.stderr, `intent: ${text}`);
  };
  const log = (text: string): void => {
    line(io.stderr, text);
  };
  const baseUrl = demo?.cloudUrl ?? config.cloud.url;
  const pinnedRootKeys = demo?.trustKeys.rootKeys ?? (await rootKeys(config, { contacts: true }));
  const dataDir = demo?.dataDir ?? config.dataDir;
  const { policy, bundled } = await activePolicy(config.policyPath);
  // Printed once the gateway is serving, like the connect line, so a start that fails prints no line to act on.
  const policyLine = (): void => {
    if (bundled !== null) {
      say(`No policy file found; using the bundled ${bundled} policy: the only detail about you it sends is your ZIP code. Change it with \`${INTENT} policy add <name>\`.`);
    }
  };
  const now = io.now === undefined ? {} : { now: io.now };
  const banner = demo === null ? {} : { banner: DEMO_BANNER };
  // One-tap: the demo's fake Shop wallet, or the linked Shop wallet when there is one (else purchases are handed off).
  const oneTap = demo === null ? await oneTapFor(io, config, dataDir) : demo.oneTap;
  const store = await openStore(dataDir, { onWait: leaseNotice(say, io.now) });
  // Only the start's requests (meta, key statement) say they are still waiting; a slow search later does not.
  let starting = true;
  const slow = slowCloudNotice(say, io.cloudNoticeMs, () => starting);
  try {
    const gateway = createGateway({
      cloud: (keySet) => cloudFor(io, store, baseUrl, { keySet, ...now }, slow),
      store,
      completerKeys: openCompleterKeys(dataDir, io.now === undefined ? {} : { now: io.now }),
      ...(oneTap === null ? {} : { oneTap }),
      // The account key (ADR-0022): its public half goes in every checkout submitted (contract 1.7.0). Made on first
      // use when `intent init` has not made it yet, never overwritten.
      accountKey: async () => (await ensureAccountKey(dataDir)).key,
      policy,
      pinnedRootKeys,
      logger: { warn: log },
      ...(demo === null ? {} : { demo: { confirmBaseUrl: demo.confirmBaseUrl, catalogNote: demo.catalogNote } }),
      ...now,
    });
    const describe = (error: unknown): string => describeError(error, errorContext(config, io.env));
    const started = startOnce(gateway, describe);
    if (options.lazyStart === true) {
      try {
        await gateway.start();
      } catch (error) {
        say(describe(error));
        say("the MCP server runs anyway: each tool call tries the start again and, until it succeeds, tells the agent why");
      }
    } else {
      await gateway.start();
    }
    starting = false;
    // A pause not yet acknowledged by Intent Cloud (this process's, the CLI's or the panel's) is sent again with backoff
    // while serve runs (ADR-0023); the local pause holds meanwhile.
    const retry = startPauseRetry(
      { store, accountKey: accountKeyFor(io, dataDir), connect: async () => {
        await started.ensure();
        return (request, unless) => gateway.sendPause(request, unless);
      }, now: io.now ?? Date.now },
      {
        onError: (error) => {
          log(`intent: the pause could not be sent: ${error instanceof Error ? error.message : String(error)}`);
        },
      },
    );
    void retry.tick();
    let transport: { close(): Promise<void> };
    if (options.http) {
      const { host, port, token } = config.http;
      const http = await runHttp({ gateway, host, port, token, log, ...banner });
      transport = http;
      // In the Docker image the server listens on 0.0.0.0, which is no address to connect to; the documented
      // mapping publishes it on the host's 127.0.0.1. The address line and the one connect line are printed here,
      // once, now that the server is up (so a container that cannot start prints none): the connect line with the
      // token on the first start that serves, else a `$(docker exec … cat …)` that reads it. No line with a
      // placeholder token, which would get a 401.
      const container = config.runtime === "container";
      const url = container ? `http://127.0.0.1:${String(http.port)}/mcp` : http.url;
      say(`MCP over HTTP at ${url}`);
      policyLine();
      if (container && token !== null && config.tokenFile !== null) {
        for (const text of containerConnect({ token, tokenFile: config.tokenFile, quiet: config.quietToken, dockerExec: DOCKER_EXEC })) log(text);
      }
      if (demo === null) {
        const auth = token === null ? "" : ` --header "Authorization: Bearer $INTENT_HTTP_TOKEN"`;
        say(container ? "connect an agent with the claude mcp add line above" : `connect an agent: claude mcp add --transport http intent ${url}${auth}`);
      } else {
        for (const text of nextSteps({ http: container ? "above" : { url, token }, code: { code: demo.code, file: demo.codeFile }, confirm: confirmOf(demo) })) log(text);
        // A detached container has no terminal to press Ctrl-C in.
        say(container ? `serving; stop it with ${DOCKER_STOP}` : "serving until Ctrl-C");
      }
    } else {
      transport = await runStdio({ gateway: options.lazyStart === true ? started.gateway : gateway, ...banner });
      policyLine();
      if (demo === null) say(`MCP over stdio is ready; data dir ${dataDir}`);
      else for (const text of nextSteps({ code: { code: demo.code, file: demo.codeFile }, confirm: confirmOf(demo) })) log(text);
    }
    const stop = async (): Promise<void> => {
      retry.stop();
      await transport.close();
      await store.close();
      await demo?.close();
    };
    if (!options.http) io.stdin.once("end", () => void stop());
    return { code: 0, stop };
  } catch (error) {
    await store.close();
    throw error;
  }
}

/** A start failure as a tool call reports it: the reason, its fix, and where to see each check. */
class NotStartedError extends Error {
  override name = "NotStartedError";
}

/**
 * The gateway, with each tool call preceded by one start attempt shared by concurrent calls (start appends to the
 * chain, so two must not run at once). A failed attempt is forgotten, so the next call tries again; a call is refused
 * with the reason while no start has succeeded.
 */
function startOnce(gateway: Gateway, describe: (error: unknown) => string): { ensure(): Promise<void>; gateway: Gateway } {
  let done = false;
  let attempt: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    if (done) return Promise.resolve();
    attempt ??= gateway.start().then(
      () => {
        done = true;
      },
      (error: unknown) => {
        attempt = null;
        throw new NotStartedError(`${describe(error).replace(/\.$/, "")}. Run \`${INTENT} doctor\` to see each check.`);
      },
    );
    return attempt;
  };
  const after =
    <T>(run: (input: unknown) => Promise<T>) =>
    async (input: unknown): Promise<T> => {
      await ensure();
      return run(input);
    };
  return {
    ensure,
    gateway: {
      start: ensure,
      findOffers: after((input) => gateway.findOffers(input)),
      createCart: after((input) => gateway.createCart(input)),
      getApprovalStatus: after((input) => gateway.getApprovalStatus(input)),
      sendPause: async (request, unless) => {
        await ensure();
        return gateway.sendPause(request, unless);
      },
    },
  };
}

/** The confirm page for nextSteps: its origin, and the port that was taken when it fell back to a free one. */
function confirmOf(demo: Demo): { origin: string; busy: number | null } {
  return { origin: new URL(demo.confirmBaseUrl).origin, busy: demo.confirmPortBusy };
}
