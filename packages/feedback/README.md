# @bastani/feedback — Pure raw-TypeScript utilities for validating, formatting, and privacy-scrubbing Atomic feedback drafts.

## Privacy scrubbing

Use `scrubFeedback` before submitting a draft. It redacts provider tokens, URL userinfo, private-key blocks, credential assignments, and home-directory paths while preserving ordinary prose, template placeholders, and path-like values. The returned `replacements` summary reports the categories and number of redactions applied.
