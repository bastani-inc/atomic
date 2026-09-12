# Changelog
All notable changes to this project will be documented in this file.
## [Unreleased]

### Added

- Added typed feedback draft validation, deterministic issue formatting, privacy scrubbing, and bounded diagnostic utilities ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Added `/feedback` and a bundled conversational skill to collect bug reports or enhancement requests and prepare editable, privacy-scrubbed drafts without posting them ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Added bug investigation through the existing debugger with a fresh, foreground handoff, bounded privacy-scrubbed diagnostics, extension activity, and path-only worktree disclosure. Unavailable investigations leave an editable draft with honest unknowns ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).

### Fixed

- Fixed privacy scrubbing for spaced credential labels, Markdown-decorated labels, and unquoted values while preserving structural delimiters, matching Markdown wrappers, and punctuation within values ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed complete redaction of credential values containing slashes while preserving path-like empty assignments, and prevented emphasized prose from being falsely redacted ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Bounded credential and URL candidate scans to keep long diagnostic text responsive ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed privacy scrubbing for comment-prefixed labels, template placeholders, multiline quoted values, and credential values beginning with a slash; bounded marker-only candidate scans to keep long feedback responsive ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed unterminated quoted assignments removing subsequent feedback sections, and scrubbed credential suffixes attached to preserved template placeholders ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed quoted credential scanning across contiguous nonblank lines while treating blank lines and report headings as hard boundaries; values crossing those boundaries require user review, and placeholder suffix scrubbing is idempotent ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed decorated credential labels in ordinary prose being mistaken for assignments, and kept suffix scrubbing attached to template placeholders idempotent ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed Markdown wrapper preservation for decorated assignments across `:` and `=` delimiters and whole-assignment code spans, and preserved inline decorated prose while documenting syntax-based redaction behavior ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed balanced credential wrappers and Markdown links being corrupted, limited unquoted wrappers to one line, and kept private-key marker mentions from consuming following report lines. Private-key blocks respect blank-line and report-heading boundaries, so separated key material still requires manual review ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed adjacent credential assignments being skipped when their names overlap a preceding value, recognized spaces and tabs in credential-name prefixes consistently, and scrubbed contiguous END-terminated private-key blocks with trailing BEGIN-line text without crossing report boundaries ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed long feedback with repeated private-key BEGIN mentions stalling privacy scrubbing when no END marker is reachable, while retaining contiguous-block redaction and hard report boundaries ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed quoted-credential and private-key scrubbing consuming Markdown report headings. Hash-prefixed headings at every level and underlined headings retain their text and following report content even when a closing quote or END marker appears later ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Bounded pending worktree snapshots and report unavailable comparisons instead of misidentifying pre-existing paths when a baseline is missing or too large ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed bug drafts omitting extension activity when that information is missing; they now say `Not reported` instead of implying no extensions were active ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Limited diagnostic path parsing and Git execution time for large worktrees, and included copy destinations in newly observed paths ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
