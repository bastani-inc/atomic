"""The Harbor adapter must carry the same contracts as the Pier twin.

`evals/README.md` promises every trial directory carries a run manifest and an
explicit status. That promise has to hold for `atomic_harbor:Atomic` too, not
only for `atomic_pier:Atomic`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from harbor.models.agent.context import AgentContext

from atomic_harbor import Atomic
from prerequisites import (
    DEEP_SWE_SUBMODULE_PATH,
    PIER_SUBMODULE_PATH,
    submodule_pin,
    submodule_worktree_head,
)
from run_manifest import IncompleteManifestError, compare_manifests, read_manifest
from trial_audit import (
    REASON_MALFORMED_SESSION_LOG,
    REASON_MISSING_OUTPUT,
    STATUS_FAILED,
    STATUS_OK,
    read_agent_status,
)

EVENT = {"type": "message_end", "message": {"role": "assistant"}}


def _agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Atomic:
    job_dir = tmp_path / "jobs" / "atomic-harbor-smoke"
    job_dir.mkdir(parents=True)
    (job_dir / "config.json").write_text(json.dumps({"job_name": "atomic-harbor-smoke"}), encoding="utf-8")
    (job_dir / "result.json").write_text(json.dumps({"id": "harbor-job-uuid"}), encoding="utf-8")
    logs_dir = job_dir / "trial-1" / "agent"
    logs_dir.mkdir(parents=True)
    auth_path = tmp_path / "auth.json"
    monkeypatch.setattr(Atomic, "_auth_config_paths", staticmethod(lambda: (auth_path,)))
    return Atomic(logs_dir=logs_dir, model_name="anthropic/claude-opus-4-6", version="0.9.3")


def test_harbor_adapter_writes_a_run_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch)
    (agent.logs_dir / "atomic.txt").write_text(json.dumps(EVENT) + "\n", encoding="utf-8")
    context = AgentContext()

    agent.populate_context_post_run(context)

    manifest = read_manifest(agent.logs_dir)
    assert manifest is not None
    assert manifest.run_id == "harbor-job-uuid/trial-1"
    assert manifest.model == "anthropic/claude-opus-4-6"
    assert manifest.atomic_version == "0.9.3"
    # Assert the same fallback the implementation uses, so this keeps its
    # coverage in a fresh clone where no submodule is checked out.
    assert manifest.deep_swe_sha == (
        submodule_worktree_head(DEEP_SWE_SUBMODULE_PATH) or submodule_pin(DEEP_SWE_SUBMODULE_PATH)
    )
    assert manifest.pier_sha == (
        submodule_worktree_head(PIER_SUBMODULE_PATH) or submodule_pin(PIER_SUBMODULE_PATH)
    )
    assert context.metadata is not None
    assert context.metadata["atomic_manifest"] == manifest.to_json()


def test_harbor_manifest_is_written_even_when_the_agent_produced_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The manifest must precede the missing-atomic.txt early return."""
    agent = _agent(tmp_path, monkeypatch)
    context = AgentContext()

    agent.populate_context_post_run(context)

    assert read_manifest(agent.logs_dir) is not None
    status = read_agent_status(agent.logs_dir)
    assert status is not None
    assert status.status == STATUS_FAILED
    assert status.reasons == (REASON_MISSING_OUTPUT,)


def test_harbor_seedless_manifest_refuses_comparison(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Harbor has no seed, so its manifests refuse to compare, naming seed."""
    agent = _agent(tmp_path, monkeypatch)
    (agent.logs_dir / "atomic.txt").write_text(json.dumps(EVENT) + "\n", encoding="utf-8")
    agent.populate_context_post_run(AgentContext())

    manifest = read_manifest(agent.logs_dir)
    assert manifest is not None
    assert manifest.seed is None

    with pytest.raises(IncompleteManifestError) as excinfo:
        compare_manifests(manifest, manifest)

    assert excinfo.value.fields == ("seed",)


@pytest.mark.parametrize(
    "bad_line",
    ['{"type":"message","message":{"role":"assist', "not-json"],
    ids=["truncated-object", "plain-text"],
)
def test_harbor_flags_any_undecodable_session_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad_line: str
) -> None:
    agent = _agent(tmp_path, monkeypatch)
    (agent.logs_dir / "atomic.txt").write_text(json.dumps(EVENT) + "\n", encoding="utf-8")
    sessions = agent.logs_dir / "atomic-sessions"
    sessions.mkdir()
    (sessions / "session.jsonl").write_text(
        json.dumps({"type": "session", "internal": True}) + "\n" + bad_line + "\n",
        encoding="utf-8",
    )

    agent.populate_context_post_run(AgentContext())

    status = read_agent_status(agent.logs_dir)
    assert status is not None
    assert status.status == STATUS_FAILED
    assert REASON_MALFORMED_SESSION_LOG in status.reasons


def test_harbor_tolerates_plain_text_in_atomic_txt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch)
    (agent.logs_dir / "atomic.txt").write_text(
        "atomic-workflows: durable backend unavailable — continuing NON-DURABLY.\n"
        + json.dumps(EVENT)
        + "\n",
        encoding="utf-8",
    )

    agent.populate_context_post_run(AgentContext())

    status = read_agent_status(agent.logs_dir)
    assert status is not None
    assert status.status == STATUS_OK
