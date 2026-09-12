# @bastani/feedback — Conversational feedback drafting and pure raw-TypeScript utilities for Atomic

This bundled extension provides a safe, ordinary-conversation workflow for drafting feedback:

- `/feedback <what happened or what you want to change>` starts the bundled feedback skill.
- The `feedback` skill classifies bug reports and enhancement requests, asks concise clarifying questions, and keeps revisions in the normal transcript.
- The `feedback_prepare_issue` tool validates the current issue form, formats the draft, and scrubs private data without posting anything.

Bug drafts require a title, what happened, and reproduction steps. Enhancement drafts require a title, the requested change, and why it helps. Missing required fields produce a tool error so you can correct the draft; prepared details are returned only for valid drafts.

Posting is handled separately by the approval-gated feedback submission boundary.

## Privacy scrubbing

Use `scrubFeedback` before submitting a draft. It redacts provider tokens, URL userinfo, private-key blocks, credential assignments, and home-directory paths while preserving ordinary prose, complete template placeholders, and path-like values. Credential assignments are recognized when the name ends in `key`, `token`, `password`, or `secret` (optionally with an `api` or `access` prefix), and the value is on the same line; other credential forms require user review. Compact assignments are redacted when their values follow the separator immediately. Weak decorated labels in inline prose are conservatively left unchanged, while line-leading weak labels and compound or `api`/`access`-prefixed names are redacted when their syntax matches. Spaced bare labels with the weak suffix names use a conservative credential-shaped-value check, except that compound names and `api`/`access`-prefixed names are treated as credentials whenever their assignment syntax matches. Quoted assignments are redacted as credentials whenever their syntax matches, including prose-like quoted values, so review those forms when they are not secrets. Quoted assignments may span contiguous nonblank lines and are bounded at the first blank line or Markdown report heading; a value that crosses such a report boundary is outside the automatic scrub guarantee and requires user review. Suffixes attached to complete placeholders are scrubbed without changing the placeholder. The returned `replacements` summary reports the categories and number of redactions applied.

Heading boundaries include `#` through `######` headings and title lines underlined with `=` or `-`. The heading and following report text are retained; remove any secret continuation there manually.

Balanced `(...)`, `{...}`, `[...]`, and `<...>` assignment values are treated as single-line credentials, including nested wrappers and whitespace inside them. The whole wrapped value is replaced, not just its opening delimiter. This is syntax-based: `api_key: (see the docs)` is also redacted, so check that useful explanation was not removed. Markdown links such as `api_key: [docs](https://example.invalid)` are preserved as links. The literal example `<your-key-here>` is preserved; other angle-wrapped values are not assumed to be placeholders. Real secrets written in preserved template or link syntax still require manual removal.

Outside balanced wrappers, `<` after an unquoted value has started is treated as a markup boundary: `API_KEY=abc<br>more` keeps `<br>more`. Manually remove any secret material written after that boundary.

Adjacent credential assignments are scrubbed independently, including when an unquoted value overlaps the recognized `api` or `access` prefix of the next name. Spaces and tabs inside those name prefixes are supported.

Unquoted wrappers never span lines. An unmatched opener is scrubbed only through the current unquoted token; later lines require review. Private-key blocks with an END marker before any hard boundary are scrubbed through that marker, even when the BEGIN line has trailing text. Without such an END marker, a BEGIN marker with trailing same-line text is scrubbed only to that line's end. Marker-only BEGIN lines consume contiguous key text through an END marker or the first blank line or Markdown report heading, whichever comes first. Unterminated blocks can consume contiguous report text, and key material after a hard boundary is deliberately left for user review. Scrubbing is not a guarantee that a draft is safe to publish.
