import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CliRenderer, OptimizedBuffer } from "@opentui/core";
import type { GraphTheme } from "./graph-theme.ts";
import type { SessionData } from "./orchestrator-panel-types.ts";

type BackgroundRun = {
  x: number;
  width: number;
  color: string;
};

type BufferRowDiagnostic = {
  y: number;
  text: string;
  backgrounds: BackgroundRun[];
};

type ColorCount = {
  color: string;
  count: number;
  percent: number;
};

export type BufferDiagnostic = {
  width: number;
  height: number;
  topBackgrounds: ColorCount[];
  yellowHueCells: number;
  yellowHueSamples: Array<{ x: number; y: number; color: string; char: string }>;
  rows: BufferRowDiagnostic[];
};

export type WorkflowDiagnosticSnapshot = {
  workflowName: string;
  agent: string;
  prompt: string;
  fatalError: string | null;
  completionReached: boolean;
  sessions: readonly SessionData[];
  backgroundTaskCount: number;
  viewMode: string;
  activeAgentId: string;
};

export type TuiDiagnostics = {
  capture: (reason: string) => void;
  dispose: () => void;
};

type TuiDiagnosticsOptions = {
  renderer: CliRenderer;
  graphTheme: GraphTheme;
  getSnapshot: () => WorkflowDiagnosticSnapshot;
};

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CAPTURES = 45;

export function isTuiDiagnosticsEnabled(): boolean {
  const value = process.env.ATOMIC_TUI_DIAGNOSTICS;
  return value === "1" || value === "true" || value === "yes";
}

export function createTuiDiagnostics({
  renderer,
  graphTheme,
  getSnapshot,
}: TuiDiagnosticsOptions): TuiDiagnostics | null {
  if (!isTuiDiagnosticsEnabled()) return null;

  const directory = resolveDiagnosticsDirectory();
  mkdirSync(directory, { recursive: true });

  let sequence = 0;
  let disposed = false;
  const maxCaptures = readPositiveInt(process.env.ATOMIC_TUI_DIAGNOSTICS_MAX, DEFAULT_MAX_CAPTURES);
  const intervalMs = readPositiveInt(process.env.ATOMIC_TUI_DIAGNOSTICS_INTERVAL_MS, DEFAULT_INTERVAL_MS);

  writeJson(join(directory, "metadata.json"), {
    directory,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    environment: diagnosticEnvironment(),
    graphTheme,
  });

  const capture = (reason: string): void => {
    if (disposed || sequence >= maxCaptures) return;
    sequence++;
    const timestamp = Date.now();
    const payload = {
      sequence,
      reason,
      capturedAt: new Date(timestamp).toISOString(),
      environment: diagnosticEnvironment(),
      renderer: {
        width: renderer.width,
        height: renderer.height,
        terminalWidth: renderer.terminalWidth,
        terminalHeight: renderer.terminalHeight,
        themeMode: renderer.themeMode,
        capabilities: cloneJson(renderer.capabilities),
      },
      graphTheme,
      workflow: getSnapshot(),
      currentRenderBuffer: summarizeBuffer(renderer.currentRenderBuffer),
      nextRenderBuffer: summarizeBuffer(renderer.nextRenderBuffer),
    };

    writeJson(join(directory, `${String(sequence).padStart(4, "0")}-${sanitizeReason(reason)}.json`), payload);
    writeJson(join(directory, "latest.json"), payload);

    if (process.env.ATOMIC_TUI_DIAGNOSTICS_OPENTUI_DUMP === "1") {
      renderer.dumpBuffers(timestamp);
      renderer.dumpStdoutBuffer(timestamp);
    }
  };

  const timer = setInterval(() => capture("interval"), intervalMs);
  capture("created");

  return {
    capture,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      writeJson(join(directory, "disposed.json"), {
        disposedAt: new Date().toISOString(),
        captures: sequence,
      });
    },
  };
}

export function summarizeBuffer(buffer: OptimizedBuffer): BufferDiagnostic {
  const raw = buffer.buffers;
  const width = buffer.width;
  const height = buffer.height;
  const counts = new Map<string, number>();
  const rows: BufferRowDiagnostic[] = [];
  const yellowHueSamples: Array<{ x: number; y: number; color: string; char: string }> = [];
  let yellowHueCells = 0;

  for (let y = 0; y < height; y++) {
    const backgrounds: BackgroundRun[] = [];
    let text = "";
    let currentColor = "";
    let runStart = 0;

    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const color = readColor(raw.bg, index);
      const char = readChar(raw.char[index] ?? 0);
      text += char;

      counts.set(color, (counts.get(color) ?? 0) + 1);
      if (isYellowHue(color)) {
        yellowHueCells++;
        if (yellowHueSamples.length < 40) {
          yellowHueSamples.push({ x, y, color, char });
        }
      }

      if (x === 0) {
        currentColor = color;
        runStart = 0;
      } else if (color !== currentColor) {
        backgrounds.push({ x: runStart, width: x - runStart, color: currentColor });
        currentColor = color;
        runStart = x;
      }
    }

    if (width > 0) {
      backgrounds.push({ x: runStart, width: width - runStart, color: currentColor });
    }
    rows.push({ y, text: text.trimEnd(), backgrounds });
  }

  const total = Math.max(1, width * height);
  const topBackgrounds = Array.from(counts.entries())
    .map(([color, count]) => ({
      color,
      count,
      percent: Math.round((count / total) * 10_000) / 100,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 16);

  return {
    width,
    height,
    topBackgrounds,
    yellowHueCells,
    yellowHueSamples,
    rows,
  };
}

function resolveDiagnosticsDirectory(): string {
  const explicit = process.env.ATOMIC_TUI_DIAGNOSTICS_DIR;
  if (explicit && explicit.trim() !== "") return explicit;
  return join(tmpdir(), `atomic-tui-diagnostics-${process.pid}`);
}

function diagnosticEnvironment(): Record<string, string | null> {
  return {
    TERM: process.env.TERM ?? null,
    TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,
    COLORTERM: process.env.COLORTERM ?? null,
    TMUX: process.env.TMUX ?? null,
    SSH_TTY: process.env.SSH_TTY ?? null,
  };
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeJson(path: string, value: object): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeReason(reason: string): string {
  const sanitized = reason.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return sanitized === "" ? "capture" : sanitized;
}

function readColor(buffer: Uint16Array, cellIndex: number): string {
  const offset = cellIndex * 4;
  return `#${toHex(buffer[offset] ?? 0)}${toHex(buffer[offset + 1] ?? 0)}${toHex(buffer[offset + 2] ?? 0)}`;
}

function toHex(value: number): string {
  const clamped = Math.max(0, Math.min(255, value));
  return clamped.toString(16).padStart(2, "0");
}

function readChar(codePoint: number): string {
  if (codePoint <= 0 || codePoint > 0x10ffff) return " ";
  return String.fromCodePoint(codePoint);
}

function isYellowHue(color: string): boolean {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max < 32 || max === min) return false;

  const saturation = (max - min) / max;
  if (saturation < 0.12) return false;

  const hue =
    max === red
      ? ((green - blue) / (max - min)) * 60
      : max === green
        ? (2 + (blue - red) / (max - min)) * 60
        : (4 + (red - green) / (max - min)) * 60;
  const normalizedHue = hue < 0 ? hue + 360 : hue;
  return normalizedHue >= 35 && normalizedHue <= 85;
}

function cloneJson(value: object | null): object | null {
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value)) as object;
}
