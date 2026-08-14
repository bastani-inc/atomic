"""S4 — network-mode resolution and the empty-allowlist trap.

Deep SWE tasks declare ``network_mode = "no-network"`` under both ``[agent]``
and ``[verifier]``. Pier only enforces the legacy ``allow_internet`` boolean, so
these tests pin the resolution rather than trusting it, and they pin the
distinguishable error for the empty-allowlist case where the sandbox — not the
credentials — is at fault.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError
from pier.models.agent.network import NetworkAllowlist
from pier.models.task.config import NetworkMode, TaskConfig

from atomic_pier import Atomic
from network_policy import EmptyEgressAllowlistError, require_non_empty_allowlist
from prerequisites import EXPECTED_TASK_COUNT, corpus_tasks_dir

DEEP_SWE_STYLE = """
schema_version = "1.3"

[verifier]
network_mode = "no-network"
environment_mode = "separate"
timeout_sec = 1800.0

[verifier.environment]
build_timeout_sec = 1800.0

[agent]
network_mode = "no-network"
timeout_sec = 5400.0

[environment]
docker_image = "example/image:tag"
"""


def _agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model_name: str | None) -> Atomic:
    auth_path = tmp_path / "auth.json"
    monkeypatch.setattr(Atomic, "_auth_config_paths", staticmethod(lambda: (auth_path,)))
    return Atomic(logs_dir=tmp_path / "logs", model_name=model_name)


# --- network_mode resolution -------------------------------------------------


def test_no_network_resolves_to_allow_internet_false_for_both_scopes() -> None:
    cfg = TaskConfig.model_validate_toml(DEEP_SWE_STYLE)

    assert cfg.environment.network_mode is NetworkMode.NO_NETWORK
    assert cfg.environment.allow_internet is False
    assert cfg.verifier.environment is not None
    assert cfg.verifier.environment.allow_internet is False


def test_agent_scope_override_is_recorded() -> None:
    cfg = TaskConfig.model_validate_toml(DEEP_SWE_STYLE)

    assert cfg.agent.network_mode is NetworkMode.NO_NETWORK
    assert cfg.verifier.network_mode is NetworkMode.NO_NETWORK


def test_public_mode_keeps_internet() -> None:
    cfg = TaskConfig.model_validate_toml(
        '[environment]\nnetwork_mode = "public"\ndocker_image = "example/image:tag"\n'
    )

    assert cfg.environment.allow_internet is True


def test_allowlist_mode_is_rejected_at_parse_time() -> None:
    with pytest.raises(Exception) as excinfo:
        TaskConfig.model_validate_toml(
            '[environment]\nnetwork_mode = "allowlist"\ndocker_image = "example/image:tag"\n'
        )

    assert "allowlist" in str(excinfo.value)


# --- unknown task-config keys ------------------------------------------------


@pytest.mark.parametrize(
    ("task_toml", "location"),
    [
        (
            '[environment]\ndocker_image = "example/image:tag"\nbogus_key = 1\n',
            "environment.bogus_key",
        ),
        ('schema_version = "1.3"\nbogus_top = true\n', "bogus_top"),
        (
            '[agent]\nnetwork_mode = "no-network"\nbogus_agent_key = "x"\n',
            "agent.bogus_agent_key",
        ),
        (
            '[[verifier.collect]]\ncommand = "true"\nbogus_hook_key = 2\n',
            "verifier.collect.0.bogus_hook_key",
        ),
    ],
    ids=["environment", "top-level", "agent", "collect-hook"],
)
def test_an_unknown_task_config_key_raises_naming_it(task_toml: str, location: str) -> None:
    """The pinned pier sets extra="forbid"; an unmodelled key must fail loudly.

    Without this, a key pier cannot model — which is exactly how `network_mode`
    and `[[verifier.collect]]` were dropped — parses clean and runs outside its
    intended sandbox.
    """
    with pytest.raises(ValidationError) as excinfo:
        TaskConfig.model_validate_toml(task_toml)

    errors = excinfo.value.errors()
    assert any(error["type"] == "extra_forbidden" for error in errors), errors
    assert any(
        ".".join(str(part) for part in error["loc"]) == location for error in errors
    ), errors
    assert location.rsplit(".", 1)[-1] in str(excinfo.value)


def test_a_known_key_still_parses() -> None:
    """Forbidding the unknown must not reject the corpus's own shape."""
    cfg = TaskConfig.model_validate_toml(DEEP_SWE_STYLE)

    assert cfg.agent.network_mode is NetworkMode.NO_NETWORK
    assert cfg.metadata == {}


def test_every_pinned_corpus_task_resolves_to_no_internet() -> None:
    """The corpus itself, not a hand-written sample, must resolve to no egress."""
    corpus = corpus_tasks_dir()
    task_files = sorted(corpus.glob("*/task.toml")) if corpus.is_dir() else []
    if not task_files:
        pytest.skip(
            f"deep-swe corpus is not initialized (no task.toml under {corpus}); "
            "run `git submodule update --init --recursive`"
        )

    offenders: list[str] = []
    for task_file in task_files:
        cfg = TaskConfig.model_validate_toml(task_file.read_text(encoding="utf-8"))
        if cfg.environment.allow_internet is not False:
            offenders.append(f"{task_file.parent.name}: environment")
        if cfg.verifier.environment is not None and cfg.verifier.environment.allow_internet is not False:
            offenders.append(f"{task_file.parent.name}: verifier")

    assert len(task_files) == EXPECTED_TASK_COUNT
    assert offenders == []


# --- empty allowlist ---------------------------------------------------------


def test_require_non_empty_allowlist_passes_through_a_populated_allowlist() -> None:
    allowlist = NetworkAllowlist(domains=["api.anthropic.com"])

    assert require_non_empty_allowlist(allowlist, model_name="anthropic/opus") is allowlist


def test_require_non_empty_allowlist_raises_named_error() -> None:
    with pytest.raises(EmptyEgressAllowlistError) as excinfo:
        require_non_empty_allowlist(NetworkAllowlist(), model_name="anthropic/opus")

    message = str(excinfo.value)
    assert "allowlist" in message
    assert "anthropic/opus" in message
    assert excinfo.value.scope == "agent"
    assert excinfo.value.model_name == "anthropic/opus"


def test_the_error_only_suggests_a_remedy_that_works() -> None:
    """Switching the task to `public` does not clear this error.

    Pier evaluates `agent.network_allowlist()` while creating the environment,
    before any `allow_internet` branch, so a public task with the same
    unqualified model raises identically. Suggesting it sent operators down a
    path that cannot work.
    """
    with pytest.raises(EmptyEgressAllowlistError) as excinfo:
        require_non_empty_allowlist(NetworkAllowlist(), model_name="opus-without-provider")

    message = str(excinfo.value)
    assert "provider/model" in message
    assert "network_mode='public'" not in message


@pytest.mark.parametrize("model_name", [None, "", "opus-without-provider"])
def test_agent_without_a_provider_qualified_model_raises_instead_of_empty_allowlist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model_name: str | None
) -> None:
    agent = _agent(tmp_path, monkeypatch, model_name)

    with pytest.raises(EmptyEgressAllowlistError) as excinfo:
        agent.network_allowlist()

    # The error must name the sandbox, not read as a credential problem.
    message = str(excinfo.value)
    assert "Egress allowlist" in message
    assert "sandbox" in message
    assert excinfo.value.model_name == model_name


def test_agent_with_provider_qualified_model_yields_a_populated_allowlist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch, "anthropic/claude-opus-4-6")

    allowlist = agent.network_allowlist()

    assert allowlist.domains
    assert "api.anthropic.com" in allowlist.domains
