---
title: "Codemode"
description: "The codemode script reference: globals, tool calls, stored values, classifier and image models, and limits."
---

# Codemode

`codemode` lets the model run a JavaScript script that calls Atomic tools and non-LLM models (classifiers and image generators) and returns only the filtered result. It is enabled by default; see [`codemode` in Built-in tools](/tools#codemode) to toggle it. To embed the sandbox in your own app, see [`@bastani/atomic-codemode`](/libraries/codemode).

## Scripts

Pass raw JavaScript source (no JSON wrapper or markdown code fences). Code runs as an async function body inside a QuickJS sandbox, so top-level `await` and `return` work. The sandbox has no Node APIs, filesystem, network, or timers; external access goes exclusively through `tools` and `models`.

Optional first-line directives configure output budget and timeout (must be line 1 or the call fails):

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

- **`max_output_tokens` (default `10000`).** Caps returned text. Overflow keeps the start and end and writes full output to a temp file whose path is included.
- **`timeout_ms` (unset by default).** Hard deadline for the whole script, including waiting for a worker slot. Avoid short deadlines when generating images, which can take minutes.

**Result format.** Starts with `Script completed` or `Script failed` plus wall time, followed by text and image items in order. Multiple text items (from `text()` or `return`) are separated by `==> text N/M <==`. `console.*` output follows in one `<console_output>` block. On failure, partial output is kept before `Script error:`. Side effects from completed tool calls are **not** rolled back; still-running calls are cancelled and unawaited promises are dropped when the script exits.

## Globals

| Global | Purpose |
| --- | --- |
| `tools.<name>(args)` | Call a permitted tool. See [Call tools](#call-tools). |
| `text(value)` | Emit a text item (strings verbatim, other values as JSON). |
| `image(value)` | Emit an image from a base64 `data:` URL, `{ image_url }`, or `{ type: "image", data, mimeType }` (PNG, JPEG, GIF, WebP; no remote URLs or SVG; see [Generate images](#generate-images)). Also saves to a temp file and prints its path. |
| `console.log(...)` | Append a space-joined line to `<console_output>` (`info`, `warn`, `error`, and `debug` behave identically). |
| `return value` | Top-level `return` emits `value` like `text()`. |
| `exit()` | End the script immediately with success. |
| `store(key, value)` / `load(key)` | Persist small JSON values across `codemode` calls on this branch. See [Store values](#store-values). |
| `ALL_TOOLS` | Array of `{ name, description }` for every script-callable tool (excludes [model-only tools](#model-only-tools)). |
| `searchTools(query, { limit?, namespace? })` | BM25 search over script-callable tools (default `limit: 8`). Exact tool names or suffixes after `__` (such as `thread_read` for `mcp__app__thread_read`) rank first. An exact active model-only tool name returns a hint to call it directly. |
| `describeTool(name)` | Returns a script-callable tool's description and TypeScript declaration, a direct-call hint for an active model-only tool, or `undefined`. |
| `describeNamespace(name)` | Returns `{ name, description?, instructions?, tools }` for a namespace (such as an MCP server), or `undefined`. |
| `models` | Inspect and invoke classifier and image models. See [Models](#models). |

## Call tools

Every script-callable tool is exposed on `tools` with non-identifier characters converted to `_` (for example `mcp__dev-docs__search` becomes `tools.mcp__dev_docs__search`). Each method accepts one argument object.

**Return values:**
- **Tools with `outputSchema`.** Resolve to their structured object (including structured failures). `bash` resolves to `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }` even for nonzero exit codes; `output` keeps up to 1 MiB (first and last 512 KiB around an omission marker if truncated, with full text in `full_output_path`).
- **MCP tools.** Resolve to `CallToolResult` (`content`, `isError`, and typed `structuredContent`).
- **`read`.** Resolves to text (including path headers and line numbers unless `:raw`), or for images to `{ type: "image", data, mimeType, note }` usable directly with `image()`.
- **Other tools (`edit`, `write`, and similar).** Resolve to text.

**Errors and discovery:**
- Failed, blocked, or invalid calls reject with `Error` (except schema-backed tools that return a structured error value; check `exit_code` or `isError`). Use `Promise.allSettled()` for independent calls.
- Accessing an unknown tool throws with close-match suggestions (for example `tools.Bash` suggests `tools.bash`). Check availability with `"name" in tools`.
- Inline tool declarations share a `3000`-token budget (`codemode.inlineBudget` in [settings](/settings#tools)); deferred tools stay unlisted and are found via `searchTools()`, `describeTool()`, `describeNamespace()`, or `ALL_TOOLS`.
- `codemode.mode` in [settings](/settings#tools) controls tool visibility: `"on"` (default) keeps direct tools declared alongside codemode; `"only"` hides ordinary direct tools so the model calls them through codemode while keeping active model-only tools (like `ask_user_question`) top-level. Declarations in `codemode`, `describeTool()`, and `ALL_TOOLS` carry each tool's prompt guidelines.

### Model-only tools

Tools without script access (such as `ask_user_question`) are absent from `tools`, `ALL_TOOLS`, and `searchTools()` rankings. Call them as top-level tools instead. Querying their exact name with `searchTools()` or `describeTool()` returns a hint to call them directly without making them script-callable.

Two tools expose a script-safe subset:
- **`tools.subagent`.** Launches children (`{ agent, task }` or `{ tasks }`) and returns task IDs at admission; also supports `status`, bounded `wait`, `pause`, `quit`, `resume`, and agent and model inspection. A script timeout cancels `wait`, not the child; admitted children continue after a script returns or throws. See [Subagents from codemode scripts](/subagents#from-codemode-scripts).
- **`tools.intercom`.** Supports `list`, `status`, `pending`, and `send` to an exact target (returning structured results). Other actions and glob or `subagents:` targets must be called directly. See [Intercom from codemode scripts](/intercom/reference#from-codemode-scripts).

## Store values

`store(key, value)` saves a JSON value for subsequent `codemode` calls; `store(key, undefined)` deletes it; `load(key)` reads it back (or `undefined`).

- Persists only when the script succeeds by appending a `codemode-store` session entry, so values survive resume and stay isolated per session branch.
- Size caps: 262,144 JSON characters per value, 1,048,576 characters total across all keys. Do not store images; emit them with `image()`, which writes a temp file automatically.

## Models

`models` accesses the model catalog and calls non-LLM models using the session's credentials:
- **Classifiers.** Answer typed questions about JSON state (and images when supported). Examples: [TypeSafe Jev](/providers#typesafe-jev), [OpenAI GPT-6 Luna](/models#use-classifier-models), and [local llama.cpp models](/llama-cpp).
- **Image models.** Generate or edit images. Examples: OpenRouter (`provider: "openrouter"`, IDs such as `google/gemini-2.5-flash-image` and `black-forest-labs/flux.2-pro`, reusing your OpenRouter credential) and OpenAI (`provider: "openai-images"`, such as `gpt-image-2.6-flare`, reusing your [OpenAI API key](/providers#subscription-and-api-key-at-the-same-time)).

Chat models are listed in the catalog but cannot be called from scripts. Neither classifiers nor image models appear in `/model`.

```ts
type ModelType = "chat" | "image" | "classifier";

interface ModelInfo {
  type?: ModelType;
  provider: string;
  id: string;
  name: string;
  api: string;
  input: ("text" | "image")[];
  contextWindow?: number;
  [key: string]: unknown;
}

declare const models: {
  getModelsOfType(type: ModelType, provider?: string): Promise<ModelInfo[]>;
  getAvailableOfType(type: ModelType, provider?: string): Promise<ModelInfo[]>;
  getModelOfType(type: ModelType, provider: string, id: string): Promise<ModelInfo | undefined>;
  classify(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>;
  generateImages(model: ModelInfo, context: ImagesContext, options?: ImagesOptions): Promise<ImagesResult>;
};
```

- Pass a `ModelInfo` or `{ provider, id }`; script-supplied `baseUrl` or headers are ignored so credentials cannot be redirected.
- Provider errors do not throw; check `stopReason`, `errorMessage`, and (for images) `error`. Malformed arguments or unknown models do throw and point to `models.getAvailableOfType(type)`.
- Up to 4 model calls run concurrently per script (extra calls queue, so `Promise.all()` is safe). Token usage and cost count toward the session total.

### Classify

```ts
interface ClassifierContext {
  state: Record<string, unknown>;
  images?: { type: "image"; data: string; mimeType: string }[];
  questions: Record<string, ClassifierQuestion>;
}

type ClassifierQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] } // Lowest level first
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };

interface ClassifierResult {
  provider: string;
  model: string;
  answers: Record<string, ClassifierAnswer>;
  usage?: ModelUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}

type ClassifierAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number } // Expected index, 0..criteria.length - 1
  | { type: "bool"; probability: number };

type ModelUsage = { input: number; output: number; totalTokens: number; cost: { total: number } };
```

Classify multiple items in parallel:

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const results = await Promise.all(
  messages.map((message) =>
    models.classify(jev, {
      state: { message },
      questions: {
        sentiment: {
          type: "choice",
          instructions: "How does the user feel about the product?",
          criteria: { positive: "Satisfied or happy", negative: "Unhappy or frustrated", neutral: "Neither" },
        },
        urgency: {
          type: "score",
          instructions: "How urgently does this need a reply?",
          criteria: ["no reply needed", "reply this week", "reply today"],
        },
      },
    }),
  ),
);
return results.map((result, i) =>
  result.stopReason === "stop"
    ? { message: messages[i], sentiment: result.answers.sentiment.choice, urgency: result.answers.urgency.score }
    : { message: messages[i], error: result.errorMessage },
);
```

When a classifier's `input` includes `"image"`, pass image blocks (such as those returned by `tools.read()`) in `images` (text-only models return an error result for non-empty `images`):

```js
const luna = await models.getModelOfType("classifier", "openai-decisions", "gpt-6-luna");
const photo = await tools.read({ path: "screenshot.png" });
const result = await models.classify(luna, {
  state: { task: "Settings page redesign" },
  images: [photo],
  questions: {
    broken: {
      type: "bool",
      instructions: "Does the screenshot show a broken layout?",
      criteria: { true: "Overlapping, cut-off, or misaligned elements", false: "Clean layout" },
    },
  },
});
return result.stopReason === "stop" ? result.answers : result.errorMessage;
```

### Generate images

```ts
interface ImagesContext {
  input: (TextBlock | ImageBlock)[];
}

// Unsupported options (such as `apiKey`, `headers`, or `fetch`) throw.
interface ImagesOptions {
  size?: string;
  quality?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
  n?: number;
  background?: "transparent" | "opaque" | "auto";
  outputFormat?: "png" | "jpeg" | "webp" | "svg" | "gif";
  outputCompression?: number;
  frameCount?: number;
  frameDurationMs?: number;
  complexity?: "low" | "medium" | "high";
  svg?: { model: string; reasoning?: { effort?: string } };
  moderation?: "auto" | "low";
  safetyIdentifier?: string;
}

interface ImagesResult {
  provider: string;
  model: string;
  output: (TextBlock | ImageBlock)[];
  usage?: ModelUsage;
  svgModel?: string;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  error?: { name: string; code: string; message: string; hint?: string; retryable: boolean; fields: Record<string, unknown> };
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string; role?: "markup" | "mask" };
```

- **Provider options.** `ImagesOptions` targets OpenAI's `openai-images` models (OpenRouter models ignore them). The first untagged image is the base image to edit; additional untagged images are references. `role: "markup"` is a same-size transparent PNG overlay; `role: "mask"` is an alpha mask (mutually exclusive).
- **GIF and SVG.** `outputFormat: "gif"` (`frameCount` `2` to `16`, `frameDurationMs` `20` to `2000`) and `"svg"` require a GPT Image 2.6 model with text-only input.
- **SVG authoring model.** `{ outputFormat: "svg" }` works without extra options. If an account requires `svg.model` and you omitted `svg`, Atomic retries once with `gpt-6.1-sol` (reported in `result.svgModel`), and retries once without `svg` if rejected as unsupported. An explicit `svg: { model, reasoning }` is sent verbatim without automatic fallback. Allow at least `timeout_ms: 180000` for SVG requests (Atomic's own request timeout is at least 10 minutes).
- **Structured errors.** Invalid options fail locally with `stopReason: "error"`, `error.code: "invalid-option"`, and `error.fields.field` (plus `error.fields.reason`: `required-by-api`, `rejected-by-api`, or `unsupported-by-api` for SVG). Other codes: `moderation-blocked`, `user-error`, `quota-exceeded`, `rate-limited`, `server-error`, `timeout`, `api-error`. Branch on `error.code` and `error.retryable` (see [Image generation](/extensions/api-reference#ctx-modelregistry-/-ctx-model-/-ctx-scopedmodels)).
- **Displaying and saving output.** Call `image(block)` for PNG, JPEG, GIF, and WebP (never print base64 `data` via `text()` or `return`; scripts that generate images without showing any receive a note). `image()` also saves each image to a private temp file and prints its path. For SVG (`image/svg+xml`), Atomic automatically saves a private temp `.svg` file (`[SVG saved to <path> (image/svg+xml, <size>)]`), and scripts can inspect XML text via `atob(block.data)`.

```js
// @options: {"timeout_ms": 300000}
const painter = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
const result = await models.generateImages(painter, {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return result.errorMessage;
for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
```

SVG and animated GIF with GPT Image 2.6:

```js
// @options: {"timeout_ms": 180000}
const flare = await models.getModelOfType("image", "openai-images", "gpt-image-2.6-flare");
const logo = await models.generateImages(flare, {
  input: [{ type: "text", text: "A flat red paper lantern icon" }],
}, { outputFormat: "svg" });
if (logo.stopReason !== "stop") return logo.error ?? logo.errorMessage;

const gif = await models.generateImages(flare, {
  input: [{ type: "text", text: "A paper lantern swinging gently, flat vector style" }],
}, { outputFormat: "gif", frameCount: 4, frameDurationMs: 200, size: "512x512" });
if (gif.stopReason !== "stop") return gif.error ?? gif.errorMessage;
for (const block of gif.output) if (block.type === "image") image(block);
return { svgModel: logo.svgModel, svg: logo.output.map((block) => block.mimeType) };
```

Extensions can call `ctx.modelRegistry.classify()` and `ctx.modelRegistry.generateImages()` directly without codemode.

## Limits

- **Memory.** 256 MiB per script VM (`InternalError: out of memory`); filter or aggregate data instead of buffering everything.
- **Cancellation.** Stopping a script or hitting `timeout_ms` cancels the call promptly. In the standalone Bun binary, non-interruptible native built-ins (such as a long regex or string search) finish before the worker exits.
- **Worker concurrency.** Default max `2` live workers per Atomic process (override with `ATOMIC_CODEMODE_MAX_WORKERS`). Cancelled workers occupy a slot until exit. Additional scripts queue in FIFO order and fail if no slot opens within 60 seconds (or `timeout_ms`).
- **Deadlocks and nesting.** Waiting on a promise with no pending tool call fails immediately because there are no timers. Scripts cannot invoke `codemode` recursively.
