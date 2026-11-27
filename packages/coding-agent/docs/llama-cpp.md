---
title: "Run local models with llama.cpp"
sidebarTitle: "Run Local Models"
description: "Connect Atomic to a local llama.cpp router server to discover, load, download, and run GGUF models and local classifiers."
---

Atomic integrates with the [llama.cpp](https://llama.app) router server to discover local GGUF models, load or unload them on demand, download models from Hugging Face, and run local classification.

## Install and start the router

<Steps>
  <Step title="Install llama.cpp">
    Install llama.cpp with the [official installer](https://llama.app/docs/installation) (see [llama.app](https://llama.app) for package managers and building from source):

    ```bash
    curl -LsSf https://llama.app/install.sh | sh
    llama --version
    ```
  </Step>
  <Step title="Start llama serve in router mode">
    Start `llama serve` **without** `--model`, `-m`, or `-hf` (those flags launch single-model mode instead of router mode). See the [llama.cpp server guide](https://llama.app/docs/serve#serving-multiple-models-router-mode) for full router options.

    ```bash
    llama serve \
      --no-models-autoload \
      --host 127.0.0.1 \
      -ngl all \
      -c 32768
    ```

    - `--no-models-autoload` keeps model loading under explicit `/llama` control.
    - `-ngl all` offloads all layers to the GPU (omit it for automatic offloading).
    - `-c 32768` sets the context size in tokens (use `-c 0` for a model's full context window, which uses more memory; parallel slots share context).
    - `--models-dir ~/models` discovers local GGUF files in that directory. Place single-file models directly in the directory, place multimodal or multi-shard models in separate subdirectories with their projection or shard files, and restart the router after adding files manually.
  </Step>
  <Step title="Connect Atomic and load a model">
    Run `/login llama.cpp` inside Atomic (see [Configure Atomic](#configure-atomic)), load a model with `/llama`, then select it with `/model`.
  </Step>
</Steps>

For settings tuned to a specific NVIDIA GPU and model, see [NVIDIA RTX recipes](#nvidia-rtx-recipes).

## Configure Atomic {#configure-atomic}

Run `/login llama.cpp` inside an interactive session and enter your router URL and optional API key. The default URL is `http://127.0.0.1:9931` (trailing slashes and `/v1` are normalized automatically).

`/login llama.cpp` immediately verifies connectivity against the router before saving credentials, so unreachable URLs or invalid API keys fail right away. Shell `atomic auth login` does not load extension providers, so use `/login llama.cpp` or environment variables instead (see [CLI credential commands](/reference/cli#credential-commands)). When the router runs with `--no-models-autoload`, login saves only the connection; load a model with `/llama` before selecting it in `/model`.

You can configure the same values with environment variables instead of `/login`:

```bash
export LLAMA_BASE_URL=http://127.0.0.1:9931
export LLAMA_API_KEY=optional-secret
atomic
```

A server URL saved via `/login llama.cpp` (stored in `auth.json` under `env.LLAMA_BASE_URL`) takes precedence over `LLAMA_BASE_URL`. When no API key is configured, Atomic sends `"local"` as a placeholder key. If the server requires authentication, start `llama serve` with the matching `--api-key` and keep `--host 127.0.0.1` for local-only access.

## Manage models

Run `/llama` in interactive mode to manage router models. Because `/llama` talks directly to your configured local router, it continues to work even when `ATOMIC_OFFLINE` (or `--offline`) is enabled.

- Select an unloaded model to load it, or a loaded model to unload it.
- Select **Download model...** to search Hugging Face and choose a repository and quantization. Search returns up to 20 GGUF repositories sorted by downloads (15-second timeout). The quantization picker excludes `mmproj` projection files, lists `Q4_K_M` first, and sorts remaining quantizations from smallest to largest. Type an exact `owner/repository` or `owner/repository:QUANT` and press Enter to download directly.
- Press `Esc` during a load or download to confirm cancellation.

Hugging Face search checks `HF_TOKEN`, then `$HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, and `~/.cache/huggingface/token` (unauthenticated search has lower rate limits). Atomic warns before gated downloads and links to the access page; because `llama.cpp` performs the download itself, its process also needs `HF_TOKEN` for gated repositories.

Atomic asks before unloading other models, never silently unloads models, and never deletes model files. `/llama` always reads live router state because other clients may share the server. Loaded and sleeping models appear in `/model` (sleeping models wake automatically when selected). With router autoload enabled, unloaded preset models also appear in `/model` and load on selection; with `--no-models-autoload`, load them in `/llama` first.

Atomic caches the last loaded-model catalog in `~/.atomic/agent/models-store.json` so entries stay selectable across restarts. If a refresh fails, Atomic reports the router error and keeps the cached catalog; a later successful refresh replaces stale entries without duplicates. If the router disconnects mid-action, select **Retry** to reconnect and refresh state without replaying the interrupted action.

### Context window, thinking, and vision detection

Atomic derives each model's context size, thinking support, and vision support automatically from the router:

- **Context window:** Atomic sets both `contextWindow` and `maxTokens` from the context window reported by the router (falling back to 128,000 tokens if unreported). The server remains authoritative and may enforce a smaller generation limit.
- **Thinking controls:** Thinking controls appear only for **currently loaded** models whose chat template supports thinking. Sleeping or unloaded preset models are not probed during discovery so they are not woken unexpectedly—load a model in `/llama` and refresh `/model` to enable thinking controls. When detected, Atomic exposes **`off`** and **`medium`** thinking levels (`minimal`, `low`, `high`, `xhigh`, and `max` are unavailable).
- **Vision support:** Image input turns on automatically when the server reports image capability for the model.

<Note>
**How the router reports metadata:** Context size is read in order from `meta.n_ctx`, the model's `--ctx-size`/`-c`/`-ctx` flag, cached context, and training context `meta.n_ctx_train`. Thinking detection checks for `"enable_thinking"` in the loaded model's `/props` `chat_template`, and vision detection checks for `"image"` in `architecture.input_modalities`.
</Note>

## Classification {#classification}

Classifier models answer typed `choice`, `bool`, and `score` questions about JSON state, letting a local model serve structured decisions (`decide()` and `structured_output`) as your [`decisionModel`](/settings#decisionmodel) (see [Structured decisions](/sdk/structured-decisions)). Extensions can call `ctx.modelRegistry.classify()` and codemode scripts can call `models.classify()`; see [Use classifier models](/models#use-classifier-models).

Atomic exposes `llama.cpp` models as classifiers in two ways:

- **Native decision models** (such as Julia-1, Laya, Kev, lev, and OpenJev) answer through `llama.cpp`'s native decision endpoint (`/v1/systemone`). Decision-only models never appear in `/model`.
- **Chat models** are also exposed as classifiers under the same ID using next-token probability classification (`llama-cpp-classify`).

<Note>
`llama.cpp` 0.6.0 and newer identify native decision models by advertising `"decisions"` in `architecture.output_modalities`. Atomic detects them even while sleeping or unloaded without waking them (unloaded presets remain selectable only when router autoload is enabled). Older servers omit this metadata and fall back to next-token classification.
</Note>

### Chat models as classifiers

Instead of generating prose, Atomic formats each question as a single prompt (presenting the JSON state, all questions, the state again, and the target question with single-token labels) and reads the server's next-token probabilities for those labels:

- **Supported question types:** `choice` accepts 2 to 62 options (single alphanumeric labels; 1 option throws an error, and more than 62 options fail over to the active chat model), `bool` uses `Yes`/`No`, and `score` accepts 2 to 10 digit levels.
- **Probability lookup and confidence:** If a label token does not appear in the server's initial top-token probabilities, Atomic retries with a wider candidate token window (up to 32,768 tokens). Choices return normalized option probabilities and a confidence score from `0` (uniform guess) to `1` (certainty), computed as `(n * peak - 1) / (n - 1)` where `n` is the option count and `peak` is the highest normalized probability; scores return the expected level.
- **Prefix caching and context sizing:** Questions run sequentially with a shared prefix so the server's prompt cache evaluates it once. Because the JSON state appears twice in the prompt, reserve at least twice the state size in context. For hybrid models such as Qwen3.5, start the router with `--ctx-checkpoints 32 --checkpoint-min-step 0` if every question reprocesses the full state.
- **Temperature and prompt injection:** SDK `classify()` accepts a `temperature` option that scales label scores before normalizing (values above `1` soften overconfident probabilities without changing the winning answer). Small local models may follow prompt-injection instructions embedded inside untrusted JSON state.

When a chat model is exposed as both a chat model and a classifier under the same `llama.cpp/<id>`:

| Setting or API | Which model wins when IDs match |
| --- | --- |
| `decisionModel: "llama.cpp/<id>"` and `decide()` | Classifier first (`llama-cpp-classify` or native decision model); falls back to the active chat model if a `choice` exceeds 62 options |
| `structured_output` and `generateStructuredOutput()` | Chat model first |

<Note>
In `/settings` → **Decision model**, each loaded chat model appears twice (once as a classifier and once as a chat model), and both rows save the same `llama.cpp/<id>`. Decision-only models show only a classifier row.
</Note>

## NVIDIA RTX recipes {#nvidia-rtx-recipes}

[NVIDIA Local AI Inference Recipes](https://nvidia.github.io/local-ai-inference-recipes/index.html) publishes `llama.cpp` flags tuned for specific NVIDIA GPUs and models. Each recipe provides a single-model `llama-server` command; convert it into a router preset file so `llama serve` can run it alongside other models. The commands below use Windows PowerShell.

<Steps>
  <Step title="Pick a recipe and verify your llama.cpp build">
    1. Open the [recipe catalog](https://nvidia.github.io/local-ai-inference-recipes/index.html), choose your hardware, OS, and model, select **llama.cpp**, and note the launch command and memory requirements.
    2. Install `llama.cpp` using the recipe's instructions so your build includes any required CUDA or speculative-decoding features.
    3. Run `llama serve --help` and confirm `--models-preset` is listed.
    4. Install Atomic via the [Quickstart](/quickstart) (on native Windows, see [Run Atomic on Windows](/windows)).
  </Step>
  <Step title="Convert the recipe command into a preset file">
    Save a `.ini` preset file where each section header becomes the model ID in Atomic:

    - Drop leading dashes (`--ctx-size 65536` → `ctx-size = 65536`).
    - Set boolean flags to `true` (`--jinja` → `jinja = true`).
    - Strip surrounding quotes and PowerShell line-continuation backticks.
    - Omit `--host` and `--port` (pass those to `llama serve` instead), and add `load-on-startup = true`.
    - Map short model-file flags using this table:

    | Recipe option | Preset key |
    | --- | --- |
    | `-hf` | `hf-repo` |
    | `-hff` | `hf-file` |
    | `-hfrd` | `hf-repo-draft` |
    | `--spec-draft-model` | `spec-draft-model` |

    For example, this recipe command:

    ```powershell
    llama-server.exe -hf "unsloth/Qwen3.8-27B-GGUF" `
      -hff "Qwen3.8-27B-UD-Q4_K_M.gguf" `
      -hfrd "z-lab/Qwen3.8-27B-DFlash2-GGUF" `
      --spec-draft-model "Qwen3.8-27B-DFlash2-Q4_K_M.gguf" `
      --no-mmproj `
      --host 127.0.0.1 `
      --port 9931 `
      --batch-size 4096 `
      --ubatch-size 1024 `
      --ctx-size 65536 `
      --parallel 1 `
      -ngl 999 `
      --jinja `
      --chat-template-kwargs '{"preserve_thinking":true}' `
      --spec-type draft-dflash `
      --spec-draft-n-max 7 `
      --spec-draft-backend-sampling
    ```

    becomes `qwen3.8-27b.ini`:

    ```ini
    version = 1

    [qwen3.8-27b]
    load-on-startup = true
    hf-repo = unsloth/Qwen3.8-27B-GGUF
    hf-file = Qwen3.8-27B-UD-Q4_K_M.gguf
    hf-repo-draft = z-lab/Qwen3.8-27B-DFlash2-GGUF
    spec-draft-model = Qwen3.8-27B-DFlash2-Q4_K_M.gguf
    no-mmproj = true
    batch-size = 4096
    ubatch-size = 1024
    ctx-size = 65536
    parallel = 1
    ngl = 999
    jinja = true
    chat-template-kwargs = {"preserve_thinking":true}
    spec-type = draft-dflash
    spec-draft-n-max = 7
    spec-draft-backend-sampling = true
    ```
  </Step>
  <Step title="Start the router with the preset and connect Atomic">
    In PowerShell inside the `llama.cpp` directory, set `$env:HF_TOKEN` if the recipe uses a gated model, then run:

    ```powershell
    .\llama.exe serve --models-preset qwen3.8-27b.ini --host 127.0.0.1
    ```

    Verify readiness with `curl.exe http://127.0.0.1:9931/models` until `qwen3.8-27b` reports status `loaded`. Then follow [Configure Atomic](#configure-atomic) to connect to `http://127.0.0.1:9931` and select `qwen3.8-27b` in `/model`.
  </Step>
</Steps>

<Note>
NVIDIA recipe memory budgets assume only that model occupies the GPU. Unload other loaded models in `/llama` before running a recipe model.
</Note>

## Troubleshooting {#troubleshooting}

Check router health and loaded models directly:

```bash
curl http://127.0.0.1:9931/health
curl http://127.0.0.1:9931/models
```

- **Server unreachable (`server-unreachable` / `LlamaServerUnreachableError`, retryable):** `llama serve` is not running, the port or host is wrong, DNS failed, or you used `https://` against a plain-HTTP server. Verify the server is listening and recheck `/login llama.cpp` or `LLAMA_BASE_URL`.
- **Request rejected (`request-rejected` / `LlamaServerRequestError`, non-retryable):** The runtime refused the configured URL before contacting the server—for example, embedded `user:pass@` credentials in the URL or a fetch-blocked port such as `6000`. Use a plain `http://` or `https://` address on a standard port (such as default `9931`) and pass any API key separately.
- **No models in `/llama`:** Verify cached models or your `--models-dir` folder layout, then restart the router.
- **Model missing from `/model` with `--no-models-autoload`:** Load the model in `/llama` first.
- **Thinking controls missing:** Load the model in `/llama`, then refresh `/model`; thinking controls appear only for currently loaded models whose chat template supports thinking.
- **Load fails or runs out of memory:** Lower `-c` or unload another model in `/llama`.
- **Server is not in router mode:** Start `llama serve` without `--model`, `-m`, or `-hf`.
