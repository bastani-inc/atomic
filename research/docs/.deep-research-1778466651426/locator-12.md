# Partition 12: install.ps1/ — Location Index

## Implementation
- `install.ps1` — Windows PowerShell installer that downloads verified prebuilt binary from GitHub Releases and hands off to `atomic install` subcommand for setup; handles platform detection (x64/ARM64), manifest verification, SHA256 checksum validation, retry logic for transient failures, and binary cleanup.

## Notable Patterns
- **Claude Code modeling**: Script is intentionally modeled on Claude Code's install.ps1 (line 3), with forward compatibility design similar to Claude Code's bootstrap pattern (line 109)
- **Binary-driven setup**: Installation logic is embedded in the shipped binary rather than the bootstrap script (lines 107-110), allowing older install scripts to remain forward-compatible
- **Agent-agnostic**: This is infrastructure for distribution and does not depend on Claude Code SDK, Claude Agent SDK, GitHub Copilot CLI/SDK, OpenCode SDK, or tmux; it is fully agent-independent
- **Platform coverage**: Windows-only (PowerShell 5.1+), handles 32-bit rejection and native ARM64 detection; complements install.sh and install.cmd for other platforms

## Summary
The partition contains a single Windows installer script (128 LOC) that is entirely agent-agnostic infrastructure. It downloads a prebuilt binary, verifies it cryptographically, and delegates setup to the binary itself. This pattern is portable to pi-coding-agent and requires no changes for the planned rewrite.
