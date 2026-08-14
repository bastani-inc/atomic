"""S6 — the per-trial artifact contract.

Two things could previously make a dead trial look like a completed one:

* the adapter returned early when ``agent/atomic.txt`` was missing, so the trial
  carried no tokens, no cost, and no complaint;
* a truncated session JSONL line was skipped silently, so metrics degraded with
  no signal.

Both now produce an explicit status. The third guarantee — ``model.patch``
exists and is non-empty — cannot be checked from the adapter at all: pier runs
``populate_context_post_run`` *before* the ``[[verifier.collect]]`` hooks, so
the patch does not exist yet while the adapter is on the stack, and pier exposes
no user-registerable trial hook. It is therefore audited after the run, from the
job directory on the host.

Trial layout this module reads (pier ``TrialPaths``)::

    <trial_dir>/
      agent/atomic.txt              the Atomic JSON event stream
      agent/atomic-status.json      written by the adapter (this module's status)
      artifacts/model.patch         written by the [[verifier.collect]] hook
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

STATUS_FILENAME = "atomic-status.json"
AGENT_DIR_NAME = "agent"
ARTIFACTS_DIR_NAME = "artifacts"
OUTPUT_FILENAME = "atomic.txt"
MODEL_PATCH_FILENAME = "model.patch"

STATUS_OK = "ok"
STATUS_FAILED = "failed"

REASON_MISSING_OUTPUT = "missing-atomic.txt"
REASON_EMPTY_OUTPUT = "empty-atomic.txt"
REASON_MALFORMED_SESSION_LOG = "malformed-session-jsonl"
REASON_MISSING_MODEL_PATCH = "missing-model.patch"
REASON_EMPTY_MODEL_PATCH = "empty-model.patch"
REASON_MANIFEST_NOT_WRITTEN = "manifest-not-written"

_REASON_TEXT: Mapping[str, str] = {
    REASON_MISSING_OUTPUT: "the agent produced no atomic.txt",
    REASON_EMPTY_OUTPUT: "atomic.txt is empty",
    REASON_MALFORMED_SESSION_LOG: "a session JSONL log contains malformed or truncated lines",
    REASON_MISSING_MODEL_PATCH: (
        "no artifacts/model.patch: the [[verifier.collect]] hook did not run or wrote nothing"
    ),
    REASON_EMPTY_MODEL_PATCH: "artifacts/model.patch is empty: the agent changed nothing",
    REASON_MANIFEST_NOT_WRITTEN: (
        "the run manifest could not be written, so this run cannot be compared with another"
    ),
}


class TrialArtifactError(RuntimeError):
    """Raised by :func:`require_trial_artifacts` for a trial that failed its contract."""

    def __init__(self, audit: TrialAudit) -> None:
        self.audit = audit
        super().__init__(audit.describe())


def explain(reason: str) -> str:
    """Human-readable text for a reason code, falling back to the code itself."""
    return _REASON_TEXT.get(reason, reason)


@dataclass(frozen=True)
class AgentRunStatus:
    """The adapter's own verdict on a run, persisted next to the agent logs."""

    status: str
    reasons: tuple[str, ...] = ()
    details: dict[str, object] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == STATUS_OK

    def to_json(self) -> dict[str, object]:
        return {"status": self.status, "reasons": list(self.reasons), "details": dict(self.details)}

    @classmethod
    def from_reasons(
        cls, reasons: Iterable[str], details: Mapping[str, object] | None = None
    ) -> AgentRunStatus:
        ordered = tuple(reasons)
        return cls(
            status=STATUS_FAILED if ordered else STATUS_OK,
            reasons=ordered,
            details=dict(details or {}),
        )

    @classmethod
    def from_json(cls, payload: object) -> AgentRunStatus | None:
        if not isinstance(payload, dict):
            return None
        status = payload.get("status")
        if not isinstance(status, str):
            return None
        raw_reasons = payload.get("reasons")
        reasons = tuple(item for item in raw_reasons if isinstance(item, str)) if isinstance(raw_reasons, list) else ()
        raw_details = payload.get("details")
        details = dict(raw_details) if isinstance(raw_details, dict) else {}
        return cls(status=status, reasons=reasons, details=details)


def write_agent_status(logs_dir: Path, status: AgentRunStatus) -> Path | None:
    """Persist ``status`` as ``<logs_dir>/atomic-status.json``.

    Returns the path written, or ``None`` when the write failed. Never raises:
    this runs inside pier's cancel and exception handlers, where raising would
    replace the in-flight exception.
    """
    path = logs_dir / STATUS_FILENAME
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _ = path.write_text(json.dumps(status.to_json(), indent=2) + "\n", encoding="utf-8")
    except OSError:
        return None
    return path


def read_agent_status(agent_dir: Path) -> AgentRunStatus | None:
    """Read the status the adapter wrote, or ``None`` when there is none."""
    path = agent_dir / STATUS_FILENAME
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return AgentRunStatus.from_json(payload)


@dataclass(frozen=True)
class TrialAudit:
    """The post-run verdict for one trial directory."""

    trial_dir: Path
    status: str
    reasons: tuple[str, ...]
    details: dict[str, object] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == STATUS_OK

    @property
    def failed(self) -> bool:
        return self.status == STATUS_FAILED

    def describe(self) -> str:
        if self.ok:
            return f"{self.trial_dir}: ok"
        return f"{self.trial_dir}: failed — " + "; ".join(explain(reason) for reason in self.reasons)


def audit_trial(trial_dir: Path) -> TrialAudit:
    """Audit one finished trial directory against the artifact contract."""
    agent_dir = trial_dir / AGENT_DIR_NAME
    artifacts_dir = trial_dir / ARTIFACTS_DIR_NAME
    output_file = agent_dir / OUTPUT_FILENAME
    model_patch = artifacts_dir / MODEL_PATCH_FILENAME

    reasons: list[str] = []
    details: dict[str, object] = {
        "atomic_txt": str(output_file),
        "model_patch": str(model_patch),
    }

    if not output_file.is_file():
        reasons.append(REASON_MISSING_OUTPUT)
    else:
        size = output_file.stat().st_size
        details["atomic_txt_bytes"] = size
        if size == 0:
            reasons.append(REASON_EMPTY_OUTPUT)

    if not model_patch.is_file():
        reasons.append(REASON_MISSING_MODEL_PATCH)
    else:
        size = model_patch.stat().st_size
        details["model_patch_bytes"] = size
        if size == 0 or not model_patch.read_text(encoding="utf-8", errors="replace").strip():
            reasons.append(REASON_EMPTY_MODEL_PATCH)

    recorded = read_agent_status(agent_dir)
    if recorded is not None:
        details["agent_status"] = recorded.to_json()
        for reason in recorded.reasons:
            if reason not in reasons:
                reasons.append(reason)

    return TrialAudit(
        trial_dir=trial_dir,
        status=STATUS_FAILED if reasons else STATUS_OK,
        reasons=tuple(reasons),
        details=details,
    )


def require_trial_artifacts(trial_dir: Path) -> TrialAudit:
    """Audit a trial and raise :class:`TrialArtifactError` when it failed."""
    audit = audit_trial(trial_dir)
    if audit.failed:
        raise TrialArtifactError(audit)
    return audit


def find_trial_dirs(job_dir: Path) -> list[Path]:
    """Return every trial directory under ``job_dir``, in sorted order.

    A trial directory is one that owns an ``agent/`` or ``artifacts/``
    subdirectory, which is what pier's ``TrialPaths`` creates.
    """
    if not job_dir.is_dir():
        return []
    found: set[Path] = set()
    for name in (AGENT_DIR_NAME, ARTIFACTS_DIR_NAME):
        for path in job_dir.rglob(name):
            if path.is_dir():
                found.add(path.parent)
    return sorted(found)


@dataclass(frozen=True)
class JobAudit:
    """The aggregate audit for a job directory."""

    job_dir: Path
    trials: tuple[TrialAudit, ...]

    @property
    def failed_trials(self) -> tuple[TrialAudit, ...]:
        return tuple(trial for trial in self.trials if trial.failed)

    @property
    def ok(self) -> bool:
        return bool(self.trials) and not self.failed_trials

    def describe(self) -> str:
        if not self.trials:
            return f"{self.job_dir}: no trial directories found"
        lines = [
            f"{self.job_dir}: {len(self.trials) - len(self.failed_trials)}/{len(self.trials)} trials ok"
        ]
        lines.extend(trial.describe() for trial in self.failed_trials)
        return "\n".join(lines)


def audit_job(job_dir: Path) -> JobAudit:
    """Audit every trial under a pier job directory."""
    trials: Sequence[TrialAudit] = [audit_trial(path) for path in find_trial_dirs(job_dir)]
    return JobAudit(job_dir=job_dir, trials=tuple(trials))
