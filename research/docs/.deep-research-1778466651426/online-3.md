# Online Research — Partition 3: `packages/atomic/` External Libraries

Researched libraries: `@commander-js/extra-typings` v14.0.0, Claude Code CLI hooks (affecting `@anthropic-ai/claude-agent-sdk` usage at the CLI surface), and `@github/copilot-sdk` v0.3.0 as used in `packages/atomic/src/`.

---

#### @commander-js/extra-typings (v14.0.0)
**Docs:** https://github.com/commander-js/extra-typings, https://www.npmjs.com/package/@commander-js/extra-typings  
**Relevant behaviour:**

`@commander-js/extra-typings` is a re-export wrapper around `commander@~14.0.0` that adds full TypeScript inference for options and arguments. The lockfile entry confirms the peer: `"peerDependencies": { "commander": "~14.0.0" }`.

Key API surface in active use across `packages/atomic/src/`:

- **`new Command(name?)`** — root program or subcommand. `createProgram()` (cli.ts:47) creates the root with `.name("atomic")`.
- **`.command(name, opts?)`** — registers a named subcommand; `{ isDefault: true }` makes it the fallback when no subcommand is given (cli.ts:73); `{ hidden: true }` hides from `--help` (cli.ts:325).
- **`.enablePositionalOptions()`** — prevents the parent from greedily binding flags meant for subcommands. Critical for `atomic workflow list -a claude` routing `-a` to `list` rather than the `workflow` dispatcher (cli.ts:53, workflow.ts:322).
- **`.passThroughOptions()`** — treats everything after a recognised flag as trailing args, allowing unknown flags to be forwarded to the underlying agent CLI (cli.ts:88).
- **`.allowUnknownOption(bool)`** — suppresses Commander's "unknown option" error for pass-through args (cli.ts:86, workflow.ts:364).
- **`.allowExcessArguments(bool)`** — same as above for positional excess (cli.ts:87).
- **`.addOption(new Option(flags).hideHelp())`** — registers an option while omitting it from `--help` output; used for the internal `--preflight-only` flag (cli.ts:83-84).
- **`.action(async (localOpts, cmd) => { … })`** — async action handler; `cmd.args` supplies the raw pass-through tokens (cli.ts:103).
- **`this.opts()`** inside an action — returns the fully-typed options object; used in `buildWorkflowCommand`'s action via `this` context (workflow.ts:369).
- **`.addCommand(cmd)`** — mounts a pre-built `Command` instance as a subcommand (cli.ts:172, workflowCommand is built separately then added).
- **`.configureOutput({ writeErr, outputError })`** — overrides Commander's error output with coloured stderr (cli.ts:60-67).
- **`.addHelpText("after", text)`** — appends usage examples after the auto-generated help section (cli.ts:89, workflow.ts:152).
- **`.requiredOption(flags, description)`** — errors if the flag is absent (cli.ts:198, 244).
- **`.argument("<pos>", description)`** and **`"[optional]"`** — typed positional argument declarations (cli.ts:329, 363).
- **Option value coercion functions** — the second argument to `.option()` can be a `(v) => T` coercer that validates at parse-time and throws to produce Commander's formatted error (workflow.ts:323-338, 341-353).
- **Dynamic option mutation at runtime** — `workflowCommand` strips and re-adds `--<input>` options on `rebuildWorkflowCommand()` by directly mutating the internals array (`options`) and calling `removeAllListeners`; this is an intentional use of Commander's EventEmitter inheritance (workflow.ts:118-151).
- **`program.parseAsync()`** — async entry point, called once in `main()` (cli.ts:613).

For the pi-rewrite context: if tmux-based workflow dispatch is removed, the hidden `_orchestrator-entry`, `_cc-debounce`, `_claude-stop-hook`, `_claude-session-start-hook`, `_claude-ask-hook`, `_claude-inflight-hook`, and `_runtime-assets-smoke` Commander subcommands (cli.ts:304-448) are all candidates for removal or replacement. The core `chat`, `workflow`, `session`, `config`, `install`, `uninstall`, `update`, and `completions` subcommands are non-tmux surface.

**Where used:**  
- `packages/atomic/src/cli.ts:26` — `import { Command, Option } from "@commander-js/extra-typings"` — root program construction  
- `packages/atomic/src/commands/cli/workflow.ts:21` — workflow dispatcher Command  
- `packages/atomic/src/commands/cli/management-commands.ts:10` — session sub-command builder (type import only)

---

#### Claude Code CLI Hook Contracts (consumed via `@anthropic-ai/claude-agent-sdk` v0.2.132 + CLI hooks)
**Docs:** https://code.claude.com/docs/hooks (local copy: `docs/claude-code/cli/hooks.md`), local research: `research/web/2026-04-19-claude-code-hook-askuserquestion.md`  
**Relevant behaviour:**

The atomic CLI registers four Claude Code hook handlers as hidden Commander subcommands. Each reads a JSON payload from stdin and returns exit 0 (never exit 2 from these handlers — an error from a hook shows as a red annotation in Claude's transcript, which is worse than a silently-missed signal).

**Stop hook** (`_claude-stop-hook`, `@bastani/atomic-sdk/providers/claude-stop-hook`):
- Fires when Claude finishes responding (once per turn). No matcher support; always fires on every stop.
- Stdin payload: `{ session_id: string, transcript_path?: string, cwd?: string, stop_hook_active?: boolean, last_assistant_message?: string, hook_event_name: "Stop" }`.
- `stop_hook_active: true` is set on every subsequent turn after the hook has returned `{ decision: "block", reason }` at least once. The implementation still writes the idle-marker and polls for queued prompts on every call regardless of `stop_hook_active` (confirmed by test: `claude-stop-hook.test.ts:90`).
- To block Claude from stopping (i.e., to inject a follow-up turn): stdout must be `{ "decision": "block", "reason": "<next prompt text>" }` with exit 0.
- To allow Claude to stop: exit 0 with no stdout (or any stdout that does not parse as JSON with `decision: "block"`).
- The hook is registered in `.claude/settings.json` as a command hook on the `Stop` event.

**SessionStart hook** (`_claude-session-start-hook`, `packages/atomic/src/commands/cli/claude-session-start-hook.ts`):
- Fires when a new Claude session starts (matcher value `"startup"`). Also fires for `resume`, `clear`, `compact` if no matcher is specified.
- Stdin payload: `{ session_id: string, source?: "startup"|"resume"|"clear"|"compact", transcript_path?: string, cwd?: string, model?: string, hook_event_name: "SessionStart" }`.
- Decision control: stdout text is added as context for Claude. Return `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }` for structured context injection.
- The atomic implementation writes a `~/.atomic/claude-ready/<session_id>` file immediately on receipt so the workflow runtime can resolve spawn-readiness via `fs.watch` without polling the transcript file.

**AskUserQuestion hook (PreToolUse / PostToolUse / PostToolUseFailure)** (`_claude-ask-hook`, `packages/atomic/src/commands/cli/claude-ask-hook.ts`):
- Fires on every `PreToolUse` for the `AskUserQuestion` tool (matcher string: `"AskUserQuestion"`).
- PreToolUse stdin payload: `{ session_id: string, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: unknown, tool_use_id: string, cwd?: string, permission_mode?: string }`.
- PostToolUse stdin payload: same with `hook_event_name: "PostToolUse"` and `tool_response: unknown` replacing no error field.
- The atomic handler writes `~/.atomic/claude-hil/<session_id>` on PreToolUse (enter) and unlinks it on PostToolUse/PostToolUseFailure (exit), allowing the workflow runtime's `fs.watch` watcher to fire `onHIL(true|false)`.
- `_claude-ask-hook` is invoked as `atomic _claude-ask-hook enter` for PreToolUse and `atomic _claude-ask-hook exit` for both PostToolUse and PostToolUseFailure.

**Inflight / TeammateIdle hook** (`_claude-inflight-hook`, `@bastani/atomic-sdk/providers/claude-inflight-hook`):
- SubagentStart/SubagentStop: fires when a Claude subagent spawns or finishes. Payload includes `agent_id`, `agent_type`, `hook_event_name: "SubagentStart"|"SubagentStop"`, `session_id`.
- TeammateIdle: fires when an agent team teammate is about to go idle. Payload includes `hook_event_name: "TeammateIdle"`, `session_id`, `teammate_name`, `team_name`.
- Decision for TeammateIdle: exit code 2 keeps the teammate running (feeds stderr back as feedback). JSON `{ "continue": false, "stopReason": "..." }` stops the teammate entirely. The atomic handler resolves root session IDs via a `.session-roots` mapping file to correctly bucket nested subagent markers under the originating root session.

**Claude Agent SDK auth probe** (via `@anthropic-ai/claude-agent-sdk`):
- `auth.ts:100` — `query({ prompt: emptyStream(), options: { pathToClaudeCodeExecutable } })` is called then `q.initializationResult()` is awaited. The `account` object in the result (`{ email?, tokenSource?, apiKeySource? }`) determines authentication status.
- The SDK's `query()` function starts the Claude CLI subprocess on construction; `q.close()` tears it down.

**Where used:**  
- `packages/atomic/src/commands/cli/claude-stop-hook.test.ts:22` — imports `claudeStopHookCommand, claudeHookDirs` from `@bastani/atomic-sdk/providers/claude-stop-hook`  
- `packages/atomic/src/commands/cli/claude-ask-hook.ts:23` — uses `claudeHookDirs()` to resolve `hil` directory  
- `packages/atomic/src/commands/cli/claude-session-start-hook.ts:20` — uses `claudeHookDirs().ready`  
- `packages/atomic/src/commands/cli/claude-inflight-hook.test.ts:23` — imports inflight hook + stop hook helpers  
- `packages/atomic/src/services/system/auth.ts:100` — `import { query } from "@anthropic-ai/claude-agent-sdk"` for auth probe

---

#### @github/copilot-sdk (v0.3.0)
**Docs:** `docs/copilot-cli/sdk.md`, local research: `research/web/2026-04-14-copilot-sdk-hil-events.md`  
**Relevant behaviour:**

In `packages/atomic/src/`, the Copilot SDK is used in one place only: the auth probe in `auth.ts`.

```typescript
const { CopilotClient } = await import("@github/copilot-sdk");
const client = new CopilotClient(copilotSdkLaunchOptions());
await client.start();
const status = await client.getAuthStatus();
// status.isAuthenticated: boolean
// status.statusMessage: string
// status.login: string (GitHub login handle)
await client.stop();
```

`copilotSdkLaunchOptions()` is provided by `@bastani/atomic-sdk/providers/copilot` which resolves the Copilot CLI binary path and any launch configuration.

The full SDK surface (`CopilotSession`, `session.on()`, `user_input.requested`, `session.idle`, etc.) is consumed at the SDK layer (`@bastani/atomic-sdk`), not directly in `packages/atomic/src/`. In `packages/atomic/`, the SDK is only used for the thin auth-check pattern above.

The Copilot SDK v0.3.0 adds `zod ^4.3.6` as a dependency (lockfile), meaning zod v4 is in the dependency tree. The `CopilotClient` API is a JSON-RPC wrapper: `start()` launches the Copilot CLI subprocess, `getAuthStatus()` sends an `auth.status` RPC call, `stop()` terminates the subprocess. No command-path resolution or scm-disable flags are exercised in this package's own source.

**Where used:**  
- `packages/atomic/src/services/system/auth.ts:75` — `const { CopilotClient } = await import("@github/copilot-sdk")` — Copilot auth probe only

---

#### @clack/prompts (v1.3.0)
**Docs:** https://github.com/bombshell-dev/clack, https://www.npmjs.com/package/@clack/prompts  
**Relevant behaviour:**

Used for interactive CLI prompts in three files:

- `session.ts:10` — `import { select, multiselect, confirm, isCancel, cancel }` — drives the session picker (single select), multi-select kill picker, and yes/no confirmation for session kill. The `select` and `multiselect` return a `symbol` when the user cancels (Ctrl+C); `isCancel(value)` detects this sentinel.
- `update.ts:17` — `import { spinner, log, note }` — `spinner()` wraps the async update download with a visual spinner; `log.success()` / `log.error()` for styled terminal output; `note()` for boxed informational panels.
- `config.ts:11` — `import { log }` — `log.success()` / `log.error()` for styled config-set feedback.

The `select` API: `await select({ message: string, options: Array<{ value, label, hint? }> })` — returns the selected `value` or a cancellation symbol. The `multiselect` API is analogous with checkboxes. The `spinner` API: `const s = spinner(); s.start(msg); … s.stop(msg);`.

**Where used:**  
- `packages/atomic/src/commands/cli/session.ts:10` — session picker and kill confirmation  
- `packages/atomic/src/commands/cli/update.ts:17` — update download spinner and log output  
- `packages/atomic/src/commands/cli/config.ts:11` — config set success/error log output

---

## Summary

Three libraries are central to the `packages/atomic/` CLI surface for the pi-rewrite:

**Commander.js (`@commander-js/extra-typings` v14.0.0)** is the foundation for the entire CLI. The rewrite must preserve `enablePositionalOptions()` + `passThroughOptions()` on the `chat` command, the `{ isDefault: true }` flag on chat, the `{ hidden: true }` pattern for all internal `_`-prefixed subcommands, and the dynamic option mutation pattern on `workflowCommand` (strip then re-add per-input options on registry rebuild). Seven hidden subcommands (`_orchestrator-entry`, `_cc-debounce`, `_claude-stop-hook`, `_claude-session-start-hook`, `_claude-ask-hook`, `_claude-inflight-hook`, `_runtime-assets-smoke`) are all tmux/Claude-hook specific and are primary candidates for replacement or removal under the pi-coding-agent rewrite.

**Claude Code CLI hook contracts** define the stdin JSON payload shapes for `Stop` (`{ session_id, stop_hook_active?, last_assistant_message? }`), `SessionStart` (`{ session_id, source?, model? }`), `PreToolUse` for `AskUserQuestion` (`{ session_id, tool_name, tool_input, tool_use_id }`), and `SubagentStart/Stop` + `TeammateIdle` (`{ session_id, agent_id?, hook_event_name }`). The pi-coding-agent will need equivalent hook equivalents or a different inter-process signalling mechanism to replace the marker-file approach these hooks drive. The critical contracts: Stop hook blocks by returning `{ decision: "block", reason }` on stdout with exit 0; all other hooks must exit 0 unconditionally to avoid red transcript annotations.

**Copilot SDK (`@github/copilot-sdk` v0.3.0)** is narrowly used in `packages/atomic/` only for the `CopilotClient.getAuthStatus()` auth probe pattern. The broader session event and HIL API is consumed by the SDK layer, not by this package directly. If Copilot is dropped from the pi-rewrite scope, the only removal in `packages/atomic/src/` is the `checkCopilotAuth()` branch in `auth.ts`.

**`@clack/prompts` v1.3.0** is a lightweight interactive prompt library providing `select`, `multiselect`, `confirm`, `spinner`, `log`, and `note`. It is used only in session management, update, and config commands — none of which are fundamentally tied to tmux or agent backends, making it safe to retain as-is in the rewrite.
