"""Shared eval-sandbox provisioning for Atomic, tmux, and playwright-cli."""

from __future__ import annotations

import re


def root_install_command(*, harbor: bool = False) -> str:
    """Install Atomic runtime tools plus tmux and Playwright browser libraries."""
    # Playwright-managed Chromium is reliable on Debian/Ubuntu, unlike Ubuntu's
    # snap-backed distro Chromium. The t64 names are needed by newer Ubuntu
    # images; apt-cache selects them without breaking older Debian images.
    apt = (
        "apt-get update && "
        "asound=$(if apt-cache show libasound2t64 >/dev/null 2>&1; then "
        "echo libasound2t64; else echo libasound2; fi) && "
        "atk=$(if apt-cache show libatk1.0-0t64 >/dev/null 2>&1; then "
        "echo libatk1.0-0t64; else echo libatk1.0-0; fi) && "
        "cups=$(if apt-cache show libcups2t64 >/dev/null 2>&1; then "
        "echo libcups2t64; else echo libcups2; fi) && "
        "apt-get install -y --no-install-recommends bash ca-certificates curl fd-find git "
        "ripgrep tmux fonts-liberation \"$asound\" \"$atk\" libatk-bridge2.0-0 "
        "libatspi2.0-0 libcairo2 \"$cups\" libdbus-1-3 libdrm2 libfontconfig1 "
        "libfreetype6 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 "
        "libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 "
        "libxi6 libxkbcommon0 libxrandr2 && "
        "ln -sf /usr/bin/fdfind /usr/local/bin/fd && rm -rf /var/lib/apt/lists/*"
    )
    if harbor:
        return "set -euo pipefail; " + apt
    apk = (
        "apk add --no-cache bash ca-certificates curl fd git nodejs npm "
        "ripgrep tmux chromium"
    )
    # Fedora provides these directly; RHEL-compatible images need EPEL.
    yum = (
        "yum install -y bash ca-certificates git tmux && "
        "(command -v curl >/dev/null 2>&1 || yum install -y curl) && "
        "(yum install -y chromium fd-find ripgrep || "
        "(yum install -y epel-release && yum install -y chromium fd-find ripgrep))"
    )
    return (
        "set -euo pipefail; "
        f"if command -v apk >/dev/null 2>&1; then {apk}; "
        f"elif command -v apt-get >/dev/null 2>&1; then {apt}; "
        f"elif command -v yum >/dev/null 2>&1; then {yum}; "
        "else echo 'Error: no supported package manager (apk, apt-get, yum)' >&2; exit 1; fi"
    )


def _validate_version_spec(version_spec: str) -> None:
    if not re.fullmatch(r"@[A-Za-z0-9][A-Za-z0-9._+-]*", version_spec):
        raise ValueError(f"Unsafe Atomic npm version specifier: {version_spec!r}")


def runtime_environment_command() -> str:
    """Load installer-persisted environment in non-login eval runtime shells."""
    return (
        'export PATH="$HOME/.local/bin:$PATH"; '
        'if [ -f "$HOME/.atomic-eval-env" ]; then . "$HOME/.atomic-eval-env"; fi'
    )


def agent_install_command(version_spec: str) -> str:
    """Install Atomic and playwright-cli, then configure Chromium."""
    _validate_version_spec(version_spec)
    node_setup = (
        "if command -v apk >/dev/null 2>&1; then "
        "node -e 'if (+process.versions.node.split(`.`)[0] < 18) process.exit(1)' || "
        "{ echo 'Error: Alpine nodejs must be Node.js 18 or newer' >&2; exit 1; }; "
        'npm config set prefix "$HOME/.local"; export PATH="$HOME/.local/bin:$PATH"; '
        'else export NVM_DIR="$HOME/.nvm"; '
        'if [ ! -s "$NVM_DIR/nvm.sh" ]; then '
        "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash; fi; "
        '. "$NVM_DIR/nvm.sh"; '
        "command -v nvm >/dev/null 2>&1 || { echo 'Error: NVM failed to load' >&2; exit 1; }; "
        "nvm install 22; nvm alias default 22; fi"
    )
    browser_setup = (
        'env_tmp="$HOME/.atomic-eval-env.tmp"; '
        "printf '%s\\n' 'export PLAYWRIGHT_MCP_BROWSER=chromium' "
        "'export PLAYWRIGHT_MCP_HEADLESS=true' "
        "'export PLAYWRIGHT_MCP_SANDBOX=false' > \"$env_tmp\"; "
        "if command -v apk >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then "
        "browser_path=$(command -v chromium || command -v chromium-browser); "
        "else playwright-cli install-browser --only-shell chromium; "
        'browser_path=$(find "$HOME/.cache/ms-playwright" -type f '
        "\\( -name headless_shell -o -name chrome-headless-shell \\) "
        "-perm -u+x -print -quit); fi; "
        'test -n "$browser_path" && test -x "$browser_path"; '
        "printf '%s\\n' \"export PLAYWRIGHT_MCP_EXECUTABLE_PATH='$browser_path'\" "
        '>> "$env_tmp"; '
        'mv -f "$env_tmp" "$HOME/.atomic-eval-env"; '
        f"{runtime_environment_command()}"
    )
    return (
        "set -euo pipefail; "
        f"{node_setup}; "
        'export PATH="$HOME/.local/bin:$PATH"; '
        f"npm install -g @bastani/atomic{version_spec} @playwright/cli; "
        f"{browser_setup}"
    )
