---
name: tmux
description: "Control tmux-compatible sessions/windows/panes for interactive CLIs: list, capture output, send keys, paste text, monitor prompts."
metadata:
  {
    "atomic":
      {
        "os": ["darwin", "linux", "windows"],
        "requires": { "bins": ["tmux", "psmux"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "tmux",
              "bins": ["tmux"],
              "label": "Install tmux (brew)",
            },
            {
              "id": "winget-psmux",
              "kind": "winget",
              "package": "psmux",
              "bins": ["tmux"],
              "label": "Install psmux (WinGet)",
            },
            {
              "id": "cargo-psmux",
              "kind": "cargo",
              "crate": "psmux",
              "bins": ["tmux"],
              "label": "Install psmux (Cargo)",
            },
            {
              "id": "scoop-psmux",
              "kind": "scoop",
              "bucket": "https://github.com/psmux/scoop-psmux",
              "package": "psmux",
              "bins": ["tmux"],
              "label": "Install psmux (Scoop)",
            },
            {
              "id": "choco-psmux",
              "kind": "choco",
              "package": "psmux",
              "bins": ["tmux"],
              "label": "Install psmux (Chocolatey)",
            },
          ],
      },
  }
---

# tmux

Use for existing interactive tmux sessions. For one-shot commands, use normal shell. For new non-interactive background jobs, use background execution.

On Windows, use [psmux](https://github.com/psmux/psmux), the native Windows tmux-compatible multiplexer. psmux automatically provides the `tmux` alias, so keep using the `tmux` commands below; no command changes are needed.

When this skill is invoked, first confirm `tmux` is available before running tmux commands (`command -v tmux` or `tmux -V`; on Windows PowerShell, `Get-Command tmux`). If `tmux` is not found, tell the user to install tmux on macOS/Linux or psmux on Windows, depending on their OS, using one of the options below.

## Installation

Choose the install path that matches the host OS and package manager.

### macOS/Linux tmux

Package managers are preferred when available:

```bash
brew install tmux
```

To build official tmux from a release tarball, install `libevent` 2.x, `ncurses`, a C compiler, `make`, `pkg-config`, and `yacc` or `bison`, then run:

```bash
./configure && make
sudo make install
```

To build the latest tmux from version control, also install `autoconf` and `automake`:

```bash
git clone https://github.com/tmux/tmux.git
cd tmux
sh autogen.sh
./configure && make
sudo make install
```

### Windows psmux

psmux installs `psmux`, `pmux`, and `tmux`; this skill should continue to use `tmux` in examples and scripts.

```powershell
winget install psmux
cargo install psmux
scoop bucket add psmux https://github.com/psmux/scoop-psmux
scoop install psmux
choco install psmux
```

Alternatively, download the latest `.zip` from GitHub Releases and add it to `PATH`, or build from source with Cargo:

```powershell
git clone https://github.com/psmux/psmux.git
cd psmux
cargo build --release
```

## Basics

```bash
tmux ls
tmux list-windows -t shared
tmux list-panes -t shared:0
tmux capture-pane -t shared:0.0 -p
tmux capture-pane -t shared:0.0 -p -S -
```

Target format: `session:window.pane`, e.g. `shared:0.0`.

## Send input

Literal text, then Enter:

```bash
tmux send-keys -t shared:0.0 -l -- "Please continue"
tmux send-keys -t shared:0.0 Enter
```

Special keys:

```bash
tmux send-keys -t shared:0.0 C-c
tmux send-keys -t shared:0.0 C-d
tmux send-keys -t shared:0.0 Escape
```

Use `-l --` for arbitrary text. Split text and Enter to avoid paste/newline surprises.

## Sessions

```bash
tmux new-session -d -s worker
tmux rename-session -t old new
tmux kill-session -t worker
```

## Prompt checks

```bash
tmux capture-pane -t worker-3 -p | tail -20
tmux capture-pane -t worker-3 -p | rg "proceed|permission|Yes|No|❯"
```

Approve/select only when the prompt is understood:

```bash
tmux send-keys -t worker-3 -l -- "y"
tmux send-keys -t worker-3 Enter
```

## QA/testing and analysis

Prefer read-only inspection before sending input. These commands are especially useful for diagnosing interactive tests, stuck agents, TUI apps, and long-running CLI workflows.

Discover every pane with useful state:

```bash
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{pane_current_path} active=#{pane_active} dead=#{pane_dead}'
```

Capture output for assertions or log review:

```bash
tmux capture-pane -t shared:0.0 -p -S -          # full scrollback
tmux capture-pane -t shared:0.0 -p -S - -J       # join wrapped lines
tmux capture-pane -t shared:0.0 -p -S -1000      # recent output only
tmux capture-pane -t shared:0.0 -p -e -S -1000   # include escape/color codes for TUI debugging
```

Inspect what a pane is running:

```bash
tmux display-message -p -t shared:0.0 '#{pane_current_command} #{pane_current_path} pid=#{pane_pid}'
tmux show-messages
```

Stream pane output to a file for later analysis without interrupting the process:

```bash
tmux pipe-pane -t shared:0.0 -o 'cat >> /tmp/tmux-pane-shared-0-0.log'
```

Coordinate tests or scripts with tmux signals:

```bash
tmux wait-for qa-ready      # wait
tmux wait-for -S qa-ready   # signal
```

Keep failed commands visible and label panes for easier reports:

```bash
tmux set-option -t shared remain-on-exit on
tmux select-pane -t shared:0.0 -T "api-tests"
```

If a tmux-compatible implementation does not support a specific format variable or option, fall back to the simpler `list-panes`, `capture-pane`, and `send-keys` forms above.

## Helpers

- `scripts/find-sessions.sh`: discover sessions.
- `scripts/wait-for-text.sh`: wait until pane output contains text.

## Notes

- `capture-pane -p` prints to stdout for scripts.
- `-S -` captures full scrollback.
- tmux sessions persist across SSH disconnects.