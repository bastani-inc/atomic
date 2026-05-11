/**
 * Tests for buildUIAdapter — maps pi ctx.ui dialog surface to WorkflowUIAdapter.
 *
 * cross-ref: packages/pi-workflows/src/extension/wiring.ts buildUIAdapter
 *            packages/pi-workflows/src/shared/types.ts WorkflowUIAdapter
 */

import { test, expect, describe } from "bun:test";
import { buildUIAdapter } from "./wiring.js";
import type { PiUISurface, UIWiringSurface } from "./wiring.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function piWith(ui: PiUISurface): UIWiringSurface {
  return { ui };
}

// ---------------------------------------------------------------------------
// buildUIAdapter — absent / degraded surface
// ---------------------------------------------------------------------------

describe("buildUIAdapter — absent surface", () => {
  test("returns undefined when pi.ui is absent", () => {
    expect(buildUIAdapter({})).toBeUndefined();
  });

  test("returns undefined when pi.ui is present but has no dialog methods", () => {
    // setWidget-only object (widget surface but no dialog methods)
    expect(buildUIAdapter({ ui: {} as PiUISurface })).toBeUndefined();
  });

  test("returns adapter when at least one dialog method present", () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_title) => "x",
    }));
    expect(adapter).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildUIAdapter — input
// ---------------------------------------------------------------------------

describe("buildUIAdapter — input", () => {
  test("delegates to pi.ui.input using prompt as title", async () => {
    const calls: string[] = [];
    const adapter = buildUIAdapter(piWith({
      input: async (title) => { calls.push(title); return "typed text"; },
    }))!;
    const result = await adapter.input("Your name?");
    expect(calls).toEqual(["Your name?"]);
    expect(result).toBe("typed text");
  });

  test("returns empty string when pi.ui.input returns undefined (dismissed)", async () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_title) => undefined,
    }))!;
    expect(await adapter.input("prompt")).toBe("");
  });

  test("returns empty string when pi.ui.input is absent", async () => {
    // Only confirm present — input fallback returns ""
    const adapter = buildUIAdapter(piWith({
      confirm: async (_t, _m) => true,
    }))!;
    expect(await adapter.input("prompt")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildUIAdapter — confirm
// ---------------------------------------------------------------------------

describe("buildUIAdapter — confirm", () => {
  test("passes message as both title and message args to pi.ui.confirm", async () => {
    const calls: Array<[string, string]> = [];
    const adapter = buildUIAdapter(piWith({
      confirm: async (title, message) => { calls.push([title, message]); return true; },
    }))!;
    const result = await adapter.confirm("Delete everything?");
    expect(calls).toEqual([["Delete everything?", "Delete everything?"]]);
    expect(result).toBe(true);
  });

  test("returns false when pi.ui.confirm is absent", async () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_t) => "x",
    }))!;
    expect(await adapter.confirm("Are you sure?")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildUIAdapter — select
// ---------------------------------------------------------------------------

describe("buildUIAdapter — select", () => {
  test("delegates to pi.ui.select with spread options array", async () => {
    const calls: Array<[string, string[]]> = [];
    const adapter = buildUIAdapter(piWith({
      select: async (title, options) => { calls.push([title, options]); return "b"; },
    }))!;
    const result = await adapter.select("Pick one", ["a", "b", "c"] as const);
    expect(calls).toEqual([["Pick one", ["a", "b", "c"]]]);
    expect(result).toBe("b");
  });

  test("returns first option when pi.ui.select returns undefined (dismissed)", async () => {
    const adapter = buildUIAdapter(piWith({
      select: async (_title, _opts) => undefined,
    }))!;
    const result = await adapter.select("Pick", ["x", "y"] as const);
    expect(result).toBe("x");
  });

  test("returns first option when pi.ui.select is absent", async () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_t) => "ignored",
    }))!;
    const result = await adapter.select("Pick", ["alpha", "beta"] as const);
    expect(result).toBe("alpha");
  });

  test("preserves generic T type — result assignable to original union", async () => {
    type Color = "red" | "green" | "blue";
    const adapter = buildUIAdapter(piWith({
      select: async (_t, _o) => "green",
    }))!;
    const result: Color = await adapter.select("Color?", ["red", "green", "blue"] as const);
    expect(result).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// buildUIAdapter — editor
// ---------------------------------------------------------------------------

describe("buildUIAdapter — editor", () => {
  test("delegates to pi.ui.editor with empty-string title and prefill", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const adapter = buildUIAdapter(piWith({
      editor: async (title, prefill) => { calls.push([title, prefill]); return "edited"; },
    }))!;
    const result = await adapter.editor("initial content");
    expect(calls).toEqual([["", "initial content"]]);
    expect(result).toBe("edited");
  });

  test("passes undefined prefill when no initial provided", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const adapter = buildUIAdapter(piWith({
      editor: async (title, prefill) => { calls.push([title, prefill]); return "x"; },
    }))!;
    await adapter.editor();
    expect(calls[0]).toEqual(["", undefined]);
  });

  test("returns initial when pi.ui.editor returns undefined (dismissed)", async () => {
    const adapter = buildUIAdapter(piWith({
      editor: async (_t, _p) => undefined,
    }))!;
    expect(await adapter.editor("fallback text")).toBe("fallback text");
  });

  test("returns empty string when dismissed and no initial", async () => {
    const adapter = buildUIAdapter(piWith({
      editor: async (_t, _p) => undefined,
    }))!;
    expect(await adapter.editor()).toBe("");
  });

  test("returns empty string when pi.ui.editor is absent", async () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_t) => "x",
    }))!;
    expect(await adapter.editor("init")).toBe("init");
  });
});

// ---------------------------------------------------------------------------
// Integration — full surface present
// ---------------------------------------------------------------------------

describe("buildUIAdapter — full pi surface", () => {
  test("all four methods delegate correctly in sequence", async () => {
    const log: string[] = [];
    const adapter = buildUIAdapter(piWith({
      input: async (t) => { log.push(`input:${t}`); return "alice"; },
      confirm: async (t, m) => { log.push(`confirm:${t}:${m}`); return false; },
      select: async (t, o) => { log.push(`select:${t}`); return o[1]; },
      editor: async (_t, p) => { log.push(`editor:${p ?? ""}`); return "done"; },
    }))!;

    expect(await adapter.input("Name?")).toBe("alice");
    expect(await adapter.confirm("Sure?")).toBe(false);
    expect(await adapter.select("Mode?", ["a", "b", "c"] as const)).toBe("b");
    expect(await adapter.editor("draft")).toBe("done");

    expect(log).toEqual([
      "input:Name?",
      "confirm:Sure?:Sure?",
      "select:Mode?",
      "editor:draft",
    ]);
  });
});
