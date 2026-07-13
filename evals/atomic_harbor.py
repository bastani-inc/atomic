import json
import os
import re
import shlex
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from prerequisites import (
    agent_install_command,
    root_install_command,
    runtime_environment_command,
)


class Atomic(BaseInstalledAgent):
    _OUTPUT_FILENAME = "atomic.txt"
    _SESSION_DIR_NAME = "atomic-sessions"
    _CONTAINER_SESSION_DIR = f"$HOME/.atomic/agent/{_SESSION_DIR_NAME}"
    _LOG_SESSION_DIR = f"/logs/agent/{_SESSION_DIR_NAME}"
    _OPENAI_CODEX_PROVIDER = "openai-codex"
    _AUTH_UPLOAD_TARGET = "/tmp/atomic-subscription-auth.json"
    _PROVIDER_AUTH_ENV_KEYS: dict[str, tuple[str, ...]] = {
        "amazon-bedrock": ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"),
        "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"),
        "github-copilot": ("COPILOT_GITHUB_TOKEN",),
        "google": (
            "GEMINI_API_KEY",
            "GOOGLE_GENERATIVE_AI_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_API_KEY",
        ),
        "groq": ("GROQ_API_KEY",),
        "huggingface": ("HF_TOKEN",),
        "mistral": ("MISTRAL_API_KEY",),
        "openai": ("OPENAI_API_KEY",),
        "openrouter": ("OPENROUTER_API_KEY",),
        "xai": ("XAI_API_KEY",),
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
    @override
    def name() -> str:
        return "atomic"

    @override
    def get_version_command(self) -> str | None:
        return f"{runtime_environment_command()}; . ~/.nvm/nvm.sh; atomic --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=root_install_command(harbor=True),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=agent_install_command(version_spec),
        )

    def _build_register_skills_command(self) -> str | None:
        """Return a shell command that copies skills to Atomic's skills directory."""
        if not self.skills_dir:
            return None
        return (
            f"mkdir -p $HOME/.agents/skills && "
            f"cp -r {shlex.quote(self.skills_dir)}/* "
            f"$HOME/.agents/skills/ 2>/dev/null || true"
        )

    @staticmethod
    def _auth_config_paths() -> tuple[Path, ...]:
        return (
            Path.home() / ".atomic" / "agent" / "auth.json",
            Path.home() / ".pi" / "agent" / "auth.json",
        )

    @staticmethod
    def _is_valid_provider_auth(entry: object) -> bool:
        if not isinstance(entry, dict):
            return False
        credential_type = entry.get("type")
        if credential_type == "api_key":
            return isinstance(entry.get("key"), str) and bool(entry["key"])
        if credential_type == "oauth":
            return isinstance(entry.get("access"), str) and bool(entry["access"])
        return False

    def _load_provider_auths(self) -> dict[str, dict[str, object]]:
        merged: dict[str, object] = {}
        for auth_path in reversed(self._auth_config_paths()):
            try:
                data = json.loads(auth_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(data, dict):
                merged.update(data)
        return {
            provider: entry
            for provider, entry in merged.items()
            if isinstance(provider, str)
            and provider
            and self._is_valid_provider_auth(entry)
        }

    def _load_provider_auth(self, provider: str) -> dict[str, object] | None:
        return self._load_provider_auths().get(provider)

    def _has_subscription_auth(self, provider: str) -> bool:
        if provider == "anthropic":
            return bool(
                self._get_env("ANTHROPIC_API_KEY")
                or self._get_env("ANTHROPIC_OAUTH_TOKEN")
                or self._load_provider_auth(provider) is not None
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

    async def _provision_subscription_auth(
        self,
        environment: BaseEnvironment,
        provider: str,
        env: dict[str, str] | None = None,
    ) -> None:
        auth_data = self._load_provider_auths()
        if env is None:
            keys = list(self._PROVIDER_AUTH_ENV_KEYS.get(provider, ()))
            if provider in {"anthropic", self._OPENAI_CODEX_PROVIDER}:
                keys.append("OPENROUTER_API_KEY")
            environment_keys = {
                key: value for key in keys if (value := self._get_env(key))
            }
        else:
            environment_keys = env
        for auth_provider, credential_keys in self._PROVIDER_AUTH_ENV_KEYS.items():
            has_environment_auth = (
                all(environment_keys.get(key) for key in credential_keys)
                if auth_provider == "amazon-bedrock"
                else any(environment_keys.get(key) for key in credential_keys)
            )
            if has_environment_auth:
                auth_data.pop(auth_provider, None)
        if not auth_data:
            return
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
            f"chmod -R a+rwX {log_session_dir} 2>/dev/null || true; "
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
        escaped_instruction = shlex.quote(instruction)

        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        requested_provider, requested_model = self.model_name.split("/", 1)
        provider, model = self._select_provider_model(requested_provider, requested_model)

        env: dict[str, str] = {}
        provider_env_keys: dict[str, tuple[str, ...]] = {
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
            "huggingface": ("HF_TOKEN",),
            "mistral": ("MISTRAL_API_KEY",),
            "openai": ("OPENAI_API_KEY",),
            "openai-codex": (),
            "openrouter": ("OPENROUTER_API_KEY",),
            "xai": ("XAI_API_KEY",),
        }
        keys = list(provider_env_keys.get(provider, ()))
        if requested_provider in {"anthropic", self._OPENAI_CODEX_PROVIDER}:
            keys.append("OPENROUTER_API_KEY")

        for key in keys:
            val = self._get_env(key)
            if val:
                env[key] = val
        env.update(self._agent_state_env())

        model_args = f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)
        await self._provision_subscription_auth(environment, requested_provider, env)

        # Atomic state stays under the container user's ~/.atomic/agent; after
        # the run, transcripts are copied to /logs for Harbor artifact parsing.
        session_dir = self._CONTAINER_SESSION_DIR
        log_session_dir = shlex.quote(self._LOG_SESSION_DIR)

        await self.exec_as_agent(
            environment,
            command=(
                f"rm -rf {session_dir} {log_session_dir} && mkdir -p {session_dir} && "
                f"{self._agent_state_setup_command()}"
                f"{self._session_sync_trap_command(session_dir, log_session_dir)}"
                f"{runtime_environment_command()} && "
                f". ~/.nvm/nvm.sh && "
                f"atomic --print --mode json --session-dir {session_dir} "
                f"{model_args}"
                f"{cli_flags}"
                f"{escaped_instruction} "
                "2>&1 </dev/null | grep -v '\"type\":\"message_update\"' | "
                f"stdbuf -oL tee /logs/agent/{self._OUTPUT_FILENAME}; status=$?; "
                "exit $status"
            ),
            env=env,
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
    def _read_session_header(session_file: Path) -> dict[str, object] | None:
        try:
            with session_file.open(encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    header = json.loads(line)
                    return header if isinstance(header, dict) else None
        except (OSError, json.JSONDecodeError, TypeError):
            return None
        return None

    def _should_count_session_file(
        self,
        session_file: Path,
        header: dict[str, object] | None,
    ) -> bool:
        if not header or header.get("type") != "session":
            return False
        session_root = self.logs_dir / self._SESSION_DIR_NAME
        if header.get("internal") is True or isinstance(header.get("workflow"), dict):
            return True
        return session_file.parent != session_root

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            return

        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cache_write_tokens = 0
        total_cost = 0.0
        total_agent_steps = 0
        seen_message_ids: set[str] = set()
        seen_message_fingerprints: set[str] = set()

        def add_assistant_message_usage(
            message: object,
            entry_id: object = None,
        ) -> None:
            nonlocal total_input_tokens, total_output_tokens, total_agent_steps
            nonlocal total_cache_read_tokens, total_cache_write_tokens, total_cost
            if not isinstance(message, dict) or message.get("role") != "assistant":
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
            total_agent_steps += 1
            usage = message.get("usage")
            if not isinstance(usage, dict):
                return
            total_input_tokens += self._token_count(usage.get("input"))
            total_output_tokens += self._token_count(usage.get("output"))
            total_cache_read_tokens += self._token_count(usage.get("cacheRead"))
            total_cache_write_tokens += self._token_count(usage.get("cacheWrite"))
            total_cost += self._cost_total(usage.get("cost"))

        def mark_assistant_message_seen(
            message: object,
            entry_id: object = None,
        ) -> None:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                return
            if isinstance(entry_id, str):
                seen_message_ids.add(entry_id)
            fingerprint = self._assistant_message_fingerprint(message)
            if fingerprint:
                seen_message_fingerprints.add(fingerprint)

        def read_session_messages(session_file: Path, *, count_usage: bool) -> None:
            try:
                with session_file.open(encoding="utf-8") as handle:
                    for line in handle:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(entry, dict) or entry.get("type") != "message":
                            continue
                        message = entry.get("message")
                        if count_usage:
                            add_assistant_message_usage(message, entry.get("id"))
                        else:
                            mark_assistant_message_seen(message, entry.get("id"))
            except OSError:
                return

        for line in output_file.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict) or event.get("type") != "message_end":
                continue
            add_assistant_message_usage(event.get("message") or {})

        # Workflow stages (and nested child sessions they spawn) are persisted
        # under the run log session directory. Count those transcripts too,
        # while using the top-level main chat session only for de-duplication.
        session_root = self.logs_dir / self._SESSION_DIR_NAME
        if session_root.exists():
            session_files = [
                path for path in session_root.rglob("*.jsonl") if path.is_file()
            ]
            classified_session_files = [
                (path, self._should_count_session_file(path, self._read_session_header(path)))
                for path in session_files
            ]
            for session_file, should_count in classified_session_files:
                if not should_count:
                    read_session_messages(session_file, count_usage=False)
            for session_file, should_count in classified_session_files:
                if should_count:
                    read_session_messages(session_file, count_usage=True)

        total_cache_tokens = total_cache_read_tokens + total_cache_write_tokens
        context.n_input_tokens = total_input_tokens + total_cache_tokens
        context.n_output_tokens = total_output_tokens
        context.n_cache_tokens = total_cache_tokens
        context.cost_usd = total_cost if total_cost > 0 else None
        context.metadata = {
            **(context.metadata or {}),
            "n_agent_steps": total_agent_steps,
        }
