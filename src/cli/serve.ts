// `intent serve` (and `intent-gateway` with no arguments): the MCP server over stdio, or Streamable HTTP with
// --http. Order: config → policy → store → disclosed cloud → gateway.start() (contract and key statement) → transport.
// In demo mode (`intent demo`, `--demo`) the same gateway runs against the in-process demo Intent Cloud with the
// published test root pinned, the store in `<data>/demo`, approval links on the local confirm page, and the demo
// banner on stderr and on every tool result.
import { type Config, DOCKER_EXEC, DOCKER_STOP, INTENT } from "../config/index.ts";
import { DEMO_BANNER, type Demo, nextSteps } from "../demo/index.ts";
import { createGateway } from "../gateway/index.ts";
import { runHttp, runStdio } from "../mcp/index.ts";
import { openStore } from "../store/index.ts";
import { containerConnect } from "./connect.ts";
import { type Io, line, type Outcome } from "./io.ts";
import { activePolicy, cloudFor, rootKeys } from "./setup.ts";
import { leaseNotice, slowCloudNotice } from "./waiting.ts";

export async function serve(io: Io, config: Config, options: { http: boolean; demo: Demo | null }): Promise<Outcome> {
  const { demo } = options;
  const say = (text: string): void => {
    line(io.stderr, `intent-gateway: ${text}`);
  };
  const log = (text: string): void => {
    line(io.stderr, text);
  };
  const baseUrl = demo?.cloudUrl ?? config.cloud.url;
  const pinnedRootKeys = demo?.trustKeys.rootKeys ?? (await rootKeys(config));
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
  const store = await openStore(dataDir, { onWait: leaseNotice(say, io.now) });
  // Only the start's requests (meta, key statement) say they are still waiting; a slow search later does not.
  let starting = true;
  const slow = slowCloudNotice(say, io.cloudNoticeMs, () => starting);
  try {
    const gateway = createGateway({
      cloud: (keySet) => cloudFor(io, store, baseUrl, { keySet, ...now }, slow),
      store,
      policy,
      pinnedRootKeys,
      logger: { warn: log },
      ...(demo === null ? {} : { demo: { confirmBaseUrl: demo.confirmBaseUrl, catalogNote: demo.catalogNote } }),
      ...now,
    });
    await gateway.start();
    starting = false;
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
      transport = await runStdio({ gateway, ...banner });
      policyLine();
      if (demo === null) say(`MCP over stdio is ready; data dir ${dataDir}`);
      else for (const text of nextSteps({ code: { code: demo.code, file: demo.codeFile }, confirm: confirmOf(demo) })) log(text);
    }
    const stop = async (): Promise<void> => {
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

/** The confirm page for nextSteps: its origin, and the port that was taken when it fell back to a free one. */
function confirmOf(demo: Demo): { origin: string; busy: number | null } {
  return { origin: new URL(demo.confirmBaseUrl).origin, busy: demo.confirmPortBusy };
}
