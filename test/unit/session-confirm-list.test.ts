/**
 * Unit tests for src/tui/session-confirm.ts and src/tui/session-list.ts.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { Key } from "@earendil-works/pi-tui";
import {
  createKillConfirmState,
  handleKillConfirmInput,
  renderKillConfirm,
  renderWorkflowKilledNotice,
} from "../../packages/workflows/src/tui/session-confirm.ts";
import { renderSessionList } from "../../packages/workflows/src/tui/session-list.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.ts";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.ts";


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

test("kill confirm: y always confirms, n / esc variants cancel", () => {
  const s = createKillConfirmState();
  assert.deepEqual(handleKillConfirmInput("y", s), { kind: "confirm" });
  assert.deepEqual(handleKillConfirmInput("Y", s), { kind: "confirm" });
  assert.deepEqual(handleKillConfirmInput("n", s), { kind: "cancel" });
  assert.deepEqual(handleKillConfirmInput(Key.escape, s), { kind: "cancel" });
});

test("kill confirm: tab toggles focus, enter commits focused button", () => {
  const s = createKillConfirmState();
  assert.equal(s.focusedButton, 0); // default Cancel
  // Enter on Cancel = cancel.
  assert.deepEqual(handleKillConfirmInput(Key.enter, s), { kind: "cancel" });
  // Tab → focus Kill, then enter = confirm.
  handleKillConfirmInput(Key.tab, s);
  assert.equal(s.focusedButton, 1);
  assert.deepEqual(handleKillConfirmInput(Key.enter, s), { kind: "confirm" });
});

test("kill confirm renders run identity and button row", () => {
  const theme = deriveGraphTheme({});
  const state = createKillConfirmState();
  const run = makeRun({
    id: "abc12345-0000-0000-0000-000000000000",
    name: "ralph",
    status: "running",
    startedAt: 1000,
    stages: [
      { id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] },
      { id: "s2", name: "build", status: "pending", parentIds: ["s1"], toolEvents: [] },
    ],
  });
  const lines = renderKillConfirm({ width: 70, theme, run, state, now: 5000 });
  const joined = lines.join("\n");
  assert.match(joined, /Kill workflow run/);
  assert.match(joined, /ralph/);
  assert.match(joined, /abc12345/);
  assert.match(joined, /Cancel/);
  assert.match(joined, /Kill run/);
  assert.match(joined, /1\/2 stages running/);
  assert.match(joined, /marks the run killed/);
  assert.match(joined, /Retains it in history\/status for inspection/);
  assert.doesNotMatch(joined, /Removes the run from live history\/status/);
});

test("kill confirm clamps long and wide workflow names to the dialog width", () => {
  const theme = deriveGraphTheme({});
  const state = createKillConfirmState();
  const width = 70;
  const run = makeRun({
    id: "abc12345-0000-0000-0000-000000000000",
    name: "研究".repeat(30) + "-destructive-dialog-overflow",
    status: "running",
    startedAt: 1000,
    stages: [{ id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] }],
  });
  const lines = renderKillConfirm({ width, theme, run, state, now: 5000 });
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
  }
  assert.match(lines.join("\n"), /…/);
});

test("workflow killed notice renders transparent completion details", () => {
  const theme = deriveGraphTheme({});
  const width = 72;
  const run = makeRun({
    id: "abc12345-0000-0000-0000-000000000000",
    name: "issue-973-validation",
    status: "running",
    stages: [
      { id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] },
      { id: "s2", name: "build", status: "pending", parentIds: ["s1"], toolEvents: [] },
    ],
  });
  const lines = renderWorkflowKilledNotice({
    width,
    theme,
    run,
    previousStatus: "running",
  });
  const joined = lines.join("\n");
  assert.match(joined, /Workflow killed/);
  assert.match(joined, /issue-973-validation/);
  assert.match(joined, /abc12345/);
  assert.doesNotMatch(joined, /removed from live history/);
  assert.match(joined, /retained/i);
  assert.match(joined, /read-only inspection/i);
  assert.match(joined, /Active stage work was aborted/);
  assert.doesNotMatch(joined, /close/);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
  }
});

test("workflow killed notice handles paused runs without active stages", () => {
  const theme = deriveGraphTheme({});
  const lines = renderWorkflowKilledNotice({
    width: 72,
    theme,
    run: makeRun({
      id: "abc12345-0000-0000-0000-000000000000",
      name: "paused-workflow",
      status: "paused",
      stages: [{ id: "s1", name: "await-input", status: "paused", parentIds: [], toolEvents: [] }],
    }),
    previousStatus: "paused",
  });
  const joined = lines.join("\n");
  assert.match(joined, /no stages were actively running/i);
  assert.doesNotMatch(joined, /Active stage work was aborted/);
});

test("workflow killed notice stays within narrow panes", () => {
  const theme = deriveGraphTheme({});
  const width = 40;
  const lines = renderWorkflowKilledNotice({
    width,
    theme,
    run: makeRun({
      id: "abc12345-0000-0000-0000-000000000000",
      name: "very-long-workflow-name-that-must-fit",
      status: "running",
      stages: [{ id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] }],
    }),
    previousStatus: "running",
  });
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
  }
});

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
