"""Shared eval-sandbox provisioning and host preflight for the Atomic evals.

Two concerns live here:

1. The shell-string builders that provision an eval sandbox (Atomic, tmux,
   playwright-cli).
2. The preflight gate that checks the Deep SWE corpus, the submodule pins, and
   the host environment *before* a benchmark run, so a mis-shaped corpus or an
   uninitialized submodule is reported as itself instead of as a mid-run
   failure.

The preflight parses ``task.toml`` with the standard library's :mod:`tomllib`
rather than pier's models on purpose: it has to keep working when
``evals/vendor/pier`` is uninitialized, which is exactly when a contributor
most needs the diagnostic.
"""

from __future__ import annotations

import os
import re
import subprocess
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path


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


def atomic_runtime_environment_command() -> str:
    """Load eval environment and NVM without trusting nvm.sh's exit status."""
    return (
        'export PATH="$HOME/.local/bin:$PATH"; '
        'if [ -f "$HOME/.atomic-eval-env" ]; then . "$HOME/.atomic-eval-env"; fi; '
        'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" || true; fi; '
        "command -v nvm >/dev/null 2>&1 || command -v atomic >/dev/null 2>&1 || "
        "{ echo 'Error: neither NVM nor Atomic is available' >&2; exit 1; }"
    )


def runtime_environment_command() -> str:
    """Load installer-persisted environment in non-login eval runtime shells."""
    return (
        'export PATH="$HOME/.local/bin:$PATH"; '
        'if [ -f "$HOME/.atomic-eval-env" ]; then . "$HOME/.atomic-eval-env"; fi'
    )


def _node_setup_command() -> str:
    """Configure distribution Node on Alpine or NVM-managed Node elsewhere."""
    return (
        "if command -v apk >/dev/null 2>&1; then "
        "node -e 'if (+process.versions.node.split(`.`)[0] < 18) process.exit(1)' || "
        "{ echo 'Error: Alpine nodejs must be Node.js 18 or newer' >&2; exit 1; }; "
        'npm config set prefix "$HOME/.local"; export PATH="$HOME/.local/bin:$PATH"; '
        'else export NVM_DIR="$HOME/.nvm"; '
        'if [ ! -s "$NVM_DIR/nvm.sh" ]; then '
        "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash; fi; "
        '. "$NVM_DIR/nvm.sh" || true; '
        "command -v nvm >/dev/null 2>&1 || { echo 'Error: NVM failed to load' >&2; exit 1; }; "
        "nvm install 22; nvm alias default 22; fi"
    )


def agent_install_command(version_spec: str) -> str:
    """Install Atomic and playwright-cli, then configure Chromium."""
    _validate_version_spec(version_spec)
    node_setup = _node_setup_command()
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


# --- preflight ---------------------------------------------------------------

EXPECTED_TASK_COUNT = 113
"""Deep SWE task count at the pinned corpus. A drift is a finding, not a detail."""

DEEP_SWE_SUBMODULE_PATH = "evals/deep-swe"
PIER_SUBMODULE_PATH = "evals/vendor/pier"

_COMPOSE_GLOB = "docker-compose.y*ml"
_CREDENTIAL_ENV_KEYS: tuple[str, ...] = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "COPILOT_GITHUB_TOKEN",
)

OK = "ok"
SKIPPED = "skipped"
FAILED = "failed"

type CommandRunner = Callable[[Sequence[str]], subprocess.CompletedProcess[str]]


class PreflightError(RuntimeError):
    """Raised by :func:`require_preflight` when a preflight check fails."""

    def __init__(self, report: PreflightReport) -> None:
        self.report = report
        super().__init__(report.describe())


@dataclass(frozen=True)
class CheckResult:
    """One preflight check: ``ok``, ``skipped``, or ``failed``, with a reason."""

    name: str
    status: str
    message: str
    details: dict[str, object] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == OK

    @property
    def skipped(self) -> bool:
        return self.status == SKIPPED

    @property
    def failed(self) -> bool:
        return self.status == FAILED


@dataclass(frozen=True)
class PreflightReport:
    """The aggregate of every check that ran."""

    checks: tuple[CheckResult, ...]

    @property
    def failures(self) -> tuple[CheckResult, ...]:
        return tuple(check for check in self.checks if check.failed)

    @property
    def skips(self) -> tuple[CheckResult, ...]:
        return tuple(check for check in self.checks if check.skipped)

    @property
    def ok(self) -> bool:
        return not self.failures

    def describe(self) -> str:
        return "\n".join(f"[{check.status}] {check.name}: {check.message}" for check in self.checks)


def _run(command: Sequence[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - fixed argv, no shell
        list(command),
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        check=False,
    )


def repository_root(start: Path | None = None) -> Path:
    """Return the superproject root that owns ``evals/``."""
    return (start or Path(__file__).resolve().parent).parent


def submodule_pin(path: str, *, repo_root: Path | None = None) -> str | None:
    """Return the gitlink SHA recorded for ``path`` in the superproject's HEAD.

    Read from the gitlink (``git rev-parse HEAD:<path>``) rather than from
    ``git -C <path> rev-parse HEAD``, which silently prints the *superproject*
    SHA when the submodule is uninitialized.
    """
    root = repo_root or repository_root()
    completed = _run(["git", "rev-parse", f"HEAD:{path}"], cwd=root)
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def is_submodule_initialized(path: str, *, repo_root: Path | None = None) -> bool:
    """True when the submodule working tree at ``path`` has been checked out."""
    root = repo_root or repository_root()
    return (root / path / ".git").exists()


def corpus_tasks_dir(repo_root: Path | None = None) -> Path:
    root = repo_root or repository_root()
    return root / DEEP_SWE_SUBMODULE_PATH / "tasks"


def check_corpus(
    tasks_dir: Path | None = None,
    *,
    expected_tasks: int = EXPECTED_TASK_COUNT,
    repo_root: Path | None = None,
) -> CheckResult:
    """Parse every ``task.toml`` and assert the corpus shape.

    Skips — never fails — when ``evals/deep-swe`` is uninitialized, because
    ``uv run pytest`` runs for contributors who never touch evals.
    """
    tasks = tasks_dir or corpus_tasks_dir(repo_root)
    task_files = sorted(tasks.glob("*/task.toml")) if tasks.is_dir() else []
    if not task_files:
        return CheckResult(
            name="deep-swe corpus",
            status=SKIPPED,
            message=(
                f"deep-swe corpus is not initialized (no task.toml under {tasks}). "
                "Run `git submodule update --init --recursive` from the repository "
                "root to enable corpus preflight. Skipping corpus checks."
            ),
            details={"tasks_dir": str(tasks)},
        )

    problems: list[str] = []
    with_collect = 0
    compose_files: list[str] = []
    for task_file in task_files:
        try:
            config = tomllib.loads(task_file.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as error:
            problems.append(f"{task_file}: malformed TOML: {error}")
            continue
        verifier = config.get("verifier")
        collect = verifier.get("collect") if isinstance(verifier, dict) else None
        if isinstance(collect, list) and collect:
            with_collect += 1
        else:
            problems.append(f"{task_file}: no [[verifier.collect]] hook")
        compose_files.extend(
            str(path) for path in sorted(task_file.parent.rglob(_COMPOSE_GLOB))
        )

    if len(task_files) != expected_tasks:
        problems.append(f"expected {expected_tasks} tasks, found {len(task_files)}")
    if compose_files:
        problems.append(f"expected 0 compose files, found {len(compose_files)}: {compose_files[:3]}")

    details: dict[str, object] = {
        "tasks": len(task_files),
        "collect_hooks": with_collect,
        "compose_files": len(compose_files),
        "tasks_dir": str(tasks),
    }
    if problems:
        return CheckResult(
            name="deep-swe corpus",
            status=FAILED,
            message="; ".join(problems[:5])
            + (f" (+{len(problems) - 5} more)" if len(problems) > 5 else ""),
            details=details,
        )
    return CheckResult(
        name="deep-swe corpus",
        status=OK,
        message=(
            f"{len(task_files)} tasks, {with_collect} collect hooks, {len(compose_files)} compose files"
        ),
        details=details,
    )


def check_submodules(*, repo_root: Path | None = None) -> CheckResult:
    """Report the recorded gitlink pins and whether each working tree exists."""
    root = repo_root or repository_root()
    details: dict[str, object] = {}
    missing: list[str] = []
    for path in (DEEP_SWE_SUBMODULE_PATH, PIER_SUBMODULE_PATH):
        details[path] = {
            "pin": submodule_pin(path, repo_root=root),
            "initialized": is_submodule_initialized(path, repo_root=root),
        }
        if not is_submodule_initialized(path, repo_root=root):
            missing.append(path)
    if missing:
        return CheckResult(
            name="submodules",
            status=SKIPPED,
            message=(
                f"uninitialized submodule(s): {', '.join(missing)}. "
                "Run `git submodule update --init --recursive` from the repository root."
            ),
            details=details,
        )
    return CheckResult(
        name="submodules",
        status=OK,
        message="evals/deep-swe and evals/vendor/pier are initialized",
        details=details,
    )


def check_docker(runner: CommandRunner | None = None) -> CheckResult:
    """Check that a Docker daemon answers. Failure here is a real failure."""
    run = runner or (lambda command: _run(command))
    try:
        completed = run(["docker", "info", "--format", "{{.ServerVersion}}"])
    except FileNotFoundError:
        return CheckResult(
            name="docker",
            status=FAILED,
            message="docker executable not found on PATH",
        )
    if completed.returncode != 0:
        return CheckResult(
            name="docker",
            status=FAILED,
            message=f"`docker info` exited {completed.returncode}: {(completed.stderr or '').strip()[:200]}",
        )
    version = (completed.stdout or "").strip()
    return CheckResult(
        name="docker",
        status=OK,
        message=f"docker server {version}",
        details={"server_version": version},
    )


def check_credentials(
    env: Mapping[str, str] | None = None,
    *,
    auth_paths: Sequence[Path] | None = None,
) -> CheckResult:
    """Check that at least one provider credential is reachable."""
    environ = env if env is not None else os.environ
    present = [key for key in _CREDENTIAL_ENV_KEYS if (environ.get(key) or "").strip()]
    paths = (
        list(auth_paths)
        if auth_paths is not None
        else [Path.home() / ".atomic" / "agent" / "auth.json", Path.home() / ".pi" / "agent" / "auth.json"]
    )
    subscriptions = [str(path) for path in paths if path.is_file()]
    if not present and not subscriptions:
        return CheckResult(
            name="credentials",
            status=FAILED,
            message=(
                "no provider credential found: none of "
                f"{', '.join(_CREDENTIAL_ENV_KEYS)} is set and no local auth.json exists"
            ),
        )
    return CheckResult(
        name="credentials",
        status=OK,
        message=(
            f"{len(present)} credential env var(s), {len(subscriptions)} local subscription file(s)"
        ),
        details={"env_keys": present, "auth_files": subscriptions},
    )


def run_preflight(
    *,
    repo_root: Path | None = None,
    tasks_dir: Path | None = None,
    expected_tasks: int = EXPECTED_TASK_COUNT,
    docker_runner: CommandRunner | None = None,
    env: Mapping[str, str] | None = None,
    auth_paths: Sequence[Path] | None = None,
    include_host_checks: bool = True,
) -> PreflightReport:
    """Run every preflight check and return the aggregate report."""
    checks: list[CheckResult] = [
        check_submodules(repo_root=repo_root),
        check_corpus(tasks_dir, expected_tasks=expected_tasks, repo_root=repo_root),
    ]
    if include_host_checks:
        checks.append(check_docker(docker_runner))
        checks.append(check_credentials(env, auth_paths=auth_paths))
    return PreflightReport(checks=tuple(checks))


def require_preflight(**kwargs: object) -> PreflightReport:
    """Run the preflight and raise :class:`PreflightError` if any check failed."""
    report = run_preflight(**kwargs)  # pyright: ignore[reportArgumentType]
    if not report.ok:
        raise PreflightError(report)
    return report
