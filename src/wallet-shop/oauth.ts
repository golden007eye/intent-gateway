// Linking the developer's Shop account (plan G8): the OAuth device flow (RFC 8628) as a public client, through the
// disclosed caller of destination `shop_accounts`, so every request is logged before it leaves (invariant 2).
//
// What stays where:
// - The device code and the tokens are credentials. The device code is sent only in token requests, under a secret
//   key, so the log digests it; the tokens only ever come back in answers, which the log keeps as a digest and a
//   size. Neither is returned in an error or printed.
// - The user code and the verification URL are for the developer's eyes: they come back in the device answer (never
//   sent by the gateway, so never in a disclosure) and are handed to `show` to print.
// - Shop's error texts (`error_description`) are never read: only the RFC error codes, each mapped to a fixed label.
// - The scope asks for no email: `openid personal_agent`, the least Shop documents for an agent (invariant 3).
import { record } from "./project.ts";
import { DEVICE_AUTHORIZATION, TOKEN, type WireResponse } from "./rpc.ts";
import type { ShopCaller, ShopCredentials } from "./adapter.ts";

export const SHOP_SCOPE = "openid personal_agent";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** The longest the gateway waits for the developer to approve, whatever Shop's `expires_in` says. */
export const MAX_WAIT_MS = 10 * 60_000;
/** RFC 8628 §3.2: the poll interval when Shop names none, and the floor; `slow_down` adds 5 s each time. */
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_S = 5;
/** The longest wait between two polls, whatever Shop asks for. */
const MAX_INTERVAL_S = 60;
/** Shop's interval kept between the RFC's 5 s floor and MAX_INTERVAL_S: never a busy loop, never a setTimeout overflow. */
const clampInterval = (seconds: number): number => Math.min(Math.max(seconds, DEFAULT_INTERVAL_S), MAX_INTERVAL_S);

/** What the developer is shown to approve the link: where to go and which code to check. */
export interface DeviceGrantPrompt {
  readonly userCode: string;
  readonly verificationUri: string;
  /** The same URL with the code in it, for a QR code; null when Shop gives none. */
  readonly verificationUriComplete: string | null;
  /** How long the code stays valid, in seconds (capped at MAX_WAIT_MS). */
  readonly expiresInS: number;
}

export type ShopLinkFailure = "expired" | "denied" | "refused" | "unreadable";

/** The device flow ended without tokens. The message is the gateway's own words; it never carries Shop's text or a code. */
export class ShopLinkError extends Error {
  override name = "ShopLinkError";
  readonly failure: ShopLinkFailure;
  /** The RFC 6749 / 8628 error code Shop answered (`invalid_client`), or null when it gave none the gateway knows. */
  readonly code: string | null;
  constructor(failure: ShopLinkFailure, message: string, code: string | null = null) {
    super(message);
    this.failure = failure;
    this.code = code;
  }
}

export interface DeviceFlowOptions {
  /** The Shop client the gateway signs in as (its own client file, or INTENT_SHOP_CLIENT_ID). */
  readonly clientId: string;
  /** The protected resource the tokens are for: Shop's MCP server origin (RFC 8707). */
  readonly resource: string;
  /** Prints where to approve; called once, before the first poll. */
  readonly show: (prompt: DeviceGrantPrompt) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** The linked tokens, plus how long the access token lives (seconds; null when Shop does not say). */
export interface LinkedShop {
  readonly credentials: ShopCredentials;
  readonly expiresInS: number | null;
}

const EXPIRED = "the sign-in code expired before it was approved";
const ERROR_LABELS: Readonly<Record<string, [ShopLinkFailure, string]>> = {
  expired_token: ["expired", EXPIRED],
  access_denied: ["denied", "the link was declined in Shop"],
  invalid_client: ["refused", "Shop does not accept this gateway's client (invalid_client)"],
  unauthorized_client: ["refused", "Shop does not let this client use the device flow (unauthorized_client)"],
  invalid_scope: ["refused", `Shop refused the scope "${SHOP_SCOPE}" (invalid_scope)`],
  invalid_grant: ["refused", "Shop refused the sign-in code (invalid_grant)"],
  invalid_request: ["refused", "Shop refused the request (invalid_request)"],
};

/**
 * A device grant Shop issued and the developer has not approved yet: what a later token poll needs. The device code
 * is a credential (whoever holds it can redeem the tokens once the developer approves), so a grant kept between
 * processes is sealed like the tokens; it names nothing about the buyer.
 */
export interface DeviceGrant {
  readonly deviceCode: string;
  readonly clientId: string;
  /** The protected resource the tokens are asked for (RFC 8707). */
  readonly resource: string;
  /** Shop's poll interval in seconds, clamped. */
  readonly intervalS: number;
  /** When the user code stops counting, in milliseconds since the epoch (at most MAX_WAIT_MS after the request). */
  readonly expiresAt: number;
}

export interface DeviceStartOptions {
  readonly clientId: string;
  readonly resource: string;
  readonly now: () => number;
}

export interface DevicePollOptions {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** Runs the device flow to the end: the device authorization, then token polls at Shop's interval until an answer. */
export async function runDeviceFlow(accounts: ShopCaller, options: DeviceFlowOptions): Promise<LinkedShop> {
  const { grant, prompt } = await startDeviceFlow(accounts, options);
  options.show(prompt);
  return pollDeviceGrant(accounts, grant, options);
}

/** The first half of the device flow: the device authorization (one disclosed send), giving the grant and what to show. */
export async function startDeviceFlow(accounts: ShopCaller, options: DeviceStartOptions): Promise<{ grant: DeviceGrant; prompt: DeviceGrantPrompt }> {
  const started = options.now();
  const device = readForm(await accounts.call(DEVICE_AUTHORIZATION, { client_id: options.clientId, scope: SHOP_SCOPE, resource: options.resource }));
  if (device.status !== 200) throw failed(device.json, "Shop refused the device authorization");
  const { json } = device;
  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const uri = json.verification_uri;
  if (typeof deviceCode !== "string" || deviceCode === "" || typeof userCode !== "string" || !USER_CODE.test(userCode) || !isWebUrl(uri)) {
    throw new ShopLinkError("unreadable", "Shop's device authorization answer has no usable device code, user code or verification URL");
  }
  const complete = isWebUrl(json.verification_uri_complete) ? json.verification_uri_complete : null;
  const expiresMs = Math.min(positive(json.expires_in) * 1000 || MAX_WAIT_MS, MAX_WAIT_MS);
  const intervalS = clampInterval(positive(json.interval) || DEFAULT_INTERVAL_S);
  return {
    grant: { deviceCode, clientId: options.clientId, resource: options.resource, intervalS, expiresAt: started + expiresMs },
    prompt: { userCode, verificationUri: uri, verificationUriComplete: complete, expiresInS: Math.round(expiresMs / 1000) },
  };
}

/**
 * The second half: token polls with `grant` at its interval (slow_down adds 5 s) until Shop answers with tokens or
 * an error, or the grant expires. No token request is sent once it has expired: Shop would only answer expired_token.
 */
export async function pollDeviceGrant(accounts: ShopCaller, grant: DeviceGrant, options: DevicePollOptions): Promise<LinkedShop> {
  const deadline = grant.expiresAt;
  let intervalS = clampInterval(grant.intervalS);
  for (;;) {
    // Never past the deadline, so the 10-minute cap holds whatever the interval.
    await options.sleep(Math.max(0, Math.min(intervalS * 1000, deadline - options.now())));
    if (options.now() >= deadline) throw new ShopLinkError("expired", EXPIRED);
    const answer = readForm(await accounts.call(TOKEN, { grant_type: DEVICE_GRANT, device_code: grant.deviceCode, client_id: grant.clientId }));
    if (answer.status === 200) return tokens(answer.json, grant.clientId, options.now());
    const code = answer.json.error;
    if (code === "authorization_pending") continue;
    // slow_down, and a busy or failing server (429, 5xx) that names no error the gateway knows: the grant still
    // works, so wait 5 s longer and ask again, never past the deadline.
    const known = typeof code === "string" && Object.hasOwn(ERROR_LABELS, code);
    if (code === "slow_down" || (!known && (answer.status === 429 || answer.status >= 500))) {
      intervalS = clampInterval(intervalS + SLOW_DOWN_S);
      continue;
    }
    throw failed(answer.json, "Shop refused the token request");
  }
}

/**
 * A grant as kept between `wallet link shop --start` and `--finish`, with `authUrl`, the account server that issued
 * it: the device code goes back to that server only. JSON, for the sealed pending file; never printed.
 */
export function deviceGrantText(grant: DeviceGrant, authUrl: string): string {
  return JSON.stringify({
    v: 1,
    device_code: grant.deviceCode,
    client_id: grant.clientId,
    resource: grant.resource,
    auth_url: authUrl,
    interval: grant.intervalS,
    expires_at: grant.expiresAt,
  });
}

/** The grant in a pending file's text, or null when the text is not one. */
export function parseDeviceGrant(text: string): { grant: DeviceGrant; authUrl: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const json = record(value);
  if (json?.v !== 1) return null;
  const { device_code: deviceCode, client_id: clientId, resource, auth_url: authUrl, interval, expires_at: expiresAt } = json;
  if (typeof deviceCode !== "string" || deviceCode === "" || typeof clientId !== "string" || clientId === "") return null;
  if (typeof resource !== "string" || typeof authUrl !== "string" || positive(interval) === 0 || positive(expiresAt) === 0) return null;
  return { grant: { deviceCode, clientId, resource, intervalS: interval as number, expiresAt: expiresAt as number }, authUrl };
}

/** A user code as RFC 8628 suggests one: short, letters, digits and `-`; anything else is not printed. */
const USER_CODE = /^[A-Za-z0-9-]{4,32}$/;

function tokens(json: Record<string, unknown>, clientId: string, nowMs: number): LinkedShop {
  const access = json.access_token;
  const type = json.token_type;
  if (typeof access !== "string" || access === "" || (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer"))) {
    throw new ShopLinkError("unreadable", "Shop's token answer has no bearer access token");
  }
  // Every other key (S1 saw `scope` and `access_type`; an `id_token` would name the buyer) is dropped here.
  const refresh = typeof json.refresh_token === "string" && json.refresh_token !== "" ? json.refresh_token : null;
  const expiresInS = positive(json.expires_in) || null;
  return { credentials: { clientId, accessToken: access, refreshToken: refresh, expiresAt: expiresInS === null ? null : nowMs + expiresInS * 1000 }, expiresInS };
}

/** The refresh grant (RFC 6749 §6). */
export const REFRESH_GRANT = "refresh_token";

/**
 * Exchanges the refresh token for a new access token (S1: Shop issues a refresh token to the public client, and its
 * access token lives 3600 s), through the disclosed account caller: logged before it leaves, with the refresh token
 * digested; the answer is kept only as a digest and a size. A refresh token Shop does not send again stays the one in
 * use. Throws ShopLinkError when there is no refresh token, Shop refuses, or its answer has no bearer token: the
 * wallet has to be linked again.
 */
export async function refreshTokens(accounts: ShopCaller, credentials: ShopCredentials, now: () => number): Promise<ShopCredentials> {
  if (credentials.refreshToken === null) throw new ShopLinkError("refused", "Shop issued no refresh token for this link");
  const started = now();
  const answer = readForm(await accounts.call(TOKEN, { grant_type: REFRESH_GRANT, refresh_token: credentials.refreshToken, client_id: credentials.clientId }));
  if (answer.status !== 200) throw failed(answer.json, "Shop refused to refresh the token");
  const renewed = tokens(answer.json, credentials.clientId, started).credentials;
  return { ...renewed, refreshToken: renewed.refreshToken ?? credentials.refreshToken };
}

function failed(json: Record<string, unknown>, fallback: string): ShopLinkError {
  const code = json.error;
  const known = typeof code === "string" && Object.hasOwn(ERROR_LABELS, code) ? ERROR_LABELS[code] : undefined;
  return known === undefined ? new ShopLinkError("refused", fallback) : new ShopLinkError(known[0], known[1], code as string);
}

function readForm(response: WireResponse): { status: number; json: Record<string, unknown> } {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(response.body).toString("utf8"));
  } catch {
    value = null;
  }
  return { status: response.status, json: record(value) ?? {} };
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** An https URL (http only on a loopback host, the fake Shop's), with no credentials in it. */
function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && url.username === "" && url.password === "";
}
