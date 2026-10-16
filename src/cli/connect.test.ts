// The Docker image's connect line, printed by the gateway once it serves (F-h): the token once, on the first start
// that serves; afterwards a line that reads it from the container; never with INTENT_QUIET_TOKEN=1.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { containerConnect, unshownMarker } from "./connect.ts";

const TOKEN = "k".repeat(43);
const EXEC = "docker exec 0123456789ab";

function dataDir(withMarker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "connect-"));
  writeFileSync(join(dir, "http-token"), `${TOKEN}\n`, { mode: 0o600 });
  if (withMarker) writeFileSync(unshownMarker(join(dir, "http-token")), "", { mode: 0o600 });
  return dir;
}

describe("containerConnect", () => {
  it("prints the new token once, then a line that reads it from the container", () => {
    const tokenFile = join(dataDir(true), "http-token");
    const first = containerConnect({ token: TOKEN, tokenFile, quiet: false, dockerExec: EXEC });
    expect(first[1]).toBe(`  claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer ${TOKEN}"`);
    expect(first.join("\n")).toContain("Later starts reuse the token and do not print it again");
    expect(existsSync(unshownMarker(tokenFile))).toBe(false);
    const again = containerConnect({ token: TOKEN, tokenFile, quiet: false, dockerExec: EXEC });
    expect(again.join("\n")).not.toContain(TOKEN);
    expect(again[1]).toBe(`  claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer $(${EXEC} cat ${tokenFile})"`);
  });

  it("attack: INTENT_QUIET_TOKEN=1 never prints the token, even with the marker, and keeps the marker", () => {
    const tokenFile = join(dataDir(true), "http-token");
    const lines = containerConnect({ token: TOKEN, tokenFile, quiet: true, dockerExec: EXEC });
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines[1]).toContain(`$(${EXEC} cat ${tokenFile})`);
  });

  it("attack: a token that is not the file's (INTENT_HTTP_TOKEN set by hand) is never printed, marker or not", () => {
    const tokenFile = join(dataDir(true), "http-token");
    const own = "z".repeat(43);
    const lines = containerConnect({ token: own, tokenFile, quiet: false, dockerExec: EXEC });
    expect(lines.join("\n")).not.toContain(own);
    expect(lines[1]).toContain(`$(${EXEC} printenv INTENT_HTTP_TOKEN)`);
  });

  it("a reused token with no marker is not printed", () => {
    const tokenFile = join(dataDir(false), "http-token");
    expect(containerConnect({ token: TOKEN, tokenFile, quiet: false, dockerExec: EXEC }).join("\n")).not.toContain(TOKEN);
  });
});
