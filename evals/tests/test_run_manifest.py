"""S7 — run manifests and the refusal to compare incompatible runs."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pier.models.agent.context import AgentContext

from atomic_pier import Atomic
from prerequisites import DEEP_SWE_SUBMODULE_PATH, PIER_SUBMODULE_PATH, submodule_pin
from run_manifest import (
    COMPARABLE_FIELDS,
    MANIFEST_FILENAME,
    ManifestMismatchError,
    RunManifest,
    build_manifest,
    compare_manifests,
    job_identity,
    manifest_differences,
    manifest_for_agent_logs_dir,
    read_manifest,
    write_manifest,
)

REQUIRED_FIELDS = ("run_id", "seed", "model", "atomic_version", "deep_swe_sha", "pier_sha")


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

    assert set(payload) == set(REQUIRED_FIELDS)
    assert all(payload[field] is not None for field in REQUIRED_FIELDS)


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


def test_build_manifest_reads_both_submodule_gitlinks() -> None:
    manifest = build_manifest(run_id="r", seed=0, model="m", atomic_version="v")

    assert manifest.deep_swe_sha == submodule_pin(DEEP_SWE_SUBMODULE_PATH)
    assert manifest.pier_sha == submodule_pin(PIER_SUBMODULE_PATH)
    assert manifest.deep_swe_sha is not None
    assert manifest.pier_sha is not None
    assert manifest.deep_swe_sha != manifest.pier_sha


# --- job identity ------------------------------------------------------------


def test_job_identity_reads_the_id_and_seed(tmp_path: Path) -> None:
    job_dir = _job(tmp_path, seed=11)

    assert job_identity(job_dir) == ("job-uuid", 11)


def test_job_identity_falls_back_to_the_directory_name(tmp_path: Path) -> None:
    job_dir = _job(tmp_path, seed=None, job_id=None)

    assert job_identity(job_dir) == ("atomic-smoke", None)


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
    assert manifest.deep_swe_sha == submodule_pin(DEEP_SWE_SUBMODULE_PATH)
    assert manifest.pier_sha == submodule_pin(PIER_SUBMODULE_PATH)
    assert context.metadata is not None
    assert context.metadata["atomic_manifest"] == manifest.to_json()
