#!/usr/bin/env bash
# P processes, each one client looping interactive write transactions, against one sqld (#4768): the multi-process
# shape of a shared pool (one connection per coordinator) without any Atomic code.
#   PROCS=40 STATEMENTS=12 SECONDS_=30 bash sqld-contention-multiprocess.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
SQLD=${SQLD:-$HOME/.cache/atomic-distributed-test/sqld/v0.24.33/sqld}
dir=$(mktemp -d); port=$((40000 + RANDOM % 10000))
"$SQLD" --db-path "$dir/db" --http-listen-addr 127.0.0.1:$port --grpc-listen-addr 127.0.0.1:$((port+1)) >/dev/null 2>&1 & server=$!
sleep 1.5
for i in $(seq 1 "${PROCS:-40}"); do
	node "$here/sqld-contention-repro.mjs" --url "http://127.0.0.1:$port" --clients 1 --modes "${MODE:-interactive}" --statements "${STATEMENTS:-12}" --seconds "${SECONDS_:-30}" > "$dir/out-$i.json" 2>/dev/null &
done
wait $(jobs -p | grep -v "^$server$") 2>/dev/null
kill -9 $server 2>/dev/null
cat "$dir"/out-*.json | node -e '
const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const total = lines.reduce((s, l) => s + l.commitsPerSec, 0);
const probes = lines.map((l) => l.writeProbe);
const errors = {}; for (const l of lines) for (const [k, v] of Object.entries(l.errors)) errors[k] = (errors[k] ?? 0) + v;
console.log(JSON.stringify({ procs: lines.length, mode: lines[0]?.mode, commitsPerSec: Math.round(total * 10) / 10, p99MaxMs: Math.max(...lines.map((l) => l.latencyMs.p99 ?? 0)), errors, writeProbes: [...new Set(probes)] }));'
rm -rf "$dir"
