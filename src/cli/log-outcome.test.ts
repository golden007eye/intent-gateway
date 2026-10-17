// `intent log` on a gateway outcome report (contract 1.6.0): the line says what was sent to Intent Cloud and how
// the edge acknowledged it, and claims nothing about what Intent Cloud did with it (invariant 5).
import { describe, expect, it } from "vitest";
import { formatLog } from "./log.ts";

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const REPORT = { report_id: "or_AAAAAAAAAAAAAAAA", state: "completing", source: "shop_api", checkout_ref: "c1", observed_at: "2026-10-16T10:05:00Z" };
const items = [
  { seq: 0, prev: "", ts: "2026-10-16T10:00:00.000Z", kind: "session", body: { id: "s1" }, hash: "" },
  {
    seq: 1,
    prev: "",
    ts: "2026-10-16T10:05:01.000Z",
    kind: "disclosure",
    body: { endpoint: "reportOutcome", method: "POST", path: "/v1/approvals/ap_1/outcome-reports", fields: ["state"], body_b64: b64(REPORT), content_digest: "sha-256=:x:", keyid: "gw-k" },
    hash: "",
  },
  { seq: 2, prev: "", ts: "2026-10-16T10:05:02.000Z", kind: "receipt", body: { disclosure_seq: 1, status: 201, verified: true }, hash: "" },
];

describe("intent log: outcome report", () => {
  it("shows an outcome report sent to Intent Cloud, with its receipt, and nothing more", () => {
    const out = formatLog(items, { style: { color: false, utc: true }, dataDir: "/d", home: "/h", intent: "intent" });
    const line = out.split("\n").find((l) => l.includes("outcome report"));
    expect(line).toMatch(/outcome +outcome report sent to Intent Cloud · approval ap_1 .*✓ receipt/);
    expect(out).not.toMatch(/\bkeys\b/);
    expect(line).not.toMatch(/ordered|completed|accepted|redeemed/);
  });
});
