---
allowed-tools: Bash(agent-desktop:*), Bash(npx agent-desktop:*)
description: Operate native desktop applications on macOS, Windows and Linux through accessibility trees with the agent-desktop CLI. Use when an AI agent must see or act on a desktop GUI, such as clicking buttons, filling forms, reading UI state, navigating menus, toggling checkboxes, scrolling, dragging, typing text, pressing shortcuts, taking screenshots, managing windows, using the clipboard, launching or closing apps, handling OS dialogs and permission prompts, or reading notifications. Triggers include requests to "operate the desktop", "computer use", "click a button in an app", "fill a native form", "read the UI", "open an app", "snapshot an app" or any native desktop GUI task. For websites and web apps use agent-browser instead.
hidden: true
metadata:
    github-path: skills/agent-desktop
    github-ref: refs/tags/v1.0.2
    github-repo: https://github.com/vercel-labs/agent-desktop
    github-tree-sha: 08884bafcd7a8d0a9a3757a7ab2ba238e1d5bf2a
name: agent-desktop
---

# agent-desktop

agent-desktop is a CLI that lets an AI agent observe and operate desktop apps through the OS accessibility tree. It is a tool, not an agent. Every command prints one JSON envelope (`ok`, `data` or `error`). The observe, act and verify loop runs in you.

## Install and permissions

If `agent-desktop` is not on `PATH`, make one bounded attempt to install it: `npm install -g agent-desktop` (Node 18 or later; macOS 13+, Windows 10 1809+ or Ubuntu 24.04+, on x64 or arm64), then `agent-desktop version`. If npm blocks install scripts, approve them (`npm install-scripts approve agent-desktop` on npm 12, `npm install -g agent-desktop --allow-scripts=agent-desktop` on npm 11) so each call does not start Node first. Report what the install did. If it fails, report the command and the error instead of switching to another tool. Atomic bundles this skill, so do not run `npx skills add` for it.

`agent-desktop status` is the readiness check. On macOS, `permissions.accessibility` must be `granted`, and `screen_recording` too for `screenshot`: run `agent-desktop permissions --guide` and let the user approve it. Windows needs no grant for apps at the terminal's integrity level. On Linux, run inside the user's graphical session; an empty `supported_surfaces` means the AT-SPI bus did not answer. Never script around a consent dialog.

For web pages use `agent-browser`. For the web contents of a Chromium or Electron app you launch, `agent-desktop launch <app> --cdp` opens a debugging port that `agent-browser connect <port>` drives (see `commands-system`).

## Shell syntax

Examples use a POSIX shell. In PowerShell, quote every ref (`'@s8f3k2p9:e1'`), because a bare `@token` is the splatting operator. Use `$env:NAME = 'value'` instead of `export`, and `| ConvertFrom-Json` instead of `$(...)` and `jq`. The Windows skill has the PowerShell forms.

## First run

1. Run `agent-desktop status`. It reports the platform, permissions and `supported_surfaces`.
2. Run `agent-desktop skills get platform`. It loads the skill for the OS the binary runs on (macOS, Windows or Linux).
3. For flags and syntax, run `agent-desktop <command> --help`. This skill does not repeat flag lists.

## The loop

Use `find` when you know the role or exact name. Otherwise map the app first and drill into one region.

```
agent-desktop snapshot --skeleton --app "Notes" -i --compact   # shallow map, children_count on cut branches
agent-desktop snapshot --root @s8f3k2p9:e3 -i --compact        # drill into one region
agent-desktop click @s8f3k2p9:e12                              # act on a qualified ref
agent-desktop snapshot --root @s8f3k2p9:e3 -i --compact        # verify: re-read the same region
```

- A small app needs no skeleton. Take a full `snapshot -i`.
- Never skeleton a surface (`--surface menu`, `sheet`, `alert`). A surface is already focused.
- An action that opens a menu, sheet or alert lists it in `data.surfaces`. Target that overlay next.
- After an async step, use `wait` (see `commands-system.md`). A fixed sleep is a race.

## Refs

- Output refs are qualified: `@<snapshot_id>:e<N>`, for example `@s8f3k2p9:e1`. Pass them to later commands as they are.
- Refs are valid for one snapshot. After any UI change, re-drill the affected region or take a new snapshot.
- Only addressable elements get refs. Static text and inert containers do not.
- `STALE_REF`: the ref no longer matches the live UI. Take a fresh snapshot and use the new ref.
- `AMBIGUOUS_TARGET`: more than one live element matches. Narrow the target with `find --role --name --exact` or `--root`, then use the new ref.
- `SNAPSHOT_NOT_FOUND`: the snapshot id expired. Snapshot again.

## Delivery and retry

Action results carry `data.disposition` and errors carry `error.disposition`, each with `delivery` and `retry`. Observation commands such as `snapshot` have none on success; their errors, and every `INVALID_ARGS` refusal, carry `not_delivered` and `retry: safe`.

- Retry or substitute an action only when `disposition.retry` is `safe`. Only `not_delivered` is safe.
- Any other delivery value means the action may have landed. A repeat can click, type or submit twice, and `toggle` can undo itself.
- On a result that is not safe, read the live state (`get`, `is`, or a fresh snapshot) and decide from that. `details.post_state` helps when present.
- Branch on `error.code` and `error.disposition`. Message and suggestion text can change.
- `details.retryable: false` means waiting cannot change the outcome. Try a different approach.

## Headless and headed

Ref actions are headless by default. They use semantic accessibility calls and do not take focus, move the cursor, synthesize keys or use the clipboard. If no semantic path exists, the action fails closed. Use the global `--headed` flag only when the user explicitly permits physical input, such as double-click, hover, drag, or focus. Never switch to headed mode to recover from a headless failure. Raw coordinates (`--xy`) never imply focus. Which actions need `--headed` differs by OS: read the platform skill.

## References

Load one only when you need it: `agent-desktop skills get desktop <reference>`.

| Reference | Open it when |
|-----------|--------------|
| `commands-observation` | You need `snapshot`, `find`, `get`, `is`, `screenshot`, `list-surfaces` semantics, partial trees, or the `--root` rules |
| `commands-interaction` | You choose between click, type, set-value, select, toggle, scroll, press and mouse commands, or you debug an action error |
| `commands-system` | You launch or close apps, manage windows, use the clipboard, `wait`, `batch`, sessions, multi-agent cursors, tracing, or load skills |
| `workflows` | You want worked patterns (forms, menus, dialogs, waiting for a new window, scroll-find, drag) and the anti-patterns list |
