// Contract suite, flows (G23, AC-R1, AC-A1): search → cart → approval with the adapter and a session key, each
// response parsed with the src/contract schemas and carrying a receipt that verifies. On the fake the buyer then
// approves with a software passkey and the proof verifies with src/trust; staging has no phone, so that step is
// fake-only. Every request carries `Intent-Contract-Version: 1.6.0` (the adapter sends it), so the flow is 1.6.0:
// a completer key in the cart request, snapshot v2, and the completer key reading the approval. Runs against TARGET
// (see target.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SoftPasskey } from "../../src/cloud-fake/index.ts";
import { ApprovalCreated, ApprovalStatus, Cart, type CartRequest, SearchResponse, SnapshotV2 } from "../../src/contract/index.ts";
import { canonicalize, sha256Hex } from "../../src/jcs/index.ts";
import { createSession } from "../../src/signing/index.ts";
import { approverFingerprint, type KeySet, verifyApprovalProof } from "../../src/trust/index.ts";
import { closeTargets, IS_FAKE, openTarget, receiptProblem, TARGET, type Target, trustedKeySet } from "./target.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SHIP = { country: "US", postal_code: "94110" } as const;

let target: Target;
let keySet: KeySet;

beforeAll(async () => {
  target = await openTarget();
  keySet = await trustedKeySet(target);
});
afterAll(closeTargets);

/** Search → cart → approval on one session, checking every response. Returns the pending approval. */
async function pendingApproval() {
  const cloud = target.connect();
  const now = target.now();

  const search = await cloud.search({ ship_to: SHIP });
  expect(search.status).toBe(200);
  expect(receiptProblem(search, keySet, now)).toBeNull();
  if (!search.ok) throw new Error("search failed");
  const offers = SearchResponse.parse(search.body).offers;
  expect(offers.length).toBeGreaterThan(0);
  const offer = offers[0];
  if (offer === undefined) throw new Error("no offer");

  // Contract 1.6.0: a per-approval completer key, and the completion modes this caller can use.
  const completer = createSession();
  const request: CartRequest = { offer_handle: offer.offer_handle, quantity: 1, ship_to: SHIP, completer_keyid: completer.keyid, completion_accepts: ["handoff"] };
  const cart = await cloud.createCart(request);
  expect(cart.status).toBe(201);
  expect(receiptProblem(cart, keySet, now)).toBeNull();
  if (!cart.ok) throw new Error("cart failed");
  const cartBody = Cart.parse(cart.body);
  expect(cartBody).toMatchObject({ completion_mode: "handoff", variant_ref: offer.variant_ref, merchant_origin: `https://${cartBody.merchant.domain}` });
  expect(typeof cartBody.total_estimated).toBe("boolean");

  const created = await cloud.createApproval(cartBody.cart_handle);
  expect(created.status).toBe(201);
  expect(receiptProblem(created, keySet, now)).toBeNull();
  if (!created.ok) throw new Error("approval failed");
  const approval = ApprovalCreated.parse(created.body);
  // Appendix A: the snapshot hash is the JCS hash of the snapshot, and the check code its first 8 characters.
  expect(approval.snapshot_hash).toBe(sha256Hex(canonicalize(approval.snapshot)));
  expect(approval.check_code).toBe(approval.snapshot_hash.slice(0, 8));
  expect(approval.snapshot.approval).toBe(approval.approval_handle);
  expect(approval.state).toBe("pending");
  // A 1.6.0 caller gets snapshot v2: offer = cart = snapshot, the 5-digit ZIP and the completer key it sent.
  const snapshot = SnapshotV2.parse(approval.snapshot);
  expect(snapshot).toMatchObject({
    ship_to: SHIP,
    variant_ref: offer.variant_ref,
    merchant_origin: cartBody.merchant_origin,
    completion_mode: cartBody.completion_mode,
    total_estimated: cartBody.total_estimated,
    completer_keyid: completer.keyid,
  });

  const pendingEntry = {
    kind: "approval_pending",
    body: { handle: approval.approval_handle, approval_url: `${keySet.confirmOrigin}${approval.approval_link_path}`, snapshot_hash: approval.snapshot_hash },
  };
  return { cloud, approval, pendingEntry, completer };
}

describe(`flows (${TARGET})`, () => {
  it("search, cart and approval parse with the contract schemas; the approval stays pending with no proof", async () => {
    const { cloud, approval } = await pendingApproval();
    const status = await cloud.getApproval(approval.approval_handle);
    expect(status.status).toBe(200);
    expect(receiptProblem(status, keySet, target.now())).toBeNull();
    if (!status.ok) throw new Error("status failed");
    const body = ApprovalStatus.parse(status.body);
    expect(body.state).toBe("pending");
    expect(body.proof).toBeUndefined();
  });

  it("another session key cannot read the approval (404 with a receipt)", async () => {
    const { approval } = await pendingApproval();
    const intruder = await target.connect().getApproval(approval.approval_handle);
    expect(intruder.status).toBe(404);
    expect(receiptProblem(intruder, keySet, target.now())).toBeNull();
    // Attack: probing handles learns nothing, since another session's handle answers exactly like an unknown one.
    const unknown = await target.connect().getApproval(`ap_${Buffer.alloc(12, 1).toString("base64url")}`);
    expect(intruder.body).toEqual(unknown.body);
    expect(intruder.body).toEqual({ error: "not_found", message: "unknown handle" });
  });

  it("the approval's completer key reads it from another session, as a restarted gateway does (Appendix G R7)", async () => {
    const { approval, completer } = await pendingApproval();
    const read = await target.connect().getApproval(approval.approval_handle, { session: completer });
    expect(read.status).toBe(200);
    expect(receiptProblem(read, keySet, target.now())).toBeNull();
    expect(read.raw.request.headers.find(([k]) => k === "signature-input")?.[1]).toContain(`keyid="${completer.keyid}"`);
    if (!read.ok) throw new Error("status failed");
    expect(ApprovalStatus.parse(read.body).state).toBe("pending");
  });

  it.runIf(IS_FAKE)("passkey approval: the proof verifies with src/trust and names the approving credential", async () => {
    const { cloud, approval, pendingEntry } = await pendingApproval();
    const passkey = new SoftPasskey();
    expect(target.fake?.approveWithPasskey(approval.approval_handle, passkey).state).toBe("approved");
    const status = await cloud.getApproval(approval.approval_handle);
    expect(receiptProblem(status, keySet, target.now())).toBeNull();
    if (!status.ok) throw new Error("status failed");
    const body = ApprovalStatus.parse(status.body);
    expect(body.state).toBe("approved");
    const verified = verifyApprovalProof(body, pendingEntry, keySet, [], target.now());
    if (!verified.ok) throw new Error(`proof does not verify: step ${String(verified.step)} ${verified.reason}`);
    expect(verified.handle).toBe(approval.approval_handle);
    expect(verified.credential.fingerprint).toBe(approverFingerprint(passkey.publicJwk));
    // Attack: the same proof presented again, after its approval entry is chained, is a replay.
    const chain = [pendingEntry, { kind: "approval", body: { handle: approval.approval_handle } }];
    expect(verifyApprovalProof(body, pendingEntry, keySet, chain, target.now())).toMatchObject({ ok: false, reason: "replay" });
  });

  it.runIf(IS_FAKE)("attack: a proof whose snapshot_hash is not the snapshot's hash does not verify", async () => {
    const { cloud, approval, pendingEntry } = await pendingApproval();
    const fake = target.fake;
    if (fake === null) throw new Error("fake only");
    fake.tamper.proofHash();
    try {
      fake.approveWithPasskey(approval.approval_handle, new SoftPasskey());
      const status = await cloud.getApproval(approval.approval_handle);
      if (!status.ok) throw new Error("status failed");
      expect(verifyApprovalProof(status.body, pendingEntry, keySet, [], target.now())).toMatchObject({ ok: false, step: 3 });
    } finally {
      fake.tamper.reset();
    }
  });
});
