// `intent serve` (and `intent-gateway` with no arguments): the MCP server over stdio, or Streamable HTTP with
// --http. Order: config → policy → store → disclosed cloud → gateway.start() (contract and key statement) → transport.
// In demo mode (`intent demo`, `--demo`) the same gateway runs against the in-process demo Intent Cloud with the
// published test root pinned, the store in `<data>/demo`, approval links on the local confirm page, and the demo
// banner on stderr and on every tool result.
import type { Config } from "../config/index.ts";
import { DEMO_BANNER, type Demo, nextSteps } from "../demo/index.ts";
import { createGateway } from "../gateway/index.ts";
import { runHttp, runStdio } from "../mcp/index.ts";
import { openStore } from "../store/index.ts";
import { type Io, line, type Outcome } from "./io.ts";
import { activePolicy, cloudFor, rootKeys } from "./setup.ts";

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
  const { policy, bundled } = await activePolicy(config.policyPath, config.demo);
  if (bundled !== null) {
    say(`no policy file at ${config.policyPath}, so the bundled ${bundled} policy applies (intent policy add <name> writes one)`);
  }
  const now = io.now === undefined ? {} : { now: io.now };
  const banner = demo === null ? {} : { banner: DEMO_BANNER };
  const store = await openStore(dataDir);
  try {
    const gateway = createGateway({
      cloud: (keySet) => cloudFor(io, store, baseUrl, { keySet, ...now }),
      store,
      policy,
      pinnedRootKeys,
      logger: { warn: log },
      ...(demo === null ? {} : { demo: { confirmBaseUrl: demo.confirmBaseUrl } }),
      ...now,
    });
    await gateway.start();
    let transport: { close(): Promise<void> };
    if (options.http) {
      const { host, port, token } = config.http;
      const http = await runHttp({ gateway, host, port, token, log, ...banner });
      transport = http;
      // In the Docker image the server listens on 0.0.0.0, which is no address to connect to; the documented
      // mapping publishes it on the host's 127.0.0.1. The token stays out of the log there: the entrypoint printed
      // it once, on the start that made it.
      const container = config.runtime === "container";
      const url = container ? `http://127.0.0.1:${String(http.port)}/mcp` : http.url;
      const shownToken = token === null ? null : container ? "<token>" : "$INTENT_HTTP_TOKEN";
      if (demo === null) {
        say(`MCP over HTTP at ${url}`);
        const auth = shownToken === null ? "" : ` --header "Authorization: Bearer ${shownToken}"`;
        say(`connect an agent: claude mcp add --transport http intent ${url}${auth}`);
      } else {
        for (const text of nextSteps({ http: { url, token: container ? shownToken : token } })) log(text);
        say("serving until Ctrl-C");
      }
    } else {
      transport = await runStdio({ gateway, ...banner });
      if (demo === null) say(`MCP over stdio is ready; data dir ${dataDir}`);
      else for (const text of nextSteps()) log(text);
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
