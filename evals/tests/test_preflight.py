"""S5 — corpus, submodule, and host preflight.

The preflight has to survive the state a fresh clone is actually in: both
submodules uninitialized. It must then *skip with a clear message* rather than
fail, because `uv run pytest` also runs for contributors who never touch evals.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from prerequisites import (
    DEEP_SWE_SUBMODULE_PATH,
    EXPECTED_TASK_COUNT,
    PIER_SUBMODULE_PATH,
    PreflightError,
    check_corpus,
    check_credentials,
    check_docker,
    check_submodules,
    is_submodule_initialized,
    repository_root,
    require_preflight,
    run_preflight,
    submodule_pin,
)

COLLECT_TASK = """
[metadata]
anything = "goes"

[[verifier.collect]]
command = "git diff > /logs/artifacts/model.patch"
timeout_sec = 300.0

[agent]
network_mode = "no-network"

[environment]
docker_image = "example/image:tag"
"""

NO_COLLECT_TASK = """
[agent]
network_mode = "no-network"

[environment]
docker_image = "example/image:tag"
"""


def _corpus(tmp_path: Path, tasks: dict[str, str]) -> Path:
    tasks_dir = tmp_path / "tasks"
    for name, body in tasks.items():
        task_dir = tasks_dir / name
        task_dir.mkdir(parents=True)
        (task_dir / "task.toml").write_text(body, encoding="utf-8")
    return tasks_dir


def _completed(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["docker"], returncode=returncode, stdout=stdout, stderr=stderr)


# --- corpus ------------------------------------------------------------------


def test_corpus_check_passes_for_a_well_formed_corpus(tmp_path: Path) -> None:
    tasks_dir = _corpus(tmp_path, {"alpha": COLLECT_TASK, "beta": COLLECT_TASK})

    result = check_corpus(tasks_dir, expected_tasks=2)

    assert result.ok, result.message
    assert result.details["tasks"] == 2
    assert result.details["collect_hooks"] == 2
    assert result.details["compose_files"] == 0


def test_corpus_check_fails_when_a_task_has_no_collect_hook(tmp_path: Path) -> None:
    tasks_dir = _corpus(tmp_path, {"alpha": COLLECT_TASK, "beta": NO_COLLECT_TASK})

    result = check_corpus(tasks_dir, expected_tasks=2)

    assert result.failed
    assert "no [[verifier.collect]] hook" in result.message
    assert result.details["collect_hooks"] == 1


def test_corpus_check_fails_on_a_wrong_task_count(tmp_path: Path) -> None:
    tasks_dir = _corpus(tmp_path, {"alpha": COLLECT_TASK})

    result = check_corpus(tasks_dir, expected_tasks=EXPECTED_TASK_COUNT)

    assert result.failed
    assert f"expected {EXPECTED_TASK_COUNT} tasks, found 1" in result.message


def test_corpus_check_fails_when_a_task_ships_a_compose_file(tmp_path: Path) -> None:
    tasks_dir = _corpus(tmp_path, {"alpha": COLLECT_TASK})
    (tasks_dir / "alpha" / "environment").mkdir()
    (tasks_dir / "alpha" / "environment" / "docker-compose.yaml").write_text("services: {}\n", encoding="utf-8")

    result = check_corpus(tasks_dir, expected_tasks=1)

    assert result.failed
    assert "expected 0 compose files, found 1" in result.message


def test_corpus_check_fails_on_malformed_toml(tmp_path: Path) -> None:
    tasks_dir = _corpus(tmp_path, {"alpha": "this is not = = toml\n"})

    result = check_corpus(tasks_dir, expected_tasks=1)

    assert result.failed
    assert "malformed TOML" in result.message


def test_corpus_check_skips_when_the_submodule_is_uninitialized(tmp_path: Path) -> None:
    empty = tmp_path / "deep-swe" / "tasks"

    result = check_corpus(empty)

    assert result.skipped
    assert not result.failed
    assert "not initialized" in result.message
    assert "git submodule update --init --recursive" in result.message


def test_corpus_check_skips_when_the_tasks_directory_exists_but_is_empty(tmp_path: Path) -> None:
    empty = tmp_path / "tasks"
    empty.mkdir()

    result = check_corpus(empty)

    assert result.skipped
    assert "git submodule update --init --recursive" in result.message


# --- submodules --------------------------------------------------------------


def test_submodule_pin_reads_the_gitlink_not_the_superproject_head() -> None:
    root = repository_root()
    pin = submodule_pin(DEEP_SWE_SUBMODULE_PATH, repo_root=root)
    superproject = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()

    assert pin is not None
    assert len(pin) == 40
    assert pin != superproject


def test_submodule_pin_is_none_for_an_unknown_path() -> None:
    assert submodule_pin("evals/does-not-exist") is None


def test_submodule_check_skips_when_a_submodule_is_uninitialized(tmp_path: Path) -> None:
    (tmp_path / DEEP_SWE_SUBMODULE_PATH).mkdir(parents=True)
    (tmp_path / PIER_SUBMODULE_PATH).mkdir(parents=True)

    result = check_submodules(repo_root=tmp_path)

    assert result.skipped
    assert "uninitialized submodule(s)" in result.message
    assert "git submodule update --init --recursive" in result.message


def test_is_submodule_initialized_reports_the_working_tree(tmp_path: Path) -> None:
    path = tmp_path / DEEP_SWE_SUBMODULE_PATH
    path.mkdir(parents=True)
    assert is_submodule_initialized(DEEP_SWE_SUBMODULE_PATH, repo_root=tmp_path) is False

    (path / ".git").write_text("gitdir: ../../.git/modules/evals/deep-swe\n", encoding="utf-8")
    assert is_submodule_initialized(DEEP_SWE_SUBMODULE_PATH, repo_root=tmp_path) is True


# --- host --------------------------------------------------------------------


def test_docker_check_reports_the_server_version() -> None:
    result = check_docker(lambda command: _completed(0, stdout="29.7.1\n"))

    assert result.ok
    assert result.details["server_version"] == "29.7.1"


def test_docker_check_fails_when_the_daemon_is_unreachable() -> None:
    result = check_docker(lambda command: _completed(1, stderr="Cannot connect to the Docker daemon"))

    assert result.failed
    assert "Cannot connect to the Docker daemon" in result.message


def test_docker_check_fails_when_docker_is_missing() -> None:
    def missing(command: object) -> subprocess.CompletedProcess[str]:
        raise FileNotFoundError(command)

    result = check_docker(missing)

    assert result.failed
    assert "not found on PATH" in result.message


def test_credentials_check_accepts_an_env_key(tmp_path: Path) -> None:
    result = check_credentials({"ANTHROPIC_API_KEY": "sk-x"}, auth_paths=[tmp_path / "missing.json"])

    assert result.ok
    assert result.details["env_keys"] == ["ANTHROPIC_API_KEY"]


def test_credentials_check_accepts_a_local_subscription_file(tmp_path: Path) -> None:
    auth = tmp_path / "auth.json"
    auth.write_text("{}", encoding="utf-8")

    result = check_credentials({}, auth_paths=[auth])

    assert result.ok
    assert result.details["auth_files"] == [str(auth)]


def test_credentials_check_fails_when_nothing_is_reachable(tmp_path: Path) -> None:
    result = check_credentials({}, auth_paths=[tmp_path / "missing.json"])

    assert result.failed
    assert "no provider credential found" in result.message


# --- aggregate ---------------------------------------------------------------


def test_run_preflight_skips_cleanly_on_a_fresh_clone(tmp_path: Path) -> None:
    (tmp_path / DEEP_SWE_SUBMODULE_PATH / "tasks").mkdir(parents=True)
    (tmp_path / PIER_SUBMODULE_PATH).mkdir(parents=True)

    report = run_preflight(repo_root=tmp_path, include_host_checks=False)

    assert report.ok
    assert len(report.skips) == 2
    assert "git submodule update --init --recursive" in report.describe()


def test_require_preflight_raises_with_the_failing_check(tmp_path: Path) -> None:
    tasks_dir = _corpus(tmp_path, {"alpha": NO_COLLECT_TASK})

    with pytest.raises(PreflightError) as excinfo:
        require_preflight(
            repo_root=tmp_path,
            tasks_dir=tasks_dir,
            expected_tasks=1,
            include_host_checks=False,
        )

    assert "no [[verifier.collect]] hook" in str(excinfo.value)
    assert excinfo.value.report.failures
