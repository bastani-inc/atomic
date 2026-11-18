#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: wait-for-text.sh -t target -p pattern [options]

Poll a tmux pane for text and exit when found before the deadline. A zero
second timeout does not inspect the pane.

The search includes echoed input and scrollback. For command completion, use a
unique marker whose full text does not appear in the command sent to tmux.

Options:
  -t, --target    tmux target (session:window.pane), required
  -p, --pattern   regex pattern to look for, required
  -F, --fixed     treat pattern as a fixed string (grep -F)
  -T, --timeout   seconds to wait (integer, default: 15)
  -i, --interval  poll interval in seconds (default: 0.5)
  -l, --lines     number of history lines to inspect (integer, default: 1000)
  -h, --help      show this help
USAGE
}

target=""
pattern=""
grep_flag="-E"
timeout=15
interval=0.5
lines=1000

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target)   target="${2-}"; shift 2 ;;
    -p|--pattern)  pattern="${2-}"; shift 2 ;;
    -F|--fixed)    grep_flag="-F"; shift ;;
    -T|--timeout)  timeout="${2-}"; shift 2 ;;
    -i|--interval) interval="${2-}"; shift 2 ;;
    -l|--lines)    lines="${2-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$target" || -z "$pattern" ]]; then
  echo "target and pattern are required" >&2
  usage
  exit 1
fi

if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
  echo "timeout must be an integer number of seconds" >&2
  exit 1
fi

if ! [[ "$lines" =~ ^[0-9]+$ ]]; then
  echo "lines must be an integer" >&2
  exit 1
fi

# grep returns 1 for a valid pattern with no input; syntax errors must not poll.
grep "$grep_flag" -- "$pattern" </dev/null >/dev/null || {
  status=$?
  if (( status != 1 )); then
    exit "$status"
  fi
}

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

# /proc/uptime gives hundredths of a second. Use the system monotonic clock on
# hosts without it; wall time can jump backwards while a capture is pending.
monotonic_cs() {
  if [[ -r /proc/uptime ]]; then
    local seconds fraction rest
    IFS='. ' read -r seconds fraction rest </proc/uptime
    printf '%s%s\n' "$seconds" "${fraction:0:2}"
  else
    perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'printf "%.0f\n", int(100 * clock_gettime(CLOCK_MONOTONIC))'
  fi
}

if ! start=$(monotonic_cs); then
  echo 'A monotonic clock is required: enable /proc/uptime or install Perl with Time::HiRes.' >&2
  exit 1
fi
deadline=$((10#$start + 100 * 10#$timeout))
before_deadline() {
  local now
  now=$(monotonic_cs) && (( 10#$now < deadline ))
}

scratch=$(mktemp -d)
worker=""
stop_worker() {
  if [[ -n "$worker" ]]; then
    kill -KILL -- "-$worker" 2>/dev/null || :
    worker=""
  fi
}
trap 'stop_worker; rm -rf -- "$scratch"' EXIT
trap 'exit 1' HUP INT TERM
: >"$scratch/pane"

poll() {
  local pane_text
  while before_deadline; do
    if pane_text=$(tmux capture-pane -p -J -t "$target" -S "-${lines}" 2>/dev/null); then
      printf '%s\n' "$pane_text" >"$scratch/pane"
      if before_deadline && grep "$grep_flag" -- "$pattern" "$scratch/pane" >/dev/null 2>&1 && before_deadline; then
        return 0
      fi
    fi
    sleep "$interval" || return "$?"
  done
  return 124
}

# Keep the entire poll (including stuck captures and long sleeps) in its own
# process group. Only the parent waits on the deadline; it never waits on tmux.
exec 3< <(
  set -m
  (set +m; poll) &
  pid=$!
  echo "$pid"
  status=0
  wait "$pid" 2>/dev/null || status=$?
  echo "$status"
)
IFS= read -r worker <&3
now=$(monotonic_cs)
remaining=$((deadline - 10#$now))
printf -v wait_time '%d.%02d' "$((remaining / 100))" "$((remaining % 100))"
if (( remaining > 0 )) && IFS= read -r -t "$wait_time" status <&3 && [[ "$status" != 124 ]]; then
  worker=""
  exit "$status"
fi

stop_worker
echo "Timed out after ${timeout}s waiting for pattern: $pattern" >&2
echo "Last ${lines} lines from $target:" >&2
cat "$scratch/pane" >&2
exit 1
