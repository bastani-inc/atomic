# Partition 11: Binary Distribution Installer (install.cmd)

## Implementation

- `install.cmd` — Windows batch installer script (169 LOC) that bootstraps Atomic CLI installation on Windows by downloading a verified prebuilt binary from GitHub Releases, verifying SHA256 checksum, and delegating to the binary's `install` subcommand for PATH wiring, shell completions, and mux detection.

## Configuration

- `install.cmd` — Hardcoded GitHub release base URL (`bastani-inc/atomic`), download directory (`%USERPROFILE%\.atomic\downloads`), manifest.json parsing strategy, platform detection (AMD64 vs ARM64), and version validation regex.

## Notable Clusters

- `install.cmd/` — 1 file, Windows-specific binary distribution entry point. Mirrors Claude Code's installer design: fetches manifest.json from GitHub Releases, resolves platform-specific binary URL, downloads and verifies checksum via PowerShell (due to cmd.exe regex limitations), then hands off to the binary's `install` subcommand for environment setup.

## Summary

The `install.cmd` script is a lightweight bootstrap for Windows that decouples pre-flight validation and binary download from the main CLI installation logic. It delegates actual installation (PATH updates, shell completions, tmux detection) to the binary's `install` subcommand. The script validates Windows architecture (rejects 32-bit), uses PowerShell for manifest/version parsing to work around cmd.exe regex limitations, performs SHA256 verification via CertUtil, and cleans up temporary files. This design is specific to the Atomic CLI binary distribution strategy and will require adaptation or replacement in a pi-coding-agent fork.
