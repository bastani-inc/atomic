#!/usr/bin/env bash
# Plant the exact review target from crash-course Extra A.5.
set -euo pipefail
ws="$1"
printf '\n%s\n' 'export function retry<T>(fn: () => Promise<T>): Promise<T> { return fn().catch(() => fn()); }' >>"$ws/src-client.ts"
