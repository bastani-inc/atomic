from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from atomic_pier import Atomic

_CREDENTIAL_KEYS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
)


@pytest.fixture(autouse=True)
def _isolate_host_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """Host credentials must not leak into the chain under test."""
    for key in _CREDENTIAL_KEYS:
        monkeypatch.delenv(key, raising=False)


def _agent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    env: dict[str, str] | None = None,
    subscriptions: dict[str, dict[str, object]] | None = None,
) -> Atomic:
    auth_path = tmp_path / "auth.json"
    if subscriptions:
        auth_path.write_text(json.dumps(subscriptions), encoding="utf-8")
    monkeypatch.setattr(Atomic, "_auth_config_paths", staticmethod(lambda: (auth_path,)))
    return Atomic(logs_dir=tmp_path / "logs", extra_env=env or {})


def _codex_subscription() -> dict[str, dict[str, object]]:
    return {"openai-codex": {"type": "oauth", "access": "codex-token"}}


def test_codex_subscription_leads_openai_then_openrouter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(
        tmp_path,
        monkeypatch,
        env={"OPENAI_API_KEY": "sk-openai", "OPENROUTER_API_KEY": "sk-or"},
        subscriptions=_codex_subscription(),
    )

    assert agent._model_chain("openai-codex", "gpt-5.6-sol") == [
        ("openai-codex", "gpt-5.6-sol"),
        ("openai", "gpt-5.6-sol"),
        ("openrouter", "openai/gpt-5.6-sol"),
    ]


def test_missing_codex_subscription_starts_on_openai(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(
        tmp_path,
        monkeypatch,
        env={"OPENAI_API_KEY": "sk-openai", "OPENROUTER_API_KEY": "sk-or"},
    )

    assert agent._model_chain("openai-codex", "gpt-5.6-sol") == [
        ("openai", "gpt-5.6-sol"),
        ("openrouter", "openai/gpt-5.6-sol"),
    ]


def test_codex_falls_all_the_way_to_openrouter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch, env={"OPENROUTER_API_KEY": "sk-or"})

    assert agent._model_chain("openai-codex", "gpt-5.6-sol") == [
        ("openrouter", "openai/gpt-5.6-sol")
    ]


def test_disallowed_codex_subscription_is_not_a_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps(_codex_subscription()), encoding="utf-8")
    monkeypatch.setattr(Atomic, "_auth_config_paths", staticmethod(lambda: (auth_path,)))
    agent = Atomic(
        logs_dir=tmp_path / "logs",
        extra_env={"OPENAI_API_KEY": "sk-openai"},
        disallowed_subscriptions="openai-codex",
    )

    assert agent._model_chain("openai-codex", "gpt-5.6-sol") == [
        ("openai", "gpt-5.6-sol")
    ]


@pytest.mark.parametrize(
    "env",
    [
        {"ANTHROPIC_OAUTH_TOKEN": "oauth", "OPENROUTER_API_KEY": "sk-or"},
        {"ANTHROPIC_API_KEY": "sk-ant", "OPENROUTER_API_KEY": "sk-or"},
    ],
)
def test_anthropic_credential_leads_openrouter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, env: dict[str, str]
) -> None:
    # Atomic cannot tell an Anthropic subscription from an API key: either
    # credential keeps `anthropic` primary, with OpenRouter behind it.
    agent = _agent(tmp_path, monkeypatch, env=env)

    assert agent._model_chain("anthropic", "claude-opus-4-8") == [
        ("anthropic", "claude-opus-4-8"),
        ("openrouter", "anthropic/claude-opus-4.8"),
    ]


def test_anthropic_without_credentials_starts_on_openrouter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch, env={"OPENROUTER_API_KEY": "sk-or"})

    assert agent._model_chain("anthropic", "claude-opus-4-8") == [
        ("openrouter", "anthropic/claude-opus-4.8")
    ]


def test_requested_model_survives_when_no_fallback_is_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = _agent(tmp_path, monkeypatch)

    assert agent._model_chain("openai-codex", "gpt-5.6-sol") == [
        ("openai-codex", "gpt-5.6-sol")
    ]


def test_settings_command_writes_fallback_models_after_the_primary(
    tmp_path: Path,
) -> None:
    command = Atomic._fallback_settings_command(
        [
            ("openai-codex", "gpt-5.6-sol"),
            ("openai", "gpt-5.6-sol"),
            ("openrouter", "openai/gpt-5.6-sol"),
        ]
    )

    home = tmp_path / "home"
    agent_dir = home / ".atomic" / "agent"
    agent_dir.mkdir(parents=True)
    subprocess.run(
        ["/bin/bash", "-c", f"set -euo pipefail; {command}"],
        env={"HOME": str(home), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        check=True,
    )

    settings = json.loads((agent_dir / "settings.json").read_text(encoding="utf-8"))
    assert settings == {
        "fallbackModels": ["openai/gpt-5.6-sol", "openrouter/openai/gpt-5.6-sol"]
    }


def test_settings_command_is_empty_without_fallbacks() -> None:
    assert Atomic._fallback_settings_command([("anthropic", "claude-opus-4-8")]) == ""
