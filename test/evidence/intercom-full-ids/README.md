# Intercom full-ID live evidence

This evidence was captured on 2026-08-13 from the clean checkout at commit
`ddab8bf05541044e3dc3b0659e6cff3a2115f1bd` after building the local package.
The captures are from a throwaway broker, not the developer's live broker.

## Isolation and startup

The throwaway agent directory was `/tmp/atomic-intercom-full-ids-e2e.TDaYLw/agent`.
Both Atomic panes used the same `ATOMIC_CODING_AGENT_DIR` value; the probe pane did
as well. The exact startup command was:

```sh
npm run build --workspace=@bastani/atomic
tmux new-session -d -s atomic-intercom-full-id-e2e -n planner \
  -c /Users/tonystark/Documents/projects/atomic-intercom-full-ids \
  "ATOMIC_CODING_AGENT_DIR='/tmp/atomic-intercom-full-ids-e2e.TDaYLw/agent' ATOMIC_OFFLINE=1 node packages/coding-agent/dist/cli.js --no-context-files --no-themes --name planner"
tmux split-window -h -t atomic-intercom-full-id-e2e:0 \
  -c /Users/tonystark/Documents/projects/atomic-intercom-full-ids \
  "ATOMIC_CODING_AGENT_DIR='/tmp/atomic-intercom-full-ids-e2e.TDaYLw/agent' ATOMIC_OFFLINE=1 node packages/coding-agent/dist/cli.js --no-context-files --no-themes --name worker"
```

Each pane was trusted for this session and renamed with `/name planner` and
`/name worker`. The worker pane ran `/intercom`; its real session-picker overlay
is in `tmux-list-overlay.txt`. It prints complete UUIDs:

- worker: `737986a2-62da-4c43-92d3-8f343da5fddf`
- planner: `f996d39d-5efd-41f7-8b01-22769b77873f`

The worker selected planner in that overlay, entered `Full ID tmux delivery`,
and pressed Enter. `tmux-worker-send.txt` records `Message sent to planner`; the
recipient's `tmux-planner-receive.txt` records the inbound `From: worker` header
and message.

## Real intercom-tool list/send/rejection

Because this isolated run had no configured model, a deterministic probe was run
in a third tmux window against the same live broker. It imported the built
`broker/client.ts` and `intercom-tool.ts`, registered the real `intercom` tool,
and executed its real `list` and `send` actions:

```sh
ATOMIC_CODING_AGENT_DIR='/tmp/atomic-intercom-full-ids-e2e.TDaYLw/agent' \
  ATOMIC_OFFLINE=1 bun /tmp/atomic-intercom-full-id-tool-probe.mjs
```

`tmux-tool-list-send-prefix.txt` contains the captured pane output. The key lines
are:

```text
TOOL_FULL_ID=f996d39d-5efd-41f7-8b01-22769b77873f
TOOL_FULL_SEND=Message sent to f996d39d-5efd-41f7-8b01-22769b77873f
TOOL_PREFIX=f996d39d
TOOL_PREFIX_SEND=Message to "f996d39d" was not delivered: Session not found
```

The same capture's `TOOL_LIST_START`/`TOOL_LIST_END` block shows full UUIDs in
both current and other-session rows. The probe's full-ID send produced another
`From: tool-probe` message in the planner pane, demonstrating real delivery; the
prefix send produced no inbound message and returned `Session not found`.

Cleanup completed with `tmux kill-session -t atomic-intercom-full-id-e2e` and
`rm -rf /tmp/atomic-intercom-full-ids-e2e.TDaYLw` after all captures were written.
