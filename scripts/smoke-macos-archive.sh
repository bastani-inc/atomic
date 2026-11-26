#!/usr/bin/env bash
#
# Smokes a macOS release archive on a Mac: the binary starts, and `atomic storage status` shows it runs the SQLite
# library the archive ships (scripts/bundled-sqlite.json) rather than the system's, and opens a cleanly closed SQLite
# store read-only, which the system's SQLite refused (#6622).
#
# Usage:
#   ./scripts/smoke-macos-archive.sh <atomic-darwin-*.tar.gz> <arm64|x86_64>
#
# x86_64 runs the Intel binary under Rosetta on Apple silicon.

set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <atomic-darwin-*.tar.gz> <arm64|x86_64>" >&2
    exit 2
fi
archive="$1"
arch="$2"
root="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
version="$(node -p 'require(process.argv[1]).version' "$root/scripts/bundled-sqlite.json")"

smoke="$(mktemp -d "${TMPDIR:-/tmp}/atomic-macos-smoke.XXXXXX")"
trap 'rm -rf "$smoke"' EXIT
tar -xzf "$archive" -C "$smoke"
atomic="$smoke/atomic/atomic"
library="$smoke/atomic/lib/libsqlite3.dylib"
file -b "$library" | grep -q "$arch" || { echo "$library is not a $arch library: $(file -b "$library")" >&2; exit 1; }
/usr/bin/arch "-$arch" "$atomic" --version

# A store written and closed, as `atomic storage import` leaves it: its last close removes the -wal and -shm files.
# Written with Node's SQLite, which removes them as Atomic's does; Apple's sqlite3 keeps the WAL.
agent="$smoke/agent"
mkdir -p "$agent/workflows"
node -e '
const { DatabaseSync } = require("node:sqlite");
const store = new DatabaseSync(process.argv[1]);
store.exec("PRAGMA journal_mode=WAL; CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1);");
store.close();' "$agent/workflows/journal.sqlite"
if [[ -e "$agent/workflows/journal.sqlite-wal" || -e "$agent/workflows/journal.sqlite-shm" ]]; then
    echo "The store's last close left its WAL" >&2
    exit 1
fi

set +e
output="$(cd "$smoke" && ATOMIC_CODING_AGENT_DIR="$agent" ATOMIC_STORAGE= ATOMIC_SESSIONS_STORAGE= /usr/bin/arch "-$arch" "$atomic" storage status 2>&1)"
status=$?
set -e
echo "$output"
[[ "$status" -eq 0 ]] || { echo "atomic storage status exited with $status" >&2; exit 1; }
grep -Fxq "  library:     SQLite $version" <<<"$output" || {
    echo "The binary does not run the SQLite $version it ships" >&2
    exit 1
}
grep -q "^  connection:  ok (" <<<"$output" || { echo "The cleanly closed store did not open" >&2; exit 1; }
if grep -q "could not load its own SQLite library" <<<"$output"; then
    exit 1
fi
