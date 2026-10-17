// Parity between src/contract and the vendored spec, and round trips of every contract object in the vectors.
// The spec is the source of truth: each zod schema, turned into JSON Schema, must equal the spec's schema with its
// $refs inlined, keyword by keyword (properties, required, additionalProperties, enum, const, pattern, bounds).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import * as contract from "./index.ts";

const dir = join(import.meta.dirname, "..", "..", "contract");
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
const spec = parse(readFileSync(join(dir, "gateway-api.v1.yaml"), "utf8")) as Obj;
const components = spec["components"] as Record<string, Obj>;
const specSchemas = components["schemas"] as Record<string, Obj>;
const vector = (name: string): Obj => JSON.parse(readFileSync(join(dir, "vectors", name), "utf8")) as Obj;

/**
 * Spec schemas the module deliberately does not cover, each with its reason. Empty in 1.5.0: every schema is reached
 * from one of the seven operations the gateway calls or verifies. A new spec schema must be added to SCHEMAS or here.
 */
const NOT_COVERED: Readonly<Record<string, string>> = {};

/** Spec annotations that do not constrain a value. */
const ANNOTATIONS = new Set(["description", "x-provisional", "example", "examples", "$schema"]);

/** Follows a local `#/components/<kind>/<name>` reference. */
function deref(ref: string): Obj {
  const m = /^#\/components\/([A-Za-z]+)\/([A-Za-z0-9]+)$/.exec(ref);
  if (m === null) throw new Error(`unsupported $ref ${ref}`);
  const target = components[m[1] as string]?.[m[2] as string];
  if (target === undefined) throw new Error(`dangling $ref ${ref}`);
  return target as Obj;
}
const refName = (node: Json): string => {
  const ref = (node as Obj)["$ref"];
  if (typeof ref !== "string") throw new Error(`expected a $ref, got ${JSON.stringify(node)}`);
  return ref.split("/").at(-1) as string;
};

/**
 * One normal form for both sides: $refs inlined, annotations dropped, `required` sorted. zod writes an integer
 * literal as `type: number` and adds the safe-integer bounds to every z.int(); the spec writes `type: integer` and
 * leaves bounds out, so a missing bound on the spec side means ±(2^53−1) (the JCS integer profile, Appendix A).
 */
function normal(node: Json): Json {
  if (Array.isArray(node)) return node.map(normal);
  if (node === null || typeof node !== "object") return node;
  if (typeof node["$ref"] === "string") return normal(deref(node["$ref"]));
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    if (ANNOTATIONS.has(k)) continue;
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as Obj).map(([p, s]) => [p, normal(s)]));
    else if (k === "required") out[k] = [...(v as string[])].sort();
    // RegExp#source escapes "/" as "\\/"; both mean the same character.
    else if (k === "pattern") out[k] = (v as string).replaceAll("\\/", "/");
    else out[k] = normal(v);
  }
  if ("const" in out) {
    if (out["type"] === "number" && Number.isInteger(out["const"])) out["type"] = "integer";
    delete out["minimum"];
    delete out["maximum"];
  } else if (out["type"] === "integer") {
    out["minimum"] ??= -Number.MAX_SAFE_INTEGER;
    out["maximum"] ??= Number.MAX_SAFE_INTEGER;
  }
  return out;
}
// The input side: what the schema accepts. (The output side reports a stripping z.object as closed too.)
const fromZod = (schema: z.ZodType): Json => normal(z.toJSONSchema(schema, { io: "input" }) as Json);

const SCHEMAS = contract.SCHEMAS as Record<string, z.ZodType>;

describe("schema parity with gateway-api.v1.yaml", () => {
  it("covers every spec schema, apart from the documented allow-list", () => {
    const expected = Object.keys(specSchemas).filter((n) => !(n in NOT_COVERED));
    expect(Object.keys(SCHEMAS).sort()).toEqual(expected.sort());
    for (const [name, reason] of Object.entries(NOT_COVERED)) {
      expect(specSchemas, `allow-listed ${name} is no longer in the spec`).toHaveProperty(name);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it.each(Object.keys(SCHEMAS))("%s equals the spec", (name) => {
    expect(fromZod(SCHEMAS[name] as z.ZodType)).toEqual(normal(specSchemas[name] as Obj));
  });

  it("exports each schema under its spec name, except Error (ErrorBody)", () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      expect((contract as Record<string, unknown>)[name === "Error" ? "ErrorBody" : name]).toBe(schema);
    }
  });

  it("every object schema rejects unknown keys, as the spec's additionalProperties: false requires", () => {
    const objects = Object.entries(specSchemas).filter(([, s]) => s["type"] === "object");
    expect(objects.length).toBeGreaterThan(20);
    for (const [name, s] of objects) {
      expect(s["additionalProperties"], name).toBe(false);
      expect((fromZod(SCHEMAS[name] as z.ZodType) as Obj)["additionalProperties"], name).toBe(false);
    }
  });

  // Attack cases for the comparison itself: a loosened schema must not pass as equal.
  it.each([
    ["unknown keys allowed", z.object({ amount_minor: z.int().min(0), currency: z.literal("USD") })],
    ["a field made optional", z.strictObject({ amount_minor: z.int().min(0).optional(), currency: z.literal("USD") })],
    ["a bound dropped", z.strictObject({ amount_minor: z.int(), currency: z.literal("USD") })],
    ["a wider enum", z.strictObject({ amount_minor: z.int().min(0), currency: z.enum(["USD", "EUR"]) })],
  ])("detects a Money schema with %s", (_, loose) => {
    expect(fromZod(loose)).not.toEqual(normal(specSchemas["Money"] as Obj));
  });

  it("detects a changed pattern", () => {
    expect(fromZod(z.string().regex(/^of_[A-Za-z0-9_-]{1,64}$/))).not.toEqual(normal(specSchemas["OfferHandle"] as Obj));
  });
});

describe("operations", () => {
  type Op = { operationId: string; security?: Json[]; requestBody?: Obj; responses: Record<string, Obj> };
  const ops = Object.entries(spec["paths"] as Record<string, Record<string, Op>>).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path, method: method.toUpperCase(), op })),
  );
  const ENDPOINTS = contract.ENDPOINTS as Record<string, contract.Endpoint>;
  const schemaOf = (body: Obj): z.ZodType => SCHEMAS[refName(((body["content"] as Obj)["application/json"] as Obj)["schema"] as Json)] as z.ZodType;

  it("names exactly the spec's operations: the seven gateway endpoints and GET /v1/key-statement", () => {
    expect(Object.keys(ENDPOINTS).sort()).toEqual(ops.map((o) => o.op.operationId).sort());
    expect(ops).toHaveLength(8);
  });

  it("every operation takes the optional Intent-Contract-Version request header, 1.5.0 or 1.6.0", () => {
    const param = (components["parameters"] as Record<string, Obj>)["ContractVersion"] as Obj;
    expect(param).toMatchObject({ name: "Intent-Contract-Version", in: "header", required: false, schema: { enum: ["1.5.0", "1.6.0"] } });
    for (const { op } of ops) {
      const params = ((op as unknown as Obj)["parameters"] ?? []) as Obj[];
      expect(params.map((p) => p["$ref"]), op.operationId).toContain("#/components/parameters/ContractVersion");
    }
  });

  it.each(ops.map((o) => [o.op.operationId, o] as const))("%s matches its method, path, bodies and statuses", (id, { path, method, op }) => {
    const ep = ENDPOINTS[id] as contract.Endpoint;
    expect([ep.method, ep.path]).toEqual([method, path]);
    // Signed unless the operation overrides the global gatewaySignature requirement with `security: []`.
    expect(ep.signed).toBe(!(Array.isArray(op.security) && op.security.length === 0));
    expect(ep.request).toBe(op.requestBody === undefined ? null : schemaOf(op.requestBody));

    const statuses = Object.keys(op.responses).map(Number);
    const ok = statuses.filter((s) => s < 300);
    expect(ok).toEqual([ep.status]);
    expect(ep.response).toBe(schemaOf(op.responses[String(ep.status)] as Obj));
    expect([...ep.errors]).toEqual(statuses.filter((s) => s >= 300));
    for (const status of ep.errors) {
      const res = deref((op.responses[String(status)] as Obj)["$ref"] as string);
      expect(contract.errorBody(status), `${id} ${String(status)}`).toBe(schemaOf(res));
    }
  });

  it("every response carries the three edge headers; each header schema equals the spec", () => {
    const HEADERS = contract.HEADERS as Record<string, { name: string; schema: z.ZodType }>;
    expect(Object.keys(HEADERS).sort()).toEqual(Object.keys(components["headers"] as Obj).sort());
    for (const { op } of ops) {
      for (const response of Object.values(op.responses)) {
        const res = typeof response["$ref"] === "string" ? deref(response["$ref"]) : response;
        const headers = res["headers"] as Record<string, Obj>;
        expect(Object.keys(headers)).toEqual(expect.arrayContaining(["Intent-Contract-Version", "Intent-Receipt", "Intent-Receipt-Signature"]));
        for (const [name, ref] of Object.entries(headers)) expect(HEADERS[refName(ref)]?.name).toBe(name);
      }
    }
    for (const [component, { schema }] of Object.entries(HEADERS)) {
      expect(fromZod(schema), component).toEqual(normal((components["headers"] as Record<string, Obj>)[component]?.["schema"] as Obj));
    }
  });

  it("CONTRACT_VERSION equals the spec's info.version", () => {
    expect(contract.CONTRACT_VERSION).toBe((spec["info"] as Obj)["version"]);
  });

  it("fills path templates only with well-formed handles", () => {
    expect(contract.approvalsPath("ct_EXAMPLE0001")).toBe("/v1/carts/ct_EXAMPLE0001/approvals");
    expect(contract.approvalPath("ap_TEST0001")).toBe("/v1/approvals/ap_TEST0001");
    for (const bad of ["ct_../../v1/meta", "ap_TEST0001", "ct_ab", "ct_EXAMPLE0001?x=1"]) expect(() => contract.approvalsPath(bad)).toThrow();
    for (const bad of ["ap_a/b0000", "ct_TEST0001", ""]) expect(() => contract.approvalPath(bad)).toThrow();
    expect(contract.outcomeReportsPath("ap_TEST0001")).toBe("/v1/approvals/ap_TEST0001/outcome-reports");
    for (const bad of ["ap_a/b0000", "ct_TEST0001", ""]) expect(() => contract.outcomeReportsPath(bad)).toThrow();
  });
});

describe("spec examples", () => {
  const examples = Object.values(spec["paths"] as Record<string, Record<string, Obj>>).flatMap((methods) =>
    Object.values(methods).flatMap((op) => {
      const bodies = [op["requestBody"], ...Object.values(op["responses"] as Obj)].filter((b): b is Obj => b !== undefined && !("$ref" in (b as Obj)));
      return bodies.flatMap((b) => {
        const media = ((b["content"] as Obj | undefined)?.["application/json"] ?? {}) as Obj;
        return "example" in media ? [[`${op["operationId"] as string} ${refName(media["schema"] as Json)}`, refName(media["schema"] as Json), media["example"]] as const] : [];
      });
    }),
  );

  it("there are examples to check", () => {
    expect(examples.length).toBeGreaterThanOrEqual(6);
  });

  it.each(examples)("%s parses", (_, name, example) => {
    // The yaml parser reads the unquoted `contract_version: 1.5.0` as the string "1.5.0".
    expect((SCHEMAS[name] as z.ZodType).parse(example)).toEqual(example);
  });
});

describe("vectors", () => {
  /** Which vectors hold contract objects. A new vector file must be listed here. */
  const VECTORS: Record<string, string> = {
    "a1-snapshot.json": "Snapshot",
    "a2-snapshot-unicode.json": "Snapshot",
    "a3-snapshot-v2.json": "SnapshotV2 (replayed in snapshot-v2.test.ts)",
    "b1-ledger.json": "LedgerRef (the entry's seq and hash, as a proof names them)",
    "b2-ledger-outcome.json": "none: Intent Cloud's ledger, which the gateway does not keep",
    "o1-binding.json": "SnapshotV2 and Binding (binding-v1 itself is G4's)",
    "o2-outcome-statement.json": "OutcomeStatement (its signature is G4's)",
    "o3-status-state.json": "OutcomeState and ApprovalState (replayed in src/gateway/status-state.test.ts)",
    "c2-http-signature.json": "CartRequest body and GatewayKeyId",
    "d1-receipt.json": "Receipt",
    "e1-approval-proof.json": "ApprovalProof",
    "e1-rs256-approval-proof.json": "ApprovalProof",
    "j1-jcs.json": "none: JCS edge cases, not contract objects",
    "s1-key-statement.json": "KeyStatement",
  };

  it("lists every vector file", () => {
    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
    const files = [...sums.matchAll(/ {2}vectors\/(\S+)$/gm)].map((m) => m[1]);
    expect(Object.keys(VECTORS).sort()).toEqual(files.sort());
  });

  it.each(["a1-snapshot.json", "a2-snapshot-unicode.json"])("%s: the snapshot parses unchanged", (file) => {
    const snapshot = ((vector(file)["input"] as Obj)["snapshot"]) as Json;
    expect(contract.Snapshot.parse(snapshot)).toEqual(snapshot);
  });

  it("a3: each v2 snapshot parses unchanged, as SnapshotV2 and as an ApprovalCreated snapshot, and not as v1", () => {
    for (const c of vector("a3-snapshot-v2.json")["cases"] as Obj[]) {
      const snapshot = (c["input"] as Obj)["snapshot"] as Json;
      expect(contract.SnapshotV2.parse(snapshot)).toEqual(snapshot);
      expect(contract.AnySnapshot.parse(snapshot)).toEqual(snapshot);
      expect(contract.Snapshot.safeParse(snapshot).success).toBe(false);
    }
  });

  it("o1: every snapshot is a SnapshotV2 and every expected binding a Binding", () => {
    const cases = vector("o1-binding.json")["cases"] as Obj[];
    expect(cases.length).toBeGreaterThanOrEqual(21);
    for (const c of cases) {
      expect(contract.SnapshotV2.safeParse((c["input"] as Obj)["snapshot"]).success, c["name"] as string).toBe(true);
      expect(contract.Binding.parse(c["expected"]), c["name"] as string).toEqual(c["expected"]);
    }
  });

  it("o2: every statement parses as an OutcomeStatement (refusals are signature and hash checks)", () => {
    for (const c of vector("o2-outcome-statement.json")["cases"] as Obj[]) {
      expect(contract.OutcomeStatement.parse(c["statement"])).toEqual(c["statement"]);
    }
  });

  it("o3: every row names an outcome state and approval states", () => {
    for (const c of vector("o3-status-state.json")["cases"] as Obj[]) {
      const input = c["input"] as Obj;
      const expected = c["expected"] as Obj;
      expect(contract.OutcomeState.safeParse(input["outcome_state"]).success).toBe(true);
      expect(contract.CompletionMode.safeParse(input["mode"]).success).toBe(true);
      expect(contract.ApprovalState.safeParse(expected["1.6.0"]).success).toBe(true);
      expect(expected["1.5.0"] === null || contract.ApprovalState.safeParse(expected["1.5.0"]).success).toBe(true);
    }
  });

  it("b1: the ledger entry's seq and hash form the LedgerRef that e1's proof names", () => {
    const b1 = vector("b1-ledger.json");
    const ref = { seq: ((b1["input"] as Obj)["entry"] as Obj)["seq"], entry_hash: (b1["expected"] as Obj)["entry_hash"] };
    expect(contract.LedgerRef.parse(ref)).toEqual(((vector("e1-approval-proof.json")["expected"] as Obj)["proof"] as Obj)["ledger"]);
  });

  it("c2: the signed body is a CartRequest and the keyid a GatewayKeyId", () => {
    const c2 = vector("c2-http-signature.json");
    expect(contract.CartRequest.safeParse(JSON.parse((c2["input"] as Obj)["body"] as string)).success).toBe(true);
    expect(contract.GatewayKeyId.safeParse((c2["expected"] as Obj)["keyid"]).success).toBe(true);
  });

  describe("d1 receipts", () => {
    const cases = (vector("d1-receipt.json")["cases"] as Obj[]).map((c) => [c["name"] as string, c["expected"] as Obj] as const);
    it.each(cases)("%s: the receipt and its decoded header parse", (_, expected) => {
      expect(contract.Receipt.parse(expected["receipt"])).toEqual(expected["receipt"]);
      const header = expected["intent_receipt"] as string;
      expect(contract.HEADERS.IntentReceipt.schema.safeParse(header).success).toBe(true);
      expect(contract.HEADERS.IntentReceiptSignature.schema.safeParse(expected["intent_receipt_signature"]).success).toBe(true);
      expect(contract.Receipt.parse(JSON.parse(Buffer.from(header, "base64url").toString("utf8")))).toEqual(expected["receipt"]);
    });
  });

  describe("e1 approval proofs", () => {
    const e1 = vector("e1-approval-proof.json");
    const rs = vector("e1-rs256-approval-proof.json");
    const proof = (e1["expected"] as Obj)["proof"] as Obj;

    it.each([
      ["ES256", e1],
      ["RS256", rs],
    ])("%s: the proof parses unchanged, alone and as an approved status", (_, v) => {
      const p = (v["expected"] as Obj)["proof"] as Obj;
      expect(contract.ApprovalProof.parse(p)).toEqual(p);
      const status = { state: "approved", display: { merchant: "Trail Supply Co (mock)", title: "Trail Runner 3", total: { amount_minor: 9499, currency: "USD" } }, proof: p };
      expect(contract.ApprovalStatus.parse(status)).toEqual(status);
    });

    // Steps 2–6 and the handle check of step 1 are cryptographic or semantic; only "ES256 alg on an RSA key" is a
    // schema refusal (Appendix E: no other algorithm and no other member).
    const refusals = [...(e1["refusals"] as Obj[]), ...(rs["refusals"] as Obj[])].map((r) => [r["name"] as string, r] as const);
    it.each(refusals)("refusal %s: schema verdict", (name, r) => {
      expect(contract.ApprovalProof.safeParse(r["proof"]).success).toBe(name !== "ES256 alg on an RSA key");
    });

    it("rejects a proof with an extra member, an unlisted key algorithm or a key member too many", () => {
      expect(contract.ApprovalProof.safeParse({ ...proof, buyer: "x" }).success).toBe(false);
      const key = proof["credential_public_key"] as Obj;
      expect(contract.ApprovalProof.safeParse({ ...proof, credential_public_key: { ...key, alg: "EdDSA" } }).success).toBe(false);
      expect(contract.ApprovalProof.safeParse({ ...proof, credential_public_key: { ...key, d: "secret" } }).success).toBe(false);
    });
  });

  describe("s1 key statement", () => {
    const s1 = vector("s1-key-statement.json");
    it("the signed statement parses unchanged", () => {
      const st = (s1["expected"] as Obj)["statement"] as Obj;
      expect(contract.KeyStatement.parse(st)).toEqual(st);
      expect(contract.KeyStatement.safeParse({ ...st, keys: [(st["keys"] as Json[])[0]] }).success).toBe(false);
    });
    // Every s1 refusal is a signature, pin or clock failure, so each still matches the schema.
    it.each((s1["refusals"] as Obj[]).map((r) => [r["name"] as string, r["statement"]] as const))("refusal %s still parses", (_, st) => {
      expect(contract.KeyStatement.safeParse(st).success).toBe(true);
    });
  });
});

describe("strictness and refinements", () => {
  const offer = {
    offer_handle: "of_EXAMPLE0001",
    merchant: { name: "Trail Supply Co", domain: "shop.example" },
    title: "Trail Runner 3",
    variant: "US 10 / Blue",
    price: { amount_minor: 8999, currency: "USD" },
    shipping: { amount_minor: 500, currency: "USD" },
    total_kind: "exact",
    availability: "in_stock",
  };

  it("rejects unknown keys, also in the provisional schemas", () => {
    expect(contract.Offer.safeParse(offer).success).toBe(true);
    expect(contract.Offer.safeParse({ ...offer, seller_id: "x" }).success).toBe(false);
    expect(contract.Offer.safeParse({ ...offer, rating: { stars_x10: 46, count: 3, source: "x" } }).success).toBe(false);
    expect(contract.RateLimited.safeParse({ error: "rate_limited", message: "", limit: "carts", retry_after_seconds: 5, scope: "ip" }).success).toBe(false);
    const meta = { contract_version: "1.5.0", contract_sums_sha256: "0".repeat(64), rule_versions: ["recheck-v1"] };
    expect(contract.Meta.safeParse({ ...meta, enrol_origin: "https://confirm.example" }).success).toBe(true);
    expect(contract.Meta.safeParse({ ...meta, confirm_origin: "https://confirm.example" }).success).toBe(false);
  });

  it("refuses non-US destinations, floats and unsafe integers", () => {
    expect(contract.ShipTo.safeParse({ country: "CA", postal_code: "94110" }).success).toBe(false);
    expect(contract.ShipTo.safeParse({ country: "US", postal_code: "9411" }).success).toBe(false);
    expect(contract.Money.safeParse({ amount_minor: 1.5, currency: "USD" }).success).toBe(false);
    expect(contract.Money.safeParse({ amount_minor: 2 ** 53, currency: "USD" }).success).toBe(false);
    expect(contract.Money.safeParse({ amount_minor: -1, currency: "USD" }).success).toBe(false);
  });

  it("ReceiptRequest: keyid, nonce and created come together or not at all (Appendix D)", () => {
    const base = { method: "POST", path: "/v1/carts", content_digest: "sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:" };
    const signed = { keyid: "gw-Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc", nonce: "bm9uY2UtdGVzdC0wMDAwMg==", created: 1790251200 };
    expect(contract.ReceiptRequest.safeParse(base).success).toBe(true);
    expect(contract.ReceiptRequest.safeParse({ ...base, ...signed }).success).toBe(true);
    for (const drop of ["keyid", "nonce", "created"] as const) {
      const partial = Object.fromEntries(Object.entries({ ...base, ...signed }).filter(([k]) => k !== drop));
      expect(contract.ReceiptRequest.safeParse(partial).success, `without ${drop}`).toBe(false);
    }
    expect(contract.ReceiptRequest.safeParse({ ...base, path: "/v1/carts?x=1" }).success).toBe(false);
  });

  it("CartRequest (1.6.0): completion_accepts holds 1 or 2 distinct known modes; completer_keyid is a gw- keyid", () => {
    const base = { offer_handle: "of_EXAMPLE0001", quantity: 1, ship_to: { country: "US", postal_code: "94110" } };
    const keyid = "gw-Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc";
    expect(contract.CartRequest.safeParse({ ...base, completer_keyid: keyid, completion_accepts: ["shop_agent", "handoff"] }).success).toBe(true);
    for (const accepts of [[], ["handoff", "handoff"], ["auto"], ["handoff", "shop_agent", "handoff"]]) {
      expect(contract.CartRequest.safeParse({ ...base, completion_accepts: accepts }).success, JSON.stringify(accepts)).toBe(false);
    }
    expect(contract.CartRequest.safeParse({ ...base, completer_keyid: "cloud-receipt-202610" }).success).toBe(false);
  });

  it("error bodies parse by status", () => {
    expect(contract.errorBody(404).safeParse({ error: "not_found", message: "no such cart" }).success).toBe(true);
    expect(contract.errorBody(404).safeParse({ error: "rate_limited", message: "" }).success).toBe(false);
    expect(contract.errorBody(429).safeParse({ error: "rate_limited", message: "", limit: "requests", retry_after_seconds: 30 }).success).toBe(true);
  });
});
