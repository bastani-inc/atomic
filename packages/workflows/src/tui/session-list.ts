/**
 * Inline `/workflow session list` renderer — thin wrapper around the
 * canonical {@link renderStatusList} surface. Applies the picker's
 * "recent within 1h" filter (vs. `--all`) and then defers the visual
 * vocabulary to status-list.ts.
 *
 * cross-ref:
 *  - src/tui/status-list.ts       canonical band-header status surface
 *  - src/tui/session-picker.ts    selectRunsForPicker — same bucketing
 */

import type { RunSnapshot, StoreSnapshot } from "../shared/store-types.js";
import { expandWorkflowGraph } from "../shared/expanded-workflow-graph.js";
import type { GraphTheme } from "./graph-theme.js";
import { renderStatusList } from "./status-list.js";
import { selectRunsForPicker } from "./session-picker.js";

export interface SessionListRenderOpts {
  theme: GraphTheme;
  /** When true, includes ended runs older than the last hour. */
  includeAll: boolean;
  now?: number;
}

export function renderSessionList(
  runs: readonly RunSnapshot[],
  opts: SessionListRenderOpts,
): string {
  const now = opts.now ?? Date.now();
  const rows = selectRunsForPicker(runs, "", opts.includeAll, now);
  const snapshot: StoreSnapshot = { runs, notices: [], version: 0 };
  const filtered = rows.map((row) => {
    const graph = expandWorkflowGraph(snapshot, row.run.id);
    return {
      ...row.run,
      stages: graph.stages.map((stage) => structuredClone(stage)),
      toolNodes: graph.tools.map((tool) => structuredClone(tool)),
    };
  });
  return renderStatusList(filtered, { theme: opts.theme, now });
}
