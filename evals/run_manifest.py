"""S7 — the run manifest.

Two Deep SWE runs used to be indistinguishable after the fact: nothing recorded
which corpus, which pier, which Atomic build, which model, or which seed
produced a number. The manifest records all six, and :func:`compare_manifests`
refuses to compare two runs that did not share them.

The submodule SHAs are the revisions that actually **ran**: the commit checked
out inside each submodule, falling back to the superproject's gitlink when the
submodule is uninitialized. A manifest exists to say which corpus and which pier
produced a number, so a working tree sitting off its pin must be recorded as
what it is rather than as the pin it drifted from.

Note what is *not* used: ``git -C evals/deep-swe rev-parse HEAD``. In an
uninitialized submodule that silently prints the *superproject* SHA, which would
record a wrong corpus with no error. :func:`prerequisites.submodule_worktree_head`
verifies the repository's own toplevel before trusting a HEAD, so it answers
``None`` there and the gitlink fallback applies.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from prerequisites import (
    DEEP_SWE_SUBMODULE_PATH,
    PIER_SUBMODULE_PATH,
    submodule_pin,
    submodule_worktree_head,
)

MANIFEST_FILENAME = "atomic-manifest.json"

REQUIRED_FIELDS: tuple[str, ...] = (
    "run_id",
    "seed",
    "model",
    "atomic_version",
    "deep_swe_sha",
    "pier_sha",
)
"""Every field a manifest must record before two runs may be compared.

Harbor has no seed concept at all — ``harbor.models.job.config.JobConfig``
declares no seed-like field and ``harbor run`` has no ``--sample-seed`` — so a
Harbor manifest's ``seed`` is ``None`` and two Harbor runs refuse to compare,
naming ``seed``. That is the honest answer: an unrecorded seed cannot be proven
equal.
"""

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


def missing_fields(manifest: RunManifest) -> tuple[str, ...]:
    """Return every required field this manifest does not record."""
    payload = manifest.to_json()
    return tuple(field for field in REQUIRED_FIELDS if payload.get(field) is None)


class ManifestMismatchError(RuntimeError):
    """Raised when two run manifests describe incompatible runs."""

    def __init__(self, differences: Sequence[tuple[str, object, object]]) -> None:
        self.differences = tuple(differences)
        rendered = "; ".join(f"{field}: {left!r} != {right!r}" for field, left, right in differences)
        super().__init__(
            "Refusing to compare runs recorded under different conditions — " + rendered
        )


class IncompleteManifestError(ManifestMismatchError):
    """Raised when a manifest is absent, unreadable, or missing required fields.

    A manifest that records nothing cannot prove two runs measured the same
    thing, so it must refuse rather than compare as equal. Subclasses
    :class:`ManifestMismatchError` so a caller that already refuses mismatches
    refuses this too.
    """

    def __init__(self, *, side: str, fields: Sequence[str]) -> None:
        self.side = side
        self.fields = tuple(fields)
        super(ManifestMismatchError, self).__init__(
            f"Refusing to compare runs: the {side} manifest is absent or incomplete — "
            f"missing {', '.join(self.fields) if self.fields else 'everything'}"
        )
        self.differences = ()


def _as_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def submodule_revision(path: str, *, repo_root: Path | None = None) -> str | None:
    """The SHA that actually ran: the checked-out head, else the gitlink pin.

    Preflight reports a drifted working tree as a failure; the manifest has to
    record what that tree contained, because a number produced by drifted code
    was not produced by the pin.
    """
    return submodule_worktree_head(path, repo_root=repo_root) or submodule_pin(
        path, repo_root=repo_root
    )


def build_manifest(
    *,
    run_id: str | None = None,
    seed: int | None = None,
    model: str | None = None,
    atomic_version: str | None = None,
    repo_root: Path | None = None,
) -> RunManifest:
    """Build a manifest recording the submodule revisions that actually ran."""
    return RunManifest(
        run_id=run_id,
        seed=seed,
        model=model,
        atomic_version=atomic_version,
        deep_swe_sha=submodule_revision(DEEP_SWE_SUBMODULE_PATH, repo_root=repo_root),
        pier_sha=submodule_revision(PIER_SUBMODULE_PATH, repo_root=repo_root),
    )


def _seed_from_job_config(config: object) -> int | None:
    """Read ``sample_seed`` from a pier job config.

    Pier writes the seed on each dataset entry (``datasets[].sample_seed``), not
    at the top level — observed in a real ``jobs/<name>/config.json``. The
    top-level lookup is kept for configs that carry it there.
    """
    if not isinstance(config, dict):
        return None
    candidates: list[object] = [config.get("sample_seed")]
    datasets = config.get("datasets")
    if isinstance(datasets, list):
        candidates.extend(
            dataset.get("sample_seed") for dataset in datasets if isinstance(dataset, dict)
        )
    for candidate in candidates:
        if isinstance(candidate, int) and not isinstance(candidate, bool):
            return candidate
    return None


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

    return run_id, _seed_from_job_config(_read_json(job_dir / "config.json"))


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


def _require_complete(manifest: RunManifest | None, side: str) -> RunManifest:
    if manifest is None:
        raise IncompleteManifestError(side=side, fields=REQUIRED_FIELDS)
    absent = missing_fields(manifest)
    if absent:
        raise IncompleteManifestError(side=side, fields=absent)
    return manifest


def compare_manifests(left: RunManifest | None, right: RunManifest | None) -> None:
    """Raise unless two complete manifests describe comparable runs.

    ``None`` means the manifest was absent or unreadable — which is what
    ``read_manifest`` returns for a directory that has none — and an incomplete
    manifest proves nothing either. Both refuse with
    :class:`IncompleteManifestError` before any field is diffed, so two empty
    manifests can never compare as equal.

    The comparison is over :data:`COMPARABLE_FIELDS` and takes no ``fields``
    argument: a caller passing ``fields=()`` could otherwise make two wholly
    different runs compare clean, which is the one thing this function exists to
    prevent. Narrowed diffs are available from :func:`manifest_differences`,
    which reports rather than decides.
    """
    complete_left = _require_complete(left, "left")
    complete_right = _require_complete(right, "right")
    differences = manifest_differences(complete_left, complete_right)
    if differences:
        raise ManifestMismatchError(differences)
