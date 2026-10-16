// `intent doctor`: one line per check, and for each problem the command or setting that fixes it. Checks the data
// dir, the active policy and its lock, the local hash chain and its lease, the root key, and Intent Cloud's
// contract version and key statement. Its two requests to Intent Cloud go through the disclosure log like any other.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, RootKey } from "../config/index.ts";
import { CONTRACT_VERSION } from "../contract/index.ts";
import { contractSums } from "../gateway/index.ts";
import { LibraryError, readLock } from "../library/index.ts";
import { PolicyError } from "../policy/index.ts";
import { openStore, verifyChain } from "../store/index.ts";
import { verifyStatement } from "../trust/index.ts";
import { describeError } from "./errors.ts";
import { type Io, line } from "./io.ts";
import { readLog } from "./log.ts";
import { demoTrustKeys } from "../demo/index.ts";
import { activePolicy, cloudFor, rootKeys } from "./setup.ts";

type Level = "ok" | "warn" | "fail";
interface Finding {
  level: Level;
  text: string;
}

const DAY_MS = 86_400_000;
const EXPIRY_WARNING_DAYS = 14;

export async function doctor(io: Io, config: Config): Promise<number> {
  const now = io.now ?? Date.now;
  const findings: Finding[] = [];
  const report = (level: Level, text: string): void => {
    findings.push({ level, text });
    line(io.stdout, `${{ ok: "ok  ", warn: "WARN", fail: "FAIL" }[level]}  ${text}`);
  };

  line(io.stdout, `intent doctor: data dir ${config.dataDir}`);
  await checkDataDir(config.dataDir, report);
  await checkPolicy(config.policyPath, report);
  checkChain(config.dataDir, report);
  await checkLease(config.dataDir, now(), report);

  if (config.demo) {
    // The demo Intent Cloud runs only inside intent demo, and its contract and keys are the ones this build ships.
    const kids = demoTrustKeys().rootKeys.map((k) => k.kid).join(", ");
    report("ok", `root key: ${kids} (the published test key; demo mode only)`);
    report("ok", "Intent Cloud: demo mode runs its own on 127.0.0.1 when intent demo starts; nothing to reach");
  } else {
    let pins: readonly RootKey[] | null = null;
    try {
      pins = await rootKeys(config);
      report("ok", `root key: ${pins.map((k) => k.kid).join(", ")} (${config.cloud.trust.kind === "file" ? "from --trust-keys" : "pinned in this build"})`);
    } catch (error) {
      report("fail", `root key: ${describeError(error)}`);
    }
    if (pins !== null) await checkCloud(io, config, config.cloud.url, pins, now, report);
  }

  const failed = findings.filter((f) => f.level === "fail").length;
  line(io.stdout, failed === 0 ? "doctor: ok" : `doctor: ${String(failed)} problem${failed === 1 ? "" : "s"}; each line above says the fix`);
  return failed === 0 ? 0 : 1;
}

type Report = (level: Level, text: string) => void;

async function checkDataDir(dataDir: string, report: Report): Promise<void> {
  let info;
  try {
    info = await lstat(dataDir);
  } catch {
    report("ok", "data dir: not created yet; intent serve creates it (mode 700)");
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    report("fail", `data dir: ${dataDir} is ${info.isSymbolicLink() ? "a symbolic link" : "not a directory"}; set INTENT_DATA_DIR to a real folder`);
    return;
  }
  if (process.platform === "win32") {
    report("ok", "data dir: exists (permissions are not checked on Windows)");
    return;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    report("fail", `data dir: owned by uid ${String(info.uid)}, not you (uid ${String(uid)}); run it as that user, or set INTENT_DATA_DIR to a folder you own`);
    return;
  }
  const mode = (info.mode & 0o777).toString(8);
  if ((info.mode & 0o077) !== 0) {
    report("fail", `data dir: other users can read it (mode ${mode}); run chmod 700 ${dataDir}`);
    return;
  }
  report("ok", `data dir: yours, mode ${mode}`);
}

async function checkPolicy(policyPath: string, report: Report): Promise<void> {
  try {
    const active = await activePolicy(policyPath);
    if (active.bundled !== null) {
      report("ok", `policy: the bundled ${active.bundled} (no file at ${policyPath}; intent policy add <name> writes one)`);
      return;
    }
    const lock = await readLock(policyPath);
    report("ok", `policy: ${policyPath}${lock === undefined ? " (written by hand, no policy.lock)" : `, from library policy ${lock.name} (${lock.source} ${lock.commit.slice(0, 12)})`}`);
  } catch (error) {
    if (error instanceof LibraryError) report("warn", `policy lock: ${describeError(error)}`);
    else if (error instanceof PolicyError) report("fail", describeError(error, { policyPath }));
    else throw error;
  }
}

function checkChain(dataDir: string, report: Report): void {
  let items: unknown[];
  try {
    items = readLog(dataDir);
  } catch (error) {
    report("fail", `chain: ${describeError(error, { dataDir })}`);
    return;
  }
  if (items.length === 0) {
    report("ok", "chain: empty; nothing has been sent yet");
    return;
  }
  const chain = verifyChain(items);
  if (!chain.ok) {
    report("fail", `chain: breaks at seq ${String(chain.brokenSeq)} (${chain.reason}); run intent verify, then move audit.jsonl aside to start a new chain`);
    return;
  }
  const head = items.at(-1) as { seq: number; hash: string };
  report("ok", `chain: ${String(items.length)} entries, every hash links; head seq ${String(head.seq)} hash ${head.hash}`);
}

async function checkLease(dataDir: string, now: number, report: Report): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(dataDir, "audit.lock"), "utf8");
  } catch {
    report("ok", "lease: free");
    return;
  }
  let expires: unknown;
  try {
    expires = (JSON.parse(text) as { expires_at?: unknown }).expires_at;
  } catch {
    expires = undefined;
  }
  if (typeof expires !== "number") {
    report("warn", "lease: audit.lock is not a lease the gateway wrote; stop every gateway on this data dir, then delete audit.lock");
  } else if (expires > now) {
    report("ok", `lease: held by a running gateway until ${new Date(expires).toISOString()}`);
  } else {
    report("ok", `lease: expired at ${new Date(expires).toISOString()}; the next writer takes it over`);
  }
}

async function checkCloud(io: Io, config: Config, cloudUrl: string, pins: readonly RootKey[], now: () => number, report: Report): Promise<void> {
  let store;
  try {
    store = await openStore(config.dataDir);
  } catch (error) {
    report("fail", `Intent Cloud not checked: ${describeError(error, { dataDir: config.dataDir })}`);
    return;
  }
  try {
    const cloud = cloudFor(io, store, cloudUrl, { keySet: () => null, now });
    const meta = await cloud.meta();
    if (!meta.ok) {
      report("fail", `Intent Cloud ${cloudUrl}: meta answered ${String(meta.status)}; check INTENT_CLOUD_URL, or try later`);
      return;
    }
    const sums = contractSums();
    const served = meta.body.contract_version;
    const header = meta.contractVersion;
    if (served !== CONTRACT_VERSION || header !== CONTRACT_VERSION || meta.body.contract_sums_sha256 !== sums) {
      report(
        "fail",
        `contract mismatch: ${cloudUrl} serves contract ${served} (header ${header ?? "missing"}, SHA256SUMS sha256 ${meta.body.contract_sums_sha256}), ` +
          `this gateway implements ${CONTRACT_VERSION} (SHA256SUMS sha256 ${sums}); update the gateway (npx -y intent-gateway@latest), ` +
          `or set INTENT_CLOUD_URL to a host that serves ${CONTRACT_VERSION}`,
      );
      return;
    }
    report("ok", `contract: ${cloudUrl} serves ${CONTRACT_VERSION}, and its SHA256SUMS matches this gateway's`);

    const statement = await cloud.keyStatement();
    if (!statement.ok) {
      report("fail", `key statement: ${cloudUrl} answered ${String(statement.status)}; try later`);
      return;
    }
    const verified = verifyStatement(statement.body, pins, new Date(now()));
    if (!verified.ok) {
      report(
        "fail",
        `key statement: does not verify against the root key (Appendix F step ${String(verified.step)}: ${verified.reason}); ` +
          `check that --trust-keys holds the root key of ${new URL(cloudUrl).host}`,
      );
      return;
    }
    await store.append("keys", { statement: statement.body });
    const days = Math.floor((verified.keySet.expiresAt.getTime() - now()) / DAY_MS);
    const text = `key statement: signed by ${verified.keySet.rootKid}, valid until ${verified.keySet.expiresAt.toISOString()} (${String(days)} days)`;
    if (days < EXPIRY_WARNING_DAYS) {
      report("warn", `${text}; Intent Cloud publishes the next one before then, and the gateway refuses to start once it lapses`);
    } else {
      report("ok", text);
    }
  } catch (error) {
    report("fail", describeError(error, { cloudUrl }));
  } finally {
    await store.close();
  }
}
