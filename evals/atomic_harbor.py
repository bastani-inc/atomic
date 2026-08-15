import json
import os
import re
import shlex
import tempfile
from pathlib import Path
from typing import cast, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from prerequisites import (
    PROVIDER_AUTH_ENV_KEYS,
    agent_install_command,
    atomic_runtime_environment_command,
    root_install_command,
)
from run_manifest import (
    MANIFEST_FILENAME,
    RunManifest,
    manifest_for_agent_logs_dir,
    recorded_atomic_version,
    write_manifest,
)
from trial_audit import (
    REASON_EMPTY_OUTPUT,
    REASON_MALFORMED_SESSION_LOG,
    REASON_MANIFEST_NOT_WRITTEN,
    REASON_MISSING_OUTPUT,
    REASON_UNRESOLVED_VERSION,
    AgentRunStatus,
    write_agent_status,
)


class Atomic(BaseInstalledAgent):
    _OUTPUT_FILENAME = "atomic.txt"
    _SESSION_DIR_NAME = "atomic-sessions"
    _CONTAINER_SESSION_DIR = f"$HOME/.atomic/agent/{_SESSION_DIR_NAME}"
    _LOG_SESSION_DIR = f"/logs/agent/{_SESSION_DIR_NAME}"
    _OPENAI_CODEX_PROVIDER = "openai-codex"
    _AUTH_UPLOAD_TARGET = "/tmp/atomic-subscription-auth.json"
    # Shared with the Pier adapter and the credential preflight so the three
    # cannot disagree about which providers are supported. Harbor keeps
    # `huggingface`, which Pier disables: Pier's restricted-egress allowlist
    # would have to grant huggingface.co, which also serves git repos and
    # datasets, while Harbor builds no such overlay.
    _PROVIDER_AUTH_ENV_KEYS: dict[str, tuple[str, ...]] = {
        **PROVIDER_AUTH_ENV_KEYS,
        "huggingface": ("HF_TOKEN",),
    }
    # What `run()` forwards into the sandbox: every credential above, plus the
    # region and Vertex routing variables and the credential-free Codex
    # subscription.
    _PROVIDER_ENV_KEYS: dict[str, tuple[str, ...]] = {
        **_PROVIDER_AUTH_ENV_KEYS,
        "amazon-bedrock": (*_PROVIDER_AUTH_ENV_KEYS["amazon-bedrock"], "AWS_REGION"),
        "google": (
            *_PROVIDER_AUTH_ENV_KEYS["google"],
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "GOOGLE_GENAI_USE_VERTEXAI",
        ),
        "openai-codex": (),
    }

    CLI_FLAGS = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
        ),
    ]

    @override
    def __init__(
        self,
        logs_dir: Path,
        prompt_template_path: Path | str | None = None,
        version: str | None = None,
        extra_env: dict[str, str] | None = None,
        *,
        disallowed_subscriptions: str | list[str] | tuple[str, ...] | None = None,
        **kwargs: object,
    ) -> None:
        self._disallowed_subscriptions: frozenset[str] = (
            self._normalize_disallowed_subscriptions(disallowed_subscriptions)
        )
        # The version the container actually installed, and the candidate the
        # session launched on — both differ from what was requested when the
        # request is a moving tag (`version=next`) or a fallback candidate runs.
        self._resolved_version: str | None = None
        self._selected_model: str | None = None
        self._manifest_write_failed = False
        self._version_unresolved = False
        super().__init__(
            logs_dir=logs_dir,
            prompt_template_path=prompt_template_path,
            version=version,
            extra_env=extra_env,
            **kwargs,
        )

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        """Install as usual, then resolve the version the container really has.

        Harbor had no such override, so an explicit moving request such as
        ``--version next`` was recorded verbatim and two runs of different
        builds compared as equal. Pier auto-detects a version only when none was
        requested, which never covers the explicit case; ``self._version`` stays
        the requested spec because ``install()`` interpolates it into
        ``npm install -g @bastani/atomic@<spec>``.
        """
        await super().setup(environment)
        version_command = self.get_version_command()
        if not version_command:
            return
        try:
            result = await environment.exec(command=version_command)
        except Exception as exc:  # noqa: BLE001 - version detection is best-effort
            self.logger.debug("Atomic version detection failed: %s", exc)
            return
        stdout = cast(str | None, getattr(result, "stdout", None))
        if getattr(result, "return_code", 1) == 0 and stdout:
            try:
                self._resolved_version = self.parse_version(stdout)
            except (IndexError, ValueError) as exc:
                self.logger.debug("Could not parse Atomic version output: %s", exc)

    @staticmethod
    def _normalize_disallowed_subscriptions(value: object) -> frozenset[str]:
        if value is None:
            return frozenset()
        values = [value] if isinstance(value, str) else value
        if not isinstance(values, list | tuple):
            raise TypeError(
                "disallowed_subscriptions must be a string or list of strings"
            )
        subscriptions: set[str] = set()
        for item in values:
            if not isinstance(item, str):
                raise TypeError(
                    "disallowed_subscriptions must contain only provider names"
                )
            subscriptions.update(
                name.strip() for name in item.split(",") if name.strip()
            )
        return frozenset(subscriptions)

    @staticmethod
    @override
    def name() -> str:
        return "atomic"

    @override
    def get_version_command(self) -> str | None:
        return f"{atomic_runtime_environment_command()}; atomic --version"

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
            provider: cast(dict[str, object], entry)
            for provider, entry in merged.items()
            if provider
            and provider not in self._disallowed_subscriptions
            and self._is_valid_provider_auth(entry)
        }

    def _load_provider_auth(self, provider: str) -> dict[str, object] | None:
        return self._load_provider_auths().get(provider)

    def _has_subscription_auth(self, provider: str) -> bool:
        if provider == "anthropic":
            # Atomic exposes no way to tell an Anthropic subscription apart from
            # an API key: both route through the same `anthropic` provider, so
            # either credential keeps `anthropic` as the primary candidate.
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

    def _model_chain(self, provider: str, model: str) -> list[tuple[str, str]]:
        """Ordered `(provider, model)` candidates for the requested model.

        Codex walks `openai-codex` -> `openai` -> `openrouter`; Anthropic walks
        `anthropic` -> `openrouter`. A candidate is listed only when its
        credential is present, so the chain never names a provider the sandbox
        cannot authenticate.
        """
        chain: list[tuple[str, str]] = []
        if self._has_subscription_auth(provider):
            chain.append((provider, model))
        if provider == self._OPENAI_CODEX_PROVIDER:
            if self._get_env("OPENAI_API_KEY"):
                chain.append(("openai", model))
            if self._get_env("OPENROUTER_API_KEY"):
                chain.append(("openrouter", f"openai/{model}"))
        elif provider == "anthropic" and self._get_env("OPENROUTER_API_KEY"):
            chain.append(
                ("openrouter", f"anthropic/{self._openrouter_anthropic_model(model)}")
            )
        return chain or [(provider, model)]

    @staticmethod
    def _fallback_settings_command(chain: list[tuple[str, str]]) -> str:
        """Seed main-chat `settings.fallbackModels` with the chain after the primary.

        Atomic only starts a session on a model it can authenticate, so the
        first credentialed candidate is selected before launch. The rest become
        `fallbackModels`, which main-chat turns walk on rate limits, quota
        exhaustion, and provider errors.

        The adapter owns this file. Each trial provisions a fresh sandbox agent
        directory, and nothing else in the image writes `settings.json`, so a
        whole-document write has nothing to preserve. Atomic's own writes go the
        other way safely: `persistScopedSettings` re-reads the file and replaces
        only the fields it modified, so a `defaultModel` write during the run
        does not drop these entries.
        """
        fallback_models = [
            f"{candidate_provider}/{candidate_model}"
            for candidate_provider, candidate_model in chain[1:]
        ]
        if not fallback_models:
            return ""
        settings = json.dumps({"fallbackModels": fallback_models}, indent=2)
        return (
            f"printf '%s\\n' {shlex.quote(settings)} "
            '> "$HOME/.atomic/agent/settings.json"; '
        )

    async def _provision_subscription_auth(
        self,
        environment: BaseEnvironment,
        provider: str,
        env: dict[str, str] | None = None,
    ) -> None:
        auth_data = self._load_provider_auths()
        if env is None:
            keys = list(self._PROVIDER_AUTH_ENV_KEYS.get(provider, ()))
            if provider == self._OPENAI_CODEX_PROVIDER:
                keys.append("OPENAI_API_KEY")
            if provider in {"anthropic", self._OPENAI_CODEX_PROVIDER}:
                keys.append("OPENROUTER_API_KEY")
            environment_keys = {
                key: value for key in keys if (value := self._get_env(key))
            }
        else:
            environment_keys = env.copy()
        for credential_keys in self._PROVIDER_AUTH_ENV_KEYS.values():
            for key in credential_keys:
                if value := self._get_env(key):
                    environment_keys[key] = value
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

    @override
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
        chain = self._model_chain(requested_provider, requested_model)
        provider, model = chain[0]
        # The candidate the session actually launches on, which is not the
        # request whenever a subscription is absent. The manifest used to fall
        # straight back to the request, so a cancelled or metadata-light run
        # recorded a model that never ran.
        self._selected_model = f"{provider}/{model}"

        env: dict[str, str] = {}
        # Forward credentials for every provider in the fallback chain, not just
        # the selected one: a main-chat fallback attempt needs its own key
        # inside the sandbox.
        keys = [
            key
            for candidate_provider, _ in chain
            for key in self._PROVIDER_ENV_KEYS.get(candidate_provider, ())
        ]

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
                f"{self._fallback_settings_command(chain)}"
                f"{self._session_sync_trap_command(session_dir, log_session_dir)}"
                f"{atomic_runtime_environment_command()} && "
                f"atomic --print --mode json --session-dir {session_dir} "
                f"{model_args}"
                f"{cli_flags}"
                f"-- {escaped_instruction} "
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
        """Return the first JSONL record of a session file, or ``None``.

        Decoded with replacement, like every other reader here. Strict text
        decoding raised ``UnicodeDecodeError`` — a ``ValueError``, so neither
        ``OSError`` nor ``JSONDecodeError`` caught it — on a first line
        truncated mid-UTF-8, and that killed ``populate_context_post_run``
        before it could write any status at all. A truncated header is exactly
        the corruption S6 requires the run to report, so it must answer
        ``None`` and let the message reader count the malformed line.
        """
        try:
            text = session_file.read_bytes().decode("utf-8", errors="replace")
        except OSError:
            return None
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                header = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                return None
            return header if isinstance(header, dict) else None
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

    def _record_agent_status(
        self, context: AgentContext, reasons: list[str], details: dict[str, object]
    ) -> AgentRunStatus:
        """Persist an explicit run status and stamp it onto the agent context.

        A manifest that could not be persisted, or a version that could not be
        resolved, is folded in here, on every path, because
        `_record_run_manifest` runs first and cannot report it itself.
        """
        if self._manifest_write_failed and REASON_MANIFEST_NOT_WRITTEN not in reasons:
            reasons = [*reasons, REASON_MANIFEST_NOT_WRITTEN]
            details = {**details, "manifest_path": str(self.logs_dir / MANIFEST_FILENAME)}
        if self._version_unresolved and REASON_UNRESOLVED_VERSION not in reasons:
            reasons = [*reasons, REASON_UNRESOLVED_VERSION]
            details = {**details, "requested_version": self.version()}
        status = AgentRunStatus.from_reasons(reasons, details)
        write_agent_status(self.logs_dir, status)
        context.metadata = {**(context.metadata or {}), "atomic_status": status.to_json()}
        return status

    def _observed_model(self) -> str | None:
        """The provider/model that actually answered, read from the agent stream."""
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            return None
        observed: str | None = None
        try:
            text = output_file.read_bytes().decode("utf-8", errors="replace")
        except OSError:
            return None
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.startswith("{"):
                continue
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            message = event.get("message") if isinstance(event, dict) else None
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            provider = message.get("provider")
            model = message.get("model")
            if isinstance(provider, str) and provider and isinstance(model, str) and model:
                observed = f"{provider}/{model}"
        return observed

    def _record_run_manifest(self, context: AgentContext) -> RunManifest:
        """Record which corpus, pier checkout, Atomic build, and model ran.

        Harbor's trial layout matches Pier's (``trial_dir/{agent,artifacts}``)
        and its job directory carries ``config.json``/``result.json``, so the
        same reader works. Harbor has no seed concept at all, so ``seed`` is
        recorded as ``null`` and two Harbor runs refuse to compare on it.

        Model precedence: what answered (from the stream) > the candidate the
        session launched on > the requested ``--model``. Version precedence:
        what the container reported after install > the requested spec, and only
        when that spec is pinned — a moving request that could not be resolved
        records nothing rather than letting two builds compare as equal.
        """
        version = recorded_atomic_version(self._resolved_version, self.version())
        self._version_unresolved = version is None
        manifest = manifest_for_agent_logs_dir(
            self.logs_dir,
            model=self._observed_model() or self._selected_model or self.model_name,
            atomic_version=version,
        )
        self._manifest_write_failed = write_manifest(self.logs_dir, manifest) is None
        context.metadata = {**(context.metadata or {}), "atomic_manifest": manifest.to_json()}
        return manifest

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        self._malformed_jsonl_lines: dict[str, int] = {}
        self._record_run_manifest(context)
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            # An absent atomic.txt means the agent produced no output at all.
            # Returning silently here is what made a dead trial look complete.
            self._record_agent_status(
                context, [REASON_MISSING_OUTPUT], {"expected": str(output_file)}
            )
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
            # Decode defensively: invalid UTF-8 is corruption, and raising
            # UnicodeDecodeError here (a ValueError, not an OSError) used to take
            # the whole status write down with it.
            try:
                text = session_file.read_bytes().decode("utf-8", errors="replace")
            except OSError:
                return
            if "\ufffd" in text:
                self._malformed_jsonl_lines[str(session_file)] = (
                    self._malformed_jsonl_lines.get(str(session_file), 0) + 1
                )
            for line in text.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    # Session transcripts are machine-written: any undecodable
                    # line is corruption, whatever byte it starts with.
                    # (atomic.txt below keeps the first-byte tolerance, because
                    # Atomic interleaves plain-text diagnostics there.)
                    self._malformed_jsonl_lines[str(session_file)] = (
                        self._malformed_jsonl_lines.get(str(session_file), 0) + 1
                    )
                    continue
                if not isinstance(entry, dict) or entry.get("type") != "message":
                    continue
                message = entry.get("message")
                if count_usage:
                    add_assistant_message_usage(message, entry.get("id"))
                else:
                    mark_assistant_message_seen(message, entry.get("id"))

        try:
            output_text = output_file.read_bytes().decode("utf-8", errors="replace")
        except OSError:
            output_text = ""
        if "\ufffd" in output_text:
            self._malformed_jsonl_lines[str(output_file)] = (
                self._malformed_jsonl_lines.get(str(output_file), 0) + 1
            )
        for line in output_text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                if line.startswith(("{", "[")):
                    self._malformed_jsonl_lines[str(output_file)] = (
                        self._malformed_jsonl_lines.get(str(output_file), 0) + 1
                    )
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

        reasons: list[str] = []
        details: dict[str, object] = {"atomic_txt": str(output_file)}
        if output_file.stat().st_size == 0:
            reasons.append(REASON_EMPTY_OUTPUT)
        if self._malformed_jsonl_lines:
            reasons.append(REASON_MALFORMED_SESSION_LOG)
            details["malformed_jsonl_lines"] = dict(self._malformed_jsonl_lines)
        self._record_agent_status(context, reasons, details)
