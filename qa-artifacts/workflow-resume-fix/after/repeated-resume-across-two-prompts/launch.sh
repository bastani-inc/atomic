#!/bin/sh
export HOME="/tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/home" ATOMIC_CODING_AGENT_DIR="/tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/agent" ATOMIC_CODING_AGENT_SESSION_DIR="/tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/sessions" ATOMIC_OFFLINE=1 ATOMIC_SKIP_VERSION_CHECK=1 ATOMIC_TELEMETRY=0 TERM=xterm-256color
unset DBOS_SYSTEM_DATABASE_URL ATOMIC_WORKFLOW_DURABLE
cd "/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e"
exec bun packages/coding-agent/dist-dev/cli.js --approve --no-context-files --session-dir "/tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/sessions" "$@"
