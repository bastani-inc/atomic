# Changelog

All notable changes to the `@bastani/i-have-adhd` extension will be documented in this file.

## [Unreleased]

### Added

- Added the upstream `i-have-adhd` skill and Atomic extension as a bundled first-party package.
- Added `/i-have-adhd [on|off]`, the `--no-adhd` startup flag, the `.i-have-adhd-off` agent-directory flag file, and the `stop adhd mode` / `normal mode` stop phrases.

### Changed

- Enabled ADHD-friendly output by default for new sessions while preserving saved per-session state across restarts, branches, and compaction.
