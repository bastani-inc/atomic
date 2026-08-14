# pyright: reportMissingTypeStubs=false

from __future__ import annotations

import json
import os
import re
import shlex
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar, cast, override
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
from pier.utils.trajectory_utils import (
    format_trajectory_json,  # pyright: ignore[reportUnknownVariableType]
)
from network_policy import EmptyEgressAllowlistError, require_non_empty_allowlist
from prerequisites import (
    PROVIDER_AUTH_ENV_KEYS,
    agent_install_command,
    atomic_runtime_environment_command,
    is_valid_provider_auth,
    root_install_command,
)
from run_manifest import (
    MANIFEST_FILENAME,
    RunManifest,
    manifest_for_agent_logs_dir,
    write_manifest,
)
from trial_audit import (
    REASON_EMPTY_OUTPUT,
    REASON_MALFORMED_SESSION_LOG,
    REASON_MANIFEST_NOT_WRITTEN,
    REASON_MISSING_OUTPUT,
    AgentRunStatus,
    explain,
    write_agent_status,
)


type JsonValue = str | int | float | bool | None | list[JsonValue] | JsonObject
type JsonObject = dict[str, JsonValue]


def _json_object(value: object) -> JsonObject | None:
    if not isinstance(value, dict):
        return None
    return cast(JsonObject, value)


class Atomic(BaseInstalledAgent):
    """Pier installed-agent adapter for the Atomic coding agent."""

    SUPPORTS_ATIF: bool = True

    _OUTPUT_FILENAME: ClassVar[str] = "atomic.txt"
    _SESSION_DIR_NAME: ClassVar[str] = "atomic-sessions"
    _CONTAINER_AGENT_DIR: ClassVar[str] = "$HOME/.atomic/agent"
    _CONTAINER_SESSION_DIR: ClassVar[str] = (
        f"{_CONTAINER_AGENT_DIR}/{_SESSION_DIR_NAME}"
    )
    _LOG_SESSION_DIR: ClassVar[str] = str(
        EnvironmentPaths.agent_dir / _SESSION_DIR_NAME
    )
    _OPENAI_CODEX_PROVIDER: ClassVar[str] = "openai-codex"
    _AUTH_UPLOAD_TARGET: ClassVar[str] = "/tmp/atomic-subscription-auth.json"

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
        # Kimi/Moonshot and ZAI env keys mirror pi-ai's provider registry
        # (getApiKeyEnvVars in @earendil-works/pi-ai env-api-keys).
        "kimi-coding": ("KIMI_API_KEY",),
        "mistral": ("MISTRAL_API_KEY",),
        "moonshotai": ("MOONSHOT_API_KEY",),
        "moonshotai-cn": ("MOONSHOT_API_KEY",),
        "openai": ("OPENAI_API_KEY",),
        "openai-codex": (),
        "openrouter": ("OPENROUTER_API_KEY",),
        "xai": ("XAI_API_KEY",),
        "zai": ("ZAI_API_KEY",),
        "zai-coding-cn": ("ZAI_CODING_CN_API_KEY",),
    }
    # Single source of truth lives in prerequisites.py so the preflight checks
    # exactly the providers this adapter forwards. The import direction is
    # one-way: prerequisites must never import an adapter.
    _PROVIDER_AUTH_ENV_KEYS: dict[str, tuple[str, ...]] = PROVIDER_AUTH_ENV_KEYS
    _BASE_URL_ENV_KEYS: tuple[str, ...] = (
        "ANTHROPIC_BASE_URL",
        "GEMINI_API_BASE",
        "GOOGLE_GEMINI_BASE_URL",
        "GROQ_BASE_URL",
        "GITHUB_COPILOT_BASE_URL",
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
        # Kimi/Moonshot and ZAI domains come from pi-ai's provider base URLs:
        # kimi-coding -> https://api.kimi.com/coding
        # moonshotai -> https://api.moonshot.ai/v1
        # moonshotai-cn -> https://api.moonshot.cn/v1
        # zai -> https://api.z.ai/api/coding/paas/v4
        # zai-coding-cn -> https://open.bigmodel.cn/api/coding/paas/v4
        "kimi-coding": ("api.kimi.com",),
        "mistral": ("api.mistral.ai",),
        "moonshotai": ("api.moonshot.ai",),
        "moonshotai-cn": ("api.moonshot.cn",),
        "openai": ("api.openai.com",),
        "openai-codex": ("chatgpt.com", "auth.openai.com"),
        "openrouter": ("openrouter.ai",),
        "xai": ("api.x.ai",),
        "zai": ("api.z.ai",),
        "zai-coding-cn": ("open.bigmodel.cn",),
    }

    CLI_FLAGS: ClassVar[list[CliFlag]] = [
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
        self._malformed_jsonl_lines: dict[str, int] = {}
        # The version the container actually installed, and the model that
        # actually answered — both differ from what was requested when the
        # request is a moving tag (`version=next`) or a fallback candidate runs.
        self._resolved_version: str | None = None
        self._selected_model: str | None = None
        self._manifest_write_failed = False
        super().__init__(  # pyright: ignore[reportUnknownMemberType]
            logs_dir=logs_dir,
            prompt_template_path=prompt_template_path,
            version=version,
            extra_env=extra_env,
            **kwargs,
        )

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        """Install as usual, then resolve the version the container really has.

        Pier auto-detects a version only when none was requested, so a moving
        tag such as ``version=next`` would be recorded verbatim in the manifest
        and two runs of different builds would compare as equal. ``self._version``
        stays the requested spec because ``install_spec()`` interpolates it into
        ``npm install -g @bastani/atomic@<spec>``.
        """
        await super().setup(environment)  # pyright: ignore[reportUnknownMemberType]
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
        if isinstance(value, str):
            values: list[object] | tuple[object, ...] = [value]
        elif isinstance(value, list | tuple):
            values = cast(list[object] | tuple[object, ...], value)
        else:
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
    def install_spec(self) -> AgentInstallSpec:
        version_spec = f"@{self._version}" if self._version else "@latest"
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[
                InstallStep(
                    user="root",
                    env={"DEBIAN_FRONTEND": "noninteractive"},
                    run=root_install_command(),
                ),
                InstallStep(user="agent", run=agent_install_command(version_spec)),
            ],
            verification_command=self.get_version_command(),
        )

    @override
    def network_allowlist(self) -> NetworkAllowlist:
        if not self.model_name or "/" not in self.model_name:
            # An empty allowlist would silently drop the filtered-egress proxy
            # overlay and leave the sandbox with no route to any provider.
            raise EmptyEgressAllowlistError(model_name=self.model_name)

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
            # Atomic resolves a GHE tenant host from GITHUB_SERVER_URL on its
            # own, and copilot-api.<tenant>.ghe.com is outside _PROVIDER_DOMAINS.
            urls.append(self._copilot_ghe_tenant_url())
        return require_non_empty_allowlist(
            allowlist_from_urls(urls, default_domains=sorted(defaults)),
            model_name=self.model_name,
        )

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

    @staticmethod
    def _is_valid_provider_auth(entry: object) -> bool:
        # Same predicate the preflight applies, so "the preflight says I have a
        # credential" and "the adapter will forward one" cannot disagree.
        return is_valid_provider_auth(entry)

    def _load_provider_auths(self) -> dict[str, JsonObject]:
        merged: JsonObject = {}
        for auth_path in reversed(self._auth_config_paths()):
            try:
                data = cast(
                    object,
                    json.loads(auth_path.read_text(encoding="utf-8")),
                )
            except (OSError, json.JSONDecodeError):
                continue
            if data_object := _json_object(data):
                merged.update(data_object)

        auths: dict[str, JsonObject] = {}
        for provider, entry in merged.items():
            auth = _json_object(entry)
            if (
                provider
                and provider not in self._disallowed_subscriptions
                and auth is not None
                and self._is_valid_provider_auth(auth)
            ):
                auths[provider] = auth
        return auths

    def _load_provider_auth(self, provider: str) -> JsonObject | None:
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
                _ = auth_data.pop(auth_provider, None)
        if not auth_data:
            return
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            temp_path = Path(handle.name)
            json.dump(auth_data, handle, indent=2)
            _ = handle.write("\n")
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
            "trap 'status=$?; cleanup_atomic_sessions \"$status\"; "
            "exit \"$status\"' EXIT; "
            "trap 'cleanup_atomic_sessions 143; exit 143' TERM; "
        )

    @override  # pyright: ignore[reportAny]
    @with_prompt_template  # pyright: ignore[reportAny]
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        requested_provider, requested_model = self.model_name.split("/", 1)
        chain = self._model_chain(requested_provider, requested_model)
        provider, model = chain[0]
        # The candidate the session actually launches on, which is not
        # `self.model_name` when the requested provider has no credential here.
        self._selected_model = f"{provider}/{model}"
        fallback_settings_command = self._fallback_settings_command(chain)
        # Forward credentials for every Atomic-supported provider, not just the
        # top-level Pier --model provider: nested workflow/subagent model
        # assignments can select other providers (e.g. kimi-coding under an
        # openai-codex-led run), and the network allowlist already admits all
        # provider domains for the same reason. Forwarding everything also keeps
        # _provision_subscription_auth's env-credential shadowing consistent —
        # any host env credential that suppresses a copied auth.json entry is
        # guaranteed to be present inside the container as its replacement.
        env = {
            key: value
            for key in dict.fromkeys(
                env_key
                for env_keys in self._PROVIDER_ENV_KEYS.values()
                for env_key in env_keys
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
        await self._provision_subscription_auth(environment, requested_provider, env)

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        session_dir = self._CONTAINER_SESSION_DIR
        log_session_dir = shlex.quote(self._LOG_SESSION_DIR)
        output_file = shlex.quote(
            str(EnvironmentPaths.agent_dir / self._OUTPUT_FILENAME)
        )
        copilot_config_command = self._copilot_models_config_command(copilot_base_url)
        command = (
            f"rm -rf {session_dir} {log_session_dir} && mkdir -p {session_dir} && "
            f"{self._agent_state_setup_command()}"
            f"{fallback_settings_command}"
            f"{self._session_sync_trap_command(session_dir, log_session_dir)}"
            f"{copilot_config_command}"
            f"{atomic_runtime_environment_command()} && "
            f"atomic --print --mode json --session-dir {session_dir} "
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
            f"{cli_flags}"
            f"-- {shlex.quote(instruction)} "
            "2>&1 </dev/null | grep -v '\"type\":\"message_update\"' | "
            f"stdbuf -oL tee {output_file}; status=$?; "
            "exit $status"
        )
        await self.exec_as_agent(environment, command=command, env=env)
        self.populate_context_post_run(context)

    def _copilot_api_base_url(self) -> str | None:
        """Explicit Copilot endpoint pin, or None to use Atomic's own routing.

        Atomic resolves the Copilot host for `COPILOT_GITHUB_TOKEN` env auth:
        `COPILOT_API_TARGET` / `GITHUB_COPILOT_BASE_URL`, then the token's
        `proxy-ep` segment, then `GITHUB_SERVER_URL`, then the public routing
        hub `https://api.githubcopilot.com`. The individual host is only used
        for OAuth logins, which the sandbox never performs.

        Those variables are not forwarded into the container (only provider
        credential keys are), so this adapter keeps the two explicit overrides
        as a harness-level pin written into models.json, which still outranks
        the agent's own resolution. When neither is set we emit no override and
        let Atomic route the token exactly as it would for a normal user.
        """
        api_target = self._get_env("COPILOT_API_TARGET")
        if api_target:
            return self._copilot_url_from_host_or_url(api_target)

        override = self._get_env("GITHUB_COPILOT_BASE_URL")
        if override:
            return self._copilot_url_from_host_or_url(override)

        return None

    def _copilot_ghe_tenant_url(self) -> str | None:
        """Tenant Copilot host Atomic derives from a GHE.com GITHUB_SERVER_URL."""
        server_url = self._get_env("GITHUB_SERVER_URL")
        if not server_url:
            return None
        host = urlparse(self._copilot_url_from_host_or_url(server_url)).hostname
        if not host or not host.endswith(".ghe.com"):
            return None
        tenant = host.removesuffix(".ghe.com").split(".")[-1]
        return f"https://copilot-api.{tenant}.ghe.com" if tenant else None

    @staticmethod
    def _copilot_url_from_host_or_url(value: str) -> str:
        if value.startswith(("http://", "https://")):
            return value.rstrip("/")
        return f"https://{value}".rstrip("/")

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
        cost = _json_object(value)
        if cost is None:
            return 0.0
        total = cost.get("total")
        if isinstance(total, int | float):
            return float(total)
        return sum(
            float(part)
            for key in ("input", "output", "cacheRead", "cacheWrite")
            if isinstance((part := cost.get(key)), int | float)
        )

    @staticmethod
    def _assistant_message_fingerprint(message: object) -> str | None:
        message_object = _json_object(message)
        if message_object is None or message_object.get("role") != "assistant":
            return None
        timestamp = message_object.get("timestamp")
        if timestamp is None:
            return None
        usage = _json_object(message_object.get("usage"))
        usage_fingerprint = ""
        if usage is not None:
            usage_fingerprint = ":".join(
                str(usage.get(key, ""))
                for key in ("input", "output", "cacheRead", "cacheWrite", "totalTokens")
            )
        message_fingerprint = ":".join(
            str(message_object.get(key, ""))
            for key in ("timestamp", "provider", "model", "stopReason")
        )
        return f"{message_fingerprint}:{usage_fingerprint}"

    def _read_jsonl(
        self, path: Path, *, strict: bool = True, count_malformed: bool = True
    ) -> list[JsonObject]:
        """Parse a JSONL log, recording undecodable records instead of hiding them.

        ``strict`` (the default, and what every session ``.jsonl`` uses) counts
        **every** line that fails to parse: a session transcript is machine
        written, so an undecodable line there is corruption however it starts.

        ``strict=False`` is for ``atomic.txt`` alone, which interleaves Atomic's
        human-readable diagnostics with its JSON event stream — one such banner
        was observed in a live trial. There, only a line that *opens* a JSON
        value and fails to finish it counts as truncation.

        Blank lines stay tolerated in both modes. ``count_malformed=False`` reads
        without tallying, for a pass that re-reads a file the metrics pass also
        walks, so one bad line is not counted twice.

        Bytes that are not valid UTF-8 are replaced rather than raised: a log
        truncated mid-multibyte-character used to escape as an uncategorized
        ``UnicodeDecodeError`` — which is a ``ValueError``, not an ``OSError`` —
        and took the whole status write down with it, so the trial ended with an
        adapter traceback and no ``atomic-status.json`` at all. It is corruption,
        and it is now reported as corruption.
        """
        entries: list[JsonObject] = []
        try:
            raw = path.read_bytes()
        except OSError:
            return []
        text = raw.decode("utf-8", errors="replace")
        if count_malformed and "\ufffd" in text:
            self._malformed_jsonl_lines[str(path)] = (
                self._malformed_jsonl_lines.get(str(path), 0) + 1
            )
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                entry = cast(object, json.loads(stripped))
            except json.JSONDecodeError:
                if count_malformed and (strict or stripped.startswith(("{", "["))):
                    self._malformed_jsonl_lines[str(path)] = (
                        self._malformed_jsonl_lines.get(str(path), 0) + 1
                    )
                continue
            if entry_object := _json_object(entry):
                entries.append(entry_object)
        return entries

    def _read_session_header(self, session_file: Path) -> JsonObject | None:
        # Counted by the metrics pass over the same file; skip the tally here so
        # one malformed line is not reported twice.
        for entry in self._read_jsonl(session_file, count_malformed=False):
            return entry if entry.get("type") == "session" else None
        return None

    def _should_count_session_file(
        self,
        session_file: Path,
        header: JsonObject | None,
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
            (
                path,
                self._should_count_session_file(
                    path,
                    self._read_session_header(path),
                ),
            )
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
    def _jsonable_arguments(value: object) -> dict[str, object]:
        return cast(dict[str, object], value) if isinstance(value, dict) else {
            "value": value
        }

    def _split_message_content(
        self,
        message: JsonObject,
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
            block_object = _json_object(block)
            if block_object is None:
                continue
            block_type = block_object.get("type")
            text = block_object.get("text")
            if block_type == "text" and isinstance(text, str):
                text_parts.append(text)
            elif block_type in {"thinking", "redacted_thinking"}:
                thinking = block_object.get("thinking") or text
                if isinstance(thinking, str):
                    reasoning_parts.append(thinking)
            elif block_type == "toolCall":
                tool_id = block_object.get("id")
                name = block_object.get("name")
                if isinstance(tool_id, str) and isinstance(name, str):
                    tool_calls.append(
                        ToolCall(
                            tool_call_id=tool_id,
                            function_name=name,
                            arguments=self._jsonable_arguments(
                                block_object.get("arguments", {})
                            ),
                        )
                    )
        return (
            "\n\n".join(part for part in text_parts if part),
            "\n\n".join(part for part in reasoning_parts if part) or None,
            tool_calls or None,
        )

    def _metrics_from_usage(self, usage: object) -> Metrics | None:
        usage_object = _json_object(usage)
        if usage_object is None:
            return None
        input_tokens = self._token_count(usage_object.get("input"))
        output_tokens = self._token_count(usage_object.get("output"))
        cache_read = self._token_count(usage_object.get("cacheRead"))
        cache_write = self._token_count(usage_object.get("cacheWrite"))
        cost = self._cost_total(usage_object.get("cost"))
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
        message: JsonObject,
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
        message: JsonObject,
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
            message_model = message.get("model")
            return Step(
                step_id=step_id,
                timestamp=timestamp,
                source="agent",
                model_name=message_model if isinstance(message_model, str) else None,
                message=text,
                reasoning_content=reasoning,
                tool_calls=tool_calls,
                metrics=metrics,
                is_copied_context=True if copied else None,
                llm_call_count=1 if metrics else None,
            )
        if role == "user":
            return Step(
                step_id=step_id,
                timestamp=timestamp,
                source="user",
                message=text,
            )
        if role == "bashExecution":
            command = message.get("command")
            output = message.get("output")
            return Step(
                step_id=step_id,
                timestamp=timestamp,
                source="system",
                message=f"bash: {command}" if isinstance(command, str) else "bash",
                observation=Observation(
                    results=[
                        ObservationResult(
                            content=output if isinstance(output, str) else None
                        )
                    ]
                ),
            )
        if role in {"custom", "branchSummary"}:
            return Step(
                step_id=step_id,
                timestamp=timestamp,
                source="system",
                message=text,
            )
        return None

    def _trajectory_from_entries(
        self,
        entries: list[JsonObject],
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
            entry_timestamp = entry.get("timestamp")
            timestamp = entry_timestamp if isinstance(entry_timestamp, str) else None
            timestamp = timestamp or self._iso_from_message_timestamp(
                message.get("timestamp")
            )
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
        header_id = header.get("id")
        trajectory = Trajectory(
            session_id=header_id if isinstance(header_id, str) else None,
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
        # atomic.txt is tallied once, by the metrics pass in
        # populate_context_post_run; this trajectory pass re-reads it.
        events = (
            self._read_jsonl(output_file, strict=False, count_malformed=False)
            if output_file.exists()
            else []
        )
        entries = [
            {"type": "message", "message": event.get("message")}
            for event in events
            if event.get("type") == "message_end"
            and _json_object(event.get("message")) is not None
        ]
        trajectory, _ = self._trajectory_from_entries(
            entries,
            None,
            seen_ids,
            seen_fingerprints,
        )
        return trajectory

    @staticmethod
    def _metric_totals(
        steps: list[Step],
    ) -> tuple[int, int, int, float, int | None]:
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
                peak = (
                    metrics.prompt_tokens
                    if peak is None
                    else max(peak, metrics.prompt_tokens)
                )
        return prompt, completion, cached, cost, peak

    def _write_trajectory(
        self,
        context: AgentContext,
        classified: list[tuple[Path, bool]],
    ) -> None:
        seen_ids: set[str] = set()
        seen_fingerprints: set[str] = set()
        main_files = [path for path, should_count in classified if not should_count]
        subagent_files = [path for path, should_count in classified if should_count]

        root: Trajectory | None = None
        summarization_count = 0
        if main_files:
            root, count = self._trajectory_from_entries(
                self._read_jsonl(main_files[0], count_malformed=False),
                None,
                seen_ids,
                seen_fingerprints,
            )
            summarization_count += count
        if root is None:
            root = self._trajectory_from_output_events(seen_ids, seen_fingerprints)
        if root is None:
            return

        subagents: list[Trajectory] = []
        for index, session_file in enumerate(subagent_files, start=1):
            trajectory, count = self._trajectory_from_entries(
                self._read_jsonl(session_file, count_malformed=False),
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
        context.n_agent_steps = sum(
            1
            for step in all_steps
            if step.source == "agent" and step.is_copied_context is not True
        )

        trajectory_path = self.logs_dir / "trajectory.json"
        try:
            _ = trajectory_path.write_text(
                format_trajectory_json(root.to_json_dict()), encoding="utf-8"
            )
        except OSError as exc:
            self.logger.debug("Failed to write Atomic trajectory: %s", exc)

    def _record_agent_status(
        self, context: AgentContext, reasons: list[str], details: dict[str, object]
    ) -> AgentRunStatus:
        """Persist an explicit run status and stamp it onto the agent context.

        Deliberately records rather than raises: pier also calls
        ``populate_context_post_run`` from its cancel and outer-exception
        handlers, where raising would replace the in-flight exception. The
        post-run auditor turns a non-``ok`` status into a failed trial.

        A manifest that could not be persisted is folded in here, on every path,
        because ``_record_run_manifest`` runs first and cannot report anything
        itself.
        """
        if self._manifest_write_failed and REASON_MANIFEST_NOT_WRITTEN not in reasons:
            reasons = [*reasons, REASON_MANIFEST_NOT_WRITTEN]
            details = {**details, "manifest_path": str(self.logs_dir / MANIFEST_FILENAME)}
        status = AgentRunStatus.from_reasons(reasons, details)
        _ = write_agent_status(self.logs_dir, status)
        context.metadata = {**(context.metadata or {}), "atomic_status": status.to_json()}
        if not status.ok:
            self.logger.error(
                "Atomic run status: failed (%s)", ", ".join(explain(r) for r in status.reasons)
            )
        return status

    def _observed_model(self) -> str | None:
        """The provider/model that actually answered, read from the agent stream.

        Every assistant message in ``atomic.txt`` carries ``provider`` and
        ``model``. The last one is what produced the trial's final work, which
        is not the requested model when the session fell back mid-run.
        """
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            return None
        observed: str | None = None
        for event in self._read_jsonl(output_file, strict=False, count_malformed=False):
            message = _json_object(event.get("message"))
            if message is None or message.get("role") != "assistant":
                continue
            provider = message.get("provider")
            model = message.get("model")
            if isinstance(provider, str) and provider and isinstance(model, str) and model:
                observed = f"{provider}/{model}"
        return observed

    def _record_run_manifest(self, context: AgentContext) -> RunManifest:
        """Record which corpus, pier, Atomic build, model, and seed produced this run.

        Model precedence: what answered (from the stream) > the candidate the
        session launched on > the requested ``--model``. Version precedence: what
        the container reported after install > the requested spec. Recording the
        request would let two runs of different builds, or of different fallback
        candidates, compare as equal.
        """
        manifest = manifest_for_agent_logs_dir(
            self.logs_dir,
            model=self._observed_model() or self._selected_model or self.model_name,
            atomic_version=self._resolved_version or self.version(),
        )
        written = write_manifest(self.logs_dir, manifest)
        # write_manifest never raises — it also runs on pier's cancel and
        # outer-except paths — so the caller has to notice the failure instead.
        self._manifest_write_failed = written is None
        context.metadata = {**(context.metadata or {}), "atomic_manifest": manifest.to_json()}
        return manifest

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        self._malformed_jsonl_lines = {}
        _ = self._record_run_manifest(context)
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            # An absent atomic.txt means the agent produced no output at all.
            # Returning silently here is what made a dead trial look complete.
            _ = self._record_agent_status(
                context,
                [REASON_MISSING_OUTPUT],
                {"expected": str(output_file)},
            )
            return

        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cache_write_tokens = 0
        total_cost = 0.0
        seen_message_ids: set[str] = set()
        seen_message_fingerprints: set[str] = set()

        def add_assistant_message_usage(
            message: object,
            entry_id: object = None,
        ) -> None:
            nonlocal total_input_tokens, total_output_tokens
            nonlocal total_cache_read_tokens, total_cache_write_tokens, total_cost
            message_object = _json_object(message)
            if message_object is None or message_object.get("role") != "assistant":
                return
            usage = _json_object(message_object.get("usage"))
            if usage is None:
                return
            fingerprint = self._assistant_message_fingerprint(message_object)
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

        def mark_assistant_message_seen(
            message: object,
            entry_id: object = None,
        ) -> None:
            message_object = _json_object(message)
            if message_object is None or message_object.get("role") != "assistant":
                return
            if isinstance(entry_id, str):
                seen_message_ids.add(entry_id)
            fingerprint = self._assistant_message_fingerprint(message_object)
            if fingerprint:
                seen_message_fingerprints.add(fingerprint)

        def read_session_messages(session_file: Path, *, count_usage: bool) -> None:
            # Session transcripts are machine-written: any undecodable line is
            # corruption, whatever byte it starts with. Each file is read once
            # here (the two loops below are disjoint), so counts do not double.
            for entry in self._read_jsonl(session_file):
                if entry.get("type") != "message":
                    continue
                message = entry.get("message")
                if count_usage:
                    add_assistant_message_usage(message, entry.get("id"))
                else:
                    mark_assistant_message_seen(message, entry.get("id"))

        for event in self._read_jsonl(output_file, strict=False):
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

        reasons: list[str] = []
        details: dict[str, object] = {"atomic_txt": str(output_file)}
        if output_file.stat().st_size == 0:
            reasons.append(REASON_EMPTY_OUTPUT)
        if self._malformed_jsonl_lines:
            reasons.append(REASON_MALFORMED_SESSION_LOG)
            details["malformed_jsonl_lines"] = dict(self._malformed_jsonl_lines)
        _ = self._record_agent_status(context, reasons, details)
