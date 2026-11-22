---
title: "Herdr"
description: "Automatic status reporting and session restore when running Atomic inside Herdr panes."
---

# Herdr

Atomic reports its status to [Herdr](https://herdr.dev) automatically when you start it inside a Herdr pane. No extra extension is needed, and the pane identifies the agent as `atomic`.

For interactive terminal automation, pane isolation, and fallbacks, see [Computer use](/computer-use#terminal-automation-with-herdr). This page covers Atomic's built-in status and restore integration.

## Setup

Use Herdr 0.8.2 or newer and launch Atomic inside a Herdr pane. Herdr sets the pane environment variables automatically, so no manual setup is required.

Status reporting runs only in interactive Atomic sessions. It stays off outside Herdr and in print, JSON, and RPC modes.

## Status indicators

| Status | Meaning |
| --- | --- |
| Working | Atomic, a subagent, or a background shell command is running. |
| Blocked | Work needs your input or approval, and no independent background work is running. |
| Idle / Done | No work is running. Herdr may show a newly finished turn as Done. |

Quiet periods such as provider waits, retries, and tool execution still count as Working. Active background work keeps the pane Working after Atomic finishes its response.

Opening `/tasks` or `/agents` does not mark the pane Blocked, and neither does a subagent asking its supervisor for guidance. A permission prompt can show Blocked. Check `/tasks` for the outcome; the pane status is not a pass or fail verdict.

## Restore after a Herdr restart

With Herdr 0.9.2 or newer, Atomic also reports a resume command so Herdr can reopen the same conversation in the pane after a Herdr server restart. Atomic does not restart panes itself. To disable automatic agent restore in Herdr, set `[session] resume_agents_on_restore = false` in Herdr's config.

- **Local SQLite sessions (default):** Atomic reports `atomic --session-store <path> --session <id>` (plus `--session-prefix <prefix>` when a table prefix is configured).
- **JSONL directory sessions:** Atomic reports `atomic --session-dir <dir> --session <id>`. Session IDs ending in `.jsonl` still use `--session <id>`.
- **Other persisted stores (such as remote libSQL or PostgreSQL):** Atomic reports `atomic --session <id>`.
- **Unsaved sessions:** Sessions started with `--no-session` are reported without a resume command. A new persisted session can be reopened only after it has been saved.
- **Quit vs. stop signals:** Quitting Atomic yourself (`Ctrl+D`, `Ctrl+C` twice, or `/quit`) clears the resume command so Herdr does not reopen the pane. When Herdr or the OS stops Atomic with `SIGTERM` or `SIGHUP`, the command stays registered for restore.
- **Older Herdr versions:** Herdr 0.8.2 through 0.9.1 show status indicators without session restore.

## Disable the integration

Add this to `~/.atomic/agent/settings.json` or trusted project `.atomic/settings.json`, then reload or restart Atomic:

```json
{
  "herdr": {
    "enabled": false
  }
}
```

Reporting is enabled by default, and disabling it also disables resume-command reporting. Project settings follow the normal [settings precedence](/settings).

## Troubleshooting

If Atomic does not appear in Herdr:

- Verify that you launched Atomic inside a Herdr pane rather than an external terminal.
- Check that Herdr is running and `herdr.enabled` is not set to `false`.
- Inside a Herdr pane, Atomic reports the pane itself and skips Herdr's legacy file integration (`herdr-agent-state.ts`, usually in `~/.pi/agent/extensions`). Outside a Herdr pane, that file loads normally.
- If you installed a separate `herdr-atomic-reporter` extension, disable one of the two reporters to prevent flickering status updates.

Custom launchers must supply `HERDR_ENV=1` along with nonempty `HERDR_BIN_PATH`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` values. See [Herdr's integration guide](https://herdr.dev/docs/integrations/#integrate-your-own-agent).

Reloading or compacting a session keeps Atomic registered in the pane. If status stops updating, check Herdr's connection and reload Atomic. Reporting failures do not interrupt the agent, and Atomic does not automatically poll to reconnect.

## Privacy

Atomic sends only status, generic attention messages, the parent session ID and local session path, and the resume command (`atomic`, `--session <id>`, and any `--session-store`, `--session-prefix`, or `--session-dir` flags) to the local Herdr server. Atomic never sends prompt text, tool arguments, or transcripts.
