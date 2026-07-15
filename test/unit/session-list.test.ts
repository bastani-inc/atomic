/** Unit tests for src/tui/session-list.ts. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { renderSessionList } from "../../packages/workflows/src/tui/session-list.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.ts";

function makeRun(over: Partial<RunSnapshot>): RunSnapshot {
  return {
    id: over.id ?? "00000000-0000-0000-0000-000000000000",
    name: over.name ?? "demo",
    inputs: over.inputs ?? {},
    status: over.status ?? "running",
    stages: over.stages ?? [],
    startedAt: over.startedAt ?? 1000,
    endedAt: over.endedAt,
    durationMs: over.durationMs,
    result: over.result,
    error: over.error,
  };
}
test("session list renders the band-header chrome with both runs and a detail hint", () => {
  const theme = deriveGraphTheme({});
  const now = 100_000;
  const runs = [
    makeRun({ id: "11111111-...", name: "ralph", status: "running", startedAt: now - 30_000 }),
    makeRun({ id: "22222222-...", name: "research", status: "completed", startedAt: now - 60_000, endedAt: now - 10_000, durationMs: 50_000, stages: [{ id: "s", name: "x", status: "completed", parentIds: [], toolEvents: [] }] }),
  ];
  const out = renderSessionList(runs, { theme, includeAll: false, now });
  // Outline-pill band header (DESIGN.md §5).
  assert.match(out, /BACKGROUND/);
  assert.match(out, /2 runs/);
  // Both runs are listed with bolded names.
  assert.match(out, /ralph/);
  assert.match(out, /research/);
  // Short-id (6 chars) leads each entry.
  assert.match(out, /111111/);
  assert.match(out, /222222/);
  // Status count badges per band-header contract.
  assert.match(out, /● 1/);
  assert.match(out, /✓ 1/);
  // Trailing hint nudges drill-down via the rich detail surface.
  assert.match(out, /\/workflow status \w+/);
});

test("session list includeAll:true includes old retained terminal runs", () => {
  const theme = deriveGraphTheme({});
  const now = 3 * 60 * 60 * 1000;
  const oldTerminal = makeRun({
    id: "33333333-0000-0000-0000-000000000000",
    name: "old-retained-terminal",
    status: "completed",
    startedAt: now - 2 * 60 * 60 * 1000 - 10_000,
    endedAt: now - 2 * 60 * 60 * 1000,
    durationMs: 10_000,
  });

  const activeOnly = renderSessionList([oldTerminal], { theme, includeAll: false, now });
  const includeAll = renderSessionList([oldTerminal], { theme, includeAll: true, now });

  assert.doesNotMatch(activeOnly, /old-retained-terminal/);
  assert.match(includeAll, /old-retained-terminal/);
  assert.match(includeAll, /333333/);
});

test("session list emits the band-header chrome with a quiet empty state", () => {
  const theme = deriveGraphTheme({});
  const out = renderSessionList([], { theme, includeAll: false });
  assert.match(out, /BACKGROUND/);
  assert.match(out, /0 runs/);
  assert.match(out, /no workflow runs in current session/);
});
