"""S7 — run manifests and the refusal to compare incompatible runs."""

from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest
from pier.models.agent.context import AgentContext

from atomic_pier import Atomic
from prerequisites import (
    DEEP_SWE_SUBMODULE_PATH,
    PIER_SUBMODULE_PATH,
    submodule_pin,
    submodule_worktree_head,
)
from run_manifest import (
    COMPARABLE_FIELDS,
    MANIFEST_FILENAME,
    REQUIRED_FIELDS,
    IncompleteManifestError,
    ManifestMismatchError,
    RunManifest,
    build_manifest,
    compare_manifests,
    job_identity,
    manifest_differences,
    manifest_for_agent_logs_dir,
    missing_fields,
    read_manifest,
    write_manifest,
)

MANIFEST_FIELD_NAMES = ("run_id", "seed", "model", "atomic_version", "deep_swe_sha", "pier_sha")


def _job(tmp_path: Path, *, seed: int | None = 0, job_id: str | None = "job-uuid") -> Path:
    job_dir = tmp_path / "jobs" / "atomic-smoke"
    job_dir.mkdir(parents=True)
    config: dict[str, object] = {"job_name": "atomic-smoke"}
    if seed is not None:
        config["sample_seed"] = seed
    (job_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")
    if job_id is not None:
        (job_dir / "result.json").write_text(json.dumps({"id": job_id}), encoding="utf-8")
    return job_dir


# --- shape -------------------------------------------------------------------


def test_manifest_carries_every_required_field() -> None:
    manifest = RunManifest(
        run_id="r", seed=0, model="anthropic/opus", atomic_version="0.9.3", deep_swe_sha="a" * 40, pier_sha="b" * 40
    )

    payload = manifest.to_json()

    assert set(payload) == set(MANIFEST_FIELD_NAMES)
    assert set(REQUIRED_FIELDS) == set(MANIFEST_FIELD_NAMES)
    assert all(payload[field] is not None for field in MANIFEST_FIELD_NAMES)


def test_manifest_round_trips_through_json(tmp_path: Path) -> None:
    manifest = RunManifest(run_id="r", seed=7, model="m", atomic_version="v", deep_swe_sha="a", pier_sha="b")

    path = write_manifest(tmp_path, manifest)

    assert path is not None
    assert path == tmp_path / MANIFEST_FILENAME
    assert read_manifest(tmp_path) == manifest
    assert read_manifest(path) == manifest


def test_read_manifest_is_none_when_absent_or_corrupt(tmp_path: Path) -> None:
    assert read_manifest(tmp_path) is None
    (tmp_path / MANIFEST_FILENAME).write_text("{not json", encoding="utf-8")
    assert read_manifest(tmp_path) is None


def test_build_manifest_reads_the_revisions_that_ran() -> None:
    """Proves the worktree-head preference, so it needs an initialized corpus.

    Comparing against the fallback in a fresh clone would make it vacuous.
    """
    head = submodule_worktree_head(DEEP_SWE_SUBMODULE_PATH)
    if head is None:
        pytest.skip("evals/deep-swe is not initialized")

    manifest = build_manifest(run_id="r", seed=0, model="m", atomic_version="v")

    assert manifest.deep_swe_sha == head
    assert manifest.pier_sha == submodule_worktree_head(PIER_SUBMODULE_PATH)
    assert manifest.deep_swe_sha is not None
    assert manifest.pier_sha is not None
    assert manifest.deep_swe_sha != manifest.pier_sha


def test_manifest_records_the_checked_out_revision_not_the_pin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A number produced by a drifted working tree was not produced by the pin.

    Preflight already fails on drift; the manifest must still say which code
    ran, or two runs on different pier code compare as equal.
    """
    ran = "d" * 40
    pinned = "a" * 40
    monkeypatch.setattr(
        "run_manifest.submodule_worktree_head", lambda path, *, repo_root=None: ran
    )
    monkeypatch.setattr("run_manifest.submodule_pin", lambda path, *, repo_root=None: pinned)

    manifest = build_manifest(run_id="r", seed=0, model="m", atomic_version="v")

    assert manifest.deep_swe_sha == ran
    assert manifest.pier_sha == ran


def test_manifest_falls_back_to_the_gitlink_when_uninitialized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`submodule_worktree_head` answers None rather than the superproject SHA."""
    pinned = "a" * 40
    monkeypatch.setattr(
        "run_manifest.submodule_worktree_head", lambda path, *, repo_root=None: None
    )
    monkeypatch.setattr("run_manifest.submodule_pin", lambda path, *, repo_root=None: pinned)

    manifest = build_manifest(run_id="r", seed=0, model="m", atomic_version="v")

    assert manifest.deep_swe_sha == pinned
    assert manifest.pier_sha == pinned


def test_two_runs_on_different_pier_code_do_not_compare_equal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("run_manifest.submodule_pin", lambda path, *, repo_root=None: "a" * 40)

    monkeypatch.setattr(
        "run_manifest.submodule_worktree_head", lambda path, *, repo_root=None: "a" * 40
    )
    pinned_run = build_manifest(run_id="r1", seed=0, model="m", atomic_version="v")

    monkeypatch.setattr(
        "run_manifest.submodule_worktree_head", lambda path, *, repo_root=None: "d" * 40
    )
    drifted_run = build_manifest(run_id="r2", seed=0, model="m", atomic_version="v")

    with pytest.raises(ManifestMismatchError) as excinfo:
        compare_manifests(pinned_run, drifted_run)

    assert {difference[0] for difference in excinfo.value.differences} == {
        "deep_swe_sha",
        "pier_sha",
    }


def test_a_clean_checkout_records_the_pin() -> None:
    """head == pin in a clean checkout, so nothing about repeatability changes."""
    if submodule_worktree_head(DEEP_SWE_SUBMODULE_PATH) is None:
        pytest.skip("evals/deep-swe is not initialized")

    manifest = build_manifest(run_id="r", seed=0, model="m", atomic_version="v")

    assert manifest.deep_swe_sha == submodule_pin(DEEP_SWE_SUBMODULE_PATH)
    assert manifest.pier_sha == submodule_pin(PIER_SUBMODULE_PATH)


# --- job identity ------------------------------------------------------------


def test_job_identity_reads_the_id_and_seed(tmp_path: Path) -> None:
    job_dir = _job(tmp_path, seed=11)

    assert job_identity(job_dir) == ("job-uuid", 11)


def test_job_identity_falls_back_to_the_directory_name(tmp_path: Path) -> None:
    job_dir = _job(tmp_path, seed=None, job_id=None)

    assert job_identity(job_dir) == ("atomic-smoke", None)


def test_job_identity_reads_the_seed_from_a_dataset_entry(tmp_path: Path) -> None:
    """Pier writes sample_seed on the dataset entry, not at the top level."""
    job_dir = tmp_path / "jobs" / "atomic-smoke"
    job_dir.mkdir(parents=True)
    (job_dir / "config.json").write_text(
        json.dumps({"job_name": "atomic-smoke", "datasets": [{"path": "deep-swe/tasks", "sample_seed": 0}]}),
        encoding="utf-8",
    )
    (job_dir / "result.json").write_text(json.dumps({"id": "job-uuid"}), encoding="utf-8")

    assert job_identity(job_dir) == ("job-uuid", 0)


def test_manifest_for_agent_logs_dir_derives_run_id_and_seed(tmp_path: Path) -> None:
    job_dir = _job(tmp_path, seed=3)
    logs_dir = job_dir / "trial-1" / "agent"
    logs_dir.mkdir(parents=True)

    manifest = manifest_for_agent_logs_dir(logs_dir, model="anthropic/opus", atomic_version="0.9.3")

    assert manifest.run_id == "job-uuid/trial-1"
    assert manifest.seed == 3
    assert manifest.model == "anthropic/opus"
    assert manifest.atomic_version == "0.9.3"


# --- comparison --------------------------------------------------------------


def _base() -> RunManifest:
    return RunManifest(
        run_id="run-a", seed=0, model="anthropic/opus", atomic_version="0.9.3", deep_swe_sha="a" * 40, pier_sha="b" * 40
    )


def test_two_identical_runs_compare_cleanly() -> None:
    compare_manifests(_base(), _base())


def test_a_differing_run_id_alone_does_not_block_comparison() -> None:
    other = RunManifest(**{**_base().to_json(), "run_id": "run-b"})  # pyright: ignore[reportArgumentType]

    compare_manifests(_base(), other)
    assert "run_id" not in COMPARABLE_FIELDS


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("model", "openai/gpt"),
        ("seed", 1),
        ("atomic_version", "0.9.4"),
        ("deep_swe_sha", "c" * 40),
        ("pier_sha", "d" * 40),
    ],
)
def test_incompatible_manifests_are_refused(field: str, value: object) -> None:
    other = RunManifest(**{**_base().to_json(), field: value})  # pyright: ignore[reportArgumentType]

    with pytest.raises(ManifestMismatchError) as excinfo:
        compare_manifests(_base(), other)

    assert field in str(excinfo.value)
    assert "Refusing to compare" in str(excinfo.value)
    assert [difference[0] for difference in excinfo.value.differences] == [field]


def test_manifest_differences_lists_every_offending_field() -> None:
    other = RunManifest(**{**_base().to_json(), "model": "openai/gpt", "seed": 5})  # pyright: ignore[reportArgumentType]

    differences = manifest_differences(_base(), other)

    assert {difference[0] for difference in differences} == {"model", "seed"}


def test_a_missing_corpus_sha_is_not_silently_compatible() -> None:
    other = RunManifest(**{**_base().to_json(), "deep_swe_sha": None})  # pyright: ignore[reportArgumentType]

    with pytest.raises(ManifestMismatchError):
        compare_manifests(_base(), other)


def test_comparison_cannot_be_narrowed_away() -> None:
    """`fields=()` used to make two wholly different runs compare clean.

    The decision function takes no narrowing argument at all; narrowed diffs
    stay available from `manifest_differences`, which reports rather than
    decides.
    """
    other = RunManifest(
        run_id="run-b",
        seed=9,
        model="openai/gpt",
        atomic_version="9.9.9",
        deep_swe_sha="c" * 40,
        pier_sha="d" * 40,
    )

    assert "fields" not in inspect.signature(compare_manifests).parameters

    with pytest.raises(TypeError):
        compare_manifests(_base(), other, fields=())  # pyright: ignore[reportCallIssue]

    with pytest.raises(ManifestMismatchError) as excinfo:
        compare_manifests(_base(), other)

    assert {difference[0] for difference in excinfo.value.differences} == set(COMPARABLE_FIELDS)


def test_manifest_differences_still_accepts_a_narrowed_field_list() -> None:
    """The diagnostic helper keeps its `fields` keyword."""
    other = RunManifest(**{**_base().to_json(), "model": "openai/gpt"})  # pyright: ignore[reportArgumentType]

    assert manifest_differences(_base(), other, fields=()) == ()
    assert [d[0] for d in manifest_differences(_base(), other, fields=("model",))] == ["model"]


# --- completeness ------------------------------------------------------------


def test_two_empty_manifests_are_refused_not_accepted() -> None:
    """The defect: `RunManifest.from_json({})` compared equal to itself."""
    empty = RunManifest.from_json({})
    assert empty is not None

    with pytest.raises(IncompleteManifestError) as excinfo:
        compare_manifests(empty, empty)

    assert "incomplete" in str(excinfo.value)
    for field in REQUIRED_FIELDS:
        assert field in str(excinfo.value)


def test_missing_fields_names_every_absent_field() -> None:
    assert missing_fields(_base()) == ()
    assert missing_fields(RunManifest()) == REQUIRED_FIELDS
    partial = RunManifest(**{**_base().to_json(), "pier_sha": None})  # pyright: ignore[reportArgumentType]
    assert missing_fields(partial) == ("pier_sha",)


@pytest.mark.parametrize("field", REQUIRED_FIELDS)
def test_an_incomplete_manifest_is_refused_naming_the_field(field: str) -> None:
    partial = RunManifest(**{**_base().to_json(), field: None})  # pyright: ignore[reportArgumentType]

    with pytest.raises(IncompleteManifestError) as excinfo:
        compare_manifests(_base(), partial)

    assert field in str(excinfo.value)
    assert excinfo.value.side == "right"
    assert excinfo.value.fields == (field,)


def test_incomplete_manifest_error_is_a_mismatch_error() -> None:
    """A caller that already refuses mismatches refuses incompleteness too."""
    assert issubclass(IncompleteManifestError, ManifestMismatchError)


def test_the_documented_comparison_command_refuses_instead_of_crashing(tmp_path: Path) -> None:
    """evals/README.md compares two directories; neither has a manifest here."""
    left = tmp_path / "run-a"
    right = tmp_path / "run-b"
    left.mkdir()
    right.mkdir()

    assert read_manifest(left) is None

    with pytest.raises(IncompleteManifestError) as excinfo:
        compare_manifests(read_manifest(left), read_manifest(right))

    assert excinfo.value.side == "left"


def test_a_seedless_harbor_style_manifest_is_refused_naming_seed() -> None:
    """Harbor has no seed at all, so two Harbor runs cannot prove seed equality."""
    harbor_like = RunManifest(**{**_base().to_json(), "seed": None})  # pyright: ignore[reportArgumentType]

    with pytest.raises(IncompleteManifestError) as excinfo:
        compare_manifests(harbor_like, harbor_like)

    assert excinfo.value.fields == ("seed",)


# --- adapter integration -----------------------------------------------------


def test_adapter_writes_a_manifest_next_to_the_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_dir = _job(tmp_path, seed=0)
    logs_dir = job_dir / "trial-1" / "agent"
    logs_dir.mkdir(parents=True)
    auth_path = tmp_path / "auth.json"
    monkeypatch.setattr(Atomic, "_auth_config_paths", staticmethod(lambda: (auth_path,)))
    agent = Atomic(logs_dir=logs_dir, model_name="anthropic/claude-opus-4-6", version="0.9.3")
    context = AgentContext()

    agent.populate_context_post_run(context)

    manifest = read_manifest(logs_dir)
    assert manifest is not None
    assert manifest.model == "anthropic/claude-opus-4-6"
    assert manifest.atomic_version == "0.9.3"
    assert manifest.seed == 0
    assert manifest.run_id == "job-uuid/trial-1"
    # The adapter's job is to write a six-field manifest; which SHA source
    # answered is proven elsewhere, so assert the same fallback it uses — this
    # keeps the coverage in a fresh clone.
    assert manifest.deep_swe_sha == (
        submodule_worktree_head(DEEP_SWE_SUBMODULE_PATH) or submodule_pin(DEEP_SWE_SUBMODULE_PATH)
    )
    assert manifest.pier_sha == (
        submodule_worktree_head(PIER_SUBMODULE_PATH) or submodule_pin(PIER_SUBMODULE_PATH)
    )
    assert context.metadata is not None
    assert context.metadata["atomic_manifest"] == manifest.to_json()


# --- what actually ran (round 5) ---------------------------------------------


def _agent_with_logs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **kwargs: object) -> Atomic:
    job_dir = _job(tmp_path, seed=0)
    logs_dir = job_dir / "trial-1" / "agent"
    logs_dir.mkdir(parents=True)
    auth_path = tmp_path / "auth.json"
    monkeypatch.setattr(Atomic, "_auth_config_paths", staticmethod(lambda: (auth_path,)))
    return Atomic(logs_dir=logs_dir, **kwargs)  # pyright: ignore[reportArgumentType]


def _assistant_event(provider: str, model: str) -> str:
    return json.dumps(
        {
            "type": "message_end",
            "message": {"role": "assistant", "provider": provider, "model": model},
        }
    )


def test_the_manifest_records_the_model_that_answered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The requested model is not always the one that ran.

    Atomic falls back across providers, and every assistant message records the
    provider and model that produced it.
    """
    agent = _agent_with_logs(
        tmp_path, monkeypatch, model_name="openai-codex/gpt-5.6-sol", version="0.9.3"
    )
    (agent.logs_dir / "atomic.txt").write_text(
        _assistant_event("openai-codex", "gpt-5.6-sol")
        + "\n"
        + _assistant_event("openrouter", "openai/gpt-5.6-sol")
        + "\n",
        encoding="utf-8",
    )

    agent.populate_context_post_run(AgentContext())

    manifest = read_manifest(agent.logs_dir)
    assert manifest is not None
    # The last answering candidate, not the requested one.
    assert manifest.model == "openrouter/openai/gpt-5.6-sol"


def test_the_manifest_falls_back_to_the_launched_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No observed message — e.g. a cancelled run — so use what was selected."""
    agent = _agent_with_logs(
        tmp_path, monkeypatch, model_name="openai-codex/gpt-5.6-sol", version="0.9.3"
    )
    agent._selected_model = "openai/gpt-5.6-sol"

    agent.populate_context_post_run(AgentContext())

    manifest = read_manifest(agent.logs_dir)
    assert manifest is not None
    assert manifest.model == "openai/gpt-5.6-sol"


def test_the_manifest_falls_back_to_the_requested_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent_with_logs(
        tmp_path, monkeypatch, model_name="anthropic/claude-opus-4-6", version="0.9.3"
    )

    agent.populate_context_post_run(AgentContext())

    manifest = read_manifest(agent.logs_dir)
    assert manifest is not None
    assert manifest.model == "anthropic/claude-opus-4-6"


def test_the_manifest_records_the_resolved_version_over_a_moving_tag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`version=next` is a moving tag; two runs of different builds must differ."""
    agent = _agent_with_logs(
        tmp_path, monkeypatch, model_name="anthropic/opus", version="next"
    )
    agent._resolved_version = "0.9.14-alpha.1"

    agent.populate_context_post_run(AgentContext())

    manifest = read_manifest(agent.logs_dir)
    assert manifest is not None
    assert manifest.atomic_version == "0.9.14-alpha.1"
    # The requested spec is untouched: install_spec() interpolates it.
    assert agent.version() == "next"


def test_two_builds_of_a_moving_tag_do_not_compare_equal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = build_manifest(run_id="a", seed=0, model="m", atomic_version="0.9.14-alpha.1")
    second = build_manifest(run_id="b", seed=0, model="m", atomic_version="0.9.15-alpha.1")

    with pytest.raises(ManifestMismatchError) as excinfo:
        compare_manifests(first, second)

    assert [d[0] for d in excinfo.value.differences] == ["atomic_version"]


def test_setup_resolves_the_installed_version_in_the_container(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pier auto-detects only when no version was requested, so `next` sticks.

    The adapter asks the container itself after install.
    """
    import asyncio
    from types import SimpleNamespace

    agent = _agent_with_logs(tmp_path, monkeypatch, model_name="anthropic/opus", version="next")

    executed: list[str] = []

    class _Environment:
        async def exec(self, command: str, **_: object) -> object:
            executed.append(command)
            return SimpleNamespace(return_code=0, stdout="0.9.14-alpha.1\n")

    async def _noop_setup(self: object, environment: object) -> None:
        return None

    monkeypatch.setattr(
        "pier.agents.installed.base.BaseInstalledAgent.setup", _noop_setup, raising=True
    )

    asyncio.run(agent.setup(_Environment()))  # pyright: ignore[reportArgumentType]

    assert agent._resolved_version == "0.9.14-alpha.1"
    assert agent.version() == "next"
    assert any("atomic --version" in command for command in executed)


def test_setup_leaves_the_version_unresolved_when_the_probe_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    agent = _agent_with_logs(tmp_path, monkeypatch, model_name="anthropic/opus", version="next")

    class _Environment:
        async def exec(self, command: str, **_: object) -> object:
            raise RuntimeError("container gone")

    async def _noop_setup(self: object, environment: object) -> None:
        return None

    monkeypatch.setattr(
        "pier.agents.installed.base.BaseInstalledAgent.setup", _noop_setup, raising=True
    )

    asyncio.run(agent.setup(_Environment()))  # pyright: ignore[reportArgumentType]

    assert agent._resolved_version is None
    agent.populate_context_post_run(AgentContext())
    manifest = read_manifest(agent.logs_dir)
    assert manifest is not None
    assert manifest.atomic_version == "next"
