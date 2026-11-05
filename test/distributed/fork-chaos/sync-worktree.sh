#!/usr/bin/env bash
# Re-syncs this worktree's current state to every worker of a fork chaos run (#4321), so a new round runs the code
# as it is now. Everything except node_modules is replaced; a changed lockfile is refused, because reinstalling
# node_modules would need Internet egress the NSGs now deny. Records the snapshot identity in $ARTIFACT_DIR.
#
#   RUN_ID=<id> ROUND=<n> test/distributed/fork-chaos/sync-worktree.sh
set -euo pipefail

: "${RUN_ID:?set RUN_ID}"
: "${ROUND:?set ROUND}"
STATE_DIR="${STATE_DIR:-$HOME/.fork-chaos/$RUN_ID}"
OUT_DIR="${ARTIFACT_DIR:-$STATE_DIR}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MANIFEST="$STATE_DIR/manifest.json"
SSH_OPTS=(-i "$STATE_DIR/ssh_key" -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$STATE_DIR/known_hosts"
	-o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR)

cd "$REPO"
{
	git ls-files -co --exclude-standard | while IFS= read -r file; do [ -e "$file" ] && printf '%s\n' "$file"; done
	echo packages/ai/dist
	echo packages/ai/src/providers/data
	ls packages/natives/native/*.node
} >"$STATE_DIR/cache/files-round-$ROUND.txt"
tar -czf "$STATE_DIR/cache/repo-round-$ROUND.tgz" -T "$STATE_DIR/cache/files-round-$ROUND.txt"
lock_hash=$(sha256sum package-lock.json | cut -d' ' -f1)
snapshot_hash=$(git ls-files -co --exclude-standard | while IFS= read -r file; do [ -f "$file" ] && sha256sum "$file"; done | sha256sum | cut -d' ' -f1)
jq -n --arg round "$ROUND" --arg head "$(git rev-parse HEAD)" --arg branch "$(git branch --show-current)" \
	--arg snapshot "$snapshot_hash" --arg lock "$lock_hash" --arg status "$(git status --short | sha256sum | cut -d' ' -f1)" \
	--argjson files "$(wc -l <"$STATE_DIR/cache/files-round-$ROUND.txt")" --arg at "$(date -u +%FT%TZ)" \
	'{round: ($round | tonumber), syncedAt: $at, branch: $branch, head: $head, worktreeContentSha256: $snapshot, packageLockSha256: $lock, gitStatusSha256: $status, files: $files}' \
	>"$OUT_DIR/worktree-snapshot-round-$ROUND.json"

remote_sync='set -euo pipefail
repo=/opt/fork-chaos/repo
old_lock=$(sha256sum $repo/package-lock.json | cut -d" " -f1)
find $repo -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -xzf /tmp/fc-sync.tgz -C $repo
rm -f /tmp/fc-sync.tgz
[ "$old_lock" = "$LOCK" ] || { echo "package-lock.json changed; node_modules would need a reinstall" >&2; exit 1; }
echo "$(hostname) synced"'

pids=()
for name in $(jq -r '.nodes[] | select(.role == "worker") | .name' "$MANIFEST"); do
	ip=$(jq -r --arg n "$name" '.nodes[] | select(.name == $n) | .ip' "$MANIFEST")
	(
		scp -q "${SSH_OPTS[@]}" "$STATE_DIR/cache/repo-round-$ROUND.tgz" "azureuser@$ip:/tmp/fc-sync.tgz"
		ssh "${SSH_OPTS[@]}" "azureuser@$ip" "LOCK=$lock_hash bash -s" <<<"$remote_sync"
	) &
	pids+=($!)
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
exit "$status"
