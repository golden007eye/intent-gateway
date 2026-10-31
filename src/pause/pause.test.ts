// Pause, unit level (ADR-0023): the signature over the exact bytes, the counter that grows across restarts, the retry
// while Intent Cloud cannot be reached, the resume that waits for a submit's answer, and verify's ordering rules.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPausedRefusal, pauseSigningBytes } from "../contract/index.ts";
import { CloudNetworkError, type DisclosedResult, DisclosureConflictError } from "../disclosure/index.ts";
import type { PauseAccepted, PauseRequest } from "../contract/index.ts";
import { type Entry, openStore, type Store, StoreConflictError } from "../store/index.ts";
import {
  type AccountKey,
  nextCounter,
  nextSendAt,
  noteSubmitAnswer,
  pauseLocally,
  pauseProblems,
  pausedIn,
  pauseState,
  refuseForPause,
  resumeLocally,
  type SendDeps,
  sendPause,
  signPause,
  startPauseRetry,
} from "./index.ts";

const T0 = Date.parse("2026-10-18T12:00:00Z");
// A fixed Ed25519 key (RFC 8032 test 1 seed), so the vector below is reproducible by anyone.
const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A local account key stub for tests only: `intent init` makes the real one. */
function testKey(seed: Buffer = SEED): AccountKey & { x: string } {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const x = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
  // RFC 7638: the required members in lexicographic order, no spaces.
  const thumbprint = createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
  return { x, thumbprint, sign: (message) => edSign(null, message, privateKey) };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function freshStore(clock: { at: number }, dir?: string): Promise<{ store: Store; dir: string }> {
  const where = dir ?? join(await fsp.mkdtemp(join(tmpdir(), "pause-")), "data");
  const store = await openStore(where, { clock: () => clock.at });
  cleanup.push(() => store.close());
  return { store, dir: where };
}

/** A transport that compare-and-appends a `pause` disclosure as the core would, then answers as `answer` says. */
function transport(store: Store, answer: (request: PauseRequest) => "ok" | "down" | { status: number; body: unknown; retryAfter?: number }, sent: PauseRequest[]) {
  return async (request: PauseRequest, unless: (entries: readonly Entry[]) => boolean): Promise<DisclosedResult<PauseAccepted>> => {
    const body = { endpoint: "pause", body_b64: Buffer.from(JSON.stringify(request)).toString("base64") };
    const logged = await store.appendUnless("disclosure", body, unless).catch((error: unknown) => {
      throw error instanceof StoreConflictError ? new DisclosureConflictError("pause") : error;
    });
    sent.push(request);
    const a = answer(request);
    if (a === "down") {
      await store.append("unacknowledged", { disclosure_seq: logged.seq, reason: "CloudNetworkError: not sent (connection refused)" });
      throw new CloudNetworkError("network", {} as never, "Intent Cloud cannot be reached (connection refused)", { neverLeft: true, failure: "connection refused" });
    }
    const status = a === "ok" ? 200 : a.status;
    await store.append("receipt", { disclosure_seq: logged.seq, status, verified: true });
    const common = { receipt: null, contractVersion: "1.7.0", retryAfter: a === "ok" ? null : (a.retryAfter ?? null), raw: {} as never, disclosureSeq: logged.seq };
    if (a === "ok") {
      return { ...common, ok: true, status: 200, body: { state: "paused", account_key_thumbprint: request.account_key_thumbprint, counter: request.counter, paused_at: request.issued_at } };
    }
    return { ...common, ok: false, status, body: a.body as never };
  };
}

function deps(store: Store, clock: { at: number }, connect: SendDeps["connect"], key: AccountKey | null = testKey()): SendDeps {
  return { store, accountKey: () => Promise.resolve(key), connect, now: () => clock.at };
}

const kinds = (store: Store): string[] => store.entries().map((e) => e.kind);
const sentBodies = (store: Store): Record<string, unknown>[] => store.entries().filter((e) => e.kind === "pause_sent").map((e) => e.body as Record<string, unknown>);

describe("the pause signature", () => {
  it("signs exactly 'intent-pause-v1\\n' + JCS({account_key_thumbprint, counter, issued_at, action}), and `action` is not sent", () => {
    const key = testKey();
    const request = signPause(key, 7, "2026-10-18T12:00:00Z");
    const bytes = Buffer.from(pauseSigningBytes(request)).toString("utf8");
    expect(bytes).toBe(`intent-pause-v1\n{"account_key_thumbprint":"${key.thumbprint}","action":"pause","counter":7,"issued_at":"2026-10-18T12:00:00Z"}`);
    expect(Object.keys(request).sort()).toEqual(["account_key_thumbprint", "counter", "issued_at", "signature"]);
    expect(key.thumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
    expect(edVerify(null, Buffer.from(bytes, "utf8"), publicKey, Buffer.from(request.signature, "base64url"))).toBe(true);
    // The vector: RFC 8032 test 1's public key, its thumbprint, and the deterministic signature over these bytes.
    expect(key.x).toBe("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo");
    expect({ thumbprint: key.thumbprint, signature: request.signature }).toMatchSnapshot();
    // One byte changed (counter 8) does not verify.
    const other = Buffer.from(pauseSigningBytes({ ...request, counter: 8 }));
    expect(edVerify(null, other, publicKey, Buffer.from(request.signature, "base64url"))).toBe(false);
  });
});

describe("pause and send", () => {
  it("the local pause holds at once; a send that reaches no one is chained as retrying, and the retry sends again after backoff", async () => {
    const clock = { at: T0 };
    const { store } = await freshStore(clock);
    const sent: PauseRequest[] = [];
    let up = false;
    const d = deps(store, clock, () => Promise.resolve(transport(store, () => (up ? "ok" : "down"), sent)));
    await pauseLocally(store, "cli");
    expect(pausedIn(store.entries())).toBe(true);
    expect(await sendPause(d)).toEqual({ sent: true, result: "retrying", reason: "unreachable" });
    expect(pausedIn(store.entries())).toBe(true);
    expect(sentBodies(store).at(-1)).toMatchObject({ result: "retrying", reason: "unreachable", counter: 1 });

    const retry = startPauseRetry(d, { pollMs: 3_600_000 });
    cleanup.push(() => {
      retry.stop();
      return Promise.resolve();
    });
    clock.at += 1_000;
    await retry.tick();
    expect(sent).toHaveLength(1); // 5 s backoff not over
    clock.at += 5_000;
    await retry.tick();
    expect(sent).toHaveLength(2);
    expect(sentBodies(store).at(-1)).toMatchObject({ result: "retrying", reason: "unreachable", counter: 2 });
    up = true;
    clock.at += 5_000; // 10 s after the second send: the doubled backoff
    await retry.tick();
    expect(sent).toHaveLength(2);
    clock.at += 5_000;
    await retry.tick();
    expect(sent).toHaveLength(3);
    expect(sentBodies(store).at(-1)).toMatchObject({ result: "acknowledged", counter: 3 });
    clock.at += 600_000;
    await retry.tick();
    expect(sent).toHaveLength(3); // acknowledged: nothing more
    expect(pauseProblems(store.entries())).toEqual([]);
  });

  it("the counter grows across restarts, and a 409 counter_replayed carries on from last_counter", async () => {
    const clock = { at: T0 };
    const first = await freshStore(clock);
    const sent: PauseRequest[] = [];
    await pauseLocally(first.store, "cli");
    await sendPause(deps(first.store, clock, () => Promise.resolve(transport(first.store, () => "ok", sent))));
    await resumeLocally(first.store, "cli");
    await first.store.close();

    // A restart: a new handle on the same data dir (the counter lives in the chain, nowhere else).
    const second = await freshStore(clock, first.dir);
    expect(nextCounter(second.store.entries())).toBe(2);
    await pauseLocally(second.store, "panel");
    const replay = (r: PauseRequest) => (r.counter <= 41 ? { status: 409, body: { error: "counter_replayed", message: "replayed", last_counter: 41 } } : ("ok" as const));
    expect(await sendPause(deps(second.store, clock, () => Promise.resolve(transport(second.store, replay, sent))))).toEqual({ sent: true, result: "acknowledged", reason: "acknowledged" });
    expect(sent.map((r) => r.counter)).toEqual([1, 2, 42]);
    expect(sentBodies(second.store).map((b) => [b.counter, b.reason])).toEqual([
      [1, "acknowledged"],
      [2, "counter_replayed"],
      [42, "acknowledged"],
    ]);
    expect(pauseProblems(second.store.entries())).toEqual([]);
  });

  it("404 (key not pinned yet) and 429 keep retrying, Retry-After honoured; 401 is not retried", async () => {
    const clock = { at: T0 };
    const { store } = await freshStore(clock);
    const sent: PauseRequest[] = [];
    let answer: { status: number; body: unknown; retryAfter?: number } = { status: 404, body: { error: "not_found", message: "unknown key" } };
    const d = deps(store, clock, () => Promise.resolve(transport(store, () => answer, sent)));
    await pauseLocally(store, "cli");
    expect(await sendPause(d)).toMatchObject({ result: "retrying", reason: "not_found" });
    answer = { status: 429, body: { error: "rate_limited", message: "slow down" }, retryAfter: 120 };
    clock.at += 5_000;
    expect(await sendPause(d)).toMatchObject({ result: "retrying", reason: "rate_limited" });
    const retry = startPauseRetry(d, { pollMs: 3_600_000 });
    cleanup.push(() => {
      retry.stop();
      return Promise.resolve();
    });
    clock.at += 60_000;
    await retry.tick();
    expect(sent).toHaveLength(2); // Retry-After 120 s, not the 10 s backoff
    answer = { status: 401, body: { error: "unauthorized", message: "bad signature" } };
    clock.at += 61_000;
    await retry.tick();
    expect(sentBodies(store).at(-1)).toMatchObject({ result: "failed", reason: "unauthorized" });
    clock.at += 3_600_000;
    await retry.tick();
    expect(sent).toHaveLength(3);
    expect(pausedIn(store.entries())).toBe(true);
  });

  // serve's retry and `intent pause` on the same data dir (two store handles), each interleaving forced with gates
  // rather than timers, so the outcome does not depend on how loaded the machine is.
  const gate = (): { wait: Promise<void>; open: () => void } => {
    let open = (): void => undefined;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  };
  const waitFor = async (done: () => boolean): Promise<void> => {
    while (!done()) await new Promise((resolve) => setImmediate(resolve));
  };
  const counters = (store: Store): unknown[] => store.entries().filter((e) => e.kind === "pause_sent").map((e) => (e.body as { counter?: unknown }).counter);

  it("attack: both read the same counter before either logs it: only one send carries it, and verify stays clean", async () => {
    const clock = { at: T0 };
    const a = await freshStore(clock);
    const b = await freshStore(clock, a.dir);
    await pauseLocally(a.store, "cli");
    const sent: PauseRequest[] = [];
    const bConnected = gate(); // B may connect
    const bRead = gate(); // B has read its counter and is about to log its send
    const aLogged = gate(); // A's send of counter 1 is logged
    const inFlight = gate(); // A's answer arrives
    // A reads counter 1, then waits until B has read counter 1 too; A logs first, B then tries to log the same counter.
    const connectA = () =>
      Promise.resolve(async (r: PauseRequest, unless: (entries: readonly Entry[]) => boolean) => {
        bConnected.open();
        await bRead.wait;
        const pending = transport(a.store, () => "ok", sent)(r, unless);
        await waitFor(() => a.store.entries().some((e) => e.kind === "disclosure"));
        aLogged.open();
        await inFlight.wait;
        return pending;
      });
    const bCounters: number[] = [];
    const connectB = async () => {
      await bConnected.wait;
      return async (r: PauseRequest, unless: (entries: readonly Entry[]) => boolean) => {
        bCounters.push(r.counter);
        bRead.open();
        await aLogged.wait;
        return transport(b.store, () => "ok", sent)(r, unless);
      };
    };
    const runA = sendPause(deps(a.store, clock, connectA));
    const outB = await sendPause(deps(b.store, clock, connectB));
    inFlight.open();
    await runA;
    // B lost the race for counter 1 (nothing logged or sent), then sent counter 2 while A's was still unanswered.
    expect(bCounters).toEqual([1, 2]);
    expect(outB).toEqual({ sent: true, result: "acknowledged", reason: "acknowledged" });
    expect(sent.map((r) => r.counter).sort()).toEqual([1, 2]);
    expect(new Set(counters(a.store)).size).toBe(counters(a.store).length);
    expect(pauseProblems(a.store.entries())).toEqual([]);
  });

  it("attack: a send that connects after another process's pause was acknowledged sends nothing", async () => {
    const clock = { at: T0 };
    const a = await freshStore(clock);
    const b = await freshStore(clock, a.dir);
    await pauseLocally(a.store, "cli");
    const sent: PauseRequest[] = [];
    const slowB = gate();
    // B starts first (nothing acknowledged yet) but connects only after A's pause was sent and acknowledged.
    const runB = sendPause(
      deps(b.store, clock, async () => {
        await slowB.wait;
        return transport(b.store, () => "ok", sent);
      }),
    );
    expect(await sendPause(deps(a.store, clock, () => Promise.resolve(transport(a.store, () => "ok", sent))))).toEqual({ sent: true, result: "acknowledged", reason: "acknowledged" });
    slowB.open();
    expect(await runB).toEqual({ sent: false, why: "acknowledged" });
    expect(sent.map((r) => r.counter)).toEqual([1]);
    expect(pauseProblems(a.store.entries())).toEqual([]);
  });

  it("a resume chained while the send was connecting stops the send: nothing is logged or sent", async () => {
    const clock = { at: T0 };
    const { store } = await freshStore(clock);
    await pauseLocally(store, "cli");
    const sent: PauseRequest[] = [];
    const outcome = await sendPause(
      deps(store, clock, async () => {
        await resumeLocally(store, "cli");
        return transport(store, () => "ok", sent);
      }),
    );
    expect(outcome).toEqual({ sent: false, why: "not_paused" });
    expect(sent).toEqual([]);
    expect(kinds(store)).not.toContain("disclosure");
  });

  it("attack: a huge Retry-After puts the next send off by 1 hour at most", () => {
    const at = "2026-10-18T12:00:00.000Z";
    const due = nextSendAt({
      paused: { since: at, seq: 0, from: "cli" },
      unconfirmedResume: null,
      cloud: { seq: 1, at, result: "retrying", reason: "rate_limited", retryAfterS: 1_000_000_000 },
      retries: 1,
      refusals: 0,
      cloudSaidPaused: false,
    });
    expect(due).toBe(Date.parse(at) + 3_600_000);
  });

  it("no account key: the pause holds here only, said once", async () => {
    const clock = { at: T0 };
    const { store } = await freshStore(clock);
    const d = deps(store, clock, () => Promise.reject(new Error("never")), null);
    await pauseLocally(store, "cli");
    expect(await sendPause(d)).toEqual({ sent: false, why: "no_account_key" });
    expect(await sendPause(d)).toEqual({ sent: false, why: "no_account_key" });
    expect(sentBodies(store)).toEqual([{ pause_seq: 0, counter: null, disclosure_seq: null, result: "retrying", reason: "no_account_key" }]);
    expect(pausedIn(store.entries())).toBe(true);
  });
});

describe("resume", () => {
  it("clears the local pause only as unconfirmed; the next submit confirms it, or pauses again", async () => {
    const clock = { at: T0 };
    const { store } = await freshStore(clock);
    expect(await resumeLocally(store, "cli")).toBe(false); // nothing to resume
    await pauseLocally(store, "cli");
    expect(await resumeLocally(store, "cli")).toBe(true);
    expect(pauseState(store.entries())).toMatchObject({ paused: null, unconfirmedResume: { seq: 1 } });
    await noteSubmitAnswer(store, { paused: true, disclosureSeq: null });
    expect(pauseState(store.entries()).paused).toMatchObject({ from: "intent_cloud" });
    expect(pauseState(store.entries()).unconfirmedResume).toBeNull();
    await resumeLocally(store, "cli");
    await noteSubmitAnswer(store, { paused: false, disclosureSeq: null });
    expect(pauseState(store.entries())).toMatchObject({ paused: null, unconfirmedResume: null });
    expect(kinds(store)).toEqual(["pause", "resume", "resume_check", "resume", "resume_check"]);
    expect(pauseProblems(store.entries())).toEqual([]);
  });

  it("a gateway refusal is chained only while paused (compare-and-append): a resume chained first wins", async () => {
    const clock = { at: T0 };
    const { store } = await freshStore(clock);
    expect(await refuseForPause(store, { step: "create_cart", source: "gateway" })).toBe(false);
    await pauseLocally(store, "cli");
    expect(await refuseForPause(store, { step: "create_cart", source: "gateway" })).toBe(true);
    expect(pauseState(store.entries()).refusals).toBe(1);
  });
});

describe("verify's pause rules", () => {
  const e = (seq: number, kind: string, body: unknown, ts = "2026-10-18T12:00:00Z"): Entry => ({ seq, prev: "", ts, kind: kind as Entry["kind"], body, hash: "" });
  const counter = (n: number) => Buffer.from(JSON.stringify({ counter: n })).toString("base64");

  it("rejects a resume before its pause, a refusal with no pause, and a resume_check for no resume", () => {
    expect(pauseProblems([e(0, "resume", { from: "cli" }), e(1, "pause", { from: "cli" })])).toEqual(["seq 0: a resume with no pause in effect before it"]);
    expect(pauseProblems([e(0, "refused", { step: "create_cart", reason: "paused", source: "gateway" })])).toEqual([
      "seq 0: the gateway refused as paused with no pause in effect before it",
    ]);
    expect(pauseProblems([e(0, "pause", { from: "cli" }), e(1, "resume_check", { resume_seq: 0, result: "confirmed" })])).toEqual([
      "seq 1: the resume_check names no unconfirmed resume in effect before it",
    ]);
  });

  it("rejects a counter that does not grow, a pause_sent before its pause, and an acknowledgement without a 200 receipt", () => {
    expect(
      pauseProblems([
        e(0, "pause", { from: "cli" }),
        e(1, "disclosure", { endpoint: "pause", body_b64: counter(5) }),
        e(2, "disclosure", { endpoint: "pause", body_b64: counter(5) }),
      ]),
    ).toEqual(["seq 2: the pause counter 5 does not grow (an earlier pause sent 5)"]);
    expect(pauseProblems([e(0, "pause_sent", { pause_seq: 1, counter: null, disclosure_seq: null, result: "retrying", reason: "unreachable" }), e(1, "pause", { from: "cli" })])).toEqual([
      "seq 0: the pause_sent names no earlier pause",
    ]);
    expect(
      pauseProblems([
        e(0, "pause", { from: "cli" }),
        e(1, "disclosure", { endpoint: "pause", body_b64: counter(1) }),
        e(2, "pause_sent", { pause_seq: 0, counter: 1, disclosure_seq: 1, result: "acknowledged", reason: "acknowledged" }),
      ]),
    ).toEqual(["seq 2: the pause_sent is acknowledged without a 200 receipt for its disclosure"]);
  });
});

describe("Intent Cloud's paused refusal", () => {
  const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
  it("is a 409 read by `code`, never by `error`", () => {
    expect(isPausedRefusal(409, null, bytes({ error: "conflict", message: "paused", code: "paused" }))).toBe(true);
    expect(isPausedRefusal(409, { error: "conflict", message: "paused", code: "paused" }, null)).toBe(true);
    expect(isPausedRefusal(409, null, bytes({ error: "paused", message: "paused" }))).toBe(false);
    expect(isPausedRefusal(409, null, bytes({ error: "conflict", message: "replayed" }))).toBe(false);
    expect(isPausedRefusal(400, null, bytes({ error: "conflict", message: "paused", code: "paused" }))).toBe(false);
    expect(isPausedRefusal(409, null, Buffer.from("<html>"))).toBe(false);
  });
});
