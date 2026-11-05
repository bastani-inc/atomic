#!/usr/bin/env bash
# Keeps one fork chaos forker running on this node until it drains (exit 0); a killed forker is restarted, and on
# start it re-drives the attempts the killed one left unfinished.
source /opt/fork-chaos/env
cd /opt/fork-chaos/repo || exit 1
while true; do
	bun run test/distributed/fork-chaos/workload.ts forker >>/opt/fork-chaos/state/forker-stdout.log 2>&1
	code=$?
	echo "$(date -u +%FT%TZ) forker exited $code" >>/opt/fork-chaos/state/supervisor.log
	[ "$code" -eq 0 ] && break
	sleep 1
done
