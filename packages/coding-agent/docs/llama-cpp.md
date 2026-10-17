---
title: "Local models"
description: "Run models locally with a llama.cpp server: discovery, load management, and downloads."
---

# llama.cpp

Atomic supports the [llama.cpp](https://github.com/ggml-org/llama.cpp) router server. The router discovers multiple GGUF models and loads or unloads them on demand.

Use a current llama.cpp build with router support. Follow its [build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) or install a [prebuilt release](https://github.com/ggml-org/llama.cpp/releases).

## Start the router

Start `llama-server` without `--model` or `-m`; those options start single-model mode instead of router mode.

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

- `--models-dir` discovers local GGUF files.
- `--no-models-autoload` leaves loading under explicit `/llama` control.
- `--jinja` enables compatible chat templates and tool calling.
- `-ngl 999` offloads as many layers as possible to the GPU.
- `-c 32768` sets each model's context window. Omit it to use the model's native context, which may require substantially more memory.

Single-file models can sit directly in the model directory. Put multimodal and multi-shard models in separate subdirectories with their projection or shard files. Restart the router after manually adding files. Per-model context sizes and other options can be set with [model presets](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets).

For settings tuned to a specific NVIDIA GPU and model, see [NVIDIA RTX recipes](#nvidia-rtx-recipes).

## Configure Atomic

Run:

```text
/login llama.cpp
```

Enter the router URL and optional API key. The default URL is `http://127.0.0.1:8080`. If the router uses `--no-models-autoload`, login only stores the connection; use `/llama` to load a model, then `/model` to select it. The same values can be supplied without `/login`:

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
atomic
```

If the server requires a key, start `llama-server` with the matching `--api-key`. Keep `--host 127.0.0.1` for local-only access.

## Manage models

Run `/llama` in interactive mode:

- Select an unloaded model to load it, or a loaded model to unload it.
- Select **Download model…**, search Hugging Face, then choose a repository and quantization. Exact `owner/repository[:quant]` values also work.
- Press Escape during a load or download to confirm cancellation.

Hugging Face search uses `HF_TOKEN` when set, then checks `$HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, and `~/.cache/huggingface/token`. Unauthenticated search has lower rate limits. Atomic warns before gated downloads and links to the access page. Because llama.cpp performs the download, its process must also have `HF_TOKEN` for gated repositories.

Atomic asks before unloading other models, never silently unloads models, and never deletes model files. `/llama` displays the router's current state because other clients may share it. Loaded and sleeping models appear in `/model`; sleeping models wake automatically when selected. With router autoload enabled, unloaded preset models also appear and load when selected. With `--no-models-autoload`, load a model through `/llama` before selecting it.

Atomic saves the last successful loaded-model catalog in `~/.atomic/agent/models-store.json`, or the active custom agent directory. Those entries remain selectable after restart until the first successful refresh. If the first online refresh fails, Atomic reports the router error and keeps the validated persisted catalog available. A later successful refresh replaces stale loaded-state entries without duplicates.

If the router disconnects, choose **Retry** to reconnect and refresh state without replaying the interrupted operation.

Each llama model uses the router-reported loaded context (`meta.n_ctx`, then training context, otherwise Atomic's fallback) for both `contextWindow` and `maxTokens`; Atomic no longer applies a separate 16K output cap. The server remains authoritative and may impose a smaller practical generation limit.

## NVIDIA RTX recipes

[NVIDIA Local AI Inference Recipes](https://nvidia.github.io/local-ai-inference-recipes/index.html) provides llama.cpp settings tuned for specific NVIDIA hardware and models. Each recipe gives a single-model `llama-server` command. Convert it into a router preset so the router can serve it alongside other models. The examples below use Windows PowerShell.

### Before you begin

1. Open the [recipe catalog](https://nvidia.github.io/local-ai-inference-recipes/index.html), select your hardware, operating system, and model, then choose **llama.cpp**. Check the prerequisites and memory requirements. Keep the recipe's launch command for the conversion below.
2. Install llama.cpp with the recipe's setup instructions. The recipe's settings depend on its build, for example CUDA support or speculative decoding options.
3. Run `llama-server --help` and check that it lists `--models-preset`. Without it, the build cannot load the recipe as a router preset. Use a newer build that still meets the recipe's requirements.
4. Install Atomic with the [Quickstart](/quickstart). On native Windows, also see [Run Atomic on Windows](/windows).

### Convert the recipe to a preset

A preset lists the settings for one or more models. Each section name becomes the model ID shown in Atomic. Save the preset next to `llama-server`, or pass its full path when starting the router.

Convert each option from the recipe command into one preset line:

- Remove the leading dashes: `--ctx-size 65536` becomes `ctx-size = 65536`.
- Write options without a value as `true`: `--jinja` becomes `jinja = true`.
- Remove quotes and PowerShell line-continuation backticks around values.
- Leave out `--host` and `--port`. They belong on the router command line.
- Add `load-on-startup = true` so the router loads the model when it starts.
- Replace short model-file options with their long preset keys:

| Recipe option | Preset key |
|---|---|
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

Open PowerShell in the llama.cpp folder and run:

```powershell
.\llama-server.exe --models-preset qwen3.8-27b.ini --host 127.0.0.1 --port 8080
```

If the recipe requires a Hugging Face token, set `$env:HF_TOKEN` in the same PowerShell window before starting the router. On its first start, the router downloads the model files.

Use the [health checks](#troubleshooting) to confirm that the server is ready. In Windows PowerShell, use `curl.exe` rather than `curl`, which PowerShell maps to a different command. The model is ready when `/models` lists `qwen3.8-27b` with the status `loaded`.

Then follow [Configure Atomic](#configure-atomic) and connect to `http://127.0.0.1:8080`. The preset section name is the model ID, so select `qwen3.8-27b` in `/model` for this example.

NVIDIA recipe memory settings assume that only the selected model uses the GPU. If `/llama` shows other loaded models, unload them before using the recipe model.

## Classification

Classifier models answer typed `choice`, `bool`, and `score` questions about JSON state, like TypeSafe's Jev models, so a local model can make `model: "auto"` routing decisions. Extensions can call `ctx.modelRegistry.classify()` and codemode scripts can call `models.classify()`; see [Classifier models](/models#use-classifier-models). Atomic lists llama.cpp models as classifiers in two ways:

- **Decision models** such as Julia-1, Laya, Kev, lev, and OpenJev answer natively through llama.cpp's `/v1/systemone` endpoint with the `typesafe-system-one` API. Decision-only models do not appear in `/model`.
- **Chat models** are also listed as classifiers with the same ID and the `llama-cpp-classify` API, which reads answers from next-token probabilities as described below.

llama.cpp 0.6.0 and later report decision models through `architecture.output_modalities` containing `decisions`. Atomic recognizes these models even when sleeping or unloaded, without loading them during discovery. Unloaded presets are selectable only when router autoload is enabled. Older servers omit this metadata, so their models use the chat-model fallback.

### Chat models as classifiers

The model does not generate an answer. Each question becomes one chat prompt: the state, every question of the request, the state again, and then the question with its answers under single-token labels. Labels are letters for a choice (up to 62 options), `Yes`/`No` for a bool, and digits for a score (up to 10 levels). Atomic reads the probabilities of the labels as the next token and normalizes them. A choice returns every option's probability and a confidence of `(n * peak - 1) / (n - 1)`; a score returns the expected level.

- An explicit [`routerModel`](/settings#routermodel) resolves a classifier before a chat model, so `routerModel: "llama.cpp/<id>"` routes with the classifier, not the chat model. A routing shortlist with more than 62 models fails on the chat-model classifier, and routing switches to the current chat model. The **Router model** picker lists each chat-capable llama.cpp model twice, once as a classifier and once as a chat model; both rows save the same ID. Decision-only models have only a classifier row.
- The `structured_output` tool and `generateStructuredOutput()` resolve the chat model first when a chat and a classifier model share an ID, so naming `llama.cpp/<id>` there keeps using the chat model.
- Raw label probabilities are usually overconfident. The `temperature` option of SDK `classify()` calls divides the label logits before normalizing; values above 1 soften the distribution. It changes no answer.
- Questions run one after another. Everything before the final question is the same for all questions of a request, so the server's prompt cache evaluates it once. The state appears twice, so it needs twice its size in context.
- Small models may follow instructions written inside the state. The prompt tells the model to judge the state as data, but that is not a guarantee.
- Hybrid models such as Qwen3.5 cannot rewind a partially cached prompt without context checkpoints. If each question reprocesses the whole state, start the router with `--ctx-checkpoints 32 --checkpoint-min-step 0`.

## Troubleshooting

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **No models in `/llama`:** Check `--models-dir`, the directory layout, and restart the router.
- **Model missing from `/model` with `--no-models-autoload`:** Load it with `/llama` first.
- **Load fails or uses too much memory:** Lower `-c` or unload another model.
- **Server is not in router mode:** Start it without `--model`, `-m`, or `-hf`.
