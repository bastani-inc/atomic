#!/usr/bin/env bash
# Shared helpers for the release scripts in this directory. Source it; do not run it.
#
# Every retry is bounded: an operation runs at most its *_ATTEMPTS times, and the
# waits between attempts double from a base delay up to RETRY_MAX_DELAY_SECONDS.

# shellcheck disable=SC2034 # The scripts that source this file read these.
NPM_PUBLISH_ATTEMPTS=4
NPM_RETRY_BASE_SECONDS=10
GH_ATTEMPTS=4
GH_RETRY_BASE_SECONDS=15
RETRY_MAX_DELAY_SECONDS=60

# retry_delay ATTEMPT BASE: seconds to wait after failed attempt ATTEMPT (1-based).
retry_delay() {
  local delay=$(($2 << ($1 - 1)))
  ((delay <= RETRY_MAX_DELAY_SECONDS)) || delay=$RETRY_MAX_DELAY_SECONDS
  echo "$delay"
}

# npm_publish_failure_kind FILE: classify the output of a failed `npm publish`.
#   exists     the registry already has this version (it refuses to publish over it)
#   transient  a provenance transparency-log conflict, a registry 5xx/408/409/429,
#              or a network failure; nothing says the version was rejected
#   fatal      anything else (permissions, a missing trusted publisher, bad input)
npm_publish_failure_kind() {
  if grep -Eqi 'cannot publish over (the )?previously published version|EPUBLISHCONFLICT' "$1"; then
    echo exists
  elif grep -Eq 'npm error code (TLOG_CREATE_ENTRY_ERROR|E5[0-9][0-9]|E408|E409|E429|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|ERR_SOCKET_TIMEOUT|UND_ERR_[A-Z_]+)$' "$1"; then
    echo transient
  else
    echo fatal
  fi
}

# gh_error_is_transient FILE: whether gh's stderr shows a GitHub API failure worth
# retrying: a 5xx, a 429 or secondary rate limit, or a dropped connection.
gh_error_is_transient() {
  grep -Eqi 'HTTP (5[0-9][0-9]|429)|secondary rate limit|abuse detection|connection (reset|refused)|i/o timeout|TLS handshake timeout|timeout awaiting response headers|unexpected EOF|stream error' "$1"
}

# gh_retry ARGS...: run `gh ARGS...`, retrying transient GitHub API failures with
# backoff. Prints the successful attempt's stdout; otherwise exits like gh with
# gh's stderr.
gh_retry() {
  local attempt status err out delay
  err=$(mktemp)
  for ((attempt = 1; ; attempt++)); do
    if out=$(gh "$@" 2>"$err"); then
      rm -f "$err"
      [[ -z "$out" ]] || printf '%s\n' "$out"
      return 0
    else
      status=$?
    fi
    if ((attempt >= GH_ATTEMPTS)) || ! gh_error_is_transient "$err"; then
      cat "$err" >&2
      rm -f "$err"
      return "$status"
    fi
    delay=$(retry_delay "$attempt" "$GH_RETRY_BASE_SECONDS")
    echo "::warning::gh $1 $2 failed transiently (attempt $attempt of $GH_ATTEMPTS): $(tr '\n' ' ' <"$err")- retrying in ${delay}s." >&2
    sleep "$delay"
  done
}

# release_state TAG: print `draft`, `published` or `missing` for the GitHub
# Release of TAG. Transient API failures are retried; an answer that is none of
# the three fails rather than being read as `missing`.
release_state() {
  local err out status
  err=$(mktemp)
  if out=$(gh_retry release view "$1" --json isDraft --jq .isDraft 2>"$err"); then
    status=0
  else
    status=$?
  fi
  cat "$err" >&2
  if ((status != 0)) && grep -qx 'release not found' "$err"; then
    rm -f "$err"
    echo missing
    return 0
  fi
  rm -f "$err"
  ((status == 0)) || return "$status"
  case $out in
  true) echo draft ;;
  false) echo published ;;
  *)
    echo "gh release view $1 reported isDraft=$out" >&2
    return 1
    ;;
  esac
}

# delete_release TAG: delete the GitHub Release of TAG, retrying transient API
# failures. A delete GitHub applied before answering with an error leaves the
# release gone, and that counts as success.
delete_release() {
  local status
  if gh_retry release delete "$1" --yes; then
    return 0
  else
    status=$?
  fi
  [[ "$(release_state "$1")" != missing ]] || return 0
  return "$status"
}
