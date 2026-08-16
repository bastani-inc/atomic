"""The run manifest: what actually produced a number.

Two Deep SWE runs used to be indistinguishable after the fact — nothing recorded
which corpus, which pier, which Atomic build, which model, or which seed was
involved. Each trial now carries an ``atomic-manifest.json`` alongside its agent
logs.

This module only *records*. Comparing two runs is `diff` on two files:

    diff <(jq -S . run-a/<trial>/agent/atomic-manifest.json) \\
         <(jq -S . run-b/<trial>/agent/atomic-manifest.json)

Every field records what **ran**, not what was asked for. The submodule SHAs are
the commits checked out inside each submodule, falling back to the superproject's
gitlink when a submodule is uninitialized, with ``-dirty`` appended when that
working tree carried uncommitted changes — a number produced by modified code was
not produced by the pin.

Note what is *not* used: ``git -C evals/deep-swe rev-parse HEAD``. In an
uninitialized submodule that silently prints the *superproject* SHA, which would
record a wrong corpus with no error. :func:`prerequisites.submodule_worktree_head`
verifies the repository's own toplevel before trusting a HEAD, so it answers
``None`` there and the gitlink fallback applies.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from prerequisites import (
    DEEP_SWE_SUBMODULE_PATH,
    PIER_SUBMODULE_PATH,
    submodule_pin,
    submodule_worktree_head,
    submodule_worktree_status,
)

MANIFEST_FILENAME = "atomic-manifest.json"
DIRTY_SUFFIX = "-dirty"

_PINNED_VERSION = re.compile(r"^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$")


@dataclass(frozen=True)
class RunManifest:
    """Everything needed to say whether two runs measured the same thing.

    Harbor has no seed concept at all — ``harbor run`` has no ``--sample-seed``
    — so a Harbor manifest's ``seed`` is ``None``. That is the honest answer: an
    unrecorded seed cannot be proven equal.
    """

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


def is_pinned_version(spec: str | None) -> bool:
    """True when ``spec`` names exactly one immutable published build.

    Everything else — ``next``, ``latest``, a dist-tag, a range such as
    ``^0.9``, or nothing at all — resolves to a different build tomorrow.
    """
    return bool(spec) and _PINNED_VERSION.match(spec.strip()) is not None


def recorded_atomic_version(resolved: str | None, requested: str | None) -> str | None:
    """The Atomic version a manifest may record, or ``None`` when it has none.

    ``resolved`` is what the container reported after install; ``requested`` is
    the ``--version`` spec. Recording ``requested`` unconditionally was the
    defect: with ``version=next`` and a failed version probe, two runs of
    different builds both recorded ``next`` and would compare as equal. A moving
    request that could not be resolved therefore records nothing.
    """
    if resolved:
        return resolved
    if is_pinned_version(requested):
        return requested
    return None


def _read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _as_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def submodule_revision(path: str, *, repo_root: Path | None = None) -> str | None:
    """The revision that actually ran: the checked-out head, else the gitlink pin.

    A dirty tree still reports its clean ``HEAD``, so the SHA alone would let an
    edited corpus or pier compare equal to an untouched run. Appending
    :data:`DIRTY_SUFFIX` keeps the SHA legible and makes that comparison fail,
    which is what a manifest is for.
    """
    head = submodule_worktree_head(path, repo_root=repo_root)
    if head is None:
        return submodule_pin(path, repo_root=repo_root)
    if submodule_worktree_status(path, repo_root=repo_root):
        return f"{head}{DIRTY_SUFFIX}"
    return head


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
    """Write ``atomic-manifest.json`` into ``directory``. Never raises.

    It also runs on pier's cancel and outer-except paths, where raising would
    replace the in-flight exception.
    """
    path = directory / MANIFEST_FILENAME
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _ = path.write_text(json.dumps(manifest.to_json(), indent=2) + "\n", encoding="utf-8")
    except OSError:
        return None
    return path
