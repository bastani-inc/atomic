# Pattern Findings: `.devcontainer/` Configuration & Installation Scripts

## Overview

The `.devcontainer/` partition contains agent-specific devcontainer configurations, GHCR feature definitions, and shared installation scripts. The current implementation supports three agents (Claude Code, Copilot CLI, OpenCode) with duplicated install scripts and agent-specific dependencies. For pi-coding-agent migration, these are direct removal/rewrite targets.

---

## Patterns Found

#### Pattern: Multi-Agent Devcontainer Feature Configuration (Agent-Specific)

**Where:** `.devcontainer/features/claude/devcontainer-feature.json:1-24`
**What:** Feature metadata manifest defining dependencies, installation order, and version constraints for a single agent-specific devcontainer feature.

```json
{
    "id": "claude",
    "version": "1.0.15",
    "name": "Atomic + Claude Code",
    "description": "Installs Atomic CLI with Claude Code agent, skills, and shared tooling (playwright, liteparse)",
    "documentationURL": "https://github.com/bastani/atomic",
    "options": {
        "version": {
            "type": "string",
            "proposals": ["latest", "prerelease"],
            "default": "latest",
            "description": "Select version of Atomic CLI, if not latest."
        }
    },
    "dependsOn": {
        "ghcr.io/devcontainers-extra/features/tmux-apt-get:1": {},
        "ghcr.io/devcontainers-extra/features/bun:1": {},
        "ghcr.io/anthropics/devcontainer-features/claude-code:1": {}
    },
    "installsAfter": [
        "ghcr.io/devcontainers/features/common-utils",
        "ghcr.io/devcontainers/features/github-cli:1"
    ]
}
```

**Variations / call-sites:**

- `.devcontainer/features/copilot/devcontainer-feature.json:1-24` (substitutes `ghcr.io/devcontainers/features/copilot-cli:1` for Claude Code)
- `.devcontainer/features/opencode/devcontainer-feature.json:1-24` (substitutes `ghcr.io/devcontainers-extra/features/opencode:1`)

---

#### Pattern: Root Devcontainer with Multi-Feature Composition

**Where:** `.devcontainer/devcontainer.json:1-41`
**What:** Main devcontainer config that composes all three agent features plus base platform features, centralizing credential env vars and VS Code extensions.

```json
{
    "name": "Atomic CLI",
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
    "features": {
        "ghcr.io/devcontainers/features/common-utils": {},
        "ghcr.io/devcontainers/features/github-cli:1": {},
        "ghcr.io/devcontainers/features/docker-in-docker:2": {},
        "./features/claude": {},
        "./features/copilot": {},
        "./features/opencode": {}
    },
    "remoteEnv": {
        "GH_TOKEN": "${localEnv:GH_TOKEN}",
        "COPILOT_GITHUB_TOKEN": "${localEnv:COPILOT_GITHUB_TOKEN}",
        "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}"
    },
    "postCreateCommand": "bun install",
    "mounts": [
        {
            "source": "${localEnv:HOME}${localEnv:USERPROFILE}/.ssh",
            "target": "/home/vscode/.ssh",
            "type": "bind"
        },
        {
            "source": "${localEnv:HOME}${localEnv:USERPROFILE}/.gitconfig",
            "target": "/home/vscode/.gitconfig",
            "type": "bind"
        }
    ],
    "customizations": {
        "vscode": {
            "extensions": [
                "oven.bun-vscode",
                "oxc.oxc-vscode",
                "shd101wyy.markdown-preview-enhanced",
                "Anthropic.claude-code",
                "sst-dev.opencode"
            ]
        }
    }
}
```

**Variations / call-sites:**

- `.devcontainer/claude/devcontainer.json:1-36` (single agent; includes only `"Anthropic.claude-code"` extension)
- `.devcontainer/copilot/devcontainer.json:1-35` (single agent; omits agent extension)
- `.devcontainer/opencode/devcontainer.json:1-35` (single agent; includes only `"sst-dev.opencode"` extension)

---

#### Pattern: Duplicated NPM Version Resolution Switch

**Where:** `.devcontainer/features/claude/install.sh:19-43`
**What:** Bash case statement resolving VERSION environment variable to npm dist-tag (latest/prerelease) or explicit semver, with validation and v-prefix stripping.

```bash
# ─── Resolve npm dist-tag / version ─────────────────────────────────────────
# Option -> npm package spec:
#   latest     → @bastani/atomic@latest  (stable releases)
#   prerelease → @bastani/atomic@next    (prereleases — matches `npm publish --tag next` in publish.yml)
#   <version>  → @bastani/atomic@<version>
ATOMIC_VERSION="${VERSION:-latest}"

case "${ATOMIC_VERSION}" in
    latest)
        ATOMIC_SPEC="@bastani/atomic@latest"
        ;;
    prerelease)
        ATOMIC_SPEC="@bastani/atomic@next"
        ;;
    *)
        # Validate semver (MAJOR.MINOR.PATCH with optional numeric prerelease suffix)
        if ! echo "${ATOMIC_VERSION}" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$'; then
            echo "Error: '${ATOMIC_VERSION}' is not a valid semver." >&2
            echo "Expected format: MAJOR.MINOR.PATCH (e.g., 1.0.0 or 1.0.0-1)" >&2
            exit 1
        fi
        # Strip leading v — npm specs don't use the v prefix
        ATOMIC_SPEC="@bastani/atomic@${ATOMIC_VERSION#v}"
        ;;
esac
```

**Variations / call-sites:**

- `.devcontainer/features/copilot/install.sh:19-43` (identical copy)
- `.devcontainer/features/opencode/install.sh:19-43` (identical copy)
- **Note at line 7-9**: Explicit warning that script is duplicated across all three features and must be kept in sync.

---

#### Pattern: Remote User Resolution with Fallback

**Where:** `.devcontainer/features/claude/install.sh:47-56`
**What:** Resolves devcontainer-exposed `_REMOTE_USER` and `_REMOTE_USER_HOME` variables with graceful fallback to defaults and validates home directory existence.

```bash
# ─── Resolve remote user ────────────────────────────────────────────────────
# Devcontainer CLI exposes _REMOTE_USER and _REMOTE_USER_HOME at feature-install
# time. Fall back gracefully if the feature is invoked outside the devcontainer
# CLI (e.g. local testing).
REMOTE_USER="${_REMOTE_USER:-${USERNAME:-vscode}}"
REMOTE_HOME="${_REMOTE_USER_HOME:-/home/${REMOTE_USER}}"
if [ ! -d "${REMOTE_HOME}" ]; then
    echo "Error: remote user home directory '${REMOTE_HOME}' does not exist" >&2
    exit 1
fi
```

**Variations / call-sites:**

- `.devcontainer/features/copilot/install.sh:47-56` (identical copy)
- `.devcontainer/features/opencode/install.sh:47-56` (identical copy)

---

#### Pattern: Bun Global Install with Login Shell Execution

**Where:** `.devcontainer/features/claude/install.sh:58-66`
**What:** Invokes `bun add -g` as the remote user via login shell to ensure bun's PATH setup is sourced and package lands in user's `~/.bun/bin`, with dependency validation.

```bash
# ─── Install atomic via bun (global) ────────────────────────────────────────
# bun is provided by the dependent ghcr.io/devcontainers-extra/features/bun:1
# feature. Install as the remote user via a login shell so bun's PATH setup is
# picked up and the package lands in their ~/.bun/bin (not root's home).
if ! su - "${REMOTE_USER}" -c 'command -v bun >/dev/null 2>&1'; then
    echo "Error: bun is not on ${REMOTE_USER}'s PATH. The bun devcontainer feature must install before this one." >&2
    exit 1
fi
su - "${REMOTE_USER}" -c "bun add -g '${ATOMIC_SPEC}'"
```

**Variations / call-sites:**

- `.devcontainer/features/copilot/install.sh:58-66` (identical copy)
- `.devcontainer/features/opencode/install.sh:58-66` (identical copy)

---

#### Pattern: Multi-Shell PATH Configuration (Shell-Specific RC Files)

**Where:** `.devcontainer/features/claude/install.sh:68-127`
**What:** Writes `~/.bun/bin` to PATH across five shell entry points (login, bash, zsh, fish) with idempotent grep checks and shell-specific syntax.

```bash
# ─── Ensure ~/.bun/bin is on PATH for ALL shell types ──────────────────────
# The bun feature may configure PATH in the user's rc files, but devcontainer
# terminals often run as non-login shells that skip /etc/profile.d/. Cover
# every entry point so `atomic` (and other bun globals) are always found:
#   - Login shells:          /etc/profile.d/
#   - Non-login bash shells: /etc/bash.bashrc
#   - Non-login zsh shells:  /etc/zsh/zshrc
#   - Fish shells:           /etc/fish/conf.d/

# Login shells
cat > /etc/profile.d/atomic-path.sh <<'PROFILE_EOF'
if [ -d "$HOME/.bun/bin" ]; then
    case ":$PATH:" in
        *":$HOME/.bun/bin:"*) ;;
        *) export PATH="$HOME/.bun/bin:$PATH" ;;
    esac
fi
PROFILE_EOF
chmod 644 /etc/profile.d/atomic-path.sh

# Non-login bash shells
if [ -f /etc/bash.bashrc ] && ! grep -q '.bun/bin' /etc/bash.bashrc 2>/dev/null; then
    cat >> /etc/bash.bashrc <<'BASHRC_EOF'

# bun global bin (atomic CLI + tools)
if [ -d "$HOME/.bun/bin" ]; then
    case ":$PATH:" in
        *":$HOME/.bun/bin:"*) ;;
        *) export PATH="$HOME/.bun/bin:$PATH" ;;
    esac
fi
BASHRC_EOF
fi

# Non-login zsh shells
if [ -f /etc/zsh/zshrc ] && ! grep -q '.bun/bin' /etc/zsh/zshrc 2>/dev/null; then
    cat >> /etc/zsh/zshrc <<'ZSHRC_EOF'

# bun global bin (atomic CLI + tools)
if [ -d "$HOME/.bun/bin" ]; then
    case ":$PATH:" in
        *":$HOME/.bun/bin:"*) ;;
        *) export PATH="$HOME/.bun/bin:$PATH" ;;
    esac
fi
ZSHRC_EOF
fi

# Fish shells (conf.d is auto-sourced on every fish startup)
if [ -d /etc/fish/conf.d ] && ! grep -q '.bun/bin' /etc/fish/conf.d/atomic-path.fish 2>/dev/null; then
    cat > /etc/fish/conf.d/atomic-path.fish <<'FISH_EOF'
# bun global bin (atomic CLI + tools)
if test -d "$HOME/.bun/bin"
    if not contains "$HOME/.bun/bin" $PATH
        set -gx PATH "$HOME/.bun/bin" $PATH
    end
end
FISH_EOF
    chmod 644 /etc/fish/conf.d/atomic-path.fish
fi
```

**Variations / call-sites:**

- `.devcontainer/features/copilot/install.sh:68-127` (identical copy)
- `.devcontainer/features/opencode/install.sh:68-127` (identical copy)

---

#### Pattern: Locale Configuration with Package Manager Branching

**Where:** `.devcontainer/features/claude/install.sh:131-209`
**What:** Ensures UTF-8 locale for proper Unicode/ASCII art rendering with conditional branches for apt-get (Debian/Ubuntu) and apk (Alpine), plus multi-shell locale env var setup.

```bash
# ─── Ensure UTF-8 locale for proper Unicode/ASCII art rendering ───────────
# Agent CLIs (e.g. Copilot) emit Unicode box-drawing / figlet characters.
# Without a UTF-8 locale the output is garbled when spawned as a Bun
# subprocess inside the devcontainer.
#
# Branches by host package manager:
#   apt-get → install `locales`, run `locale-gen en_US.UTF-8`, `update-locale`
#   apk     → install `musl-locales` (Alpine; no locale-gen needed)
#   neither → skip silently — the rc-file env exports below still set
#             LANG/LC_ALL so most agent CLIs render correctly even without
#             a generated locale archive.

if command -v apt-get >/dev/null 2>&1; then
    if ! command -v locale-gen >/dev/null 2>&1; then
        apt-get update -y
        apt-get install -y --no-install-recommends locales
    fi
    if [ -f /etc/locale.gen ]; then
        sed -i 's/^# *en_US\.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
    fi
    if ! grep -q '^en_US\.UTF-8 UTF-8' /etc/locale.gen 2>/dev/null; then
        echo 'en_US.UTF-8 UTF-8' >> /etc/locale.gen
    fi
    locale-gen en_US.UTF-8
    if command -v update-locale >/dev/null 2>&1; then
        update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LC_CTYPE=en_US.UTF-8
    fi
elif command -v apk >/dev/null 2>&1; then
    # Alpine ships a stripped-down musl libc with no locale data. The
    # `musl-locales` community package installs the en_US.UTF-8 archive,
    # which the env exports below then activate.
    apk add --no-cache musl-locales musl-locales-lang 2>/dev/null || true
fi

cat > /etc/profile.d/atomic-locale.sh <<'LOCALE_EOF'
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"
LOCALE_EOF
chmod 644 /etc/profile.d/atomic-locale.sh

# Non-login bash shells
if [ -f /etc/bash.bashrc ] && ! grep -q 'atomic-locale' /etc/bash.bashrc 2>/dev/null; then
    cat >> /etc/bash.bashrc <<'BASHRC_LOCALE_EOF'

# atomic-locale: ensure UTF-8 for agent CLI Unicode rendering
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"
BASHRC_LOCALE_EOF
fi

# Non-login zsh shells
if [ -f /etc/zsh/zshrc ] && ! grep -q 'atomic-locale' /etc/zsh/zshrc 2>/dev/null; then
    cat >> /etc/zsh/zshrc <<'ZSHRC_LOCALE_EOF'

# atomic-locale: ensure UTF-8 for agent CLI Unicode rendering
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"
ZSHRC_LOCALE_EOF
fi

# Fish shells
if [ -d /etc/fish/conf.d ]; then
    cat > /etc/fish/conf.d/atomic-locale.fish <<'FISH_LOCALE_EOF'
# atomic-locale: ensure UTF-8 for agent CLI Unicode rendering
if not set -q LANG
    set -gx LANG en_US.UTF-8
end
if not set -q LC_ALL
    set -gx LC_ALL en_US.UTF-8
end
if not set -q LC_CTYPE
    set -gx LC_CTYPE en_US.UTF-8
end
FISH_LOCALE_EOF
    chmod 644 /etc/fish/conf.d/atomic-locale.fish
fi
```

**Variations / call-sites:**

- `.devcontainer/features/copilot/install.sh:131-209` (identical copy)
- `.devcontainer/features/opencode/install.sh:131-209` (identical copy)

---

#### Pattern: Global CLI Tool Installation with Error Tolerance

**Where:** `.devcontainer/features/claude/install.sh:211-217`
**What:** Installs additional global CLI tools (@playwright/cli, @llamaindex/liteparse) via bun with `--trust` flag and non-fatal error handling.

```bash
# ─── Install global CLI tools via bun ──────────────────────────────────────
# Use bun (already installed) with --trust to allow postinstall lifecycle
# scripts (e.g. playwright browser downloads).
echo "Installing global CLI tools..."
su - "${REMOTE_USER}" -c "bun install -g --trust @playwright/cli@latest @llamaindex/liteparse@latest" 2>&1 \
    && echo "✓ Global CLI tools installed" \
    || echo "⚠ Some global CLI tools failed to install (non-fatal)"
```

**Variations / call-sites:**

- `.devcontainer/features/copilot/install.sh:211-217` (identical copy)
- `.devcontainer/features/opencode/install.sh:211-217` (identical copy)

---

#### Pattern: Agent-Specific Environment Variables

**Where:** `.devcontainer/claude/devcontainer.json:10-12`
**What:** Credential environment variables mapped from local environment, with agent-specific keys (ANTHROPIC_API_KEY for Claude Code).

```json
"remoteEnv": {
  "GH_TOKEN": "${localEnv:GH_TOKEN}",
  "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}"
}
```

**Variations / call-sites:**

- `.devcontainer/copilot/devcontainer.json:10-12` (includes `COPILOT_GITHUB_TOKEN` instead of ANTHROPIC_API_KEY)
- `.devcontainer/opencode/devcontainer.json:10-11` (only GH_TOKEN)
- `.devcontainer/devcontainer.json:12-15` (combines all three agent tokens)

---

## Summary

The `.devcontainer/` partition exhibits a **template-with-substitution pattern** where three near-identical feature configurations (claude, copilot, opencode) differ primarily in:

- Agent-specific GHCR feature dependencies (line 16-18 in devcontainer-feature.json)
- Corresponding agent CLI installation packages (claude-code vs. copilot-cli vs. opencode)
- Credential environment variables (ANTHROPIC_API_KEY vs. COPILOT_GITHUB_TOKEN vs. GH_TOKEN)
- VS Code extension IDs

The install scripts are **explicitly duplicated** (as noted in lines 7-9 of each install.sh) across all three features with a requirement to keep them in sync. For pi-coding-agent migration, this duplication pattern will need to be consolidated into a single pi-specific feature with parameterization or a shared base script with agent-specific overrides.

Key removal/rewrite targets for the pi-coding-agent migration:

1. `.devcontainer/features/{claude,copilot,opencode}/devcontainer-feature.json` → Single `.devcontainer/features/pi/devcontainer-feature.json`
2. `.devcontainer/features/{claude,copilot,opencode}/install.sh` → Single `.devcontainer/features/pi/install.sh` (extract agent-specific vars to parameters)
3. `.devcontainer/{claude,copilot,opencode}/devcontainer.json` → `.devcontainer/pi/devcontainer.json` (or remove if unneeded)
4. Feature references in `.devcontainer/devcontainer.json:8-10` → `.devcontainer/features/pi` only
