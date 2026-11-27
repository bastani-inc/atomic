---
title: "Choose a model"
sidebarTitle: "Choose a Model"
description: "Pick how to connect models, switch models and thinking levels during a session, scope and fall back across models, and troubleshoot model selection."
---

Atomic ships built-in model catalogs for cloud subscriptions, API-key providers, and local inference servers, and lets you add custom endpoints without leaving your session. Use this guide to pick how to connect, switch models and thinking effort day to day, and configure scopes, fallbacks, and specialized models.

## Pick how to connect

| What you want | Use this | Start here |
| --- | --- | --- |
| Use an existing Claude, ChatGPT/Codex, GitHub Copilot, Kimi Code, Meta, OpenRouter, or xAI account | Subscription or account sign-in (`/login`) | [Connect model providers](/providers#subscriptions) |
| Pay per token with an API key or cloud account (Anthropic, OpenAI, Google, Azure, Bedrock, Vertex, OpenRouter, Cloudflare, and more) | API key via `/login`, `~/.atomic/agent/auth.json`, or environment variable | [API keys](/providers#api-keys) |
| Run local GGUF models with GPU offloading, on-demand load/unload, and local classification | Local `llama.cpp` router (`/login llama.cpp`, `/llama`) | [Run local models with llama.cpp](/llama-cpp) |
| Connect Ollama, LM Studio, vLLM, or an OpenAI-, Anthropic-, or Google-compatible proxy | `~/.atomic/agent/models.json` | [Configure custom models](/models) |
| Implement a custom streaming protocol, OAuth flow, or dynamic model discovery | Custom provider extension (`atomic.registerProvider()`) | [Build custom providers](/custom-provider) |

## Switch models and thinking levels

Once at least one provider is authenticated, switch models and reasoning effort interactively or from the command line. Every interactive model or thinking change saves automatically as your startup default in `~/.atomic/agent/settings.json`.

### Interactive commands and shortcuts

| Action | Command or shortcut | What it does |
| --- | --- | --- |
| Pick a model | `/model` or `Ctrl+L` | Opens the searchable model picker. Press `←`/`→` on a reasoning model to pick its thinking level before confirming. Press `Tab` to toggle between scoped and all models. |
| Switch directly | `/model <provider/id>` | Switches immediately on an exact case-insensitive `provider/id` or bare `id` match (without a `:level` suffix), or opens the picker pre-filtered on a partial match. |
| Cycle models | `Ctrl+P` / `Shift+Ctrl+P` | Cycles forward and backward through available models (`Alt+P` for backward on Windows and WSL). Cycles only scoped models when `enabledModels` is active. |
| Set thinking level | `/thinking [level]` or `Shift+Tab` | Changes reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), clamped to what the active model supports. |
| Collapse or expand thinking | `Ctrl+T` | Toggles thinking blocks in the viewed transcript. |

Atomic saves your active model under `defaultProvider` and `defaultModel`, and saves your reasoning level under both `modelThinkingLevels["<provider>/<id>"]` and `defaultThinkingLevel`. Open `/settings` and select **Default thinking level per model** to inspect saved per-model levels.

### Fast and Ultrafast models

Fast and Ultrafast inference are selectable model IDs ending in `-fast` or `-ultrafast`, not a separate toggle. Select them anywhere you name a model, including `/model`, `--model`, `enabledModels`, `fallbackModels`, and subagents:

```bash
atomic --model anthropic/claude-opus-5-fast:high
atomic --model openai-codex/gpt-6.2-sol-fast:medium
atomic --model openai/gpt-6.2-astra-ultrafast:high
atomic --model xai/grok-4.7-fast
```

Derived `-fast` and `-ultrafast` variants are generated for eligible models on `openai`, `openai-api`, `openai-codex`, `anthropic`, `anthropic-api`, and `xai`. GitHub Copilot publishes its own account-advertised fast model IDs. See [Fast models](/providers#fast-models) and [Fast and Ultrafast tiers](/providers#fast-and-ultrafast-tiers).

### Override for a single run from the shell

Inspect available models or start one session on a specific provider, model, and thinking level without changing your saved defaults:

```bash
atomic --list-models
atomic --model anthropic/claude-opus-5:high
atomic --provider openai-codex --model gpt-6.2-sol:medium
```

See [CLI model options](/reference/cli#model-options) for all model flags and fuzzy matching rules.

## Scope models and set fallbacks

### Limit active models with `/scoped-models` and `enabledModels`

If you have credentials for many providers, narrow your daily rotation so `Ctrl+P`, `/model`, and subagents stay on the models you approve.

Run `/scoped-models` in interactive mode to toggle and reorder models; every change saves immediately to global `~/.atomic/agent/settings.json` as explicit `provider/id` entries. For glob patterns, per-entry `:thinking` levels, or project-scoped lists, edit `enabledModels` directly in `settings.json` (or pass `--models` for one run):

```json
{
  "enabledModels": [
    "anthropic/claude-opus-5:high",
    "openai-codex/gpt-6.2-sol*",
    "xai/grok-4.7"
  ]
}
```

When a scope is active:

- **Startup model:** A new session starts on your saved default if it is in scope, or on the first matched scoped model otherwise.
- **`Ctrl+P` and `/model`:** Cycling walks only scoped models in order. `/model` opens filtered to scoped models (press `Tab` to view all models).
- **Subagents:** Child subagents inherit the active scope and reject any model outside it. Because Fast and Ultrafast variants have their own IDs (`-fast`, `-ultrafast`), end a pattern with `*` (such as `"openai-codex/gpt-6.2-sol*"`) or list those IDs explicitly if you want subagents to use them.

<Tip>
Editing `enabledModels` through `/scoped-models` saves explicit `provider/id` strings to global `settings.json`, replacing hand-written globs and `:thinking` suffixes. Edit `settings.json` directly when you want to keep globs or per-model thinking suffixes. See [`enabledModels`](/settings#enabledmodels).
</Tip>

### Recover from limits and outages with `fallbackModels`

Configure an ordered fallback chain in `settings.json` so main-chat turns switch automatically when a model hits rate limits, exhausted quota, content filters, auth errors, refused TLS certificates, or outages:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-6.2-sol",
  "defaultThinkingLevel": "high",
  "fallbackModels": [
    "anthropic/claude-opus-5:high",
    "github-copilot/gpt-6.1-sol:high"
  ]
}
```

- **Main chat stays independent of `enabledModels`:** You can keep an out-of-scope emergency model in `fallbackModels`. Child subagent fallbacks still stay within the session's `enabledModels` scope.
- **Per-run overrides:** Pass `--fallback-models` to replace the chain for one run, or `--no-fallback` to disable fallbacks. Passing `--model` on the CLI runs strictly as named unless you also pass `--fallback-models`.
- **Skipped candidates:** Providers without configured credentials are skipped before any request, and a provider that rejects credentials mid-turn is skipped for the rest of that chain.

Because switching providers changes billing and data-handling terms, include only approved providers in `fallbackModels`. See [`fallbackModels`](/settings#fallbackmodels).

## Use specialized models

In addition to chat models, Atomic supports three specialized model kinds. None of them appear in `/model` or run as your chat model.

| Model kind | Configured via | Built-in options | Learn more |
| --- | --- | --- | --- |
| **Chat** | `/model`, `defaultModel`, `enabledModels`, `fallbackModels` | All built-in, `models.json`, `llama.cpp`, and extension chat providers | [Connect providers](/providers) |
| **Classifier** | `decisionModel` (`/settings` → **Decision model**) or codemode | `google-decisions/gemini-decision-1`, `openai-decisions/gpt-6-luna`, `typesafe/jev-latest`, Cloudflare Clef and Jev, GitHub Copilot, OpenRouter, Vercel AI Gateway, OpenCode Zen, local `llama.cpp` | [Classifier models](/models#use-classifier-models) |
| **Compactor** | `compactionModel` (`/settings` → **Compaction model**) | `"auto"` (built-in memory compaction) or `morph/morph-compactor`, plus custom compactors in `models.json` | [Custom compactors](/compaction/custom-compactors) |
| **Image** | Codemode (`models.generateImages()`) or extensions (`ctx.modelRegistry.generateImages()`) | `openai-images` (GPT Image 1 through GPT Image 2.6, including SVG and GIF) and `openrouter` image models | [Image models](/models#use-image-models) |

- **Decision models (`decisionModel`):** Leave `decisionModel` empty or `"auto"` to use your active chat model for structured decisions (`structured_output` and `decide()`), or pin a fast classifier such as `typesafe/jev-latest`, `openai-decisions/gpt-6-luna`, or a local `llama.cpp/<id>` model in `/settings`. Changes in `/settings` apply immediately without `/reload`. See [`decisionModel`](/settings#decisionmodel) and [Structured decisions](/sdk/structured-decisions).
- **Compaction models (`compactionModel`):** By default Atomic uses [memory compaction](/compaction/memory-compaction) (`"auto"`), which clears the window and lets the agent recover verbatim details from session history. To send context to a remote compactor such as `morph/morph-compactor` or your own endpoint, select it under `/settings` → **Compaction model**. See [Custom compaction models](/compaction/custom-compactors).
- **Image models (`openai-images` and `openrouter`):** Built-in `openai-images` models reuse your OpenAI API key (`openai-api`, `openai` API key, or `OPENAI_API_KEY`, skipping ChatGPT sign-in), while `openrouter` image models reuse your OpenRouter credential. See [Use image models](/models#use-image-models) and [Codemode image generation](/codemode#generate-images).

## How Atomic picks your startup model

When Atomic starts, it resolves the initial chat model in this order:

<Steps>
  <Step title="CLI flags">
    Explicit `--model` (with optional `--provider`) on the command line wins for that run.
  </Step>
  <Step title="Resumed session model">
    When you run `--continue`, `--resume`, or `/resume`, Atomic restores the model last used in that session (if still available and authenticated).
  </Step>
  <Step title="Saved defaults and model scope">
    For a new session, Atomic uses `defaultProvider` and `defaultModel` from `settings.json` when authenticated and inside any active `enabledModels` / `--models` scope. If your saved default is outside an active scope, Atomic starts on the first matched scoped model instead.
  </Step>
  <Step title="Automatic preferred-provider selection">
    When no saved default applies (for example on first run, or when the saved model lacks credentials), Atomic walks its built-in preferred provider order and picks the first authenticated provider's preferred default model. If none of those preferred IDs are available, it picks the first available authenticated model.
  </Step>
</Steps>

<Note>
**Unsupported saved `defaultProvider`:** If `defaultProvider` names a removed or unregistered provider even after extensions load, Atomic does not switch providers silently. Interactive mode warns and leaves model selection open, print and JSON modes write an error to stderr and exit nonzero, and RPC rejects `prompt` until you select an available model.
</Note>

### Startup provider selection order

When multiple providers are authenticated and no saved default applies, Atomic checks providers in this built-in priority order and picks each provider's preferred model first:

| Priority group | Providers checked in order (preferred default model) |
| --- | --- |
| Primary cloud & subscriptions | `amazon-bedrock` (`us.anthropic.claude-opus-5-5`), `anthropic` (`claude-opus-5-5`), `anthropic-api` (`claude-opus-5-5`), `openai` (`gpt-6.2-sol`), `openai-api` (`gpt-6.2-sol`), `azure` (`gpt-6.2-sol`), `openai-codex` (`gpt-6.2-sol`) |
| Major API & gateway providers | `nvidia` (`nvidia/nemotron-3.5-super-vl-120b-a12b`), `deepseek` (`deepseek-v4-pro`), `google` (`gemini-4-argon`), `google-vertex` (`gemini-4-argon`), `github-copilot` (`gpt-6.1-sol`), `openrouter` (`moonshotai/kimi-k2.7-code`), `vercel-ai-gateway` (`zai/glm-5.3`), `xai` (`grok-4.7`) |
| Additional built-in providers | `groq`, `cerebras`, `ant-ling`, `zai`, `zai-coding-cn`, `mistral`, `minimax`, `minimax-cn`, `moonshotai`, `moonshotai-cn`, `huggingface`, `fireworks`, `together`, `baseten`, `opencode`, `opencode-go`, `kimi-coding`, `meta`, `cloudflare-workers-ai`, `cloudflare-ai-gateway`, `qwen-token-plan*`, `xiaomi*` |

`/model` and `/scoped-models` display cached catalogs immediately while refreshing network-backed catalogs in the background for up to 15 seconds. Run `atomic update --models` from the shell to refresh cached catalogs ahead of time.

## Troubleshooting

- **A model does not appear in `/model`:**
  - Verify credentials for its provider with `atomic auth check --provider <provider>` (see [Verify credentials before a session](/providers#verify-readiness-before-a-session)).
  - Check whether `enabledModels` is filtering the picker—press `Tab` inside `/model` to show all authenticated models.
  - Remember that classifiers, image models, and compactors never appear in `/model`.
  - On GitHub Copilot or OpenRouter, `/model` hides models your account or API key cannot access once an online refresh succeeds. Run `atomic update --models` or `/login` after plan changes.
  - On `llama.cpp` started with `--no-models-autoload`, load the model in `/llama` first before opening `/model`.
- **Auth works in one terminal window only:** Environment variables (`export ANTHROPIC_API_KEY=...`) apply only to that shell. Run `/login` or `atomic auth login <provider>` to save credentials in `~/.atomic/agent/auth.json` for every session.
- **Browser callback fails over SSH or on a remote host:** Paste the final redirect URL or authorization code into the `/login` prompt, or run `atomic auth login <provider> --no-browser` for a device-code or copy-code flow.
- **An OpenAI-compatible or local endpoint rejects requests:** Servers such as Ollama, vLLM, and SGLang often reject the `developer` role or `reasoning_effort`. Add `compat` flags (such as `"supportsDeveloperRole": false` and `"supportsReasoningEffort": false`) in `~/.atomic/agent/models.json`, then open `/model` or run `/reload`. See [OpenAI compatibility](/models/reference#openai-compatibility).
- **A `-fast` or `-ultrafast` model is missing or blocked for a subagent:** Only eligible built-in models on `openai`, `openai-api`, `openai-codex`, `anthropic`, `anthropic-api`, and `xai` receive derived fast variants (plus account-advertised fast IDs on `github-copilot`). Custom entries under `models` in `models.json` never receive derived fast variants—use `modelOverrides` instead. If `enabledModels` is active, include the `-fast` or `-ultrafast` ID explicitly (for example `"openai-codex/gpt-6.2-sol*"`).

## Next steps

<Columns cols={2}>
  <Card title="Connect model providers" href="/providers">
    Sign in with subscriptions, store API keys, and configure cloud or specialized providers.
  </Card>
  <Card title="Run local models with llama.cpp" href="/llama-cpp">
    Discover, download, load, and run local GGUF chat models and classifiers.
  </Card>
  <Card title="Configure custom models" href="/models">
    Add Ollama, LM Studio, vLLM, API proxies, image models, and remote compactors.
  </Card>
  <Card title="Models and thinking settings" href="/settings#models-and-thinking">
    Complete reference for `enabledModels`, `fallbackModels`, `decisionModel`, and `thinkingBudgets`.
  </Card>
</Columns>
