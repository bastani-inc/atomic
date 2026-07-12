"""Shared sandbox provisioning for the runtime prerequisites of shipped Atomic skills."""

from __future__ import annotations
import re

from dataclasses import dataclass

PLAYWRIGHT_CLI_VERSION = "0.1.17"
LITEPARSE_VERSION = "2.5.1"
UV_VERSION = "0.11.28"
PYTHON_VERSION = "3.13"


@dataclass(frozen=True)
class SkillPrerequisite:
    skill: str
    prerequisite: str
    install: str
    verify: str
    required_for: str = "all uses"


SHIPPED_SKILLS = (
    "create-spec",
    "effective-liteparse",
    "impeccable",
    "intercom",
    "playwright-cli",
    "prompt-engineer",
    "research-codebase",
    "skill-creator",
    "subagent",
    "tdd",
    "tmux",
)

PREREQUISITES = (
    SkillPrerequisite(
        "effective-liteparse",
        "Node.js 18+",
        "NVM Node 22 or distro nodejs",
        "node --version",
    ),
    SkillPrerequisite(
        "effective-liteparse",
        f"@llamaindex/liteparse@{LITEPARSE_VERSION}",
        f"npm install -g @llamaindex/liteparse@{LITEPARSE_VERSION}",
        "lit --version",
    ),
    SkillPrerequisite(
        "effective-liteparse",
        "LibreOffice",
        "install distro libreoffice package",
        "libreoffice --version",
        "Office documents",
    ),
    SkillPrerequisite(
        "effective-liteparse",
        "ImageMagick",
        "install distro imagemagick package",
        "magick -version || convert -version",
        "images",
    ),
    SkillPrerequisite(
        "effective-liteparse",
        f"uv {UV_VERSION} and Python {PYTHON_VERSION}",
        f"install uv {UV_VERSION}; uv python install {PYTHON_VERSION}",
        "uv --version; uv python find 3.13",
        "bundled ranked-search helper",
    ),
    SkillPrerequisite(
        "playwright-cli",
        f"@playwright/cli@{PLAYWRIGHT_CLI_VERSION}",
        f"npm install -g @playwright/cli@{PLAYWRIGHT_CLI_VERSION}; playwright install chromium",
        "playwright-cli --version; offline browser launch",
    ),
    SkillPrerequisite(
        "tmux", "tmux-compatible CLI", "install distro tmux package", "tmux -V"
    ),
    SkillPrerequisite(
        "impeccable", "Node.js", "NVM Node 22 or distro nodejs", "node --version"
    ),
    SkillPrerequisite(
        "skill-creator",
        "Python 3 and PyYAML",
        "install distro python3 and PyYAML packages",
        'python3 -c "import yaml"',
    ),
)

NO_EXTERNAL_PREREQUISITES = (
    "create-spec",
    "intercom",
    "prompt-engineer",
    "research-codebase",
    "subagent",
    "tdd",
)


def root_install_command(*, harbor: bool = False) -> str:
    """Return an idempotent, noninteractive system-package installation command."""
    apt = (
        "apt-get update && apt-get install -y --no-install-recommends "
        "bash ca-certificates curl fd-find git imagemagick libreoffice python3 python3-yaml ripgrep tmux "
        "libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 "
        "libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 "
        "libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 "
        "libxkbcommon0 libxrandr2 xvfb fonts-liberation && "
        "ln -sf /usr/bin/fdfind /usr/local/bin/fd && rm -rf /var/lib/apt/lists/*"
    )
    if harbor:
        return "set -euo pipefail; " + apt
    apk = (
        "apk add --no-cache bash ca-certificates curl fd git imagemagick libreoffice nodejs npm "
        "py3-yaml python3 ripgrep tmux chromium && "
        "apk add --no-cache libc++ --repository=https://dl-cdn.alpinelinux.org/alpine/edge/main"
    )
    yum = (
        "yum install -y --allowerasing bash ca-certificates curl git dnf-plugins-core epel-release && "
        "(dnf config-manager --set-enabled crb || "
        "dnf config-manager --set-enabled powertools || true) && yum makecache && "
        "yum install -y --allowerasing ImageMagick chromium libreoffice-core libreoffice-writer "
        "libreoffice-calc libreoffice-impress python3 python3-pyyaml ripgrep tmux"
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
    """Install Atomic plus pinned skill CLIs, browsers, and uv as the sandbox user."""
    _validate_version_spec(version_spec)
    node_setup = (
        "if command -v apk >/dev/null 2>&1; then "
        "node -e 'if (process.versions.node.split(`.`)[0] !== `22`) process.exit(1)' || "
        "{ echo 'Error: Alpine nodejs must be Node 22' >&2; exit 1; }; "
        'npm config set prefix "$HOME/.local"; export PATH="$HOME/.local/bin:$PATH"; '
        "else curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash; "
        'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; '
        "command -v nvm >/dev/null 2>&1 || { echo 'Error: NVM failed to load' >&2; exit 1; }; "
        "nvm install 22; nvm alias default 22; fi"
    )
    browser_setup = (
        "if command -v apk >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then "
        "browser_path=$(command -v chromium || command -v chromium-browser) && "
        'env_tmp="$HOME/.atomic-eval-env.tmp" && '
        "printf '%s\\n' \"export PLAYWRIGHT_MCP_EXECUTABLE_PATH='$browser_path'\" "
        "'export PLAYWRIGHT_MCP_BROWSER=chromium' 'export PLAYWRIGHT_MCP_HEADLESS=true' "
        "'export PLAYWRIGHT_MCP_SANDBOX=false' > \"$env_tmp\" && "
        'mv -f "$env_tmp" "$HOME/.atomic-eval-env" && '
        f"{runtime_environment_command()}; else "
        'PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" '
        'node "$(npm root -g)/@playwright/cli/node_modules/playwright/cli.js" install chromium; fi'
    )
    return (
        "set -euo pipefail; "
        f"{node_setup}; "
        'export PATH="$HOME/.local/bin:$PATH"; '
        f"npm install -g @bastani/atomic{version_spec} "
        f"@playwright/cli@{PLAYWRIGHT_CLI_VERSION} "
        f"@llamaindex/liteparse@{LITEPARSE_VERSION}; "
        f"curl -fsSL https://astral.sh/uv/{UV_VERSION}/install.sh | "
        'env UV_INSTALL_DIR="$HOME/.local/bin" sh; '
        f"uv python install {PYTHON_VERSION}; "
        "uv run --python 3.13 --with 'bm25s>=0.3.9,<1' --with 'aiofiles>=25.1.0,<26' "
        "python -c 'import aiofiles, bm25s'; "
        f"{browser_setup}; " + verification_command()
    )


def verification_command() -> str:
    """Fail fast unless every provisioned prerequisite is functional, including offline Chromium."""
    return (
        "atomic --version; node --version; npm --version; tmux -V; lit --version; "
        "uv --version; uv python find 3.13 >/dev/null; "
        "UV_OFFLINE=1 uv run --python 3.13 --with 'bm25s>=0.3.9,<1' "
        "--with 'aiofiles>=25.1.0,<26' python -c 'import aiofiles, bm25s'; "
        "python3 -c 'import yaml'; libreoffice --version; "
        "(magick -version || convert -version); playwright-cli --version; "
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_offline=true "
        "PLAYWRIGHT_MCP_BROWSER=chromium playwright-cli open about:blank; "
        "playwright-cli snapshot >/dev/null; playwright-cli close"
    )
