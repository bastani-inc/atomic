---
title: SDK API reference
sidebarTitle: "SDK API"
description: SDK options, resource loaders, return values, run modes, and exports.
---

# SDK API reference

## Options Reference

### Directories

```typescript
const { session } = await createAgentSession({
  // Working directory for DefaultResourceLoader discovery
  cwd: process.cwd(), // default
  
  // Global config directory
  agentDir: "~/.atomic/agent", // default (expands ~)
});
```

Atomic reads primary `.atomic` locations first and legacy `.pi` locations for compatibility when multiple config directories are supported. Passing an explicit `agentDir` makes that directory the user override.

`cwd` is used by `DefaultResourceLoader` for:
- Project extensions (`.atomic/extensions/`, then legacy `.pi/extensions/`)
- Project skills:
  - `.atomic/skills/`, then legacy `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Project prompts (`.atomic/prompts/`, then legacy `.pi/prompts/`)
- Context files (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` walking up from cwd)
- Session directory naming

`agentDir` is used by `DefaultResourceLoader` for:
- Global extensions (`extensions/`)
- Global skills:
  - `skills/` under `agentDir` (for example `~/.atomic/agent/skills/`; legacy `~/.pi/agent/skills/` is also considered by default)
  - `~/.agents/skills/`
- Global prompts (`prompts/`)
- Global context files (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` under `agentDir`)
- Settings (`settings.json`)
- Custom models (`models.json`)
- Credentials (`auth.json`)
- Sessions (`sessions/`)

When you pass a custom `ResourceLoader`, `cwd` and `agentDir` no longer control resource discovery. They still influence session naming and tool path resolution.

### Workspace

```typescript
import { createAgentSession, workspace } from "@bastani/atomic";

const { session, workspace: binding } = await createAgentSession({
  workspace: workspace({ repo: "/srv/src/api", branch: "feat/ticket-123", sandbox: "read-only" }),
  cwd: "packages/server", // optional; resolved inside the worktree
});
```

`workspace` accepts a `workspace({ … })` value or an already resolved `BoundWorkspace`. The session's `cwd` becomes the bound worktree, an explicit `cwd` must stay inside it, and a read-only workspace removes and refuses `write`, `edit` and `todo`. `result.workspace` and `session.workspace` hold the resolved binding. See [Workspaces](/sdk#workspaces).

### Model

```typescript
import { getModel } from "@bastani/pi-ai/compat";
import { ModelRuntime } from "@bastani/atomic";

const modelRuntime = await ModelRuntime.create();

// Find specific built-in model (doesn't check if credentials exist)
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("Model not found");

// Find any model by provider/id, including custom models from models.json
const customModel = modelRuntime.getModel("my-provider", "my-model");

// Get only models whose providers have configured authentication
const available = await modelRuntime.getAvailable();

const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh, max (when supported by the model)
  
  // Models for cycling (CTRL+P in interactive mode)
  scopedModels: [
    { model: opus, thinkingLevel: "high" },
    { model: haiku, thinkingLevel: "off" },
  ],
  
  modelRuntime,
});
```

`ModelRegistry` keeps synchronous reads for extension compatibility, while catalog refresh is asynchronous. Extensions should await `modelRegistry.refresh()` before synchronous `getAll()`, `find()`, or `getAvailable()` reads when a provider may update its catalog. New SDK integrations use `ModelRuntime`; `await modelRuntime.refresh()` reports `aborted` and per-provider `errors`, and failed providers retain their last-known models.

If no model is provided:
1. Tries to restore from session (if continuing)
2. Uses default from settings
3. Falls back to first available model

> See [examples/sdk/02-custom-model.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/02-custom-model.ts)

#### Model catalog persistence and refresh

`ModelRuntime.create()` restores cached catalogs from local persistence but does not contact
pi.dev unless you opt in. `allowModelNetwork` (default `false`) enables a create-time network
refresh, and `modelRefreshTimeoutMs` (default `15_000`) bounds how long that refresh may run
before it is aborted. Pass `refreshOnCreate: false` to skip the initial catalog and
availability refresh entirely; built-in models remain available.

```typescript
const refreshedRuntime = await ModelRuntime.create({
  allowModelNetwork: true,
  modelRefreshTimeoutMs: 15_000,
});
```

Remote catalogs are persisted locally so later runtimes can restore them without a network
request. The default file is `models-store.json` next to `models.json` — with the default
`modelsPath` that is `~/.atomic/agent/models-store.json`. Set `modelsStorePath` to choose
another location, or inject `modelsStore` to control persistence entirely; a runtime created
with `modelsPath: null` keeps its store in memory. Network refreshes are throttled to once
per provider every four hours unless forced. To force an immediate refresh, call
`await modelRuntime.refresh({ allowNetwork: true, force: true, signal })`. Setting
`ATOMIC_OFFLINE` (legacy alias `PI_OFFLINE`) disables model network access, and a
`refresh()` call that omits `allowNetwork` follows that same runtime network policy.

`registerProvider()`, `registerNativeProvider()` and `unregisterProvider()` return at once and
refresh the catalog from the cache in the background, checking each provider's credentials.
`await modelRuntime.whenRegistrationRefreshesSettled()` resolves once no such refresh is running,
including one a registration starts while you wait.

### API Keys and OAuth

`ModelRuntime` is the asynchronous SDK engine for provider composition, credentials, model catalogs, and requests. `ModelRegistry` remains a thin compatibility facade for extensions; `await modelRegistry.complete(model, context, options)` routes a request through its runtime with the resolved provider and auth. New SDK integrations should pass `modelRuntime` to `createAgentSession` and use `modelRuntime.complete()` directly when they issue standalone requests.

Credential resolution combines runtime API-key overrides, stored `auth.json` credentials, environment variables, and the active `models.json` provider configuration. OAuth acquisition is provider-owned and runs through `ModelRuntime.login()`.

```typescript
import { AuthStorage, ModelRuntime } from "@bastani/atomic";

const authStorage = AuthStorage.create();
const modelRuntime = await ModelRuntime.create({ credentials: authStorage });

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

// Runtime API key override (not persisted to disk). Setting the key updates
// auth state; refresh the provider explicitly when its catalog must be current.
const providerId = "anthropic";
const authController = new AbortController();
await modelRuntime.setRuntimeApiKey(providerId, "sk-my-temp-key", { signal: authController.signal });
await modelRuntime.refresh({ providers: [providerId], signal: authController.signal });

// Custom credential and model configuration locations
const customRuntime = await ModelRuntime.create({
  authPath: "/my/app/auth.json",
  modelsPath: "/my/app/models.json",
});

const customSession = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime: customRuntime,
});

// Disable models.json while retaining built-in providers
const builtinsOnly = await ModelRuntime.create({ modelsPath: null });
```

> See the complete [`ModelRuntime` credential and model configuration example](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts).

### Structured decisions

Use `generateStructuredOutput()` for one schema-validated semantic decision without starting an agent session. Pass optional exact `model` and `fallbackModels` IDs, `currentModel`, `modelRegistry`, `instructions`, `state`, and `schema`. Omit `model` to start with the current chat model, or with `decisionModel` when you pass `settings`; the current chat model is also the terminal fallback. With `settings`, `decisionModel` resolves as `decide()` resolves it, and a failure there rejects with a `DecisionError`. Atomic resolves each ID through the supplied registry: a chat model uses chat inference, and a registered classifier uses the generic classify operation. A catalog entry does not prove that the provider can serve the request. Classifiers run only when the schema is a finite Choice and are otherwise skipped. General calls derive choice questions from that schema. See [Structured decisions](/sdk/structured-decisions).

Use `decide()` to ask the user's configured `decisionModel` typed Choice, yes/no and Score questions over your state. It returns typed answers, with probabilities when a classifier answered, and rejects with a `DecisionError`. Workflow-stage and subagent `model: "auto"` selection and workflow readiness after a steer decide through it; the `structured_output` tool starts on the same decision model. See [decide](/sdk/structured-decisions#decide).

### System Prompt

Use a `ResourceLoader` to override the system prompt:

```typescript
import { createAgentSession, DefaultResourceLoader } from "@bastani/atomic";

const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are a helpful assistant.",
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/03-custom-prompt.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/03-custom-prompt.ts)

### Tools

Specify which tools to expose by name:

- Built-in tool names enabled by default: `read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`
- `find` discovers filesystem paths by glob; `search` searches file contents with regex patterns across files, directories, globs, and internal URLs.
- `builtins` selects shipped packages independently of tools: keys are `workflows`, `subagents`, `mcp`, `web-access`, and `intercom`. Omitted, `{}`, and omitted keys enable packages. A `false` value removes that package's extensions and resources, including on reload; `true` enables it.
- `tools` accepts an allowlist of coding, extension, and custom tool names or `*` patterns. `tools: []` exposes none, including Intercom. A list containing only `+name`/`-name` entries instead changes the resolved defaults, for example `tools: ["+codemode", "-write"]`. Modifiers take exact names, cannot be mixed with plain entries, and apply to reloaded defaults too. Invalid lists throw. Extension/custom tools and MCP exposure retain their default behavior with modifiers.
- `excludedTools` removes matching names from the registry and active selection. Exclusions win over `tools`; unknown names are ignored.
- `noTools: "all"` exposes no tools, even with a nonempty `tools` allowlist or modifiers. It does not remove package resources or authorize services.
- `noTools: "builtin"` suppresses coding-tool defaults when `tools` is omitted, keeping extension/custom tools except exclusions. An explicit `tools` list still wins over this mode.
- Configured `defaultTools` selects initial coding tools when `tools` and `noTools` are omitted. Plain names replace the defaults; modifier-only lists such as `["-bash", "+ls"]` change the defaults, and project modifier-only lists layer over the global selection. Extension/custom tools retain their own activation behavior. See [defaultTools](/settings#tools).

Workflow and subagent children inherit these restrictions. Child allowlists intersect with the parent selection, including during model fallback. A child cannot restore a parent-disabled package or excluded tool. See [child configuration](/sdk#workflow-and-subagent-children) for model/auth, host callback and working-directory inheritance.

```typescript
import { createAgentSession } from "@bastani/atomic";

// Read-only tools; Intercom is not selected.
const { session } = await createAgentSession({
  tools: ["read", "search", "find", "ls"],
});

// Pick specific tools.
const { session } = await createAgentSession({
  tools: ["read", "bash", "search"],
});

// Keep defaults but remove HITL prompts
const { session } = await createAgentSession({
  excludedTools: ["ask_user_question"],
});

// Allowlist first, then subtract exclusions
const { session } = await createAgentSession({
  tools: ["read", "bash", "ask_user_question"],
  excludedTools: ["ask_user_question"], // active tools: read, bash
});
```

#### Checking tool status

`session.getToolStatus()` explains a session's tools: where the tool selection came from, every registered tool with its exposure, owner, and active state, why each inactive tool is off and how to turn it on, selected names that an exclusion removed, and selected names that nothing registered, with a suggestion when a name looks like a typo. `formatToolStatus()` renders the report as plain text.

```typescript
import { createAgentSession, formatToolStatus } from "@bastani/atomic";

const { session } = await createAgentSession({ tools: ["+codemode"] });
console.log(formatToolStatus(session.getToolStatus()));
```

```text
Tool selection: Atomic's default tool set with +codemode
  read, bash, kill, edit, write, find, search, ask_user_question, todo, codemode

Active (17)
  read                direct      built-in
  bash                direct      built-in
  kill                direct      built-in
  edit                direct      built-in
  write               direct      built-in
  find                direct      built-in
  search              direct      built-in
  ask_user_question   model-only  built-in
  todo                direct      built-in
  workflow            model-only  bundled package "workflows"
  subagent            model-only  bundled package "subagents"
  web_search          direct      bundled package "web-access"
  code_search         direct      bundled package "web-access"
  fetch_content       direct      bundled package "web-access"
  get_search_content  direct      bundled package "web-access"
  intercom            model-only  bundled package "intercom"
  codemode            model-only  built-in extension "codemode"

Inactive (2)
  ls                  direct      built-in
    not selected; add "+ls" to defaultTools or --tools to enable it
  tool_search         model-only  built-in extension "tool-search"
    opt-in; add "+tool_search" to defaultTools or --tools to enable it
```

Each entry in `tools` has `name`, `active`, `exposure`, `source`, `sourcePath`, `summary`, and, for inactive tools, `inactiveReason`. `missing` and `excluded` list `{ name, reason }` entries; a `missing` name usually means a typo or an extension that failed to load. Pass `{ heading, dim, warning }` functions as the second argument to `formatToolStatus()` to add terminal colors. Interactive mode shows the same report with `/tools`, and RPC clients request it with [`get_tools`](/rpc/protocol#get_tools).

The report's `git` field says which git Atomic runs: `{ source: "system" | "provisioned", version, path, update? }`, or `{ source: "unavailable", error }`, where `error` is a serialized [git error](#git-errors). A provisioned install of an older pinned release carries `update: { pinnedTag, installedTag?, reason? }`; `reason`, a serialized git error, appears once a replacement was tried in this process and could not be made (offline, or a failed download). A failed replacement is not retried by every later resolution in the same process, and the next start tries again. Reading the status never downloads git.

#### Resolving git

Atomic runs git 2.30.0 or newer (`GIT_MINIMUM_VERSION`) from `PATH`, and otherwise a portable git it downloads into `getBinDir()/git`; see [Git](/getting-started/installation#git). Use the same resolution for your own git commands:

```typescript
import { spawnSync } from "node:child_process";
import { resolveGit } from "@bastani/atomic";

const git = await resolveGit();
spawnSync(git.path, ["status", "--short"], { cwd: projectDir, env: git.env, encoding: "utf8" });
```

| Function | Returns |
|---|---|
| `resolveGit({ signal?, onStatus? })` | `Promise<ResolvedGit>`. May download and verify the portable git. `onStatus` receives `{ type: "info" \| "warning", message }` progress. Aborting `signal` rejects with `signal.reason`; concurrent callers share one download, which stops only when every caller has aborted. |
| `resolveGitSync()` | `ResolvedGit` without downloading. When no git is usable it throws, in this order: the `GitUnavailableError` (`unsupported-platform` or `offline`) that rules out provisioning; else the error the last `resolveGit()` failed with in this process (a `GitUnavailableError` such as `download-failed`, or a `GitProvisionTimeoutError`); else `GitUnavailableError` with code `not-installed`. Pass the error to `isRetryableGitProvisionError()` to tell whether `await resolveGit()` can help. |
| `getGitStatus()` | `GitToolStatus`, the value in the tools report. Never downloads. |

`ResolvedGit` has `path` (absolute executable path), `source` (`"system"` or `"provisioned"`), `version`, and `env`: a copy of `process.env` plus, for a provisioned git, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_CONFIG_SYSTEM` (macOS and Linux), and `GIT_SSL_CAINFO` (Linux and Windows). Pass `env` to the child process; a `GIT_CONFIG_SYSTEM` or `GIT_SSL_CAINFO` you already set is kept. `env` is computed per call, so later changes to `process.env` are picked up.

For a provisioned git, the returned `path` and matching `env` remain usable across automatic updates. Keep them together for a running command; resolve again when starting work with the currently selected release. Do not construct executable or helper paths from the cache directory yourself.

#### Git errors

Every git resolution failure is a `GitProvisionError`, with `code`, `hint` (the remediation), `retryable`, and JSON-safe `fields`. Invalid SDK options are rejected before provisioning starts. Failed downloads, checksums, and verification never select a partial installation; failed updates leave earlier resolved paths usable. Branch on `code` or the class, never on `message`.

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `GitUnavailableError` | `unsupported-platform` | No portable build for this system: `reason` is `musl`, `glibc-too-old`, `architecture`, or `platform` | `platform`, `arch`, `reason`, `libc?`, `systemGit?` | Run `installCommand` (for example `apk add git` on Alpine) or install git 2.30.0+ |
| `GitUnavailableError` | `offline` | `ATOMIC_OFFLINE` is set and no usable git exists | `platform`, `arch`, `offlineVariable`, `systemGit?` | Unset the variable or install git 2.30.0+ |
| `GitUnavailableError` | `not-installed` | `resolveGitSync()` found no usable git and does not download | `platform`, `arch`, `installDir`, `systemGit?` | `await resolveGit()` first, or install git 2.30.0+ |
| `GitUnavailableError` | `checksum-mismatch` | The download's SHA-256 differs from the pinned value | `platform`, `arch`, `asset`, `url`, `expectedSha256`, `actualSha256` | Check for a proxy that alters downloads, or install git yourself. Not retryable |
| `GitUnavailableError` | `download-failed` | The download failed; `httpStatus` is absent for network errors | `platform`, `arch`, `asset`, `url`, `httpStatus?` | Check access to github.com and retry. `retryable` is true for network errors and HTTP 408, 425, 429, 500, 502, 503, 504 |
| `GitUnavailableError` | `install-failed` | Reading the selected install, staging, extracting, running, or publishing the download failed (`phase`: `stage`, `extract`, `verify`, `promote`) | `platform`, `arch`, `phase`, `asset`, `installDir`, `detail?` | Free disk space or fix permissions on `installDir`; for `verify`, check cache readability or install git yourself if this system cannot run the build |
| `GitProvisionTimeoutError` | `provision-timeout` | A step exceeded its limit (`phase`: `lock`, `download`, `extract`, `verify`) | `phase`, `timeoutMs`, `elapsedMs` | Retry; `retryable` is true |
| `GitProvisionConfigError` | `invalid-option` | A `resolveGit()` option had the wrong type; checked before any probe | `source` (`"sdk"`), `field`, `expected` | Fix the option |

`systemGit`, when present, is the git found on `PATH` that Atomic could not use: `{ path, problem: "below-minimum" | "probe-failed", version? }`. `GitUnavailableError` also exposes `platform` directly. Every `GitUnavailableError` and `GitProvisionTimeoutError` carries `installCommand` when Atomic recognizes the distribution (from `/etc/os-release`, or the platform on macOS, Windows, Android, BSD and illumos); `hint` ends with it, and a rehydrated error keeps the command of the machine that raised it. Linux commands are written for a root shell, and Ubuntu earlier than 22.04 gets the git-core PPA because its own package is older than 2.30. A cleanup failure after an error is attached as `cleanupCause` and never replaces it.

Guards accept errors from other processes and realms by `name` and `code`: `isGitProvisionError`, `isGitUnavailableError`, `isGitProvisionTimeoutError`, and `isGitProvisionConfigError` test one value; `findGitProvisionError(error)` returns the first git error in a cause chain and `isRetryableGitProvisionError(error)` asks whether any is retryable, both to a bounded depth. `JSON.stringify(error)` produces `{ name, code, message, hint, retryable, fields, cause? }`, and `rehydrateGitProvisionError(payload)` restores the same class with its cause chain; an unknown name becomes a `GitProvisionError` that keeps the original `name` and `code`.

```typescript
import { isGitUnavailableError, resolveGit } from "@bastani/atomic";

try {
  await resolveGit();
} catch (error) {
  if (isGitUnavailableError(error) && error.code === "unsupported-platform") console.error(error.hint);
  else throw error;
}
```

#### fd and ripgrep download errors

When `fd` or `ripgrep` is neither in `getBinDir()` nor on `PATH`, the `find`, `grep` and `search` tools download the latest release from GitHub. If a request fails, the tool call rejects with a `ManagedToolError` whose `message` names the request, and interactive startup shows the same text as a warning. Nothing is installed. Offline mode, unsupported platforms and an archive that cannot be unpacked still reject with a plain error.

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `ManagedToolDownloadError` | `download-failed` | The release lookup (`phase: "resolve-version"`) or archive download (`phase: "download"`) failed, or the response was not usable. `cause` is the underlying error | `tool` (`"fd"` or `"rg"`), `phase`, `url`, `httpStatus?`, `detail?` | Check access to github.com and retry, or install the tool with your package manager. `retryable` is true for network errors and HTTP 408, 425, 429, 500, 502, 503, 504 |
| `ManagedToolTimeoutError` | `download-timeout` | The request did not finish in time: 10 s for the release lookup, 120 s for the archive | `tool`, `phase`, `url`, `timeoutMs`, `elapsedMs` | Retry; `retryable` is true |

`isManagedToolError`, `isManagedToolDownloadError` and `isManagedToolTimeoutError` also accept errors from another realm by `name` and `code`; `isRetryableManagedToolError(error)` asks whether anything in the cause chain is retryable, to a bounded depth. Branch on `code` or the class, never on `message`.

#### Bash tool behavior

Atomic's built-in `bash` tool matches upstream pi: when `bash` is enabled, commands execute through the configured shell with the Atomic process permissions. Use `tools`, `excludedTools`, or `noTools` to decide whether a session exposes the `bash` tool at all. Atomic no longer provides a command-level allow/deny option for `bash`; use an operating-system/container sandbox or a custom tool/extension when you need command allowlisting or stronger isolation.

Completed `bash` commands also return `structuredContent` shaped as `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`, including nonzero exits. Programmatic callers receive up to 1 MiB of captured output, plus an omission marker when truncated; larger output keeps its head and tail and supplies a path to the full output. This is a captured-output limit, not a strict serialized JSON size limit. Model-facing text keeps its ordinary truncation limits. Running/background observations keep their existing task lifecycle and result format.

#### Waiting for existing shell tasks

Both Bash and PowerShell factories accept `{ action: "wait", id: taskId, budgetMs: 1000 }` with a trusted `taskOwner` binding. No command is executed. `BashToolInput` and `PowerShellToolInput` distinguish command launches from existing-task waits; narrow by `action` before reading `command`.

`budgetMs` is optional, finite, and non-negative. Omission uses the owner's command wait policy and zero polls. Results keep the `WaitOutcome` in `details.observation`, available exit information in `details.exitCode`, and retained output in text content. Failure and cancellation metadata remain in the settled observation. Yielded waits advance through bounded retained-output pages for the same owned task, even when the tool is recreated. Partial UTF-8 characters continue on the next page. Settled waits return all retained output again, subject to labelled gaps and truncation. Aborting the call releases only its observation. A binding from `AgentTaskHost.ownerBinding` also releases waits for incoming owner messages.

Do not mix wait arguments with launch fields. Unknown or foreign IDs and unbound waits are rejected before execution hooks. Custom `operations.exec` does not provide existing-task ownership. See [Background tasks](/background-tasks) for examples and lifetime rules.

#### PowerShell tool behavior

`createPowerShellTool()` and `createPowerShellToolDefinition()` provide the same tool used by interactive sessions. When their default local operations execute on native Windows, they prefer `pwsh.exe`, fall back to `powershell.exe`, and throw a clear error when neither executable is available. `createLocalPowerShellOperations()` and `getPowerShellConfig()` are also exported for custom integrations. The PowerShell factories expose the current `ATOMIC_*` and legacy `PI_*` session snapshot by default; set `exposeSessionEnvironment: false` to opt out.

PowerShell tools and local operations accept a trusted `taskOwner` binding and the same
`wait` observation policy as bash. Owned native Windows execution automatically yields
after the owner's command budget (normally 10000 ms); explicit per-call budgets override it,
and execution timeout remains separate. Task descriptions retain the original command text.
Without a supported owner, explicit background requests are refused and foreground execution waits for completion.

```typescript
import { createPowerShellTool } from "@bastani/atomic";

const powershell = createPowerShellTool("C:\\path\\to\\project");
```

#### Tools with Custom cwd

When you pass a custom `cwd`, `createAgentSession()` builds selected built-in tools for that cwd.

```typescript
import { createAgentSession, SessionManager } from "@bastani/atomic";

const cwd = "/path/to/project";

// Use default tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(cwd),
});

// Or pick specific tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  tools: ["read", "bash", "search"],
  sessionManager: SessionManager.inMemory(cwd),
});
```

> See [examples/sdk/05-tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/05-tools.ts)

### Custom Tools

```typescript
import { Type } from "typebox";
import { createAgentSession, defineTool } from "@bastani/atomic";

// Inline custom tool
const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({
    input: Type.String({ description: "Input value" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `Result: ${params.input}` }],
    details: {},
  }),
});

// Pass custom tools directly
const { session } = await createAgentSession({
  customTools: [myTool],
});
```

Use `defineTool()` for standalone definitions and arrays like `customTools: [myTool]`. Inline `pi.registerTool({ ... })` already infers parameter types correctly.

Custom tools passed via `customTools` are combined with extension-registered tools. Extensions loaded by the ResourceLoader can also register tools via `pi.registerTool()`.

If you pass a plain-name `tools` allowlist, include each custom or extension tool name you want enabled, for example `tools: ["read", "bash", "my_tool"]`. Modifier-only lists retain default activation and can enable inactive registered tools with `+name`. Use `excludedTools` to remove a custom or extension tool by name from the final exposed set.

`ToolDefinition.constrainedSampling` is part of the public SDK and survives `defineTool()`, `customTools`, tool wrappers, session/staged inspection, and isolated execution. Use `{ type: "json_schema", strict: "prefer" | "require" }`, `{ type: "grammar", variants: { openai_lark?: string, openai_regex?: string } }`, or `false`. `prefer` can fall back; `require` fails when the active model cannot enforce strict JSON Schema. Grammar constraints require one required string parameter and capable model metadata. Public inspection preserves optional-property identity exactly: an omitted key stays absent, an explicitly present `undefined` stays present, and `false` or a config object remains unchanged. The exported `ConstrainedSamplingConfig` type and [extension reference](/extensions/authoring#constrained-sampling) define the exact shape. Typed RPC clients receive the four model capability flags through optional `ModelInfo.compat`; see [RPC](/rpc/protocol#get_available_models).

Factory-created `createBashTool()` instances receive the same execution-time `ATOMIC_SESSION_*`/`PI_SESSION_*` model and session snapshot as the built-in bash tool. Set `exposeSessionEnvironment: false` only when the subprocess must not receive it. `MessageRenderOptions.outputPad` is likewise passed to normal and isolated custom message renderers.

Normal sessions also expose `kill({ id: taskId })` for their owned bash and PowerShell background tasks. Include `kill` when using a `tools` allowlist if the agent should be able to stop those tasks. The exported `createKillTool` and `createKillToolDefinition` factories accept `KillToolOptions.taskOwner`, a trusted execution-time callback returning the same owner binding used by shell launch. Without a binding they reject execution. The result details preserve the supervisor's `CancelReceipt`, including its decision, execution outcome, and cleanup state. See [Background tasks](/background-tasks#stop-a-shell-task-from-a-tool-call).

#### Detachable tool calls

A tool whose work does not need the session once it has started (a CI run, a deployment, an external job) can declare `detachable: true`. Running it again with the same call id and arguments after a restart must be safe, because a host may start a call again when the process that ran it died.

```typescript
const waitForCi = defineTool({
  name: "wait_for_ci",
  label: "Wait for CI",
  description: "Waits for the CI run of the change",
  parameters: Type.Object({ run: Type.String() }),
  detachable: true,
  execute: (_toolCallId, params, signal) => ci.waitFor(params.run, signal),
});
```

`detachable` may also be a function of the call's arguments. Only a call for which it returns `true` may detach; every other call runs inline however long it takes. The built-in shell tools and Intercom use this, so only a shell `wait` without a budget, an Intercom `ask` and a `contact_supervisor` decision request may detach. Intercom reply waits remain live when multi-node routing is active.

A detachable call is scheduled like any other call of its message: it starts only once the calls it must follow, as its `concurrency` says, have finished.

A tool that must save a durable handoff before detaching can also set `detachmentRequiresReady: true`. While the call runs, `toolCallNeedsDetachmentHandoff(signal)` tells it whether a handoff is needed. After saving the handoff, call `markToolCallReadyForDetachment(signal)`; the call detaches only after both that signal and the host's delay. If the call finishes first, its result is returned inline. Both helpers are exported from `@bastani/atomic`.

Without a detachment policy a detachable call runs inline like any other. A host that can keep the conversation in a session store sets one with `session.setToolDetachment({ afterMs })`, where `afterMs` is from 0 to `MAX_TOOL_DETACHMENT_AFTER_MS` (2,147,483,647, the longest timer delay):

- A call that finishes within `afterMs` runs inline.
- A call still running after `afterMs` detaches: the turn's other results are saved, the call has no result yet, and `prompt()` resolves. The call's work goes on outside the session, so the host can dispose of the session meanwhile.
- `session.takeDetachedToolCalls()` returns each detached call once. Every `DetachedToolCall` has `toolCallId`, `toolName`, a `result` promise that never rejects (a thrown error becomes an `isError` result), and `abort(reason)`. When the thrown error has a string `code`, the result's `details.error` carries it as data, so a host can branch on `code` instead of the text: the error's own `toJSON()` form when it has one, otherwise its `name`, `code`, `message`, and its `hint`, `retryable`, JSON-safe `fields` and cause chain when it has them. If its `toJSON()` throws, `details.error` is built from its properties and carries `serialization: "fallback"`.
- `session.resumeDetachedTurn(results)` on a session reopened from the store records each result as its call's result, right after the call, and continues the same turn, without a new user message, once every detachable call of the turn has its result. Results may be handed back together or across several calls: until the last one arrives, the call records what it gets and resolves without continuing, and `hasPendingDetachedTurn()` stays `true`. A result for a call that already has one, or repeated in `results`, is ignored. With no new result, a transcript that ends on a detachable call's turn whose every call already has its result continues that turn (the process that recorded the results stopped before the model answered), and a turn still waiting on a call is left as it is.
- `session.hasPendingDetachedTurn()` tells whether a reopened transcript ends on such a turn, with or without some or all of its results. When it does, continue the turn with `redispatchDetachedToolCalls()` and `resumeDetachedTurn()` instead of prompting again.
- `session.redispatchDetachedToolCalls()` starts again the detachable calls that a reopened transcript ends on without a result, with their original ids and arguments. Calls that already have a result are not started again. Session listeners receive a `tool_execution_start` event for each call before the method returns, and extensions receive it in order with the session's other events.

A result handed to `resumeDetachedTurn()` enters the transcript exactly as an inline call's result would: extension `tool_result` handlers see it and can rewrite it, images are resized for the provider, and output over the persistence threshold is stored with the session when its session store holds blobs (`SessionStore.putBlob`/`getBlob`, which the SQLite, libSQL and in-memory stores have), named `tool-output://<sha256>`, and otherwise saved to a file (see [Persisted tool output](/tools#persisted-tool-output)).

A detached call runs outside its session's async context and tool wrappers, so it holds no reference to the session while it waits. While the call runs inline, its `onUpdate` and `ctx` reach the session as usual. Once it detaches:

- progress it reports with `onUpdate` is dropped;
- `ctx` answers only `cwd`, and any other use throws `ToolDetachmentError` with code `context-detached`. Read what the work needs from `ctx` before it awaits anything long, or pass it in the tool's arguments.

A call started again by `redispatchDetachedToolCalls()` reports no progress from the start. Its `ctx` reaches the session only while the work starts, until its first `await`; read what it needs from `ctx` before then. A call queued behind another call of the same turn gets that `ctx` when it starts, if the session is still open, and otherwise only `cwd`. A detached call reports no host diagnostics.

`ask_user_question` is detachable only in a workflow stage's own session, where the question waits in the stage's UI rather than the session's: the stage releases its session while the model waits on the user's answer. In other sessions it always runs inline, because its question ends with the session that asked it. A shell `wait` whose task is gone after a restart returns an error result whose `details.error` is the serialized `TaskToolError` (see [Owner-bound task supervisor](#owner-bound-task-supervisor-s1)).

While a transcript waits on a detached call's result, a background task's completion notice is saved but not added to the conversation, so nothing comes between the call and its result. It is delivered once `resumeDetachedTurn()` has continued the turn.

`ToolDetachmentError` reports a refused detachment operation; nothing changed when it is thrown. Check it with `isToolDetachmentError(error)`, or find it in a cause chain with `findToolDetachmentError(error)`, and branch on `code`:

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `ToolDetachmentError` | `invalid-policy` | `setToolDetachment()` got an `afterMs` that is not a finite number from 0 to `MAX_TOOL_DETACHMENT_AFTER_MS` | `sessionId`, `field`, `value` | Pass an `afterMs` in that range, or `undefined`. To keep calls inline, set no policy |
| `ToolDetachmentError` | `unknown-tool-call` | `resumeDetachedTurn()` got a new result for a call the transcript does not end on | `sessionId`, `toolCallId` | Hand back only results of the calls this session's transcript waits on |
| `ToolDetachmentError` | `session-busy` | `resumeDetachedTurn()` was called while the session was still running, or still recording the results an earlier call handed back (`retryable: true`) | `sessionId` | Wait for that call or run to settle, then call it again |
| `ToolDetachmentError` | `session-closed` | `resumeDetachedTurn()` was called on a session that is disposed or closing. Nothing is recorded | `sessionId` | Reopen the session from its store and hand the results to the new session |
| `ToolDetachmentError` | `context-detached` | A detached call's work used its `ctx` for anything but `cwd` | `sessionId`, `toolCallId` | Read what the work needs from `ctx` before the call detaches, or pass it in the tool's arguments |
| `ToolDetachmentError` | `stage-parked` | A workflow stage released while it waits on tool results was asked to start a task, an agent task or a shell command (`retryable: true`) | `sessionId` (the stage's session) | Wait for the stage to reopen its session, then start the task again |

Every error has `hint` with the remediation and `fields` with the JSON-safe facts above. Only `session-busy` and `stage-parked` are `retryable`. To pass one across a process boundary, send `JSON.stringify(error)` (its `toJSON()` keeps `name`, `code`, `message`, `hint`, `retryable`, `fields` and a bounded `cause` chain) and rebuild it with `deserializeToolDetachmentError(serialized)`, which returns a `ToolDetachmentError` that the guards recognize. A name or code this version does not know keeps its `name`, `code`, `hint` and message.

#### Structured output final results

`structured_output` is not registered in normal agent sessions by default. Register the factory when a caller needs a schema-validated decision inferred by a selected model:

```typescript
import { Type } from "typebox";
import { createAgentSession, createStructuredOutputTool } from "@bastani/atomic";

const DecisionSchema = Type.Object({
  category: Type.Union([Type.Literal("question"), Type.Literal("statement")]),
}, { additionalProperties: false });

const structuredOutput = createStructuredOutputTool({ schema: DecisionSchema });

const { session } = await createAgentSession({
  customTools: [structuredOutput],
  tools: ["structured_output"],
});
```

The calling model does not supply the decision fields. It calls `structured_output` with:

- `instructions`: the judgment to make.
- `state`: a nonempty named object containing the task and relevant context. Do not put secrets here.
- `model`: optional exact `provider/model` ID of a chat model or a registered classifier. Omit it to use the session's `decisionModel`, which defaults to the current stage or session chat model.
- `fallbackModels`: optional ordered exact IDs tried after the primary.

The tool infers the result through the session model registry. A successful call returns the schema-validated value as pretty-printed JSON, stores that value in `details`, and sets `terminate: true`. It does not capture the calling model's arguments as the decision. A classifier is used only when the registered schema is a finite Choice; otherwise that candidate is skipped and the next fallback, then the current chat model, is tried. A classifier failure such as missing credentials, an unavailable provider, an unsupported classify operation, a refusal, or a malformed answer advances the same chain. A chat provider refusal advances immediately when reported as an error; plain text without a result gets up to three repairs before advancing. Cancellation stops the call. Saved `/login` credentials are used through the session model registry; a listed model does not prove live access.

Each call must finish within a wall-clock deadline that covers every repair attempt, retry, and model fallback. It defaults to the session's [`httpIdleTimeoutMs`](/settings#http) setting; pass `timeoutMs` (a positive integer in milliseconds) to `createStructuredOutputTool()` to change it. The calling model cannot. See [Structured decisions](/sdk/structured-decisions#cancellation-and-failures).

A custom tool name still works. Include that name in any explicit `tools` allowlist:

```typescript
const finalDecision = createStructuredOutputTool({
  name: "final_decision",
  schema: DecisionSchema,
});

await createAgentSession({
  customTools: [finalDecision],
  tools: ["final_decision"],
});
```

Custom tool names are supported, and the prompt metadata follows the configured name. The examples above use `final_decision` and the default `structured_output` name. Include the name you register in any explicit `tools` allowlist.

> See [examples/sdk/05-tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/05-tools.ts)

### Extensions

Extensions are loaded by the `ResourceLoader`. `DefaultResourceLoader` discovers extensions from `~/.atomic/agent/extensions/` and `.atomic/extensions/` first, then legacy `~/.pi/agent/extensions/` and `.pi/extensions/`, plus settings.json extension sources.

```typescript
import { createAgentSession, DefaultResourceLoader } from "@bastani/atomic";

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: ["/path/to/my-extension.ts"],
  extensionFactories: [
    (pi) => {
      pi.on("agent_start", () => {
        console.log("[Inline Extension] Agent starting");
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

`createAgentSession()` preserves the resources from a supplied loader and adds Atomic's shipped builtin extensions and resources. Repeated references to a shipped builtin load it once. Your loader's arrays and discovery options are not rewritten. Existing tool selection and collision rules still apply.

Named `extensionFactories` descriptors may set `builtin: true` to expose the factory as a synthetic `builtin:<name>` resource, and `replaceable: true` to omit it when another extension claims the same tool, command, or flag. Use `additionalExtensionPaths: ["builtin:codemode"]` for explicit built-in loading, including with `noExtensions: true`. These inline resource controls are separate from the companion-package `builtins` map. See [built-in extension resources](/extensions#built-in-extension-resources).

Every `DefaultResourceLoader` includes Atomic's inline built-in extensions, `codemode`, `tool-search`, and `llama.cpp`, so `defaultTools: ["+codemode"]` or `tools: ["+tool_search"]` works in SDK sessions without extra factories. `loader.getExtensions()` lists them with `builtin:<name>` paths. Registering them does not activate `codemode` or `tool_search`; both stay opt-in. A descriptor you pass with the same name replaces the default one, and `noExtensions: true`, `disabledBuiltinExtensions: ["codemode"]`, or an `extensions` setting such as `"-builtin:codemode"` turns one off.

Pass `extensionBindings` to `createAgentSession()` to install `uiContext`, `mode`, `commandContextActions`, `shutdownHandler` or `onError` before startup hooks run. Creation awaits startup and resource discovery. A failed startup shuts down the partially created session before rejecting. Rebinding updates the host without replaying `session_start`; reload emits one start for its new generation. Remove manual post-creation startup calls from integrations that only used them to initialize extensions.

Strict reloads (`failOnExtensionErrors: true`) require the loader's transactional `prepareReload()` support so a failed candidate cannot mutate live state before validation. `DefaultResourceLoader` provides that support. Custom loaders without it remain compatible with ordinary reloads, but strict reload fails before calling their mutating `reload()` method.

Use `await session.dispose()` rather than fire-and-forget cleanup. It seals admission immediately and waits for owned work, extension shutdown, persistence and lease release. Concurrent disposal calls return the same promise. Catch `ShutdownFailed` to inspect its component `errors`; a rejected close is not successful cleanup, and the session stays closed. Do not add a manual MCP, Intercom or workflow teardown sequence. Caller-supplied settings, storage and model runtimes remain caller-owned.

`AgentSessionRuntime` uses the same awaited close when replacing sessions and transfers configured host bindings before the replacement starts. Reload invalidates old input requests and extension subscriptions while retaining host configuration. Live durable workflows retain their existing runtime ownership across reload and session replacement; final owner disposal waits for their shutdown. A late answer from an old generation cannot authorize replacement work.

Settings persistence failures can make disposal reject. Repair storage and repeat the write before closing; disposal does not consume the caller's `SettingsManager.drainErrors()` channel. Duplicate `executeBash()` IDs remain correlation IDs, and `abortBash(id)` cancels every active call with that ID.

Ensure callbacks settle independently of disposal. For reload, replacement, and resource ownership guidance, see [SDK lifecycle](/sdk#finishing-admitted-work).

Extensions can register tools, subscribe to events, add commands, and more. See [Extensions](/extensions) for the full API.

**Event Bus:** Extensions can communicate via `pi.events`. Pass a shared `eventBus` to `DefaultResourceLoader` if you need to emit or listen from outside:

```typescript
import { createEventBus, DefaultResourceLoader } from "@bastani/atomic";

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  eventBus,
});
await loader.reload();

eventBus.on("my-extension:status", (data) => console.log(data));
```

> See [examples/sdk/06-extensions.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/06-extensions.ts) and [Extensions](/extensions)

### Skills

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type Skill,
} from "@bastani/atomic";

const customSkill: Skill = {
  name: "my-skill",
  description: "Custom instructions",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  source: "custom",
};

const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/04-skills.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/04-skills.ts)

### Context Files

```typescript
import { createAgentSession, DefaultResourceLoader } from "@bastani/atomic";

const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      { path: "/virtual/AGENTS.md", content: "# Guidelines\n\n- Be concise" },
    ],
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/07-context-files.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/07-context-files.ts)

### Slash Commands

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type PromptTemplate,
} from "@bastani/atomic";

const customCommand: PromptTemplate = {
  name: "deploy",
  description: "Deploy the application",
  source: "(custom)",
  content: "# Deploy\n\n1. Build\n2. Test\n3. Deploy",
};

const loader = new DefaultResourceLoader({
  promptsOverride: (current) => ({
    prompts: [...current.prompts, customCommand],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/08-prompt-templates.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/08-prompt-templates.ts)

### Session Management

Sessions use a tree structure with `id`/`parentId` linking, enabling in-place branching.

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@bastani/atomic";

// In-memory (no persistence)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// New persistent session
const { session: persisted } = await createAgentSession({
  sessionManager: await SessionManager.create(process.cwd()),
});

// Continue most recent
const { session: continued, modelFallbackMessage } = await createAgentSession({
  sessionManager: await SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) {
  console.log("Note:", modelFallbackMessage);
}

// Open specific file
const { session: opened } = await createAgentSession({
  sessionManager: await SessionManager.open("/path/to/session.jsonl"),
});

// List sessions
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Session replacement API for /new, /resume, /fork, /clone, and import flows.
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: await SessionManager.create(process.cwd()),
});

// Replace the active session with a fresh one
await runtime.newSession();

// Replace the active session with another saved session
await runtime.switchSession("session-id");

// Replace the active session with a fork from a specific user entry
await runtime.fork("entry-id");

// Clone the active path through a specific entry
await runtime.fork("entry-id", { position: "at" });
```

`SessionManager.create()`, `open()`, `continueRecent()`, `forkFrom()`, and mutations are asynchronous. `SessionManager.inMemory()` returns an explicitly memory-backed manager synchronously. Await a mutation before reading its result or starting dependent work. A resolved write is committed; a failed write rejects with the store's typed error and leaves the failed entry unpublished. New persistent sessions store their header during creation and commit setup entries immediately. There is no `flush` method. Reads remain synchronous.

**SessionManager tree API:**

```typescript
const sm = await SessionManager.open("/path/to/session.jsonl");

// Session listing
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Tree traversal
const entries = sm.getEntries();        // All entries (excludes header)
const tree = sm.getTree();              // Full tree structure
const path = sm.getPath();              // Path from root to current leaf
const leaf = sm.getLeafEntry();         // Current leaf entry
const entry = sm.getEntry(id);          // Get entry by ID
const children = sm.getChildren(id);    // Direct children of entry

// Labels
const label = sm.getLabel(id);          // Get label for entry
await sm.appendLabelChange(id, "checkpoint"); // Set label

// Branching
await sm.branch(entryId);                     // Move leaf to earlier entry
await sm.branchWithSummary(id, "Summary...");  // Branch with context summary
await sm.createBranchedSession(leafId);       // Extract path to new file
```

> See [examples/sdk/11-sessions.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/11-sessions.ts) and [Session Format](/session-format)

**Resuming on another machine:** `runtime.switchSession()` prepares a session recorded on another machine before it opens it: a matching checkout is used as-is, otherwise the session's worktree snapshot is restored into a fresh worktree and the session continues there (see [Resume on any machine](/guides/resume-on-any-machine)). `runtime.rehydrate(sessionId)` does the same when it wakes a session, except that a session whose last working directory is the checkout it worked in on this machine (a worktree this machine restored for it, or a checkout whose repository holds the commit of its latest snapshot) continues there as it is. `createAgentSession({ sessionManager })` does the same for a supplied session that recorded worktree snapshots, unless you pass `cwd` or `workspace`. It starts in the recorded checkout when that still matches the snapshot, compared under the `snapshots` option you pass; a recorded path that exists here with a different tree, for example on a runner built from the same image, is restored like a missing one. A session without snapshots, or created with `snapshots: { enabled: false }`, starts as supplied. `prepareSessionResume(sessionManager, options)` runs the step for a `SessionManager` you opened yourself and returns the session opened where it continues. Failures are typed, exported from `@bastani/atomic`, and carry `code`, `hint` and JSON `fields`; `serializeResumeError` and `rehydrateResumeError` carry them across processes. `isResumeFailure(error)` tells a failure the user can fix from a bug. In shared storage, `switchSession()`, `rehydrate()` and the workflows `run()` with an existing run's `runId` bound their lookup by `RESUME_CATALOG_TIMEOUT_MS` (15 seconds). `/workflow resume` reports a run id that is not found with the journal catalog's `run-not-found` error, not with `ResumeNotFoundError`; `run()` with a run id its journal does not hold starts a new run under that id.

| Class | Code | When | Fields | Guard |
|---|---|---|---|---|
| `ResumeNotFoundError` | `not-found` | The session id matches nothing in the selected storage. `reason` is `local-storage-not-joined` (storage only this machine reads; the hint is `atomic storage join <url> --token-file <path>`, after `atomic team leave` on a machine joined with `atomic team join`) or `shared-miss`. | `subject`, `id`, `reason`, `storage` | `isResumeNotFoundError` |
| `ResumePreconditionError` | `preconditions-unmet` | Checked before anything is opened or written; lists every unmet piece in one pass. | `entryPoint` (`cli`, `switch-session`, `create-agent-session`, `workflow-resume` or `rehydrate`), `problems[]` of `{ code, subject, why, fix }` with codes `adapter-not-installed`, `credential-missing`, `credential-unreadable`, `git-unavailable`, `setup-hook-missing`. With `git-unavailable`, `cause` is the `GitUnavailableError` or `GitProvisionError` that says why no Git could be started or provisioned | `isResumePreconditionError` |
| `ResumeCatalogUnavailableError` | `catalog-unavailable` | The storage could not be reached during the lookup. `retryable: true`; nothing was changed. | `subject` (`session` or `run`), `id`, `storage`, `phase` | `isResumeCatalogUnavailableError`, `isRetryableResumeError` |
| `ResumeCatalogTimeoutError` | `catalog-timeout` | The storage did not answer the lookup within 15 seconds. `retryable: true`; nothing was changed. | `subject` (`session` or `run`), `id`, `storage`, `phase`, `timeoutMs`, `elapsedMs` | `isResumeCatalogTimeoutError`, `isRetryableResumeError` |
| `ResumeSetupHookError` | `setup-hook-failed`, `setup-hook-timed-out` | The setup hook of a restored worktree failed, was stopped, or ran past its timeout. | `hook`, `worktree`, `envHash`, `exitStatus`, `signal`, `logPath`, `timeoutMs`, `elapsedMs` | `isResumeSetupHookError` |

All of them extend `ResumeError` (`isResumeError`, `findResumeError`), and cross worker and process boundaries as themselves (`serializeResumeError`, `rehydrateResumeError`). A snapshot that cannot be restored stays a `WorkspaceDriftError` with the restore failure as its `cause`. Cancelling a resume through its `AbortSignal` rejects with the signal's reason, never with one of these errors.

### Settings Management

```typescript
import { createAgentSession, SettingsManager, SessionManager } from "@bastani/atomic";

// Default: loads from files (global + project merged)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create(),
});

// With overrides
const settingsManager = SettingsManager.create();
settingsManager.applyOverrides({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 5 },
});
const { session } = await createAgentSession({ settingsManager });

// In-memory (no file I/O, for testing)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  sessionManager: SessionManager.inMemory(),
});

// Custom directories
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create("/custom/cwd", "/custom/agent"),
});
```

**Static factories:**
- `SettingsManager.create(cwd?, agentDir?)` - Load from files
- `SettingsManager.inMemory(settings?)` - No file I/O

**Project-specific settings:**

Settings load from Atomic-first locations and merge:
1. Global: `~/.atomic/agent/settings.json`, then legacy `~/.pi/agent/settings.json`
2. Project: `<cwd>/.atomic/settings.json`, then legacy `<cwd>/.pi/settings.json`

Project overrides global. Nested objects merge keys. Setters modify global settings by default.

**Persistence and error handling semantics:**

- Settings getters/setters are synchronous for in-memory state.
- Setters enqueue persistence writes asynchronously.
- Call `await settingsManager.flush()` when you need a durability boundary (for example, before process exit or before asserting file contents in tests).
- `SettingsManager` does not print settings I/O errors. Use `settingsManager.drainErrors()` and report them in your app layer.

> See [examples/sdk/10-settings.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/10-settings.ts)

## ResourceLoader

Use `DefaultResourceLoader` to discover extensions, skills, prompts, themes, and context files.

```typescript
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@bastani/atomic";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
});
await loader.reload();

const extensions = loader.getExtensions();
const skills = loader.getSkills();
const prompts = loader.getPrompts();
const themes = loader.getThemes();
const contextFiles = loader.getAgentsFiles().agentsFiles;
```

Package workflows returned by `DefaultResourceLoader` are available through the SDK session's `workflow` tool, even when the factory adds the shipped workflows extension. Use the tool's `reload` action to pick up added or removed package workflows without recreating the session. Project packages still require project trust; workflow reload does not grant it.

Custom `ResourceLoader` implementations can optionally provide `getWorkflowResources()` returning `ResolvedResource[]` and `refreshWorkflowResources()` returning `Promise<ResolvedResource[]>`. Refresh should return the current trust-filtered resources. If refresh is omitted, workflow reload uses the getter's current snapshot. If both are omitted, shipped workflows and normal workflow-directory discovery remain available.

Package MCP servers from `DefaultResourceLoader` remain available through the session's `mcp` tool when the factory adds the shipped MCP extension. Custom loaders can provide `getMcpServerContributions()` returning `McpServerContribution[]`; return only contributions allowed by your loader's trust policy. Normal MCP configuration overrides still apply. See [MCP servers](/mcp-servers) for connection and tool invocation.

## Return Value

`createAgentSession()` returns:

```typescript
interface CreateAgentSessionResult {
  // The session
  session: AgentSession;
  
  // Extensions result (for runner setup)
  extensionsResult: LoadExtensionsResult;
  
  // Warning if session model couldn't be restored
  modelFallbackMessage?: string;

  // The resolved binding when the session was created with `workspace`
  workspace?: BoundWorkspace;
}

interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
```

## Run Modes

The SDK exports run mode utilities for building custom interfaces on top of `createAgentSession()`:

### InteractiveMode

Full TUI interactive mode with editor, chat history, and all built-in commands:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@bastani/atomic";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: await SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: "Hello",
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

### runPrintMode

Single-shot mode: send prompts, output result, exit:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runPrintMode,
  SessionManager,
} from "@bastani/atomic";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: await SessionManager.create(process.cwd()),
});

await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "Hello",
  initialImages: [],
  messages: ["Follow up"],
});
```

### runRpcMode

JSON-RPC mode for subprocess integration:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "@bastani/atomic";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: await SessionManager.create(process.cwd()),
});

await runRpcMode(runtime);
```

See [RPC documentation](/rpc) for the JSON protocol.

## Session start errors

An in-process subagent that does not start within its start budget fails with a `SessionStartTimeoutError`; see [Subagent start timeouts](/subagents#subagent-start-timeouts) for the budget and how to change it. The child's result carries it serialized as `startError`, and its `error` text is the error's `message`. Every error in this family extends `SessionStartError`. Branch on the class, a guard, or `code`, never on the message:

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `SessionStartTimeoutError` | `session-start-timeout` | A subagent did not open its session, load its resources, create its agent session (including any resource-admission wait) and dispatch its task within its start budget. `retryable` is `true`. | `subject` (the child), `phase` (`admission`, `setup`, `dispatch` or `event-loop`: what blocked it), `step` (`opening-session`, `loading-resources`, `creating-session`, `awaiting-admission` or `dispatching-task`), `timeoutMs`, `elapsedMs`, `stepElapsedMs`, `steps` (each step's `elapsedMs`, in order), `eventLoop` (`turns`, `meanTurnMs`, `maxTurnMs` sampled during the budget), `hint` | Act on `phase` as [Subagent start timeouts](/subagents#subagent-start-timeouts) describes, then launch the child again. |
| `SessionStartConfigError` | `invalid-session-start-timeout` | A start budget is not a whole number of milliseconds from 1 to 2147483647. The subagent runner throws it for an invalid `sessionStartTimeoutMs` option before it admits the child; an invalid `sessionStartTimeoutMs` in the subagent `config.json` is reported once and ignored. `retryable` is `false`. | `source` (`sdk`, `cli`, `env` or `settings`), `field`, `reason` (`not-a-positive-integer` or `exceeds-maximum`), `value` (the rejected value as JSON text, at most 64 characters), `hint` | Correct that field. |

Guards check the class first and then `name` and `code` (plus `phase` or `field`), so they also match an error from another realm. `isSessionStartError(value)`, `isSessionStartTimeoutError(value)` and `isSessionStartConfigError(value)` test one value. `findSessionStartError(error)` returns the first session start error in an error's `cause` chain, looking at most eight levels deep, and `isRetryableSessionStartError(error)` tells whether that error is retryable.

`serializeSessionStartError(error)` returns JSON-safe `{ name, code, message, hint, retryable, fields, cause }`, with causes bounded at eight levels. `rehydrateSessionStartError(serialized)` returns the same class with the same fields. An unknown name, or fields that no longer fit its class, rehydrates into `SessionStartError` with the original `name`, `code`, `message` and `fields`. `parseSessionStartTimeoutMs(value, source, field)` validates a budget the same way the runner does: it returns `undefined` for `undefined`, the number for a valid budget, and throws `SessionStartConfigError` otherwise.

```typescript
import { isRetryableSessionStartError, rehydrateSessionStartError } from "@bastani/atomic";

const startError = result.startError && rehydrateSessionStartError(result.startError);
if (startError && isRetryableSessionStartError(startError)) {
  // Act on startError.phase, then launch the child again.
}
```

## Debug output

These helpers let extensions and SDK code follow [debug mode](/development#debugging):

- `isDebugEnabled(area?, env?)` returns whether debug output is on: in debug mode for every area, and for `area` also while its own variable is set. Without `area`, only debug mode counts. `env` defaults to `process.env`.
- `reportDebug(area, event, fields, ownOutput?, env?)` records one event. In debug mode it appends a JSON line to the debug log, with credentials redacted and long text cut to 2,000 characters. `fields` holds strings, numbers, booleans, `null` or lists of strings and numbers, never objects. While the area's own variable is set, `ownOutput` is called with the variable's value to write the event where that variable always has.
- `appendDebugRecord(path, record)` appends one redacted JSON line to another debug file, such as a trace file.
- `DEBUG_AREA_VARIABLES` maps each area (`workflow`, `model-routing`, `pooled-watch`, `pool`, `storage`) to its own environment variable, or `undefined`.
- `getDebugLogFailure()` returns the first `DebugLogUnwritableError` of this process, if writing a debug log ever failed.
- `setDebugSetting(enabled)` turns debug mode on or off for this process and for child processes it starts afterwards. It does not save the `debug` setting.
- `onDebugSettingChange(listener)` calls `listener` with each change of that value and returns a function that unsubscribes.

### Debug errors

| Class | `code` | When | Fields | What to do |
|-------|--------|------|--------|------------|
| `DebugLogUnwritableError` | `debug-log-unwritable` | The debug log or a trace file cannot be created or appended to. It is not thrown: it is recorded once per process, shown as one warning, and returned by `getDebugLogFailure()`. | `path`, `hint`, `retryable: false`, `cause` | Make the directory writable, or turn debug mode off. |
| `DebugConfigError` | `invalid-setting` | `setDebugSetting()` or the RPC `set_debug` command received something other than `true` or `false`. It is thrown before anything changes. | `source` (`"sdk"` or `"rpc"`), `field` (`"enabled"`), `received` (the value's type, never the value), `hint`, `retryable: false` | Pass `true` or `false`. |

Both extend `DebugError`, whose `code` is a `DebugErrorCode` and whose `fields()` returns the fields above. Branch on the class or `code`, not the message. `isDebugError`, `isDebugLogUnwritableError` and `isDebugConfigError` recognize them, including an error that crossed a process boundary as a plain object with the same `name` and `code`.

To pass one between processes, `serializeDebugError(error)` turns it into a `SerializedDebugError` (`name`, `code`, `message`, `hint`, `retryable`, `fields`, and a cause chain of at most eight errors), and `rehydrateDebugError(serialized)` rebuilds the same class with the same fields. An unknown `name` comes back as a `DebugError` that keeps its `name`, `code`, `fields` and `retryable`. The RPC client does this for you: when the engine refuses `set_debug`, `setDebug()` rejects with the `DebugConfigError`.

## Exports

The main entry point exports:

```typescript
// Factory
createAgentSession
createAgentSessionRuntime
AgentSessionRuntime

// Auth and Models
AuthStorage
ModelRegistry

// Resource loading
DefaultResourceLoader
type ResourceLoader
createEventBus

// Constants and helpers
CONFIG_DIR_NAME
defineTool
STRUCTURED_OUTPUT_TOOL_NAME
createStructuredOutputTool
createStructuredOutputCapture
generateStructuredOutput
getAgentDir
getPackageDir
getReadmePath
getDocsPath
getExamplesPath
generateDiffString
generateUnifiedPatch
type EditDiffResult

// Releasing idle sessions and waking them (see "Releasing idle sessions" in the SDK guide)
type ReleasedAgentSession
type ReleaseWhenIdleOptions
AgentWakeDispatcher
agentWakeDispatcher
wakeKeyNamespace
type AgentWake
type AgentWakeKind
type AgentWakeHandler
type AgentWakeHandlerOptions
type AgentWakeClock
type AgentWakeTimer
type AgentWakeDispatcherOptions
type AgentWakeDispatcherStats
type AgentWakeFailureListener
AgentRehydrateError
AgentReleaseConfigError
type AgentRehydrateErrorCode
type AgentRehydrateErrorFields
type AgentReleaseConfigSource
type AgentSessionActivity
type SerializedAgentRehydrateError
type SerializedAgentErrorCause
isAgentRehydrateError
isAgentReleaseConfigError
isRetryableAgentRehydrateError
isLocalOnlySessionStorage
serializeAgentRehydrateError
rehydrateAgentRehydrateError
TEAM_JOIN_COMMAND

// Session output
createTranscript
type Transcript
type TranscriptOptions
type TranscriptPart

// Session management
SessionManager
SettingsManager

// Decision service
decide
type DecisionRequest
type DecisionResult
type DecisionQuestion, DecisionQuestions, DecisionChoiceQuestion, DecisionBoolQuestion, DecisionScoreQuestion
type DecisionAnswers, DecisionChoiceAnswer, DecisionBoolAnswer, DecisionScoreAnswer, DecisionSource
DecisionError, DecisionConfigError, DecisionRequestError, DecisionModelUnavailableError
DecisionTimeoutError, DecisionOutputError, DecisionProviderError
type DecisionErrorCode, DecisionConfigErrorCode, DecisionRequestErrorReason, DecisionModelUnavailableReason
isDecisionError, isDecisionConfigError, isDecisionRequestError, isDecisionModelUnavailableError
isDecisionTimeoutError, isDecisionOutputError, isDecisionProviderError
findDecisionError, isRetryableDecisionError, serializeDecisionError, rehydrateDecisionError

// Workflow run control and observation (session.workflows)
type SessionWorkflows
type WorkflowRunControl
type WorkflowActivityFrame
type WorkflowActivityObserver
type WorkflowActivitySubscription
type WorkflowRootActivity
type WorkflowRootGraph
type WorkflowGraphNode
type WorkflowGraphNodePrompt
type WorkflowGraphRunPrompt
type WorkflowRunSummary
type WorkflowRunDetail
type WorkflowRunControlOutcome
type WorkflowRunControlFailedRun
WorkflowRunControlError
WorkflowRunNotFoundError
WorkflowRunOwnershipError
WorkflowRunNotResumableError
WorkflowStageNotFoundError
WorkflowStageAmbiguousError
WorkflowStageResumeUnsupportedError
WorkflowRunStorageError
WorkflowRunControlUnavailableError

// Session start errors
SessionStartError
SessionStartTimeoutError
SessionStartConfigError
isSessionStartError
isSessionStartTimeoutError
isSessionStartConfigError
findSessionStartError
isRetryableSessionStartError
serializeSessionStartError
rehydrateSessionStartError
parseSessionStartTimeoutMs
MAX_SESSION_START_TIMEOUT_MS
type SessionStartErrorCode
type SessionStartPhase
type SessionStartStep
type SessionStartStepTiming
type SessionStartEventLoopSample
type SessionStartTimeoutDetails
type SessionStartConfigSource
type SessionStartConfigReason
type SerializedSessionStartError
type SerializedSessionStartCause
// Finished task retention (see "Owner-bound task supervisor (S1)")
FINISHED_TASK_RETENTION
TaskEvictedError, isTaskEvictedError, findTaskEvictedError, rehydrateTaskEvictedError
type TaskEvictedErrorCode, type TaskEvictedErrorFields
TaskToolError, isTaskToolError, rehydrateTaskToolError
type TaskToolFailureCode, type TaskToolErrorFields, type SerializedTaskToolError
// Detached tool call failures (see "Detachable tool calls")
type DetachedCallFailure, type DetachedCallFailureCause
// Git resolution (see "Resolving git")
resolveGit, resolveGitSync, getGitStatus, GIT_MINIMUM_VERSION
GitProvisionError, GitUnavailableError, GitProvisionTimeoutError, GitProvisionConfigError
isGitProvisionError, isGitUnavailableError, isGitProvisionTimeoutError, isGitProvisionConfigError
findGitProvisionError, isRetryableGitProvisionError, rehydrateGitProvisionError
type ResolvedGit, type ResolveGitOptions, type GitToolStatus, type GitUnavailableCode, type GitUnavailableFields

// fd and ripgrep download errors (see "fd and ripgrep download errors")
ManagedToolError, ManagedToolDownloadError, ManagedToolTimeoutError
isManagedToolError, isManagedToolDownloadError, isManagedToolTimeoutError, isRetryableManagedToolError
type ManagedToolName, type ManagedToolRequestPhase, type ManagedToolErrorCode, type ManagedToolDownloadFields, type ManagedToolTimeoutFields

// Debug output
isDebugEnabled
reportDebug
appendDebugRecord
DEBUG_AREA_VARIABLES
getDebugLogFailure
setDebugSetting
onDebugSettingChange
DebugError
DebugLogUnwritableError
DebugConfigError
isDebugError
isDebugLogUnwritableError
isDebugConfigError
serializeDebugError
rehydrateDebugError
type SerializedDebugError
type SerializedErrorCause
type DebugConfigErrorFields
type DebugArea
type DebugFields
type DebugValue
type DebugErrorCode
type DebugSettingSource

// Event subscriptions (session.subscribe, ctx.subscribe, ctx.events)
type EventSource
type SubscriptionEvent
type Subscription
type SubscriptionStats
type SessionEventChild
type SessionEventHandler
type SessionSubscribeOptions
githubChecks, githubReviews, logTail, webhook, interval
publishEvent, openEventSubscription
createWakeDispatcher, sharedWakeDispatcher
SubscriptionError, SubscriptionClosedError, SubscriptionConfigError, SubscriptionEventError
EventSourceError, SubscriptionHandlerError, SubscriptionChildUnavailableError
SubscriptionSetupError, SubscriptionSubscriberUnavailableError, SubscriptionRecordError, SubscriptionTimeoutError
isSubscriptionError, isSubscriptionClosedError, isSubscriptionConfigError, isSubscriptionEventError
isEventSourceError, isSubscriptionHandlerError, isSubscriptionChildUnavailableError
isSubscriptionSetupError, isSubscriptionSubscriberUnavailableError, isSubscriptionRecordError, isSubscriptionTimeoutError
isRetryableSubscriptionError, serializeSubscriptionError, deserializeSubscriptionError
type SubscriptionErrorCode, type SubscriptionConfigReason, type SubscriptionSetupMissing, type SubscriberUnavailableReason, type SubscriptionRecordKind, type SubscriptionTimeoutPhase, type WebhookRequestFailures

// Tool factories
createCodingTools
createReadOnlyTools
createReadTool, createBashTool, createEditTool, createWriteTool
createGrepTool, createFindTool, createLsTool

// Edit and write errors (see Built-in tools: Edit and write errors)
EditToolError, EditInputError, EditMatchError, EditTargetError, WriteSelectorError, FileToolAbortedError
isEditToolError, isEditInputError, isEditMatchError, isEditTargetError, isWriteSelectorError, isFileToolAbortedError
serializeFileToolError, rehydrateEditToolError, rehydrateWriteSelectorError

// Types
type CreateAgentSessionOptions
type CreateAgentSessionResult
type StructuredOutputCapture
type StructuredOutputToolOptions
type StructuredOutputRequest
type StructuredOutputResult
type ExtensionFactory
type ExtensionAPI
type ToolDefinition
type Skill
type PromptTemplate
type Tool
```

For extension types, see [Extensions](/extensions) for the full API.

## Owner-bound task supervisor (S1)

For trusted custom hosts, the package exports `AgentTaskHost` and its integration types, not the raw native supervisor. Bind the actual host scope and a mandatory `authorizeLaunch` guard. Never accept ownership or authorization from model-supplied input or reconstruct a lease from a task ID or saved history.

`startAgentTask(intent, operation, runnerFactory)` returns a Result containing `{taskId, lease}` after setup. The factory receives the original `AbortSignal`, reference, and `reportActivity` context. Return separate `result` and `cleanup` promises; report cleanup only when it is confirmed. Replaying the same operation reuses execution without calling another factory.

Use `observeAgentLaunch(taskId, policy?)`, `waitForTask`, `resolveTask`, `cancelTask`, `watchOwnerTasks`, and `close` within the bound owner. Observation returns Result/WaitOutcome. Yielding or cancelling an observation does not stop execution. Cancellation and cleanup failures remain observable; owner close may remain pending until your runner acknowledges cleanup.

An owner keeps its 256 most recently finished tasks (`FINISHED_TASK_RETENTION`): a task is finished once its result settled and its cleanup was reaped. Queued, running and stopping tasks, and tasks whose cleanup is quarantined or failed, are never evicted. When more tasks finish, the one that finished longest ago is evicted: `watchOwnerTasks` delivers a `task-evicted` event and later snapshots omit it. While the owner is open or closing, a finished task is evicted only after every live subscription of its owner has drained it and then drained again, so no subscriber misses a settlement. Atomic's sessions and workflow stages also hold each finished task until its completion notice has been delivered, so the notice can still read the task's title, transcript excerpt and output; an owner then keeps more than 256 records until those notices are out. A custom host that reads a finished task later can do the same with `retainTaskRecord(taskId)` and `releaseTaskRecord(taskId)` on `AgentTaskHost`; both leave a task the owner does not keep alone. `retainTaskRecord` returns a Result: a task the owner already evicted takes no hold and refuses with `TaskEvicted`, also when the eviction lands while the call runs, so hold a task from `onTaskSettled` if you need its record. A closing owner's holds no longer count. Closing an owner keeps every task the close settled until the closing host has drained them all, so `onTaskSettled` runs for each one, even past the retention. Only then does `closeTaskOwner` trim the closed owner to its 256 most recently finished tasks, without waiting for other subscriptions, and its subscriptions receive the final retained set before stopping. A settled wait registered before eviction still returns its outcome. Operation replay reuses a task only while it is kept; afterwards the same operation starts a new one.

`resolveTask`, `waitForTask`, `cancelTask`, `retainTaskRecord` and output reads of an evicted task refuse with code `TaskEvicted` instead of `UnknownTask`; the refusal's `message` is the `TaskEvictedError` message. The `wait` and `kill` tools throw a `TaskToolError` with code `TaskEvicted` whose `cause` is a `TaskEvictedError`.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `TaskEvictedError` | `task_evicted` | A task id or lease names a finished task its owner no longer keeps, because `retainedFinishedTasks` or more of its tasks finished after it. `retryable` is `false`. | `taskId`, `retainedFinishedTasks`, `hint` | Use the result the conversation already reported; a subagent's transcript stays in its own saved session. A shell command's full output is no longer available. |
| `TaskToolError` | `UnknownTask`, `ScopeMismatch`, `TaskEvicted`, `OwnerClosed`, `EnvironmentClosing`, `ObserverCancelled`, `OutputUnavailable`, `CleanupFailed`, `StaleGeneration` | A `wait` or `kill` of a shell task failed: the id names no task of this session or stage, another session's task, an evicted task, a closed owner, or Atomic is shutting down; the wait was cancelled; the output or the stop could not be read or confirmed; or the task list changed while it was read. Only `StaleGeneration` is `retryable`. | `fields.taskId`, `hint` (absent for `EnvironmentClosing`), `retryable`; `cause` is a `TaskEvictedError` for `TaskEvicted` | Follow `hint`: run `/tasks` to see the current tasks, run the command again for a closed owner, or retry a `StaleGeneration`. |

`isTaskToolError(value)` checks the class and then `name` and `code`. `rehydrateTaskToolError(value)` rebuilds the class, with an evicted task's `TaskEvictedError` cause, from its serialized form (`toJSON()`: `name`, `code`, `message`, `hint`, `retryable`, `fields`, `cause`), such as a detached shell wait's `details.error`, and returns `undefined` for a copy without a known `code` or a string `fields.taskId`.

`isTaskEvictedError(value)` checks the class first and then `name` and `code`, so it also matches a copy from another realm or process. `findTaskEvictedError(error)` returns the `TaskEvictedError` that is the error or sits in its `cause` chain within eight links, such as the cause of a `TaskToolError`, or `undefined`. `rehydrateTaskEvictedError(value)` rebuilds the class from a copy such as `JSON.parse(JSON.stringify(error))`, and returns `undefined` for a copy without a string `taskId` or a positive integer `retainedFinishedTasks`.

### Supervised command SDK

For shell integration, use the exported Bash and PowerShell factories with a trusted `taskOwner` binding. Execution timeout and observation budget are separate. The automatic command wait is normally 10000 ms; `until-settled` waits for completion. A yielded command remains owned, and later waits can read retained output with explicit omission markers.

Without a supported owner, explicit background execution is refused. Native Windows legacy WSL `bash.exe` is not supported for owned commands; run Atomic inside WSL instead. See [waiting for shell tasks](#waiting-for-existing-shell-tasks) and [Background tasks](/background-tasks) for caller usage.

### Task transcript references

Task inspectors show references to the bound child conversation, excluding thinking and non-conversation entries. An unbound or empty history reports `Transcript unavailable`. Saved history is not authority to restart or control a task.
