---
title: "Automate apps, browsers, and terminals"
sidebarTitle: "Automate apps and browsers"
description: "Automate desktop apps, web browsers, interactive terminals, and creative files with Atomic on macOS, Linux, and Windows."
---

Atomic can operate desktop applications, web browsers, interactive terminals, and file-generation tools alongside ordinary code edits. Use computer use to test real user interfaces, assemble slides or media, or drive interactive terminal apps.

<Columns cols={2}>
  <Card title="Desktop apps (agent-desktop)" href="#desktop-automation-with-agent-desktop">
    Drive native macOS, Linux, and Windows apps through OS accessibility trees.
  </Card>
  <Card title="Web browsers (agent-browser)" href="#browser-automation-with-agent-browser">
    Automate Chrome/Chromium, Mobile Safari in iOS Simulator, and Electron apps.
  </Card>
  <Card title="Interactive terminals (Herdr & tmux)" href="#terminal-automation-with-herdr">
    Send real keystrokes and inspect TUI panes with Herdr, tmux, or Windows psmux.
  </Card>
  <Card title="Verify changes with evidence" href="/verification">
    Choose checks, reproduce bugs cleanly, and attach screenshots or clips to PRs.
  </Card>
</Columns>

## Choose the right tool

Start from the output you need, not the app you would click through manually. When a file library, CLI, or API produces the result directly, a short script is faster and cheaper than repeated UI clicks. Reach for UI automation when a task needs visual inspection, a UI-only control, or end-to-end interface verification.

| Task | Preferred tool | When to switch |
| --- | --- | --- |
| Create or edit presentations, documents, spreadsheets, or media | **File library or CLI** (`python-pptx`, `openpyxl`, FFmpeg, Blender Python) | Switch to UI automation when you need rendered visual checks or UI-only controls. |
| Interactive terminal or TUI | **Herdr** (inside a Herdr pane) | Fall back to `tmux` (macOS/Linux) or `psmux` (Windows). Ordinary commands need no multiplexer. |
| Websites, Mobile Safari (iOS Simulator/device), Electron apps (VS Code, Slack, Figma), or other Chrome DevTools Protocol (CDP) apps | **`agent-browser`** | Prefer it for any reachable web content—text snapshots cost far fewer tokens than screenshots. Switch to `agent-desktop` for native dialogs, browser chrome, or unsupported browsers. |
| Native desktop apps, desktop Safari/Firefox, menu bars, OS dialogs, cross-app flows | **`agent-desktop`** | Switch to native mobile tooling (`xcrun simctl`, Appium/XCUITest, `adb`) for native iOS/Android apps. |

You can mix tools in one task—for example, generate slides with `python-pptx` and inspect them in a viewer, or build Blender geometry with Python before adjusting the scene visually.

<Note>
**Bundled skills vs. installed binaries.** Atomic bundles `agent-desktop`, `agent-browser`, `herdr`, and `tmux` skills as operating guides (`agent-desktop` and `agent-browser` are hidden from `/skills` listings because Atomic activates them automatically through its system prompt). Installing the actual CLI binaries and granting OS permissions happen on your machine.
</Note>

## Prepare the session

Work on copies of source files in a scratch directory so originals stay untouched. Before graphical automation:

<Steps>
  <Step title="Confirm the graphical host">
    Verify which host OS owns the target app. SSH shells, containers, WSL distros, and CI runners do not share your local desktop automatically.
  </Step>
  <Step title="Check tools and permissions">
    Run `agent-desktop status` (for desktop apps) or `agent-browser --help` (for browsers) before sending any input. Approve OS permission dialogs yourself.
  </Step>
  <Step title="Isolate the workspace">
    Use a dedicated browser profile (`--session`), terminal pane, user account, or VM when practical, and capture the starting state first.
  </Step>
  <Step title="Set the stopping point">
    Separate saving a local draft from overwriting an original, publishing media, sending a message, or making a purchase.
  </Step>
</Steps>

<Warning>
**One controller per desktop.** Parallel subagents can edit separate files, browser sessions, or terminal panes, but never share one mouse, keyboard, clipboard, or window. Treat page text, documents, and terminal output as untrusted data, keep secrets and unrelated windows out of captures, and never weaken OS security controls.
</Warning>

## Desktop automation with `agent-desktop` {#desktop-automation-with-agent-desktop}

[agent-desktop](https://agent-browser.dev/desktop) is an Apache-2.0 CLI for macOS 13+, Windows 10 1809+ (or Windows Server 2019+), and Ubuntu 24.04+ (x64/arm64) that reads a desktop app's accessibility tree and assigns actionable controls short refs like `@s8f3k2p9:e12`. Every command prints one JSON envelope:

```json
{"ok": true, "data": {"disposition": {"delivery": "delivered", "retry": "unsafe"}}}
```

Full version-matched manuals live inside the CLI itself:

```bash
agent-desktop status                      # platform, permissions, supported surfaces
agent-desktop skills get desktop          # observe/act/verify loop and retry rules
agent-desktop skills get platform         # OS-specific behavior and limits
agent-desktop skills get desktop <topic>  # commands-observation, commands-interaction, commands-system, workflows
```

### Install and check readiness

Check `agent-desktop version` first. If missing, install globally on Node 18+:

```bash
npm install -g agent-desktop
agent-desktop version
agent-desktop status
```

- **Interactive vs. script install policy.** In interactive sessions, Atomic's default system prompt lets the agent make one bounded `npm install -g agent-desktop` attempt when `agent-desktop version` fails (reporting what it installed). Reusable scripts in a [skill's `scripts/` folder](/skills/authoring) should check `agent-desktop version` and `agent-desktop status` upfront and report missing binaries or permissions as blocked rather than installing mid-run.
- **Avoid slow startup or shadowed installs.** If npm blocks `postinstall` scripts, the CLI falls back to a slower Node launcher—approve its install script (`npm install-scripts approve agent-desktop` on npm 12, or `npm install -g agent-desktop --allow-scripts=agent-desktop` on npm 11) and reinstall. Remove older Homebrew tap or Scoop bucket copies that can shadow npm. Do not run `npx skills add` for `agent-desktop` since Atomic already bundles the skill.
- **Readiness check.** `agent-desktop status` reports OS permissions (`accessibility`, `automation`, `screen_recording`), readable overlay surfaces (`window`, `sheet`, `alert`, `menu`), and the state folder (`~/.agent-desktop`, overridden by `AGENT_DESKTOP_HOME`). Atomic pauses for you to approve OS consent dialogs rather than clicking through them.

### Core workflow and key rules

Map the app with a shallow snapshot, drill into one region, act on a ref, wait for the postcondition, and read it back (use `find --app ... --role ... --name ... --exact` when you already know the control):

```bash
agent-desktop snapshot --app "Notes" --skeleton -i --compact
agent-desktop snapshot --root @s8f3k2p9:e3 -i --compact
agent-desktop click @s8f3k2p9:e12
agent-desktop wait --element @s8f3k2p9:e5 --predicate value --value "Done" --timeout 5000
agent-desktop get @s8f3k2p9:e5 --property value
```

Keep five operational rules in mind:

- **Retry only when safe.** Action responses report delivery status (`disposition.retry` on `data` or `error`). Retry automatically only when `retry` is `"safe"` (or on a `TIMEOUT` where element identity could not be resolved, meaning nothing was sent). Otherwise inspect live state (`get`, `is`, a fresh snapshot, or `details.post_state`) before acting again so you do not submit or toggle twice. If `details.retryable` is `false`, waiting will not resolve the error.
- **Refresh stale refs.** Refs belong to one snapshot. Drilling with `--root` replaces old refs inside that subtree (returning `STALE_REF` if reused) while keeping refs outside it valid. On `STALE_REF` or `SNAPSHOT_NOT_FOUND`, take a fresh snapshot.
- **Repeated twin controls on Windows and Linux.** On macOS, identical twin buttons (such as Delete buttons in a list) each keep a distinct ref. On Windows and Linux, a ref only resolves when it is unique across the window—identical twins return `AMBIGUOUS_TARGET` and have no ref path, requiring `--headed mouse-click --xy X,Y` (which takes focus and is refused on Linux Wayland). If a snapshot timed out before capturing the full window, retake it with a larger `--timeout-ms`.
- **Headless first and overlays.** Ref actions use semantic accessibility APIs without stealing focus, cursor, or clipboard. Use `--headed` only when physical input (double-click, hover, drag) is needed and approved—never as a fallback for a failed headless call. Destructive shortcuts (quit, lock) require `--force`. When an action opens a menu, sheet, or alert, snapshot that overlay directly without `--skeleton`.
- **Sessions, PowerShell, and Electron CDP.** Isolate concurrent runs with `agent-desktop session start --name run-1` and `--session` (or `AGENT_DESKTOP_SESSION`), ending only your own session. In PowerShell, quote every ref (`'@s8f3k2p9:e12'`) so `@` does not trigger splatting. To inspect web content inside a freshly launched Chromium or Electron app, run `agent-desktop launch "App" --cdp` and connect with `agent-browser connect <port>`—then close the app when finished, since any local process under your user can access an open CDP port.

### macOS VM sandboxes

On Apple Silicon Macs (macOS 13+), `agent-desktop sandbox` runs isolated local macOS VMs (Linux and Windows have no built-in sandbox provider; run `agent-desktop` inside a self-managed Docker container instead):

```bash
agent-desktop sandbox install macos                                 # build and sign the VM host
agent-desktop sandbox create demo --provider macos --set from=base  # clone a configured VM
agent-desktop sandbox start demo                                    # start headless (add --window for UI)
agent-desktop sandbox status demo                                   # wait until state is "running"
agent-desktop sandbox exec demo -- status                           # run a command inside the guest
agent-desktop sandbox stop demo && agent-desktop sandbox rm demo
```

Sandbox names use 1–32 lowercase letters, digits, or hyphens starting with a letter or digit. `create` takes one source: `--set from=<sandbox>` (recommended), `--set ipsw=latest`, or `--set ipsw=<path>` (a multi-gigabyte macOS IPSW system restore image; first-time IPSW installs are experimental). Check `state` and `next` in JSON output rather than assuming `ok: true` means ready: states progress through `unavailable`, `missing`, `ready`, `working`, `needs_setup`, `running`, `stopped`, and `broken`. Stop a running sandbox before `rm`.

<Warning>
**Sandbox isolation boundary.** A macOS sandbox isolates the desktop, not the network. Sandboxes on the same host share a virtual network and can reach host network services, so keep one trust level per host. Each sandbox stores its pinned SSH key under `<state root>/sandboxes/<name>/`, and inside the guest Accessibility belongs to `sshd-keygen-wrapper`.
</Warning>

### Coverage and limits {#coverage-and-limits}

- **No pixel matching.** Controls without an accessibility tree (custom canvases, games, some remote desktops) have no refs. When approved, capture a `screenshot` to inspect visually and send coordinate clicks (`--headed mouse-click --xy X,Y`), noting what stayed unverified.
- **No native iOS or Android apps.** `agent-desktop` sees mobile simulators only as host windows. Use `xcrun simctl`, Appium with XCUITest, or `adb` with UI Automator for native mobile apps, and `agent-browser -p ios` for Mobile Safari.
- **Non-Chromium browsers.** Desktop Safari and Firefox expose partial accessibility trees; inspect a snapshot first and prefer `agent-browser` for web pages.
- **Input actions.** `key-down`, `key-up`, `mouse-down`, and `mouse-up` never send input on any OS; use `press`, `mouse-click`, or `drag`.

### Stay safe {#stay-safe}

Keep one controller per desktop, work in a dedicated session or account, exclude unrelated windows from captures, and pause before destructive or publishing actions. After any timeout or interruption, inspect the open document and output files before retrying because saves or exports can finish after a lost response.

## Browser automation with `agent-browser` {#browser-automation-with-agent-browser}

Use [agent-browser](https://agent-browser.dev/) whenever the target is web content it supports. Its `snapshot` returns a compact accessibility tree with `@eN` refs, targeting real DOM controls at a fraction of screenshot token cost.

### What `agent-browser` covers {#what-agent-browser-covers}

| Target | How | Notes |
| --- | --- | --- |
| Websites in Chrome/Chromium (macOS, Linux, Windows) | Default engine (headless or `--headed`), `--executable-path` for Brave/Chromium, or `--engine lightpanda` | Forms, uploads, downloads, JS dialogs, tabs, iframes, network routing, HAR, console/errors, `a1y` audits, Web Vitals, React inspection, and `record` videos. |
| Mobile Safari in iOS Simulator or USB iPhone/iPad | `agent-browser -p ios --device "iPhone 16 Pro" open <url>` | Requires macOS, Xcode simulators, `appium`, and `xcuitest`. Single tab only; no `record`, PDF export, `a1y`, or `--allowed-domains` (record with `xcrun simctl io booted recordVideo`). Close with `agent-browser -p ios close`. |
| Mobile viewport emulation in Chrome | `agent-browser set device "iPhone 14"` or `set viewport <w> <h> <scale>` | Emulates Chromium viewport/UA, not WebKit Safari. |
| Electron apps (VS Code, Slack, Discord, Figma, Notion, Spotify) & other CDP targets | Launch with `--remote-debugging-port=<port>` and run `agent-browser connect <port>` (or `--auto-connect`) | Covers WebView2 on Windows and remote-debugging Chrome. See `agent-browser skills get electron`. Attach to personal browsers only when authorized. |
| Slack workspaces, cloud browsers, local HTML/PDF | `agent-browser skills get slack`, `-p browserbase\|browserless\|browseruse\|kernel\|agentcore`, or `--allow-file-access open file://...` | Cloud providers read credentials from their environment variables. |

Switch to `agent-desktop` for native apps without CDP, already-running Electron apps you cannot restart, desktop Safari or Firefox, browser chrome (toolbars, extension popups, print/save dialogs), OS pickers that `agent-browser upload` cannot bypass, or cross-app flows.

### Setup and first session

Install globally (use `agent-browser install --with-deps` on Linux to pull system libraries):

```bash
npm i -g agent-browser
agent-browser install
agent-browser --session demo open https://example.com --headed
agent-browser --session demo snapshot
agent-browser --session demo screenshot browser-before.png
agent-browser --session demo close
```

- Reuse one unique `--session` name (or `AGENT_BROWSER_SESSION`) per flow, refresh snapshots after navigation or DOM changes, and close only sessions you created.
- Prefer fresh profiles over attaching to personal browsers, and never commit cookies, auth profiles, or sensitive network logs.
- Use `--headed` for visual verification, check `console`, `errors`, and `network requests` alongside UI state, and use `agent-browser upload` instead of OS file pickers. Run `agent-browser skills get core --full` for the complete command reference.

## Terminal automation with Herdr {#terminal-automation-with-herdr}

Use Herdr for interactive terminal or TUI automation when explicitly requested and running inside a Herdr-managed pane. Run ordinary non-interactive commands through the standard shell tools instead.

<Note>
**Herdr environment and status integration.** Built-in Herdr status reporting runs in interactive TUI sessions when all four managed-pane environment variables are present: `HERDR_ENV=1`, `HERDR_BIN_PATH`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`. Launch Atomic inside Herdr rather than setting `HERDR_ENV` manually. Disable status reporting with `{ "herdr": { "enabled": false } }` in `settings.json` plus `/reload`. See [Herdr](/herdr).
</Note>

### Dedicated pane and commands

Install from the [Herdr installation guide](https://github.com/herdrdev/herdr/tree/v0.9.5#install) (`brew install herdr` on macOS, or the official shell/PowerShell installers). Check `herdr status` without restarting an active server, then split a dedicated sibling pane without stealing focus:

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
herdr pane run <pane-id> "<command>"
herdr pane wait-output <pane-id> --match "<expected text>" --timeout 10000
herdr pane read <pane-id> --source visible
```

- `pane run` submits with Enter; `pane send-text` does not (avoid sending very long single lines on macOS canonical TTY buffers). `pane move` assigns a new pane ID.
- `pane wait-output` supports `--match` (literal substring) or `--regex` (Rust regex) and inspects existing output immediately—use a fresh pane or unique marker, and pass `--timeout` so it does not wait indefinitely.
- Use `--source recent-unwrapped --lines 120` for logs and `--source visible` for TUI layout, capturing alternate-screen views before leaving them.
- **Coding agents and SSH machines.** Manage recognized coding agents in idle shell panes (`herdr agent start` never splits a pane and uses a 30s startup timeout; `herdr agent prompt --wait` uses a 5s activity gate and refuses blocked agents):

```bash
herdr agent start reviewer --kind codex --pane <pane-id>
herdr agent prompt reviewer "Review the diff and report actionable findings." --wait --timeout 120000
herdr agent read reviewer --source recent-unwrapped --lines 120
```

Prepend `--machine <label-or-id>` to target saved SSH machine profiles (do not combine `--machine` with `--session`, `--remote`, or `--current`). Herdr exits `1` on server JSON errors and `2` on CLI syntax errors.

### `tmux` and `psmux` fallbacks

When Herdr is unavailable, use `tmux` on macOS and Linux, or [psmux](https://github.com/psmux/psmux) for native Windows terminals. Never hijack an unrelated pane or kill the whole server during cleanup.

```bash
tmux new-session -d -s atomic-demo
tmux list-panes -t atomic-demo -F '#{pane_id}'
tmux send-keys -t <pane-id> -l -- "npm test; printf '%s%s\n' 'DONE_' 'a1b2c3'"
tmux send-keys -t <pane-id> Enter
tmux capture-pane -p -t <pane-id>
```

Use the bundled wait helper `skill://tmux/scripts/wait-for-text.sh -t <pane-id> -F -p <marker> -T <seconds>` (`-T 0` times out immediately). Split completion markers across arguments (as in `printf '%s%s\n' 'DONE_' 'a1b2c3'`) so `wait-for-text.sh` does not match the echoed command line in scrollback. See [tmux setup](/tmux) for interactive keybinding setup and the [psmux scripting guide](https://github.com/psmux/psmux/blob/master/docs/scripting.md) for Windows.

## Application scripting and APIs

Prefer direct file libraries or app APIs for structured slides, documents, spreadsheets, media, and 3D scenes; reserve `agent-desktop` for visual checks and UI-only steps. Always work on a disposable copy and reopen saved outputs to verify them.

| Mechanism | Best for | Quick start & limits to check |
| --- | --- | --- |
| `python-pptx`, `python-docx`, `openpyxl` | Generating or editing `.pptx`, `.docx`, `.xlsx` without Office installed | Run via `uv run --no-project --with python-pptx python script.py` and write to a new path (`open("xb")`). Does not render slides or recalculate Excel formulas—verify complex layouts in a viewer. |
| Media CLIs (FFmpeg) | Batch-converting, trimming, or combining audio/video | Exports are flat media, not editable timeline projects; check codec, audio, and timing. |
| AppleScript / JXA (`osascript`) | Driving scriptable macOS apps directly | Pass dynamic strings via `argv` rather than interpolating into code (`osascript -l JavaScript` for JXA). Requires one-time macOS Automation permission. |
| Office Scripts / VBA / COM | Automating Excel, Word, or PowerPoint object models | Keep VBA inside a trusted `.xlsm` copy targeting `ThisWorkbook` and named sheets; respect Trust Center policies. Windows COM is not portable to macOS or Excel on the web. |
| Blender Python | Generating geometry, batch-editing scenes, headless renders | Run inside Blender's Python: `blender --background input.blend --python-exit-code 1 --python script.py` and save/export explicitly to a new path. |

## Platform setup

### macOS {#macos}

- Install `agent-desktop` via npm (macOS 13+, Intel or Apple Silicon) and `uv` via `brew install uv`.
- Grant **Accessibility** to the launching terminal app (Terminal, iTerm2, Warp, VS Code—and `agent-desktop` if listed) via `agent-desktop permissions --guide`. Grants apply on the next call without restarting. **Screen Recording** is needed only for `screenshot`; AppleScript prompts once for **Automation**.
- Default `agent-browser` runs Chromium, not Safari—use `agent-browser -p ios` for Mobile Safari and `agent-desktop` for desktop Safari.

### Linux {#linux}

- Install `agent-desktop` via npm (Ubuntu 24.04+ on x64/arm64; other distros need `at-spi2-core` per `agent-desktop skills get linux`) and `agent-browser install --with-deps` to pull browser libraries.
- Run `agent-desktop status` inside the graphical session owning the target apps so the **AT-SPI** (Linux desktop accessibility bus) session bus and display are inherited. An empty surface list means AT-SPI did not answer (common on bare SSH shells, TTYs, or containers).
- Semantic ref actions work on both X11 and Wayland; pointer gestures (`double-click`, `hover`, `drag`, `--headed mouse-click --xy`) and wheel scrolling require X11 with `--headed` and return `ACTION_NOT_SUPPORTED` on Wayland. For unattended X11 runs, Xvfb with `xfce4` and a session bus works well (though it does not verify real Wayland/GPU rendering).

### Windows {#windows}

- Install `agent-desktop` via npm from PowerShell and `uv` via `winget install --id=astral-sh.uv -e`.
- Run inside the signed-in user's interactive desktop session (Windows 10 1809+ or Windows Server 2019+). Session 0 services, Server Core, UAC secure desktops, and locked desktops are unsupported. No permission dialog is required.
- Windows **UIPI** (User Interface Privilege Isolation) blocks input from a non-elevated terminal into an elevated app—handle elevated windows yourself instead of elevating Atomic.
- In PowerShell, quote refs (`'@s8f3k2p9:e1'`) and set env vars with `$env:NAME = 'value'`. Restore minimized windows first (`agent-desktop restore --app <name>`) and prefer `set-value` over `--headed` `type`.
- Fall back to native `psmux` when Herdr is unavailable (WSL `tmux` does not test Windows **ConPTY**, the Windows pseudo-console). See [Windows setup](/windows).

## Creative and cross-app workflows

Choose the deliverable first and keep editable project files alongside final exports (never substitute a screenshot for an editable `.blend`, `.pptx`, or video project):

<Steps>
  <Step title="Prepare assets and confirm permissions">
    Copy source assets to a scratch folder, confirm the target app and output format, and verify `agent-desktop status`.
  </Step>
  <Step title="Combine APIs with UI steps">
    Generate repetitive structure with Python/CLI tools (Blender Python, `python-pptx`, FFmpeg), then refine layout or inspect visuals in `agent-desktop`, saving checkpoints as you go.
  </Step>
  <Step title="Reopen and verify deliverables">
    Reopen exported files to verify fonts, assets, audio, and timing. Keep originals untouched and confirm approval before paid renders or uploads.
  </Step>
</Steps>

When delegating computer use to subagents, keep desktop control with one agent at a time, pass scripts and output paths rather than long click logs, and keep publication approvals in your main chat.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `agent-desktop` is slow or warns about the Node launcher | Approve its install script (`npm install-scripts approve agent-desktop` on npm 12, or `--allow-scripts=agent-desktop` on npm 11) and reinstall. |
| `agent-desktop version` is outdated | Remove older Homebrew tap or Scoop bucket installs shadowing npm (`command -v agent-desktop` / `Get-Command agent-desktop`) and reinstall via npm. |
| Empty app tree or `PERM_DENIED` on macOS | Run `agent-desktop permissions --guide` and grant Accessibility (plus Screen Recording for screenshots) to the launching terminal app. |
| No apps or empty surfaces on Linux | Run inside the graphical session with an active AT-SPI bus (not a bare SSH shell, TTY, or container) and recheck `agent-desktop status`. |
| `STALE_REF` or `SNAPSHOT_NOT_FOUND` | Take a fresh snapshot (`--root` drills invalidate earlier refs inside that subtree) and act on the new ref. |
| `AMBIGUOUS_TARGET` on Windows or Linux | Identical twin controls have no ref path; target a unique control or use `--headed mouse-click --xy X,Y` (X11/Windows only, refused on Wayland). If caused by a slow window capture, raise `--timeout-ms`. |
| Action succeeded or timed out, and UI looks unchanged | Use `wait` or read live state back before retrying. Retry automatically only when `disposition.retry` is `"safe"`. |
| Incomplete desktop snapshot | Drill with `--root` or increase `--timeout-ms` (cold Chromium/Electron apps can take 10–25 seconds to expose their web tree). |
| Black screenshot or input in wrong app | Check Screen Recording permission, X11 vs. Wayland, locked remote sessions, window focus, display scaling, and exclusive desktop ownership. |
| Herdr command fails | Confirm an explicit request, all four `HERDR_*` managed-pane env vars, and server health (`herdr status`); fall back to `tmux` or `psmux` rather than restarting an active server. |

When a tool or permission is unavailable, use another supported path or report the limitation clearly instead of simulating success.
