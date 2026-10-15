// Fails when a committed file contains a private term (ADR-0001). The term list is never committed:
// CI passes it as the PRIVATE_TERMS secret, locally it is ~/.config/intent-gateway/private-terms.
// Hits are reported by term number and never by term, so a public CI log never prints what it guards.
//
//   node scripts/public-safety.ts            scan the index (what the next commit will contain)
//   node scripts/public-safety.ts --history  scan every blob reachable from any ref (the public history)
//   --optional                                skip with a notice when no term list exists (contributors have none)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Blob {
  sha: string;
  path: string;
}

export interface Hit {
  where: string;
  line: number | "multi-line" | "path";
  term: number;
}

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, " ");

export function parseTerms(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => normalise(line).trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function decode(content: Buffer): string {
  if (content[0] === 0xff && content[1] === 0xfe) return content.subarray(2).toString("utf16le");
  return content.toString("utf8");
}

// A path that contains a term is itself private, so it is reported as "<path redacted>".
export function findHits(path: string, content: Buffer, terms: readonly string[]): Hit[] {
  const pathHits = terms.flatMap((term, i) => (normalise(path).includes(term) ? [i + 1] : []));
  const where = pathHits.length > 0 ? "<path redacted>" : path;
  const hits: Hit[] = pathHits.map((term) => ({ where, line: "path", term }));
  const lines = decode(content).split("\n").map(normalise);
  const whole = normalise(lines.join(" "));
  terms.forEach((term, i) => {
    const found = lines.flatMap((text, index) => (text.includes(term) ? [index + 1] : []));
    for (const line of found) hits.push({ where, line, term: i + 1 });
    if (found.length === 0 && whole.includes(term)) hits.push({ where, line: "multi-line", term: i + 1 });
  });
  return hits;
}

export function loadTerms(env: NodeJS.ProcessEnv, localFile: string): string[] {
  const source = env.PRIVATE_TERMS ?? (existsSync(localFile) ? readFileSync(localFile, "utf8") : "");
  const terms = parseTerms(source);
  if (terms.length === 0) {
    throw new Error(`no private terms: set PRIVATE_TERMS or create ${localFile}`);
  }
  return terms;
}

// `git cat-file --batch` output: "<sha> <type> <size>\n<content>\n" per object.
export function parseBatch(output: Buffer): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    const [sha, , size] = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (sha === undefined || size === undefined) throw new Error("unexpected git cat-file output");
    const start = headerEnd + 1;
    objects.set(sha, output.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return objects;
}

function git(args: string[], input?: string): Buffer {
  return execFileSync("git", args, { input, maxBuffer: 1 << 30 });
}

function indexBlobs(): Blob[] {
  // "<mode> <sha> <stage>\t<path>"
  return git(["ls-files", "-s", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [meta = "", path = ""] = entry.split("\t");
      return { sha: meta.split(" ")[1] ?? "", path };
    })
    .filter((blob) => blob.sha !== "");
}

function historyBlobs(): Blob[] {
  const objects = git(["rev-list", "--all", "--objects"]).toString("utf8").split("\n").filter(Boolean);
  const types = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], objects.map((o) => o.split(" ")[0]).join("\n"))
    .toString("utf8")
    .split("\n");
  const blobShas = new Set(types.filter((t) => t.endsWith(" blob")).map((t) => t.split(" ")[0]));
  const seen = new Set<string>();
  return objects.flatMap((line) => {
    const space = line.indexOf(" ");
    const sha = space === -1 ? line : line.slice(0, space);
    if (!blobShas.has(sha) || seen.has(sha)) return [];
    seen.add(sha);
    return [{ sha, path: space === -1 ? "" : line.slice(space + 1) }];
  });
}

function main(): void {
  const history = process.argv.includes("--history");
  const localFile = join(homedir(), ".config", "intent-gateway", "private-terms");
  if (process.argv.includes("--optional") && process.env.PRIVATE_TERMS === undefined && !existsSync(localFile)) {
    console.log("public-safety: skipped, no private term list here (maintainers only; CI runs it on main)");
    return;
  }
  const terms = loadTerms(process.env, localFile);
  const blobs = history ? historyBlobs() : indexBlobs();
  const contents = parseBatch(git(["cat-file", "--batch"], blobs.map((b) => b.sha).join("\n") + "\n"));
  const hits = blobs.flatMap((blob) => {
    const label = history ? `${blob.path} @${blob.sha.slice(0, 10)}` : blob.path;
    return findHits(label, contents.get(blob.sha) ?? Buffer.alloc(0), terms);
  });
  for (const hit of hits) console.error(`${hit.where}:${String(hit.line)}: private term #${String(hit.term)}`);
  if (hits.length > 0) {
    console.error(`public-safety: ${String(hits.length)} hit(s); move that content to CLAUDE.local.md`);
    process.exit(1);
  }
  console.log(`public-safety: ${String(blobs.length)} ${history ? "blobs in history" : "staged files"} clean`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) main();
