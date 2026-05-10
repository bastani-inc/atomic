/**
 * Attached-mode footer: a single-row status line shown at the bottom
 * of every agent window in workflows and the chat command.
 *
 * Implementation: compile a JSX tree (see tui/attached-statusline.tsx)
 * to a tmux/psmux format string and apply it via `set-option -g
 * status-left/status-right`. Used on both tmux and psmux — uniform
 * code path, no split panes, no separate process. Replaced the older
 * OpenTUI-pane footer because psmux's pane-resize plumbing is broken
 * (split-window -l 1 produces h=2; resize-pane -y is a silent no-op;
 * window-resized hook does not fire). Status-line rendering is done
 * by tmux/psmux internally and reflows on resize without any hook.
 *
 * Trade-off: status-line is server-global, so multiple agent windows
 * in a workflow share one footer. The workflow variant uses
 * `#{window_name}` so the active window's name shows automatically;
 * the chat variant has a single window so this isn't a concern.
 * Per-window agent-type pill colors in workflows aren't yet supported
 * (would need conditional format strings keyed off `#{window_name}`).
 */

import type { AgentType } from "../types.ts";
import { attachedStatusline } from "../tui/attached-statusline.tsx";
import { renderFooter } from "../tui/renderer.ts";
import { deriveGraphTheme } from "../components/graph-theme.ts";
import { resolveTheme } from "./theme.ts";

export function spawnAttachedFooter(
  _paneId: string,
  agentType?: AgentType,
  sessionName?: string,
  name?: string,
): void {
  const theme = deriveGraphTheme(resolveTheme(null));
  renderFooter(
    attachedStatusline({ theme, agentType, name }),
    { sessionName },
  );
}
