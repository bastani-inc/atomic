---
title: "Herdr integration"
sidebarTitle: "Herdr"
description: "Use Atomic's built-in Herdr status indicators, session restore, troubleshooting steps, and privacy controls."
---

Atomic reports its status to [Herdr](https://herdr.dev) automatically when you start it inside a Herdr pane. No extra extension is needed, and the pane identifies the agent as `atomic`.

For interactive terminal automation, pane isolation, and fallbacks, see [Computer use](/computer-use#terminal-automation-with-herdr). To let Atomic inspect or control Herdr panes, tabs, workspaces, worktrees, and commands from inside a Herdr pane (`HERDR_ENV=1`), invoke the bundled `/skill:herdr` skill ([Bundled skills](/skills#bundled-skills)). This page covers Atomic's built-in status and session-restore integration.

## Setup

Use Herdr 0.8.2 or newer and launch Atomic inside a Herdr pane. Herdr sets the pane environment variables automatically, so no manual configuration is required.

- Status reporting runs only in interactive Atomic sessions. It stays off outside Herdr and in print, JSON, and RPC modes.
- Reporting stays active even when you pass `--no-extensions` (`-ne`); only setting `herdr.enabled: false` turns it off.
- Inside Herdr panes (`TERM_PROGRAM=herdr`), Atomic automatically enables Kitty inline images and clickable OSC 8 hyperlinks.

## Status indicators

| Status | Meaning |
| --- | --- |
| Working | Atomic, a subagent, or a background shell command is running. |
| Blocked | Work needs your input or approval, and no independent background work is running. |
| Idle / Done | No work is running. Herdr may show a newly finished turn as Done. |

Quiet periods such as provider waits, retries, and tool execution still count as Working. Active background work keeps the pane Working after Atomic finishes its response.

All Blocked states report the fixed message `"Waiting for approval"`, even for non-approval questions or prompts. Unlike [OSC 7501 program status](/terminal-setup#program-status), Herdr also reports [project trust](/security) prompts (`/trust` or resumed-folder trust) as Blocked when no background tasks are running.

Opening [`/tasks`](/background-tasks) or [`/agents`](/subagents) does not mark the pane Blocked, and neither does a [subagent](/subagents) asking its supervisor for guidance. Check `/tasks` for pass or fail outcomes; the pane status shows activity, not a verdict.

## Restore after a Herdr restart

With Herdr 0.9.2 or newer, Atomic also reports a resume command so Herdr can reopen the same conversation in the pane after a Herdr server restart ([Sessions](/sessions), [Storage](/storage)). Atomic does not restart panes itself. To disable automatic agent restore in Herdr, set `[session] resume_agents_on_restore = false` in Herdr's config.

- **Local SQLite sessions (default):** Atomic reports `atomic --session-store <path> --session <id>` (plus `--session-prefix <prefix>` when a table prefix is configured).
- **JSONL directory sessions:** Atomic reports `atomic --session-dir <dir> --session <id>`. Session IDs ending in `.jsonl` still use `--session <id>`.
- **Other persisted stores (such as remote libSQL or PostgreSQL):** Atomic reports `atomic --session <id>`.
- **Switching sessions:** Running `/new`, `/resume`, `/fork`, or `/clone` updates the pane to the new session's ID and resume command.
- **Unsaved sessions:** Sessions started with `--no-session` report status without a resume command. For a brand-new persisted session, Atomic reports the resume command right away, though reopening succeeds only after the session's first entry is saved to storage.
- **Quit vs. stop signals:** Quitting Atomic yourself (`Ctrl+D`, `Ctrl+C` twice, `/quit`, or `/exit`) clears the resume command so Herdr does not reopen the pane. When Herdr or the OS stops Atomic with `SIGTERM`, `SIGHUP`, or a Windows console close or sign-out, the resume command stays registered for restore.
- **Resume-command safety limits:** If the resume command has more than 64 arguments, exceeds 8 KiB, or contains a single quote (`'`) or control character in any argument (such as a session path), Atomic omits the resume command while continuing to report live status.
- **Older Herdr versions:** Herdr 0.8.2 through 0.9.1 show status indicators without session restore.

## Disable the integration

Add this to `~/.atomic/agent/settings.json` or trusted project `.atomic/settings.json`, then run `/reload` or restart Atomic:

```json
{
  "herdr": {
    "enabled": false
  }
}
```

Reporting is enabled by default, and disabling it also disables resume-command reporting. Running `/reload` after setting `herdr.enabled` to `false` cleanly releases the pane registration and clears the resume command. Project settings follow the normal [settings precedence](/settings).

## Troubleshooting

If Atomic does not appear in Herdr:

- Verify that you launched Atomic inside a Herdr pane rather than an external terminal.
- Check that Herdr is running and `herdr.enabled` is not set to `false`.
- Inside a Herdr pane, Atomic's built-in reporter supersedes Herdr's legacy file integration and skips both `herdr-agent-state.ts` and `herdr-agent-state.js` (usually in `~/.pi/agent/extensions`). Outside a Herdr pane, those files load normally.
- If you installed a separate `herdr-atomic-reporter` extension, remove or disable one of the two reporters to prevent flickering status updates.

Custom launchers must supply `HERDR_ENV=1` along with non-empty `HERDR_BIN_PATH`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` values. See [Herdr's integration guide](https://herdr.dev/docs/integrations/#integrate-your-own-agent).

Each `herdr` CLI status call times out after 5 seconds (with a 64 KiB output buffer). Reporting errors never interrupt the agent, and each error category logs to stderr at most once per session. Reloading or compacting a session keeps Atomic registered while enabled; if status stops updating, check Herdr's connection and run `/reload` (Atomic does not poll to reconnect).

## Privacy

Atomic sends only status, generic attention messages, the parent session ID and local session path, and the resume command (`atomic`, `--session <id>`, and any `--session-store`, `--session-prefix`, or `--session-dir` flags) to the local Herdr server. Atomic never sends prompt text, tool arguments, or transcripts.
