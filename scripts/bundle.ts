// Bundles the gateway and its runtime dependencies into dist/ with esbuild (ADR-0013), so the published package
// has no `dependencies` and `npx -y intent-gateway` installs nothing but the package itself. Beside the code it
// writes what the bundled third-party code must carry: dist/THIRD_PARTY_LICENSES (every bundled package with its
// licence and notice files) and dist/sbom.cdx.json (a CycloneDX SBOM of the bundled packages, versions and
// lockfile hashes), because neither npm nor an SBOM scanner can see a package that is compiled into one file.
//
// Layout: dist/main.js is only src/main.ts and src/runtime, so the Node check runs before any dependency code is
// even parsed; it then imports dist/cli/index.js, which holds the rest. Shared code goes to dist/chunks/. Gateway
// code finds policies/, contract/ and build-info.json with `new URL("../../…", import.meta.url)`, written for
// src/<module>/<file>.ts; every output except dist/main.js sits at that same depth (dist/<dir>/<file>.js), so the
// paths resolve the same from the source and from the bundle (test/build.test.ts checks it).
import { readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as esbuild from "esbuild";
import { parseAllDocuments } from "yaml";

/** A third-party package with at least one file in the bundle. */
export interface BundledPackage {
  name: string;
  version: string;
  /** The SPDX expression from its package.json (`license`, or the old `licenses` array), or "UNKNOWN". */
  license: string;
  /** Its folder, relative to the repo. */
  dir: string;
  /** Its repository URL from package.json, when it names one. */
  repository?: string;
  /** Its author from package.json, when it names one. */
  author?: string;
}

export const ENTRY_POINTS = ["src/main.ts", "src/cli/index.ts"];

/**
 * Bundled CommonJS code (the Sigstore packages, ajv) calls `require` for Node built-ins; ESM output has no `require`,
 * so each output file defines one from its own URL. It loads only what the bundle names: every package is inlined.
 */
const BANNER = 'import { createRequire as __intentCreateRequire } from "node:module";\nconst require = __intentCreateRequire(import.meta.url);';

export function buildOptions(repo: string, outdir: string, write: boolean): esbuild.BuildOptions & { metafile: true } {
  return {
    absWorkingDir: repo,
    entryPoints: ENTRY_POINTS,
    outbase: "src",
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    // The floor of package.json `engines` (ADR-0012).
    target: "node22.22",
    chunkNames: "chunks/[name]-[hash]",
    banner: { js: BANNER },
    // Unminified, so the shipped code can be read and audited; licence comments stay where they were.
    legalComments: "inline",
    metafile: true,
    write,
    logLevel: "silent",
  };
}

/** Runs esbuild; with `write` false nothing is written (the licence check uses that). */
export async function bundle(repo: string, outdir: string, write: boolean): Promise<{ packages: BundledPackage[]; result: esbuild.BuildResult<{ metafile: true }> }> {
  const result = await esbuild.build(buildOptions(repo, outdir, write));
  if (result.warnings.length > 0) {
    const text = await esbuild.formatMessages(result.warnings, { kind: "warning" });
    throw new Error(`esbuild warned; a warning here is a runtime require the bundle may not resolve:\n${text.join("\n")}`);
  }
  return { packages: bundledPackages(repo, Object.keys(result.metafile.inputs)), result };
}

/** The packages (`node_modules/<name>` folders) that the esbuild inputs `inputs` come from, sorted by name. */
export function bundledPackages(repo: string, inputs: readonly string[]): BundledPackage[] {
  const dirs = new Set<string>();
  for (const input of inputs) {
    const at = input.lastIndexOf("node_modules/");
    if (at === -1) continue;
    const [first = "", second = ""] = input.slice(at + "node_modules/".length).split("/");
    const name = first.startsWith("@") ? `${first}/${second}` : first;
    dirs.add(`${input.slice(0, at)}node_modules/${name}`);
  }
  return [...dirs].map((dir) => readPackage(repo, dir)).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function readPackage(repo: string, dir: string): BundledPackage {
  const pkg = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license?: string | { type?: string };
    licenses?: { type?: string }[];
    repository?: string | { url?: string };
    author?: string | { name?: string };
  };
  let license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
  if (license === undefined && Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => l.type).filter((t) => typeof t === "string");
    license = types.length === 1 ? types[0] : types.length > 1 ? `(${types.join(" OR ")})` : undefined;
  }
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  return {
    name: pkg.name,
    version: pkg.version,
    license: license ?? "UNKNOWN",
    dir,
    ...(repository === undefined ? {} : { repository }),
    ...(author === undefined ? {} : { author }),
  };
}

/** The licence, copying and notice files of a package folder, sorted. */
function noticeFiles(repo: string, dir: string): string[] {
  return readdirSync(join(repo, dir))
    .filter((f) => /^(licen[cs]e|copying|notice)([.\-_].*)?$/i.test(f))
    .sort();
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** What stands in for the licence file of a package that ships none: what its package.json says, and the text. */
function missingLicence(p: BundledPackage): string {
  const by = p.author === undefined ? "" : ` and names its author, ${p.author}`;
  const head = `The package ships no licence file. Its package.json declares ${p.license}${by}.`;
  if (p.license === "MIT") return `${head} The MIT License:\n\n${p.author === undefined ? "" : `Copyright (c) ${p.author}\n\n`}${MIT_TEXT}`;
  if (p.license === "Apache-2.0") return `${head} The Apache License 2.0 text is in LICENSE at the root of this package.`;
  return `${head} Its text: https://spdx.org/licenses/${p.license}.html`;
}

/** dist/THIRD_PARTY_LICENSES: every bundled package, its licence, and the full text of its licence and notice files. */
export function thirdPartyLicenses(repo: string, gatewayVersion: string, packages: readonly BundledPackage[]): string {
  const rule = "=".repeat(80);
  const parts = [
    `intent-gateway ${gatewayVersion} bundles the third-party packages below into dist/. The gateway itself is\n` +
      "licensed under Apache-2.0 (LICENSE, NOTICE). Each package keeps its own licence, reproduced here as shipped\n" +
      `in the package. ${String(packages.length)} packages.\n`,
  ];
  for (const p of packages) {
    const files = noticeFiles(repo, p.dir);
    const head = [`${p.name} ${p.version}`, `License: ${p.license}`, ...(p.repository === undefined ? [] : [`Repository: ${p.repository}`])].join("\n");
    const texts = files.length === 0 ? [missingLicence(p)] : files.map((f) => `--- ${f} ---\n${readFileSync(join(repo, p.dir, f), "utf8").trimEnd()}`);
    parts.push(`${rule}\n${head}\n\n${texts.join("\n\n")}\n`);
  }
  return parts.join("\n");
}

/**
 * Lockfile integrity per `name@version`, as a hex SHA-512 (CycloneDX hashes are hex). pnpm writes one YAML document
 * for the Node that devEngines.runtime pins and one for the project, so every document is read.
 */
export function lockfileHashes(lockfile: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const doc of parseAllDocuments(lockfile)) {
    if (!("toJS" in doc)) throw new Error("pnpm-lock.yaml is not valid YAML");
    const lock = doc.toJS() as { packages?: Record<string, { resolution?: { integrity?: string } }> } | null;
    for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
      const integrity = entry.resolution?.integrity;
      if (integrity?.startsWith("sha512-") === true) hashes.set(key, Buffer.from(integrity.slice(7), "base64").toString("hex"));
    }
  }
  return hashes;
}

const purl = (name: string, version: string): string => `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;

/**
 * dist/sbom.cdx.json: a CycloneDX 1.6 SBOM whose subject is the gateway and whose components are the bundled
 * packages, with the SHA-512 the lockfile pins for each. No timestamp or serial number, so a rebuild of one commit
 * writes the same bytes (the image must be reproducible, ADR-0010).
 */
export function sbom(gatewayVersion: string, packages: readonly BundledPackage[], hashes: ReadonlyMap<string, string>): string {
  const gateway = purl("intent-gateway", gatewayVersion);
  const components = packages.map((p) => {
    const at = p.name.lastIndexOf("/");
    const hash = hashes.get(`${p.name}@${p.version}`);
    if (hash === undefined) throw new Error(`pnpm-lock.yaml has no integrity for bundled ${p.name}@${p.version}`);
    return {
      type: "library",
      "bom-ref": purl(p.name, p.version),
      ...(at === -1 ? { name: p.name } : { group: p.name.slice(0, at), name: p.name.slice(at + 1) }),
      version: p.version,
      purl: purl(p.name, p.version),
      licenses: [{ expression: p.license }],
      hashes: [{ alg: "SHA-512", content: hash }],
    };
  });
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: { type: "application", "bom-ref": gateway, name: "intent-gateway", version: gatewayVersion, purl: gateway, licenses: [{ expression: "Apache-2.0" }] },
      properties: [{ name: "intent-gateway:bundled", value: "every component is compiled into dist/ of the package; none is installed separately" }],
    },
    components,
    dependencies: [{ ref: gateway, dependsOn: components.map((c) => c["bom-ref"]) }, ...components.map((c) => ({ ref: c["bom-ref"], dependsOn: [] }))],
  };
  return `${JSON.stringify(bom, null, 2)}\n`;
}

/** `pnpm build`: an empty dist/, the bundle, THIRD_PARTY_LICENSES and the SBOM. `pnpm licence-check` checks the licences. */
export async function build(repo: string, outdir = join(repo, "dist")): Promise<BundledPackage[]> {
  rmSync(outdir, { recursive: true, force: true });
  const { packages } = await bundle(repo, outdir, true);
  const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  writeFileSync(join(outdir, "THIRD_PARTY_LICENSES"), thirdPartyLicenses(repo, version, packages));
  writeFileSync(join(outdir, "sbom.cdx.json"), sbom(version, packages, lockfileHashes(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8"))));
  return packages;
}

// `node scripts/bundle.ts [--outdir <dir>]`: the E2E tests bundle into a temporary package folder with --outdir.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  const { values } = parseArgs({ options: { outdir: { type: "string" } } });
  const repo = join(import.meta.dirname, "..");
  const outdir = resolve(values.outdir ?? join(repo, "dist"));
  const packages = await build(repo, outdir);
  console.log(`bundle: ${relative(repo, outdir) || "."} with ${String(packages.length)} third-party packages compiled in`);
}
