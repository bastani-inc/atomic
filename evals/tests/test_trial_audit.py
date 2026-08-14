"""S6 — the artifact contract: model.patch, atomic.txt, and session logs.

Negative cases first: a trial that produced no `model.patch`, no `atomic.txt`,
or a truncated session JSONL used to look like a completed trial. Each is now an
explicit failure.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pier.models.agent.context import AgentContext

from atomic_pier import Atomic
from trial_audit import (
    REASON_EMPTY_MODEL_PATCH,
    REASON_MANIFEST_NOT_WRITTEN,
    REASON_EMPTY_OUTPUT,
    REASON_MALFORMED_SESSION_LOG,
    REASON_MISSING_MODEL_PATCH,
    REASON_MISSING_OUTPUT,
    STATUS_FAILED,
    STATUS_FILENAME,
    STATUS_OK,
    AgentRunStatus,
    TrialArtifactError,
    audit_job,
    audit_trial,
    read_agent_status,
    require_trial_artifacts,
    write_agent_status,
)

PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"


def _trial(
    root: Path,
    name: str = "trial",
    *,
    atomic_txt: str | None = '{"type":"message_end"}\n',
    model_patch: str | None = PATCH,
) -> Path:
    trial_dir = root / name
    (trial_dir / "agent").mkdir(parents=True)
    (trial_dir / "artifacts").mkdir(parents=True)
    if atomic_txt is not None:
        (trial_dir / "agent" / "atomic.txt").write_text(atomic_txt, encoding="utf-8")
    if model_patch is not None:
        (trial_dir / "artifacts" / "model.patch").write_text(model_patch, encoding="utf-8")
    return trial_dir


# --- trial audit -------------------------------------------------------------


def test_complete_trial_is_ok(tmp_path: Path) -> None:
    audit = audit_trial(_trial(tmp_path))

    assert audit.ok
    assert audit.reasons == ()
    assert audit.details["model_patch_bytes"] == len(PATCH)


def test_missing_model_patch_is_a_failure_not_a_completed_trial(tmp_path: Path) -> None:
    audit = audit_trial(_trial(tmp_path, model_patch=None))

    assert audit.failed
    assert audit.status == STATUS_FAILED
    assert REASON_MISSING_MODEL_PATCH in audit.reasons
    assert "[[verifier.collect]]" in audit.describe()


def test_empty_model_patch_is_a_failure(tmp_path: Path) -> None:
    audit = audit_trial(_trial(tmp_path, model_patch="   \n"))

    assert audit.failed
    assert REASON_EMPTY_MODEL_PATCH in audit.reasons


def test_missing_atomic_txt_is_a_failure(tmp_path: Path) -> None:
    audit = audit_trial(_trial(tmp_path, atomic_txt=None))

    assert audit.failed
    assert REASON_MISSING_OUTPUT in audit.reasons


def test_empty_atomic_txt_is_a_failure(tmp_path: Path) -> None:
    audit = audit_trial(_trial(tmp_path, atomic_txt=""))

    assert audit.failed
    assert REASON_EMPTY_OUTPUT in audit.reasons


def test_recorded_adapter_status_is_folded_into_the_audit(tmp_path: Path) -> None:
    trial_dir = _trial(tmp_path)
    write_agent_status(
        trial_dir / "agent",
        AgentRunStatus.from_reasons([REASON_MALFORMED_SESSION_LOG], {"lines": 3}),
    )

    audit = audit_trial(trial_dir)

    assert audit.failed
    assert REASON_MALFORMED_SESSION_LOG in audit.reasons


def test_recorded_ok_status_leaves_a_good_trial_ok(tmp_path: Path) -> None:
    trial_dir = _trial(tmp_path)
    write_agent_status(trial_dir / "agent", AgentRunStatus.from_reasons([]))

    assert audit_trial(trial_dir).ok


def test_require_trial_artifacts_raises_for_a_missing_patch(tmp_path: Path) -> None:
    trial_dir = _trial(tmp_path, model_patch=None)

    with pytest.raises(TrialArtifactError) as excinfo:
        require_trial_artifacts(trial_dir)

    assert REASON_MISSING_MODEL_PATCH in excinfo.value.audit.reasons


def test_require_trial_artifacts_returns_the_audit_when_ok(tmp_path: Path) -> None:
    assert require_trial_artifacts(_trial(tmp_path)).ok


# --- status round trip -------------------------------------------------------


def test_agent_status_round_trips(tmp_path: Path) -> None:
    written = write_agent_status(tmp_path, AgentRunStatus.from_reasons([REASON_MISSING_OUTPUT]))

    assert written == tmp_path / STATUS_FILENAME
    restored = read_agent_status(tmp_path)
    assert restored is not None
    assert restored.status == STATUS_FAILED
    assert restored.reasons == (REASON_MISSING_OUTPUT,)


def test_read_agent_status_is_none_when_absent_or_corrupt(tmp_path: Path) -> None:
    assert read_agent_status(tmp_path) is None
    (tmp_path / STATUS_FILENAME).write_text("{not json", encoding="utf-8")
    assert read_agent_status(tmp_path) is None


# --- job audit ---------------------------------------------------------------


def test_job_audit_reports_the_failing_trial(tmp_path: Path) -> None:
    _trial(tmp_path, "trial-ok")
    _trial(tmp_path, "trial-bad", model_patch=None)

    job = audit_job(tmp_path)

    assert len(job.trials) == 2
    assert not job.ok
    assert len(job.failed_trials) == 1
    assert "trial-bad" in job.describe()


def test_job_audit_reports_an_empty_job_directory(tmp_path: Path) -> None:
    job = audit_job(tmp_path)

    assert job.trials == ()
    assert not job.ok
    assert "no trial directories found" in job.describe()


# --- adapter statuses --------------------------------------------------------


def _agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Atomic:
    auth_path = tmp_path / "auth.json"
    monkeypatch.setattr(Atomic, "_auth_config_paths", staticmethod(lambda: (auth_path,)))
    logs_dir = tmp_path / "agent"
    logs_dir.mkdir(parents=True, exist_ok=True)
    return Atomic(logs_dir=logs_dir)


def test_adapter_records_a_failure_when_atomic_txt_is_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch)
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_FAILED
    assert status.reasons == (REASON_MISSING_OUTPUT,)
    assert context.metadata is not None
    assert context.metadata["atomic_status"]["status"] == STATUS_FAILED


def test_adapter_records_ok_for_a_healthy_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_text(
        json.dumps({"type": "message_end", "message": {"role": "assistant"}}) + "\n",
        encoding="utf-8",
    )
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_OK
    assert status.reasons == ()


def test_adapter_flags_a_truncated_session_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_text(
        json.dumps({"type": "message_end", "message": {"role": "assistant"}}) + "\n",
        encoding="utf-8",
    )
    sessions = tmp_path / "agent" / "atomic-sessions"
    sessions.mkdir()
    # A session log cut off mid-line, as a killed container leaves it.
    (sessions / "session.jsonl").write_text(
        json.dumps({"type": "session", "internal": True})
        + "\n"
        + '{"type":"message","message":{"role":"assist',
        encoding="utf-8",
    )
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_FAILED
    assert REASON_MALFORMED_SESSION_LOG in status.reasons
    assert status.details["malformed_jsonl_lines"]


@pytest.mark.parametrize(
    "bad_line",
    [
        '{"type":"message","message":{"role":"assist',
        "not-json",
        "<<<<<<< HEAD",
        "\x00\x01garbage",
    ],
    ids=["truncated-object", "plain-text", "conflict-marker", "binary-noise"],
)
def test_any_undecodable_session_line_is_flagged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad_line: str
) -> None:
    """A session transcript is machine-written: corruption is corruption.

    The first-byte heuristic that `atomic.txt` needs must not leak into session
    logs, where a line that does not even start with `{` was skipped silently.
    """
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_text(
        json.dumps({"type": "message_end", "message": {"role": "assistant"}}) + "\n",
        encoding="utf-8",
    )
    sessions = tmp_path / "agent" / "atomic-sessions"
    sessions.mkdir()
    (sessions / "session.jsonl").write_text(
        json.dumps({"type": "session", "internal": True}) + "\n" + bad_line + "\n",
        encoding="utf-8",
    )
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_FAILED
    assert REASON_MALFORMED_SESSION_LOG in status.reasons


def test_a_malformed_session_line_is_counted_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The header pass and the metrics pass read the same file; count once."""
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_text(
        json.dumps({"type": "message_end", "message": {"role": "assistant"}}) + "\n",
        encoding="utf-8",
    )
    sessions = tmp_path / "agent" / "atomic-sessions"
    sessions.mkdir()
    session_file = sessions / "session.jsonl"
    session_file.write_text(
        json.dumps({"type": "session", "internal": True}) + "\nnot-json\n",
        encoding="utf-8",
    )
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    counts = status.details["malformed_jsonl_lines"]
    assert isinstance(counts, dict)
    assert counts[str(session_file)] == 1


def test_adapter_tolerates_atomics_plain_text_diagnostics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Atomic writes human-readable warnings into the same stream as its JSON.

    Observed in a live Deep SWE trial: one such banner in a 3.3 MB atomic.txt.
    Counting it as corruption would fail every healthy trial.
    """
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_text(
        "atomic-workflows: durable backend unavailable — continuing NON-DURABLY "
        "with an in-memory backend.\n"
        + json.dumps({"type": "message_end", "message": {"role": "assistant"}})
        + "\n",
        encoding="utf-8",
    )
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_OK
    assert status.reasons == ()


def test_adapter_flags_a_truncated_line_in_atomic_txt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_text(
        json.dumps({"type": "message_end", "message": {"role": "assistant"}})
        + "\n"
        + '{"type":"message_end","message":{"role":"assist',
        encoding="utf-8",
    )
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_FAILED
    assert REASON_MALFORMED_SESSION_LOG in status.reasons


def test_adapter_tolerates_blank_lines(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_text(
        "\n" + json.dumps({"type": "message_end", "message": {"role": "assistant"}}) + "\n\n",
        encoding="utf-8",
    )
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_OK


# --- invalid UTF-8 in a session log (round 5) --------------------------------


def test_invalid_utf8_in_a_session_log_is_reported_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A truncated multibyte character used to escape as UnicodeDecodeError.

    That is a ValueError, not an OSError, so it slipped past the reader's guard
    and took the whole status write down with it: the trial ended with an
    adapter traceback and no atomic-status.json at all.
    """
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_text(
        json.dumps({"type": "message_end", "message": {"role": "assistant"}}) + "\n",
        encoding="utf-8",
    )
    sessions = tmp_path / "agent" / "atomic-sessions"
    sessions.mkdir()
    (sessions / "session.jsonl").write_bytes(
        json.dumps({"type": "session", "internal": True}).encode("utf-8") + b"\n\xff\xfe garbage\n"
    )
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_FAILED
    assert REASON_MALFORMED_SESSION_LOG in status.reasons


def test_invalid_utf8_in_atomic_txt_is_reported_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_bytes(
        json.dumps({"type": "message_end", "message": {"role": "assistant"}}).encode("utf-8")
        + b"\n\xff\xfe\n"
    )
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_FAILED
    assert REASON_MALFORMED_SESSION_LOG in status.reasons


# --- a manifest that could not be written (round 5) --------------------------


def test_a_manifest_that_cannot_be_written_fails_the_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run whose manifest was lost cannot be compared with another."""
    agent = _agent(tmp_path, monkeypatch)
    (tmp_path / "agent" / "atomic.txt").write_text(
        json.dumps({"type": "message_end", "message": {"role": "assistant"}}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr("atomic_pier.write_manifest", lambda directory, manifest: None)
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.status == STATUS_FAILED
    assert REASON_MANIFEST_NOT_WRITTEN in status.reasons


def test_a_lost_manifest_is_reported_on_the_missing_output_path_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_record_run_manifest` runs before the early return, so the flag must survive it."""
    agent = _agent(tmp_path, monkeypatch)
    monkeypatch.setattr("atomic_pier.write_manifest", lambda directory, manifest: None)
    context = AgentContext()

    agent.populate_context_post_run(context)

    status = read_agent_status(tmp_path / "agent")
    assert status is not None
    assert status.reasons == (REASON_MISSING_OUTPUT, REASON_MANIFEST_NOT_WRITTEN)
