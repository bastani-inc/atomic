#!/usr/bin/env bash
# Seed the exact project-local prompt template from crash-course lesson 5.6.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/prompts"
cat >"$ws/.atomic/prompts/handoff.md" <<'MD'
---
description: Hand this session's context to another Atomic session over intercom
argument-hint: "<session-name> <what the next session should do>"
---
Hand off to the intercom session named "$1". The next session's job: ${@:2}

Build the brief for THAT job only, then deliver it with one intercom `send`.

Message body, in this order:
1. One sentence naming what the next session is taking over.
2. A `<keepContext>` block, under ten lines, holding only what it must not lose:
   constraints, acceptance criteria, branch, worktree path, file paths, issue or run ids.
3. In flight: what is half-done right now and the next concrete action.
4. Open questions, each tagged `verified` or `assumed`.

Rules:
- Reference settled work by path, URL, or commit sha. Never paste a spec, diff, or file body into the prose.
- Anything this session did not itself run or read is `assumed`. Never promote a belief to a fact.
- Redact secrets, tokens, and keys. If one is load-bearing, name the env var instead.
- Put supporting excerpts in `attachments`, not in the prose: `type: "snippet"` with a `language` for code, `type: "context"` for notes. Name each one for what it is.
- End with: "Reply over intercom if anything above is assumed rather than verified — this session is still open."

Then print the brief you sent so I can read it.
MD
