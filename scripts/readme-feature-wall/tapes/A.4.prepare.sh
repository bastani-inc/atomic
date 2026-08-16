#!/usr/bin/env bash
# Seed both prompt templates from crash-course Extra A.4.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/prompts"
cat >"$ws/.atomic/prompts/review.md" <<'MD'
---
description: Review staged git changes
---
Review the staged changes (`git diff --cached`). Focus on bugs, security issues, and error handling gaps.
MD
cat >"$ws/.atomic/prompts/component.md" <<'MD'
---
description: Create a component
argument-hint: "<name> [features]"
---
Create a React component named $1 with features: ${@:2}
MD
