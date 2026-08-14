"""S7 — the run manifest.

Two Deep SWE runs used to be indistinguishable after the fact: nothing recorded
which corpus, which pier, which Atomic build, which model, or which seed
produced a number. The manifest records all six, and :func:`compare_manifests`
refuses to compare two runs that did not share them.

The submodule SHAs come from the superproject's gitlink
(``git rev-parse HEAD:evals/deep-swe``). ``git -C evals/deep-swe rev-parse HEAD``
is not equivalent: in an uninitialized submodule it silently prints the
*superproject* SHA, which would record a wrong corpus with no error.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from prerequisites import DEEP_SWE_SUBMODULE_PATH, PIER_SUBMODULE_PATH, submodule_pin

MANIFEST_FILENAME = "atomic-manifest.json"

COMPARABLE_FIELDS: tuple[str, ...] = (
    "model",
    "seed",
    "atomic_version",
    "deep_swe_sha",
    "pier_sha",
)
"""Fields two runs must share to be comparable. ``run_id`` differs by design."""


@dataclass(frozen=True)
class RunManifest:
    """Everything needed to say whether two runs measured the same thing."""

    run_id: str | None = None
    seed: int | None = None
    model: str | None = None
    atomic_version: str | None = None
    deep_swe_sha: str | None = None
    pier_sha: str | None = None

    def to_json(self) -> dict[str, object]:
        return {
            "run_id": self.run_id,
            "seed": self.seed,
            "model": self.model,
            "atomic_version": self.atomic_version,
            "deep_swe_sha": self.deep_swe_sha,
            "pier_sha": self.pier_sha,
        }

    @classmethod
    def from_json(cls, payload: object) -> RunManifest | None:
        if not isinstance(payload, dict):
            return None
        seed = payload.get("seed")
        return cls(
            run_id=_as_str(payload.get("run_id")),
            seed=seed if isinstance(seed, int) and not isinstance(seed, bool) else None,
            model=_as_str(payload.get("model")),
            atomic_version=_as_str(payload.get("atomic_version")),
            deep_swe_sha=_as_str(payload.get("deep_swe_sha")),
            pier_sha=_as_str(payload.get("pier_sha")),
        )


class ManifestMismatchError(RuntimeError):
    """Raised when two run manifests describe incompatible runs."""

    def __init__(self, differences: Sequence[tuple[str, object, object]]) -> None:
        self.differences = tuple(differences)
        rendered = "; ".join(f"{field}: {left!r} != {right!r}" for field, left, right in differences)
        super().__init__(
            "Refusing to compare runs recorded under different conditions — " + rendered
        )


def _as_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def build_manifest(
    *,
    run_id: str | None = None,
    seed: int | None = None,
    model: str | None = None,
    atomic_version: str | None = None,
    repo_root: Path | None = None,
) -> RunManifest:
    """Build a manifest, reading both submodule SHAs from the gitlinks."""
    return RunManifest(
        run_id=run_id,
        seed=seed,
        model=model,
        atomic_version=atomic_version,
        deep_swe_sha=submodule_pin(DEEP_SWE_SUBMODULE_PATH, repo_root=repo_root),
        pier_sha=submodule_pin(PIER_SUBMODULE_PATH, repo_root=repo_root),
    )


def job_identity(job_dir: Path) -> tuple[str | None, int | None]:
    """Return ``(run_id, seed)`` read from a pier job directory.

    ``run_id`` prefers the job's recorded UUID and falls back to the job
    directory name; ``seed`` is the job config's ``sample_seed``.
    """
    run_id: str | None = None
    result = _read_json(job_dir / "result.json")
    if isinstance(result, dict):
        run_id = _as_str(result.get("id"))
    if run_id is None and job_dir.name:
        run_id = job_dir.name

    seed: int | None = None
    config = _read_json(job_dir / "config.json")
    if isinstance(config, dict):
        candidate = config.get("sample_seed")
        if isinstance(candidate, int) and not isinstance(candidate, bool):
            seed = candidate
    return run_id, seed


def manifest_for_agent_logs_dir(
    logs_dir: Path,
    *,
    model: str | None,
    atomic_version: str | None,
    repo_root: Path | None = None,
) -> RunManifest:
    """Build a manifest for an agent whose ``logs_dir`` is ``<trial>/agent``."""
    trial_dir = logs_dir.parent
    run_id, seed = job_identity(trial_dir.parent)
    if run_id is not None and trial_dir.name:
        run_id = f"{run_id}/{trial_dir.name}"
    return build_manifest(
        run_id=run_id,
        seed=seed,
        model=model,
        atomic_version=atomic_version,
        repo_root=repo_root,
    )


def write_manifest(directory: Path, manifest: RunManifest) -> Path | None:
    """Write ``atomic-manifest.json`` into ``directory``. Never raises."""
    path = directory / MANIFEST_FILENAME
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _ = path.write_text(json.dumps(manifest.to_json(), indent=2) + "\n", encoding="utf-8")
    except OSError:
        return None
    return path


def read_manifest(path: Path) -> RunManifest | None:
    """Read a manifest from a file or from a directory containing one."""
    target = path / MANIFEST_FILENAME if path.is_dir() else path
    return RunManifest.from_json(_read_json(target))


def manifest_differences(
    left: RunManifest,
    right: RunManifest,
    *,
    fields: Sequence[str] = COMPARABLE_FIELDS,
) -> tuple[tuple[str, object, object], ...]:
    """Return every comparable field on which two manifests disagree."""
    left_json: Mapping[str, object] = left.to_json()
    right_json: Mapping[str, object] = right.to_json()
    return tuple(
        (field, left_json.get(field), right_json.get(field))
        for field in fields
        if left_json.get(field) != right_json.get(field)
    )


def compare_manifests(
    left: RunManifest,
    right: RunManifest,
    *,
    fields: Sequence[str] = COMPARABLE_FIELDS,
) -> None:
    """Raise :class:`ManifestMismatchError` unless two runs are comparable."""
    differences = manifest_differences(left, right, fields=fields)
    if differences:
        raise ManifestMismatchError(differences)
