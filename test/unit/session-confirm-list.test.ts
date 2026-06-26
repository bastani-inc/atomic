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
  renderWorkflowQuitConfirm,
} from "../../packages/workflows/src/tui/session-confirm.ts";
import { renderSessionList } from "../../packages/workflows/src/tui/session-list.ts";
import { openKillConfirm, openWorkflowQuitConfirm } from "../../packages/workflows/src/tui/session-overlays.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.ts";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

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

test("kill confirm: y always confirms, n / esc / Ctrl+C variants cancel", () => {
  const s = createKillConfirmState();
  assert.deepEqual(handleKillConfirmInput("y", s), { kind: "confirm" });
  assert.deepEqual(handleKillConfirmInput("Y", s), { kind: "confirm" });
  assert.deepEqual(handleKillConfirmInput("n", s), { kind: "cancel" });
  assert.deepEqual(handleKillConfirmInput(Key.escape, s), { kind: "cancel" });
  for (const key of [Key.ctrl("c"), "ctrl+C", "\x03", "\x1b[99;5u", "\x1b[99;5:1u", "\x1b[27;5;99~"]) {
    assert.deepEqual(handleKillConfirmInput(key, s), { kind: "cancel" });
  }
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
  const plain = stripAnsi(joined);
  assert.match(plain, /y Kill/);
  assert.match(plain, /enter Cancel/);
  assert.doesNotMatch(plain, /enter Confirm/);
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

test("confirm modal rows use panel tokens instead of graph canvas tokens", () => {
  const theme = deriveGraphTheme({
    bg: "#010203",
    surface: "#020304",
    backgroundPanel: "#fafafa",
    backgroundElement: "#f4f4f5",
  });
  const state = createKillConfirmState();
  const run = makeRun({
    id: "abc12345-0000-0000-0000-000000000000",
    name: "panel-theme",
    status: "running",
    startedAt: 1000,
    stages: [{ id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] }],
  });

  const kill = renderKillConfirm({ width: 70, theme, run, state, now: 5000 }).join("\n");
  const quit = renderWorkflowQuitConfirm({ width: 76, theme, state, now: 5000, runs: [run] }).join("\n");

  for (const rendered of [kill, quit]) {
    assert.match(rendered, /\x1b\[48;2;250;250;250m/);
    assert.match(rendered, /\x1b\[48;2;244;244;245m/);
    assert.doesNotMatch(rendered, /\x1b\[48;2;1;2;3m/);
    assert.doesNotMatch(rendered, /\x1b\[48;2;2;3;4m/);
  }
});

test("confirm footers describe Enter as the currently focused button", () => {
  const theme = deriveGraphTheme({});
  const run = makeRun({
    id: "abc12345-0000-0000-0000-000000000000",
    name: "footer-theme",
    stages: [{ id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] }],
  });

  const killDefault = createKillConfirmState();
  const killDefaultPlain = stripAnsi(renderKillConfirm({ width: 80, theme, run, state: killDefault }).join("\n"));
  assert.match(killDefaultPlain, /enter Cancel/);
  assert.doesNotMatch(killDefaultPlain, /enter Confirm/);

  const killFocused = createKillConfirmState();
  handleKillConfirmInput(Key.tab, killFocused);
  const killFocusedPlain = stripAnsi(renderKillConfirm({ width: 80, theme, run, state: killFocused }).join("\n"));
  assert.match(killFocusedPlain, /enter Kill/);

  const quitDefault = createKillConfirmState();
  const quitDefaultPlain = stripAnsi(renderWorkflowQuitConfirm({ width: 84, theme, runs: [run], state: quitDefault }).join("\n"));
  assert.match(quitDefaultPlain, /enter Cancel/);
  assert.doesNotMatch(quitDefaultPlain, /enter Confirm/);

  const quitFocused = createKillConfirmState();
  handleKillConfirmInput(Key.tab, quitFocused);
  const quitFocusedPlain = stripAnsi(renderWorkflowQuitConfirm({ width: 84, theme, runs: [run], state: quitFocused }).join("\n"));
  assert.match(quitFocusedPlain, /enter Quit & kill/);
});

test("workflow quit confirm defaults to cancel and renders active-run summary", () => {
  const theme = deriveGraphTheme({});
  const state = createKillConfirmState();
  const lines = renderWorkflowQuitConfirm({
    width: 76,
    theme,
    state,
    now: 61_000,
    runs: [
      makeRun({
        id: "abc12345-0000-0000-0000-000000000000",
        name: "alpha",
        startedAt: 1_000,
        stages: [{ id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] }],
      }),
      makeRun({
        id: "def67890-0000-0000-0000-000000000000",
        name: "beta",
        startedAt: 31_000,
        stages: [{ id: "s2", name: "build", status: "pending", parentIds: [], toolEvents: [] }],
      }),
    ],
  });

  assert.equal(state.focusedButton, 0);
  assert.deepEqual(handleKillConfirmInput(Key.enter, state), { kind: "cancel" });
  const joined = lines.join("\n");
  const plain = stripAnsi(joined);
  assert.match(joined, /Quit with active workflows/);
  assert.match(joined, /2 in-flight workflows/);
  assert.match(joined, /Quit & kill/);
  assert.match(plain, /y Quit & kill/);
  assert.match(plain, /enter Cancel/);
  assert.doesNotMatch(plain, /enter Confirm/);
  assert.doesNotMatch(plain, /y Kill/);
  assert.match(joined, /Killed runs are retained/);
  assert.match(joined, /alpha/);
  assert.match(joined, /beta/);
});

test("workflow quit confirm fails open when custom UI rejects or never mounts", async () => {
  const theme = deriveGraphTheme({});
  const runs = [makeRun({ id: "run-quit" })];

  assert.equal(
    await openWorkflowQuitConfirm(
      {
        custom: () => Promise.reject(new Error("custom unavailable")),
      },
      runs,
      theme,
    ),
    undefined,
  );

  let factoryCalls = 0;
  assert.equal(
    await openWorkflowQuitConfirm(
      {
        custom: () => {
          factoryCalls += 1;
          return undefined;
        },
      },
      runs,
      theme,
    ),
    undefined,
  );
  assert.equal(factoryCalls, 1);
});

test("kill confirm cancels safely when custom UI rejects or never mounts", async () => {
  const theme = deriveGraphTheme({});
  const run = makeRun({ id: "run-kill" });

  assert.equal(
    await openKillConfirm(
      {
        custom: () => Promise.reject(new Error("custom unavailable")),
      },
      run,
      theme,
    ),
    false,
  );

  let factoryCalls = 0;
  assert.equal(
    await openKillConfirm(
      {
        custom: () => {
          factoryCalls += 1;
          return undefined;
        },
      },
      run,
      theme,
    ),
    false,
  );
  assert.equal(factoryCalls, 1);
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
