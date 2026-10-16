#!/usr/bin/env bash
# Outsider end-to-end run: the gateway as a stranger meets it. A fresh HOME, an empty working dir outside the
# repository, a PATH with only node, npm, npx, docker and claude (plus the system's /usr/bin and /bin), and the
# commands from README.md and docs/quickstart.md. Each scenario prints PASS, FAIL or SKIP with its evidence; every
# log stays in the output dir printed at the end. The exit status is 1 when any scenario failed. Docker runs with
# an empty Docker config in the output dir (no registry credentials, as a stranger has none), except the
# --docker build; a failed pull or build is a FAIL line.
#
# It runs on a maintainer's machine, on demand, never in CI: it drives a headless, logged-in Claude Code.
# Before a release it must pass with --tarball (and --docker); after one, with --npm next (docs/release.md).
#
# SAFETY: every claude call uses --strict-mcp-config with a config that names only the gateway under test, no
# built-in tools, and --allowedTools "mcp__gw__*". After each call the run checks Claude's own report of its MCP
# servers and tools and stops at once if anything else was loaded. Never run `claude mcp add` from here.
#
# Usage: scripts/e2e-outsider.sh [--tarball | --npm <version|next> | --docker | --image <ref>]
#                                [--only <a,b,...>] [--out <dir>] [--keep]
# Settings: CLAUDE_BIN (default claude), E2E_CLAUDE_MODEL (default: Claude Code's own), E2E_CLAUDE_TIMEOUT
# (seconds per claude call, default 240), E2E_STDIO=0 (skip the stdio variant of b).
set -Eeuo pipefail

usage() {
  sed -n '2,/^set -E/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

MODE=tarball
VERSION=""
IMAGE_REF=""
OUT=""
ONLY=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) MODE=tarball ;;
    --npm) MODE=npm; VERSION="${2:?--npm needs a version or next}"; shift ;;
    --docker) MODE=docker ;;
    --image) MODE=image; IMAGE_REF="${2:?--image needs a reference}"; shift ;;
    --only) ONLY="${2:?--only needs a list such as b,c}"; shift ;;
    --out) OUT="${2:?--out needs a dir}"; shift ;;
    --keep) KEEP=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "e2e: unknown argument $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
OUT="${OUT:-${TMPDIR:-/tmp}/intent-e2e-$RUN_ID}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
case "$OUT/" in
  "$REPO"/*) echo "e2e: the output dir must be outside the repository ($OUT)" >&2; exit 2 ;;
esac
# npm takes the nearest folder above with a package.json or node_modules as the project, and resolves
# `./intent-gateway.tgz` there, so no folder above the stranger's may have one.
up="$OUT"
while [ "$up" != / ]; do
  up="$(dirname "$up")"
  for marker in package.json node_modules; do
    [ ! -e "$up/$marker" ] || { echo "e2e: $up/$marker would make npm resolve ./intent-gateway.tgz there; use --out under a folder without one" >&2; exit 2; }
  done
done
LOGS="$OUT/logs"
OBIN="$OUT/bin"
OHOME="$OUT/home"
WORK="$OUT/work"
TOOLS="$OUT/tools"
mkdir -p "$LOGS" "$OBIN" "$OHOME" "$WORK" "$TOOLS"
SUMMARY="$OUT/summary.txt"
: >"$SUMMARY"
REAL_HOME="$HOME"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_TIMEOUT="${E2E_CLAUDE_TIMEOUT:-240}"
START_SECONDS=$SECONDS

if [ -z "$ONLY" ]; then
  case "$MODE" in
    docker | image) ONLY="a,g" ;;
    *) ONLY="a,b,c,d,e,f" ;;
  esac
fi
wants() { case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

say() { printf 'e2e: %s\n' "$*" >&2; }
die() { say "$*"; exit 2; }

# ---------------------------------------------------------------------------------------------------- results
FAILS=0
declare -a RESULTS=()
WHY=""
record() { # record <PASS|FAIL|SKIP> <id> <title> <evidence>
  RESULTS+=("$1 $2 $3")
  if [ "$1" = FAIL ]; then FAILS=$((FAILS + 1)); fi
  printf '%s %s: %s\n    %s\n' "$1" "$2" "$3" "$4" | tee -a "$SUMMARY"
  return 0
}
# run_scenario <id> <title> <function>: PASS when the function returns 0 (its evidence in WHY), FAIL otherwise.
run_scenario() {
  local id="$1" title="$2" fn="$3" t0=$SECONDS
  WHY=""
  say "scenario $id: $title"
  if "$fn"; then
    record PASS "$id" "$title" "${WHY:-ok} ($((SECONDS - t0))s)"
  elif [ "${SKIPPED:-0}" = 1 ]; then
    SKIPPED=0
    record SKIP "$id" "$title" "$WHY"
  else
    record FAIL "$id" "$title" "$WHY ($((SECONDS - t0))s)"
  fi
}
# Checks: each sets WHY to the evidence of what was wrong and returns 1.
must_match() { # must_match <file> <ERE> <what>
  grep -Eq -- "$2" "$1" && return 0
  WHY="$3: no match for /$2/ in $1; it ends with: $(tail -n 5 "$1" | tr '\n' '|' | cut -c1-600)"
  return 1
}
must_not_match() { # must_not_match <file> <ERE> <what>
  grep -Eq -- "$2" "$1" || return 0
  WHY="$3: /$2/ found in $1: $(grep -Em 2 -- "$2" "$1" | tr '\n' '|' | cut -c1-600)"
  return 1
}

# ------------------------------------------------------------------------------------------- the outsider's world
need() { command -v "$1" >/dev/null 2>&1 || die "needs $1 on PATH"; }
need node
need curl
need timeout
need setsid
need ss
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] && [ $((NODE_MAJOR % 2)) -eq 0 ] || die "needs Node 24 LTS or later even release on PATH, found $(node --version)"
for tool in node npm npx; do ln -sf "$(command -v "$tool")" "$OBIN/$tool"; done
if command -v docker >/dev/null 2>&1; then ln -sf "$(command -v docker)" "$OBIN/docker"; fi
if command -v "$CLAUDE_BIN" >/dev/null 2>&1; then ln -sf "$(command -v "$CLAUDE_BIN")" "$OBIN/claude"; fi
OPATH="$OBIN:/usr/bin:/bin"
for name in intent intent-gateway; do
  if PATH="$OPATH" command -v "$name" >/dev/null 2>&1; then die "$name is on the outsider PATH ($(PATH="$OPATH" command -v "$name")); remove it first"; fi
done

# outsider [VAR=value ...] <command ...>: run as the stranger, in the empty working dir, with nothing inherited.
outsider() {
  (cd "$WORK" && env -i HOME="$OHOME" PATH="$OPATH" LANG=C.UTF-8 TERM=dumb "$@")
}

# The gateway command the stranger types.
case "$MODE" in
  tarball) SPEC="file:$WORK/intent-gateway.tgz" ;;
  npm) SPEC="intent-gateway@$VERSION" ;;
  *) SPEC="" ;;
esac
gw() { outsider npx -y "$SPEC" "$@"; }

# The helper: free ports, a minimal MCP client, Claude's stream-json report, tampering, kill-in-flight.
HELPER="$TOOLS/e2e-helper.mjs"
cat >"$HELPER" <<'JS'
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const [cmd, ...args] = process.argv.slice(2);
const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

async function mcpCall(url, token, tool, json) {
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== "-") base.authorization = `Bearer ${token}`;
  let session;
  let version;
  async function post(body, id) {
    const headers = { ...base };
    if (session !== undefined) headers["mcp-session-id"] = session;
    if (version !== undefined) headers["mcp-protocol-version"] = version;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    if (id === undefined) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
    const messages = sse ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))) : [JSON.parse(text)];
    const reply = messages.find((m) => m.id === id);
    if (reply === undefined) throw new Error(`no reply to request ${id}: ${text.slice(0, 300)}`);
    if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error));
    return reply.result;
  }
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-outsider", version: "1" } } }, 1);
  version = init.protocolVersion;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const result = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: JSON.parse(json) } }, 2);
  console.log(textOf(result.content));
  if (result.isError === true) process.exitCode = 1;
}

// Claude's stream-json output: what it loaded, what it called, what the tools returned and what it said. Exit 3 when
// it loaded or called anything but the one gateway server (the SAFETY rule).
function claudeReport(file, server) {
  const problems = [];
  let init = null;
  let result = null;
  const called = [];
  const toolResults = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "system" && m.subtype === "init") init = m;
    for (const c of m.message?.content ?? []) {
      if (m.type === "assistant" && c.type === "tool_use") called.push(c.name);
      if (m.type === "user" && c.type === "tool_result") toolResults.push(textOf(c.content));
    }
    if (m.type === "result") result = m;
  }
  if (init === null) problems.push("no init message: cannot tell which MCP servers were loaded");
  else {
    const servers = (init.mcp_servers ?? []).map((s) => `${s.name}(${s.status})`);
    console.log(`servers: ${servers.join(", ")}`);
    console.log(`tools: ${(init.tools ?? []).join(", ")}`);
    const names = (init.mcp_servers ?? []).map((s) => s.name);
    if (names.length !== 1 || names[0] !== server) problems.push(`MCP servers other than ${server}: ${names.join(", ")}`);
    const foreign = (init.tools ?? []).filter((t) => !t.startsWith(`mcp__${server}__`));
    if (foreign.length > 0) problems.push(`tools outside the gateway: ${foreign.join(", ")}`);
  }
  const foreignCalls = called.filter((t) => !t.startsWith(`mcp__${server}__`));
  if (foreignCalls.length > 0) problems.push(`called tools outside the gateway: ${foreignCalls.join(", ")}`);
  console.log(`called: ${called.join(", ") || "(nothing)"}`);
  for (const [i, t] of toolResults.entries()) console.log(`tool result ${i + 1}:\n${t}`);
  console.log(`result (${result?.subtype ?? "none"}): ${result?.result ?? ""}`);
  for (const p of problems) console.log(`SAFETY: ${p}`);
  process.exit(problems.length > 0 ? 3 : 0);
}

// Wait for the chain to grow by a disclosure line, then SIGKILL the gateway at once, before its answer is logged.
function spinKill(file, pid, ms) {
  const from = statSync(file).size;
  const deadline = Date.now() + Number(ms);
  while (Date.now() < deadline) {
    const size = statSync(file).size;
    if (size <= from) continue;
    const buf = Buffer.alloc(size - from);
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, buf.length, from);
    closeSync(fd);
    const added = buf.toString("utf8");
    if (!added.includes('"kind":"disclosure"')) continue;
    process.kill(Number(pid), "SIGKILL");
    const late = /"kind":"(receipt|unacknowledged|discarded)"/.test(added);
    console.log(late ? "late: the answer was logged before the kill" : `killed ${pid} with a disclosure logged and no answer yet`);
    process.exit(late ? 4 : 0);
  }
  console.log("no disclosure appeared");
  process.exit(2);
}

// Change one byte of the chain: a digit of the second entry's timestamp. The line stays canonical JSON; its hash breaks.
function tamper(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const i = lines.length > 2 ? 1 : 0;
  const at = lines[i].indexOf('"ts":"') + 6;
  const j = lines[i].slice(at).search(/[0-9]/) + at;
  const digit = String((Number(lines[i][j]) + 1) % 10);
  lines[i] = lines[i].slice(0, j) + digit + lines[i].slice(j + 1);
  writeFileSync(file, lines.join("\n"));
  console.log(`changed line ${i + 1}, offset ${j}, to ${digit}`);
}

switch (cmd) {
  case "free-port": {
    const s = createServer().listen(0, "127.0.0.1", () => {
      console.log(s.address().port);
      s.close();
    });
    break;
  }
  case "mcp-http": {
    const [url, token] = args;
    const server = { type: "http", url, ...(token === "-" ? {} : { headers: { Authorization: `Bearer ${token}` } }) };
    console.log(JSON.stringify({ mcpServers: { gw: server } }));
    break;
  }
  case "mcp-stdio": {
    const [home, path, command, ...rest] = args;
    console.log(JSON.stringify({ mcpServers: { gw: { type: "stdio", command, args: rest, env: { HOME: home, PATH: path } } } }));
    break;
  }
  case "mcp-call":
    await mcpCall(...args);
    break;
  case "claude-report":
    claudeReport(...args);
    break;
  case "spin-kill":
    spinKill(...args);
    break;
  case "tamper":
    tamper(...args);
    break;
  default:
    console.error(`unknown helper command ${cmd}`);
    process.exit(2);
}
JS
helper() { node "$HELPER" "$@"; }

# ------------------------------------------------------------------------------------------------- cleanup
declare -a PGIDS=()
declare -a CONTAINERS=()
declare -a VOLUMES=()
BUILT_IMAGE=""
cleanup() {
  local pg
  for pg in "${PGIDS[@]}"; do kill -TERM -- "-$pg" 2>/dev/null || true; done
  for pg in "${PGIDS[@]}"; do kill -KILL -- "-$pg" 2>/dev/null || true; done
  if [ ${#CONTAINERS[@]} -gt 0 ]; then docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true; fi
  if [ ${#VOLUMES[@]} -gt 0 ]; then docker volume rm -f "${VOLUMES[@]}" >/dev/null 2>&1 || true; fi
  if [ -n "$BUILT_IMAGE" ] && [ "$KEEP" = 0 ]; then docker image rm -f "$BUILT_IMAGE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ------------------------------------------------------------------------------------------------- gateways
# wait_for <file> <ERE> <seconds> [pid]: until the file matches; fails early when the pid has exited.
wait_for() {
  local deadline=$((SECONDS + $3))
  while [ $SECONDS -lt $deadline ]; do
    grep -Eq -- "$2" "$1" 2>/dev/null && return 0
    if [ -n "${4:-}" ] && ! kill -0 "$4" 2>/dev/null; then
      grep -Eq -- "$2" "$1" 2>/dev/null && return 0
      WHY="the process exited before /$2/ appeared in $1: $(tail -n 5 "$1" | tr '\n' '|' | cut -c1-600)"
      return 1
    fi
    sleep 0.5
  done
  WHY="no /$2/ in $1 after $3s: $(tail -n 5 "$1" 2>/dev/null | tr '\n' '|' | cut -c1-600)"
  return 1
}

# start_gateway <log name>: `demo --http` as the stranger, on a free port. Sets GW_PGID, GW_PORT, GW_URL, GW_ERR.
GW_PGID=""
GW_PORT=""
GW_URL=""
GW_ERR=""
start_gateway() {
  GW_PORT="$(helper free-port)"
  GW_ERR="$LOGS/$1.err"
  local extra=()
  if [ -n "${INTENT_DEMO_CONFIRM_PORT:-}" ]; then extra+=("INTENT_DEMO_CONFIRM_PORT=$INTENT_DEMO_CONFIRM_PORT"); fi
  (cd "$WORK" && exec setsid env -i HOME="$OHOME" PATH="$OPATH" LANG=C.UTF-8 TERM=dumb INTENT_HTTP_PORT="$GW_PORT" \
    "${extra[@]}" npx -y "$SPEC" demo --http) >"$LOGS/$1.out" 2>"$GW_ERR" </dev/null &
  GW_PGID=$!
  PGIDS+=("$GW_PGID")
  wait_for "$GW_ERR" 'MCP over HTTP at http://127\.0\.0\.1:[0-9]+/mcp' 180 "$GW_PGID" || return 1
  GW_URL="$(grep -Eo 'MCP over HTTP at http://127\.0\.0\.1:[0-9]+/mcp' "$GW_ERR" | tail -n 1 | sed 's/^MCP over HTTP at //')"
  [ "$GW_URL" = "http://127.0.0.1:$GW_PORT/mcp" ] || { WHY="the gateway serves at $GW_URL, not on the port it was given ($GW_PORT)"; return 1; }
}
stop_gateway() {
  [ -n "$GW_PGID" ] || return 0
  kill -TERM -- "-$GW_PGID" 2>/dev/null || true
  local i
  for i in $(seq 1 40); do
    kill -0 -- "-$GW_PGID" 2>/dev/null || break
    [ "$i" = 40 ] && kill -KILL -- "-$GW_PGID" 2>/dev/null
    sleep 0.25
  done
  GW_PGID=""
}
# The pid listening on a port: the gateway's node process, not the npx wrapper around it.
listener_pid() { ss -ltnpH "sport = :$1" | grep -Eo 'pid=[0-9]+' | head -n 1 | cut -d= -f2; }

# ------------------------------------------------------------------------------------------------- claude
# ask_claude <name> <mcp config> <new|continue> <prompt>: one headless turn. Writes $LOGS/claude-<name>.{jsonl,txt};
# REPORT is the .txt. Stops the whole run if Claude loaded or called anything but the gateway under test.
REPORT=""
ask_claude() {
  local name="$1" config="$2" how="$3" prompt="$4" cwd="${5:-$WORK}"
  local args=(-p "$prompt")
  [ "$how" = continue ] && args+=(--continue)
  args+=(--strict-mcp-config --mcp-config "$config" --tools "" --setting-sources "" --permission-mode dontAsk
    --output-format stream-json --verbose --disallowedTools "mcp__claude_ai_intent")
  if [ -n "${E2E_CLAUDE_MODEL:-}" ]; then args+=(--model "$E2E_CLAUDE_MODEL"); fi
  args+=(--allowedTools "mcp__gw__*")
  local passthrough=()
  local v
  for v in USER LOGNAME ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR CLAUDE_CODE_OAUTH_TOKEN; do
    if [ -n "${!v:-}" ]; then passthrough+=("$v=${!v}"); fi
  done
  REPORT="$LOGS/claude-$name.txt"
  local rc=0
  # Claude keeps the developer's real HOME: it is their own, logged-in Claude Code. The gateway it reaches is ours.
  (cd "$cwd" && env -i HOME="$REAL_HOME" PATH="$OPATH" LANG=C.UTF-8 TERM=dumb "${passthrough[@]}" \
    ENABLE_CLAUDEAI_MCP_SERVERS=false MCP_TIMEOUT=180000 \
    timeout "$CLAUDE_TIMEOUT" claude "${args[@]}") >"$LOGS/claude-$name.jsonl" 2>"$LOGS/claude-$name.err" </dev/null || rc=$?
  local report_rc=0
  helper claude-report "$LOGS/claude-$name.jsonl" gw >"$REPORT" || report_rc=$?
  if [ "$report_rc" = 3 ]; then
    cat "$REPORT" >&2
    say "SAFETY: claude reached something other than the gateway under test; stopping the run (see $REPORT)"
    exit 3
  fi
  if [ "$rc" != 0 ]; then
    WHY="claude exited $rc (timeout is ${CLAUDE_TIMEOUT}s); see $LOGS/claude-$name.err and $REPORT"
    return 1
  fi
}

# ----------------------------------------------------------------------------------- target-specific commands
# TARGET is npx (the stranger's gateway) or docker (the container CONTAINER).
TARGET=npx
CONTAINER=""
# -v: every entry, with the approval link and one "sent" row per request.
t_log() { if [ "$TARGET" = docker ]; then docker exec "$CONTAINER" intent log --demo -v; else gw log --demo -v; fi; }
t_verify() { if [ "$TARGET" = docker ]; then docker exec "$CONTAINER" intent verify --demo; else gw verify --demo; fi; }
t_code() {
  if [ "$TARGET" = docker ]; then docker exec "$CONTAINER" cat /data/demo/approval-code
  else cat "$OHOME/.local/share/intent-gateway/demo/approval-code"; fi
}

# ------------------------------------------------------------------------------------------------- scenarios
# shellcheck disable=SC2016 # the dollar signs are the prompt's own
PROMPT_CART='Find running shoes to ZIP 94103, under $200, and prepare a cart for the cheapest.'
PROMPT_STATUS='Check the approval status.'
# shellcheck disable=SC2016
PROMPT_BLOCKED='Find a bottle of alcohol to ZIP 94103, under $40.'

scenario_a() {
  local f
  f="$LOGS/a-help.txt"
  gw_first --help >"$f" 2>&1 || { WHY="--help exited non-zero; see $f"; return 1; }
  must_match "$f" 'demo' "--help names the demo" || return 1
  f="$LOGS/a-doctor.txt"
  gw_first doctor --demo >"$f" 2>&1 || { WHY="doctor --demo exited non-zero; see $f"; return 1; }
  must_match "$f" '^doctor: ok' "doctor --demo" || return 1
  f="$LOGS/a-verify.txt"
  gw_first verify --demo >"$f" 2>&1 || { WHY="verify --demo on an empty chain exited non-zero; see $f"; return 1; }
  must_match "$f" '^verify: ok' "verify --demo on an empty chain" || return 1
  must_match "$f" 'No entries yet' "verify --demo says the chain is empty" || return 1
  WHY="--help, doctor --demo: ok, verify --demo: ok on an empty chain"
}
# The first-run commands exactly as the README types them.
gw_first() {
  case "$MODE" in
    tarball) outsider npx -y ./intent-gateway.tgz "$@" ;;
    npm) outsider npx -y "$SPEC" "$@" ;;
    *) docker run --rm -e INTENT_DEMO=1 -v "$VOL_A:/data" "$IMAGE" "$@" ;;
  esac
}

APPROVAL_URL=""
MCP_CONFIG=""
# Ask for a cart; find its approval link in the log, not in Claude's prose.
cart_step() { # cart_step <name>
  ask_claude "$1" "$MCP_CONFIG" new "$PROMPT_CART" || return 1
  must_match "$REPORT" '^called: .*mcp__gw__find_offers' "Claude called find_offers" || return 1
  must_match "$REPORT" '^called: .*mcp__gw__create_cart' "Claude called create_cart" || return 1
  local f="$LOGS/$1-log.txt"
  t_log >"$f" 2>&1 || { WHY="log --demo failed; see $f"; return 1; }
  APPROVAL_URL="$(grep -Eo 'http://127\.0\.0\.1:[0-9]+/confirm/c/[A-Za-z0-9_-]+' "$f" | tail -n 1 || true)"
  [ -n "$APPROVAL_URL" ] || { WHY="no approval_url in log --demo; see $f"; return 1; }
}
# post_confirm <name> <code or empty>: GET the confirm page, POST approve. Sets HTTP_STATUS, BODY.
HTTP_STATUS=""
BODY=""
post_confirm() {
  local jar="$LOGS/$1.cookies" page="$LOGS/$1-page.html" csrf
  BODY="$LOGS/$1-response.html"
  local got
  got="$(curl -sS -c "$jar" -b "$jar" -o "$page" -w '%{http_code}' "$APPROVAL_URL")" || { WHY="GET $APPROVAL_URL failed"; return 1; }
  [ "$got" = 200 ] || { WHY="GET $APPROVAL_URL gave $got; see $page"; return 1; }
  csrf="$(grep -Eo 'name="csrf" value="[^"]+"' "$page" | head -n 1 | sed 's/.*value="//; s/"$//')"
  [ -n "$csrf" ] || { WHY="no csrf token on the confirm page; see $page"; return 1; }
  local form=(--data-urlencode "csrf=$csrf" --data-urlencode "action=approve")
  if [ -n "$2" ]; then form+=(--data-urlencode "code=$2"); fi
  HTTP_STATUS="$(curl -sS -c "$jar" -b "$jar" -o "$BODY" -w '%{http_code}' "${form[@]}" "$APPROVAL_URL")" || { WHY="POST $APPROVAL_URL failed"; return 1; }
}

# b and c share one cart: c tries to approve it without the code first, then b approves it with the code.
B_OK=0
C_OK=0
B_WHY=""
C_WHY=""
happy_path() { # happy_path <prefix>
  local p="$1"
  B_OK=0 C_OK=0 B_WHY="" C_WHY=""
  if ! cart_step "$p-cart"; then B_WHY="$WHY"; C_WHY="no cart to approve: $WHY"; return 0; fi
  # c: approve without the demo code.
  if post_confirm "$p-nocode" ""; then
    if [ "$HTTP_STATUS" != 403 ]; then
      C_WHY="POST approve without the code gave $HTTP_STATUS, not 403; see $BODY"
    elif ask_claude "$p-status-pending" "$MCP_CONFIG" continue "$PROMPT_STATUS" &&
      must_match "$REPORT" '^called: .*mcp__gw__get_approval_status' "Claude called get_approval_status" &&
      must_not_match "$REPORT" 'Approver passkey fingerprint' "status after a refused approve"; then
      C_OK=1
      C_WHY="POST without the code: 403 ($(grep -Eo '<h1>[^<]*' "$BODY" | head -n 1 | sed 's/<h1>//')); status not approved: $(grep -A2 -m1 '^tool result' "$REPORT" | tail -n 1 | cut -c1-160)"
    else
      C_WHY="$WHY"
    fi
  else
    C_WHY="$WHY"
  fi
  # b: approve with the code from the data dir.
  local code
  code="$(t_code 2>/dev/null | tr -d '[:space:]' || true)"
  [ -n "$code" ] || { B_WHY="no demo code in the data dir"; return 0; }
  post_confirm "$p-approve" "$code" || { B_WHY="$WHY"; return 0; }
  [ "$HTTP_STATUS" = 200 ] || { B_WHY="POST approve with the code gave $HTTP_STATUS; see $BODY"; return 0; }
  must_match "$BODY" 'Approved' "the confirm page says approved" || { B_WHY="$WHY"; return 0; }
  ask_claude "$p-status-approved" "$MCP_CONFIG" continue "$PROMPT_STATUS" || { B_WHY="$WHY"; return 0; }
  must_match "$REPORT" 'Approver passkey fingerprint' "get_approval_status reports the approval" || { B_WHY="$WHY"; return 0; }
  must_match "$REPORT" '^result \(success\): .*[Aa]pproved' "Claude says approved" || { B_WHY="$WHY"; return 0; }
  local f="$LOGS/$p-verify.txt"
  t_verify >"$f" 2>&1 || { B_WHY="verify --demo exited non-zero; see $f"; return 0; }
  must_match "$f" '^verify: ok' "verify --demo after the purchase" || { B_WHY="$WHY"; return 0; }
  must_match "$f" 'verified: 1' "verify counts the approval" || { B_WHY="$WHY"; return 0; }
  B_OK=1
  B_WHY="offers → cart → $APPROVAL_URL → approved with the code → agent reports approved → verify: ok"
}
scenario_b_from_happy() { WHY="$B_WHY"; [ "$B_OK" = 1 ]; }
scenario_c_from_happy() { WHY="$C_WHY"; [ "$C_OK" = 1 ]; }

scenario_b_stdio() {
  local home="$OUT/home-stdio" cwd="$OUT/work-stdio"
  mkdir -p "$home" "$cwd"
  # Warm the stranger's npx cache, so the first MCP start fits in Claude's server start timeout.
  (cd "$cwd" && env -i HOME="$home" PATH="$OPATH" npx -y "$SPEC" --version) >"$LOGS/b2-warm.txt" 2>&1 || { WHY="npx $SPEC --version failed; see $LOGS/b2-warm.txt"; return 1; }
  local config="$OUT/mcp-stdio.json"
  helper mcp-stdio "$home" "$OPATH" npx -y "$SPEC" demo >"$config"
  ask_claude b2-stdio-cart "$config" new "$PROMPT_CART" "$cwd" || return 1
  must_match "$REPORT" '^called: .*mcp__gw__create_cart' "Claude called create_cart over stdio" || return 1
  must_match "$REPORT" 'Approval link: http://127\.0\.0\.1:[0-9]+/confirm/c/' "create_cart returned an approval link" || return 1
  local f="$LOGS/b2-log.txt"
  (cd "$cwd" && env -i HOME="$home" PATH="$OPATH" npx -y "$SPEC" log --demo -v) >"$f" 2>&1 || { WHY="log --demo failed; see $f"; return 1; }
  must_match "$f" 'approval asked' "the chain records the approval request" || return 1
  f="$LOGS/b2-verify.txt"
  (cd "$cwd" && env -i HOME="$home" PATH="$OPATH" npx -y "$SPEC" verify --demo) >"$f" 2>&1 || { WHY="verify --demo exited non-zero; see $f"; return 1; }
  must_match "$f" '^verify: ok' "verify --demo after the stdio session" || return 1
  WHY="stdio: offers → cart with an approval link, log records it, verify: ok (approval not tried: the confirm page lives in the gateway Claude stops after each -p turn)"
}

sent_rows() { grep -Ec '^ +#[0-9]+ +sent ' "$1" || true; }
scenario_d() {
  local before="$LOGS/d-log-before.txt" after="$LOGS/d-log-after.txt" n0 n1
  t_log >"$before" 2>&1
  n0="$(sent_rows "$before")"
  ask_claude d-blocked "$MCP_CONFIG" new "$PROMPT_BLOCKED" || return 1
  t_log >"$after" 2>&1
  n1="$(sent_rows "$after")"
  [ "$n0" = "$n1" ] || { WHY="asking for alcohol added $((n1 - n0)) sent row(s); see $after and $REPORT"; return 1; }
  local agent="the agent did not call find_offers"
  grep -Eq '^called: .*find_offers' "$REPORT" && agent="the agent called find_offers"
  # The same request straight to the gateway, so the gateway's own block is checked whatever the agent chose.
  local direct="$LOGS/d-direct.txt"
  helper mcp-call "$GW_URL" - find_offers '{"category":"alcohol","product":"red wine","budget_usd":40,"zip":"94103"}' >"$direct" 2>&1 || true
  t_log >"$after" 2>&1
  [ "$(sent_rows "$after")" = "$n0" ] || { WHY="a find_offers for alcohol was sent; see $after and $direct"; return 1; }
  must_match "$after" 'blocked .*nothing was sent' "log shows the alcohol search blocked" || return 1
  WHY="$agent; no new sent row; a direct find_offers for alcohol: $(grep -m1 -v '^DEMO' "$direct" | cut -c1-140); log: $(grep -E 'blocked ' "$after" | tail -n 1 | sed 's/  */ /g' | cut -c1-160)"
}

scenario_e() {
  local copy="$OUT/tamper-data"
  rm -rf "$copy"
  mkdir -p "$copy"
  cp -a "$OHOME/.local/share/intent-gateway/demo" "$copy/demo"
  local f="$LOGS/e-verify-copy.txt"
  outsider INTENT_DATA_DIR="$copy" npx -y "$SPEC" verify --demo >"$f" 2>&1 || { WHY="verify of the untouched copy failed; see $f"; return 1; }
  must_match "$f" '^verify: ok' "verify of the untouched copy" || return 1
  local edit
  edit="$(helper tamper "$copy/demo/audit.jsonl")"
  f="$LOGS/e-verify-tampered.txt"
  local rc=0
  outsider INTENT_DATA_DIR="$copy" npx -y "$SPEC" verify --demo >"$f" 2>&1 || rc=$?
  [ "$rc" != 0 ] || { WHY="verify exited 0 on a tampered chain ($edit); see $f"; return 1; }
  must_not_match "$f" '^verify: ok' "verify of the tampered chain" || return 1
  WHY="$edit → verify exit $rc: $(grep -Ei 'break|fail|mismatch' "$f" | head -n 1 | cut -c1-160)"
}

scenario_f_restart() {
  stop_gateway
  start_gateway f-restart || return 1
  local f="$LOGS/f-restart-verify.txt"
  gw verify --demo >"$f" 2>&1 || { WHY="verify after a restart exited non-zero; see $f"; return 1; }
  must_match "$f" '^verify: ok' "verify after a restart" || return 1
  WHY="stopped with SIGTERM, started again on the same data dir, verify: ok"
}

scenario_f_kill() {
  local chain="$OHOME/.local/share/intent-gateway/demo/audit.jsonl" attempt pid out
  for attempt in 1 2 3; do
    pid="$(listener_pid "$GW_PORT")"
    [ -n "$pid" ] || { WHY="no process listens on the gateway port $GW_PORT"; return 1; }
    out="$LOGS/f-kill-$attempt.txt"
    helper spin-kill "$chain" "$pid" 30000 >"$out" 2>&1 &
    local spinner=$!
    sleep 0.3
    helper mcp-call "$GW_URL" - find_offers '{"category":"running-shoes","budget_usd":200,"zip":"94103"}' >"$LOGS/f-kill-$attempt-call.txt" 2>&1 || true
    local rc=0
    wait "$spinner" || rc=$?
    stop_gateway
    start_gateway "f-kill-$attempt-restart" || return 1
    local f="$LOGS/f-kill-$attempt-verify.txt"
    gw verify --demo >"$f" 2>&1 || { WHY="verify after kill -9 exited non-zero ($(cat "$out")); see $f"; return 1; }
    must_match "$f" '^verify: ok' "verify after kill -9" || return 1
    if [ "$rc" = 0 ]; then
      must_match "$f" 'maybe sent' "verify names the send with no answer" || return 1
      WHY="attempt $attempt: $(cat "$out"); next start served; verify: ok with: $(grep -m1 'maybe sent' "$f" | sed 's/^ *//' | cut -c1-160)"
      return 0
    fi
    say "kill attempt $attempt: $(cat "$out"); trying again"
  done
  SKIPPED=1
  WHY="the gateway logged the answer before the kill in 3 attempts (the demo Intent Cloud is in-process and answers within milliseconds); restart and verify were ok each time"
  return 1
}

# ---------------------------------------------------------------------------------------------------- docker
IMAGE=""
VOL_A=""
IMAGE_READY=0
docker_name() { printf 'intent-e2e-%s-%s' "$RUN_ID" "$1"; }

# outsider_docker: from here on, every docker command runs as a stranger's would: with an empty Docker config
# (no registry credentials, so a pull is anonymous) and the same daemon. Stale credentials in the maintainer's
# ~/.docker/config.json made GHCR deny a public image that an outsider can pull. A --docker build runs before
# this, with the maintainer's config and buildx.
outsider_docker() {
  if [ -z "${DOCKER_HOST:-}" ]; then
    DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
    if [ -n "$DOCKER_HOST" ]; then export DOCKER_HOST; else unset DOCKER_HOST; fi
  fi
  unset DOCKER_CONTEXT
  export DOCKER_CONFIG="$OUT/docker-config"
  mkdir -p "$DOCKER_CONFIG"
}

# g1a: the image as the README runs it, without INTENT_DEMO, reaches Intent Cloud staging, prints the connect line
# with the token and serves; `doctor` inside the container is ok.
scenario_g_staging() {
  local c f logs i
  c="$(docker_name staging)"
  CONTAINERS+=("$c")
  VOLUMES+=("$c")
  f="$LOGS/g-staging-run.txt"
  docker run -d --name "$c" -v "$c:/data" "$IMAGE" >"$f" 2>&1 || { WHY="docker run failed; see $f"; return 1; }
  logs="$LOGS/g-staging-logs.txt"
  for i in $(seq 1 120); do
    docker logs "$c" >"$logs" 2>&1 || true
    grep -q 'claude mcp add' "$logs" && break
    [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || break
    sleep 1
  done
  must_match "$logs" 'claude mcp add intent --transport http http://127\.0\.0\.1:8787/mcp --header "Authorization: Bearer [A-Za-z0-9_-]{32,}"' "the connect line with the token" || return 1
  must_match "$logs" 'MCP over HTTP at' "the gateway serves" || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || { WHY="the container stopped; see $logs"; return 1; }
  f="$LOGS/g-staging-doctor.txt"
  docker exec "$c" intent doctor >"$f" 2>&1 || { WHY="doctor in the container exited non-zero; see $f"; return 1; }
  must_match "$f" '^doctor: ok' "doctor against staging" || return 1
  WHY="connect line with the token; serving; doctor: ok against staging"
}

# g1b, g1c: when Intent Cloud cannot be used, the image without INTENT_DEMO exits cleanly with the demo re-run line
# and prints no token: staging unreachable (no network) and a host with no pinned root key.
scenario_g_nocloud() { # scenario_g_nocloud <name> <docker run args...>
  local name="$1" c f rc=0
  shift
  c="$(docker_name "$name")"
  CONTAINERS+=("$c")
  VOLUMES+=("$c")
  f="$LOGS/g-$name.txt"
  timeout 180 docker run --name "$c" "$@" -v "$c:/data" "$IMAGE" >"$f" 2>&1 || rc=$?
  [ "$rc" != 0 ] || { WHY="the container exited 0; see $f"; return 1; }
  [ "$rc" != 124 ] || { WHY="the container did not exit within 180s; see $f"; return 1; }
  must_match "$f" 'INTENT_DEMO=1' "the exit message gives the demo re-run line" || return 1
  must_not_match "$f" 'Bearer [A-Za-z0-9_-]{32,}' "no token in the output" || return 1
  local token
  token="$(docker run --rm -v "$c:/data" --entrypoint cat "$IMAGE" /data/http-token 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -n "$token" ]; then must_not_match "$f" "$token" "the saved token is not in the output" || return 1; fi
  WHY="exit $rc: $(grep -m1 'INTENT_DEMO=1' "$f" | cut -c1-200); no token printed"
}
scenario_g_offline() { scenario_g_nocloud offline --network none; }
scenario_g_unpinned() { scenario_g_nocloud unpinned -e INTENT_CLOUD_URL=https://unpinned.example; }

scenario_g_demo() {
  local c f host_port=8787
  c="$(docker_name demo)"
  CONTAINERS+=("$c")
  VOLUMES+=("$c")
  if ss -ltnH 'sport = :8788' | grep -q .; then
    WHY="host port 8788 is in use ($(ss -ltnpH 'sport = :8788' | head -n 1)); the image's confirm page needs it (README: -p 127.0.0.1:8788:8788)"
    return 1
  fi
  if ss -ltnH 'sport = :8787' | grep -q .; then host_port="$(helper free-port)"; fi
  f="$LOGS/g-demo-run.txt"
  docker run -d --name "$c" -p "127.0.0.1:$host_port:8787" -p 127.0.0.1:8788:8788 -e INTENT_DEMO=1 -v "$c:/data" "$IMAGE" >"$f" 2>&1 ||
    { WHY="docker run failed; see $f"; return 1; }
  local logs="$LOGS/g-demo-logs.txt" i
  for i in $(seq 1 120); do
    docker logs "$c" >"$logs" 2>&1 || true
    grep -q 'claude mcp add' "$logs" && break
    [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || break
    sleep 1
  done
  must_match "$logs" 'claude mcp add intent --transport http http://127\.0\.0\.1:8787/mcp --header "Authorization: Bearer [A-Za-z0-9_-]{32,}"' "the connect line with the token" || return 1
  local token url
  token="$(grep -Eo 'Bearer [A-Za-z0-9_-]{32,}' "$logs" | head -n 1 | cut -d' ' -f2)"
  url="http://127.0.0.1:$host_port/mcp"
  GW_URL="$url"
  MCP_CONFIG="$OUT/mcp-docker.json"
  helper mcp-http "$url" "$token" >"$MCP_CONFIG"
  TARGET=docker
  CONTAINER="$c"
  local cwd_saved="$WORK"
  WORK="$OUT/work-docker"
  mkdir -p "$WORK"
  happy_path g || true
  WORK="$cwd_saved"
  [ "$B_OK" = 1 ] || { WHY="happy path against the container: $B_WHY"; return 1; }
  [ "$C_OK" = 1 ] || { WHY="approve without the code against the container: $C_WHY"; return 1; }
  # A restart reuses the token and prints it no second time; the chain still verifies.
  docker restart "$c" >/dev/null 2>&1 || { WHY="docker restart failed"; return 1; }
  for i in $(seq 1 120); do
    docker logs "$c" >"$logs" 2>&1 || true
    [ "$(grep -c 'MCP over HTTP at' "$logs")" -ge 2 ] && break
    sleep 1
  done
  [ "$(grep -c 'MCP over HTTP at' "$logs")" -ge 2 ] || { WHY="the restarted container is not serving; see $logs"; return 1; }
  [ "$(grep -c -- "$token" "$logs")" = 1 ] || { WHY="the token appears $(grep -c -- "$token" "$logs") times in the log after a restart; see $logs"; return 1; }
  f="$LOGS/g-restart-verify.txt"
  docker exec "$c" intent verify --demo >"$f" 2>&1 || { WHY="verify after docker restart exited non-zero; see $f"; return 1; }
  must_match "$f" '^verify: ok' "verify after docker restart" || return 1
  WHY="connect line with the token; $B_WHY; without the code: 403, still not approved; restart: token not printed again, verify: ok"
}

# ------------------------------------------------------------------------------------------------- the run
say "mode $MODE; output in $OUT"
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || die "needs Claude Code ($CLAUDE_BIN) on PATH, logged in"

case "$MODE" in
  tarball)
    say "building the package in $REPO"
    (cd "$REPO" && { [ -d node_modules ] || pnpm install --frozen-lockfile; } && pnpm build && mkdir -p "$OUT/pack" &&
      npm pack --pack-destination "$OUT/pack") >"$LOGS/pack.txt" 2>&1 || die "pnpm build && npm pack failed; see $LOGS/pack.txt"
    cp "$(ls "$OUT"/pack/intent-gateway-*.tgz)" "$WORK/intent-gateway.tgz"
    ;;
  npm) ;;
  docker)
    need docker
    IMAGE="intent-gateway-e2e:$RUN_ID"
    say "building $IMAGE"
    if docker build -t "$IMAGE" "$REPO" >"$LOGS/docker-build.txt" 2>&1; then
      BUILT_IMAGE="$IMAGE"
      IMAGE_READY=1
    else
      record FAIL build "docker build -t $IMAGE" "$(tail -n 3 "$LOGS/docker-build.txt" | tr '\n' '|' | cut -c1-600); see $LOGS/docker-build.txt"
    fi
    outsider_docker
    ;;
  image)
    need docker
    IMAGE="$IMAGE_REF"
    outsider_docker
    say "pulling $IMAGE with no registry credentials, as an outsider would"
    if docker pull "$IMAGE" >"$LOGS/docker-pull.txt" 2>&1; then
      IMAGE_READY=1
    else
      record FAIL pull "docker pull $IMAGE, with no registry credentials" "$(tail -n 3 "$LOGS/docker-pull.txt" | tr '\n' '|' | cut -c1-600); see $LOGS/docker-pull.txt"
    fi
    ;;
esac

case "$MODE" in
  tarball | npm)
    wants a && run_scenario a "first run: --help, doctor --demo, verify --demo on an empty chain" scenario_a
    if wants b || wants c || wants d || wants e || wants f; then
      if start_gateway gateway; then
        MCP_CONFIG="$OUT/mcp-http.json"
        helper mcp-http "$GW_URL" - >"$MCP_CONFIG"
        if wants b || wants c; then
          t_happy=$SECONDS
          say "scenarios b and c share one cart: c tries it without the demo code first"
          happy_path b || true
          B_WHY="$B_WHY [b and c together: $((SECONDS - t_happy))s]"
          wants c && run_scenario c "approve without the demo code: 403, still pending" scenario_c_from_happy
          wants b && run_scenario b "happy path over demo --http: offers, cart, approve, approved, verify ok" scenario_b_from_happy
        fi
        wants d && run_scenario d "a blocked request (alcohol): refused, nothing sent" scenario_d
        wants e && run_scenario e "tamper one byte of a copied chain: verify fails" scenario_e
        if wants f; then
          run_scenario f1 "restart the gateway: still verifies" scenario_f_restart
          run_scenario f2 "kill -9 with a find_offers in flight: next start works, verify ok, maybe sent" scenario_f_kill
        fi
        stop_gateway
      else
        record FAIL start "demo --http starts" "$WHY"
      fi
      if wants b && [ "${E2E_STDIO:-1}" != 0 ]; then
        run_scenario b2 "happy path over stdio, as claude mcp add runs it: offers, cart, log, verify" scenario_b_stdio
      fi
    fi
    ;;
  docker | image)
    [ "$IMAGE_READY" = 1 ] || { say "no image, so no scenario runs"; ONLY=""; }
    VOL_A="$(docker_name first)"
    VOLUMES+=("$VOL_A")
    wants a && run_scenario a "first run in the image: --help, doctor --demo, verify --demo on an empty chain" scenario_a
    if wants g; then
      run_scenario g1a "image without INTENT_DEMO: reaches staging, connect line, serves, doctor ok" scenario_g_staging
      run_scenario g1b "image without INTENT_DEMO, no network: clean exit, demo re-run line, no token" scenario_g_offline
      run_scenario g1c "image without INTENT_DEMO, unpinned INTENT_CLOUD_URL: clean exit, demo re-run line, no token" scenario_g_unpinned
      run_scenario g2 "image with INTENT_DEMO=1: connect line, happy path, no-code 403, restart verifies" scenario_g_demo
    fi
    ;;
esac

TOTAL=$((SECONDS - START_SECONDS))
{
  echo
  echo "e2e outsider ($MODE${VERSION:+ $VERSION}${IMAGE_REF:+ $IMAGE_REF}): ${#RESULTS[@]} scenarios, $FAILS failed, ${TOTAL}s"
  for r in "${RESULTS[@]}"; do echo "  $r"; done
  echo "logs: $OUT"
} | tee -a "$SUMMARY"
[ "$FAILS" = 0 ]
