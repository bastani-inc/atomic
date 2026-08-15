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

import fnmatch
import json
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

PROVIDER_AUTH_ENV_KEYS: dict[str, tuple[str, ...]] = {
    "amazon-bedrock": ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"),
    "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"),
    "github-copilot": ("COPILOT_GITHUB_TOKEN",),
    "google": (
        "GEMINI_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_API_KEY",
    ),
    "groq": ("GROQ_API_KEY",),
    "kimi-coding": ("KIMI_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "moonshotai": ("MOONSHOT_API_KEY",),
    "moonshotai-cn": ("MOONSHOT_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "xai": ("XAI_API_KEY",),
    "zai": ("ZAI_API_KEY",),
    "zai-coding-cn": ("ZAI_CODING_CN_API_KEY",),
}
"""Canonical provider → credential env keys for the **Pier** run path.

``atomic_pier.Atomic._PROVIDER_AUTH_ENV_KEYS`` *is* this dict, so the preflight
and the Pier adapter cannot disagree. The import direction is one-way — the
adapters import this module, so this module must never import an adapter.

``atomic_harbor.Atomic`` keeps its own literal, which diverges in both
directions: it carries ``huggingface: ("HF_TOKEN",)`` and omits the Kimi,
Moonshot and ZAI providers. That divergence is deliberate and left alone.
``huggingface`` is not added here because the Pier adapter's ``_PROVIDER_DOMAINS``
deliberately disables it under restricted egress (huggingface.co also serves git
repos and datasets), so admitting the credential would imply an egress rule the
adapter refuses to grant. The credential preflight exists for the Deep SWE run
path, which is Pier's.
"""

CREDENTIAL_ENV_KEYS: tuple[str, ...] = tuple(
    sorted({key for keys in PROVIDER_AUTH_ENV_KEYS.values() for key in keys})
)

ALL_OF_PROVIDERS: frozenset[str] = frozenset({"amazon-bedrock"})
"""Providers whose env credential is only usable when *every* key is present.

Bedrock needs an access-key id and its secret together; one alone authenticates
nothing. Every other provider offers alternatives — ``anthropic`` takes an API
key *or* an OAuth token, ``google`` four different ones — so any single key
satisfies it. This mirrors the rule
``atomic_pier.Atomic._provision_subscription_auth`` already applies when it
decides whether to forward environment auth.
"""

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


def submodule_worktree_head(path: str, *, repo_root: Path | None = None) -> str | None:
    """Return the SHA checked out *inside* the submodule, or ``None``.

    A bare ``(root / path / ".git").exists()`` probe is not enough: any file
    named ``.git`` passes it, and a plain ``git -C <path> rev-parse HEAD`` in an
    empty directory walks up and answers with the *superproject's* HEAD. So the
    repository's own toplevel must equal the submodule path before its HEAD is
    trusted.
    """
    root = repo_root or repository_root()
    target = root / path
    if not target.is_dir():
        return None
    toplevel = _run(["git", "rev-parse", "--show-toplevel"], cwd=target)
    if toplevel.returncode != 0:
        return None
    reported = toplevel.stdout.strip()
    if not reported:
        return None
    try:
        if Path(reported).resolve() != target.resolve():
            return None
    except OSError:
        return None
    head = _run(["git", "rev-parse", "HEAD"], cwd=target)
    if head.returncode != 0:
        return None
    return head.stdout.strip() or None


def is_submodule_initialized(path: str, *, repo_root: Path | None = None) -> bool:
    """True when ``path`` holds a real checked-out submodule working tree."""
    return submodule_worktree_head(path, repo_root=repo_root) is not None


def corpus_tasks_dir(repo_root: Path | None = None) -> Path:
    root = repo_root or repository_root()
    return root / DEEP_SWE_SUBMODULE_PATH / "tasks"


def _compose_files_under(directory: Path) -> list[str]:
    """Return every compose file under ``directory``, matched case-insensitively.

    ``Path.rglob`` is case-sensitive on Linux, so a task shipping
    ``Docker-Compose.YML`` slipped past the check while still being a compose
    file to Docker on a case-insensitive filesystem. This walks each entry once
    and filters on the lowercased basename, which returns exactly the same set
    as the issue's ``find -iname 'docker-compose.y*ml'`` and cannot double count
    the way a union of two globs would.
    """
    return sorted(
        str(path)
        for path in directory.rglob("*")
        if path.is_file() and fnmatch.fnmatchcase(path.name.lower(), _COMPOSE_GLOB)
    )


def check_corpus(
    tasks_dir: Path | None = None,
    *,
    expected_tasks: int = EXPECTED_TASK_COUNT,
    expected_collect_hooks: int | None = None,
    repo_root: Path | None = None,
) -> CheckResult:
    """Parse every ``task.toml`` and assert the corpus shape.

    Skips — never fails — when ``evals/deep-swe`` is *uninitialized*, because
    ``uv run pytest`` runs for contributors who never touch evals. Once it is
    initialized every shape problem **fails**, including a missing ``tasks/``
    directory: at that point the contributor has the corpus and it is wrong,
    which is exactly what the preflight exists to say.

    Initialization is decided first, and only from the submodule's own state. A
    checked-out corpus whose ``tasks/`` directory is absent used to short-circuit
    into the skip and report ``ok``, which is the loudest possible way to say
    nothing. An explicit ``tasks_dir`` counts as initialized: the caller pointed
    at a corpus, so its absence is a defect rather than a fresh clone.
    """
    tasks = tasks_dir or corpus_tasks_dir(repo_root)
    expected_hooks = expected_tasks if expected_collect_hooks is None else expected_collect_hooks
    initialized = tasks_dir is not None or is_submodule_initialized(
        DEEP_SWE_SUBMODULE_PATH, repo_root=repo_root
    )
    if not initialized:
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

    if not tasks.is_dir():
        return CheckResult(
            name="deep-swe corpus",
            status=FAILED,
            message=(
                f"deep-swe is initialized but its corpus directory is missing: {tasks} "
                f"does not exist. Expected the pinned corpus layout ({expected_tasks} "
                "tasks under tasks/<name>/task.toml)."
            ),
            details={"tasks_dir": str(tasks), "initialized": True},
        )

    task_files = sorted(tasks.glob("*/task.toml"))
    problems: list[str] = []
    collect_blocks = 0
    tasks_without_collect = 0
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
            # Count hooks, not tasks: two tasks carrying two hooks each is not
            # the same corpus as 113 tasks carrying one hook each.
            collect_blocks += len(collect)
        else:
            tasks_without_collect += 1
            problems.append(f"{task_file}: no [[verifier.collect]] hook")
        compose_files.extend(_compose_files_under(task_file.parent))

    if len(task_files) != expected_tasks:
        problems.append(f"expected {expected_tasks} tasks, found {len(task_files)}")
    if collect_blocks != expected_hooks:
        problems.append(
            f"expected {expected_hooks} [[verifier.collect]] hooks, found {collect_blocks}"
        )
    if compose_files:
        problems.append(f"expected 0 compose files, found {len(compose_files)}: {compose_files[:3]}")

    details: dict[str, object] = {
        "tasks": len(task_files),
        "collect_hooks": collect_blocks,
        "tasks_without_collect": tasks_without_collect,
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
            f"{len(task_files)} tasks, {collect_blocks} collect hooks, {len(compose_files)} compose files"
        ),
        details=details,
    )


def check_submodules(*, repo_root: Path | None = None) -> CheckResult:
    """Prove the gitlink pin and the checked-out working tree agree.

    ``FAILED`` when any submodule is checked out at a commit other than its
    pin — drift the run must not silently benchmark against. ``SKIPPED`` only
    when nothing drifted and a submodule is genuinely uninitialized, which is a
    fresh clone. Drift is evaluated **first**: a report that skipped on one
    uninitialized submodule used to swallow another submodule's drift, and a
    skip never makes ``PreflightReport.ok`` false.
    """
    root = repo_root or repository_root()
    details: dict[str, object] = {}
    missing: list[str] = []
    drifted: list[str] = []
    for path in (DEEP_SWE_SUBMODULE_PATH, PIER_SUBMODULE_PATH):
        pin = submodule_pin(path, repo_root=root)
        head = submodule_worktree_head(path, repo_root=root)
        details[path] = {"pin": pin, "head": head, "initialized": head is not None}
        if head is None:
            missing.append(path)
        elif pin is not None and head != pin:
            drifted.append(f"{path}: pinned {pin}, checked out {head}")
    if drifted:
        message = (
            "submodule working tree does not match its pin — "
            + "; ".join(drifted)
            + ". Run `git submodule update --init --recursive` to return to the pin."
        )
        if missing:
            # Keep the fresh-clone guidance in the same message rather than
            # losing it behind the failure.
            message += f" Also uninitialized: {', '.join(missing)}."
        return CheckResult(name="submodules", status=FAILED, message=message, details=details)
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
        message="evals/deep-swe and evals/vendor/pier match their pinned SHAs",
        details=details,
    )


def check_docker(runner: CommandRunner | None = None) -> CheckResult:
    """Check that a Docker daemon answers. Failure here is a real failure."""
    run = runner or _run
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


def is_valid_provider_auth(entry: object) -> bool:
    """True when an ``auth.json`` entry actually carries a usable credential.

    Mirrors ``atomic_pier.Atomic._is_valid_provider_auth``, which delegates
    here. A file existing is not a credential: ``{}`` has none, and an
    ``api_key`` entry with an empty ``key`` has none either.
    """
    if not isinstance(entry, dict):
        return False
    credential_type = entry.get("type")
    if credential_type == "api_key":
        key = entry.get("key")
        return isinstance(key, str) and bool(key)
    if credential_type == "oauth":
        access = entry.get("access")
        return isinstance(access, str) and bool(access)
    return False


def _valid_auth_providers(path: Path) -> list[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(payload, dict):
        return []
    return sorted(
        provider
        for provider, entry in payload.items()
        if isinstance(provider, str) and is_valid_provider_auth(entry)
    )


def provider_env_auth_satisfied(provider: str, environ: Mapping[str, str]) -> bool:
    """True when ``environ`` carries a usable credential for ``provider``.

    All-of for the providers in :data:`ALL_OF_PROVIDERS`, any-of otherwise. An
    empty key group can never be satisfied — ``all(())`` is ``True``, which would
    otherwise bless a provider that needs no credential at all.
    """
    keys = PROVIDER_AUTH_ENV_KEYS.get(provider, ())
    if not keys:
        return False
    present = [key for key in keys if (environ.get(key) or "").strip()]
    if provider in ALL_OF_PROVIDERS:
        return len(present) == len(keys)
    return bool(present)


def _missing_all_of_keys(provider: str, environ: Mapping[str, str]) -> tuple[str, ...]:
    """Keys an all-of provider still needs, when it is partially configured."""
    keys = PROVIDER_AUTH_ENV_KEYS.get(provider, ())
    present = [key for key in keys if (environ.get(key) or "").strip()]
    if not present or len(present) == len(keys):
        return ()
    return tuple(key for key in keys if key not in present)


def check_credentials(
    env: Mapping[str, str] | None = None,
    *,
    auth_paths: Sequence[Path] | None = None,
) -> CheckResult:
    """Check that at least one provider credential is actually reachable.

    A key alone is not a credential: ``amazon-bedrock`` needs both of its keys,
    so a lone ``AWS_ACCESS_KEY_ID`` authenticates nothing and must not pass.
    """
    environ = env if env is not None else os.environ
    present = [key for key in CREDENTIAL_ENV_KEYS if (environ.get(key) or "").strip()]
    satisfied = [
        provider
        for provider in sorted(PROVIDER_AUTH_ENV_KEYS)
        if provider_env_auth_satisfied(provider, environ)
    ]
    incomplete = {
        provider: missing
        for provider in sorted(ALL_OF_PROVIDERS)
        if (missing := _missing_all_of_keys(provider, environ))
    }
    paths = (
        list(auth_paths)
        if auth_paths is not None
        else [Path.home() / ".atomic" / "agent" / "auth.json", Path.home() / ".pi" / "agent" / "auth.json"]
    )
    subscriptions = {
        str(path): providers
        for path in paths
        if path.is_file() and (providers := _valid_auth_providers(path))
    }
    if not satisfied and not subscriptions:
        message = (
            "no provider credential found: none of "
            f"{', '.join(CREDENTIAL_ENV_KEYS)} is set and no local auth.json "
            "holds a valid api_key or oauth entry"
        )
        if incomplete:
            # Saying "none is set" would be false when half a Bedrock pair is
            # present, so name what is still missing instead.
            message += "; incomplete: " + "; ".join(
                f"{provider} also needs {', '.join(missing)}"
                for provider, missing in incomplete.items()
            )
        return CheckResult(
            name="credentials",
            status=FAILED,
            message=message,
            details={
                "env_keys": present,
                "providers": satisfied,
                "incomplete_providers": {p: list(m) for p, m in incomplete.items()},
            },
        )
    return CheckResult(
        name="credentials",
        status=OK,
        message=(
            f"{len(satisfied)} provider(s) from {len(present)} credential env var(s), "
            f"{len(subscriptions)} local subscription file(s) with a valid entry"
        ),
        details={
            "env_keys": present,
            "providers": satisfied,
            "incomplete_providers": {p: list(m) for p, m in incomplete.items()},
            "auth_files": subscriptions,
        },
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
