// Self-check of an installed npm package: its SLSA provenance was signed by the gateway's release workflow, names
// the tarball the registry serves, and every installed file is the file in that tarball.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { loadVerifier, releaseIdentity, verifyAttestation, isRecord, errorText } from "./attestation.ts";
import { getBytes, getJson } from "./http.ts";
import { CheckFailure, toFailure, type Failure, type SelfCheckOptions, type SelfCheckResult } from "./result.ts";
import { readTarGz } from "./tar.ts";

export interface NpmOptions extends SelfCheckOptions {
  /** Registry base URL; defaults to the public npm registry. */
  registry?: string;
}

export const NPM_REGISTRY = "https://registry.npmjs.org";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const OUTSIDE_NPM = ["npm audit signatures"];

/** Verifies the package installed at `pkgDir`. Never throws for a failed check; the result says why. */
export async function verifyNpm(pkgDir: string, opts: NpmOptions = {}): Promise<SelfCheckResult> {
  const now = opts.now ?? (() => new Date());
  let subject = pkgDir;
  let failures: Failure[];
  try {
    const { name, version } = await readManifest(pkgDir);
    subject = `${name}@${version}`;
    failures = await check(pkgDir, name, version, opts);
  } catch (err) {
    failures = [toFailure(err)];
  }
  return {
    label: "self-check",
    kind: "npm-provenance",
    subject,
    ok: failures.length === 0,
    failures,
    checkedAt: now().toISOString(),
    outsideChecks: OUTSIDE_NPM,
  };
}

async function check(pkgDir: string, name: string, version: string, opts: NpmOptions): Promise<Failure[]> {
  const doFetch = opts.fetch ?? fetch;
  const registry = (opts.registry ?? NPM_REGISTRY).replace(/\/+$/, "");
  const expectedSan = releaseIdentity(version);
  if (expectedSan === undefined) throw new CheckFailure("package-unreadable", `not a release version: ${version}`);
  const escapedName = name.replace("/", "%2f");

  const packument = await getJson(doFetch, `${registry}/${escapedName}`);
  const dist = isRecord(packument) && isRecord(packument.versions) ? packument.versions[version] : undefined;
  if (!isRecord(dist) || !isRecord(dist.dist)) throw new CheckFailure("registry-error", `registry lists no ${name}@${version}`);
  const { integrity, tarball } = dist.dist;
  const sha512 = typeof integrity === "string" ? sha512FromIntegrity(integrity) : undefined;
  if (sha512 === undefined || typeof tarball !== "string") {
    throw new CheckFailure("registry-error", "registry entry lacks a sha512 integrity or a tarball URL");
  }

  // The registry's predicateType field is unsigned; it only selects the bundle, and the signed statement is checked.
  const listing = await getJson(doFetch, `${registry}/-/npm/v1/attestations/${escapedName}@${version}`);
  const attestations = isRecord(listing) && Array.isArray(listing.attestations) ? (listing.attestations as unknown[]) : [];
  const provenance = attestations.find((a) => isRecord(a) && a.predicateType === SLSA_PROVENANCE_V1);
  if (!isRecord(provenance)) throw new CheckFailure("attestation-missing", `no SLSA provenance for ${name}@${version}`);

  const verifier = await loadVerifier(opts.trustedRoot);
  const statement = verifyAttestation(provenance.bundle, verifier, expectedSan);
  if (statement.predicateType !== SLSA_PROVENANCE_V1) {
    throw new CheckFailure("statement-invalid", `predicate type ${statement.predicateType}`);
  }
  const purl = `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
  const signed = statement.subject.find((s) => s.name === purl);
  if (signed?.digest.sha512 !== sha512.toString("hex")) {
    throw new CheckFailure(
      "digest-mismatch",
      `provenance subject ${purl} has sha512 ${String(signed?.digest.sha512)}, registry dist.integrity is ${sha512.toString("hex")}`,
    );
  }

  const tgz = await getBytes(doFetch, tarball);
  if (!createHash("sha512").update(tgz).digest().equals(sha512)) {
    throw new CheckFailure("tarball-integrity-mismatch", `${tarball} does not match dist.integrity`);
  }
  return compareFiles(pkgDir, readTarGz(tgz));
}

async function compareFiles(pkgDir: string, packed: Map<string, Buffer>): Promise<Failure[]> {
  const installed = new Set(await listFiles(pkgDir));
  const failures: Failure[] = [];
  const digest = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
  for (const [path, content] of [...packed].sort(([a], [b]) => a.localeCompare(b))) {
    if (!installed.delete(path)) {
      failures.push({ reason: "file-missing", detail: path });
      continue;
    }
    if (digest(await readFile(join(pkgDir, path))) !== digest(content)) {
      failures.push({ reason: "file-mismatch", detail: path });
    }
  }
  for (const path of [...installed].sort()) failures.push({ reason: "file-extra", detail: path });
  return failures;
}

/** Every file under `dir`, relative and `/`-separated, skipping nested `node_modules` (dependencies, not this package). */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => !e.isDirectory())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .filter((p) => !p.split("/").includes("node_modules"));
}

async function readManifest(pkgDir: string): Promise<{ name: string; version: string }> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
  } catch (err) {
    throw new CheckFailure("package-unreadable", errorText(err));
  }
  if (!isRecord(manifest) || typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new CheckFailure("package-unreadable", "package.json lacks name or version");
  }
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(manifest.name)) {
    throw new CheckFailure("package-unreadable", `not an npm package name: ${manifest.name}`);
  }
  return { name: manifest.name, version: manifest.version };
}

function sha512FromIntegrity(integrity: string): Buffer | undefined {
  const entry = integrity.split(/\s+/).find((e) => e.startsWith("sha512-"));
  return entry === undefined ? undefined : Buffer.from(entry.slice(7), "base64");
}
