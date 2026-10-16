#!/bin/sh
# The Docker image's entrypoint (ADR-0005). It only prepares the HTTP token, then runs the same `intent` CLI the
# npm package ships; it adds no gateway code.
#
# Off loopback the gateway refuses to serve without a bearer token. When INTENT_HTTP_TOKEN is not set, the token
# lives in <data>/http-token (0600): made on the first start, when it is printed once with the line to paste into
# Claude Code, and reused on later starts without printing it again.
set -eu

data="${INTENT_DATA_DIR:-/data}"
token_file="$data/http-token"

say() { printf 'intent-gateway: %s\n' "$*" >&2; }

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

if [ "${INTENT_DEMO:-}" = 1 ]; then
  say "demo: the approval links open the confirm page on port 8788; publish it with -p 127.0.0.1:8788:8788"
  say "demo: re-check what was sent with: docker exec <container> intent verify --demo"
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
    say "using the HTTP token in $token_file; read it with: docker exec <container> cat $token_file"
  else
    # 32 random bytes as unpadded base64url: 43 characters.
    INTENT_HTTP_TOKEN="$(head -c 32 /dev/urandom | base64 -w 0 | tr '+/' '-_' | tr -d '=')"
    tmp="$token_file.$$"
    (umask 077 && printf '%s\n' "$INTENT_HTTP_TOKEN" >"$tmp")
    mv "$tmp" "$token_file"
    say "made an HTTP token and saved it in $token_file. It is shown this once; later starts reuse it."
    say "Connect Claude Code (with the port mapped as -p 127.0.0.1:8787:8787):"
    printf '  claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer %s"\n' "$INTENT_HTTP_TOKEN" >&2
  fi
  export INTENT_HTTP_TOKEN
fi

exec node /app/dist/main.js "$@"
