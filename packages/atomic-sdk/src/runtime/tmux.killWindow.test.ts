/**
 * Unit tests for tmux.killWindow.
 *
 * Integration tests (those that actually invoke tmux) are skipped when the
 * tmux binary is not on PATH. All tests are isolated to a dedicated session
 * name that is torn down in afterAll.
 */

import { test, expect, describe, afterAll } from "bun:test";
import {
  killWindow,
  tmuxRun,
  killSession,
  getMuxBinary,
} from "./tmux.ts";

const hasTmux = !!Bun.which("tmux");

// Unique session name to avoid collisions with real sessions.
const TEST_SESSION = `atomic-test-kw-${Math.random().toString(36).slice(2, 10)}`;

// ---------------------------------------------------------------------------
// Guard: orchestrator window ("0") and empty name
// ---------------------------------------------------------------------------

describe("killWindow — orchestrator window guard", () => {
  test("rejects when windowName is '0'", async () => {
    await expect(killWindow("any-session", "0")).rejects.toThrow(
      "refuses to kill orchestrator window",
    );
  });

  test("rejects when windowName is empty string", async () => {
    await expect(killWindow("any-session", "")).rejects.toThrow(
      "refuses to kill orchestrator window",
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: real tmux session
// ---------------------------------------------------------------------------

describe("killWindow — integration", () => {
  if (!hasTmux) {
    test("skipped: tmux not on PATH", () => {
      expect(getMuxBinary()).toBeNull();
    });
    return;
  }

  // Set up a session with two windows before running integration tests.
  // We create the session in a nested beforeAll-equivalent: since bun:test
  // doesn't allow top-level async describe setup, we do it lazily in the
  // first test via a shared flag, but the cleaner approach is to keep the
  // session creation synchronous here via tmuxRun.

  // Session created once; torn down in afterAll.
  const WINDOW_KEEP = "keep-me";
  const WINDOW_KILL = "kill-me";

  // Create the session with the first window named WINDOW_KEEP.
  // tmux new-session always creates window 0; we rename it.
  const sessionResult = tmuxRun([
    "new-session",
    "-d",
    "-s",
    TEST_SESSION,
    "-n",
    WINDOW_KEEP,
  ]);

  // Add a second window named WINDOW_KILL.
  let windowResult: string | null = null;
  if (sessionResult.ok) {
    const r = tmuxRun(["new-window", "-d", "-t", TEST_SESSION, "-n", WINDOW_KILL, "-P", "-F", "#{pane_id}", "sleep infinity"]);
    windowResult = r.ok ? r.stdout : null;
  }

  afterAll(() => {
    killSession(TEST_SESSION);
  });

  test("session and second window are created successfully", () => {
    expect(sessionResult.ok).toBe(true);
    expect(windowResult).not.toBeNull();
  });

  test("killWindow removes the target window", async () => {
    if (!sessionResult.ok) return; // session setup failed; skip

    await killWindow(TEST_SESSION, WINDOW_KILL);

    const listResult = tmuxRun(["list-windows", "-t", TEST_SESSION, "-F", "#{window_name}"]);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const windows = listResult.stdout.split("\n").filter(Boolean);
    expect(windows).not.toContain(WINDOW_KILL);
    expect(windows).toContain(WINDOW_KEEP);
  });

  test("killWindow resolves even when window no longer exists (idempotent)", async () => {
    if (!sessionResult.ok) return;

    // WINDOW_KILL was already killed in the previous test; calling again should not throw.
    await expect(killWindow(TEST_SESSION, WINDOW_KILL)).resolves.toBeUndefined();
  });
});
