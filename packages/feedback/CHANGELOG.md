# Changelog
All notable changes to this project will be documented in this file.
## [Unreleased]

### Added

- Added typed feedback draft validation, deterministic issue formatting, privacy scrubbing, and bounded diagnostic utilities ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).

### Fixed

- Fixed privacy scrubbing for spaced credential labels, Markdown-decorated labels, and unquoted values while preserving structural delimiters, matching Markdown wrappers, and punctuation within values ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed complete redaction of credential values containing slashes while preserving path-like empty assignments, and prevented emphasized prose from being falsely redacted ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Bounded credential and URL candidate scans to keep long diagnostic text responsive ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed privacy scrubbing for comment-prefixed labels, template placeholders, multiline quoted values, and credential values beginning with a slash; bounded marker-only candidate scans to keep long feedback responsive ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed unterminated quoted assignments removing subsequent feedback sections, and scrubbed credential suffixes attached to preserved template placeholders ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed quoted credential scanning across contiguous nonblank lines while treating blank lines and report headings as hard boundaries; values crossing those boundaries require user review, and placeholder suffix scrubbing is idempotent ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed decorated credential labels in ordinary prose being mistaken for assignments, and kept suffix scrubbing attached to template placeholders idempotent ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
- Fixed Markdown wrapper preservation for decorated assignments across `:` and `=` delimiters and whole-assignment code spans, and preserved inline decorated prose while documenting syntax-based redaction behavior ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).
