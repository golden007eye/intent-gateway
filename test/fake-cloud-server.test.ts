// The standalone fake Cloud entry used by manual and acceptance runs: starts, prints its URL and root pin, serves the
// statement, answers buyer commands on stdin, and stays out of the npm package and the build.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");

describe("test/support/fake-cloud-server.ts", () => {
  it("prints {url, rootPin}, serves the key statement and answers stdin commands", { timeout: 20_000 }, async () => {
    const child = spawn(process.execPath, [join(repo, "test/support/fake-cloud-server.ts"), "--port", "0"], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const first = JSON.parse(String((await lines.next()).value)) as { url: string; rootPin: { kid: string } };
      expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(first.rootPin.kid).toBe("cloud-root-1");
      const res = await fetch(`${first.url}/v1/key-statement`);
      expect(res.status).toBe(200);
      expect(res.headers.get("intent-receipt")).not.toBeNull();
      child.stdin.write("approve ap_unknown1\n");
      expect(JSON.parse(String((await lines.next()).value))).toEqual({ status: 404, reason: "unknown approval" });
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("is in neither the npm package files nor the build", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files.some((f) => f === "test" || f.startsWith("test/"))).toBe(false);
    const build = JSON.parse(readFileSync(join(repo, "tsconfig.build.json"), "utf8")) as { include: string[]; exclude: string[] };
    expect(build.include).toEqual(["src"]);
    expect(build.exclude).toContain("src/cloud-fake");
  });
});
