"""S5 — corpus, submodule, and host preflight.

The preflight has to survive the state a fresh clone is actually in: both
submodules uninitialized. It must then *skip with a clear message* rather than
fail, because `uv run pytest` also runs for contributors who never touch evals.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from prerequisites import (
    CREDENTIAL_ENV_KEYS,
    DEEP_SWE_SUBMODULE_PATH,
    EXPECTED_TASK_COUNT,
    PIER_SUBMODULE_PATH,
    PROVIDER_AUTH_ENV_KEYS,
    PreflightError,
    check_corpus,
    check_credentials,
    check_docker,
    check_submodules,
    is_submodule_initialized,
    is_valid_provider_auth,
    provider_env_auth_satisfied,
    repository_root,
    require_preflight,
    run_preflight,
    submodule_pin,
    submodule_worktree_head,
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


def test_corpus_check_counts_hooks_not_tasks(tmp_path: Path) -> None:
    """Two tasks carrying two hooks each is not a 2-hook corpus."""
    two_hooks = COLLECT_TASK + (
        '\n[[verifier.collect]]\ncommand = "echo second"\ntimeout_sec = 10.0\n'
    )
    tasks_dir = _corpus(tmp_path, {"alpha": two_hooks, "beta": two_hooks})

    result = check_corpus(tasks_dir, expected_tasks=2)

    assert result.failed
    assert result.details["collect_hooks"] == 4
    assert "expected 2 [[verifier.collect]] hooks, found 4" in result.message


def test_corpus_check_accepts_an_explicit_hook_expectation(tmp_path: Path) -> None:
    two_hooks = COLLECT_TASK + (
        '\n[[verifier.collect]]\ncommand = "echo second"\ntimeout_sec = 10.0\n'
    )
    tasks_dir = _corpus(tmp_path, {"alpha": two_hooks})

    result = check_corpus(tasks_dir, expected_tasks=1, expected_collect_hooks=2)

    assert result.ok, result.message
    assert result.details["collect_hooks"] == 2


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


@pytest.mark.parametrize(
    "name",
    ["docker-compose.yml", "docker-compose.yaml", "Docker-Compose.YML", "DOCKER-COMPOSE.YAML"],
)
def test_compose_detection_is_case_insensitive(tmp_path: Path, name: str) -> None:
    """`Path.rglob` is case-sensitive on Linux; Docker is not.

    A task shipping `Docker-Compose.YML` used to pass the check while still
    being a compose file on a case-insensitive filesystem.
    """
    tasks_dir = _corpus(tmp_path, {"alpha": COLLECT_TASK})
    (tasks_dir / "alpha" / "environment").mkdir()
    (tasks_dir / "alpha" / "environment" / name).write_text("services: {}\n", encoding="utf-8")

    result = check_corpus(tasks_dir, expected_tasks=1)

    assert result.failed
    assert result.details["compose_files"] == 1
    assert "expected 0 compose files, found 1" in result.message


def test_compose_detection_counts_each_file_once(tmp_path: Path) -> None:
    """Two distinct compose files count as two, never four."""
    tasks_dir = _corpus(tmp_path, {"alpha": COLLECT_TASK})
    environment = tasks_dir / "alpha" / "environment"
    environment.mkdir()
    (environment / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
    (environment / "Docker-Compose.YML").write_text("services: {}\n", encoding="utf-8")

    result = check_corpus(tasks_dir, expected_tasks=1)

    assert result.failed
    assert result.details["compose_files"] == 2


@pytest.mark.parametrize("name", ["docker-composeXyml", "notes.yml", "compose.yml"])
def test_non_compose_names_are_not_flagged(tmp_path: Path, name: str) -> None:
    """Match exactly what `find -iname 'docker-compose.y*ml'` matches."""
    tasks_dir = _corpus(tmp_path, {"alpha": COLLECT_TASK})
    (tasks_dir / "alpha" / "environment").mkdir()
    (tasks_dir / "alpha" / "environment" / name).write_text("x\n", encoding="utf-8")

    result = check_corpus(tasks_dir, expected_tasks=1)

    assert result.ok, result.message
    assert result.details["compose_files"] == 0


def test_corpus_check_fails_on_malformed_toml(tmp_path: Path) -> None:
    tasks_dir = _corpus(tmp_path, {"alpha": "this is not = = toml\n"})

    result = check_corpus(tasks_dir, expected_tasks=1)

    assert result.failed
    assert "malformed TOML" in result.message


def test_corpus_check_skips_when_the_submodule_is_uninitialized(tmp_path: Path) -> None:
    """The fresh-clone contract: nothing checked out under evals/deep-swe.

    The skip is tied to *the submodule* being uninitialized, so it is decided
    from the submodule's state rather than from whether a directory happens to
    be missing.
    """
    (tmp_path / DEEP_SWE_SUBMODULE_PATH / "tasks").mkdir(parents=True)

    result = check_corpus(repo_root=tmp_path)

    assert result.skipped
    assert not result.failed
    assert "not initialized" in result.message
    assert "git submodule update --init --recursive" in result.message


def test_corpus_check_skips_when_deep_swe_is_an_empty_directory(tmp_path: Path) -> None:
    """A fresh clone has evals/deep-swe present but empty — no tasks/ at all."""
    (tmp_path / DEEP_SWE_SUBMODULE_PATH).mkdir(parents=True)

    result = check_corpus(repo_root=tmp_path)

    assert result.skipped
    assert "not initialized" in result.message


def test_corpus_check_fails_when_an_initialized_corpus_has_no_tasks_directory(
    tmp_path: Path,
) -> None:
    """A checked-out corpus whose `tasks/` is missing must fail, not skip.

    This shape used to short-circuit into the skip — `not tasks.is_dir()` was
    evaluated before the initialization test — so `run_preflight().ok` stayed
    True for a corpus that could not possibly run.
    """
    submodule = tmp_path / DEEP_SWE_SUBMODULE_PATH
    submodule.mkdir(parents=True)
    (submodule / "README.md").write_text("no tasks here\n", encoding="utf-8")
    for command in (
        ["git", "init", "-q"],
        ["git", "add", "-A"],
        [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--no-gpg-sign",
            "-m",
            "seed",
        ],
    ):
        subprocess.run(command, cwd=submodule, capture_output=True, text=True, check=True)

    assert is_submodule_initialized(DEEP_SWE_SUBMODULE_PATH, repo_root=tmp_path) is True

    result = check_corpus(repo_root=tmp_path)

    assert result.failed
    assert not result.skipped
    assert "corpus directory is missing" in result.message
    assert "not initialized" not in result.message
    assert result.details["initialized"] is True

    report = run_preflight(repo_root=tmp_path, include_host_checks=False)
    assert not report.ok
    assert [check.name for check in report.failures] == ["deep-swe corpus"]


def test_corpus_check_fails_for_an_explicit_missing_tasks_dir(tmp_path: Path) -> None:
    """An explicit tasks_dir means the caller pointed at a corpus."""
    result = check_corpus(tmp_path / "nowhere")

    assert result.failed
    assert "corpus directory is missing" in result.message


def test_corpus_check_fails_when_the_corpus_is_present_but_empty(tmp_path: Path) -> None:
    """An initialized corpus with no tasks is a defect, not a fresh clone.

    The skip exists so a contributor who never ran `git submodule update` is
    not blocked. Once the directory is there, "0 tasks" is exactly the drift
    the preflight is supposed to report.
    """
    empty = tmp_path / "tasks"
    empty.mkdir()

    result = check_corpus(empty)

    assert result.failed
    assert not result.skipped
    assert f"expected {EXPECTED_TASK_COUNT} tasks, found 0" in result.message


def test_corpus_check_fails_for_a_real_initialized_but_empty_submodule(tmp_path: Path) -> None:
    """The default path, with a genuine git worktree checked out and no tasks."""
    submodule = tmp_path / DEEP_SWE_SUBMODULE_PATH
    (submodule / "tasks").mkdir(parents=True)
    for command in (
        ["git", "init", "-q"],
        [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--no-gpg-sign",
            "--allow-empty",
            "-m",
            "seed",
        ],
    ):
        subprocess.run(command, cwd=submodule, capture_output=True, text=True, check=True)

    assert is_submodule_initialized(DEEP_SWE_SUBMODULE_PATH, repo_root=tmp_path) is True

    result = check_corpus(repo_root=tmp_path)

    assert result.failed
    assert not result.skipped
    assert f"expected {EXPECTED_TASK_COUNT} tasks, found 0" in result.message


def test_the_real_corpus_matches_the_pinned_shape() -> None:
    """113 tasks, 113 collect hooks, 0 compose files — or a clear skip."""
    result = check_corpus()

    if result.skipped:
        pytest.skip(result.message)
    assert result.ok, result.message
    assert result.details["tasks"] == EXPECTED_TASK_COUNT
    assert result.details["collect_hooks"] == EXPECTED_TASK_COUNT
    assert result.details["compose_files"] == 0


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


def test_is_submodule_initialized_rejects_a_bare_dot_git_file(tmp_path: Path) -> None:
    """A file named `.git` is not a checked-out submodule."""
    path = tmp_path / DEEP_SWE_SUBMODULE_PATH
    path.mkdir(parents=True)
    assert is_submodule_initialized(DEEP_SWE_SUBMODULE_PATH, repo_root=tmp_path) is False

    (path / ".git").write_text("gitdir: ../../.git/modules/evals/deep-swe\n", encoding="utf-8")
    assert is_submodule_initialized(DEEP_SWE_SUBMODULE_PATH, repo_root=tmp_path) is False


def test_submodule_worktree_head_reads_the_checked_out_sha() -> None:
    head = submodule_worktree_head(DEEP_SWE_SUBMODULE_PATH)
    if head is None:
        pytest.skip("evals/deep-swe is not initialized")

    assert len(head) == 40
    assert head == submodule_pin(DEEP_SWE_SUBMODULE_PATH)


def test_submodule_worktree_head_does_not_walk_up_to_the_superproject(tmp_path: Path) -> None:
    """An empty directory inside a repository must not answer with its HEAD."""
    nested = repository_root() / "evals" / "tests"
    assert submodule_worktree_head("evals/tests") is None
    assert nested.is_dir()


def test_submodule_check_fails_when_a_worktree_drifts_from_its_pin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pinned = "a" * 40
    drifted = "b" * 40

    monkeypatch.setattr(
        "prerequisites.submodule_pin", lambda path, *, repo_root=None: pinned
    )
    monkeypatch.setattr(
        "prerequisites.submodule_worktree_head",
        lambda path, *, repo_root=None: drifted if path == DEEP_SWE_SUBMODULE_PATH else pinned,
    )

    result = check_submodules(repo_root=tmp_path)

    assert result.failed
    assert DEEP_SWE_SUBMODULE_PATH in result.message
    assert pinned in result.message
    assert drifted in result.message


def test_drift_is_reported_even_when_another_submodule_is_uninitialized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A skip must not swallow a drift, because a skip keeps the report `ok`.

    deep-swe uninitialized (a fresh clone) plus a pier worktree sitting off its
    pin used to report `skipped`, and `run_preflight(...).ok` stayed True.
    """
    pinned = "a" * 40
    drifted = "b" * 40

    monkeypatch.setattr("prerequisites.submodule_pin", lambda path, *, repo_root=None: pinned)
    monkeypatch.setattr(
        "prerequisites.submodule_worktree_head",
        lambda path, *, repo_root=None: None if path == DEEP_SWE_SUBMODULE_PATH else drifted,
    )

    result = check_submodules(repo_root=tmp_path)

    assert result.failed
    assert not result.skipped
    assert PIER_SUBMODULE_PATH in result.message
    assert pinned in result.message
    assert drifted in result.message
    # The fresh-clone guidance must survive inside the failure message.
    assert DEEP_SWE_SUBMODULE_PATH in result.message
    assert "git submodule update --init --recursive" in result.message


def test_a_hidden_drift_makes_the_whole_preflight_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("prerequisites.submodule_pin", lambda path, *, repo_root=None: "a" * 40)
    monkeypatch.setattr(
        "prerequisites.submodule_worktree_head",
        lambda path, *, repo_root=None: None if path == DEEP_SWE_SUBMODULE_PATH else "b" * 40,
    )

    report = run_preflight(repo_root=tmp_path, include_host_checks=False)

    assert not report.ok
    assert [check.name for check in report.failures] == ["submodules"]


def test_submodule_check_passes_for_this_checkout() -> None:
    result = check_submodules()

    if result.skipped:
        pytest.skip(result.message)
    assert result.ok, result.message
    details = result.details[DEEP_SWE_SUBMODULE_PATH]
    assert isinstance(details, dict)
    assert details["head"] == details["pin"]


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


@pytest.mark.parametrize(
    "env_key",
    ["ANTHROPIC_API_KEY", "KIMI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "ZAI_API_KEY"],
)
def test_credentials_check_accepts_any_supported_provider_env_key(
    tmp_path: Path, env_key: str
) -> None:
    """The preflight must know every provider the adapter forwards, not five keys."""
    result = check_credentials({env_key: "sk-x"}, auth_paths=[tmp_path / "missing.json"])

    assert result.ok, result.message
    assert result.details["env_keys"] == [env_key]


@pytest.mark.parametrize(
    "env_key", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
)
def test_half_a_bedrock_credential_is_not_a_credential(tmp_path: Path, env_key: str) -> None:
    """Bedrock needs both keys; one alone authenticates nothing.

    The flattened any-of check blessed a run that could not authenticate.
    """
    result = check_credentials({env_key: "value"}, auth_paths=[tmp_path / "missing.json"])

    assert result.failed
    assert result.details["providers"] == []
    # The message must name what is still missing rather than claim nothing is set.
    assert "amazon-bedrock also needs" in result.message
    companion = {
        "AWS_ACCESS_KEY_ID": "AWS_SECRET_ACCESS_KEY",
        "AWS_SECRET_ACCESS_KEY": "AWS_ACCESS_KEY_ID",
    }[env_key]
    assert companion in result.message


def test_a_complete_bedrock_credential_passes(tmp_path: Path) -> None:
    result = check_credentials(
        {"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "secret"},
        auth_paths=[tmp_path / "missing.json"],
    )

    assert result.ok, result.message
    assert result.details["providers"] == ["amazon-bedrock"]
    assert result.details["incomplete_providers"] == {}


def test_a_partial_all_of_provider_does_not_block_a_complete_one(tmp_path: Path) -> None:
    result = check_credentials(
        {"AWS_ACCESS_KEY_ID": "id", "KIMI_API_KEY": "sk-x"},
        auth_paths=[tmp_path / "missing.json"],
    )

    assert result.ok, result.message
    assert result.details["providers"] == ["kimi-coding"]


@pytest.mark.parametrize(
    ("provider", "environ", "expected"),
    [
        ("amazon-bedrock", {"AWS_ACCESS_KEY_ID": "id"}, False),
        ("amazon-bedrock", {"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "s"}, True),
        ("anthropic", {"ANTHROPIC_API_KEY": "sk"}, True),
        ("anthropic", {"ANTHROPIC_OAUTH_TOKEN": "tok"}, True),
        ("google", {"GOOGLE_APPLICATION_CREDENTIALS": "/path"}, True),
        ("anthropic", {"ANTHROPIC_API_KEY": "   "}, False),
        ("unknown-provider", {"ANYTHING": "x"}, False),
    ],
)
def test_provider_env_auth_satisfied(provider: str, environ: dict[str, str], expected: bool) -> None:
    assert provider_env_auth_satisfied(provider, environ) is expected


def test_an_empty_key_group_is_never_satisfied(monkeypatch: pytest.MonkeyPatch) -> None:
    """`all(())` is True, which would bless a provider needing no credential."""
    monkeypatch.setitem(PROVIDER_AUTH_ENV_KEYS, "empty-group", ())
    monkeypatch.setattr(
        "prerequisites.ALL_OF_PROVIDERS", frozenset({"amazon-bedrock", "empty-group"})
    )

    assert provider_env_auth_satisfied("empty-group", {}) is False


def test_every_adapter_provider_key_is_known_to_the_preflight() -> None:
    for keys in PROVIDER_AUTH_ENV_KEYS.values():
        for key in keys:
            assert key in CREDENTIAL_ENV_KEYS


def test_credentials_check_accepts_a_local_subscription_file(tmp_path: Path) -> None:
    auth = tmp_path / "auth.json"
    auth.write_text(
        json.dumps({"anthropic": {"type": "oauth", "access": "token"}}), encoding="utf-8"
    )

    result = check_credentials({}, auth_paths=[auth])

    assert result.ok
    assert result.details["auth_files"] == {str(auth): ["anthropic"]}


def test_credentials_check_rejects_an_empty_auth_file(tmp_path: Path) -> None:
    """A file existing is not a credential."""
    auth = tmp_path / "auth.json"
    auth.write_text("{}", encoding="utf-8")

    result = check_credentials({}, auth_paths=[auth])

    assert result.failed
    assert "no provider credential found" in result.message


@pytest.mark.parametrize(
    "entry",
    [
        {"type": "api_key", "key": ""},
        {"type": "oauth", "access": ""},
        {"type": "unknown", "key": "x"},
        "not-an-object",
    ],
)
def test_credentials_check_rejects_an_unusable_auth_entry(tmp_path: Path, entry: object) -> None:
    auth = tmp_path / "auth.json"
    auth.write_text(json.dumps({"anthropic": entry}), encoding="utf-8")

    result = check_credentials({}, auth_paths=[auth])

    assert result.failed
    assert is_valid_provider_auth(entry) is False


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
