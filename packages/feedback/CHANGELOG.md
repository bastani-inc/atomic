# Changelog
All notable changes to this project will be documented in this file.
## [Unreleased]

### Added

- Added typed feedback draft validation, deterministic issue formatting, privacy scrubbing, and bounded diagnostic utilities.

### Fixed

- Fixed privacy scrubbing for spaced credential labels, Markdown-decorated labels, and unquoted values while preserving structural delimiters, matching Markdown wrappers, and punctuation within values.
- Fixed complete redaction of credential values containing slashes while preserving path-like empty assignments, and prevented emphasized prose from being falsely redacted.
- Bounded credential and URL candidate scans to keep long diagnostic text responsive.
