# Herdr

Atomic reports its status to [Herdr](https://herdr.dev) automatically when you launch it in a Herdr pane. No extra extension is required. The pane identifies the agent as `atomic`.

For interactive terminal automation, pane isolation, and tool fallbacks, see [Computer use](/computer-use#terminal-automation-with-herdr). This page covers Atomic's automatic status integration.

## Setup

Use Herdr 0.8.2 or newer and launch Atomic inside it. Herdr supplies the pane connection settings automatically; you do not need to configure them yourself.

The integration runs only for interactive Atomic sessions. It stays inactive outside Herdr and in print, JSON, or RPC mode.

## Status indicators

| Status | Meaning |
|---|---|
| Working | Atomic, a workflow, a subagent, or a background shell command is still running. |
| Blocked | Work needs your input or approval, and no independent work is running. |
| Idle / Done | No work is running. Herdr may show a newly completed turn as Done. |

Quiet periods such as provider waits, retries, and tool execution still count as working. Background work keeps the pane working after Atomic finishes its response.

Opening `/tasks`, `/agents`, or `/workflow connect` does not count as an approval request. Neither does a subagent asking its supervisor for guidance. Actual permission requests and workflow budget approvals can show Blocked.

A failed workflow can remain marked blocked in Atomic after its execution ends, while the pane returns to Idle. Check the workflow details for its result; the pane indicator is not a success or failure verdict. Sending a message acknowledges existing workflow attention for the indicator, but does not resume the workflow or approve a budget increase.

## Disable the integration

Add this to `~/.atomic/agent/settings.json` or trusted project `.atomic/settings.json`, then reload or restart Atomic:

```json
{
  "herdr": {
    "enabled": false
  }
}
```

Reporting is enabled by default. Project settings follow the normal [settings precedence](/settings).

## Troubleshooting

If Atomic does not appear in Herdr:

- Make sure you launched Atomic inside a Herdr pane, rather than in a separate terminal.
- Check that Herdr is running and reporting has not been disabled in Atomic's settings.
- Inside a Herdr pane, Atomic reports the pane itself and skips Herdr's installed Pi integration (`herdr-agent-state.ts`, usually in `~/.pi/agent/extensions`), so you do not need to disable it. Outside a Herdr pane that file still loads normally.
- A `herdr-atomic-reporter` extension, if you installed one, reports the pane in addition to Atomic's built-in integration. Disable one of the two if the pane's status flickers.

For custom launchers, Herdr must provide `HERDR_ENV=1` and nonempty `HERDR_BIN_PATH`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` values. See [Herdr's integration guide](https://herdr.dev/docs/integrations/#integrate-your-own-agent).

Reloading or compacting a session should not remove Atomic from the pane. If status stops updating, check Herdr's connection and reload Atomic. Reporting failures do not stop your agent or workflow, and reconnect polling is not automatic.

## Privacy

Atomic sends status, generic attention messages, and the parent session's ID and local session path to the local Herdr server. It does not send prompt text, tool arguments, transcripts, or workflow output. Session reporting alone does not guarantee automatic session restoration in Herdr.
