---
title: "Extension examples"
sidebarTitle: "Examples"
description: "Browse runnable TypeScript extensions shipped in Atomic for custom tools, commands, hooks, UI components, and providers."
---

Every example below lives in [examples/extensions/](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions). Try any example directly for one session with `-e`:

```bash
atomic -e /path/to/atomic/packages/coding-agent/examples/extensions/hello.ts
```

## Tools

| Example | Description | Key APIs |
| --- | --- | --- |
| `hello.ts` | Minimal tool registration | `registerTool` |
| `question.ts` | Width-wrapped single-question custom UI with option descriptions and typed answers | `registerTool`, `ui.custom` |
| `questionnaire.ts` | Width-wrapped multi-step wizard with tab navigation and typed answers | `registerTool`, `ui.custom` |
| `todo.ts` | Stateful tool with session persistence | `registerTool`, `appendEntry`, `renderResult`, session events |
| `dynamic-tools.ts` | Register tools after startup and during commands | `registerTool`, `session_start`, `registerCommand` |
| `structured-output.ts` | Opt-in schema-specific `structured_output` tool using the canonical factory | `createStructuredOutputTool`, `registerTool`, terminating tool results |
| `truncated-tool.ts` | Output truncation example | `registerTool`, `truncateHead` |
| `tool-override.ts` | Override built-in `read` tool behavior | `registerTool` (same name as built-in) |
| `built-in-tool-renderer.ts` | Replace rendering of built-in tools (`read`, `bash`, `edit`, `write`) while delegating execution | `registerTool`, `create*ToolDefinition`, `renderShell: "self"` |
| `minimal-mode.ts` | Minimal collapsed rendering for built-in tools toggled with `Ctrl+O` | `registerTool`, `create*ToolDefinition`, `renderResult` |

## Commands

| Example | Description | Key APIs |
| --- | --- | --- |
| `commands.ts` | `/commands` slash command that lists and filters all registered commands by source | `registerCommand`, `getCommands`, `getArgumentCompletions` |
| `pirate.ts` | Modify the system prompt per turn | `registerCommand`, `before_agent_start` |
| `summarize.ts` | Conversation summary command | `registerCommand`, `ui.custom` |
| `handoff.ts` | Cross-provider model handoff | `registerCommand`, `ui.editor`, `ui.custom` |
| `qna.ts` | Q&A helper with custom UI | `registerCommand`, `ui.custom`, `setEditorText` |
| `send-user-message.ts` | Inject user messages from a command | `registerCommand`, `sendUserMessage` |
| `reload-runtime.ts` | Reload command and model tool handoff | `registerCommand`, `ctx.reload()`, `sendUserMessage` |
| `shutdown-command.ts` | Graceful shutdown command | `registerCommand`, `ctx.shutdown()` |

## Events and gates

| Example | Description | Key APIs |
| --- | --- | --- |
| `permission-gate.ts` | Prompt before dangerous bash commands | `on("tool_call")`, `ui.confirm` |
| `protected-paths.ts` | Block writes to protected paths | `on("tool_call")` |
| `confirm-destructive.ts` | Confirm session switches and forks | `on("session_before_switch")`, `on("session_before_fork")` |
| `dirty-repo-guard.ts` | Warn when switching sessions in a dirty git repo | `on("session_before_*")`, `exec` |
| `input-transform.ts` | Transform user input before the model sees it | `on("input")` |
| `input-transform-streaming.ts` | Streaming-aware input transformation | `on("input")`, `streamingBehavior` |
| `project-trust.ts` | Decide or defer project trust from a user or CLI extension | `on("project_trust")`, trust UI |
| `dynamic-resources/` | Dynamically contribute skills, prompt templates, and themes at startup | `on("resources_discover")` |
| `model-status.ts` | Display active model changes in the status bar | `on("model_select")`, `setStatus` |
| `provider-payload.ts` | Inspect outgoing payloads and provider response headers | `on("before_provider_request")`, `on("after_provider_response")` |
| `system-prompt-header.ts` | Display system prompt summary information | `on("agent_start")`, `getSystemPrompt` |
| `claude-rules.ts` | Load rules from files and inject them into turns | `on("session_start")`, `on("before_agent_start")` |
| `prompt-customizer.ts` | Add context-aware tool guidance using `systemPromptOptions` | `on("before_agent_start")`, `BuildSystemPromptOptions` |
| `file-trigger.ts` | File watcher that sends messages into the session | `sendMessage` |

## Compaction and sessions

| Example | Description | Key APIs |
| --- | --- | --- |
| `custom-compaction.ts` | Replace compacted context with custom text without calling a model | `on("session_before_compact")`, `on("session_compact")` |
| `trigger-compact.ts` | Trigger compaction at a token threshold or via `/trigger-compact [instructions]` | `ctx.compact()` |
| `git-checkpoint.ts` | Create git stashes on turns for rollback | `on("turn_start")`, `on("session_before_fork")`, `exec` |
| `git-merge-and-resolve.ts` | Auto-fetch and merge upstream after each turn, sending conflict blocks to the agent | `on("agent_end")`, `exec`, `sendMessage` |
| `auto-commit-on-exit.ts` | Commit working tree changes on session shutdown | `on("session_shutdown")`, `exec` |

## UI components

| Example | Description | Key APIs |
| --- | --- | --- |
| `status-line.ts` | Footer status indicator | `setStatus`, session events |
| `working-indicator.ts` | Customize the streaming working indicator | `setWorkingIndicator`, `registerCommand` |
| `working-message-test.ts` | Keep a custom working message and indicator across turns | `setWorkingMessage`, `setWorkingIndicator`, `on("session_start")` |
| `hidden-thinking-label.ts` | Customize the placeholder label for collapsed thinking blocks via `/thinking-label` | `setHiddenThinkingLabel`, `registerCommand` |
| `titlebar-spinner.ts` | Animate a braille spinner in the terminal title while the agent works | `setTitle`, `on("agent_start")`, `on("agent_end")` |
| `github-issue-autocomplete.ts` | Layer `#1234` GitHub issue completions onto built-in autocomplete | `addAutocompleteProvider`, `on("session_start")`, `exec` |
| `custom-footer.ts` | Replace the footer component | `registerCommand`, `setFooter` |
| `custom-header.ts` | Replace the startup header component | `on("session_start")`, `setHeader` |
| `border-status-editor.ts` | Custom editor that draws aligned left and right status labels in its border | `setEditorComponent`, `CustomEditor` |
| `modal-editor.ts` | Vim-style modal editor | `setEditorComponent`, `CustomEditor` |
| `rainbow-editor.ts` | Custom editor border styling | `setEditorComponent` |
| `widget-placement.ts` | Place widgets above or below the editor | `setWidget` |
| `overlay-test.ts` | Overlay positioning example | `ui.custom` with overlay options |
| `overlay-qa-tests.ts` | Overlay positioning, visibility, and resize suite | `ui.custom`, all overlay options |
| `notify.ts` | Simple notification examples | `ui.notify` |
| `timed-confirm.ts` | Confirmation dialogs with countdown timeout and abort signal | `ui.confirm` with `timeout` and `signal` |
| `mac-system-theme.ts` | Switch theme based on macOS appearance | `setTheme`, `exec` |
| `rpc-demo.ts` | Exercise all RPC-supported UI dialogs, status, widgets, title, and editor prefill | `select`, `confirm`, `input`, `editor`, `setStatus`, `setWidget`, `setTitle`, `setEditorText` |

## Complete extensions

| Example | Description | Key APIs |
| --- | --- | --- |
| `plan-mode/` | Full plan mode workflow | Lifecycle events, `registerCommand`, `registerShortcut`, `registerFlag`, `setStatus`, `setWidget`, `sendMessage`, `setActiveTools` |
| `preset.ts` | Saveable presets for model, active tools, and thinking level | `registerCommand`, `registerShortcut`, `registerFlag`, `setModel`, `setActiveTools`, `setThinkingLevel`, `appendEntry` |
| `tools.ts` | Interactive menu to toggle tools on and off | `registerCommand`, `setActiveTools`, `SettingsList`, session events |

### Plan-mode completion

In `plan-mode/`, write `[DONE:1]` to mark an individual step complete, including inside thinking blocks. To finish the entire plan without per-step markers, send a standalone final visible reply such as `All steps are complete.` or `The plan is done.`. Hidden thinking does not count toward that whole-plan reply, and negated summaries, questions, conditional statements, or completion phrases embedded in longer prose leave unfinished steps active.

## Remote execution and sandboxes

| Example | Description | Key APIs |
| --- | --- | --- |
| `ssh.ts` | Run built-in tools and `!` commands over SSH | `registerFlag`, `on("user_bash")`, `on("before_agent_start")`, tool operations |
| `interactive-shell.ts` | Persistent shell session for user bash commands | `on("user_bash")` |
| `gondolin/` | Route built-in tools and `!` commands into a Gondolin micro-VM | Tool operations, built-in tool overrides, `on("user_bash")` |
| `subagent/` | Spawn child agents from a custom tool | `registerTool`, `exec` |

## Games

| Example | Description | Key APIs |
| --- | --- | --- |
| `snake.ts` | Snake game in custom UI | `registerCommand`, `ui.custom`, keyboard handling |
| `space-invaders.ts` | Space Invaders game in custom UI | `registerCommand`, `ui.custom` |
| `doom-overlay/` | Doom inside an overlay component | `ui.custom` with overlay |
| `tic-tac-toe.ts` | Interactive Tic-Tac-Toe demonstrating `executionMode: "sequential"` on stateful sibling tool calls | `registerTool` (`executionMode: "sequential"`), `registerCommand`, `ui.custom` |

## Providers

| Example | Description | Key APIs |
| --- | --- | --- |
| `custom-provider-anthropic/` | Custom Anthropic proxy provider | `registerProvider` |
| `custom-provider-gitlab-duo/` | GitLab Duo provider with OAuth login | `registerProvider` with OAuth |
| `provider-accounts.ts` | Register multiple numbered OpenAI account aliases (`openai-1` through `openai-7`) | `registerProviderAlias` |

## Messages, metadata, and utilities

| Example | Description | Key APIs |
| --- | --- | --- |
| `message-renderer.ts` | Custom renderer for extension messages | `registerMessageRenderer`, `sendMessage` |
| `debug-provider.ts` | Capture raw provider stream events per assistant message with `/debug-provider` | `on("provider_stream_event")`, `registerEntryRenderer`, `appendEntry` |
| `event-bus.ts` | Inter-extension messaging | `atomic.events` |
| `session-name.ts` | Name sessions for the session picker | `setSessionName`, `getSessionName` |
| `bookmark.ts` | Bookmark entries for `/tree` | `setLabel` |
| `inline-bash.ts` | Expand inline bash expressions inside tool calls | `on("tool_call")` |
| `bash-spawn-hook.ts` | Customize bash command, `cwd`, and `env` before spawn | `createBashTool`, `spawnHook` |
| `with-deps/` | Extension package with third-party npm dependencies | Package layout with `package.json` |

## Next steps

Use the [Extension API reference](/extensions/api-reference) to check the context properties and method contracts used by these examples.
