import { test, expect, describe, mock } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import {
  requestRendererBackgroundRepaint,
  resetRendererTerminalBackground,
  setRendererBackground,
  terminalBackgroundColorSequence,
  wrapForTmuxIfNeeded,
} from "../../../src/sdk/components/renderer-background.ts";

function createRendererStub(): CliRenderer {
  return {
    setBackgroundColor: mock(() => {}),
    requestRender: mock(() => {}),
    resetTerminalBgColor: mock(() => {}),
  } as Partial<CliRenderer> as CliRenderer;
}

describe("terminalBackgroundColorSequence", () => {
  test("formats OSC 11 background sync for hex colors", () => {
    expect(terminalBackgroundColorSequence("#1e1e2e")).toBe("\x1b]11;rgb:1e/1e/2e\x07");
  });

  test("accepts hex colors without a leading hash", () => {
    expect(terminalBackgroundColorSequence("eff1f5")).toBe("\x1b]11;rgb:ef/f1/f5\x07");
  });

  test("rejects non-hex colors", () => {
    expect(() => terminalBackgroundColorSequence("transparent")).toThrow("Cannot sync terminal background");
  });
});

describe("wrapForTmuxIfNeeded", () => {
  test("returns raw sequence outside tmux", () => {
    const previousTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      expect(wrapForTmuxIfNeeded("\x1b]11;rgb:1e/1e/2e\x07")).toBe("\x1b]11;rgb:1e/1e/2e\x07");
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
    }
  });

  test("wraps OSC sequences for tmux passthrough", () => {
    const previousTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-test";
    try {
      expect(wrapForTmuxIfNeeded("\x1b]11;rgb:1e/1e/2e\x07")).toBe("\x1bPtmux;\x1b\x1b]11;rgb:1e/1e/2e\x07\x1b\\");
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
    }
  });
});

describe("renderer background helpers", () => {
  test("sets renderer background without syncing terminal by default", () => {
    const renderer = createRendererStub();

    setRendererBackground(renderer, "#1e1e2e");

    expect(renderer.setBackgroundColor).toHaveBeenCalledWith("#1e1e2e");
  });

  test("requests a full repaint before rendering", () => {
    const renderer = createRendererStub();

    requestRendererBackgroundRepaint(renderer);

    expect((renderer as unknown as { forceFullRepaintRequested: boolean }).forceFullRepaintRequested).toBe(true);
    expect(renderer.requestRender).toHaveBeenCalled();
  });

  test("resets terminal background through renderer outside tmux", () => {
    const previousTmux = process.env.TMUX;
    delete process.env.TMUX;
    const renderer = createRendererStub();
    try {
      resetRendererTerminalBackground(renderer);

      expect(renderer.resetTerminalBgColor).toHaveBeenCalled();
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
    }
  });
});
