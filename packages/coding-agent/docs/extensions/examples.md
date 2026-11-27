---
title: "Extension examples"
sidebarTitle: "Examples"
description: "Browse runnable TypeScript extensions shipped in Atomic for custom tools, commands, hooks, UI components, and providers."
---

Every example below lives in [examples/extensions/](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions). Clone the repository (or copy an individual file locally), then try any example for one session with `-e`:

```bash
git clone https://github.com/bastani-inc/atomic.git
atomic -e ./atomic/packages/coding-agent/examples/extensions/hello.ts
```

<Note>
**Interactive UI compatibility:** Default interactive CLI mode (`atomic`) runs extensions in an isolated worker process. Most examples work out of the box with `atomic -e`, while the UI examples marked **In-process TUI only** below rely on synchronous TUI callbacks, theme switching, or working-indicator APIs that require an embedded in-process TUI host via the SDK. See the [UI API compatibility matrix](/extensions/ui#ui-api-compatibility-matrix).
</Note>

## Tools

| Example | Description | Key APIs |
| --- | --- | --- |
| [`hello.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/hello.ts) | Minimal tool registration | `registerTool` |
| [`question.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/question.ts) | Width-wrapped single-question custom UI with option descriptions and typed answers | `registerTool`, `ui.custom` |
| [`questionnaire.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts) | Width-wrapped multi-step wizard with tab navigation and typed answers | `registerTool`, `ui.custom` |
| [`todo.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/todo.ts) | Stateful tool with session persistence | `registerTool`, `appendEntry`, `renderResult`, session events |
| [`dynamic-tools.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/dynamic-tools.ts) | Register tools after startup and during commands | `registerTool`, `session_start`, `registerCommand` |
| [`structured-output.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/structured-output.ts) | Opt-in schema-specific `structured_output` tool using the canonical factory | `createStructuredOutputTool`, `registerTool`, terminating tool results |
| [`truncated-tool.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/truncated-tool.ts) | Output truncation example | `registerTool`, `truncateHead` |
| [`tool-override.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tool-override.ts) | Override built-in `read` tool behavior | `registerTool` (same name as built-in) |
| [`built-in-tool-renderer.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/built-in-tool-renderer.ts) | Replace rendering of built-in tools (`read`, `bash`, `edit`, `write`) while delegating execution | `registerTool`, `create*ToolDefinition`, `renderShell: "self"` |
| [`minimal-mode.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/minimal-mode.ts) | Minimal collapsed rendering for built-in tools toggled with `Ctrl+O` | `registerTool`, `create*ToolDefinition`, `renderResult` |

## Commands

| Example | Description | Key APIs |
| --- | --- | --- |
| [`commands.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/commands.ts) | `/commands` slash command that lists and filters all registered commands by source | `registerCommand`, `getCommands`, `getArgumentCompletions` |
| [`pirate.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/pirate.ts) | Modify the system prompt per turn | `registerCommand`, `before_agent_start` |
| [`summarize.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/summarize.ts) | Conversation summary command | `registerCommand`, `ui.custom` |
| [`handoff.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/handoff.ts) | Cross-provider model handoff | `registerCommand`, `ui.editor`, `ui.custom` |
| [`qna.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/qna.ts) | Q&A helper with custom UI | `registerCommand`, `ui.custom`, `setEditorText` |
| [`send-user-message.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/send-user-message.ts) | Inject user messages from a command | `registerCommand`, `sendUserMessage` |
| [`reload-runtime.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/reload-runtime.ts) | Reload command and model tool handoff | `registerCommand`, `ctx.reload()`, `sendUserMessage` |
| [`shutdown-command.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/shutdown-command.ts) | Graceful shutdown command | `registerCommand`, `ctx.shutdown()` |

## Events and gates

| Example | Description | Key APIs |
| --- | --- | --- |
| [`permission-gate.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts) | Prompt before dangerous bash commands | `on("tool_call")`, `ui.confirm` |
| [`protected-paths.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/protected-paths.ts) | Block writes to protected paths | `on("tool_call")` |
| [`confirm-destructive.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/confirm-destructive.ts) | Confirm session switches and forks | `on("session_before_switch")`, `on("session_before_fork")` |
| [`dirty-repo-guard.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/dirty-repo-guard.ts) | Warn when switching sessions in a dirty git repo | `on("session_before_*")`, `exec` |
| [`input-transform.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/input-transform.ts) | Transform user input before the model sees it | `on("input")` |
| [`input-transform-streaming.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/input-transform-streaming.ts) | Streaming-aware input transformation | `on("input")`, `streamingBehavior` |
| [`project-trust.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/project-trust.ts) | Decide or defer project trust from a user or CLI extension | `on("project_trust")`, trust UI |
| [`dynamic-resources/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/dynamic-resources) | Dynamically contribute skills, prompt templates, and themes at startup | `on("resources_discover")` |
| [`model-status.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/model-status.ts) | Display active model changes in the status bar | `on("model_select")`, `setStatus` |
| [`provider-payload.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/provider-payload.ts) | Inspect outgoing payloads and provider response headers | `on("before_provider_request")`, `on("after_provider_response")` |
| [`system-prompt-header.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/system-prompt-header.ts) | Display system prompt summary information | `on("agent_start")`, `getSystemPrompt` |
| [`claude-rules.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/claude-rules.ts) | Load rules from files and inject them into turns | `on("session_start")`, `on("before_agent_start")` |
| [`prompt-customizer.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/prompt-customizer.ts) | Add context-aware tool guidance using `systemPromptOptions` | `on("before_agent_start")`, `BuildSystemPromptOptions` |
| [`file-trigger.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/file-trigger.ts) | File watcher that sends messages into the session | `sendMessage` |

## Compaction and sessions

| Example | Description | Key APIs |
| --- | --- | --- |
| [`custom-compaction.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-compaction.ts) | Replace compacted context with custom text without calling a model | `on("session_before_compact")`, `on("session_compact")` |
| [`trigger-compact.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/trigger-compact.ts) | Trigger compaction at a token threshold or via `/trigger-compact [instructions]` | `ctx.compact()` |
| [`git-checkpoint.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/git-checkpoint.ts) | Create git stashes on turns for rollback | `on("turn_start")`, `on("session_before_fork")`, `exec` |
| [`git-merge-and-resolve.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/git-merge-and-resolve.ts) | Auto-fetch and merge upstream after each turn, sending conflict blocks to the agent | `on("agent_end")`, `exec`, `sendMessage` |
| [`auto-commit-on-exit.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/auto-commit-on-exit.ts) | Commit working tree changes on session shutdown | `on("session_shutdown")`, `exec` |

## UI components

<Warning>
Examples marked **In-process TUI only** do not take effect in default interactive CLI mode (`atomic -e ...`) because they call TUI-process APIs that are no-ops or emit warnings in the isolated worker. Load them in an embedded in-process TUI session via the SDK instead.
</Warning>

| Example | Runtime | Description | Key APIs |
| --- | --- | --- | --- |
| [`status-line.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/status-line.ts) | Default CLI | Footer status indicator | `setStatus`, session events |
| [`titlebar-spinner.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/titlebar-spinner.ts) | Default CLI | Animate a braille spinner in the terminal title while the agent works | `setTitle`, `on("agent_start")`, `on("agent_end")` |
| [`widget-placement.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/widget-placement.ts) | Default CLI | Place widgets above or below the editor | `setWidget` |
| [`overlay-test.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/overlay-test.ts) | Default CLI | Overlay positioning example | `ui.custom` with overlay options |
| [`overlay-qa-tests.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/overlay-qa-tests.ts) | Default CLI | Overlay positioning, visibility, and resize suite | `ui.custom`, all overlay options |
| [`notify.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/notify.ts) | Default CLI | Simple notification examples | `ui.notify` |
| [`timed-confirm.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/timed-confirm.ts) | Default CLI | Confirmation dialogs with countdown timeout and abort signal | `ui.confirm` with `timeout` and `signal` |
| [`rpc-demo.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/rpc-demo.ts) | RPC / Default CLI | Exercise all RPC-supported UI dialogs, status, widgets, title, and editor prefill | `select`, `confirm`, `input`, `editor`, `setStatus`, `setWidget`, `setTitle`, `setEditorText` |
| [`working-indicator.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/working-indicator.ts) | **In-process TUI only** | Customize the streaming working indicator | `setWorkingIndicator`, `registerCommand` |
| [`working-message-test.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/working-message-test.ts) | **In-process TUI only** | Keep a custom working message and indicator across turns | `setWorkingMessage`, `setWorkingIndicator`, `on("session_start")` |
| [`hidden-thinking-label.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/hidden-thinking-label.ts) | **In-process TUI only** | Customize the placeholder label for collapsed thinking blocks via `/thinking-label` | `setHiddenThinkingLabel`, `registerCommand` |
| [`github-issue-autocomplete.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/github-issue-autocomplete.ts) | **In-process TUI only** | Layer `#1234` GitHub issue completions onto built-in autocomplete | `addAutocompleteProvider`, `on("session_start")`, `exec` |
| [`custom-footer.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts) | **In-process TUI only** | Replace the footer component | `registerCommand`, `setFooter` |
| [`custom-header.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-header.ts) | **In-process TUI only** | Replace the startup header component | `on("session_start")`, `setHeader` |
| [`border-status-editor.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/border-status-editor.ts) | **In-process TUI only** | Custom editor that draws aligned left and right status labels in its border | `setEditorComponent`, `setWorkingVisible`, `setFooter`, `CustomEditor` |
| [`modal-editor.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/modal-editor.ts) | **In-process TUI only** | Vim-style modal editor | `setEditorComponent`, `CustomEditor` |
| [`rainbow-editor.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/rainbow-editor.ts) | **In-process TUI only** | Custom editor border styling | `setEditorComponent` |
| [`mac-system-theme.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/mac-system-theme.ts) | **In-process TUI only** | Switch theme based on macOS appearance | `setTheme`, `exec` |

## Complete extensions

| Example | Description | Key APIs |
| --- | --- | --- |
| [`plan-mode/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/plan-mode) | Read-only planning and step-tracked execution workflow (see its [README](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/plan-mode/README.md)) | Lifecycle events, `registerCommand`, `registerShortcut`, `registerFlag`, `setStatus`, `setWidget`, `sendMessage`, `setActiveTools` |
| [`preset.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/preset.ts) | Saveable presets for model, active tools, and thinking level | `registerCommand`, `registerShortcut`, `registerFlag`, `setModel`, `setActiveTools`, `setThinkingLevel`, `appendEntry` |
| [`tools.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tools.ts) | Interactive menu to toggle tools on and off | `registerCommand`, `setActiveTools`, `SettingsList`, session events |

## Remote execution and sandboxes

| Example | Description | Key APIs |
| --- | --- | --- |
| [`ssh.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/ssh.ts) | Run built-in tools and `!` commands over SSH | `registerFlag`, `on("user_bash")`, `on("before_agent_start")`, tool operations |
| [`interactive-shell.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/interactive-shell.ts) | Persistent shell session for user bash commands | `on("user_bash")` |
| [`gondolin/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/gondolin) | Route built-in tools and `!` commands into a Gondolin micro-VM | Tool operations, built-in tool overrides, `on("user_bash")` |
| [`subagent/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/subagent) | Spawn child agents from a custom tool | `registerTool`, `exec` |

## Games

| Example | Description | Key APIs |
| --- | --- | --- |
| [`snake.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/snake.ts) | Snake game in custom UI | `registerCommand`, `ui.custom`, keyboard handling |
| [`space-invaders.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/space-invaders.ts) | Space Invaders game in custom UI | `registerCommand`, `ui.custom` |
| [`doom-overlay/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/doom-overlay) | Doom inside an overlay component | `ui.custom` with overlay |
| [`tic-tac-toe.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tic-tac-toe.ts) | Interactive Tic-Tac-Toe demonstrating `executionMode: "sequential"` on stateful sibling tool calls | `registerTool` (`executionMode: "sequential"`), `registerCommand`, `ui.custom` |

## Providers

| Example | Description | Key APIs |
| --- | --- | --- |
| [`custom-provider-anthropic/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-anthropic) | Custom Anthropic proxy provider | `registerProvider` |
| [`custom-provider-gitlab-duo/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo) | GitLab Duo provider with OAuth login | `registerProvider` with OAuth |
| [`provider-accounts.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/provider-accounts.ts) | Register multiple numbered OpenAI account aliases (`openai-1` through `openai-7`) | `registerProviderAlias` |

## Messages, metadata, and utilities

| Example | Description | Key APIs |
| --- | --- | --- |
| [`message-renderer.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/message-renderer.ts) | Custom renderer for extension messages | `registerMessageRenderer`, `sendMessage` |
| [`debug-provider.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/debug-provider.ts) | Capture raw provider stream events per assistant message with `/debug-provider` | `on("provider_stream_event")`, `registerEntryRenderer`, `appendEntry` |
| [`event-bus.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/event-bus.ts) | Inter-extension messaging | `atomic.events` |
| [`session-name.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/session-name.ts) | Name sessions for the session picker | `setSessionName`, `getSessionName` |
| [`bookmark.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/bookmark.ts) | Bookmark entries for `/tree` | `setLabel` |
| [`inline-bash.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/inline-bash.ts) | Expand inline bash expressions inside tool calls | `on("tool_call")` |
| [`bash-spawn-hook.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/bash-spawn-hook.ts) | Customize bash command, `cwd`, and `env` before spawn | `createBashTool`, `spawnHook` |
| [`with-deps/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/with-deps) | Extension package with third-party npm dependencies | Package layout with `package.json` |

## Next steps

Use the [Extension API reference](/extensions/api-reference) to check the context properties and method contracts used by these examples.
