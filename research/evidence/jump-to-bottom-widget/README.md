# End-to-end evidence: transcript jump-to-bottom indicator

Real interactive session, real provider (`anthropic/claude-opus-5`, `$0.253` of live spend visible
in the usage meter), driven under tmux at 100x30 from this worktree:

```sh
tmux new-session -d -s jtb -x 100 -y 30 \
  "cd /path/to/atomic-jump-to-bottom && exec bun packages/coding-agent/src/cli.ts --approve"
tmux send-keys -t jtb '!seq 1 120' Enter                    # fill > 1 screen of transcript
tmux send-keys -t jtb 'In one short sentence, what does a jump-to-bottom button do?' Enter
tmux send-keys -t jtb PageUp; tmux send-keys -t jtb PageUp  # detach from the live end
tmux capture-pane -t jtb -e -p                              # capture with ANSI
```

Note: piping the launch command through `tee` removes the TTY and drops atomic into print mode.
The session must own the pane directly (`exec`).

## 1. Indicator appears when the transcript is detached (`01-indicator-visible.png`)

```
 108
                                     ┌────────────────────────┐
                                     │ Jump to bottom (end) ↓ │
                                     └────────────────────────┘

                                          ↑2 • ↓22 • W40k • CH0.0% • $0.253 (sub) • 4.0%/1.0M (auto)
────────────────────────────────────────────────────────────────────────────────────────────────────
❯
```

The key label reads `end` because it is resolved live from the `tui.altScreen.bottom` binding
rather than hardcoded, and it renders in the same lowercase form as every other key hint in the
dock (for example `↳ alt+up to edit all queued messages`).

## 2. Bound key jumps to the live end (`02-after-jump.png`, `tmux-02-after-end-key.txt`)

`tmux send-keys -t jtb End` → viewport returns to the newest content, indicator gone:

```
 In one short sentence, what does a jump-to-bottom button do?

 It scrolls the view straight to the newest content at the bottom.
```

## 3. Clicking the label jumps to the live end

Injected as a single write so the terminal parses one SGR sequence (sending `ESC` and the body as
separate `send-keys` calls types the payload into the editor instead):

```sh
tmux send-keys -t jtb -H 1b 5b 3c 30 3b 34 35 3b 32 32 4d   # press   ESC[<0;45;22M
tmux send-keys -t jtb -H 1b 5b 3c 30 3b 34 35 3b 32 32 6d   # release ESC[<0;45;22m
```

Row 22 / column 45 is inside the label span. Result: viewport jumped to the live end and the
indicator disappeared — the OSC 8 activation path reached `jumpToTranscriptEnd`.

## 4. Refusal: the border is not clickable

Same click one row higher (row 21, the top border):

```sh
tmux send-keys -t jtb -H 1b 5b 3c 30 3b 34 35 3b 32 31 4d
tmux send-keys -t jtb -H 1b 5b 3c 30 3b 34 35 3b 32 31 6d
```

Pane before and after are identical — the box is still on screen, the viewport did not move. Only
the label carries the hyperlink, as specified.

## Screenshots

PNGs were produced from the ANSI pane capture (`tmux capture-pane -e -p`) rendered to HTML and
photographed with Playwright, so the colours are the terminal's own, not a re-typeset mock.
