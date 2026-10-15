// The production verifier against real data: a provenance bundle recorded from the public npm registry
// (sigstore@5.0.0, built by its own release workflow) and the Sigstore public-good trusted root recorded from TUF.
// This proves the same code path accepts a genuine bundle under the public root, and refuses it for our identity.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { GITHUB_OIDC_ISSUER, loadVerifier, releaseIdentity, verifyAttestation } from "./attestation.ts";
import { CheckFailure } from "./result.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/supplychain/${name}`, import.meta.url), "utf8"));
const realBundle = fixture("sigstore-5.0.0-provenance.json");
const publicGoodRoot = fixture("public-good-trusted-root.json");
const REAL_SAN = "https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main";

describe("verifyAttestation on a recorded public-good bundle", () => {
  test("verifies and returns the signed SLSA statement for its real signer", async () => {
    const verifier = await loadVerifier(publicGoodRoot);
    const statement = verifyAttestation(realBundle, verifier, REAL_SAN);
    expect(statement.predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(statement.subject).toEqual([
      {
        name: "pkg:npm/sigstore@5.0.0",
        digest: {
          sha512:
            "849a897e81bf7b8a8541a6ae40bd3473a27a16b1cb0462ad905bd6dc96d34881053a12eb4a375233f81677fc9439f628fe0b0445e8535c60b5559597fbd5f80e",
        },
      },
    ]);
  });

  test("refuses it as identity-mismatch against the gateway's release identity", async () => {
    const verifier = await loadVerifier(publicGoodRoot);
    const ours = releaseIdentity("5.0.0") ?? "";
    expect(() => verifyAttestation(realBundle, verifier, ours)).toThrow(
      expect.objectContaining({ reason: "identity-mismatch" }) as CheckFailure,
    );
  });
});

describe("releaseIdentity", () => {
  test("is the release workflow at the version tag, with the GitHub OIDC issuer", () => {
    expect(releaseIdentity("0.1.0-preview.1")).toBe(
      "https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/tags/v0.1.0-preview.1",
    );
    expect(GITHUB_OIDC_ISSUER).toBe("https://token.actions.githubusercontent.com");
  });

  test("refuses versions that are not release versions", () => {
    for (const v of ["", "1.2", "v1.2.3", "1.2.3@refs/heads/main", "1.2.3 "]) expect(releaseIdentity(v)).toBeUndefined();
  });
});
