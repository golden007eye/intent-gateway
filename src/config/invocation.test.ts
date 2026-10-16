// invocation(): every command the gateway prints must be one that works for this install (devrun F-b, F-d).
import { describe, expect, it } from "vitest";
import { dockerExec, INTENT, invocation, type InvocationInput } from "./index.ts";

const NPX_DIR = "/home/dev/.npm/_npx/0123abcd";
const NPX_ROOT = `${NPX_DIR}/node_modules/intent-gateway`;
const NPX_BIN = `${NPX_DIR}/node_modules/.bin/intent-gateway`;

function npxManifest(dependency: string, packages: string[]): (path: string) => string | null {
  return (path) =>
    path === `${NPX_DIR}/package.json` ? JSON.stringify({ dependencies: { "intent-gateway": dependency }, _npx: { packages } }) : null;
}

function run(input: Partial<InvocationInput>): string {
  return invocation({ argv1: undefined, packageRoot: "/src/intent-gateway", env: {}, readText: () => null, realpath: (p) => p, ...input });
}

describe("invocation", () => {
  it("names the published package npx was given, with its tag", () => {
    const readText = npxManifest("^0.1.0-preview.1", ["intent-gateway@next"]);
    expect(run({ argv1: NPX_BIN, packageRoot: NPX_ROOT, readText, env: { npm_command: "exec" } })).toBe("npx -y intent-gateway@next");
  });

  it("names a local tarball by its absolute path, even when npx was given a relative one", () => {
    const readText = npxManifest("file:../../../projects/intent-gateway/intent-gateway.tgz", ["./intent-gateway.tgz"]);
    expect(run({ argv1: NPX_BIN, packageRoot: NPX_ROOT, readText })).toBe("npx -y file:/home/dev/projects/intent-gateway/intent-gateway.tgz");
  });

  it("quotes a tarball path with a space", () => {
    const readText = npxManifest("file:../../../my projects/intent-gateway.tgz", ["file:/home/dev/my projects/intent-gateway.tgz"]);
    expect(run({ argv1: NPX_BIN, packageRoot: NPX_ROOT, readText })).toBe("npx -y 'file:/home/dev/my projects/intent-gateway.tgz'");
  });

  it("runs a source build or an unpacked package by its real path with node", () => {
    expect(run({ argv1: "/home/dev/intent-gateway/dist/main.js", packageRoot: "/home/dev/intent-gateway" })).toBe("node /home/dev/intent-gateway/dist/main.js");
    const realpath = (p: string): string => (p === "/home/dev/bin/intent" ? "/home/dev/intent-gateway/dist/main.js" : p);
    expect(run({ argv1: "/home/dev/bin/intent", realpath, env: { PATH: "/usr/bin" } })).toBe("node /home/dev/intent-gateway/dist/main.js");
  });

  it("falls back to node and the real path when the npx folder cannot be read", () => {
    const realpath = (): string => `${NPX_ROOT}/dist/main.js`;
    expect(run({ argv1: NPX_BIN, packageRoot: NPX_ROOT, realpath })).toBe(`node ${NPX_ROOT}/dist/main.js`);
  });

  it("uses the bare command for a bin on PATH (a global install)", () => {
    expect(run({ argv1: "/usr/local/bin/intent", env: { PATH: "/usr/bin:/usr/local/bin" } })).toBe("intent");
    expect(run({ argv1: "/usr/local/bin/intent-gateway", env: { PATH: "/usr/local/bin/" } })).toBe("intent-gateway");
  });

  it("uses docker exec with the container id (HOSTNAME) in the image", () => {
    expect(run({ argv1: "/app/dist/main.js", env: { INTENT_RUNTIME: "container", HOSTNAME: "3f2a9c41b0de" } })).toBe("docker exec 3f2a9c41b0de intent");
  });

  it.each([[undefined], ["my-gateway"], ["3F2A9C41B0DE"], ["3f2a9c41b0de1"], ["3f2a9c41b0d; rm -rf /"]])(
    "says <container> when HOSTNAME %j is not a short container id (--hostname, --network host)",
    (hostname) => {
      expect(run({ argv1: "/app/dist/main.js", env: { INTENT_RUNTIME: "container", HOSTNAME: hostname } })).toBe("docker exec <container> intent");
      expect(dockerExec({ HOSTNAME: hostname })).toBe("docker exec <container>");
    },
  );

  it("says intent when this process is not the gateway's script (a test runner, an embedding)", () => {
    expect(run({ argv1: "/repo/node_modules/vitest/vitest.mjs" })).toBe("intent");
    expect(run({})).toBe("intent");
    expect(INTENT).toBe("intent");
  });
});
