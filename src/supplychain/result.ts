// Every supplychain result is a "self-check": the code doing the checking is the installed code being checked, so a
// tampered install could also tamper with this check. The result therefore always names an outside check to run.

/** Why a self-check failed. Each name is stable; `verify` and tests match on it. */
export type FailureReason =
  | "package-unreadable" // the installed package.json is missing or has no valid name/version
  | "not-published" // the registry has no such package or version (404, or a packument that does not list it)
  | "ref-invalid" // the image reference is not a digest reference to the gateway image
  | "registry-error" // the registry did not answer, answered non-2xx, or served content that does not match its digest
  | "trust-root-unavailable" // the Sigstore trusted root could not be loaded
  | "attestation-missing" // the registry lists no provenance attestation for this version
  | "bundle-invalid" // the attestation is not a well-formed Sigstore DSSE bundle
  | "signature-invalid" // the bundle's certificate chain, transparency-log entry or signature does not verify
  | "identity-mismatch" // signed by a workflow other than the gateway's release workflow at this version's tag
  | "issuer-mismatch" // the signing certificate was not issued for a GitHub Actions OIDC token
  | "statement-invalid" // the signed payload is not the expected in-toto statement
  | "digest-mismatch" // the signed subject digest differs from the artifact's digest
  | "tarball-integrity-mismatch" // the downloaded tarball does not match the registry's dist.integrity
  | "file-mismatch" // an installed file differs from the same file in the signed tarball
  | "file-missing" // a file in the signed tarball is absent from the install
  | "file-extra" // the install holds a file the signed tarball does not
  | "signature-missing" // no valid image signature by the release workflow was found
  | "sbom-missing"; // no valid CycloneDX SBOM attestation by the release workflow was found

export interface Failure {
  reason: FailureReason;
  detail: string;
}

export interface SelfCheckOptions {
  /** HTTP transport; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Clock; defaults to the system clock. */
  now?: () => Date;
  /** Sigstore trusted root (protobuf JSON); defaults to the public-good root fetched through Sigstore TUF. */
  trustedRoot?: unknown;
}

export interface SelfCheckResult {
  /** Always "self-check": this ran inside the installed code it checks. */
  label: "self-check";
  kind: "npm-provenance" | "image-signature";
  /** `name@version` for npm, the digest reference for the image. */
  subject: string;
  ok: boolean;
  failures: readonly Failure[];
  /** ISO time the check ran, from the injected clock. */
  checkedAt: string;
  /** Commands that check the same artifact from outside the installed code. */
  outsideChecks: readonly string[];
}

/** A failure that ends the check. Internal to the module; results carry `Failure` values instead. */
export class CheckFailure extends Error {
  readonly reason: FailureReason;
  /** The HTTP status when the failure is a non-2xx answer. */
  readonly status: number | undefined;
  constructor(reason: FailureReason, detail: string, status?: number) {
    super(detail);
    this.reason = reason;
    this.status = status;
  }
}

export function toFailure(err: unknown): Failure {
  if (err instanceof CheckFailure) return { reason: err.reason, detail: err.message };
  throw err;
}

const KIND_TEXT = { "npm-provenance": "npm provenance", "image-signature": "image signature and SBOM" } as const;

/** Human-readable lines for the CLI. The first line always starts with "self-check:". */
export function formatSelfCheck(result: SelfCheckResult): string {
  const lines = [`self-check: ${KIND_TEXT[result.kind]} of ${result.subject}: ${result.ok ? "ok" : "FAILED"}`];
  for (const f of result.failures) lines.push(`  ${f.reason}: ${f.detail}`);
  lines.push("  This check runs inside the installed code. Confirm it from outside with:");
  for (const cmd of result.outsideChecks) lines.push(`    ${cmd}`);
  return lines.join("\n") + "\n";
}
