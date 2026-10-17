import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { describeBuild, readBuild } from "./build.ts";
import { BUILD, ConfigError, loadConfig, PINNED_HOSTS, type LoadOptions } from "./index.ts";

// Most cases pass --trust-keys, so they hold for any host; the cloud trust cases below cover the pins.
const TRUST = ["--trust-keys", "/keys/root.jwk"];
const LINUX: LoadOptions = { platform: "linux", homedir: "/home/dev", cwd: "/work" };

/** Intent Cloud staging's root public key, as docs/release.md has the release pin it. */
const STAGING_ROOT = { kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: "7-sDUcgqFgaDKZvWfEjmnhcntLrcrnNVlM1VFyGHFoI" } };

/** A host pinned with no root key, as a host is before its release commits one; added only for `run`. */
const EMPTY_PIN_URL = "https://empty-pin.example";
function withEmptyPin<T>(run: () => T): T {
  const pins = PINNED_HOSTS as Record<string, { rootKeys: unknown[] }>;
  pins["empty-pin.example"] = { rootKeys: [] };
  try {
    return run();
  } finally {
    delete pins["empty-pin.example"];
  }
}

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

  // Attack: a quoted `~` would otherwise become `$CWD/~/gw`, a data dir the developer never chose.
  it.each([
    ["INTENT_DATA_DIR", "~/gw"],
    ["INTENT_DATA_DIR", "~"],
    ["INTENT_DATA_DIR", "~dev/gw"],
    ["INTENT_POLICY", "~/policy.yaml"],
  ])("refuses %s=%j with a leading ~", (name, value) => {
    expect(() => load({ [name]: value })).toThrow(new RegExp(`${name} starts with ~`));
  });

  it("refuses --trust-keys with a leading ~", () => {
    expect(() => load({}, LINUX, ["--trust-keys=~/root.jwk"])).toThrow(/--trust-keys starts with ~/);
  });

  it("keeps a ~ that is not leading", () => {
    expect(load({ INTENT_DATA_DIR: "/srv/a~b" }).dataDir).toBe("/srv/a~b");
  });

  it("refuses a relative LOCALAPPDATA on Windows", () => {
    const win: LoadOptions = { platform: "win32", homedir: "C:\\Users\\dev", cwd: "C:\\work" };
    expect(() => load({ LOCALAPPDATA: "AppData\\Local" }, win)).toThrow(/LOCALAPPDATA is not an absolute path/);
    expect(load({ LOCALAPPDATA: "AppData\\Local", INTENT_DATA_DIR: "D:\\gw" }, win).dataDir).toBe("D:\\gw");
  });

  it("uses the real platform when none is injected", () => {
    expect(loadConfig({ INTENT_DATA_DIR: "/abs" }, TRUST).dataDir).toMatch(/abs$/);
  });
});

describe("environment validation", () => {
  it.each([
    ["INTENT_DATADIR", "/x"],
    ["INTENT_HTTP_TOKN", "x".repeat(40)],
    ["INTENT_DEBUGGING", "1"],
  ])("rejects the unknown variable %s", (name, value) => {
    expect(() => load({ [name]: value })).toThrow(new RegExp(`unknown environment variable ${name}`));
  });

  it.each([
    ["INTENT_DEMO", "demo"],
    ["INTENT_DEBUG", "debug"],
  ] as const)("%s=1 sets %s; unset is false; any other value is refused", (name, key) => {
    expect(load({})[key]).toBe(false);
    expect(load({ [name]: "1" })[key]).toBe(true);
    expect(() => load({ [name]: "true" })).toThrow(new RegExp(`${name} must be 1 or unset`));
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
    ["INTENT_CLOUD_URL", "http://localhost:4000", /INTENT_CLOUD_URL must use https/],
    ["INTENT_CLOUD_URL", "http://127.0.0.2:4000", /INTENT_CLOUD_URL must use https/],
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

  it("accepts a variable the caller owns only when it names it in settings, and still refuses it empty", () => {
    expect(() => loadConfig({ INTENT_OWNED: "1" }, TRUST, LINUX)).toThrow(/unknown environment variable INTENT_OWNED/);
    expect(() => loadConfig({ INTENT_OWNED: "1" }, TRUST, { ...LINUX, settings: ["INTENT_OWNED"] })).not.toThrow();
    expect(() => loadConfig({ INTENT_OWNED: "" }, TRUST, { ...LINUX, settings: ["INTENT_OWNED"] })).toThrow(/INTENT_OWNED is set but empty/);
    expect(() => loadConfig({ INTENT_OTHER: "1" }, TRUST, { ...LINUX, settings: ["INTENT_OWNED"] })).toThrow(/known: .*INTENT_OWNED/);
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

  // `localhost` is a name the system resolves (hosts file, DNS search), so it can bind off-loopback: it needs a
  // token, as do other loopback spellings, which are treated as off-loopback.
  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "gateway.example",
    "::ffff:127.0.0.1",
    "localhost",
    "LOCALHOST",
    "127.8.9.10",
    "0:0:0:0:0:0:0:1",
  ])("rejects non-loopback host %s without a token, naming the variable", (host) => {
    expect(() => load({ INTENT_HTTP_HOST: host })).toThrow(/INTENT_HTTP_TOKEN is required/);
  });

  it.each(["127.0.0.1", "::1"])("allows loopback host %s without a token", (host) => {
    expect(load({ INTENT_HTTP_HOST: host }).http.token).toBeNull();
  });

  it.each([
    "localhost",
    "fe80::1",
    "2001:db8::8a2e:370:7334",
    "::ffff:192.0.2.1",
    "gw-1.internal.example",
    "1:2:3:4:5:6:7:8",
    "1:2:3:4:5:6:7::",
    "::",
    "::1.2.3.4",
  ])("accepts host %s with a token", (host) => {
    expect(load({ INTENT_HTTP_HOST: host, INTENT_HTTP_TOKEN: token }).http.host).toBe(host);
  });

  it.each([
    ":::::",
    "1:2:3:4:5:6:7:8:9",
    "::1::",
    "12345::",
    "::g",
    "fe80::1%eth0",
    "[::1]",
    "999.1.1.1",
    "1.2.3",
    "-a.example",
    "a..b",
    "a_b",
    "1:2:3:4:5:6:7",
    "1::2:3:4:5:6:7:8",
    "1.2.3.4::",
    "::1.2.3.4:5",
    "1:::2",
  ])("rejects the malformed host %j", (host) => {
    expect(() => load({ INTENT_HTTP_HOST: host, INTENT_HTTP_TOKEN: token })).toThrow(
      /INTENT_HTTP_HOST must be an IP address or host name/,
    );
  });

  it("accepts a non-loopback host with a token", () => {
    expect(load({ INTENT_HTTP_HOST: "0.0.0.0", INTENT_HTTP_PORT: "9000", INTENT_HTTP_TOKEN: token }).http).toEqual({
      host: "0.0.0.0",
      port: 9000,
      token,
    });
  });
});

describe("wallet settings", () => {
  const KEY = "q".repeat(43) + "=";

  it("takes INTENT_WALLET_KEY_FILE first, resolved against the working directory", () => {
    expect(load({ INTENT_WALLET_KEY_FILE: "secrets/wallet" }).wallet).toMatchObject({ key: { kind: "file", path: "/work/secrets/wallet" }, envKeyIgnored: false });
    const both = load({ INTENT_WALLET_KEY_FILE: "/run/secrets/wallet", INTENT_WALLET_KEY: KEY }).wallet;
    expect(both).toMatchObject({ key: { kind: "file", path: "/run/secrets/wallet" }, envKeyIgnored: true });
    expect(() => load({ INTENT_WALLET_KEY_FILE: "~/wallet" })).toThrow(/INTENT_WALLET_KEY_FILE starts with ~/);
  });

  it("attack: refuses an INTENT_WALLET_KEY_FILE inside the data dir, where it would sit beside the vault", () => {
    expect(() => load({ INTENT_DATA_DIR: "/data", INTENT_WALLET_KEY_FILE: "/data/wallet-key" })).toThrow(/INTENT_WALLET_KEY_FILE .* is inside the data dir/);
    expect(() => load({ INTENT_DATA_DIR: "/data", INTENT_WALLET_KEY_FILE: "/data/wallet/../k" })).toThrow(ConfigError);
    expect(() => load({ INTENT_RUNTIME: "container", INTENT_WALLET_KEY_FILE: "/data/secrets/k" })).toThrow(/inside the data dir/);
    // A sibling whose name starts like the data dir is outside it.
    expect(load({ INTENT_DATA_DIR: "/data", INTENT_WALLET_KEY_FILE: "/data-keys/k" }).wallet.key).toEqual({ kind: "file", path: "/data-keys/k" });
    expect(load({ INTENT_DATA_DIR: "/data", INTENT_WALLET_KEY_FILE: "/..data/k" }).wallet.key).toEqual({ kind: "file", path: "/..data/k" });
  });

  it("takes INTENT_WALLET_KEY next, and never prints its value", () => {
    const config = load({ INTENT_WALLET_KEY: KEY });
    expect(config.wallet.key.kind).toBe("env");
    expect(config.wallet.key.kind === "env" && config.wallet.key.value.reveal()).toBe(KEY);
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(String(config.wallet.key.kind === "env" ? config.wallet.key.value : "")).toBe("[redacted]");
    expect(load({ INTENT_WALLET_KEY: "ab".repeat(32) }).wallet.key.kind).toBe("env");
  });

  it("refuses an INTENT_WALLET_KEY that is not 32 bytes of base64 or hex, without echoing it", () => {
    for (const bad of ["hunter2-secret", "q".repeat(42) + "=", "zz".repeat(32)]) {
      let message = "";
      try {
        load({ INTENT_WALLET_KEY: bad });
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message).toContain("INTENT_WALLET_KEY must be 32 random bytes");
      expect(message).not.toContain(bad);
    }
  });

  it.each([
    ["Linux", {}, LINUX, "/home/dev/.config/intent-gateway/wallet-key"],
    ["Linux XDG_CONFIG_HOME", { XDG_CONFIG_HOME: "/xdg-config" }, LINUX, "/xdg-config/intent-gateway/wallet-key"],
    ["relative XDG_CONFIG_HOME is ignored", { XDG_CONFIG_HOME: "cfg" }, LINUX, "/home/dev/.config/intent-gateway/wallet-key"],
    ["macOS", {}, { platform: "darwin", homedir: "/Users/dev", cwd: "/work" }, "/Users/dev/Library/Preferences/intent-gateway/wallet-key"],
    ["Windows", { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" }, { platform: "win32", homedir: "C:\\Users\\dev", cwd: "C:\\work" }, "C:\\Users\\dev\\AppData\\Roaming\\intent-gateway\\wallet-key"],
  ] as const)("defaults the key file outside the data dir: %s", (_name, env, options, expected) => {
    const config = load(env, options);
    expect(config.wallet.key).toEqual({ kind: "default", path: expected });
    expect(expected.startsWith(config.dataDir)).toBe(false);
  });

  it("has no default key in the Docker image or inside the data dir", () => {
    const container = load({ INTENT_RUNTIME: "container" }).wallet.key;
    expect(container).toMatchObject({ kind: "none" });
    expect(container.kind === "none" && container.reason).toContain("INTENT_WALLET_KEY_FILE");
    const inside = load({ INTENT_DATA_DIR: "/home/dev/.config" }).wallet.key;
    expect(inside).toMatchObject({ kind: "none" });
    expect(load({ INTENT_RUNTIME: "container", INTENT_WALLET_KEY_FILE: "/run/secrets/w" }).wallet.key).toEqual({ kind: "file", path: "/run/secrets/w" });
  });

  it("checks the Shop URLs: https, or http on loopback only", () => {
    expect(load({}).wallet).toMatchObject({ shopMcpUrl: null, shopAuthUrl: null });
    expect(load({ INTENT_SHOP_MCP_URL: "https://shop.example/mcp", INTENT_SHOP_AUTH_URL: "http://127.0.0.1:9000/" }).wallet).toMatchObject({
      shopMcpUrl: "https://shop.example/mcp",
      shopAuthUrl: "http://127.0.0.1:9000/",
    });
    expect(() => load({ INTENT_SHOP_MCP_URL: "http://shop.example/mcp" })).toThrow(/INTENT_SHOP_MCP_URL must use https/);
    expect(() => load({ INTENT_SHOP_AUTH_URL: "not a url" })).toThrow(/INTENT_SHOP_AUTH_URL is not a URL/);
    // An unparsable value is not echoed: it may carry a credential.
    expect(() => load({ INTENT_SHOP_MCP_URL: "shop.example/mcp?token=SECRET" })).toThrow(/^(?!.*SECRET).*INTENT_SHOP_MCP_URL is not a URL/);
    expect(() => load({ INTENT_SHOP_AUTH_URL: "https://u:p@shop.example/" })).toThrow(/must not carry credentials/);
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

  it("loads the pinned cloud-root-1 key for the default host, with no --trust-keys", () => {
    expect(load({}, LINUX, []).cloud).toEqual({
      url: "https://staging-api.intentai.shop",
      trust: { kind: "pinned", host: "staging-api.intentai.shop", rootKeys: [STAGING_ROOT] },
    });
    // The offline commands see the same pin.
    expect(load({}, { ...LINUX, requireTrust: false }, []).cloud.trust).toEqual({ kind: "pinned", host: "staging-api.intentai.shop", rootKeys: [STAGING_ROOT] });
  });

  it("refuses a host whose pin lists no root key, naming the demo and --trust-keys", () => {
    withEmptyPin(() => {
      expect(() => load({ INTENT_CLOUD_URL: EMPTY_PIN_URL }, LINUX, [])).toThrow(
        "this build has no trusted root key for empty-pin.example yet. Try everything locally now with intent demo, or pass --trust-keys <file> for a self-hosted Intent Cloud",
      );
    });
  });

  it("in the container, the unpinned-host hints re-run it in demo mode, never docker exec into it (F-h)", () => {
    const container = { INTENT_RUNTIME: "container", HOSTNAME: "d3394f0ffd41" };
    const empty = withEmptyPin(() => {
      try {
        load({ ...container, INTENT_CLOUD_URL: EMPTY_PIN_URL }, LINUX, []);
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    });
    expect(empty).toBe(
      "this build has no trusted root key for empty-pin.example yet. " +
        "Try everything locally now: re-run the container in demo mode: docker rm d3394f0ffd41 && " +
        "docker run -d --name intent -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 -e INTENT_DEMO=1 -v intent-data:/data intent-gateway; " +
        'or, for a self-hosted Intent Cloud, mount its root key file: docker run … -v "$PWD/keys.json:/keys.json:ro" intent-gateway --trust-keys /keys.json',
    );
    expect(() => load({ ...container, INTENT_CLOUD_URL: "https://cloud.example" }, LINUX, [])).toThrow(/not a pinned Intent Cloud host; mount its root key file .+ -e INTENT_DEMO=1 /);
    expect(() => load({ ...container, INTENT_CLOUD_URL: "https://cloud.example" }, LINUX, [])).not.toThrow(/docker exec/);
  });

  it("with requireTrust false, an unpinned host is reported instead of refused (offline commands)", () => {
    const config = withEmptyPin(() => load({ INTENT_CLOUD_URL: EMPTY_PIN_URL }, { ...LINUX, requireTrust: false }, []));
    expect(config.cloud.trust).toEqual({
      kind: "unpinned",
      host: "empty-pin.example",
      reason: "this build has no trusted root key for empty-pin.example yet. Try everything locally now with intent demo, or pass --trust-keys <file> for a self-hosted Intent Cloud",
    });
    expect(load({ INTENT_CLOUD_URL: "https://cloud.example" }, { ...LINUX, requireTrust: false }, []).cloud.trust).toMatchObject({
      kind: "unpinned",
      reason: expect.stringMatching(/not a pinned Intent Cloud host/) as unknown,
    });
    // A bad URL is still refused: requireTrust only relaxes the missing pin.
    expect(() => load({ INTENT_CLOUD_URL: "http://cloud.example" }, { ...LINUX, requireTrust: false }, [])).toThrow(/must use https/);
  });

  it("refuses an empty pin even when other arguments are present", () => {
    withEmptyPin(() => {
      expect(() => load({ INTENT_CLOUD_URL: EMPTY_PIN_URL }, LINUX, ["serve", "--trust-keys-x", "k"])).toThrow(ConfigError);
    });
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

/** The published test root (src/demo, the fake Intent Cloud): its private seed is public, so no host may pin it. */
const TEST_ROOT_X = "F0VTtFbd38aQjsqxwQH-arIeK6oGF3lbfUOmNIKZP9U";

/** Why a pin is not `{ rootKeys: [{ kid: cloud-root-1, jwk: { kty: OKP, crv: Ed25519, x } }] }`, or [] when it is. */
function pinProblems(pin: unknown): string[] {
  const problems: string[] = [];
  const p = pin as { rootKeys?: unknown };
  if (Object.keys(p).join() !== "rootKeys" || !Array.isArray(p.rootKeys)) return ["not { rootKeys: [...] }"];
  for (const key of p.rootKeys as { kid?: unknown; jwk?: Record<string, unknown> }[]) {
    if (Object.keys(key).sort().join() !== "jwk,kid") problems.push("key has fields other than kid and jwk");
    if (key.kid !== "cloud-root-1") problems.push(`kid ${String(key.kid)}`);
    const jwk = key.jwk ?? {};
    for (const secret of ["d", "p", "q", "dp", "dq", "qi", "k"]) {
      if (Object.hasOwn(jwk, secret)) problems.push(`private field ${secret}`);
    }
    const extra = Object.keys(jwk).filter((f) => !["kty", "crv", "x", "d", "p", "q", "dp", "dq", "qi", "k"].includes(f));
    if (extra.length > 0) problems.push(`jwk fields ${extra.join(", ")}`);
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") problems.push("not an Ed25519 public key");
    if (typeof jwk.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)) problems.push("x is not 32 bytes of base64url");
    if (jwk.x === TEST_ROOT_X) problems.push("the published test root");
  }
  return problems;
}

describe("PINNED_HOSTS holds only root public keys", () => {
  it("the shape check catches a private key, another kid, the test root or an extra field (attack cases)", () => {
    const pub = { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) };
    expect(pinProblems({ rootKeys: [{ kid: "cloud-root-1", jwk: pub }] })).toEqual([]);
    expect(pinProblems({ rootKeys: [{ kid: "cloud-root-1", jwk: { ...pub, d: "secret" } }] })).toEqual(["private field d"]);
    expect(pinProblems({ rootKeys: [{ kid: "cloud-root-1", jwk: { kty: "oct", k: "secret" } }] })).toEqual([
      "private field k",
      "not an Ed25519 public key",
      "x is not 32 bytes of base64url",
    ]);
    expect(pinProblems({ rootKeys: [{ kid: "signing-1", jwk: pub }] })).toEqual(["kid signing-1"]);
    expect(pinProblems({ rootKeys: [{ kid: "cloud-root-2", jwk: pub }] })).toEqual(["kid cloud-root-2"]);
    expect(pinProblems({ rootKeys: [{ kid: "cloud-root-1", jwk: { ...pub, x: TEST_ROOT_X } }] })).toEqual(["the published test root"]);
    expect(pinProblems({ rootKeys: [{ kid: "cloud-root-1", jwk: { ...pub, alg: "EdDSA" } }] })).toEqual(["jwk fields alg"]);
    expect(pinProblems({ rootKeys: [{ kid: "cloud-root-1", jwk: { ...pub, x: "AAAA" } }] })).toEqual(["x is not 32 bytes of base64url"]);
    expect(pinProblems({ rootKeys: [], confirmOrigin: "x" })).toEqual(["not { rootKeys: [...] }"]);
    expect(pinProblems({ rootKeys: [{ kid: "cloud-root-1", jwk: pub, origin: "x" }] })).toEqual([
      "key has fields other than kid and jwk",
    ]);
  });

  it("attack: no host ever pins the published test root, whose private seed is public (R3-8)", () => {
    for (const [host, pin] of Object.entries(PINNED_HOSTS)) {
      expect(pin.rootKeys.map((k) => k.jwk.x), host).not.toContain(TEST_ROOT_X);
    }
  });

  it("the staging host pins exactly the release's cloud-root-1 public key", () => {
    expect(PINNED_HOSTS["staging-api.intentai.shop"]).toEqual({ rootKeys: [STAGING_ROOT] });
  });

  it("every entry is { rootKeys: [{ kid: cloud-root-1, public jwk }] }", () => {
    // Non-vacuous: there is a pin to check.
    expect(Object.keys(PINNED_HOSTS).length).toBeGreaterThan(0);
    for (const [host, pin] of Object.entries(PINNED_HOSTS)) {
      expect(pinProblems(pin), host).toEqual([]);
      expect(pin.rootKeys.length, `${host} pins no root key`).toBeGreaterThan(0);
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
    const files = configSources();
    for (const [f, source] of files) expect(forbiddenTokens(source), f).toEqual([]);
  });
});

/** The non-test .ts files of src/config, by relative path. */
function configSources(): Map<string, string> {
  const dir = import.meta.dirname;
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  return new Map(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

// Hosts come from PINNED_HOSTS (with root keys) or from the developer's own INTENT_CLOUD_URL and --trust-keys. A
// URL or host literal anywhere else in this module would be a host trusted without a pin.
const FILE_NAME = /\.(?:json|ya?ml|lock|ts|js)$/;
const HOST_LIKE = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+\.?$/i;

function hostLiterals(source: string): string[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) {
      const text = node.text;
      const words = text.split(/[\s"'`()[\]{},;<>]+/).map((w) => w.replace(/[.:]+$/, ""));
      if (text.includes("://") || words.some((w) => HOST_LIKE.test(w) && !FILE_NAME.test(w))) found.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("no URL or host literal in src/config except the pinned hosts", () => {
  const pinned = Object.keys(PINNED_HOSTS);
  const allowed = new Set([...pinned, ...pinned.map((h) => `https://${h}`), "127.0.0.1"]);

  it("the scanner catches each kind of URL or host literal (attack cases)", () => {
    expect(hostLiterals(`const a = "https://cloud.example";`)).toEqual(["https://cloud.example"]);
    expect(hostLiterals(`const b = "api.cloud.example";`)).toEqual(["api.cloud.example"]);
    expect(hostLiterals("const c = `wss://${h}/x`;")).toEqual(["wss://"]);
    expect(hostLiterals(`const d = { "cloud.example": 1 };`)).toEqual(["cloud.example"]);
    expect(hostLiterals(`const e = "connect to gw.example now";`)).toEqual(["connect to gw.example now"]);
    expect(hostLiterals(`const f = "10.0.0.1";`)).toEqual(["10.0.0.1"]);
    expect(hostLiterals(`const g = "policy.yaml"; const h = "build-info.json"; // see https://x.example`)).toEqual([]);
  });

  it("src/config holds only the pinned host literals", () => {
    const files = configSources();
    // Non-vacuous: the module's files were read, and the scan sees the pinned host where it is declared.
    expect([...files.keys()].sort()).toEqual(["build.ts", "index.ts", "invocation.ts"]);
    const found = [...files.values()].flatMap(hostLiterals);
    for (const host of pinned) expect(found).toContain(host);
    expect(found.filter((literal) => !allowed.has(literal))).toEqual([]);
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
    expect(BUILD).toEqual({ version: pkg.version, buildCommit: null, dirty: false });
  });

  it("reads build-info.json written by scripts/build-info.ts", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(readBuild(tree(JSON.stringify({ version: "1.2.3", buildCommit: commit, dirty: false })))).toEqual({
      version: "1.2.3",
      buildCommit: commit,
      dirty: false,
    });
  });

  it("reads a dirty build as no build commit", () => {
    expect(readBuild(tree(JSON.stringify({ version: "1.2.3", buildCommit: null, dirty: true })))).toEqual({
      version: "1.2.3",
      buildCommit: null,
      dirty: true,
    });
  });

  // A plain `docker build` with no BUILD_COMMIT (F-i): the commit is unknown, and nothing may claim one.
  it("reads a build that did not know its commit as unknown, never as a commit", () => {
    const build = readBuild(tree(JSON.stringify({ version: "1.2.3", buildCommit: null, dirty: null })));
    expect(build).toEqual({ version: "1.2.3", buildCommit: null, dirty: null });
    expect(describeBuild(build)).toBe("1.2.3, commit unknown (local build without BUILD_COMMIT)");
  });

  it("describes each kind of build without naming a commit it does not know", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(describeBuild({ version: "1.2.3", buildCommit: commit, dirty: false })).toBe(`1.2.3, built from commit ${commit}`);
    expect(describeBuild({ version: "1.2.3", buildCommit: null, dirty: true })).toBe("1.2.3, no commit (built from a tree with uncommitted changes)");
    expect(describeBuild({ version: "1.2.3", buildCommit: null, dirty: false })).toBe("1.2.3, no commit (running from source)");
  });

  it("falls back to package.json when build-info.json is absent", () => {
    expect(readBuild(tree())).toEqual({ version: "1.2.3", buildCommit: null, dirty: false });
  });

  it.each([
    [JSON.stringify({ version: "1.2.3", buildCommit: "abc", dirty: false }), /no full git commit hash/],
    [JSON.stringify({ version: "1.2.3", buildCommit: null, dirty: false }), /no full git commit hash/],
    [JSON.stringify({ buildCommit: "0".repeat(40), dirty: false }), /no version/],
    // Attack: a dirty build that still names a commit would let bundled policies claim that commit.
    [JSON.stringify({ version: "1.2.3", buildCommit: "0".repeat(40), dirty: true }), /records a commit for a dirty build/],
    // Attack: an unknown-commit build that also names a commit is refused, not read as that commit.
    [JSON.stringify({ version: "1.2.3", buildCommit: "0".repeat(40), dirty: null }), /did not know its commit/],
    [JSON.stringify({ version: "1.2.3", buildCommit: "unknown", dirty: null }), /did not know its commit/],
    [JSON.stringify({ version: "1.2.3", buildCommit: "0".repeat(40) }), /does not say whether the build tree was dirty/],
    [JSON.stringify({ version: "1.2.3", buildCommit: "0".repeat(40), dirty: "no" }), /does not say whether/],
  ])("rejects a malformed build-info.json: %s", (text, message) => {
    expect(() => readBuild(tree(text))).toThrow(message);
  });

  it("rejects a package.json without a version", () => {
    const url = tree();
    writeFileSync(join(root ?? "", "package.json"), "{}");
    expect(() => readBuild(url)).toThrow(/no version/);
  });
});
