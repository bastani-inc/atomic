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

# /proc/uptime gives hundredths of a second. Use the system monotonic clock on
# hosts without it; wall time can jump backwards while a capture is pending.
monotonic_cs() {
  if [[ -r /proc/uptime ]]; then
    local seconds fraction rest
    IFS='. ' read -r seconds fraction rest </proc/uptime || return 1
    fraction=${fraction}00
    printf '%s%s\n' "$seconds" "${fraction:0:2}"
  else
    perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'printf "%.0f\n", int(100 * clock_gettime(CLOCK_MONOTONIC))'
  fi
}

if ! start=$(monotonic_cs); then
  echo 'A monotonic clock is required: enable /proc/uptime or install Perl with Time::HiRes.' >&2
  exit 1
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi
# A child created during group cancellation must also see that the wait ended.
active() { [[ -d "$scratch" && ! -e "$scratch/stopped" ]]; }
# Bound each timer sleep to a day, not the overall wait. Large decimal budgets
# must not overflow shell arithmetic or the platform's sleep primitive.
remaining_cs() {
  local now
  active || return 1
  now=$(monotonic_cs) || return 1
  awk -v elapsed="$((10#$now - 10#$start))" -v timeout="$timeout" '
    BEGIN { left = timeout * 100 - elapsed; if (left <= 0) exit 1; printf "%.0f\n", (left > 8640000 ? 8640000 : left) }'
}
before_deadline() { remaining_cs >/dev/null; }

scratch=$(mktemp -d)
worker=""
stop_worker() {
  if [[ -n "$worker" ]]; then
    : >"$scratch/stopped"
    kill -KILL -- "-$worker" 2>/dev/null || :
    worker=""
  fi
}
trap 'stop_worker; rm -rf -- "$scratch"' EXIT
# Stop an owned group immediately, or remember the signal until its PID is saved.
# A second interrupt must not cut off the first one's cleanup.
cancelled=0
trap 'trap "" HUP INT TERM; cancelled=1; stop_worker' HUP INT TERM
: >"$scratch/pane"

poll() {
  local pane_text rc
  active || return 124
  LC_NUMERIC=C sleep 0.0 2>/dev/null || return 125
  # Check the pattern inside the timed worker: even the first grep can stall.
  grep "$grep_flag" -- "$pattern" </dev/null >/dev/null || {
    rc=$?
    (( rc == 1 )) || return "$rc"
  }
  while before_deadline; do
    if pane_text=$(tmux capture-pane -p -J -t "$target" -S "-${lines}" 2>/dev/null) &&
      printf '%s\n' "$pane_text" >"$scratch/next" && mv -f "$scratch/next" "$scratch/pane"; then
      if before_deadline && grep "$grep_flag" -- "$pattern" "$scratch/pane" >/dev/null 2>&1 && before_deadline; then
        return 0
      fi
    fi
    active || return 124
    sleep "$interval" || return "$?"
  done
  return 124
}

watch_deadline() {
  local remaining duration
  while remaining=$(remaining_cs); do
    printf -v duration '%d.%02d' "$((remaining / 100))" "$((remaining % 100))"
    active || break
    LC_NUMERIC=C sleep "$duration" 2>/dev/null || { echo 125 2>/dev/null; return; }
  done
  echo 124 2>/dev/null
}

# The poll and its timer share a private process group. The first status on the
# pipe wins. Stopping the group cancels the other, even inside tmux or sleep.
set -m
(
  set +m
  IFS= read -r result < <(
    (status=0; poll || status=$?; echo "$status" 2>/dev/null) &
    watch_deadline &
    wait
  )
  exit "$result"
) &
worker=$!
(( ! cancelled )) || exit 1
status=0
wait "$worker" 2>/dev/null || status=$?
stop_worker
(( ! cancelled )) || exit 1
if [[ "$status" == 125 ]]; then
  echo 'The wait timer requires a sleep command that accepts fractional seconds.' >&2
  exit 1
fi
if [[ "$status" != 124 ]]; then exit "$status"; fi

echo "Timed out after ${timeout}s waiting for pattern: $pattern" >&2
echo "Last ${lines} lines from $target:" >&2
cat "$scratch/pane" >&2
exit 1
