#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: wait-for-text.sh -t target -p pattern [options]

Poll a tmux pane for text and exit when found before the deadline. A zero
second timeout does not inspect the pane. The deadline relies on the system's
sleep: if the OS cannot start or run sleep on time, the helper may return late.

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

# Bound each timer sleep to a day, not the overall wait. Large decimal budgets
# must not overflow shell arithmetic or the platform's sleep primitive.
remaining_cs() {
  local now
  now=$(monotonic_cs) || return 1
  awk -v elapsed="$((10#$now - 10#$start))" -v timeout="$timeout" '
    BEGIN { left = timeout * 100 - elapsed; if (left <= 0) exit 1; printf "%.0f\n", (left > 8640000 ? 8640000 : left) }'
}
before_deadline() { remaining_cs >/dev/null; }

# The worker and everything it starts stay in the caller's process group, so a
# kill of that group stops them all, and the wait writes nothing to disk. Each
# child runs in the background, so a stop request interrupts the wait for it.
stopping=0
child=""
stop_child() {
  stopping=1
  if [[ -n "$child" ]]; then kill -KILL "$child" 2>/dev/null || :; fi
}
# Wait for $child. Once the worker is asked to stop, end it and return 143.
wait_child() {
  local rc=0
  if (( stopping )); then kill -KILL "$child" 2>/dev/null || :; fi
  wait "$child" 2>/dev/null || rc=$?
  if (( stopping )); then
    wait "$child" 2>/dev/null || :
    rc=143
  fi
  child=""
  return "$rc"
}

# Only the reader writes into the command substitution. Stopping it closes
# the result even if a descendant of tmux still holds the capture pipe open.
# Report both PIDs on fd 5; pipefail preserves tmux's status on normal reads.
capture() {
  local rc=0
  {
    tmux capture-pane -p -J -t "$target" -S "-${lines}" 2>/dev/null 5>&- &
    printf 'capture %s\n' "$!" >&5 2>/dev/null
    wait "$!" 2>/dev/null || rc=$?
    printf 'captured\n' >&5 2>/dev/null
    exit "$rc"
  } | cat 5>&- &
  printf 'reader %s\n' "$!" >&5 2>/dev/null
  wait "$!" 2>/dev/null || rc=$?
  printf 'read\n' >&5 2>/dev/null
  return "$rc"
}

captured=0
last_pane=""
poll() {
  local pane_text rc=0
  LC_NUMERIC=C sleep 0.0 >/dev/null 2>&1 &
  child=$!
  wait_child || { status=timer-error; return 0; }
  # Check the pattern inside the timed worker: even the first grep can stall.
  # Check quietly, so nothing a stalled check started keeps the caller's error
  # output open, and repeat a failed check to report its error.
  grep "$grep_flag" -- "$pattern" </dev/null >/dev/null 2>&1 &
  child=$!
  wait_child || rc=$?
  if (( rc > 1 )); then
    grep "$grep_flag" -- "$pattern" </dev/null >/dev/null &
    child=$!
    wait_child || :
    return "$rc"
  fi
  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux not found in PATH" >&2
    return 1
  fi
  while before_deadline && (( ! stopping )); do
    # Stop polling once the helper is gone, even if only its own PID was killed.
    if ! kill -0 "$$" 2>/dev/null; then
      stopping=1
      return 143
    fi
    if { pane_text=$(capture); } 5>&1; then
      captured=1
      last_pane=$pane_text
      if before_deadline; then
        printf '%s\n' "$pane_text" 2>/dev/null | grep "$grep_flag" -- "$pattern" >/dev/null 2>&1 &
        child=$!
        if wait_child && before_deadline; then return 0; fi
      fi
    fi
    (( ! stopping )) || return 143
    sleep "$interval" >/dev/null &
    child=$!
    wait_child || return "$?"
  done
  status=timeout
}

watch_deadline() {
  local remaining duration rc
  trap stop_child TERM
  echo 'timer ready' 2>/dev/null
  while remaining=$(remaining_cs); do
    printf -v duration '%d.%02d' "$((remaining / 100))" "$((remaining % 100))"
    LC_NUMERIC=C sleep "$duration" >/dev/null 2>&1 &
    child=$!
    rc=0
    wait_child || rc=$?
    (( ! stopping )) || return 0
    if (( rc != 0 )); then
      echo 'status timer-error' 2>/dev/null
      return 0
    fi
  done
  (( stopping )) || echo 'status timeout' 2>/dev/null
}

# The worker's output: the PIDs of its timer and of each capture, the first
# status from the poll or its timer, then the last complete capture once the
# timer has stopped. The worker and its timer say when they can take a stop
# request: a signal sent while a shell is still starting can be lost.
watch_pane() {
  # poll sets a named timer result or returns a command's own exit status.
  local status=0 timer
  trap stop_child TERM
  # A write after the helper has gone must not end the worker before its timer.
  trap '' PIPE
  echo ready 2>/dev/null
  watch_deadline &
  timer=$!
  printf 'timer %s\n' "$timer" 2>/dev/null
  poll || status=$?
  (( stopping )) || printf 'status %s\n' "$status" 2>/dev/null
  kill -TERM "$timer" 2>/dev/null || :
  wait "$timer" 2>/dev/null || wait "$timer" 2>/dev/null || :
  if (( captured )); then printf 'pane\n%s\n' "$last_pane" 2>/dev/null; fi
}

worker=""
stopping_worker=0
timer_pid=""
capture_pid=""
reader_pid=""
status=""
have_pane=0
pane=""
# Act on a line of the worker's output. Returns 1 after its last complete capture.
take() {
  case $1 in
    ready) if (( stopping_worker )); then kill -TERM "$worker" 2>/dev/null || :; fi ;;
    'timer ready'|'timer '*)
      if [[ $1 != 'timer ready' ]]; then timer_pid=${1#timer }; fi
      if (( stopping_worker )) && [[ -n "$timer_pid" ]]; then kill -TERM "$timer_pid" 2>/dev/null || :; fi ;;
    'capture '*)
      capture_pid=${1#capture }
      if (( stopping_worker )); then kill -KILL "$capture_pid" 2>/dev/null || :; fi ;;
    captured) capture_pid="" ;;
    'reader '*)
      reader_pid=${1#reader }
      if (( stopping_worker )); then kill -KILL "$reader_pid" 2>/dev/null || :; fi ;;
    read) reader_pid="" ;;
    'status '*) if [[ -z "$status" ]]; then status=${1#status }; fi ;;
    pane) have_pane=1; pane=$(cat <&3) || :; return 1 ;;
  esac
}
# How long, in whole seconds, one wait for the worker's next line lasts before
# the helper checks for a stop request. A signal normally interrupts the wait at
# once, but bash 5.2 and older miss one that arrives just as `read` starts to
# wait: its trap then runs only after the next line, which a stalled capture can
# hold back until the deadline.
read_slice=1
# What a wait that timed out had read of a line, kept for the next wait.
partial=""
# Read the worker's next line into `line`. Returns 1 at the end of its output,
# and, with `until-cancelled`, 2 once a stop request has been noted.
next_line() {
  local part rc
  while :; do
    rc=0
    IFS= read -r -t "$read_slice" part <&3 || rc=$?
    if (( rc == 0 )); then
      line=$partial$part
      partial=""
      return 0
    fi
    # A timed-out read returns more than 128; anything else is the end.
    if (( rc <= 128 )); then
      partial=""
      return 1
    fi
    partial+=$part
    if [[ ${1-} == until-cancelled && -n "$cancelled" ]]; then return 2; fi
  done
}
# Ask the worker and its timer to stop, and kill a capture still running.
signal_worker() {
  stopping_worker=1
  kill -TERM "$worker" 2>/dev/null || :
  if [[ -n "$timer_pid" ]]; then kill -TERM "$timer_pid" 2>/dev/null || :; fi
  if [[ -n "$capture_pid" ]]; then kill -KILL "$capture_pid" 2>/dev/null || :; fi
  if [[ -n "$reader_pid" ]]; then kill -KILL "$reader_pid" 2>/dev/null || :; fi
}
# Stop the worker and keep its last complete capture. Only the worker and its
# own protocol writers need to finish, not a descendant holding the capture pipe.
stop_worker() {
  local line
  if [[ -n "$worker" ]]; then
    signal_worker
    while next_line && take "$line"; do :; done
    exec 3<&-
    worker=""
  fi
}
trap stop_worker EXIT
# Only note the signal here and ask the worker to stop. Reading the worker's
# output in this handler could take a line the main loop has begun to read.
cancelled=""
on_signal() {
  if [[ -z "$cancelled" ]]; then cancelled=$1; fi
  if [[ -n "$worker" ]]; then signal_worker; fi
}
trap 'on_signal HUP' HUP
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
if [[ -z "$cancelled" ]]; then
  exec 3< <(watch_pane)
  worker=$!
  # The first status wins. A signal ends this loop at the worker's next line, or
  # within a read slice when that line does not come.
  while [[ -z "$status$cancelled" ]] && next_line until-cancelled && take "$line"; do :; done
fi
stop_worker
if [[ -n "$cancelled" ]]; then
  # End by the same signal, so a calling script stops too.
  trap - EXIT "$cancelled"
  kill -"$cancelled" "$$"
  exit "$((128 + $(kill -l "$cancelled")))"
fi
if [[ "$status" == timer-error ]]; then
  echo 'The wait timer requires a sleep command that accepts fractional seconds.' >&2
  exit 1
fi
if [[ "$status" != timeout ]]; then exit "${status:-1}"; fi

echo "Timed out after ${timeout}s waiting for pattern: $pattern" >&2
echo "Last ${lines} lines from $target:" >&2
if (( have_pane )); then printf '%s\n' "$pane" >&2; fi
exit 1
