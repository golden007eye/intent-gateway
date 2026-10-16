// Demo mode (`intent demo`): the fake Intent Cloud with the published test keys and the sample catalog, in-process
// on 127.0.0.1, and a local confirm page whose buttons sign with a demo passkey. Nothing can be bought.
//
// Use (the CLI): `const demo = await startDemo({dataDir})`, then build the gateway as for `serve` against
// `demo.cloudUrl` with `demo.trustKeys.rootKeys` pinned, the store opened at `demo.dataDir`, and
// `demo: {confirmBaseUrl: demo.confirmBaseUrl, catalogNote: demo.catalogNote}` in GatewayOptions; pass `banner: DEMO_BANNER` to runStdio/runHttp
// and print `nextSteps()` on stderr. `--demo` on log/verify/panel/doctor reads `demoDataDir(dataDir)` with
// `demoTrustKeys()` and starts nothing.
export { DEMO_BANNER, nextSteps, type NextStepsOptions } from "./banner.ts";
export { CONFIRM_CSP, CONFIRM_HOST, type ConfirmPage, MAX_WRONG_CODES, startConfirmPage } from "./confirm.ts";
export { CONTAINER_CONFIRM_PORT, type Demo, demoCatalogNote, DEMO_DIR, demoDataDir, type DemoOptions, demoTrustKeys, startDemo } from "./demo.ts";
