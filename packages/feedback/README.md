# @bastani/feedback — Pure raw-TypeScript utilities for validating, formatting, and privacy-scrubbing Atomic feedback drafts.

## Privacy scrubbing

Use `scrubFeedback` before submitting a draft. It redacts provider tokens, URL userinfo, private-key blocks, credential assignments, and home-directory paths while preserving ordinary prose, complete template placeholders, and path-like values. Bare labels with a separator use a conservative credential-shaped-value check to avoid rewriting natural-language sentences; use compact assignments for values that cannot be classified from context. Unterminated quoted assignments are bounded to their line or to a structural report boundary (a blank line or `### ` heading), while valid multiline quoted values close before that boundary; suffixes attached to complete placeholders are scrubbed without changing the placeholder. The returned `replacements` summary reports the categories and number of redactions applied.
