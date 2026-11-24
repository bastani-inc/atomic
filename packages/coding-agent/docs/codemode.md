---
title: "Codemode reference"
sidebarTitle: "Codemode"
description: "Write JavaScript scripts inside Atomic's sandbox to compose tool calls, persist state across turns, and call classifier or image models."
---

`codemode` lets the model run a JavaScript script that calls Atomic tools and non-LLM models (classifiers and image generators) and returns only the filtered result. It is enabled by default. Toggle it from the CLI or settings ([`codemode` in Built-in tools](/tools#codemode)), or from the SDK with `tools: ["-codemode"]`, `noTools: "builtin"`, or `DefaultResourceLoader({ disabledBuiltinExtensions: ["codemode"] })` ([SDK extensions](/sdk/reference#extensions)). For multi-step subagent workflows in codemode, see [Orchestrate with codemode and subagents](/orchestration). To embed the sandbox in your own application, see [`@bastani/atomic-codemode`](/libraries/codemode).

## Scripts

Pass raw JavaScript source with no JSON wrapper or markdown code fences. Code runs as an async function body inside a sandboxed JavaScript runtime, so top-level `await` and `return` work. The sandbox has no Node or Bun APIs, filesystem, network, or timers; all external access goes through `tools` and `models`.

```javascript
const [readme, pkg] = await Promise.all([
  tools.read({ path: "README.md:1-40" }),
  tools.read({ path: "package.json" }),
]);
return { name: JSON.parse(pkg).name, excerpt: readme.slice(0, 400) };
```

An optional first-line directive sets the output budget and timeout. It must be line 1 followed by JavaScript code; unknown keys or a script with no code after the directive fail immediately:

```javascript
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

- **`max_output_tokens` (default `10000`).** Non-negative safe integer (`0` is accepted; budget is `max_output_tokens * 4` characters). Overflow keeps the start and end and writes full output to a temp file whose path is included in the result.
- **`timeout_ms` (unset by default).** Hard deadline in milliseconds for the whole script, including waiting for a worker slot. Must be a positive integer up to `2147483647` (about 24.8 days); `0`, negative numbers, decimals, or larger values fail before running. Avoid short deadlines when generating images, which can take minutes.

**Result format.** Starts with `Script completed` or `Script failed` plus wall time, followed by text and image items in order. Multiple text items (from `text()` or `return`) are separated by `==> text N/M <==`. `console.*` output follows in one `<console_output>` block. On failure, partial output is kept before `Script error:`. Side effects from completed tool calls are **not** rolled back; still-running calls are cancelled and unawaited promises are dropped when the script exits.

## Globals

Use `await` with every async global (`tools.*`, `searchTools()`, `describeTool()`, `describeNamespace()`, and `models.*`). Output, store, and exit helpers are synchronous.

| Global | Sync / Async | Purpose |
| --- | --- | --- |
| `tools.<name>(args)` | Async (`await`) | Call a permitted tool. See [Call tools](#call-tools). |
| `text(value)` | Sync | Emit a text item (strings verbatim, other values as JSON). |
| `image(value)` | Sync | Emit an image from a base64 `data:` URL, `{ image_url }`, or `{ type: "image", data, mimeType }` (PNG, JPEG except JPEG-LS, GIF, or WebP; no remote URLs or SVG; see [Generate images](#generate-images)). Inspects base64 magic bytes instead of trusting the declared MIME type, strips whitespace and newlines, throws `TypeError` on invalid or mismatched base64, saves a temp file, and prints its path. |
| `console.log(...)` | Sync | Append a space-joined line to `<console_output>` (`info`, `warn`, `error`, and `debug` behave identically). |
| `return value` | Sync | Top-level `return` emits `value` like `text()`. |
| `exit()` | Sync | End the script immediately with success. Persists prior `store()` writes, takes no argument (call `text()` first to emit output), and ignores further `text()` or `image()` calls inside `finally` blocks. |
| `store(key, value)` / `load(key)` | Sync | Persist small JSON values across `codemode` calls on this branch. See [Store values](#store-values). |
| `ALL_TOOLS` | Value | Array of `{ name, description }` for every script-callable tool (excludes [model-only tools](#model-only-tools)). |
| `searchTools(query, { limit?, namespace? })` | Async (`await`) | BM25 search over script-callable tools (`limit` must be a positive integer, default `8`). Exact tool names or suffixes after `__` (such as `thread_read` for `mcp__app__thread_read`) rank first. Querying an exact active model-only tool name returns a hint to call it directly unless `namespace` is passed. |
| `describeTool(name)` | Async (`await`) | Returns a script-callable tool's description and TypeScript declaration, a direct-call hint for an active model-only tool, or `undefined`. Accepts exact names, JS identifiers, `mcp.<server>.<tool>`, `mcp__<raw-server>__<tool>`, `<server>__<tool>`, or `<tool>` suffixes, and throws an ambiguity error if a shorthand matches multiple tools. |
| `describeNamespace(name)` | Async (`await`) | Returns `{ name, description?, instructions?, tools }` for a namespace (such as an MCP server), or `undefined`. |
| `models` | Async methods (`await`) | Inspect and invoke classifier and image models. See [Models](#models). Not exposed in routing-only subagents. |

## Call tools

Every script-callable tool is exposed on `tools` under both its normalized JavaScript identifier (non-identifier characters replaced with `_`, such as `tools.mcp__dev_docs__search`) and its raw tool name (`tools["mcp__dev-docs__search"]`). If two tool names normalize to the same identifier, the first registered tool keeps the normalized key. Each method accepts one argument object.

**Return values:**
- **Tools with `outputSchema`.** Resolve to their structured object (including structured failures). `bash` resolves to `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }` even for nonzero exit codes; `output` keeps up to 1 MiB (the first and last 512 KiB around an omission marker if truncated, with full text in `full_output_path`).
- **MCP tools.** Resolve to `CallToolResult` (`content`, `isError`, and typed `structuredContent`, with `_meta` stripped).
- **`read`.** Resolves to plain LF text with `[Lines S-E of N]` range headers on partial reads (no per-line numbers or local path headers; URL reads include `URL:`, `Status:`, and `Content-Type:` headers; append `:raw` for exact bytes). For images, resolves to `{ type: "image", data, mimeType, note }` usable directly with `image()`.
- **Other tools (`edit`, `write`, and similar).** Resolve to text.

**Errors and discovery:**
- Failed, blocked, or invalid calls reject with `Error` (except schema-backed tools that return a structured error value; check `exit_code` or `isError`). Use `Promise.allSettled()` for independent calls.
- Accessing an unknown tool throws with close-match suggestions (for example `tools.Bash` suggests `tools.bash`). Check availability with `"name" in tools`.
- Inline tool declarations share a `3000`-token budget (`codemode.inlineBudget` in [settings](/settings#tools)); deferred tools stay unlisted and are found via `await searchTools()`, `await describeTool()`, `await describeNamespace()`, or `ALL_TOOLS`.
- `codemode.mode` in [settings](/settings#tools) controls tool visibility: `"on"` (default) keeps direct tools declared alongside codemode; `"only"` hides ordinary direct tools so the model calls them through codemode while keeping active model-only tools (like `ask_user_question`) top-level. Declarations in `codemode`, `describeTool()`, and `ALL_TOOLS` carry each tool's prompt guidelines.

### Model-only tools

Tools without script access (such as `ask_user_question` and `tool_search`) are absent from `tools`, `ALL_TOOLS`, and `searchTools()` rankings. Call them as top-level tools instead. Querying their exact name with `await searchTools()` or `await describeTool()` returns a hint to call them directly without making them script-callable.

Two tools expose a script-safe subset:
- **`tools.subagent`.** Launches subagents (`{ agent, task }` or `{ tasks }`) and returns task IDs at admission; also supports `status`, bounded `wait`, `pause`, `quit`, `resume`, and agent and model inspection. A script timeout cancels `wait`, not the subagent; admitted subagents continue after a script returns or throws. See [Subagents from codemode scripts](/subagents#from-codemode-scripts).
- **`tools.intercom`.** Supports `list`, `status`, `pending`, and `send` to an exact target (returning structured results). Other actions and glob or `subagents:` targets must be called directly. See [Intercom from codemode scripts](/intercom/reference#from-codemode-scripts).

## Store values

`store(key, value)` synchronously saves a JSON value for subsequent `codemode` calls; `store(key, undefined)` deletes it; `load(key)` synchronously reads it back (or returns `undefined`).

- Writes become visible to `load()` immediately inside the same script. They persist to the session history only when the script succeeds (including via `exit()`), so values survive resume and stay isolated per session branch. Failed scripts discard uncommitted writes.
- Keys must be strings. Non-JSON-serializable values (functions, BigInt, circular references) throw `TypeError`.
- Size caps are 262,144 JSON characters per value (`json.length`) and 1,048,576 characters total across all stored entries (`key.length + json.length`). Do not store images; emit them with `image()`, which writes a temp file automatically.

## Models

`models` accesses the model catalog and calls non-LLM models using the session's credentials. Routing-only subagents do not expose `models`.

- **Classifiers.** Answer typed questions about JSON state (and images when supported). Examples: [TypeSafe Jev](/providers#typesafe-jev), [OpenAI GPT-6 Luna](/models#use-classifier-models), and [local llama.cpp models](/llama-cpp).
- **Image models.** Generate or edit images. Examples: OpenRouter (`provider: "openrouter"`, IDs such as `google/gemini-2.5-flash-image` and `black-forest-labs/flux.2-pro`, reusing your OpenRouter credential) and OpenAI (`provider: "openai-images"`, such as `gpt-image-2.6-flare`, reusing your [OpenAI API key](/providers#subscription-and-api-key-at-the-same-time)).

Chat models are listed in the catalog (with active service-tier pricing) but cannot be called from scripts. Neither classifiers nor image models appear in `/model`.

```typescript
type ModelType = "chat" | "image" | "classifier";

interface ModelInfo {
  type?: ModelType;
  provider: string;
  id: string;
  name: string;
  api: string;
  input: ("text" | "image")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
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

```typescript
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

```javascript
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

When a classifier's `input` includes `"image"`, pass image blocks (such as those returned by `tools.read()`) in `images`. Text-only models return an error result for non-empty `images`:

```javascript
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

```typescript
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
  svg?: { model: string; reasoning?: { effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } };
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

- **Provider options.** `ImagesOptions` targets OpenAI's `openai-images` models (OpenRouter models ignore them). The first untagged image is the base image to edit; additional untagged images are references. `role: "markup"` (a same-size transparent PNG overlay) and `role: "mask"` (an alpha mask) are mutually exclusive and require an untagged base image earlier in `input`.
- **OpenAI option validation.** `outputCompression` accepts integers `0` to `100` and is valid only with `outputFormat: "jpeg"` or `"webp"`. `background: "transparent"` is valid only with `"png"`, `"webp"`, or the default format. `safetyIdentifier` has a 128-character limit. `complexity` (`"low"`, `"medium"`, or `"high"`, API default `"high"`) applies to GPT Image 2.6 only.
- **GIF and SVG.** `outputFormat: "gif"` and `"svg"` require a GPT Image 2.6 model with text-only input. For GIF, `frameCount` (`2` to `16`, API default `9`) and `frameDurationMs` (`20` to `2000`, API default `200`, rounded to 10 ms) are rejected unless `outputFormat` is `"gif"`. For SVG, `n` must be `1` or omitted, and the `svg` option is rejected unless `outputFormat` is `"svg"`.
- **SVG authoring model.** `{ outputFormat: "svg" }` works without extra options. If an account requires `svg.model` and you omitted `svg`, Atomic retries once with `gpt-6.1-sol` (reported in `result.svgModel`), and retries once without `svg` if rejected as unsupported. An explicit `svg: { model, reasoning }` is sent verbatim without automatic fallback. Allow at least `timeout_ms: 180000` for SVG requests (Atomic's own request timeout is at least 10 minutes).
- **Structured errors.** Invalid options fail locally with `stopReason: "error"`, `error.code: "invalid-option"`, and `error.fields.field` (plus `error.fields.reason`: `required-by-api`, `rejected-by-api`, or `unsupported-by-api` for SVG). Other codes are `moderation-blocked`, `user-error`, `quota-exceeded`, `rate-limited`, `server-error`, `timeout`, and `api-error`. Branch on `error.code` and `error.retryable` (see [Image generation](/libraries/ai#image-generation)).
- **Displaying and saving output.** Call `image(block)` for PNG, JPEG, GIF, and WebP (never print base64 `data` via `text()` or `return`; scripts that generate images without showing any receive a note). `image()` also saves each image to a private temp file and prints its path. For SVG (`image/svg+xml`), Atomic automatically saves a private temp `.svg` file (`[SVG saved to <path> (image/svg+xml, <size>)]`), and scripts can inspect XML text via `atob(block.data)`.

```javascript
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

```javascript
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

- **Memory.** 256 MiB per script sandbox (`InternalError: out of memory`); filter or aggregate data instead of buffering everything in memory.
- **Hard output caps.** Across `text()`, `image()`, and `console.*`, a script can emit at most 16 MiB (`16,777,216` characters) total and `100,000` items. Exceeding either cap stops the script immediately with an uncatchable `RangeError`.
- **Frozen built-in prototypes.** Standard JavaScript globals and built-in prototypes are frozen before your script starts. Monkey-patching built-in prototypes throws `TypeError`; normal own properties on your own objects (`name`, `message`, `toString`, `toJSON`, and custom keys) work normally.
- **Cancellation.** Stopping a script or hitting `timeout_ms` cancels execution promptly. In the standalone binary release, a single long-running native built-in operation (such as a catastrophic regex) finishes before the worker exits.
- **Worker concurrency.** Default limit is `2` concurrent script workers per Atomic process (override with `ATOMIC_CODEMODE_MAX_WORKERS` or legacy `PI_CODEMODE_MAX_WORKERS`). Cancelled workers occupy a slot until they exit. Additional scripts queue in FIFO order and fail if no slot opens within 60 seconds (or `timeout_ms`).
- **Deadlocks and nesting.** Waiting on a promise with no pending tool call fails immediately because there are no timers. Scripts cannot invoke `codemode` recursively.
