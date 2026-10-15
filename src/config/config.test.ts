import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { readBuild } from "./build.ts";
import { BUILD, ConfigError, loadConfig, PINNED_HOSTS, type LoadOptions } from "./index.ts";

// The staging pin is empty until the release task commits the root key, so most cases pass --trust-keys.
const TRUST = ["--trust-keys", "/keys/root.jwk"];
const LINUX: LoadOptions = { platform: "linux", homedir: "/home/dev", cwd: "/work" };

function load(env: Record<string, string>, options: LoadOptions = LINUX, argv: string[] = TRUST) {
  return loadConfig(env, argv, options);
}

describe("data dir", () => {
  const cases: [label: string, env: Record<string, string>, options: LoadOptions, dataDir: string][] = [
    ["Linux default", {}, LINUX, "/home/dev/.local/share/intent-gateway"],
    ["Linux XDG_DATA_HOME", { XDG_DATA_HOME: "/xdg" }, LINUX, "/xdg/intent-gateway"],
    ["relative XDG_DATA_HOME is ignored", { XDG_DATA_HOME: "xdg" }, LINUX, "/home/dev/.local/share/intent-gateway"],
    [
      "macOS default",
      {},
      { platform: "darwin", homedir: "/Users/dev", cwd: "/work" },
      "/Users/dev/Library/Application Support/intent-gateway",
    ],
    [
      "Windows LOCALAPPDATA",
      { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      { platform: "win32", homedir: "C:\\Users\\dev", cwd: "C:\\work" },
      "C:\\Users\\dev\\AppData\\Local\\intent-gateway",
    ],
    [
      "Windows without LOCALAPPDATA",
      {},
      { platform: "win32", homedir: "C:\\Users\\dev", cwd: "C:\\work" },
      "C:\\Users\\dev\\AppData\\Local\\intent-gateway",
    ],
    ["container", { INTENT_RUNTIME: "container", XDG_DATA_HOME: "/xdg" }, LINUX, "/data"],
    ["INTENT_DATA_DIR absolute", { INTENT_DATA_DIR: "/srv/gw", XDG_DATA_HOME: "/xdg" }, LINUX, "/srv/gw"],
    ["INTENT_DATA_DIR relative to cwd", { INTENT_DATA_DIR: "state" }, LINUX, "/work/state"],
    ["INTENT_DATA_DIR wins in a container", { INTENT_DATA_DIR: "/mnt/gw", INTENT_RUNTIME: "container" }, LINUX, "/mnt/gw"],
  ];
  it.each(cases)("%s", (_label, env, options, dataDir) => {
    const config = load(env, options);
    expect(config.dataDir).toBe(dataDir);
    expect(config.policyPath).toBe(options.platform === "win32" ? `${dataDir}\\policy.yaml` : `${dataDir}/policy.yaml`);
  });

  it("reports the runtime", () => {
    expect(load({}).runtime).toBe("host");
    expect(load({ INTENT_RUNTIME: "container" }).runtime).toBe("container");
  });

  it("takes INTENT_POLICY, relative to cwd", () => {
    expect(load({ INTENT_POLICY: "/etc/gw/policy.yaml" }).policyPath).toBe("/etc/gw/policy.yaml");
    expect(load({ INTENT_POLICY: "p.yaml" }).policyPath).toBe("/work/p.yaml");
  });

  it("uses the real platform when none is injected", () => {
    expect(loadConfig({ INTENT_DATA_DIR: "/abs" }, TRUST).dataDir).toMatch(/abs$/);
  });
});

describe("environment validation", () => {
  it.each([
    ["INTENT_DATADIR", "/x"],
    ["INTENT_HTTP_TOKN", "x".repeat(40)],
    ["INTENT_DEBUG", "1"],
  ])("rejects the unknown variable %s", (name, value) => {
    expect(() => load({ [name]: value })).toThrow(new RegExp(`unknown environment variable ${name}`));
  });

  it("ignores variables outside INTENT_*", () => {
    expect(() => load({ PATH: "/bin", INTENTX: "1", intent_data_dir: "/x" })).not.toThrow();
  });

  it.each([
    ["INTENT_RUNTIME", "docker", /INTENT_RUNTIME must be "container"/],
    ["INTENT_DATA_DIR", "", /INTENT_DATA_DIR is set but empty/],
    ["INTENT_HTTP_PORT", "0", /INTENT_HTTP_PORT must be a port/],
    ["INTENT_HTTP_PORT", "65536", /INTENT_HTTP_PORT must be a port/],
    ["INTENT_HTTP_PORT", "80a", /INTENT_HTTP_PORT must be a port/],
    ["INTENT_HTTP_PORT", "8787.5", /INTENT_HTTP_PORT must be a port/],
    ["INTENT_HTTP_PORT", " 8787", /INTENT_HTTP_PORT must be a port/],
    ["INTENT_HTTP_HOST", "not a host", /INTENT_HTTP_HOST must be/],
    ["INTENT_HTTP_TOKEN", "short", /INTENT_HTTP_TOKEN must be at least 32/],
    ["INTENT_HTTP_TOKEN", `${"a".repeat(32)} b`, /INTENT_HTTP_TOKEN must be at least 32/],
    ["INTENT_CLOUD_URL", "not a url", /INTENT_CLOUD_URL is not a URL/],
    ["INTENT_CLOUD_URL", "http://cloud.example", /INTENT_CLOUD_URL must use https/],
    ["INTENT_CLOUD_URL", "ftp://cloud.example", /INTENT_CLOUD_URL must use https/],
    ["INTENT_CLOUD_URL", "https://cloud.example/v1", /INTENT_CLOUD_URL must be an origin/],
    ["INTENT_CLOUD_URL", "https://cloud.example/?a=1", /INTENT_CLOUD_URL must be an origin/],
    ["INTENT_CLOUD_URL", "https://user:pw@cloud.example", /INTENT_CLOUD_URL must be an origin/],
  ])("rejects %s=%j", (name, value, message) => {
    const error = (() => {
      try {
        load({ [name]: value });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(message);
  });

  it("an undefined value counts as unset", () => {
    expect(loadConfig({ INTENT_HTTP_PORT: undefined, INTENT_BOGUS: undefined }, TRUST, LINUX).http.port).toBe(8787);
  });
});

describe("HTTP transport", () => {
  const token = "t".repeat(32);

  it("defaults to loopback 127.0.0.1:8787 without a token", () => {
    expect(load({}).http).toEqual({ host: "127.0.0.1", port: 8787, token: null });
  });

  it.each(["0.0.0.0", "::", "192.168.1.10", "gateway.example", "::ffff:127.0.0.1"])(
    "rejects non-loopback host %s without a token, naming the variable",
    (host) => {
      expect(() => load({ INTENT_HTTP_HOST: host })).toThrow(/INTENT_HTTP_TOKEN is required/);
    },
  );

  it.each(["127.0.0.1", "127.8.9.10", "localhost", "LOCALHOST", "::1"])("allows loopback host %s without a token", (host) => {
    expect(load({ INTENT_HTTP_HOST: host }).http.token).toBeNull();
  });

  it("accepts a non-loopback host with a token", () => {
    expect(load({ INTENT_HTTP_HOST: "0.0.0.0", INTENT_HTTP_PORT: "9000", INTENT_HTTP_TOKEN: token }).http).toEqual({
      host: "0.0.0.0",
      port: 9000,
      token,
    });
  });
});

describe("cloud trust", () => {
  it("rejects an unpinned cloud URL without --trust-keys", () => {
    expect(() => load({ INTENT_CLOUD_URL: "https://cloud.example" }, LINUX, [])).toThrow(
      /cloud\.example is not a pinned Intent Cloud host; pass --trust-keys/,
    );
  });

  it("a pinned host name on another port is not pinned", () => {
    expect(() => load({ INTENT_CLOUD_URL: "https://staging-api.intentai.shop:8443" }, LINUX, [])).toThrow(
      /not a pinned Intent Cloud host/,
    );
  });

  it("an inherited property name is not a pinned host", () => {
    expect(() => load({ INTENT_CLOUD_URL: "https://constructor" }, LINUX, [])).toThrow(/not a pinned/);
  });

  it("refuses the default host while its pin is empty", () => {
    expect(PINNED_HOSTS["staging-api.intentai.shop"]?.rootKeys).toEqual([]);
    expect(() => load({}, LINUX, [])).toThrow(/no root key is pinned for staging-api\.intentai\.shop/);
  });

  it("refuses an empty pin even when other arguments are present", () => {
    expect(() => load({}, LINUX, ["serve", "--trust-keys-x", "k"])).toThrow(ConfigError);
  });

  it("uses a pinned host's root keys when the pin is filled", () => {
    const pins = PINNED_HOSTS as Record<string, { rootKeys: unknown[] }>;
    const key = { kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" } };
    pins["pinned.example"] = { rootKeys: [key] };
    try {
      expect(load({ INTENT_CLOUD_URL: "https://pinned.example" }, LINUX, []).cloud).toEqual({
        url: "https://pinned.example",
        trust: { kind: "pinned", host: "pinned.example", rootKeys: [key] },
      });
    } finally {
      delete pins["pinned.example"];
    }
  });

  it.each([
    [["--trust-keys", "keys.json"], "/work/keys.json"],
    [["serve", "--trust-keys=/abs/keys.json"], "/abs/keys.json"],
  ])("--trust-keys %j trusts that file", (argv, path) => {
    expect(load({ INTENT_CLOUD_URL: "https://cloud.example" }, LINUX, argv).cloud).toEqual({
      url: "https://cloud.example",
      trust: { kind: "file", path },
    });
  });

  it("allows http only to a loopback cloud (the fake Intent Cloud in tests)", () => {
    expect(load({ INTENT_CLOUD_URL: "http://127.0.0.1:4000" }).cloud.url).toBe("http://127.0.0.1:4000");
    expect(load({ INTENT_CLOUD_URL: "http://[::1]:4000/" }).cloud.url).toBe("http://[::1]:4000");
  });

  it.each([[["--trust-keys"]], [["--trust-keys", "--other"]], [["--trust-keys="]], [["--trust-keys", ""]]])(
    "rejects --trust-keys without a path: %j",
    (argv) => {
      expect(() => load({}, LINUX, argv)).toThrow(/--trust-keys needs a path/);
    },
  );

  it("rejects --trust-keys given twice", () => {
    expect(() => load({}, LINUX, ["--trust-keys", "a", "--trust-keys=b"])).toThrow(/more than once/);
  });
});

describe("PINNED_HOSTS holds only root public keys", () => {
  it("every entry is { rootKeys: [{ kid: cloud-root-1, public jwk }] }", () => {
    for (const pin of Object.values(PINNED_HOSTS)) {
      expect(Object.keys(pin)).toEqual(["rootKeys"]);
      for (const key of pin.rootKeys) {
        expect(Object.keys(key).sort()).toEqual(["jwk", "kid"]);
        expect(key.kid).toBe("cloud-root-1");
        for (const secret of ["d", "p", "q", "dp", "dq", "qi", "k"]) expect(key.jwk).not.toHaveProperty(secret);
      }
    }
  });
});

// Confirm origins and the rp_id come from the signed statement at run time (plan §3.1). A literal in this module
// would be a second, unsigned source of truth for them.
const FORBIDDEN = /confirm|rp_?id/i;

function forbiddenTokens(source: string): string[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateLiteralToken(node) ||
        ts.isRegularExpressionLiteral(node) ||
        ts.isIdentifier(node) ||
        ts.isPrivateIdentifier(node)) &&
      FORBIDDEN.test(node.text)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("no confirm origin or rp_id in src/config", () => {
  it("the scanner catches each kind of literal (attack cases)", () => {
    expect(forbiddenTokens(`const a = "https://confirm.example";`)).toEqual(["https://confirm.example"]);
    expect(forbiddenTokens("const b = `x${1}rp_id`;")).toEqual(["rp_id"]);
    expect(forbiddenTokens("const c = { rpId: 1 };")).toEqual(["rpId"]);
    expect(forbiddenTokens("const d = { 'RP_ID': `id` };")).toEqual(["RP_ID"]);
    expect(forbiddenTokens("const e = /confirm/;")).toEqual(["/confirm/"]);
    expect(forbiddenTokens(`// a comment about the confirm page\nconst f = "ok";`)).toEqual([]);
  });

  it("no source file in src/config holds one", () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".ts") && join(dir, f) !== import.meta.filename,
    );
    expect(files).toContain("index.ts");
    for (const f of files) expect(forbiddenTokens(readFileSync(join(dir, f), "utf8")), f).toEqual([]);
  });
});

describe("BUILD", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function tree(buildInfo?: string): URL {
    root = mkdtempSync(join(tmpdir(), "gw-build-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    if (buildInfo !== undefined) writeFileSync(join(root, "dist", "build-info.json"), buildInfo);
    return pathToFileURL(join(root, "dist") + "/");
  }

  it("from source: the package version and no build commit", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(BUILD).toEqual({ version: pkg.version, buildCommit: null });
  });

  it("reads build-info.json written by scripts/build-info.ts", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(readBuild(tree(JSON.stringify({ version: "1.2.3", buildCommit: commit })))).toEqual({
      version: "1.2.3",
      buildCommit: commit,
    });
  });

  it("falls back to package.json when build-info.json is absent", () => {
    expect(readBuild(tree())).toEqual({ version: "1.2.3", buildCommit: null });
  });

  it.each([
    [JSON.stringify({ version: "1.2.3", buildCommit: "abc" }), /no full git commit hash/],
    [JSON.stringify({ buildCommit: "0".repeat(40) }), /no version/],
  ])("rejects a malformed build-info.json: %s", (text, message) => {
    expect(() => readBuild(tree(text))).toThrow(message);
  });

  it("rejects a package.json without a version", () => {
    const url = tree();
    writeFileSync(join(root ?? "", "package.json"), "{}");
    expect(() => readBuild(url)).toThrow(/no version/);
  });
});
