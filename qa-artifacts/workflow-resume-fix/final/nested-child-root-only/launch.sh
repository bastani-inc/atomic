#!/bin/sh
export HOME="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/nested-child-root-only/home" ATOMIC_CODING_AGENT_DIR="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/nested-child-root-only/agent" ATOMIC_CODING_AGENT_SESSION_DIR="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/nested-child-root-only/sessions" ATOMIC_OFFLINE=1 ATOMIC_SKIP_VERSION_CHECK=1 ATOMIC_TELEMETRY=0 TERM=xterm-256color
unset DBOS_SYSTEM_DATABASE_URL ATOMIC_WORKFLOW_DURABLE
cd "/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e"
exec bun packages/coding-agent/dist-dev/cli.js --approve --no-context-files --session-dir "/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/nested-child-root-only/sessions" "$@"
