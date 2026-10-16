// `intent serve` (and `intent-gateway` with no arguments): the MCP server over stdio, or Streamable HTTP with
// --http. Order: config → policy → store → disclosed cloud → gateway.start() (contract and key statement) → transport.
import type { Config } from "../config/index.ts";
import { createGateway } from "../gateway/index.ts";
import { runHttp, runStdio } from "../mcp/index.ts";
import { openStore } from "../store/index.ts";
import { type Io, line, type Outcome } from "./io.ts";
import { activePolicy, cloudFor, type Demo, rootKeys } from "./setup.ts";

export async function serve(io: Io, config: Config, options: { http: boolean; demo: Demo | null }): Promise<Outcome> {
  const { demo } = options;
  const say = (text: string): void => {
    line(io.stderr, `intent-gateway: ${text}`);
  };
  const baseUrl = demo?.cloudUrl ?? config.cloud.url;
  const pinnedRootKeys = demo?.trustKeys.rootKeys ?? (await rootKeys(config));
  const { policy, bundled } = await activePolicy(config.policyPath);
  if (bundled) {
    say(`no policy file at ${config.policyPath}, so the bundled strict-default policy applies (intent policy add <name> writes one)`);
  }
  const now = io.now === undefined ? {} : { now: io.now };
  const log = (text: string): void => {
    line(io.stderr, text);
  };
  const store = await openStore(config.dataDir);
  try {
    const gateway = createGateway({
      cloud: (keySet) => cloudFor(io, store, baseUrl, { keySet, ...now }),
      store,
      policy,
      pinnedRootKeys,
      logger: { warn: (message) => { line(io.stderr, message); } },
      ...now,
    });
    await gateway.start();
    let transport: { close(): Promise<void> };
    if (options.http) {
      const http = await runHttp({ gateway, host: config.http.host, port: config.http.port, token: config.http.token, log });
      transport = http;
      say(`MCP over HTTP at ${http.url}`);
      const auth = config.http.token === null ? "" : ' --header "Authorization: Bearer $INTENT_HTTP_TOKEN"';
      say(`connect an agent: claude mcp add --transport http intent ${http.url}${auth}`);
    } else {
      transport = await runStdio({ gateway });
      say(`MCP over stdio is ready; data dir ${config.dataDir}`);
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
