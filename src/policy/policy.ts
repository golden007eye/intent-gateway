// Gateway policy v1: the strict schema, Intent Cloud's baseline, and `meet`. A policy can only narrow the
// baseline (invariant 1), so every value that could loosen it is refused at load time with POLICY_LOOSENS.
import { domainToASCII } from "node:url";
import { z } from "zod";
import { DOCUMENT, PolicyError, joinPath, parseStrictYaml } from "./parse.ts";

export const MAX_POLICY_BYTES = 64 * 1024;
export const MAX_QUANTITY = 3;

export type ShipTo = "postcode_only" | "none";

export interface Spend {
  readonly per_order_usd?: number;
  readonly per_day_usd?: number;
  readonly per_week_usd?: number;
}

/** A loaded policy with every section filled in. Lists are normalized, sorted and deduplicated. */
export interface Policy {
  readonly version: 1;
  readonly share: { readonly ship_to: ShipTo; readonly history: false };
  readonly spend: Spend;
  readonly quantity: { readonly max: number };
  /** `allow` absent means any merchant not blocked; present means only these (and their subdomains). */
  readonly merchants: { readonly allow?: readonly string[]; readonly block: readonly string[] };
  readonly categories: { readonly block: readonly string[] };
  readonly approval: "passkey";
}

/**
 * Categories Intent Cloud never offers: health and medical products; age-restricted products (alcohol,
 * tobacco, cannabis, adult, weapons); financial and digital goods (gift cards, crypto, subscriptions, digital
 * downloads). The gateway blocks them itself too, so no policy can allow them.
 */
export const EXCLUDED_CATEGORIES: readonly string[] = Object.freeze([
  "health",
  "medical",
  "age-restricted",
  "alcohol",
  "tobacco",
  "cannabis",
  "adult",
  "weapons",
  "financial",
  "gift-cards",
  "crypto",
  "subscriptions",
  "digital-goods",
  "digital-downloads",
]);

// NFKC folds full-width and compatibility forms; format characters (zero-width spaces, bidi marks) are dropped
// so `Ａlcohol` and `alcohol\u200b` read as `alcohol`.
function cleanCategory(category: string): string {
  return category.normalize("NFKC").toLowerCase().replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}

const hyphenate = (part: string): string => part.trim().replace(/[\s_]+/g, "-");

/** The category as a path: `/` and `>` separate levels, spaces and underscores become `-`. */
export function normalizeCategory(category: string): string {
  return cleanCategory(category).split(/[/>]/).map(hyphenate).join("/");
}

/** True when `category`, any parent of it (`a/b` is under `a`), or any part of it split on `&`, `>`, `/` or `,`
 * (`Alcohol & Spirits` has the part `alcohol`) is in `blocked`. */
export function categoryBlocked(category: string, blocked: readonly string[]): boolean {
  const levels = normalizeCategory(category).split("/");
  if (levels.some((_, i) => blocked.includes(levels.slice(0, i + 1).join("/")))) return true;
  return cleanCategory(category)
    .split(/[&>/,]/)
    .map(hyphenate)
    .some((part) => part !== "" && blocked.includes(part));
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
// Characters that make a merchant a URL or host:port rather than a bare hostname. `domainToASCII` would
// silently cut a path (`evil.com/x` becomes `evil.com`), so they are refused before it runs.
const NOT_HOSTNAME = /[\s:/\\?#@[\]%*]/u;

/**
 * The merchant as a bare ASCII hostname: NFKC, lowercase, IDN to punycode (`bücher.de` is `xn--bcher-kva.de`,
 * `evil。com` is `evil.com`), one trailing dot dropped. Undefined for anything else: a scheme, port, path,
 * empty label or empty name.
 */
export function normalizeMerchant(merchant: string): string | undefined {
  const folded = merchant.normalize("NFKC").toLowerCase().trim();
  if (NOT_HOSTNAME.test(folded)) return undefined;
  const ascii = domainToASCII(folded);
  const host = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  if (host === "" || host.length > 253) return undefined;
  return host.split(".").every((label) => LABEL.test(label)) ? host : undefined;
}

/** True when `merchant` is one of `list` or a subdomain of one. A merchant that is not a hostname matches none. */
export function merchantMatches(merchant: string, list: readonly string[]): boolean {
  const m = normalizeMerchant(merchant);
  if (m === undefined) return false;
  return list.some((entry) => m === entry || m.endsWith(`.${entry}`));
}

const sorted = (items: Iterable<string>): readonly string[] => Object.freeze([...new Set(items)].sort());

function freezePolicy(p: {
  ship_to: ShipTo;
  spend: { readonly [K in keyof Spend]?: number | undefined };
  max: number;
  allow: Iterable<string> | undefined;
  block: Iterable<string>;
  categories: Iterable<string>;
}): Policy {
  const spend: { -readonly [K in keyof Spend]: number } = {};
  for (const key of ["per_order_usd", "per_day_usd", "per_week_usd"] as const) {
    const value = p.spend[key];
    if (value !== undefined) spend[key] = value;
  }
  const merchants = p.allow === undefined ? { block: sorted(p.block) } : { allow: sorted(p.allow), block: sorted(p.block) };
  return Object.freeze({
    version: 1,
    share: Object.freeze({ ship_to: p.ship_to, history: false }),
    spend: Object.freeze(spend),
    quantity: Object.freeze({ max: p.max }),
    merchants: Object.freeze(merchants),
    categories: Object.freeze({ block: sorted(p.categories) }),
    approval: "passkey",
  });
}

/** Intent Cloud's rules as a policy: the loosest policy the gateway will run. US-only delivery is enforced by
 * `evaluate`, which accepts only a 5-digit US ZIP as the ship-to postcode. */
export const CLOUD_BASELINE: Policy = freezePolicy({
  ship_to: "postcode_only",
  spend: {},
  max: MAX_QUANTITY,
  allow: undefined,
  block: [],
  categories: EXCLUDED_CATEGORIES,
});

const usd = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const name = z.string().max(253).regex(/\S/, "must not be blank");
const names = z.array(name).max(1000);

const schema = z.strictObject({
  version: z.literal(1),
  share: z
    .strictObject({ ship_to: z.enum(["postcode_only", "none"]).optional(), history: z.literal(false).optional() })
    .optional(),
  spend: z
    .strictObject({ per_order_usd: usd.optional(), per_day_usd: usd.optional(), per_week_usd: usd.optional() })
    .optional(),
  quantity: z.strictObject({ max: z.number().int().min(1).max(MAX_QUANTITY) }).optional(),
  merchants: z.strictObject({ allow: names.optional(), block: names.optional() }).optional(),
  categories: z.strictObject({ block: names.optional() }).optional(),
  approval: z.literal("passkey"),
});

// Sections whose every wrong value could loosen a Cloud rule (or be read as "no limit") by some reader.
const GUARDED: Record<string, string> = {
  approval: "purchase approval must be `passkey`; a policy cannot turn it off or change it",
  share: "share.ship_to must be postcode_only or none, and share.history must be false",
  spend: "spend limits must be positive whole USD amounts",
  quantity: `quantity.max must be a whole number from 1 to ${String(MAX_QUANTITY)}`,
};

function toPolicyError(issue: z.core.$ZodIssue): PolicyError {
  const path = issue.path.reduce<string>((at, key) => joinPath(at, typeof key === "number" ? key : String(key)), "");
  if (issue.code === "unrecognized_keys") {
    const at = joinPath(path, issue.keys[0] ?? "");
    const message =
      at === "categories.allow"
        ? "categories cannot be allowed: a policy can only block categories, never allow ones Intent Cloud excludes"
        : "unknown key; policy v1 accepts no other keys";
    return new PolicyError("POLICY_LOOSENS", at, message);
  }
  const top = String(issue.path[0] ?? "");
  const guarded = GUARDED[top];
  if (guarded !== undefined) return new PolicyError("POLICY_LOOSENS", path, guarded);
  return new PolicyError("POLICY_INVALID", path === "" ? DOCUMENT : path, issue.message);
}

function hostnameAt(merchant: string, path: string): string {
  const host = normalizeMerchant(merchant);
  if (host === undefined) {
    throw new PolicyError("POLICY_INVALID", path, "a merchant must be a bare hostname (no scheme, port, path or empty label)");
  }
  return host;
}

/** Reads a policy.yaml. Throws PolicyError: POLICY_LOOSENS for anything that could loosen the baseline,
 * POLICY_INVALID for other malformed input. */
export function loadPolicy(text: string): Policy {
  const parsed = schema.safeParse(parseStrictYaml(text, MAX_POLICY_BYTES));
  if (!parsed.success) {
    const errors = parsed.error.issues.map(toPolicyError);
    throw errors.find((e) => e.code === "POLICY_LOOSENS") ?? errors[0] ?? new PolicyError("POLICY_INVALID", DOCUMENT, "invalid");
  }
  const d = parsed.data;
  const block = (d.merchants?.block ?? []).map((m, i) => hostnameAt(m, `merchants.block[${String(i)}]`));
  const allow = d.merchants?.allow?.map((m, i) => hostnameAt(m, `merchants.allow[${String(i)}]`));
  const categories = (d.categories?.block ?? []).map((c, i) => {
    const normalized = normalizeCategory(c);
    if (normalized.split("/").includes("")) {
      throw new PolicyError("POLICY_INVALID", `categories.block[${String(i)}]`, "a category level is empty");
    }
    return normalized;
  });
  return freezePolicy({
    ship_to: d.share?.ship_to ?? CLOUD_BASELINE.share.ship_to,
    spend: d.spend ?? {},
    max: d.quantity?.max ?? CLOUD_BASELINE.quantity.max,
    allow,
    block,
    categories,
  });
}

const minDefined = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/** The merchants both allow-lists accept: an entry survives when the other list covers it. */
function intersectAllow(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined {
  if (a === undefined) return b?.slice();
  if (b === undefined) return a.slice();
  return [...a.filter((m) => merchantMatches(m, b)), ...b.filter((m) => merchantMatches(m, a))];
}

/** The narrowest combination of two policies: lower limits, both block lists, only merchants both allow. */
export function meet(a: Policy, b: Policy): Policy {
  return freezePolicy({
    ship_to: a.share.ship_to === "none" || b.share.ship_to === "none" ? "none" : "postcode_only",
    spend: {
      per_order_usd: minDefined(a.spend.per_order_usd, b.spend.per_order_usd),
      per_day_usd: minDefined(a.spend.per_day_usd, b.spend.per_day_usd),
      per_week_usd: minDefined(a.spend.per_week_usd, b.spend.per_week_usd),
    },
    max: Math.min(a.quantity.max, b.quantity.max),
    allow: intersectAllow(a.merchants.allow, b.merchants.allow),
    block: [...a.merchants.block, ...b.merchants.block],
    categories: [...a.categories.block, ...b.categories.block],
  });
}

