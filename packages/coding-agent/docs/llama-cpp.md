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

## Configure Atomic

Run:

```text
/login llama.cpp
```

Enter the router URL and optional API key. The default URL is `http://127.0.0.1:8080`. The same values can be supplied without `/login`:

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

Atomic asks before unloading other models, never silently unloads models, and never deletes model files. `/llama` always displays the router's current state because other clients may share it. Only loaded models appear in `/model`; load one first, then select it there. If the router disconnects, choose **Retry** to reconnect and refresh state without replaying the interrupted operation.

## Troubleshooting

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **No models in `/llama`:** Check `--models-dir`, the directory layout, and restart the router.
- **Model missing from `/model`:** Load it with `/llama` first.
- **Load fails or uses too much memory:** Lower `-c` or unload another model.
- **Server is not in router mode:** Start it without `--model`, `-m`, or `-hf`.
