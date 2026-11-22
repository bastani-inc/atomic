---
title: SDK API reference
sidebarTitle: "SDK API"
description: SDK options, resource loaders, return values, run modes, and exports.
---

# SDK API reference

## Options reference

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
- Opt-in JSONL sessions (`sessions/`, when JSONL storage is selected; default sessions live in SQLite at `~/.atomic/workflows/journal.sqlite`)
- The TypeScript extension transpile cache (`cache/transpile/`, one directory per Atomic version; a version's directory is removed once no Atomic process has used it for a week)

`agentDir` is per session, not per process. Each session caches its transpiled extensions under its own `agentDir`. Without the option, a session reads `ATOMIC_CODING_AGENT_DIR` when created. Sessions in one process can use different agent directories. Extension loads never create `agentDir`; if it does not exist, loads skip the cache.

When you pass a custom `ResourceLoader`, `cwd` and `agentDir` no longer control resource discovery. They still control session naming and tool path resolution.

### Workspace

```typescript
import { createAgentSession, workspace } from "@bastani/atomic";

const { session, workspace: binding } = await createAgentSession({
  workspace: workspace({ repo: "/srv/src/api", branch: "feat/ticket-123", sandbox: "read-only" }),
  cwd: "packages/server", // optional; resolved inside the worktree
});
```

`workspace` accepts a `workspace({ ... })` value or an already resolved `BoundWorkspace`. The session's `cwd` becomes the bound worktree, an explicit `cwd` must stay inside it, and a read-only workspace removes and refuses `write`, `edit`, and `todo`. `result.workspace` and `session.workspace` hold the resolved binding. See [Workspaces](/sdk#workspaces).

### Model

```typescript
import { getModel } from "@bastani/atomic-ai/compat";
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

#### Resolving `model: "auto"`

`resolveAutoModel({ settings, availableModels, sessionModel?, sessionThinkingLevel?, thinkingLevel? })` returns the `{ model, thinkingLevel }` that subagents run for `model: "auto"`, or `undefined` when there is none. It makes no model request. It picks the configured default model (`settings.defaultProvider` and `settings.defaultModel`) when it is in `availableModels`, at `thinkingLevel`, else that model's `modelThinkingLevels` entry, else `defaultThinkingLevel`, else `medium`. Without one it returns `sessionModel` at `thinkingLevel`, else `sessionThinkingLevel`. The level is clamped to what the model supports.

```typescript
import { resolveAutoModel, SettingsManager } from "@bastani/atomic";

const auto = resolveAutoModel({
  settings: SettingsManager.create(process.cwd()).getSettings(),
  availableModels: await modelRuntime.getAvailable(),
});
if (auto) {
  const { session } = await createAgentSession({ model: auto.model, thinkingLevel: auto.thinkingLevel, modelRuntime });
}
```

#### Model catalog persistence and refresh

`ModelRuntime.create()` restores cached catalogs from local persistence and does not download the models.dev catalog unless you opt in. Pass `catalogBaseUrl` (or set `ATOMIC_MODEL_CATALOG_URL`) to read `<url>/api.json` from your own models.dev mirror instead of https://models.dev.

- `allowModelNetwork` (default `false`): enables a create-time network refresh.
- `modelRefreshTimeoutMs` (default `15_000`): bounds how long that refresh may run before it is aborted.
- `refreshOnCreate: false`: skips the initial catalog and availability refresh entirely; built-in models remain available.

`createAgentSession()` does not fetch an account model list at startup. If its cache restore found no GitHub Copilot catalog and its first prompt has no usable model or fallback, the session can look up the exact saved Copilot model. A supplied `model`, a working preset or fallback, and a cached catalog need no lookup. Only that session uses the result; `models-store.json`, credentials, and model listings do not change.

The `modelFallbackMessage` returned by `createAgentSession()` describes startup. If the account confirms the model is absent, the first prompt's error says so; a refused, offline, or cancelled lookup keeps the usual error. Pass `signal` to `createAgentSession()` to cancel the lookup, or pass `allowModelNetwork: false` to `ModelRuntime.create()` to disable it. Custom asynchronous-only credential stores keep normal local selection; discovery never waits on their read queue.

```typescript
const refreshedRuntime = await ModelRuntime.create({
  allowModelNetwork: true,
  modelRefreshTimeoutMs: 15_000,
});
```

Remote catalogs persist locally so later runtimes can restore them without a network request:

- The default file is `models-store.json` next to `models.json`. With the default `modelsPath`, that file is `~/.atomic/agent/models-store.json`.
- Set `modelsStorePath` to choose another location, or inject `modelsStore` to control persistence entirely. A runtime created with `modelsPath: null` keeps its store in memory.
- Network refreshes are throttled to once per provider every four hours unless forced. Call `await modelRuntime.refresh({ allowNetwork: true, force: true, signal })` to force an immediate refresh.
- Setting `ATOMIC_OFFLINE` (legacy alias `PI_OFFLINE`) disables model network access, and a `refresh()` call that omits `allowNetwork` follows that same runtime network policy.

`registerProvider()`, `registerNativeProvider()`, and `unregisterProvider()` return at once and refresh the catalog from cache in the background while checking provider credentials. `await modelRuntime.whenRegistrationRefreshesSettled()` resolves once no registration refresh is running, including refreshes started while you wait.

### API keys and OAuth

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

Use `generateStructuredOutput()` for one schema-validated decision without starting an agent session. Pass optional exact `model` and `fallbackModels` IDs, `currentModel`, `modelRegistry`, `instructions`, `state`, and `schema`. Omit `model` to start on `currentModel`, or on `decisionModel` when you pass `settings`; `currentModel` is also the final fallback.

With `settings`, `decisionModel` resolves as `decide()` resolves it and rejects with a `DecisionError` on failure. Atomic resolves each ID through `modelRegistry`: chat models use chat inference, and registered classifiers use the generic `classify` operation when the schema is a finite Choice (and are skipped otherwise). See [Structured decisions](/sdk/structured-decisions).

Use `decide()` to ask the configured `decisionModel` typed Choice, yes/no, and Score questions over `state`. It returns typed answers, with probabilities when a classifier answered, and rejects with a `DecisionError`. The `structured_output` tool starts on the same decision model. See [decide](/sdk/structured-decisions#decide).

### System prompt

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

- Built-in tool names enabled by default: `read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, `powershell` (on native Windows when PowerShell is available), and `codemode` when its extension is loaded.
- `find` discovers filesystem paths by glob; `search` searches file contents with regex patterns across files, directories, globs, and internal URLs.
- `builtins` selects shipped packages independently of tools: keys are `subagents`, `mcp`, `web-access`, and `intercom`. Omitted, `{}`, and omitted keys enable packages. A `false` value removes that package's extensions and resources, including on reload; `true` enables it.
- The `subagents` builtin ships all 21 bundled subagent skills: `agent-browser`, `agent-desktop`, `bro`, `create-spec`, `feedback`, `herdr`, `how`, `impeccable`, `liteparse`, `prompt-engineer`, `qlty`, `research-codebase`, `show-me`, `skill-creator`, `subagent`, `tdd`, `teach`, `tmux`, `unslop`, `why`, and `workflow-files`. If you want these skills without the delegation tool, keep `subagents` enabled and pass `excludedTools: ["subagent"]`. If you disable the package, install independent copies of the skills you need in your [skills directory](/skills#locations).
- `tools` accepts an allowlist of coding, extension, and custom tool names or `*` patterns. `tools: []` exposes no tools, including Intercom. A list containing only `+name`/`-name` entries modifies resolved defaults (for example `tools: ["+codemode", "-write"]`). Modifiers require exact names, cannot mix with plain entries, and apply across reloads. Invalid lists throw.
- `excludedTools` removes matching names from the registry and active selection. Exclusions win over `tools`; unknown names are ignored.
- `noTools: "all"` exposes no tools, even with a nonempty `tools` list. It does not remove package resources or authorize services.
- `noTools: "builtin"` suppresses the built-in selection, including `codemode`, when `tools` is omitted. Other extension and custom tools keep their default activation unless excluded. An explicit `tools` list wins over this mode.
- Configured `defaultTools` selects initial coding tools when `tools` and `noTools` are omitted. Plain names replace defaults; modifier-only lists such as `["-bash", "+ls"]` modify defaults, and project modifier-only lists layer over global settings. See [defaultTools](/settings#tools).

Subagent children inherit these restrictions. Child allowlists intersect with parent selections, including during model fallback, and a child cannot restore a parent-disabled package or excluded tool. See [child configuration](/sdk#subagent-children) for model, auth, host callback, and working-directory inheritance.

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

`session.getToolStatus()` explains a session's tools: where the selection came from, every registered tool with its exposure, owner, and active state, why inactive tools are off and how to enable them, excluded names, and missing names with typo suggestions. `formatToolStatus()` renders the report as plain text.

```typescript
import { createAgentSession, formatToolStatus } from "@bastani/atomic";

const { session } = await createAgentSession({ tools: ["+codemode"] });
console.log(formatToolStatus(session.getToolStatus()));
```

```text
Tool selection: Atomic's default tool set with +codemode
  read, bash, kill, edit, write, find, search, ask_user_question, todo, codemode

Active (16)
  read                direct      built-in
  bash                direct      built-in
  kill                direct      built-in
  edit                direct      built-in
  write               direct      built-in
  find                direct      built-in
  search              direct      built-in
  ask_user_question   model-only  built-in
  todo                direct      built-in
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

Each entry in `tools` has `name`, `active`, `exposure`, `source`, `sourcePath`, `summary`, and, for inactive tools, `inactiveReason`. `missing` and `excluded` list `{ name, reason }` entries; a `missing` name usually means a typo or a failed extension load. Pass `{ heading, dim, warning }` functions as the second argument to `formatToolStatus()` for terminal colors. Interactive mode shows the same report with `/tools`, and RPC clients request it with [`get_tools`](/rpc/protocol#get_tools).

The report's `git` field reports which Git Atomic runs: `{ source: "system" | "provisioned", version, path, update? }`, or `{ source: "unavailable", error }` with a serialized [git error](#git-errors). A provisioned install of an older pinned release carries `update: { pinnedTag, installedTag?, reason? }`. `reason` appears if a replacement attempt failed in this process; failed replacements are not retried until the next process start. Reading status never downloads Git.

#### Resolving git

Atomic runs Git 2.30.0 or newer (`GIT_MINIMUM_VERSION`) from `PATH`, and otherwise a portable Git downloaded into `getBinDir()/git` (see [Git](/getting-started/installation#git)). Use the same resolver for your own Git commands:

```typescript
import { spawnSync } from "node:child_process";
import { resolveGit } from "@bastani/atomic";

const git = await resolveGit();
spawnSync(git.path, ["status", "--short"], { cwd: projectDir, env: git.env, encoding: "utf8" });
```

| Function | Returns |
|---|---|
| `resolveGit({ signal?, onStatus? })` | `Promise<ResolvedGit>`. May download and verify portable Git. `onStatus` receives `{ type: "info" \| "warning", message }` progress. Aborting `signal` rejects with `signal.reason`; concurrent callers share one download, which stops only when every caller aborts. |
| `resolveGitSync()` | `ResolvedGit` without downloading. Throws in order: `GitUnavailableError` (`unsupported-platform` or `offline`), else the last failed `resolveGit()` error in this process (`GitUnavailableError` or `GitProvisionTimeoutError`), else `GitUnavailableError` (`not-installed`). Check `isRetryableGitProvisionError()` to see whether `await resolveGit()` can help. |
| `getGitStatus()` | `GitToolStatus`, the value in the tools report. Never downloads. |

`ResolvedGit` provides `path` (absolute executable path), `source` (`"system"` or `"provisioned"`), `version`, and `env`. For provisioned Git, `env` copies `process.env` and adds `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_CONFIG_SYSTEM` (macOS and Linux), and `GIT_SSL_CAINFO` (Linux and Windows), preserving any `GIT_CONFIG_SYSTEM` or `GIT_SSL_CAINFO` already set. `env` is computed per call so later changes to `process.env` apply.

For provisioned Git, the returned `path` and `env` stay valid across automatic updates. Keep them together for a running command, and resolve again when starting work with the latest release. Do not construct executable or helper paths from the cache directory yourself.

#### Git errors

Every Git resolution failure is a `GitProvisionError` carrying `code`, `hint`, `retryable`, and JSON-safe `fields`. Invalid SDK options fail before provisioning starts. Failed downloads, checksums, and verification never activate a partial install, and failed updates leave earlier resolved paths usable. Branch on `code` or the class, never on `message`.

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `GitUnavailableError` | `unsupported-platform` | No portable build for this system: `reason` is `musl`, `glibc-too-old`, `architecture`, or `platform` | `platform`, `arch`, `reason`, `libc?`, `systemGit?` | Run `installCommand` (for example `apk add git` on Alpine) or install Git 2.30.0+ |
| `GitUnavailableError` | `offline` | `ATOMIC_OFFLINE` is set and no usable Git exists | `platform`, `arch`, `offlineVariable`, `systemGit?` | Unset the variable or install Git 2.30.0+ |
| `GitUnavailableError` | `not-installed` | `resolveGitSync()` found no usable Git and does not download | `platform`, `arch`, `installDir`, `systemGit?` | Call `await resolveGit()` first, or install Git 2.30.0+ |
| `GitUnavailableError` | `checksum-mismatch` | Download SHA-256 differs from the pinned value | `platform`, `arch`, `asset`, `url`, `expectedSha256`, `actualSha256` | Check for a proxy altering downloads, or install Git yourself. Not retryable |
| `GitUnavailableError` | `download-failed` | Download failed; `httpStatus` is absent for network errors | `platform`, `arch`, `asset`, `url`, `httpStatus?` | Check access to github.com and retry. `retryable` is true for network errors and HTTP 408, 425, 429, 500, 502, 503, 504 |
| `GitUnavailableError` | `install-failed` | Reading, staging, extracting, verifying, or promoting failed (`phase`: `stage`, `extract`, `verify`, `promote`) | `platform`, `arch`, `phase`, `asset`, `installDir`, `detail?` | Free disk space or fix permissions on `installDir`; for `verify`, check cache readability or install Git yourself |
| `GitProvisionTimeoutError` | `provision-timeout` | A step exceeded its limit (`phase`: `lock`, `download`, `extract`, `verify`) | `phase`, `timeoutMs`, `elapsedMs` | Retry; `retryable` is true |
| `GitProvisionConfigError` | `invalid-option` | A `resolveGit()` option had the wrong type; checked before any probe | `source` (`"sdk"`), `field`, `expected` | Fix the option |

When present, `systemGit` describes the unusable Git found on `PATH`: `{ path, problem: "below-minimum" | "probe-failed", version? }`. `GitUnavailableError` also exposes `platform`. Every `GitUnavailableError` and `GitProvisionTimeoutError` sets `installCommand` when Atomic recognizes the OS or distribution (for example, Linux root commands, using the `git-core` PPA on Ubuntu earlier than 22.04). `hint` ends with `installCommand`, and rehydrated errors preserve the originating machine's command. Cleanup failures attach as `cleanupCause` without replacing the original error.

Guards match across realms and processes by `name` and `code`: `isGitProvisionError`, `isGitUnavailableError`, `isGitProvisionTimeoutError`, and `isGitProvisionConfigError`. `findGitProvisionError(error)` searches a cause chain to a bounded depth, and `isRetryableGitProvisionError(error)` checks whether any error in the chain is retryable. `JSON.stringify(error)` outputs `{ name, code, message, hint, retryable, fields, cause? }`, and `rehydrateGitProvisionError(payload)` restores the class and cause chain (unknown names become `GitProvisionError` keeping their `name` and `code`).

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

When `fd` or `ripgrep` is neither in `getBinDir()` nor on `PATH`, the `find` and `search` tools download the latest release from GitHub. If a request fails, the tool call rejects with a `ManagedToolError` naming the request, interactive startup shows the same warning, and nothing is installed. Offline mode, unsupported platforms, and unreadable archives still reject with plain errors.

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `ManagedToolDownloadError` | `download-failed` | Release lookup (`phase: "resolve-version"`) or archive download (`phase: "download"`) failed, or the response was unusable (`cause` holds the underlying error) | `tool` (`"fd"` or `"rg"`), `phase`, `url`, `httpStatus?`, `detail?` | Check access to github.com and retry, or install the tool with your package manager. `retryable` is true for network errors and HTTP 408, 425, 429, 500, 502, 503, 504 |
| `ManagedToolTimeoutError` | `download-timeout` | Request exceeded its limit: 10 s for release lookup, 120 s for archive download | `tool`, `phase`, `url`, `timeoutMs`, `elapsedMs` | Retry; `retryable` is true |

`isManagedToolError`, `isManagedToolDownloadError`, and `isManagedToolTimeoutError` match across realms by `name` and `code`. `isRetryableManagedToolError(error)` inspects a cause chain to a bounded depth. Branch on `code` or the class, never on `message`.

#### Bash tool behavior

When `bash` is enabled, commands run through the configured shell with the Atomic process permissions. Use `tools`, `excludedTools`, or `noTools` to decide whether a session exposes `bash`. Atomic has no command-level allow/deny filter for `bash`; use an OS or container sandbox, or a custom tool or extension, when you need command allowlisting or isolation.

Completed `bash` calls return `structuredContent` shaped as `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`, including nonzero exits. Programmatic callers receive up to 1 MiB of captured output plus an omission marker when truncated; larger outputs keep their head and tail and include `full_output_path`. This cap limits captured output rather than serialized JSON size. Model-facing text keeps normal truncation limits, and running or background observations keep their task lifecycle format.

#### Waiting for existing shell tasks

Both Bash and PowerShell factories accept `{ action: "wait", id: taskId, budgetMs: 1000 }` with a trusted `taskOwner` binding without executing a command. Narrow `BashToolInput` and `PowerShellToolInput` by `action` before reading `command`.

- `budgetMs` is optional, finite, and non-negative. Omitting it uses the owner's command wait policy; `0` polls immediately.
- Results store `WaitOutcome` in `details.observation`, available exit status in `details.exitCode`, and retained output in text content. Failure and cancellation metadata stay in the settled observation.
- Yielded waits advance through bounded retained-output pages for the same owned task even if the tool is recreated, continuing split UTF-8 characters on the next page. Settled waits return all retained output subject to labelled gaps and truncation.
- Aborting a wait releases only its observation. A binding from `AgentTaskHost.ownerBinding` also releases waits when owner messages arrive.

Do not mix wait arguments with launch fields. Unknown IDs, foreign IDs, and unbound waits reject before execution hooks. Custom `operations.exec` does not supply task ownership. See [Background tasks](/background-tasks) for examples and lifetime rules.

#### PowerShell tool behavior

`createPowerShellTool()` and `createPowerShellToolDefinition()` provide the same tool interactive sessions use. On native Windows, default local operations prefer `pwsh.exe`, fall back to `powershell.exe`, and throw if neither is available. `createLocalPowerShellOperations()` and `getPowerShellConfig()` are exported for custom integrations. Factories expose the execution-time `ATOMIC_*` and legacy `PI_*` session snapshot by default; set `exposeSessionEnvironment: false` to opt out.

PowerShell tools and local operations accept a trusted `taskOwner` binding and the same `wait` observation policy as `bash`. Owned native Windows runs auto-yield after the owner's command budget (normally 10000 ms); explicit per-call budgets override it, while execution timeout stays separate. Without a supported owner, explicit background requests reject and foreground execution waits for completion.

On native Windows, an unowned `bash` or `powershell` command runs in its own job object so a timeout or abort terminates child processes even after the shell exits. Processes that break away (`CREATE_BREAKAWAY_FROM_JOB`), including commands started by Git Bash, are terminated on timeout or abort only while still under the running shell; detached children left behind by a finished command continue running.

```typescript
import { createPowerShellTool } from "@bastani/atomic";

const powershell = createPowerShellTool("C:\\path\\to\\project");
```

#### Tools with custom cwd

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

### Custom tools

```typescript
import { Type } from "@bastani/atomic/typebox";
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

Use `defineTool()` for standalone definitions and arrays like `customTools: [myTool]`. Inline `pi.registerTool({ ... })` infers parameter types automatically.

Custom tools passed via `customTools` combine with extension-registered tools. When you pass a plain-name `tools` allowlist, include each custom or extension tool you want active (for example `tools: ["read", "bash", "my_tool"]`). Modifier-only lists keep default activation and can enable inactive tools with `+name`. `excludedTools` removes any matching tool from the active set.

`ToolDefinition.constrainedSampling` survives `defineTool()`, `customTools`, tool wrappers, inspection, and isolated execution:

- `{ type: "json_schema", strict: "prefer" | "require" }`: `prefer` may fall back; `require` fails if the active model cannot enforce strict JSON Schema.
- `{ type: "grammar", variants: { openai_lark?: string, openai_regex?: string } }`: requires one required string parameter and capable model metadata.
- `false`: disables constrained sampling.

Inspection preserves optional-property identity (`undefined` stays present when explicitly set). See `ConstrainedSamplingConfig`, [Constrained sampling](/extensions/authoring#constrained-sampling), and `ModelInfo.compat` in [RPC](/rpc/protocol#get_available_models).

Factory-created `createBashTool()` instances receive the same execution-time `ATOMIC_SESSION_*` and `PI_SESSION_*` snapshot as the built-in `bash` tool unless you pass `exposeSessionEnvironment: false`. `MessageRenderOptions.outputPad` is also forwarded to normal and isolated custom message renderers.

Normal sessions expose `kill({ id: taskId })` for owned `bash` and `powershell` background tasks. Include `kill` in any explicit `tools` allowlist if the agent should be able to stop tasks. `createKillTool` and `createKillToolDefinition` accept `KillToolOptions.taskOwner` (the same trusted binding used by shell launches) and reject without one. Result details carry the supervisor's `CancelReceipt`. See [Stop a shell task from a tool call](/background-tasks#stop-a-shell-task-from-a-tool-call).

#### Detachable tool calls

A tool whose work does not need the session once started (such as a CI run, deployment, or external job) can set `detachable: true`. Re-running it with the same call ID and arguments after a restart must be safe, because a host may re-dispatch it if the previous process died.

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

`detachable` can also be a predicate on the call's arguments. Only calls returning `true` may detach. Built-in shell tools and Intercom use predicates so only a shell `wait` without a budget, an Intercom `ask`, and a `contact_supervisor` decision request can detach. Intercom reply waits stay live when multi-node routing is active.

A detachable call follows its message's `concurrency` ordering before starting. If a tool must save a durable handoff first, set `detachmentRequiresReady: true`: check `toolCallNeedsDetachmentHandoff(signal)` while running, then call `markToolCallReadyForDetachment(signal)` once saved. The call detaches only after both that signal and the host's delay (or returns inline if it finishes sooner).

Without a detachment policy, detachable calls run inline. A host using persistent storage enables detachment with `session.setToolDetachment({ afterMs })`, where `afterMs` is `0` to `MAX_TOOL_DETACHMENT_AFTER_MS` (`2,147,483,647`):

- **Inline vs. detached:** Calls finishing within `afterMs` complete inline. Calls still running detach: the turn's other results save, the detached call remains pending, and `prompt()` resolves so the host can release or dispose of the session.
- **Interrupts:** Once a turn is interrupted, inline calls no longer detach (even if marked ready in the same tick). They keep their result if they stop within `ATOMIC_TOOL_ABORT_GRACE_MS` (default 10 s); otherwise they record `Operation aborted` and later outcomes are discarded. Queued calls fail immediately with `Operation aborted`. Calls that detached before the interrupt are unaffected and remain available from `takeDetachedToolCalls()`.
- **`session.takeDetachedToolCalls()`:** Returns each detached call once as a `DetachedToolCall` (`toolCallId`, `toolName`, non-rejecting `result` promise, `abort(reason)`). Calls whose turn the transcript has moved past are cancelled, dropped, and logged as `stale-detached-call`. Thrown errors become `isError` results; errors with a string `code` populate `details.error` via `toJSON()` (or a fallback object with `serialization: "fallback"` if `toJSON()` throws). Unrecordable payloads record a call error instead, while session-store failures still reject resume.
- **`session.resumeDetachedTurn(results)`:** On a reopened session, records each result after its call and continues the turn (without a new user message) once every detachable call of that turn has a result. You can supply results across multiple calls; until the last arrives, `hasPendingDetachedTurn()` stays `true`. Duplicate, already-answered, or stale results are ignored (stale ones log `stale-detached-call`), while results for nonexistent calls throw `unknown-tool-call`. Calling with no new results continues a turn whose calls already have results.
- **`session.isWaitingOnDetachedResults()`:** Reports whether the transcript still awaits a detached result. While waiting under a detachment policy, nothing starts a turn on the idle session (including subagent notices, steering, follow-ups, and post-compaction continuations); held custom messages are persisted and replayed after `resumeDetachedTurn()` continues the turn. Do not call `prompt()` while waiting on results.
- **`session.hasPendingDetachedTurn()` and `session.redispatchDetachedToolCalls()`:** `hasPendingDetachedTurn()` reports whether a reopened transcript ends on a detached turn; continue it with `redispatchDetachedToolCalls()` and `resumeDetachedTurn()` instead of prompting again. `redispatchDetachedToolCalls()` restarts unanswered detachable calls with their original IDs and arguments and emits `tool_execution_start` before returning.

Results handed to `resumeDetachedTurn()` pass through `tool_result` hooks, image resizing, and output persistence (stored as `tool-output://<sha256>` in blob-capable stores like SQLite, libSQL, and memory, or on disk otherwise; see [Persisted tool output](/tools#persisted-tool-output)).

Detached calls run outside the session's async context and hold no reference to the session:

- `onUpdate` progress updates are dropped after detachment (and from the start on redispatched calls).
- `ctx` exposes only `cwd`; other properties throw `ToolDetachmentError` with code `context-detached`. Read needed `ctx` values before awaiting, or pass them in tool arguments. (Redispatched calls have full `ctx` only until their first `await`; queued calls get it when they start if the session is still open.)
- Detached calls report no host diagnostics.

`ask_user_question` always runs inline. A shell `wait` whose task is gone after a restart returns an error result whose `details.error` is a serialized `TaskToolError` (see [Owner-bound task supervisor](#owner-bound-task-supervisor)).

While waiting on a detached call, background completion notices are saved and held until `resumeDetachedTurn()` continues the turn. `compact()` rejects while waiting, and automatic compaction waits until right before the continuation request.

`ToolDetachmentError` reports refused detachment operations without mutating state. Check it with `isToolDetachmentError(error)` or `findToolDetachmentError(error)`, and branch on `code`:

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `ToolDetachmentError` | `invalid-policy` | `setToolDetachment()` received an `afterMs` outside `0` to `MAX_TOOL_DETACHMENT_AFTER_MS` | `sessionId`, `field`, `value` | Pass a valid `afterMs` or `undefined` to keep calls inline |
| `ToolDetachmentError` | `unknown-tool-call` | `resumeDetachedTurn()` received a result for a call not in the transcript | `sessionId`, `toolCallId` | Return only results from `takeDetachedToolCalls()` or `redispatchDetachedToolCalls()` for this session |
| `ToolDetachmentError` | `session-busy` | `resumeDetachedTurn()` ran while the session was running or recording earlier results (`retryable: true`) | `sessionId` | Wait for the active call or run to settle, then retry |
| `ToolDetachmentError` | `session-closed` | `resumeDetachedTurn()` ran on a closing or disposed session | `sessionId` | Reopen the session from its store and pass the results there |
| `ToolDetachmentError` | `context-detached` | A detached call accessed a `ctx` member other than `cwd` | `sessionId`, `toolCallId` | Read required `ctx` values before detachment or pass them in arguments |

Each error carries `hint` and JSON-safe `fields`; only `session-busy` is `retryable`. `JSON.stringify(error)` serializes `name`, `code`, `message`, `hint`, `retryable`, `fields`, and a bounded `cause` chain, and `deserializeToolDetachmentError(serialized)` restores a `ToolDetachmentError` that guards recognize.

#### Structured output final results

`structured_output` is not registered by default. Register `createStructuredOutputTool()` when you need a schema-validated decision inferred by a selected model:

```typescript
import { Type } from "@bastani/atomic/typebox";
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

The calling model invokes `structured_output` with:

- `instructions`: the judgment to make.
- `state`: a nonempty named object with the task and relevant context (never secrets).
- `model`: optional exact `provider/model` ID of a chat model or registered classifier (defaults to the session's `decisionModel`, then the current chat model).
- `fallbackModels`: optional ordered exact IDs tried after the primary.

The tool infers the answer through the session's model registry rather than capturing caller arguments directly. On success, it returns pretty-printed JSON, sets `details` to the validated value, and sets `terminate: true`. Classifiers run only for finite Choice schemas and are skipped otherwise; classifier failures and chat provider errors advance through the fallback chain, while plain text without a result gets up to three repairs before advancing. Cancellation stops the call immediately.

Each call shares one wall-clock deadline covering repairs, retries, and fallbacks. It defaults to the session's [`httpIdleTimeoutMs`](/settings#http) setting; pass `timeoutMs` (a positive integer in milliseconds) to `createStructuredOutputTool()` to override it. See [Structured decisions](/sdk/structured-decisions#cancellation-and-failures).

To register under a custom name, pass `name` and include it in any explicit `tools` allowlist:

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

> See [examples/sdk/05-tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/sdk/05-tools.ts)

### Extensions

`DefaultResourceLoader` discovers extensions from `~/.atomic/agent/extensions/` and `.atomic/extensions/` first, then legacy `~/.pi/agent/extensions/` and `.pi/extensions/`, plus `settings.json` extension sources.

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

`createAgentSession()` preserves resources from a supplied loader and adds Atomic's shipped builtin extensions once without mutating your loader's arrays or options.

- **Synthetic builtin factories:** Named `extensionFactories` descriptors may set `builtin: true` to expose a `builtin:<name>` resource and `replaceable: true` to yield if another extension registers the same tool, command, or flag. Pass `additionalExtensionPaths: ["builtin:codemode"]` for explicit loading even with `noExtensions: true`. See [built-in extension resources](/extensions#built-in-extension-resources).
- **Inline built-in extensions:** `DefaultResourceLoader` includes `codemode`, `tool-search`, and `llama.cpp` as `builtin:<name>` paths. `codemode` is active by default (opt out with `tools: ["-codemode"]`), while `tool_search` is opt-in. Turn off an inline builtin with `noExtensions: true`, `disabledBuiltinExtensions: ["codemode"]`, or `extensions: ["-builtin:codemode"]`.
- **Bindings and startup:** Pass `extensionBindings` to `createAgentSession()` to install `uiContext`, `mode`, `commandContextActions`, `shutdownHandler`, or `onError` before `session_start` runs. Creation awaits startup and resource discovery, shutting down a partial session if startup fails. Pass `reportStartupErrors: true` to report `session_start` and `resources_discover` errors to `onError` while keeping the session open. Later `bindExtensions()` calls update bindings without replaying `session_start`.
- **Strict reloads:** `failOnExtensionErrors: true` requires transactional `prepareReload()` support (`DefaultResourceLoader` implements it). Custom loaders without `prepareReload()` work for ordinary reloads, while strict reload fails before calling their mutating `reload()`.

#### Session disposal and lifecycle

Always `await session.dispose()`. Disposal seals new admission immediately and waits for active work, extension shutdown handlers, pending settings writes, pending notice-line saves, lease release, and up to 5 seconds for in-flight extension transpile-cache writes started by that session.

Once `dispose()` resolves, nothing the session started is still writing to its session store or extension transpile cache, so deleting `agentDir` or a caller-owned store directory right afterward will not race. (Transpile-cache writes still unfinished after 5 seconds are logged to debug output and left to finish asynchronously.)

- Concurrent `dispose()` calls share one promise.
- Catch `ShutdownFailed` to inspect component `errors`; a failed close still leaves the session closed.
- Settings persistence failures can reject disposal; repair storage and repeat the write before closing (`dispose()` does not drain `SettingsManager.drainErrors()`).
- Caller-supplied settings, storage, and model runtimes remain caller-owned. Do not add manual MCP or Intercom teardown.
- `AgentSessionRuntime` uses the same awaited close during session replacement and transfers bindings before the replacement starts. Reload invalidates stale input requests and subscriptions so late replies cannot authorize new work.
- Duplicate `executeBash()` IDs act as correlation IDs: `abortBash(id)` cancels every active call with that ID.

For reload, replacement, and resource ownership patterns, see [Finishing admitted work](/sdk#finishing-admitted-work).

#### Prompting options

`session.prompt(text, options?)` accepts:

- `expandPromptTemplates` (default `true`): expands file-based prompt templates, skill commands, and extension commands.
- `images`: optional `ImageContent[]` attachments.
- `streamingBehavior`: `"steer"` or `"followUp"` when sending while a turn is active; omitting it while streaming rejects with `AgentSessionBusyError`.
- `startTurnOnly`: when `true`, starts a turn only if the session is idle and queued messages are not paused. When a turn is already running or queued input is paused, nothing is sent or queued and `prompt()` resolves as `"handled"`.
- `source`: `InputSource` metadata for `input` hooks.
- `preflightResult`: callback `(success, disposition?)` invoked once preflight accepts (`"handled"`, `"queued"`, or `"started"`) or rejects the prompt.

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

### Context files

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

### Slash commands

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

### Session management

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

`runtime.switchSession(id, options?)` and `runtime.rehydrate(id, options?)` resume at the current context window, so `getEntries()` and `getTree()` return only the resident window.

To visit older entries without loading them into memory, iterate `for await (const page of sessionManager.readHistory({ fromSeq, toSeq, signal }))`:

- `page.items` contains entries and oversized references; read oversized bytes with `sessionManager.readHistoryChunks(reference)`.
- `fromSeq` and `toSeq` are inclusive and optional. Iteration stops at the last stored sequence when it began.
- Pages arrive in recording order across branches by default; pass `branchLeafSeq` to restrict reads to one branch's ancestry.
- A custom task transcript source implementing only `getEntries()` exposes only its supplied rows; implement `readHistory` and `getEarlierCursor` to support paging into older or off-branch history.

```typescript
// Read older entries a page at a time; the manager keeps none of them.
const prompts: string[] = [];
for await (const page of sessionManager.readHistory()) {
  for (const item of page.items) {
    if ("entry" in item && item.entry.type === "message" && item.entry.message.role === "user") {
      prompts.push(JSON.stringify(item.entry.message.content));
    }
  }
}
// One older entry by id:
const entry = await sessionManager.readEntry("entry-id");
```

`sessionManager.loadFullHistory()` and `{ history: "full" }` on `SessionManager.open()`, `openSessionById()`, `continueRecent()`, `switchSession()`, and `rehydrate()` load every stored entry across every branch into memory so `getEntries()` and `getTree()` cover the whole session. Use them only when you need all entries resident at once.

`SessionManager.create()`, `open()`, `continueRecent()`, `forkFrom()`, and all mutations are asynchronous. `SessionManager.inMemory()` with no entries is synchronous; when supplying entries, await `SessionManager.inMemory(cwd, options, entries)` and keep the input array stable until it resolves. A resolved write is committed (there is no `flush()` method), and a failed write rejects with the store's typed error without publishing the entry. Reads remain synchronous.

**SessionManager tree API:**

```typescript
const sm = await SessionManager.open("/path/to/session.jsonl");

// Session listing
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Tree traversal
const entries = sm.getEntries();        // Entries in the current window, without the header
const tree = sm.getTree();              // Tree structure for the current window
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

#### Resuming on another machine

`runtime.switchSession()` prepares a session recorded on another machine before opening it: a matching checkout stays as is, while a missing or drifted checkout is restored into a fresh worktree (see [Resume on any machine](/guides/resume-on-any-machine)).

- **`runtime.rehydrate(sessionId)`:** Applies the same preparation, keeping checkouts already used on this machine (a worktree restored here or a local repository holding the latest snapshot commit) and restoring only other checkouts.
- **`createAgentSession({ sessionManager })`:** Prepares a supplied session that has worktree snapshots unless `cwd` or `workspace` is passed. A local path with a different tree is restored like a missing checkout. Sessions without snapshots or with `snapshots: { enabled: false }` start as supplied.
- **Path mapping:** Session tools map recorded checkout paths to restored worktrees. To map paths the same way in host code, run inside `withWorktreeRootMappings(sessionManager.getWorktreeRootMappings(), work, outer)` and call `mapPathForCwd(path, cwd)` (`outer` defaults to `currentWorktreeRootMappings()`).
- **`prepareSessionResume(sessionManager, options)`:** Runs preparation for a `SessionManager` you opened yourself and returns the opened session plus `notices`.
- **Non-blocking secondary checkouts:** Only the session's primary checkout needs to be restorable; other missing or changed checkouts emit a warning notice rather than refusing resume (`switchSession()`, `rehydrate()`, and `createAgentSession()` do not print those notices).
- **Shared-storage timeout:** `switchSession()` and `rehydrate()` bound catalog lookup by `RESUME_CATALOG_TIMEOUT_MS` (15 seconds).

Resume errors extend `ResumeError` (`isResumeError`, `findResumeError`, `isResumeFailure`), carry `code`, `hint`, and JSON-safe `fields`, and cross processes via `serializeResumeError` and `rehydrateResumeError`.

| Class | Code | When | Fields | Guard |
|---|---|---|---|---|
| `ResumeNotFoundError` | `not-found` | Session ID matches nothing in selected storage (`reason`: `local-storage-not-joined` or `shared-miss`). | `subject`, `id`, `reason`, `storage` | `isResumeNotFoundError` |
| `ResumePreconditionError` | `preconditions-unmet` | Unmet preconditions detected before opening (`problems[]` with codes `adapter-not-installed`, `credential-missing`, `credential-unreadable`, `git-unavailable`). | `entryPoint` (`cli`, `switch-session`, `create-agent-session`, or `rehydrate`), `problems[]` (`{ code, subject, why, fix, checkout? }`) | `isResumePreconditionError` |
| `ResumeCatalogUnavailableError` | `catalog-unavailable` | Storage unreachable during lookup (`retryable: true`). | `subject` (`session` or `run`), `id`, `storage`, `phase` | `isResumeCatalogUnavailableError`, `isRetryableResumeError` |
| `ResumeCatalogTimeoutError` | `catalog-timeout` | Storage lookup exceeded 15 seconds (`retryable: true`). | `subject` (`session` or `run`), `id`, `storage`, `phase`, `timeoutMs`, `elapsedMs` | `isResumeCatalogTimeoutError`, `isRetryableResumeError` |

An unrebuildable snapshot produces a `WorkspaceDriftError` carrying the restore failure as `cause`. Blueprint failures never reject resume (see below), and cancelling via `AbortSignal` rejects with the signal's reason.

#### Missing session directory

`runtime.switchSession()` and `runtime.importFromJsonl()` check the session's recorded working directory across both JSONL and database storage. They reject with `MissingSessionCwdError` when that directory does not exist on this machine and no worktree snapshot restored one, leaving storage unchanged.

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `MissingSessionCwdError` | `session-cwd-missing` | The session's working directory does not exist (`retryable: false`). | `sessionCwd`, `fallbackCwd`, `sessionFile` (JSONL only), `hint` | Retry with `{ cwdOverride }` (`switchSession`) or `importFromJsonl(path, cwdOverride)`, or fork there with `SessionManager.forkTo(cwd, store)`. |

Use `isMissingSessionCwdError(error)`, `serializeMissingSessionCwdError(error)`, `isSerializedMissingSessionCwdError(value)`, and `rehydrateMissingSessionCwdError(serialized)` across process boundaries. `RpcClient` rehydrates this error for `switch_session` and `import_session`. Interactive mode prompts to continue in the current directory, fork there, or cancel (see [Sessions](/sessions#resuming-and-deleting-sessions)).

#### Blueprint errors

Blueprint errors never reject a resume; `runBlueprintBuild` and `setUpResumedBlueprints` return them in the build outcome as warnings. All extend `BlueprintError` (`isBlueprintError`, `findBlueprintError`, `serializeBlueprintError`, `rehydrateBlueprintError`) and are not retryable.

| Class | Code | When | Fields | Guard |
|---|---|---|---|---|
| `BlueprintInvalidError` | `blueprint-invalid` | A blueprint file breaks the schema or a rule (`reason` names the rule; `rule` carries the validation rule text, such as `'uses' steps are not supported in maintenance sections`). | `blueprint`, `scope`, `reason`, `rule`, `subject` | `isBlueprintInvalidError` |
| `BlueprintStepFailedError` | `blueprint-step-failed` | A step exited nonzero, stopped on a signal, or failed to start; remaining steps in that blueprint did not run. | `blueprint`, `scope`, `section`, `index`, `step`, `exitStatus`, `signal`, `logPath` | `isBlueprintStepFailedError` |
| `BlueprintStepTimedOutError` | `blueprint-step-timed-out` | A step exceeded its 3-hour limit and was stopped. | step fields, `logPath`, `timeoutMs`, `elapsedMs`, `phase` | `isBlueprintStepTimedOutError` |
| `BlueprintUsesUnsupportedError` | `blueprint-uses-unsupported` | A `uses` step names an unsupported action (`docker-action`, `unknown-action-type`, `action-not-found`, `action-fetch-failed`, `action-metadata-invalid`, `node-unavailable`, `required-input-missing`, `unsupported-expression`). | step fields, `uses`, `reason`, `detail`, `logPath` | `isBlueprintUsesUnsupportedError` |
| `BlueprintBuildFailedError` | `blueprint-build-failed` | A blueprint file or build ledger could not be read or written. | `phase`, `detail` | `isBlueprintBuildFailedError` |

### Settings management

```typescript
import { createAgentSession, SettingsManager, SessionManager } from "@bastani/atomic";

// Default: loads from files (global + project merged)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create(),
});

// With overrides: never saved, and kept for the run (through setting writes, reload() and trust changes) until a setter changes the same setting
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
- `SettingsManager.create(cwd?, agentDir?)`: load from files.
- `SettingsManager.inMemory(settings?)`: no file I/O.

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

Package MCP servers discovered by `DefaultResourceLoader` connect through the bundled MCP client extension and register their tools as `mcp__<server>__<tool>` (defaulting to `codemode` exposure). Custom loaders can provide `getMcpServerContributions()` returning `McpServerContribution[]`; return only contributions allowed by your loader's trust policy. Normal MCP configuration overrides still apply. See [MCP servers](/mcp-servers) for connection and tool invocation.

### Copying extension handlers in `extensionsOverride`

If your override rebuilds a discovered extension without changing its `resources_discover` handler, keep the callback supplied by the loader on **that load**. You can copy the handler map without wrapping its functions:

```typescript
const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  extensionsOverride: (base) => ({
    ...base,
    extensions: base.extensions.map((extension) => ({
      ...extension,
      handlers: new Map(extension.handlers),
    })),
  }),
});
```

During interactive startup, deferred resource loading can run discovery twice. Both calls run, but if the same registration reports the same error, the terminal shows it once. A later `/reload` reports the failure again.

Creating `(...args) => handler(...args)` on every load registers a new callback each time, so you can see two startup errors. Keep separate callbacks when your override changes the handler, adds a step that can fail, or forwards on behalf of separate installations. Don't cache a previous load's handler or share a forwarder by extension name.

## Return value

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

## Run modes

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

If you quit the host or call `session.dispose()` during the initial interactive extension bind, `await mode.init()` or `await mode.run()` returns normally. The disposed session does not enter the input loop. This also applies when an incoming event or a pending provider retry started the UI. Track your own shutdown request instead of catching `SessionClosed` to detect it.

Replacing the session during the initial bind is not a quit: the interrupted startup still rejects. If you dispose only the session and then create a replacement with `await runtime.newSession()`, call `mode.run()` again to accept input for the replacement. Direct `session.bindExtensions()` and `mode.handleEvent(event)` calls still reject on close, so custom handlers can catch startup failures and report errors from their recovery work.

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

- `isDebugEnabled(area?, env?)` returns whether debug mode is on. The same setting applies to every area. `env` defaults to `process.env`.
- `reportDebug(area, event, fields, ownOutput?, env?)` records one event. In debug mode it appends a JSON line to the debug log, with credentials redacted and long text cut to 2,000 characters. `fields` holds strings, numbers, booleans, `null` or lists of strings and numbers, never objects. The optional `ownOutput` callback is not used by any current area.
- `appendDebugRecord(path, record)` appends one redacted JSON line to another debug file, such as a trace file. It and `reportDebug()` retain their synchronous write and immediate failure-reporting behavior.
- `appendDebugRecordAsync(path, record)` and `reportDebugAsync(area, event, fields, ownOutput?, env?)` provide the same redaction and reporting without blocking the host. Await their promises to observe the completed write, or call `flushDebugLog()` to wait for all queued debug records.
- `DEBUG_AREA_VARIABLES` lists `decision`, `storage` and `engine`. All have value `undefined`: there are no separate environment switches for these areas.
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

## Nonblocking helpers

Use the asynchronous helpers in a host that must keep accepting input while it reads files, checks trust or resolves tools. Existing synchronous SDK forms remain available.

| Helpers | Purpose |
| --- | --- |
| `getProjectTrustOptionsAsync`, `hasProjectTrustInputsAsync`, `hasTrustRequiringProjectResourcesAsync`, `savedProjectTrustAsync` | Read project trust inputs without synchronous file access; `savedProjectTrustAsync()` returns a predicate whose trust result must be awaited |
| `buildSkillCatalogAsync`, `emptySkillCatalog` | Load a skill catalog asynchronously, or create an empty catalog without reading files |
| `latestSessionSnapshotAsync`, `mapPathForCwdAsync`, `mapRestoredPathAsync`, `workspaceSessionCwdAsync` | Read snapshot metadata and resolve restored paths and workspace working directories asynchronously |
| `loadMcpConfigAsync`, `updateMcpServerConfigAsync`, `addMcpServerConfigAsync`, `removeMcpServerConfigAsync` | Read and edit MCP configuration asynchronously; await edits before reading their result |
| `AuthStorage.createAsync`, `SettingsManager.createAsync` | Load credential or settings storage asynchronously |
| `ModelRuntime.getCompatibilityRequestConfigAsync`, `ModelRuntime.getCatalogInputsGenerationAsync` | Read provider request configuration or observe catalog input changes asynchronously |
| `selectProcessStorageAsync`, `processSharedStorageSelectionAsync`, `processStorageEnvironmentAsync` | Read process storage inputs or a team token file asynchronously when building storage selections or child environments |
| `storageHomeDirAsync`, `workflowsStorageDirAsync`, `defaultSessionDatabasePathAsync`, `defaultSharedStoragePathAsync`, `storagePathBaseDirAsync` from `@bastani/atomic/storage` | Resolve storage homes and paths asynchronously while preserving custom agent-directory isolation |
| `readClaimFileAsync`, `claimFileAtomicallyAsync`, `sameDirectoryAsync`, `selectStorageAsync` from `@bastani/atomic/storage` | Read or publish ownership claims, compare directories or resolve a storage selection without blocking the host |
| `takeTakeoverMutexAsync` | Acquire a takeover mutex asynchronously; await the returned mutex's `release()` |
| `resolveInstalledGit`, `getGitStatusAsync`, `AgentSession.getToolStatusAsync` | Resolve installed Git or collect Git and session tool status asynchronously without provisioning a missing tool |
| `appendDebugRecordAsync`, `reportDebugAsync`, `flushDebugLog` | Append debug records off the host thread, or wait for queued records before inspecting their files |
| `containProcessTree`, `processTreeEnded`, `killProcessTree` | Contain a child tree on Windows, wait for a contained tree to end, or terminate an owned process group across platforms |

Await each operation before starting work that depends on its result:

- MCP edits of one file are queued. A synchronous MCP edit rejects while an asynchronous edit is pending; await the pending edit or use asynchronous helpers throughout.
- `emptySkillCatalog()` is synchronous because it performs no I/O, and `savedProjectTrust()` remains synchronous for existing callers.
- `@bastani/atomic-ai/compat` exports `getEnvApiKeyAsync()` alongside `getEnvApiKey()`.
- Use process-containment helpers only on child PIDs your integration owns. `containProcessTree()` returns `undefined` off Windows; release containment before closing on normal completion, or terminate before closing on cancellation.

## Private temp directories

`ensurePrivateTempDirAsync(...segments)` creates or reuses an account-private directory and returns its path. `assertPrivateDirectoryAsync(path)` verifies that `path` is a real directory owned by the current account that no other account can open, rejecting with `TempDirRefusedError` on security refusal. Filesystem errors such as `ENOENT` propagate unchanged, and relative paths resolve against the current working directory.

On Windows, the native module reads directory ownership and access lists directly, falling back to an asynchronous PowerShell check if unavailable. Prefer the asynchronous functions to wait for verification. Synchronous `ensurePrivateTempDir()` and `assertPrivateDirectory()` never wait: they accept directories already verified in this process and otherwise start background verification (`assertPrivateDirectory()` throws `TempDirRefusedError` with `its ownership is still being verified`, and `ensurePrivateTempDir()` allocates another private directory).

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
resolveAutoModel

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
type AgentWakeSlot
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
// Finished task retention (see "Owner-bound task supervisor")
FINISHED_TASK_RETENTION
TaskEvictedError, isTaskEvictedError, findTaskEvictedError, rehydrateTaskEvictedError
type TaskEvictedErrorCode, type TaskEvictedErrorFields
TaskToolError, isTaskToolError, rehydrateTaskToolError
type TaskToolFailureCode, type TaskToolErrorFields, type SerializedTaskToolError
// Messages typed into a task's transcript (see "Task transcript references")
TaskMessageError, TaskMessageTimeoutError, isTaskMessageError, isTaskMessageTimeoutError
findTaskMessageError, isRetryableTaskMessageError, rehydrateTaskMessageError
type TaskMessageErrorCode, type TaskMessageErrorFields, type TaskMessageTimeoutErrorFields
type TaskMessageTimeoutPhase, type SerializedTaskMessageError
// Detached tool call failures (see "Detachable tool calls")
type DetachedCallFailure, type DetachedCallFailureCause
// Git resolution (see "Resolving git")
resolveGit, resolveGitSync, resolveInstalledGit, getGitStatus, getGitStatusAsync, GIT_MINIMUM_VERSION
GitProvisionError, GitUnavailableError, GitProvisionTimeoutError, GitProvisionConfigError
isGitProvisionError, isGitUnavailableError, isGitProvisionTimeoutError, isGitProvisionConfigError
findGitProvisionError, isRetryableGitProvisionError, rehydrateGitProvisionError
type ResolvedGit, type ResolveGitOptions, type GitToolStatus, type GitUnavailableCode, type GitUnavailableFields

// Private temp directories (see "Private temp directories")
ensurePrivateTempDirAsync, assertPrivateDirectoryAsync, ensurePrivateTempDir, assertPrivateDirectory, TempDirRefusedError

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

// Session working directory
MissingSessionCwdError
isMissingSessionCwdError
serializeMissingSessionCwdError
rehydrateMissingSessionCwdError
isSerializedMissingSessionCwdError
type SerializedMissingSessionCwdError
type MissingSessionCwdErrorCode
type MissingSessionCwdFields
type SessionCwdIssue

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
createReadTool, createBashTool, createPowerShellTool, createKillTool
createEditTool, createWriteTool, createSearchTool, createFindTool, createLsTool

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

<a id="owner-bound-task-supervisor-s1" />

## Owner-bound task supervisor

For trusted custom hosts, the package exports `AgentTaskHost` and its integration types rather than the raw native supervisor. Bind the host scope and a mandatory `authorizeLaunch` guard. Never accept ownership or authorization from model input or reconstruct a lease from a task ID or saved history.

`startAgentTask(intent, operation, runnerFactory)` returns a Result containing `{ taskId, lease }` after setup. The factory receives the original `AbortSignal`, reference, and `reportActivity` context, and returns separate `result` and `cleanup` promises (report cleanup only once confirmed). Replaying the same operation reuses execution without calling another factory.

Use `observeAgentLaunch(taskId, policy?)`, `waitForTask`, `resolveTask`, `cancelTask`, `watchOwnerTasks`, and `close` within the bound owner:

- Observation returns a `Result` / `WaitOutcome`. Launch observation returns once registered, with reason `explicit` for `{ kind: "background" }` and `default-background` without a policy (subagents run in the background).
- `waitForTask(taskId, budgetMs?, onRegistered?, signal?)` waits up to `budgetMs` (or the owner's agent budget if omitted); aborting `signal` ends the wait immediately with `ObserverCancelled`.
- Yielding or cancelling an observation does not stop execution. Cancellation and cleanup failures stay observable, and owner close can stay pending until the runner acknowledges cleanup.

### Finished task retention and eviction

An owner keeps its 256 most recently finished tasks (`FINISHED_TASK_RETENTION`), counting a task as finished once both its result settles and its cleanup is reaped:

- Queued, running, stopping, quarantined-cleanup, and failed-cleanup tasks are never evicted.
- Beyond 256 finished tasks, the oldest finished task is evicted, emitting `task-evicted` on `watchOwnerTasks` and omitting it from later snapshots.
- While open or closing, a finished task is evicted only after live owner subscriptions have drained it. Atomic sessions also hold each finished task until its completion notice is delivered.
- Custom hosts can hold and release finished records with `retainTaskRecord(taskId)` and `releaseTaskRecord(taskId)` on `AgentTaskHost`. Hold from `onTaskSettled` if needed, because `retainTaskRecord` returns `TaskEvicted` once a task is evicted.
- On owner close, newly settled tasks stay available until `onTaskSettled` finishes for all of them; `closeTaskOwner` then trims the closed owner to its 256 most recent finished tasks and sends subscriptions the final retained set before stopping.
- A settled wait registered before eviction still returns its outcome. Operation replay reuses a task only while it is retained; afterward the same operation starts a new task.

`resolveTask`, `waitForTask`, `cancelTask`, `retainTaskRecord`, and output reads for an evicted task fail with `TaskEvicted` (carrying the `TaskEvictedError` message). The `wait` and `kill` tools throw `TaskToolError` with code `TaskEvicted` and a `TaskEvictedError` `cause`.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `TaskEvictedError` | `task_evicted` | A task ID or lease names an evicted finished task (`retryable: false`). | `taskId`, `retainedFinishedTasks`, `hint` | Use the result already reported in the conversation; subagent transcripts remain in their saved sessions. |
| `TaskToolError` | `UnknownTask`, `ScopeMismatch`, `TaskEvicted`, `OwnerClosed`, `EnvironmentClosing`, `ObserverCancelled`, `OutputUnavailable`, `CleanupFailed`, `StaleGeneration` | A shell `wait` or `kill` failed (unknown, foreign, or evicted ID; closed owner; shutdown; cancelled wait; unreadable output or unconfirmed stop; concurrent list change). Only `StaleGeneration` is `retryable`. | `fields.taskId`, `hint` (absent for `EnvironmentClosing`), `retryable`, `cause` (`TaskEvictedError` for `TaskEvicted`) | Follow `hint`: run `/tasks`, re-run the command for a closed owner, or retry `StaleGeneration`. |

Use `isTaskToolError(value)` and `rehydrateTaskToolError(value)` to inspect and restore serialized `TaskToolError` payloads (such as a detached shell wait's `details.error`). Use `isTaskEvictedError(value)`, `findTaskEvictedError(error)` (searches up to 8 cause links), and `rehydrateTaskEvictedError(value)` for `TaskEvictedError`. Both rehydrators return `undefined` when required fields are missing or invalid.

### Supervised command SDK

For shell integration, use the exported Bash and PowerShell factories with a trusted `taskOwner` binding. Execution timeout and observation budget are separate. The automatic command wait is normally 10000 ms; `until-settled` waits for completion. A yielded command remains owned, and later waits can read retained output with explicit omission markers.

Without a supported owner, explicit background execution is refused. Native Windows legacy WSL `bash.exe` is not supported for owned commands; run Atomic inside WSL instead. See [Waiting for existing shell tasks](#waiting-for-existing-shell-tasks) and [Background tasks](/background-tasks) for caller usage.

### Session-local task prompts

`heldPrompts()` returns the process-local `HeldPrompts` registry used by interactive task views. A `HeldPrompt` has `sessionId`, `promptId`, `kind`, `question`, `title`, and `createdAt`, plus the applicable `message`, `choices`, `placeholder`, `initial`, or questionnaire `params`. Timed dialogs also carry an absolute `expiresAt` timestamp in milliseconds. Held prompts do not persist across restarts.

- `current(sessionId)`: reads that session's first pending prompt (concurrent requests queue in arrival order).
- `subscribe(listener)`: calls `listener(sessionId)` when that session's queue changes and returns an unsubscribe function.
- `answer({ sessionId, promptId }, { value })`: returns `{ ok: true }` only for the current matching prompt and a valid `HeldPromptValue` (booleans for confirmations, literal labels for selections, strings for text dialogs, `QuestionnaireResult` for questionnaires). Refused answers return `{ ok: false, reason }` without settling the prompt.
- `cancel({ sessionId, promptId })`: cancels only the current matching prompt and never approves a confirmation.
- `isCurrent(route)` and `routeNamesPrompt(route, prompt)`: verify both identities before answering.
- `hold(prompt, signal, cancelValue)`: enqueues a prompt and awaits its validated answer, adding `createdAt`. Aborting `signal` removes the request even while queued; the adapter owns timeout cancellation.

`HeldPromptKind`, `HeldPromptAnswer`, `HeldPromptResult`, and `HeldPrompts` are exported types. Discard unsent form state once a prompt is no longer current.

- `watchHeldPromptAttention(sessionId, report)`: maps the current prompt to task `input-needed` activity and returns a stop function.
- `isHeldPromptInput(input)` and `isPresentationHostInput(input)`: distinguish Atomic's held-prompt adapter and presentation fallback adapter from explicit SDK `humanInput` adapters.

Only Atomic's interactive hosts with a task inspector hold child prompts automatically. Plain RPC and SDK `uiContext` hosts continue presenting dialogs directly; custom hosts needing session-local forms should supply `humanInput` and route by `HostInputOptions.sessionId`.

### Task transcript references

Custom live transcript sources should implement `getEntrySeq(id)` and `entryReceipt(message)` for bounded paging across compaction. Without either, a chat holding an unsaved stateful card keeps the original live transcript rather than discarding or mis-matching the card.

Task inspectors display references to the bound child conversation: prompts, responses, provider errors, thinking blocks, tool calls and results, shell commands and output, compaction boundaries, branch summaries, and displayed extension messages. Model-only custom messages and non-rendered entries are excluded. Unbound or empty histories report `Transcript unavailable`, and saved history grants no authority to restart or control a task.

`readTaskTranscript(task, cursor?)` returns task-scoped item references and continuation cursors for both saved and live tasks:

- The first occurrence of a repeated public item ID wins.
- Indexed stores check candidate records by sequence; unindexed archives scan earlier metadata in bounded pages only on explicit lookup (never during normal scroll or repaint).
- Reference pages hold at most 100 items and normally at most 1 MiB of identifiers (oversized single identifiers are returned whole with their real `source.entryId` without assembling unrelated text, arguments, or results).

#### Steering and pausing agent tasks

`TaskViewSource` and `TaskTranscriptSource` expose optional methods for sending messages to, clearing queues on, and pausing or resuming running agent tasks:

- **`TaskViewSource.sendTaskMessage(id, text, lane?)`:** Delivers typed text directly to an agent task's session on `lane` (`"steer"` default or `"followUp"`, `TaskMessageLane`). While busy, text waits in the task's queue and is delivered raw at that lane's boundary; idle tasks start a turn, and finished subagents resume. Resolves once the session accepts the text.
- **`TaskViewSource.clearTaskQueue(id)`:** Removes queued typed messages (`QueuedTaskMessages`: `{ steering, followUp }`) for the editor without removing messages from other agents.
- **`TaskViewSource.pauseTask(id)` and `resumeTask(id)`:** `pauseTask(id)` interrupts the task's active turn (like `Esc` in a subagent chat), returns removed typed messages (plus an optional `warning` if pause state could not be persisted), and holds remaining queued work until `resumeTask(id)` releases the queue before the next prompt.
- **`TaskTranscriptSource` hooks:** Implement `queueMessage(text, lane)`, `clearQueue()`, `pauseTurn()`, `resumeTurn()`, `turnPaused()`, and `getQueuedMessages()` on custom transcript sources. Sources without `queueMessage` fall back to `sendMessage(text)` over Intercom if available, and otherwise refuse with `messages-unsupported`. Without `pauseTurn()`, `pauseTask` interrupts the turn via `interruptTurn()` without taking queued messages back.

Failures reject with `TaskMessageError` (or `TaskMessageTimeoutError`):

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `TaskMessageError` | `task-unavailable` | ID names no task held by the view (`retryable: false`). | `taskId`, `hint` | Run `/tasks` to list current tasks. |
| `TaskMessageError` | `messages-unsupported` | Task cannot receive typed messages (for example, a shell task; `retryable: false`). | `taskId`, `hint` | Send messages only to agent tasks that accept typed input. |
| `TaskMessageError` | `delivery-refused` | Task session did not accept the message (`retryable: true`). | `taskId`, `hint`, `target?`, `detail?` | Verify the agent is still available, then retry. |
| `TaskMessageTimeoutError` | `delivery-unconfirmed` | Session did not confirm within `timeoutMs` (`retryable: false`; message may still arrive). | `taskId`, `target`, `timeoutMs`, `elapsedMs`, `phase` (`delivery-acknowledgement`), `hint` | Check the transcript before resending. |
| `TaskMessageError` | `delivery-unconfirmed` | Channel threw or dropped without confirming (`retryable: false`; message may have arrived). | `taskId`, `target?`, `detail`, `hint`, `cause?` | Check the transcript before resending. |

Use `isTaskMessageError(value)`, `isTaskMessageTimeoutError(value)`, `findTaskMessageError(error)`, `isRetryableTaskMessageError(error)`, and `rehydrateTaskMessageError(value)` (restoring from `toJSON()`, or returning `undefined` for invalid payloads).

An agent task's chat is a `ChatSessionHost`. It queues follow-ups and dequeues messages only on the keys bound to `app.message.followUp` and `app.message.dequeue` (`Alt+Enter` and `Alt+Up` by default; `Ctrl+Q` and `Alt+Q` on Windows and WSL) through its editor's `onAction`, or directly when no editor is attached. `Ctrl+F` moves the cursor right.
