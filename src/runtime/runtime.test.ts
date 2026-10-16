// The Node range the gateway runs on (F-t): package.json engines `^22.22.2 || ^24.15.0 || >=26.0.0`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_NODE, nodeSupported, unsupportedNodeLine } from "./index.ts";

describe("nodeSupported", () => {
  it.each([
    ["22.22.2", true],
    ["22.22.10", true],
    ["22.23.3", true],
    ["v22.23.0", true],
    ["24.15.0", true],
    ["24.22.0", true],
    ["26.0.0", true],
    ["26.12.0", true],
    ["27.0.0-pre", true],
    ["28.1.0", true],
    ["22.22.1", false],
    ["22.17.1", false],
    ["22.12.0", false],
    ["22.9.0", false],
    ["20.19.5", false],
    ["23.11.1", false],
    ["24.14.1", false],
    ["24.0.0", false],
    ["25.9.0", false],
    ["18.20.8", false],
    ["", false],
    ["not a version", false],
  ])("%s: %s", (version, supported) => {
    expect(nodeSupported(version)).toBe(supported);
  });

  it("accepts the Node running these tests (CI runs them on every supported line)", () => {
    expect(nodeSupported(process.versions.node)).toBe(true);
  });

  it("names the same range as package.json engines", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe("^22.22.2 || ^24.15.0 || >=26.0.0");
    expect(SUPPORTED_NODE).toBe("Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+");
  });
});

describe("unsupportedNodeLine", () => {
  it("is one line naming the floor, the running Node and how to upgrade", () => {
    const text = unsupportedNodeLine("v22.17.1");
    expect(text).toBe(
      "intent-gateway needs Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+; this is Node 22.17.1. " +
        "Upgrade with nvm install 24, brew upgrade node, or the installer at https://nodejs.org/en/download, then run it again.",
    );
    expect(text).not.toContain("\n");
  });
});
