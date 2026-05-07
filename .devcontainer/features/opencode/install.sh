#!/usr/bin/env bash
#-------------------------------------------------------------------------------------------------------------
# Installs the Atomic CLI globally via bun from the npm registry.
# Config data, agent config syncing, tooling and SDK installation are all
# handled on first `atomic chat` run via auto-init.
#
# NOTE: This script is duplicated across claude, copilot, and opencode features.
#       Keep all three copies in sync when making changes.
#       See: .devcontainer/features/{claude,copilot,opencode}/install.sh
#-------------------------------------------------------------------------------------------------------------

set -e

if [ "$(id -u)" -ne 0 ]; then
    echo 'Script must be run as root.' >&2
    exit 1
fi

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

echo "Installing ${ATOMIC_SPEC}..."

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

# ─── Install atomic via bun (global) ────────────────────────────────────────
# bun is provided by the dependent ghcr.io/devcontainers-extra/features/bun:1
# feature. Install as the remote user via a login shell so bun's PATH setup is
# picked up and the package lands in their ~/.bun/bin (not root's home).
if ! su - "${REMOTE_USER}" -c 'command -v bun >/dev/null 2>&1'; then
    echo "Error: bun is not on ${REMOTE_USER}'s PATH. The bun devcontainer feature must install before this one." >&2
    exit 1
fi
su - "${REMOTE_USER}" -c "bun add -g '${ATOMIC_SPEC}'"

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

echo "✓ Atomic CLI installed (${ATOMIC_SPEC})"

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

# ─── Install global CLI tools via bun ──────────────────────────────────────
# Use bun (already installed) with --trust to allow postinstall lifecycle
# scripts (e.g. playwright browser downloads).
echo "Installing global CLI tools..."
su - "${REMOTE_USER}" -c "bun install -g --trust @playwright/cli@latest @llamaindex/liteparse@latest" 2>&1 \
    && echo "✓ Global CLI tools installed" \
    || echo "⚠ Some global CLI tools failed to install (non-fatal)"
