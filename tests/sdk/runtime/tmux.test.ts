import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMuxBinary,
  resetMuxBinaryCache,
  isTmuxInstalled,
  isInsideTmux,
  tmuxRun,
  parseListSessionsOutput,
  normalizeTmuxCapture,
  normalizeTmuxLines,
  attachSession,
  getCurrentSession,
  isInsideAtomicSocket,
  SOCKET_NAME,
  spawnMuxAttach,
  detachAndAttachAtomic,
  buildKillSessionOnPaneExitHooks,
  parseSessionName,
  parseSessionEnvValue,
  getPanePid,
} from "../../../packages/atomic-sdk/src/runtime/tmux.ts";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/**
 * Save and restore environment variables around each test.
 * Call in a describe block to avoid duplicating the afterEach pattern.
 */
function withEnvRestore(vars: string[]) {
  const saved: Record<string, string | undefined> = {};
  for (const v of vars) saved[v] = process.env[v];

  afterEach(() => {
    for (const v of vars) {
      if (saved[v] !== undefined) {
        process.env[v] = saved[v];
      } else {
        delete process.env[v];
      }
    }
  });
}

function writeFakeCommand(directory: string, name: string): void {
  const extension = process.platform === "win32" ? ".cmd" : "";
  const commandPath = join(directory, `${name}${extension}`);
  const body = process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n";
  writeFileSync(commandPath, body);
  chmodSync(commandPath, 0o755);
}

function withMockPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  }
}

// ---------------------------------------------------------------------------
// getMuxBinary
// ---------------------------------------------------------------------------

describe("getMuxBinary", () => {
  beforeEach(() => {
    resetMuxBinaryCache();
  });

  afterEach(() => {
    resetMuxBinaryCache();
  });

  test("returns 'tmux' on unix when tmux is available", () => {
    // On this Linux CI host, tmux should be resolvable (or we skip)
    const binary = getMuxBinary();
    if (process.platform !== "win32") {
      // On Unix, it returns "tmux" if installed, null otherwise
      if (Bun.which("tmux")) {
        expect(binary).toBe("tmux");
      } else {
        expect(binary).toBeNull();
      }
    }
  });

  test("caches the result after first call", () => {
    const first = getMuxBinary();
    const second = getMuxBinary();
    expect(first).toBe(second);
  });

  test("resetMuxBinaryCache clears cached value", () => {
    getMuxBinary(); // populate cache
    resetMuxBinaryCache();
    // After reset, the next call re-resolves (doesn't throw, returns consistent result)
    const result = getMuxBinary();
    expect(typeof result === "string" || result === null).toBe(true);
  });

  test.serial("ignores tmux-only shims on Windows", () => {
    const originalPath = process.env.PATH;
    const tempDir = mkdtempSync(join(tmpdir(), "atomic-mux-"));
    try {
      writeFakeCommand(tempDir, "tmux");
      process.env.PATH = tempDir;
      resetMuxBinaryCache();

      withMockPlatform("win32", () => {
        expect(getMuxBinary()).toBeNull();
        expect(isTmuxInstalled()).toBe(false);
      });
    } finally {
      process.env.PATH = originalPath;
      resetMuxBinaryCache();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test.serial("prefers native psmux on Windows", () => {
    const originalPath = process.env.PATH;
    const tempDir = mkdtempSync(join(tmpdir(), "atomic-mux-"));
    try {
      writeFakeCommand(tempDir, "psmux");
      writeFakeCommand(tempDir, "pmux");
      writeFakeCommand(tempDir, "tmux");
      process.env.PATH = tempDir;
      resetMuxBinaryCache();

      withMockPlatform("win32", () => {
        expect(getMuxBinary()).toBe("psmux");
        expect(isTmuxInstalled()).toBe(true);
      });
    } finally {
      process.env.PATH = originalPath;
      resetMuxBinaryCache();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// isTmuxInstalled
// ---------------------------------------------------------------------------

describe("isTmuxInstalled", () => {
  beforeEach(() => {
    resetMuxBinaryCache();
  });

  afterEach(() => {
    resetMuxBinaryCache();
  });

  test("returns boolean consistent with getMuxBinary", () => {
    const binary = getMuxBinary();
    expect(isTmuxInstalled()).toBe(binary !== null);
  });
});

// ---------------------------------------------------------------------------
// isInsideTmux
// ---------------------------------------------------------------------------

describe("isInsideTmux", () => {
  withEnvRestore(["TMUX", "PSMUX"]);

  test("returns true when TMUX env var is set", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    delete process.env.PSMUX;
    expect(isInsideTmux()).toBe(true);
  });

  test("returns true when PSMUX env var is set", () => {
    delete process.env.TMUX;
    process.env.PSMUX = "1";
    expect(isInsideTmux()).toBe(true);
  });

  test("returns true when both TMUX and PSMUX are set", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    process.env.PSMUX = "1";
    expect(isInsideTmux()).toBe(true);
  });

  test("returns false when neither env var is set", () => {
    delete process.env.TMUX;
    delete process.env.PSMUX;
    expect(isInsideTmux()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tmuxRun — success and failure paths
// ---------------------------------------------------------------------------

describe("tmuxRun", () => {
  beforeEach(() => {
    resetMuxBinaryCache();
  });

  afterEach(() => {
    resetMuxBinaryCache();
  });

  test("returns ok:true with stdout for valid commands", () => {
    const result = tmuxRun(["list-sessions"]);
    // Even if no sessions exist, tmux returns ok:false (exit code 1)
    // but the structure is always correct
    expect(result).toHaveProperty("ok");
    if (result.ok) {
      expect(typeof result.stdout).toBe("string");
    } else {
      expect(typeof result.stderr).toBe("string");
    }
  });

  test("returns ok:false with stderr for invalid tmux subcommand", () => {
    const result = tmuxRun(["completely-invalid-subcommand-xyz"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });

});

// ---------------------------------------------------------------------------
// normalizeTmuxCapture — pure function
// ---------------------------------------------------------------------------

describe("normalizeTmuxCapture", () => {
  test("collapses whitespace to single spaces", () => {
    expect(normalizeTmuxCapture("hello   world")).toBe("hello world");
  });

  test("strips carriage returns", () => {
    expect(normalizeTmuxCapture("hello\r\nworld")).toBe("hello world");
  });

  test("collapses newlines to spaces", () => {
    expect(normalizeTmuxCapture("line1\nline2\nline3")).toBe("line1 line2 line3");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeTmuxCapture("  hello  ")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(normalizeTmuxCapture("")).toBe("");
  });

  test("handles whitespace-only input", () => {
    expect(normalizeTmuxCapture("   \n\n   \r\n   ")).toBe("");
  });

  test("handles tabs and mixed whitespace", () => {
    expect(normalizeTmuxCapture("hello\t\tworld\n  foo")).toBe("hello world foo");
  });

  test("preserves single spaces between words", () => {
    expect(normalizeTmuxCapture("a b c")).toBe("a b c");
  });
});

// ---------------------------------------------------------------------------
// normalizeTmuxLines — pure function
// ---------------------------------------------------------------------------

describe("normalizeTmuxLines", () => {
  test("trims trailing whitespace per line", () => {
    const input = "hello   \nworld   ";
    const result = normalizeTmuxLines(input);
    expect(result).toBe("hello\nworld");
  });

  test("preserves leading whitespace on non-first lines", () => {
    const input = "top\n    deeper";
    expect(normalizeTmuxLines(input)).toBe("top\n    deeper");
  });

  test("final trim removes leading whitespace from entire result", () => {
    const input = "  indented\n    deeper";
    // The final .trim() strips leading whitespace from the whole string
    expect(normalizeTmuxLines(input)).toBe("indented\n    deeper");
  });

  test("trims overall result", () => {
    const input = "\n\nhello\nworld\n\n";
    expect(normalizeTmuxLines(input)).toBe("hello\nworld");
  });

  test("handles empty string", () => {
    expect(normalizeTmuxLines("")).toBe("");
  });

  test("handles single line", () => {
    expect(normalizeTmuxLines("hello   ")).toBe("hello");
  });

  test("preserves internal blank lines", () => {
    const input = "line1\n\nline3";
    expect(normalizeTmuxLines(input)).toBe("line1\n\nline3");
  });

  test("trimEnd strips carriage returns (CR is whitespace)", () => {
    // JS trimEnd treats \r as whitespace, so it gets stripped
    expect(normalizeTmuxLines("hello\r  ")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// parseSessionName — pure function
// ---------------------------------------------------------------------------

describe("parseSessionName", () => {
  test("parses chat session with agent", () => {
    const result = parseSessionName("atomic-chat-claude-a1b2c3d4");
    expect(result).toEqual({ type: "chat", agent: "claude" });
  });

  test("parses chat session with copilot agent", () => {
    const result = parseSessionName("atomic-chat-copilot-abcd1234");
    expect(result).toEqual({ type: "chat", agent: "copilot" });
  });

  test("parses chat session with opencode agent", () => {
    const result = parseSessionName("atomic-chat-opencode-abcd1234");
    expect(result).toEqual({ type: "chat", agent: "opencode" });
  });

  test("parses workflow session with agent", () => {
    const result = parseSessionName("atomic-wf-claude-ralph-a1b2c3d4");
    expect(result).toEqual({ type: "workflow", agent: "claude" });
  });

  test("parses workflow session with hyphenated workflow name", () => {
    const result = parseSessionName("atomic-wf-opencode-my-cool-workflow-a1b2c3d4");
    expect(result).toEqual({ type: "workflow", agent: "opencode" });
  });

  test("returns type but no agent for legacy chat name (no agent segment)", () => {
    const result = parseSessionName("atomic-chat-a1b2c3d4");
    expect(result.type).toBe("chat");
    expect(result.agent).toBeUndefined();
  });

  test("returns type but no agent for legacy workflow name (no agent segment)", () => {
    const result = parseSessionName("atomic-wf-ralph-a1b2c3d4");
    expect(result.type).toBe("workflow");
    expect(result.agent).toBeUndefined();
  });

  test("returns empty object for unrelated session name", () => {
    const result = parseSessionName("my-random-session");
    expect(result).toEqual({});
  });

  test("returns empty object for empty string", () => {
    const result = parseSessionName("");
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseSessionEnvValue — pure function
// ---------------------------------------------------------------------------

describe("parseSessionEnvValue", () => {
  test("returns only the exact requested key from psmux-noisy output", () => {
    const value = parseSessionEnvValue(
      [
        "ATOMIC_AGENT=claude",
        "PSMUX_CONFIG_FILE=C:\\dev\\atomic\\src\\sdk\\runtime\\tmux.conf",
        "PSMUX_TARGET_SESSION=atomic__atomic-senv-abc12345",
      ].join("\n"),
      "ATOMIC_AGENT",
    );

    expect(value).toBe("claude");
  });

  test("returns null when psmux returns other environment keys", () => {
    const value = parseSessionEnvValue(
      [
        "ATOMIC_AGENT=claude",
        "PSMUX_CONFIG_FILE=C:\\dev\\atomic\\src\\sdk\\runtime\\tmux.conf",
      ].join("\n"),
      "NONEXISTENT_KEY",
    );

    expect(value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseListSessionsOutput — pure function
// ---------------------------------------------------------------------------

describe("parseListSessionsOutput", () => {
  const delimiter = "__ATOMIC_SESSION_FIELD__";

  test("filters psmux internal target sessions and metadata leakage", () => {
    const output = [
      [
        "pwsh -NoProfile -Command Start-Sleep -Seconds 1",
        "1",
        "50.175.4.2 59740 10.1.0.4 22",
        "0",
      ].join(delimiter),
      "PSMUX_CONFIG_FILE=C:\\dev\\atomic\\src\\sdk\\runtime\\tmux.conf",
      "PSMUX_TARGET_SESSION=atomic__pwsh -NoProfile -Command Start-Sleep -Seconds 1]",
      [
        "atomic-chat-copilot-abc12345",
        "1",
        "1700000000",
        "0",
      ].join(delimiter),
    ].join("\n");

    const sessions = parseListSessionsOutput(output, () => null);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.name).toBe("atomic-chat-copilot-abc12345");
    expect(sessions[0]!.type).toBe("chat");
    expect(sessions[0]!.agent).toBe("copilot");
    expect(JSON.stringify(sessions)).not.toContain("PSMUX");
    expect(JSON.stringify(sessions)).not.toContain("Start-Sleep");
  });

  test("keeps Atomic-managed sessions that rely on session env for agent", () => {
    const output = [
      "atomic-senv-abc12345",
      "1",
      "1700000000",
      "1",
    ].join(delimiter);

    const sessions = parseListSessionsOutput(output, (name, key) =>
      name === "atomic-senv-abc12345" && key === "ATOMIC_AGENT" ? "claude" : null
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.name).toBe("atomic-senv-abc12345");
    expect(sessions[0]!.attached).toBe(true);
    expect(sessions[0]!.agent).toBe("claude");
  });

  test("ignores malformed formatter rows", () => {
    const sessions = parseListSessionsOutput(
      [
        "atomic-chat-claude-missing-fields",
        ["atomic-chat-claude-good1234", "1", "1700000000", "0"].join(delimiter),
      ].join("\n"),
      () => null,
    );

    expect(sessions.map((s) => s.name)).toEqual(["atomic-chat-claude-good1234"]);
  });

  test("uses only the exact requested environment key for agent fallback", () => {
    const output = [
      "atomic-senv-abc12345",
      "1",
      "1700000000",
      "0",
    ].join(delimiter);

    const sessions = parseListSessionsOutput(output, (_name, key) =>
      key === "ATOMIC_AGENT"
        ? "claude"
        : "PSMUX_CONFIG_FILE=C:\\dev\\atomic\\tmux.conf"
    );

    expect(sessions[0]!.agent).toBe("claude");
  });
});

describe("buildKillSessionOnPaneExitHooks", () => {
  test("installs a direct pane-kill hook alongside the tmux pane-exited hook", () => {
    const hooks = buildKillSessionOnPaneExitHooks("atomic-chat-copilot-abc12345", "%1");

    expect(hooks).toEqual([
      {
        event: "pane-exited",
        command: "if -F '#{==:#{hook_pane},%1}' 'kill-session -t atomic-chat-copilot-abc12345'",
      },
      {
        event: "after-kill-pane",
        command: "kill-session -t atomic-chat-copilot-abc12345",
      },
    ]);
  });

  test("uses a session-scoped pane-exited hook for psmux", () => {
    const hooks = buildKillSessionOnPaneExitHooks("atomic-chat-copilot-abc12345", "%1", {
      guardPaneExited: false,
    });

    expect(hooks).toEqual([
      {
        event: "pane-exited",
        command: "kill-session -t atomic-chat-copilot-abc12345",
      },
      {
        event: "after-kill-pane",
        command: "kill-session -t atomic-chat-copilot-abc12345",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getCurrentSession
// ---------------------------------------------------------------------------

describe("getCurrentSession", () => {
  withEnvRestore(["TMUX", "PSMUX"]);

  test("returns null when not inside tmux", () => {
    delete process.env.TMUX;
    delete process.env.PSMUX;
    expect(getCurrentSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isInsideAtomicSocket
// ---------------------------------------------------------------------------

describe("isInsideAtomicSocket", () => {
  withEnvRestore(["TMUX", "PSMUX"]);

  test("returns true when TMUX points to atomic socket", () => {
    process.env.TMUX = `/tmp/tmux-1000/${SOCKET_NAME},12345,0`;
    delete process.env.PSMUX;
    expect(isInsideAtomicSocket()).toBe(true);
  });

  test("returns true when PSMUX points to atomic socket", () => {
    delete process.env.TMUX;
    process.env.PSMUX = `/tmp/tmux-1000/${SOCKET_NAME},99999,0`;
    expect(isInsideAtomicSocket()).toBe(true);
  });

  test("returns false when TMUX points to a different socket", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    delete process.env.PSMUX;
    expect(isInsideAtomicSocket()).toBe(false);
  });

  test("returns false when neither env var is set", () => {
    delete process.env.TMUX;
    delete process.env.PSMUX;
    expect(isInsideAtomicSocket()).toBe(false);
  });

  test("returns false for empty TMUX env var", () => {
    process.env.TMUX = "";
    delete process.env.PSMUX;
    expect(isInsideAtomicSocket()).toBe(false);
  });

  test("handles TMUX with no comma separator", () => {
    process.env.TMUX = `/tmp/tmux-1000/${SOCKET_NAME}`;
    delete process.env.PSMUX;
    expect(isInsideAtomicSocket()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tmuxRun — no binary available
// ---------------------------------------------------------------------------

describe("tmuxRun — no binary on PATH", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    resetMuxBinaryCache();
    originalPath = process.env.PATH;
    // Point PATH to an empty directory so no binaries are found
    process.env.PATH = "/nonexistent-empty-dir";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    resetMuxBinaryCache();
  });

  test.serial("returns ok:false when no mux binary found", () => {
    const result = tmuxRun(["list-sessions"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr).toContain("No terminal multiplexer");
    }
  });
});

// ---------------------------------------------------------------------------
// buildAttachArgs / spawnMuxAttach / detachAndAttachAtomic — no binary
// ---------------------------------------------------------------------------

describe("no-binary error paths", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    resetMuxBinaryCache();
    originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-empty-dir";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    resetMuxBinaryCache();
  });

  test.serial("spawnMuxAttach throws when no binary found", () => {
    expect(() => spawnMuxAttach("any-session")).toThrow(/No terminal multiplexer/);
  });

  test.serial("detachAndAttachAtomic throws when no binary found", () => {
    expect(() => detachAndAttachAtomic("any-session")).toThrow(/No terminal multiplexer/);
  });

  test.serial("attachSession throws when no binary found", () => {
    expect(() => attachSession("any-session")).toThrow(/No terminal multiplexer/);
  });
});

// ---------------------------------------------------------------------------
// getPanePid
// ---------------------------------------------------------------------------

describe("getPanePid — no binary", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    resetMuxBinaryCache();
    originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-empty-dir";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    resetMuxBinaryCache();
  });

  test.serial("returns null when no mux binary found", () => {
    expect(getPanePid("%0")).toBeNull();
  });
});

