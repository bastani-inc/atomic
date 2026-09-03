---
name: feedback
description: Draft a privacy-scrubbed Atomic bug report or enhancement through the ordinary conversation.
---

# Conversational feedback

Classify the user's request as a bug or enhancement.

For an enhancement, collect a title, what they want to change, and why. If the kind or one required field is unresolved, ask exactly one concise ordinary-text question, then stop. Let the next normal user message answer it; do not capture input or open a special interface.

When an enhancement is complete, call `feedback_prepare_issue` exactly once. Display the tool's exact prepared title and body as ordinary assistant Markdown, without rewriting them. End with a plain request for edits or approval.

Never launch a debugger for an enhancement. Never post an issue. Posting is not available in this turn.
