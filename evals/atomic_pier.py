from __future__ import annotations

import json
import os
import re
import shlex
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from pier.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist
from pier.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from pier.models.trial.paths import EnvironmentPaths
from pier.utils.trajectory_utils import format_trajectory_json


class Atomic(BaseInstalledAgent):
    """Pier installed-agent adapter for the Atomic coding agent."""

    SUPPORTS_ATIF: bool = True

    _OUTPUT_FILENAME = "atomic.txt"
    _SESSION_DIR_NAME = "atomic-sessions"
    _CONTAINER_AGENT_DIR = "$HOME/.atomic/agent"
    _CONTAINER_SESSION_DIR = f"{_CONTAINER_AGENT_DIR}/{_SESSION_DIR_NAME}"
    _LOG_SESSION_DIR = str(EnvironmentPaths.agent_dir / _SESSION_DIR_NAME)
    _OPENAI_CODEX_PROVIDER = "openai-codex"
    _AUTH_UPLOAD_TARGET = "/tmp/atomic-subscription-auth.json"

    _PROVIDER_ENV_KEYS: dict[str, tuple[str, ...]] = {
        "amazon-bedrock": ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"),
        "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"),
        "github-copilot": ("COPILOT_GITHUB_TOKEN",),
        "google": (
            "GEMINI_API_KEY",
            "GOOGLE_GENERATIVE_AI_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "GOOGLE_GENAI_USE_VERTEXAI",
            "GOOGLE_API_KEY",
        ),
        "groq": ("GROQ_API_KEY",),
        # Disabled: unused provider, and huggingface.co also hosts git
        # repos/datasets (code lookup in restricted egress). Re-enable
        # alongside the _PROVIDER_DOMAINS entry if HF inference is needed.
        # "huggingface": ("HF_TOKEN",),
        "mistral": ("MISTRAL_API_KEY",),
        "openai": ("OPENAI_API_KEY",),
        "openai-codex": (),
        "openrouter": ("OPENROUTER_API_KEY",),
        "xai": ("XAI_API_KEY",),
    }
    _BASE_URL_ENV_KEYS: tuple[str, ...] = (
        "ANTHROPIC_BASE_URL",
        "GEMINI_API_BASE",
        "GOOGLE_GEMINI_BASE_URL",
        "GROQ_BASE_URL",
        "GITHUB_COPILOT_BASE_URL",
        "GITHUB_SERVER_URL",
        "COPILOT_API_TARGET",
        # "HF_INFERENCE_ENDPOINT",  # disabled with the huggingface provider
        "MISTRAL_BASE_URL",
        "OPENAI_API_BASE",
        "OPENAI_BASE_URL",
        "OPENROUTER_BASE_URL",
        "XAI_BASE_URL",
    )
    _PROVIDER_DOMAINS: dict[str, tuple[str, ...]] = {
        "amazon-bedrock": (".amazonaws.com",),
        # console.anthropic.com serves the OAuth token endpoint used to
        # refresh provisioned Claude Pro/Max subscription credentials.
        "anthropic": ("api.anthropic.com", "console.anthropic.com"),
        # Copilot inference only. Pier injects COPILOT_GITHUB_TOKEN, which
        # Atomic sends directly to the CAPI hosts as a Bearer token — the
        # github.com device-login and api.github.com copilot_internal token
        # exchange endpoints are only used by interactive OAuth logins and
        # would allowlist GitHub code search/clone in restricted egress.
        "github-copilot": (
            "api.githubcopilot.com",
            "api.business.githubcopilot.com",
            "api.enterprise.githubcopilot.com",
            "api.individual.githubcopilot.com",
            ".githubcopilot.com",
        ),
        "google": (".googleapis.com",),
        "groq": ("api.groq.com",),
        # "huggingface": ("huggingface.co",),  # disabled: unused provider
        "mistral": ("api.mistral.ai",),
        "openai": ("api.openai.com",),
        "openai-codex": ("chatgpt.com", "auth.openai.com"),
        "openrouter": ("openrouter.ai",),
        "xai": ("api.x.ai",),
    }

    CLI_FLAGS = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
        ),
    ]

    @staticmethod
    def name() -> str:
        return "atomic"

    def get_version_command(self) -> str | None:
        return "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; atomic --version"

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    def install_spec(self) -> AgentInstallSpec:
        version_spec = f"@{self._version}" if self._version else "@latest"
        root_run = (
            "if command -v apk &>/dev/null; then"
            "  apk add --no-cache bash curl fd git nodejs npm ripgrep;"
            " elif command -v apt-get &>/dev/null; then"
            "  apt-get update && apt-get install -y --no-install-recommends curl fd-find git ripgrep &&"
            "  ln -sf /usr/bin/fdfind /usr/local/bin/fd &&"
            "  rm -rf /var/lib/apt/lists/*;"
            " elif command -v yum &>/dev/null; then"
            "  yum install -y curl git;"
            " else"
            "  echo 'Warning: No known package manager found, assuming curl is available' >&2;"
            " fi"
        )
        agent_run = (
            "set -euo pipefail; "
            "if command -v apk &>/dev/null; then"
            f"  npm install -g @bastani/atomic{version_spec};"
            " else"
            "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash &&"
            "  export NVM_DIR=\"$HOME/.nvm\" &&"
            "  \\. \"$NVM_DIR/nvm.sh\" || true &&"
            "  command -v nvm &>/dev/null || { echo 'Error: NVM failed to load' >&2; exit 1; } &&"
            "  nvm install 22 && nvm alias default 22 && npm -v &&"
            f"  npm install -g @bastani/atomic{version_spec};"
            " fi && atomic --version"
        )
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[
                InstallStep(
                    user="root",
                    env={"DEBIAN_FRONTEND": "noninteractive"},
                    run=root_run,
                ),
                InstallStep(user="agent", run=agent_run),
            ],
            verification_command=self.get_version_command(),
        )

    def network_allowlist(self) -> NetworkAllowlist:
        if not self.model_name or "/" not in self.model_name:
            return NetworkAllowlist()

        provider, _ = self.model_name.split("/", 1)
        # Atomic workflows can select fallback models from providers other than
        # the top-level Pier --model provider. In Pier's restricted egress mode,
        # narrowing the allowlist to only the requested provider makes valid
        # workflow fallback attempts fail as generic SDK "Connection error"
        # transport failures. Allow every Atomic-supported provider domain here;
        # credentials/model config still decide which providers can actually run.
        defaults: set[str] = set()
        for domains in self._PROVIDER_DOMAINS.values():
            defaults.update(domains)
        urls = [self._get_env(key) for key in self._BASE_URL_ENV_KEYS]
        if provider == "github-copilot":
            urls.append(self._copilot_api_base_url())
        return allowlist_from_urls(urls, default_domains=sorted(defaults))

    def _build_register_skills_command(self) -> str | None:
        if not self.skills_dir:
            return None
        return (
            "mkdir -p $HOME/.agents/skills && "
            f"cp -r {shlex.quote(self.skills_dir)}/* "
            "$HOME/.agents/skills/ 2>/dev/null || true"
        )

    @staticmethod
    def _auth_config_paths() -> tuple[Path, ...]:
        return (
            Path.home() / ".atomic" / "agent" / "auth.json",
            Path.home() / ".pi" / "agent" / "auth.json",
        )

    def _load_provider_auth(self, provider: str) -> dict[str, object] | None:
        merged: dict[str, object] = {}
        for auth_path in reversed(self._auth_config_paths()):
            try:
                data = json.loads(auth_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(data, dict):
                merged.update(data)
        entry = merged.get(provider)
        return entry if isinstance(entry, dict) else None

    def _has_subscription_auth(self, provider: str) -> bool:
        if provider == "anthropic":
            return bool(self._get_env("ANTHROPIC_OAUTH_TOKEN")) or (
                self._load_provider_auth(provider) is not None
            )
        if provider == self._OPENAI_CODEX_PROVIDER:
            return self._load_provider_auth(provider) is not None
        return True

    @staticmethod
    def _openrouter_anthropic_model(model: str) -> str:
        return re.sub(r"-(\d+)-(\d+)$", r"-\1.\2", model)

    def _fallback_model(self, provider: str, model: str) -> tuple[str, str] | None:
        if not self._get_env("OPENROUTER_API_KEY"):
            return None
        if provider == "anthropic":
            return "openrouter", f"anthropic/{self._openrouter_anthropic_model(model)}"
        if provider == self._OPENAI_CODEX_PROVIDER:
            return "openrouter", f"openai/{model}"
        return None

    def _select_provider_model(self, provider: str, model: str) -> tuple[str, str]:
        # The Atomic CLI has no top-level subscription->OpenRouter retry flag; its
        # `fallbackModels` support is scoped to workflow/subagent attempts. For
        # eval runs we therefore select the OpenRouter mirror before launch only
        # when the subscription credential is absent, preserving subscription-first
        # behavior while avoiding a failed primary attempt that cannot recover.
        if not self._has_subscription_auth(provider):
            fallback = self._fallback_model(provider, model)
            if fallback:
                return fallback
        return provider, model

    def _should_provision_subscription_auth(self, provider: str) -> bool:
        if provider == self._OPENAI_CODEX_PROVIDER:
            return True
        # Provision the local Claude Pro/Max OAuth entry only when no explicit
        # env credential is supplied; ANTHROPIC_OAUTH_TOKEN keeps precedence.
        return provider == "anthropic" and not self._get_env("ANTHROPIC_OAUTH_TOKEN")

    async def _provision_subscription_auth(
        self,
        environment: BaseEnvironment,
        provider: str,
    ) -> None:
        if not self._should_provision_subscription_auth(provider):
            return
        entry = self._load_provider_auth(provider)
        if entry is None:
            return
        auth_data = {provider: entry}
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            temp_path = Path(handle.name)
            json.dump(auth_data, handle, indent=2)
            handle.write("\n")
        try:
            os.chmod(temp_path, 0o600)
            await environment.upload_file(temp_path, self._AUTH_UPLOAD_TARGET)
        finally:
            try:
                temp_path.unlink()
            except OSError:
                pass
        if environment.default_user is not None:
            await self.exec_as_root(
                environment,
                command=(
                    f"chown {shlex.quote(str(environment.default_user))} "
                    f"{self._AUTH_UPLOAD_TARGET}"
                ),
            )
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p $HOME/.atomic/agent && chmod 700 $HOME/.atomic/agent && "
                f"install -m 600 {self._AUTH_UPLOAD_TARGET} "
                "$HOME/.atomic/agent/auth.json && "
                f"rm -f {self._AUTH_UPLOAD_TARGET}"
            ),
        )

    @staticmethod
    def _agent_state_env() -> dict[str, str]:
        return {"ATOMIC_CODING_AGENT_DIR": "~/.atomic/agent"}

    @staticmethod
    def _agent_state_setup_command() -> str:
        return (
            "mkdir -p $HOME/.atomic/agent/cache $HOME/.atomic/agent/todos && "
            "chmod 700 $HOME/.atomic/agent && "
            "export ATOMIC_TODO_PATH=\"$HOME/.atomic/agent/todos\"; "
        )

    @staticmethod
    def _session_sync_trap_command(session_dir: str, log_session_dir: str) -> str:
        return (
            "sync_atomic_sessions() { "
            f"mkdir -p {log_session_dir}; "
            f"cp -a {session_dir}/. {log_session_dir}/ 2>/dev/null || true; "
            "}; "
            "sync_atomic_sessions_loop() { "
            "while true; do sync_atomic_sessions; sleep 5; done; "
            "}; "
            "sync_atomic_sessions_loop & atomic_session_sync_pid=$!; "
            "cleanup_atomic_sessions() { "
            "status=${1:-$?}; "
            "sync_atomic_sessions; "
            "kill \"$atomic_session_sync_pid\" 2>/dev/null || true; "
            "wait \"$atomic_session_sync_pid\" 2>/dev/null || true; "
            "return \"$status\"; "
            "}; "
            "trap 'status=$?; cleanup_atomic_sessions \"$status\"; exit \"$status\"' EXIT; "
            "trap 'cleanup_atomic_sessions 143; exit 143' TERM; "
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        requested_provider, requested_model = self.model_name.split("/", 1)
        provider, model = self._select_provider_model(requested_provider, requested_model)
        env = {
            key: value
            for key in (
                *self._PROVIDER_ENV_KEYS.get(provider, ()),
                *(
                    ("OPENROUTER_API_KEY",)
                    if requested_provider in {"anthropic", self._OPENAI_CODEX_PROVIDER}
                    else ()
                ),
            )
            if (value := self._get_env(key))
        }
        env.update(self._agent_state_env())
        copilot_base_url = (
            self._copilot_api_base_url() if provider == "github-copilot" else None
        )

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)
        await self._provision_subscription_auth(environment, requested_provider)

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        session_dir = self._CONTAINER_SESSION_DIR
        log_session_dir = shlex.quote(self._LOG_SESSION_DIR)
        output_file = shlex.quote(str(EnvironmentPaths.agent_dir / self._OUTPUT_FILENAME))
        copilot_config_command = self._copilot_models_config_command(copilot_base_url)
        command = (
            f"rm -rf {session_dir} {log_session_dir} && mkdir -p {session_dir} && "
            f"{self._agent_state_setup_command()}"
            f"{self._session_sync_trap_command(session_dir, log_session_dir)}"
            f"{copilot_config_command}"
            "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi && "
            f"atomic --print --mode json --session-dir {session_dir} "
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
            f"{cli_flags}"
            f"{shlex.quote(instruction)} "
            "2>&1 </dev/null | grep -v '\"type\":\"message_update\"' | "
            f"stdbuf -oL tee {output_file}; status=$?; "
            "exit $status"
        )
        await self.exec_as_agent(environment, command=command, env=env)
        self.populate_context_post_run(context)


    def _copilot_api_base_url(self) -> str:
        api_target = self._get_env("COPILOT_API_TARGET")
        if api_target:
            return self._copilot_url_from_host_or_url(api_target)

        override = self._get_env("GITHUB_COPILOT_BASE_URL")
        if override:
            return self._copilot_url_from_host_or_url(override)

        server_url = self._get_env("GITHUB_SERVER_URL") or "https://github.com"
        return self._copilot_api_base_url_from_server_url(server_url)

    @staticmethod
    def _copilot_url_from_host_or_url(value: str) -> str:
        if value.startswith(("http://", "https://")):
            return value.rstrip("/")
        return f"https://{value}".rstrip("/")

    @staticmethod
    def _ghe_copilot_api_base_url(host: str) -> str:
        prefix = "-".join(("copilot", "api"))
        return f"https://{prefix}.{host}"

    @staticmethod
    def _copilot_api_base_url_from_server_url(server_url: str) -> str:
        host = urlparse(server_url if "://" in server_url else f"https://{server_url}").hostname
        if not host or host == "github.com":
            return "https://api.githubcopilot.com"
        if host.endswith(".ghe.com"):
            return Atomic._ghe_copilot_api_base_url(host)
        return "https://api.enterprise.githubcopilot.com"

    @staticmethod
    def _copilot_models_config_command(base_url: str | None) -> str:
        if not base_url:
            return ""
        models_config = {"providers": {"github-copilot": {"baseUrl": base_url}}}
        config_json = json.dumps(models_config, indent=2)
        return (
            "mkdir -p $HOME/.atomic/agent && chmod 700 $HOME/.atomic/agent && "
            "cat > $HOME/.atomic/agent/models.json <<'ATOMIC_MODELS_JSON'\n"
            f"{config_json}\n"
            "ATOMIC_MODELS_JSON\n"
        )

    @staticmethod
    def _token_count(value: object) -> int:
        return int(value) if isinstance(value, int | float) else 0

    @staticmethod
    def _cost_total(value: object) -> float:
        if isinstance(value, int | float):
            return float(value)
        if not isinstance(value, dict):
            return 0.0
        total = value.get("total")
        if isinstance(total, int | float):
            return float(total)
        return sum(
            float(part)
            for key in ("input", "output", "cacheRead", "cacheWrite")
            if isinstance((part := value.get(key)), int | float)
        )

    @staticmethod
    def _assistant_message_fingerprint(message: object) -> str | None:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            return None
        timestamp = message.get("timestamp")
        if timestamp is None:
            return None
        usage = message.get("usage")
        usage_fingerprint = ""
        if isinstance(usage, dict):
            usage_fingerprint = ":".join(
                str(usage.get(key, ""))
                for key in ("input", "output", "cacheRead", "cacheWrite", "totalTokens")
            )
        message_fingerprint = ":".join(
            str(message.get(key, ""))
            for key in ("timestamp", "provider", "model", "stopReason")
        )
        return f"{message_fingerprint}:{usage_fingerprint}"

    @staticmethod
    def _read_jsonl(path: Path) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict):
                    entries.append(entry)
        except OSError:
            return []
        return entries

    def _read_session_header(self, session_file: Path) -> dict[str, Any] | None:
        for entry in self._read_jsonl(session_file):
            return entry if entry.get("type") == "session" else None
        return None

    def _should_count_session_file(
        self,
        session_file: Path,
        header: dict[str, Any] | None,
    ) -> bool:
        if not header:
            return False
        session_root = self.logs_dir / self._SESSION_DIR_NAME
        if header.get("internal") is True or isinstance(header.get("workflow"), dict):
            return True
        return session_file.parent != session_root

    def _classified_session_files(self) -> list[tuple[Path, bool]]:
        session_root = self.logs_dir / self._SESSION_DIR_NAME
        if not session_root.exists():
            return []
        session_files = sorted(
            (path for path in session_root.rglob("*.jsonl") if path.is_file()),
            key=lambda path: (len(path.parts), str(path)),
        )
        return [
            (path, self._should_count_session_file(path, self._read_session_header(path)))
            for path in session_files
        ]

    @staticmethod
    def _iso_from_message_timestamp(value: object) -> str | None:
        if not isinstance(value, int | float):
            return None
        try:
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()
        except (OSError, OverflowError, ValueError):
            return None

    @staticmethod
    def _jsonable_arguments(value: object) -> dict[str, Any]:
        return value if isinstance(value, dict) else {"value": value}

    def _split_message_content(
        self, message: dict[str, Any]
    ) -> tuple[str, str | None, list[ToolCall] | None]:
        content = message.get("content")
        if isinstance(content, str):
            return content, None, None
        if not isinstance(content, list):
            return "", None, None

        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text" and isinstance(block.get("text"), str):
                text_parts.append(block["text"])
            elif block_type in {"thinking", "redacted_thinking"}:
                thinking = block.get("thinking") or block.get("text")
                if isinstance(thinking, str):
                    reasoning_parts.append(thinking)
            elif block_type == "toolCall":
                tool_id = block.get("id")
                name = block.get("name")
                if isinstance(tool_id, str) and isinstance(name, str):
                    tool_calls.append(
                        ToolCall(
                            tool_call_id=tool_id,
                            function_name=name,
                            arguments=self._jsonable_arguments(block.get("arguments", {})),
                        )
                    )
        return (
            "\n\n".join(part for part in text_parts if part),
            "\n\n".join(part for part in reasoning_parts if part) or None,
            tool_calls or None,
        )

    def _metrics_from_usage(self, usage: object) -> Metrics | None:
        if not isinstance(usage, dict):
            return None
        input_tokens = self._token_count(usage.get("input"))
        output_tokens = self._token_count(usage.get("output"))
        cache_read = self._token_count(usage.get("cacheRead"))
        cache_write = self._token_count(usage.get("cacheWrite"))
        cost = self._cost_total(usage.get("cost"))
        if not any((input_tokens, output_tokens, cache_read, cache_write, cost)):
            return None
        extra = {
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
        }
        return Metrics(
            prompt_tokens=input_tokens + cache_read + cache_write,
            completion_tokens=output_tokens or None,
            cached_tokens=(cache_read + cache_write) or None,
            cost_usd=cost or None,
            extra=extra,
        )

    def _append_observation(
        self,
        steps: list[Step],
        message: dict[str, Any],
        timestamp: str | None,
    ) -> None:
        call_id = message.get("toolCallId")
        content, _, _ = self._split_message_content(message)
        if not content:
            content = json.dumps(message.get("content", ""), ensure_ascii=False)
        source_call_id = call_id if isinstance(call_id, str) else None
        if steps and steps[-1].source == "agent" and source_call_id:
            known = {tc.tool_call_id for tc in steps[-1].tool_calls or []}
            if source_call_id not in known:
                source_call_id = None
        result = ObservationResult(
            source_call_id=source_call_id,
            content=content,
            extra={
                key: value
                for key, value in {
                    "tool_name": message.get("toolName"),
                    "is_error": message.get("isError"),
                }.items()
                if value is not None
            }
            or None,
        )
        if steps and steps[-1].source == "agent":
            if steps[-1].observation is None:
                steps[-1].observation = Observation(results=[])
            steps[-1].observation.results.append(result)
            return
        steps.append(
            Step(
                step_id=len(steps) + 1,
                timestamp=timestamp,
                source="system",
                message="Tool result",
                observation=Observation(results=[result]),
            )
        )

    def _step_from_message(
        self,
        message: dict[str, Any],
        step_id: int,
        timestamp: str | None,
        entry_id: object,
        seen_ids: set[str],
        seen_fingerprints: set[str],
    ) -> Step | None:
        role = message.get("role")
        text, reasoning, tool_calls = self._split_message_content(message)
        if role == "assistant":
            fingerprint = self._assistant_message_fingerprint(message)
            copied = (isinstance(entry_id, str) and entry_id in seen_ids) or (
                fingerprint is not None and fingerprint in seen_fingerprints
            )
            if isinstance(entry_id, str):
                seen_ids.add(entry_id)
            if fingerprint:
                seen_fingerprints.add(fingerprint)
            metrics = None if copied else self._metrics_from_usage(message.get("usage"))
            return Step(
                step_id=step_id,
                timestamp=timestamp,
                source="agent",
                model_name=message.get("model") if isinstance(message.get("model"), str) else None,
                message=text,
                reasoning_content=reasoning,
                tool_calls=tool_calls,
                metrics=metrics,
                is_copied_context=True if copied else None,
                llm_call_count=1 if metrics else None,
            )
        if role == "user":
            return Step(step_id=step_id, timestamp=timestamp, source="user", message=text)
        if role == "bashExecution":
            command = message.get("command")
            output = message.get("output")
            return Step(
                step_id=step_id,
                timestamp=timestamp,
                source="system",
                message=f"bash: {command}" if isinstance(command, str) else "bash",
                observation=Observation(
                    results=[ObservationResult(content=output if isinstance(output, str) else None)]
                ),
            )
        if role in {"custom", "branchSummary"}:
            return Step(step_id=step_id, timestamp=timestamp, source="system", message=text)
        return None

    def _trajectory_from_entries(
        self,
        entries: list[dict[str, Any]],
        trajectory_id: str | None,
        seen_ids: set[str],
        seen_fingerprints: set[str],
    ) -> tuple[Trajectory | None, int]:
        header = entries[0] if entries and entries[0].get("type") == "session" else {}
        steps: list[Step] = []
        summarization_count = 0
        for entry in entries:
            entry_type = entry.get("type")
            if entry_type in {"compaction", "context_compaction"}:
                summarization_count += 1
                continue
            if entry_type != "message":
                continue
            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            timestamp = entry.get("timestamp") if isinstance(entry.get("timestamp"), str) else None
            timestamp = timestamp or self._iso_from_message_timestamp(message.get("timestamp"))
            if message.get("role") == "toolResult":
                self._append_observation(steps, message, timestamp)
                continue
            step = self._step_from_message(
                message,
                len(steps) + 1,
                timestamp,
                entry.get("id"),
                seen_ids,
                seen_fingerprints,
            )
            if step:
                steps.append(step)
        if not steps:
            return None, summarization_count
        trajectory = Trajectory(
            session_id=header.get("id") if isinstance(header.get("id"), str) else None,
            trajectory_id=trajectory_id,
            agent=Agent(
                name=self.name(),
                version=self.version() or "unknown",
                model_name=self.model_name,
            ),
            steps=steps,
        )
        return trajectory, summarization_count

    def _trajectory_from_output_events(
        self,
        seen_ids: set[str],
        seen_fingerprints: set[str],
    ) -> Trajectory | None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        events = self._read_jsonl(output_file) if output_file.exists() else []
        entries = [
            {"type": "message", "message": event.get("message")}
            for event in events
            if event.get("type") == "message_end" and isinstance(event.get("message"), dict)
        ]
        trajectory, _ = self._trajectory_from_entries(entries, None, seen_ids, seen_fingerprints)
        return trajectory

    @staticmethod
    def _metric_totals(steps: list[Step]) -> tuple[int, int, int, float, int | None]:
        prompt = completion = cached = 0
        cost = 0.0
        peak: int | None = None
        for step in steps:
            if step.source != "agent" or step.metrics is None:
                continue
            metrics = step.metrics
            prompt += metrics.prompt_tokens or 0
            completion += metrics.completion_tokens or 0
            cached += metrics.cached_tokens or 0
            cost += metrics.cost_usd or 0.0
            if metrics.prompt_tokens is not None:
                peak = metrics.prompt_tokens if peak is None else max(peak, metrics.prompt_tokens)
        return prompt, completion, cached, cost, peak

    def _write_trajectory(self, context: AgentContext, classified: list[tuple[Path, bool]]) -> None:
        seen_ids: set[str] = set()
        seen_fingerprints: set[str] = set()
        main_files = [path for path, should_count in classified if not should_count]
        subagent_files = [path for path, should_count in classified if should_count]

        root: Trajectory | None = None
        summarization_count = 0
        if main_files:
            root, count = self._trajectory_from_entries(
                self._read_jsonl(main_files[0]), None, seen_ids, seen_fingerprints
            )
            summarization_count += count
        if root is None:
            root = self._trajectory_from_output_events(seen_ids, seen_fingerprints)
        if root is None:
            return

        subagents: list[Trajectory] = []
        for index, session_file in enumerate(subagent_files, start=1):
            trajectory, count = self._trajectory_from_entries(
                self._read_jsonl(session_file),
                f"atomic-session-{index}",
                seen_ids,
                seen_fingerprints,
            )
            summarization_count += count
            if trajectory:
                subagents.append(trajectory)
        if subagents:
            root.subagent_trajectories = subagents

        all_steps = root.steps + [step for traj in subagents for step in traj.steps]
        prompt, completion, cached, cost, peak = self._metric_totals(all_steps)
        root.final_metrics = FinalMetrics(
            total_prompt_tokens=prompt or None,
            total_completion_tokens=completion or None,
            total_cached_tokens=cached or None,
            total_cost_usd=cost or None,
            total_steps=len(all_steps),
            extra={
                key: value
                for key, value in {
                    "peak_context_tokens": peak,
                    "summarization_count": summarization_count or None,
                }.items()
                if value is not None
            }
            or None,
        )
        context.peak_context_tokens = peak
        context.summarization_count = summarization_count or None
        context.n_agent_steps = sum(1 for step in all_steps if step.source == "agent")

        trajectory_path = self.logs_dir / "trajectory.json"
        try:
            trajectory_path.write_text(
                format_trajectory_json(root.to_json_dict()), encoding="utf-8"
            )
        except OSError as exc:
            self.logger.debug("Failed to write Atomic trajectory: %s", exc)

    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            return

        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cache_write_tokens = 0
        total_cost = 0.0
        seen_message_ids: set[str] = set()
        seen_message_fingerprints: set[str] = set()

        def add_assistant_message_usage(message: object, entry_id: object = None) -> None:
            nonlocal total_input_tokens, total_output_tokens
            nonlocal total_cache_read_tokens, total_cache_write_tokens, total_cost
            if not isinstance(message, dict) or message.get("role") != "assistant":
                return
            usage = message.get("usage")
            if not isinstance(usage, dict):
                return
            fingerprint = self._assistant_message_fingerprint(message)
            if isinstance(entry_id, str):
                if entry_id in seen_message_ids:
                    return
            elif fingerprint and fingerprint in seen_message_fingerprints:
                return
            if isinstance(entry_id, str):
                seen_message_ids.add(entry_id)
            if fingerprint:
                seen_message_fingerprints.add(fingerprint)
            total_input_tokens += self._token_count(usage.get("input"))
            total_output_tokens += self._token_count(usage.get("output"))
            total_cache_read_tokens += self._token_count(usage.get("cacheRead"))
            total_cache_write_tokens += self._token_count(usage.get("cacheWrite"))
            total_cost += self._cost_total(usage.get("cost"))

        def mark_assistant_message_seen(message: object, entry_id: object = None) -> None:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                return
            if isinstance(entry_id, str):
                seen_message_ids.add(entry_id)
            fingerprint = self._assistant_message_fingerprint(message)
            if fingerprint:
                seen_message_fingerprints.add(fingerprint)

        def read_session_messages(session_file: Path, *, count_usage: bool) -> None:
            for entry in self._read_jsonl(session_file):
                if entry.get("type") != "message":
                    continue
                message = entry.get("message")
                if count_usage:
                    add_assistant_message_usage(message, entry.get("id"))
                else:
                    mark_assistant_message_seen(message, entry.get("id"))

        for event in self._read_jsonl(output_file):
            if event.get("type") == "message_end":
                add_assistant_message_usage(event.get("message") or {})

        classified = self._classified_session_files()
        for session_file, should_count in classified:
            if not should_count:
                read_session_messages(session_file, count_usage=False)
        for session_file, should_count in classified:
            if should_count:
                read_session_messages(session_file, count_usage=True)

        total_cache_tokens = total_cache_read_tokens + total_cache_write_tokens
        context.n_input_tokens = total_input_tokens + total_cache_tokens
        context.n_output_tokens = total_output_tokens
        context.n_cache_tokens = total_cache_tokens
        context.cost_usd = total_cost if total_cost > 0 else None
        self._write_trajectory(context, classified)
