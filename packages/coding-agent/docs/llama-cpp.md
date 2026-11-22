---
title: "Local models"
description: "Run models locally with a llama.cpp router server: discovery, load management, downloads, and local classification."
---

# llama.cpp

Atomic supports the [llama.cpp](https://llama.app) router server. The router discovers multiple GGUF models and loads or unloads them on demand.

## Install llama.cpp

Install llama.cpp with the [official installer](https://llama.app/docs/installation):

```bash
curl -LsSf https://llama.app/install.sh | sh
```

Verify the installation:

```bash
llama --version
```

See [llama.app](https://llama.app) for package managers and building from source.

## Start the router

Start `llama serve` without `--model`, `-m`, or `-hf`, which start single-model mode instead of router mode. See the [llama.cpp server guide](https://llama.app/docs/serve#serving-multiple-models-router-mode) for full router options.

```bash
llama serve \
  --no-models-autoload \
  --host 127.0.0.1 \
  -ngl all \
  -c 32768
```

- `--no-models-autoload` keeps model loading under explicit `/llama` control.
- `-ngl all` offloads all layers to the GPU. Omit it for automatic GPU offloading.
- `-c 32768` sets the context size in tokens. Use `-c 0` for a model's full context window, which uses more memory. Parallel server slots share context.
- `--models-dir ~/models` discovers local GGUF files in that directory.

Place single-file models directly in the model directory, and put multimodal or multi-shard models in separate subdirectories with their projection or shard files. Restart the router after adding files manually. The router also reads cached models and `--models-preset` files; see the [server guide](https://llama.app/docs/serve#serving-multiple-models-router-mode).

For settings tuned to a specific NVIDIA GPU and model, see [NVIDIA RTX recipes](#nvidia-rtx-recipes).

## Configure Atomic

Run `/login llama.cpp` and enter the router URL and optional API key. The default URL is `http://127.0.0.1:9931`. When the router runs with `--no-models-autoload`, login saves only the connection; load a model with `/llama`, then select it with `/model`.

You can configure the same values with environment variables instead of `/login`:

```bash
export LLAMA_BASE_URL=http://127.0.0.1:9931
export LLAMA_API_KEY=optional-secret
atomic
```

If the server requires an API key, start `llama serve` with the matching `--api-key`. Keep `--host 127.0.0.1` for local-only access.

## Manage models

Run `/llama` in interactive mode to manage router models:

- Select an unloaded model to load it, or a loaded model to unload it.
- Select **Download model…** to search Hugging Face and pick a repository and quantization. Typing an exact `owner/repository[:quant]` value and pressing Enter downloads it directly.
- Press Escape during a load or download to confirm cancellation.

Hugging Face search checks `HF_TOKEN`, then `$HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, and `~/.cache/huggingface/token`. Unauthenticated search has lower rate limits. Atomic warns before gated downloads and links to the access page; because llama.cpp performs the download, its process also needs `HF_TOKEN` for gated repositories.

Atomic asks before unloading other models, never silently unloads models, and never deletes model files. `/llama` reads the router's live state because other clients may share the server. Loaded and sleeping models appear in `/model`, and sleeping models wake automatically when selected. With router autoload enabled, unloaded preset models also appear in `/model` and load on selection; with `--no-models-autoload`, load them through `/llama` first.

Atomic caches the last loaded-model catalog in `~/.atomic/agent/models-store.json` (or the active agent directory). Cached entries stay selectable across restarts until the next successful refresh. If an online refresh fails, Atomic reports the router error and keeps the cached catalog; a later successful refresh replaces stale entries without duplicates.

If the router disconnects, select **Retry** to reconnect and refresh state without replaying the interrupted action.

Each llama.cpp model sets both `contextWindow` and `maxTokens` from the router-reported context window (`meta.n_ctx`, then the model's configured `--ctx-size`, cached context, training context `meta.n_ctx_train`, or the 128,000-token fallback). The server remains authoritative and may enforce a smaller generation limit.

## NVIDIA RTX recipes

[NVIDIA Local AI Inference Recipes](https://nvidia.github.io/local-ai-inference-recipes/index.html) publishes llama.cpp settings tuned for specific NVIDIA GPUs and models. Each recipe provides a single-model `llama-server` command. Convert it into a router preset file so `llama serve` (which accepts the same options) can serve it alongside other models. The examples below use Windows PowerShell.

### Before you begin

1. Open the [recipe catalog](https://nvidia.github.io/local-ai-inference-recipes/index.html), choose your hardware, OS, and model, then select **llama.cpp**. Check prerequisites and memory requirements, and keep the launch command.
2. Install llama.cpp using the recipe's setup instructions so your build includes any required CUDA or speculative-decoding features.
3. Run `llama serve --help` and verify that `--models-preset` is listed. If `llama` or `--models-preset` is missing, update to a newer compatible build.
4. Install Atomic via the [Quickstart](/quickstart). On native Windows, see [Run Atomic on Windows](/windows).

### Convert the recipe to a preset

A preset file defines settings for one or more models, and each section header becomes the model ID in Atomic. Save the file in the llama.cpp directory or pass its full path to `llama serve`.

Convert each command-line option into a preset line:

- Drop leading dashes: `--ctx-size 65536` becomes `ctx-size = 65536`.
- Set boolean flags to `true`: `--jinja` becomes `jinja = true`.
- Strip quotes and PowerShell line-continuation backticks around values.
- Omit `--host` and `--port` (pass them to `llama serve` instead).
- Add `load-on-startup = true` to load the model when the router starts.
- Map short model-file flags to their preset keys:

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

### Start the recipe router

Open PowerShell in the llama.cpp directory and run:

```powershell
.\llama.exe serve --models-preset qwen3.8-27b.ini --host 127.0.0.1
```

If the recipe needs a Hugging Face token, set `$env:HF_TOKEN` in the same PowerShell session before starting the router. The first launch downloads the model files.

Check readiness with the [troubleshooting commands](#troubleshooting). In PowerShell, use `curl.exe` instead of `curl`. The model is ready when `/models` lists `qwen3.8-27b` with status `loaded`.

Follow [Configure Atomic](#configure-atomic) to connect to `http://127.0.0.1:9931`, then select `qwen3.8-27b` in `/model`.

NVIDIA recipe memory budgets assume only that model occupies the GPU. Unload any other loaded models in `/llama` before running the recipe model.

## Classification

Classifier models answer typed `choice`, `bool`, and `score` questions about JSON state, letting a local model serve `decide()` and `structured_output` decisions as your [`decisionModel`](/settings#decisionmodel). Extensions can call `ctx.modelRegistry.classify()` and codemode scripts can call `models.classify()`; see [Classifier models](/models#use-classifier-models).

Atomic exposes llama.cpp models as classifiers in two ways:

- **Decision models** (such as Julia-1, Laya, Kev, lev, and OpenJev) answer natively through llama.cpp's `/v1/systemone` endpoint with the `typesafe-system-one` API. Decision-only models do not appear in `/model`.
- **Chat models** are also exposed as classifiers under the same ID with the `llama-cpp-classify` API, using next-token log-probabilities.

llama.cpp 0.6.0 and newer identify decision models by including `decisions` in `architecture.output_modalities`. Atomic detects them even when sleeping or unloaded without waking them during discovery. Unloaded presets are selectable only when router autoload is enabled. Older servers omit this metadata and fall back to `llama-cpp-classify`.

### Chat models as classifiers

Rather than generating text, Atomic formats each question as a single chat prompt (state, all request questions, state again, then the target question and single-token labels) and reads next-token probabilities for the labels. Labels are alphanumeric characters for `choice` (2 to 62 options), `Yes`/`No` for `bool`, and digits for `score` (2 to 10 levels). Choices return normalized option probabilities and a confidence of `(n * peak - 1) / (n - 1)`; scores return the expected level.

Key behavior for chat-model classifiers:

- An explicit [`decisionModel`](/settings#decisionmodel) resolves classifiers before chat models, so `decisionModel: "llama.cpp/<id>"` uses the classifier. A choice with more than 62 options fails on `llama-cpp-classify` and falls back to the active chat model. The **Decision model** picker lists each chat model twice (classifier and chat), saving the same ID; decision-only models have only a classifier row.
- `structured_output` and `generateStructuredOutput()` resolve chat models before classifiers when both share an ID, so naming `llama.cpp/<id>` there uses the chat model.
- SDK `classify()` accepts a `temperature` option that divides label logits before normalizing. Values above `1` soften overconfident probabilities without changing the winning answer.
- Questions run sequentially and share the prompt prefix so the server's prompt cache evaluates it once. Because the state appears twice in the prompt, reserve twice the state size in context.
- Small models may follow prompt-injection instructions inside the state despite the system prompt instructing them to judge the state as data.
- Hybrid models such as Qwen3.5 need context checkpoints to reuse a cached prefix across questions. If every question reprocesses the full state, start the router with `--ctx-checkpoints 32 --checkpoint-min-step 0`.

## Troubleshooting

```bash
curl http://127.0.0.1:9931/health
curl http://127.0.0.1:9931/models
```

- **No models in `/llama`:** Verify cached models or `--models-dir` layout, then restart the router.
- **Model missing from `/model` with `--no-models-autoload`:** Load it in `/llama` first.
- **Load fails or runs out of memory:** Lower `-c` or unload another model.
- **Server is not in router mode:** Start `llama serve` without `--model`, `-m`, or `-hf`.
