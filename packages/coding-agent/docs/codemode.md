---
title: "Codemode"
description: "The codemode script reference: globals, tool calls, stored values, classifier and image models, and limits."
---

# Codemode

The `codemode` tool lets the model write a JavaScript script that calls Atomic's other tools and runs non-LLM models, such as classifiers and image models. Only the script's output reaches the model, so a script can run calls in parallel and filter large results before the model sees them. To turn it on, see [`codemode` in Built-in tools](/tools#codemode).

## Scripts

The tool input is raw JavaScript source, not JSON and not a markdown code fence. It runs as the body of an async function in a QuickJS sandbox, so top-level `await` and `return` work. The sandbox has no Node APIs, file system, network, or timers; scripts reach the outside world only through tools and `models`.

A script may start with an options line:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

- `max_output_tokens` (default 10000) limits the output. Longer output keeps its start and end, and the full text is written to a temp file whose path is included in the result.
- `timeout_ms` is a hard deadline for the whole script. It is unset by default. Image generation can take minutes, so do not set a short deadline for scripts that generate images.

The result starts with `Script completed` or `Script failed`, the wall time, and the output. A failed script keeps its partial output, followed by `Script error:` and the error. Tool calls are real: calls made before a failure are not undone. Calls still running when the script ends are cancelled, and unawaited promises are discarded.

## Globals

| Global | Purpose |
|---|---|
| `tools.<name>(args)` | Call a tool. See [Call tools](#call-tools). |
| `text(value)` | Add a text item to the output. Strings are added as is, other values as JSON. |
| `image(value)` | Add an image to the output: a base64 `data:` URL, an `{ image_url }` object, or an image block `{ type: "image", data, mimeType }` such as those returned by MCP tools and `models.generateImages()`. Remote URLs are not supported. PNG, JPEG, GIF, and WebP are accepted. Each image is also saved to a temp file, and the result names the path before the image. |
| `console.log(...)` | Like `text()`; `info`, `warn`, `error`, and `debug` do the same. |
| `return value` | A top-level `return` adds the value like `text()`. |
| `exit()` | End the script successfully. |
| `store(key, value)` / `load(key)` | Keep small JSON values across `codemode` calls. See [Store values](#store-values). |
| `ALL_TOOLS` | Every callable tool as `{ name, description }`, including tools the description does not list. |
| `searchTools(query, { limit?, namespace? })` | Rank callable tools by relevance (BM25, default limit 8). Resolves to `{ name, description }[]`. |
| `describeTool(name)` | Resolves to a tool's description and TypeScript declaration, or `undefined`. |
| `describeNamespace(name)` | Resolves to `{ name, description?, instructions?, tools }` for a namespace such as an MCP server, or `undefined`. |
| `models` | List and run non-LLM models. See [Models](#models). |

## Call tools

Every tool the session can call is a method of `tools`, named by its identifier: characters that are not valid in a JavaScript identifier become `_`, so the MCP tool `mcp__dev-docs__search` is `tools.mcp__dev_docs__search`. Each method takes one object with the tool's arguments.

What a call resolves to depends on the tool:

- Tools with an output schema resolve to a structured value. `bash` resolves to `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`, also for non-zero exit codes. Its `output` is not limited to what the model sees directly: it holds up to 1 MiB, and longer output keeps its first and last 512 KiB around an omission marker, with `truncated` set and the full output in `full_output_path`.
- MCP tools resolve to their `CallToolResult`, including `isError` and `structuredContent`.
- Other tools, such as `read`, `edit`, and `write`, resolve to their text output.

A call that fails, is blocked, or gets invalid arguments rejects with an `Error` that carries the tool's error text. Use `Promise.allSettled()` to keep the results of the calls that succeed. Reading a tool that does not exist throws an error that names the close matches, so `tools.Bash` suggests `tools.bash`; check for a tool with `"name" in tools`.

The `codemode` description lists tools with their TypeScript declarations, grouped by namespace (for example one MCP server). Tools with `deferred` exposure are not listed, so the description stays the same while they register. Listed declarations share a budget of 3000 estimated tokens (`codemode.inlineBudget` in [settings](/settings#tools)). Scripts find the other tools with `searchTools()`, `describeTool()`, `describeNamespace()`, or by filtering `ALL_TOOLS`.

While `codemode` is active, `codemode.mode` in [settings](/settings#tools) decides how the other tools are presented. With `on` (default) declared tools stay declared, and their descriptions say in one line how scripts call them and what the call resolves to. With `only` they are hidden from the model and listed in the `codemode` description instead, so the model calls them through scripts.

## Store values

`store(key, value)` keeps a JSON value under a string key for later `codemode` calls; storing `undefined` deletes the key. `load(key)` returns the value, or `undefined`. Writes are kept only when the script succeeds: each successful script that stores values appends a `codemode-store` custom entry to the session, so resumed sessions keep the values and each branch sees only the values written on its path.

The store is for small state such as IDs, cursors, or summaries. One value may have at most 262144 characters of JSON and all values together at most 1048576. Do not store image data; show images with `image()`, which also saves them to a temp file.

## Models

`models` reaches the model catalog and runs non-LLM models with the session's credentials: classifiers, which answer typed questions about JSON state, and image models, which generate images. Chat models are listed but cannot be run from scripts. Classifier models include [TypeSafe Jev](/providers#typesafe-jev) and [local llama.cpp models](/llama-cpp); image models include OpenRouter's, such as `google/gemini-2.5-flash-image` and `black-forest-labs/flux.2-pro`, which use the same `OPENROUTER_API_KEY` or `/login` credential as its chat models. Neither kind appears in `/model`.

```ts
type ModelType = "chat" | "image" | "classifier";

/** A catalog entry. `provider` and `id` identify it; other fields depend on the type. */
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
  /** Every known model of a type, optionally for one provider. */
  getModelsOfType(type: ModelType, provider?: string): Promise<ModelInfo[]>;
  /** Models of a type whose provider has working credentials. */
  getAvailableOfType(type: ModelType, provider?: string): Promise<ModelInfo[]>;
  /** One catalog entry, or undefined. */
  getModelOfType(type: ModelType, provider: string, id: string): Promise<ModelInfo | undefined>;
  /** Answer `context.questions` about `context.state`; answers are in `result.answers` by question ID. */
  classify(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>;
  /** Generate images from `context.input` text and image blocks; show `result.output` blocks with image(). Can take minutes. */
  generateImages(model: ModelInfo, context: ImagesContext): Promise<ImagesResult>;
};
```

`classify()` and `generateImages()` use only the `provider` and `id` of `model`, so `{ provider, id }` works as well, and a script-supplied `baseUrl` or headers never receive the credentials. They do not throw on provider errors: check `stopReason` and `errorMessage`. A malformed model or context does throw, with the expected shape in the message; an unknown or mistyped model points to `models.getAvailableOfType()`. At most four such calls run at once per script; more calls wait for a free slot, so `Promise.all()` over many items is fine. Their usage is added to the `codemode` tool result and counts toward the session cost.

Model IDs differ between providers. Use `models.getAvailableOfType(type)` to find the IDs that work with the current credentials.

### Classify

```ts
interface ClassifierContext {
  /** The data to classify. */
  state: Record<string, unknown>;
  /** Questions by ID. One call answers all of them. */
  questions: Record<string, ClassifierQuestion>;
}

type ClassifierQuestion =
  /** Pick one label. `criteria` maps each label to what it means. */
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  /** Score on an ordered scale. `criteria` describes each level, lowest first. */
  | { type: "score"; instructions: string; criteria: string[] }
  /** Yes or no. */
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };

interface ClassifierResult {
  provider: string;
  model: string;
  /** Answers by question ID. */
  answers: Record<string, ClassifierAnswer>;
  usage?: ModelUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}

type ClassifierAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  /** `score` is the expected level index, from 0 to `criteria.length - 1`. */
  | { type: "score"; score: number; confidence: number }
  /** Probability of `true`. */
  | { type: "bool"; probability: number };

/** Token counts and cost in USD, when the service reports them. */
type ModelUsage = { input: number; output: number; totalTokens: number; cost: { total: number } };
```

Classify several items by calling `classify()` once per item. This script sorts feedback messages, for example ones a tool returned earlier in the script:

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

### Generate images

```ts
interface ImagesContext {
  /** The prompt as text blocks, plus image blocks to edit or use as references. */
  input: (TextBlock | ImageBlock)[];
}

interface ImagesResult {
  provider: string;
  model: string;
  /** Generated images, and text blocks for models that also return text. */
  output: (TextBlock | ImageBlock)[];
  usage?: ModelUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}

type TextBlock = { type: "text"; text: string };
/** `data` is base64. */
type ImageBlock = { type: "image"; data: string; mimeType: string };
```

Show generated images with `image(block)`. Do not print `data` with `text()`, `console`, or `return`: it is large and the model cannot read it as text. A script that generates images without showing any gets a note saying so. `image()` also saves each image to a private temp file and puts its path in the result, so a later turn can copy or move the file.

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

Extensions call classifiers and image models through `ctx.modelRegistry.classify()` and `ctx.modelRegistry.generateImages()`, without codemode.

## Limits

- A script's VM has 256 MB of memory. Running out throws `InternalError: out of memory`; filter or aggregate large data instead of accumulating it.
- A script that waits on a promise that can never settle (no tool call pending) fails immediately, since there are no timers.
- Scripts cannot start other `codemode` scripts.
