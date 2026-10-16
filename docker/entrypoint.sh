#!/bin/sh
# The Docker image's entrypoint (ADR-0005). It only prepares the HTTP token, then runs the same `intent` CLI the
# npm package ships; it adds no gateway code.
#
# Off loopback the gateway refuses to serve without a bearer token. When INTENT_HTTP_TOKEN is not set, the token
# lives in <data>/http-token (0600): made on the first start, when it is printed once with the line to paste into
# Claude Code (so it is kept in the container log too), and reused on later starts, which print only how to read
# it. INTENT_QUIET_TOKEN=1 never prints it.
set -eu

data="${INTENT_DATA_DIR:-/data}"
token_file="$data/http-token"

say() { printf 'intent-gateway: %s\n' "$*" >&2; }

# `docker exec` takes the container's short id, which Docker sets as HOSTNAME (12 hex digits). Any other HOSTNAME
# (--hostname, --network host) is not an id, so the commands then say <container>. Mirrors dockerExec() in src/config.
h='[0-9a-f]'
case "${HOSTNAME:-}" in
  $h$h$h$h$h$h$h$h$h$h$h$h) exec_cmd="docker exec $HOSTNAME" ;;
  *) exec_cmd="docker exec <container>" ;;
esac

# Flags alone (`docker run <image> --trust-keys /keys.json`) mean the default command with those flags.
case "${1:-}" in
  -h | --help | --version) ;;
  -*) set -- serve --http "$@" ;;
esac

# Only the server needs the token; `docker exec <c> intent log` and the like run the CLI directly.
case "${1:-serve}" in
  serve | demo) ;;
  *) exec node /app/dist/main.js "$@" ;;
esac

# Inside the container the server listens on every interface; the documented `-p 127.0.0.1:8787:8787` keeps it
# on the host's loopback. Set only here, so other commands (`docker exec`) do not need the token.
export INTENT_HTTP_HOST="${INTENT_HTTP_HOST:-0.0.0.0}"

case "${INTENT_QUIET_TOKEN:-}" in
  "" | 1) ;;
  *) say "INTENT_QUIET_TOKEN must be 1 or unset, got \"$INTENT_QUIET_TOKEN\""; exit 1 ;;
esac

if [ "${INTENT_DEMO:-}" = 1 ]; then
  say "demo: the approval links open the confirm page on port 8788; publish it with -p 127.0.0.1:8788:8788"
  say "demo: re-check what was sent with: $exec_cmd intent verify --demo"
fi

if [ -z "${INTENT_HTTP_TOKEN:-}" ]; then
  # The store refuses a data dir owned by another user, so say the fix here, before anything is written.
  if [ ! -d "$data" ] || [ "$(stat -c %u "$data")" != "$(id -u)" ] || [ ! -w "$data" ]; then
    say "the data dir $data is not a writable folder owned by uid $(id -u)."
    say "For a bind mount, run as its owner: docker run --user \"\$(id -u):\$(id -g)\" -v \"\$PWD/data:/data\" ..."
    exit 1
  fi
  if [ -L "$token_file" ] || { [ -e "$token_file" ] && [ ! -f "$token_file" ]; }; then
    say "$token_file is not a regular file; remove it to make a new token"
    exit 1
  fi
  if [ -f "$token_file" ]; then
    INTENT_HTTP_TOKEN="$(cat "$token_file")"
    say "using the HTTP token in $token_file; read it with: $exec_cmd cat $token_file"
  else
    # 32 random bytes as unpadded base64url: 43 characters.
    INTENT_HTTP_TOKEN="$(head -c 32 /dev/urandom | base64 -w 0 | tr '+/' '-_' | tr -d '=')"
    tmp="$token_file.$$"
    (umask 077 && printf '%s\n' "$INTENT_HTTP_TOKEN" >"$tmp")
    mv "$tmp" "$token_file"
    if [ "${INTENT_QUIET_TOKEN:-}" = 1 ]; then
      say "made an HTTP token and saved it in $token_file (not printed: INTENT_QUIET_TOKEN=1); read it with: $exec_cmd cat $token_file"
    else
      say "made an HTTP token and saved it in $token_file. Later starts reuse it and do not print it again."
      say "The connect line below holds the token, so it is also kept in this container's log (docker logs); set INTENT_QUIET_TOKEN=1 to never print it."
      made_token=1
    fi
  fi
  export INTENT_HTTP_TOKEN
fi

# The one connect line (the gateway prints none in the container, so a pasted line never carries a placeholder).
# Only the start that made the token prints it; otherwise the line reads it from the container when pasted.
connect() { printf '  claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer %s"\n' "$1" >&2; }
if [ -n "${made_token:-}" ]; then
  say "Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787):"
  connect "$INTENT_HTTP_TOKEN"
elif [ -f "$token_file" ] && [ "$(cat "$token_file")" = "$INTENT_HTTP_TOKEN" ]; then
  say "Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787; the line reads the token from the container):"
  connect "\$($exec_cmd cat $token_file)"
else
  say "Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787; the line reads your INTENT_HTTP_TOKEN from the container):"
  connect "\$($exec_cmd printenv INTENT_HTTP_TOKEN)"
fi

exec node /app/dist/main.js "$@"
