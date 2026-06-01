(no external research applicable)

## Justification

The `.devcontainer/` partition consists entirely of infrastructure provisioning manifests and shell install scripts. After reading all 10 files (3 `devcontainer.json` manifests, 1 root `devcontainer.json`, 3 `devcontainer-feature.json` descriptors, and 3 `install.sh` scripts), no external library or framework documentation is central to the rewrite question.

### What the partition contains

The three feature install scripts (`features/claude/install.sh`, `features/copilot/install.sh`, `features/opencode/install.sh`) are byte-for-byte identical. Each script:

1. Installs `@bastani/atomic` globally via `bun add -g` (the package being rewritten — not a dep to research).
2. Patches shell rc-files (`/etc/profile.d/`, `/etc/bash.bashrc`, `/etc/zsh/zshrc`, `/etc/fish/conf.d/`) to put `~/.bun/bin` on PATH.
3. Generates a UTF-8 locale via `locale-gen` / `apk add musl-locales`.
4. Installs two global CLI tools: `@playwright/cli@latest` and `@llamaindex/liteparse@latest` — both are agent tooling sidecars, not runtime dependencies of the Atomic application logic.

The `devcontainer-feature.json` descriptors declare GHCR feature dependencies:

| Feature file | `dependsOn` GHCR features                  |
| ------------ | ------------------------------------------ |
| `claude`     | `tmux-apt-get:1`, `bun:1`, `claude-code:1` |
| `copilot`    | `tmux-apt-get:1`, `bun:1`, `copilot-cli:1` |
| `opencode`   | `tmux-apt-get:1`, `bun:1`, `opencode:1`    |

The root `devcontainer.json` and the three agent-specific manifests reference the same GHCR features inline.

### Why external docs are not central

The rewrite goal is to remove tmux/Claude/Copilot/OpenCode SDK dependencies and port onto `pi-coding-agent`. The `.devcontainer/` layer is pure environment provisioning — it does not contain application code, SDK calls, or logic that needs to be ported. The relevant removal surface in this partition is mechanical:

- Strip the `tmux-apt-get:1` dependency from all three `devcontainer-feature.json` files.
- Remove `ghcr.io/anthropics/devcontainer-features/claude-code:1`, `ghcr.io/devcontainers/features/copilot-cli:1`, and `ghcr.io/devcontainers-extra/features/opencode:1` feature references.
- Replace or collapse the three agent-specific `devcontainer.json` manifests and their corresponding feature directories with a single pi-coding-agent feature.
- Update environment variable forwarding (`ANTHROPIC_API_KEY`, `COPILOT_GITHUB_TOKEN`) to whatever the pi-coding-agent requires.

None of these changes require fetching external documentation — the devcontainer feature spec and GHCR feature naming conventions are stable, self-evident from the existing files, and the devcontainers spec schema itself is not being changed. The install scripts use only standard POSIX shell constructs and `bun add -g`, both of which are already covered by project-level docs.
