import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, mock, test } from "bun:test";
import { OptimizedBuffer, RGBA, type CliRenderer } from "@opentui/core";
import type { GraphTheme } from "../../../src/sdk/components/graph-theme.ts";
import {
  createTuiDiagnostics,
  isTuiDiagnosticsEnabled,
  summarizeBuffer,
} from "../../../src/sdk/components/tui-diagnostics.ts";

const graphTheme: GraphTheme = {
  background: "#1e1e2e",
  backgroundElement: "#313244",
  text: "#cdd6f4",
  textMuted: "#a6adc8",
  textDim: "#6c7086",
  primary: "#89b4fa",
  success: "#a6e3a1",
  error: "#f38ba8",
  warning: "#f9e2af",
  info: "#74c7ec",
  mauve: "#cba6f7",
  border: "#45475a",
  borderActive: "#585b70",
};

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createRendererStub(width = 2, height = 1): { renderer: CliRenderer; destroy: () => void } {
  const currentRenderBuffer = OptimizedBuffer.create(width, height, "unicode");
  const nextRenderBuffer = OptimizedBuffer.create(width, height, "unicode");
  const text = RGBA.fromInts(255, 255, 255, 255);
  const background = RGBA.fromInts(30, 30, 46, 255);
  currentRenderBuffer.setCell(0, 0, "a", text, background);
  nextRenderBuffer.setCell(0, 0, "b", text, background);

  return {
    renderer: {
      width,
      height,
      terminalWidth: width,
      terminalHeight: height,
      themeMode: "dark",
      capabilities: { color: true },
      currentRenderBuffer,
      nextRenderBuffer,
      dumpBuffers: mock(() => {}),
      dumpStdoutBuffer: mock(() => {}),
    } as Partial<CliRenderer> as CliRenderer,
    destroy: () => {
      currentRenderBuffer.destroy();
      nextRenderBuffer.destroy();
    },
  };
}

describe("isTuiDiagnosticsEnabled", () => {
  test("requires an explicit opt-in value", () => {
    const previous = process.env.ATOMIC_TUI_DIAGNOSTICS;
    delete process.env.ATOMIC_TUI_DIAGNOSTICS;
    try {
      expect(isTuiDiagnosticsEnabled()).toBe(false);
      process.env.ATOMIC_TUI_DIAGNOSTICS = "1";
      expect(isTuiDiagnosticsEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ATOMIC_TUI_DIAGNOSTICS;
      else process.env.ATOMIC_TUI_DIAGNOSTICS = previous;
    }
  });
});

describe("summarizeBuffer", () => {
  test("groups background colors and flags yellow-hue cells", () => {
    const buffer = OptimizedBuffer.create(4, 2, "unicode");
    try {
      const text = RGBA.fromInts(255, 255, 255, 255);
      const dark = RGBA.fromInts(30, 30, 46, 255);
      const yellow = RGBA.fromInts(249, 226, 175, 255);

      for (let x = 0; x < 4; x++) {
        buffer.setCell(x, 0, "a", text, x < 2 ? yellow : dark);
        buffer.setCell(x, 1, "b", text, dark);
      }

      const summary = summarizeBuffer(buffer);

      expect(summary.width).toBe(4);
      expect(summary.height).toBe(2);
      expect(summary.topBackgrounds[0]).toEqual({
        color: "#1e1e2e",
        count: 6,
        percent: 75,
      });
      expect(summary.topBackgrounds[1]).toEqual({
        color: "#f9e2af",
        count: 2,
        percent: 25,
      });
      expect(summary.yellowHueCells).toBe(2);
      expect(summary.rows[0]?.backgrounds).toEqual([
        { x: 0, width: 2, color: "#f9e2af" },
        { x: 2, width: 2, color: "#1e1e2e" },
      ]);
    } finally {
      buffer.destroy();
    }
  });

  test("handles invalid code points", () => {
    const buffer = OptimizedBuffer.create(1, 1, "unicode");
    try {
      buffer.buffers.char[0] = 0x11_0000;
      const summary = summarizeBuffer(buffer);

      expect(summary.width).toBe(1);
      expect(summary.height).toBe(1);
      expect(summary.topBackgrounds).toEqual([{ color: "#000000", count: 1, percent: 100 }]);
      expect(summary.rows).toEqual([{ y: 0, text: "", backgrounds: [{ x: 0, width: 1, color: "#000000" }] }]);
    } finally {
      buffer.destroy();
    }
  });
});

describe("createTuiDiagnostics", () => {
  test("returns null when diagnostics are disabled", () => {
    const { renderer, destroy } = createRendererStub();
    try {
      withEnv({ ATOMIC_TUI_DIAGNOSTICS: undefined }, () => {
        expect(
          createTuiDiagnostics({
            renderer,
            graphTheme,
            getSnapshot: () => ({
              workflowName: "disabled",
              agent: "copilot",
              prompt: "",
              fatalError: null,
              completionReached: false,
              sessions: [],
              backgroundTaskCount: 0,
              viewMode: "graph",
              activeAgentId: "root",
            }),
          }),
        ).toBeNull();
      });
    } finally {
      destroy();
    }
  });

  test("writes metadata, captures, and dispose files", () => {
    const directory = join(tmpdir(), `atomic-tui-diagnostics-test-${process.pid}-${Date.now()}`);
    const { renderer, destroy } = createRendererStub();
    try {
      withEnv(
        {
          ATOMIC_TUI_DIAGNOSTICS: "1",
          ATOMIC_TUI_DIAGNOSTICS_DIR: directory,
          ATOMIC_TUI_DIAGNOSTICS_MAX: "2",
          ATOMIC_TUI_DIAGNOSTICS_INTERVAL_MS: "60000",
          ATOMIC_TUI_DIAGNOSTICS_OPENTUI_DUMP: "1",
          TERM: "xterm-256color",
          TERM_PROGRAM: "test-terminal",
          COLORTERM: "truecolor",
          TMUX: "/tmp/tmux",
          SSH_TTY: "/dev/pts/1",
        },
        () => {
          mkdirSync(directory, { recursive: true });
          const diagnostics = createTuiDiagnostics({
            renderer,
            graphTheme,
            getSnapshot: () => ({
              workflowName: "workflow",
              agent: "copilot",
              prompt: "prompt",
              fatalError: null,
              completionReached: true,
              sessions: [{ name: "root", status: "complete", parents: [], startedAt: 1, endedAt: 2 }],
              backgroundTaskCount: 1,
              viewMode: "graph",
              activeAgentId: "root",
            }),
          });

          expect(diagnostics).not.toBeNull();
          diagnostics?.capture("manual capture!");
          diagnostics?.capture("over limit");
          diagnostics?.dispose();
          diagnostics?.dispose();

          const files = readdirSync(directory).sort();
          expect(files).toContain("metadata.json");
          expect(files).toContain("latest.json");
          expect(files).toContain("disposed.json");
          expect(files.some((file) => file.endsWith("-created.json"))).toBe(true);
          expect(files.some((file) => file.endsWith("-manual-capture.json"))).toBe(true);
          expect(files.some((file) => file.endsWith("-over-limit.json"))).toBe(false);

          const latest = JSON.parse(readFileSync(join(directory, "latest.json"), "utf8")) as {
            reason: string;
            environment: { TMUX: string | null };
            workflow: { workflowName: string };
          };
          expect(latest.reason).toBe("manual capture!");
          expect(latest.environment.TMUX).toBe("/tmp/tmux");
          expect(latest.workflow.workflowName).toBe("workflow");
          expect(renderer.dumpBuffers).toHaveBeenCalled();
          expect(renderer.dumpStdoutBuffer).toHaveBeenCalled();
        },
      );
    } finally {
      destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
