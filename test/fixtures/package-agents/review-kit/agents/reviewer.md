---
name: reviewer
description: Reviews a change with the kit's pinned models and tools
model: kit-primary/argon:high
fallbackModels: kit-secondary/boron:low, kit-tertiary/carbon:minimal
tools: read, mcp:kitdocs
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
---
REVIEW-KIT ROLE: you are the review kit's reviewer. Look up the kit's docs, then report your verdict.
