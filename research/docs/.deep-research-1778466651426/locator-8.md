# Partition 8 Locator: .devcontainer/

## Implementation

- `.devcontainer/devcontainer.json` — Root devcontainer manifest; references three agent-specific features (claude, copilot, opencode) and defines common environment setup for Atomic CLI development
- `.devcontainer/claude/devcontainer.json` — Per-agent devcontainer for Claude Code workflow; references GHCR feature `ghcr.io/flora131/atomic/claude:1`
- `.devcontainer/copilot/devcontainer.json` — Per-agent devcontainer for Copilot CLI workflow; references GHCR feature `ghcr.io/flora131/atomic/copilot:1`
- `.devcontainer/opencode/devcontainer.json` — Per-agent devcontainer for OpenCode workflow; references GHCR feature `ghcr.io/flora131/atomic/opencode:1`

## Configuration

- `.devcontainer/features/claude/devcontainer-feature.json` — GHCR feature manifest for Claude Code agent; declares version 1.0.15, specifies tmux, bun, and Claude Code SDK as dependencies
- `.devcontainer/features/copilot/devcontainer-feature.json` — GHCR feature manifest for Copilot CLI agent; declares version 1.0.15, specifies tmux, bun, and Copilot CLI as dependencies
- `.devcontainer/features/opencode/devcontainer-feature.json` — GHCR feature manifest for OpenCode agent; declares version 1.0.15, specifies tmux, bun, and OpenCode SDK as dependencies

## Examples / Fixtures

- `.devcontainer/features/claude/install.sh` — Install script for Claude Code agent feature; downloads @bastani/atomic package via bun, configures PATH across shell types (bash, zsh, fish), installs playwright and liteparse global tools, ensures UTF-8 locale for agent CLI rendering
- `.devcontainer/features/copilot/install.sh` — Install script for Copilot CLI agent feature; identical copy of claude/install.sh (per note in header: duplicated across three agents to keep in sync)
- `.devcontainer/features/opencode/install.sh` — Install script for OpenCode agent feature; identical copy of claude/install.sh (per note in header: duplicated across three agents to keep in sync)

## Notable Clusters

- `.devcontainer/features/` — 6 files (3 manifests, 3 shell scripts); per-agent GHCR feature definitions for tmux-based CLI integration; all three agents share identical install logic (common @bastani/atomic, playwright, liteparse toolchain)

The .devcontainer partition contains four agent-specific manifests (root + three per-agent variants) and three per-agent GHCR feature definitions. The feature manifests declare explicit dependencies on tmux-apt-get and agent SDKs (Claude Code, Copilot CLI, OpenCode), while install scripts are tripled (identical copies) and currently reference @bastani/atomic package from npm. This is the direct removal surface for the pi-coding-agent migration: tmux dependencies are hardcoded in feature manifests, agent SDK/CLI references are baked into devcontainer.json features arrays, and install scripts are synchronized triplets that would need consolidation onto a single pi-based flow.
