/**
 * Tests for createRegistry() — immutable chainable workflow registry.
 */

import { test, expect, describe, spyOn, afterEach } from "bun:test";
import { createRegistry } from "../../src/sdk/registry.ts";
import { defineWorkflow } from "../../src/sdk/define-workflow.ts";
import type { WorkflowDefinition } from "../../src/sdk/types.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Inline definitions so TypeScript infers literal agent and name types —
// makeWorkflow() with explicit return annotation WorkflowDefinition erases
// those literals and breaks the type-accumulation test at the bottom.
const wfA = defineWorkflow({ name: "alpha", source: import.meta.path }).for("claude").run(async (_ctx) => {}).compile();
const wfB = defineWorkflow({ name: "beta", source: import.meta.path }).for("opencode").run(async (_ctx) => {}).compile();
const wfC = defineWorkflow({ name: "gamma", source: import.meta.path }).for("copilot").run(async (_ctx) => {}).compile();

// ─── createRegistry() ─────────────────────────────────────────────────────────

describe("createRegistry()", () => {
  test("returns empty registry — list() is empty", () => {
    const r = createRegistry();
    expect(r.list()).toHaveLength(0);
  });

  test("returns empty registry — has() is false for any key", () => {
    const r = createRegistry();
    expect(r.has("claude/alpha")).toBe(false);
    expect(r.has("opencode/beta")).toBe(false);
    expect(r.has("anything")).toBe(false);
  });
});

// ─── .register(wf) ────────────────────────────────────────────────────────────

describe(".register(wf)", () => {
  test("returns a NEW registry instance", () => {
    const r0 = createRegistry();
    const r1 = r0.register(wfA);
    expect(r1).not.toBe(r0);
  });

  test("original registry unchanged after register (immutability)", () => {
    const r0 = createRegistry();
    r0.register(wfA);
    expect(r0.list()).toHaveLength(0);
    expect(r0.has("claude/alpha")).toBe(false);
  });

  test("adds workflow at key ${agent}/${name}", () => {
    const r = createRegistry().register(wfA);
    expect(r.has("claude/alpha")).toBe(true);
    expect(r.get("claude/alpha")).toBe(wfA);
  });

  test("chainable — register three workflows lists all three", () => {
    const r = createRegistry()
      .register(wfA)
      .register(wfB)
      .register(wfC);
    expect(r.list()).toHaveLength(3);
  });

  test("duplicate key throws with exact error message", () => {
    const r = createRegistry().register(wfA);
    expect(() => r.register(wfA)).toThrow(
      '[atomic] Duplicate workflow registration: "claude/alpha" is already registered.',
    );
  });
});

// ─── .get(key) ────────────────────────────────────────────────────────────────

describe(".get(key)", () => {
  test("typed lookup returns the registered workflow", () => {
    const r = createRegistry().register(wfA);
    const result = r.get("claude/alpha");
    expect(result).toBe(wfA);
    expect(result.name).toBe("alpha");
    expect(result.agent).toBe("claude");
  });

  test("missing key throws with exact error message", () => {
    const r = createRegistry();
    expect(() => r.get("claude/missing" as never)).toThrow(
      '[atomic] Workflow "claude/missing" is not registered.',
    );
  });
});

// ─── .has(key) ────────────────────────────────────────────────────────────────

describe(".has(key)", () => {
  test("true for registered key", () => {
    const r = createRegistry().register(wfB);
    expect(r.has("opencode/beta")).toBe(true);
  });

  test("false for unregistered key", () => {
    const r = createRegistry().register(wfB);
    expect(r.has("claude/alpha")).toBe(false);
    expect(r.has("opencode/missing")).toBe(false);
  });
});

// ─── .list() ──────────────────────────────────────────────────────────────────

describe(".list()", () => {
  test("insertion order matches", () => {
    const r = createRegistry()
      .register(wfA)
      .register(wfB)
      .register(wfC);
    const list = r.list();
    expect(list[0]).toBe(wfA);
    expect(list[1]).toBe(wfB);
    expect(list[2]).toBe(wfC);
  });

  test("result is frozen (push throws)", () => {
    const r = createRegistry().register(wfA);
    const list = r.list();
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => (list as WorkflowDefinition[]).push(wfB)).toThrow();
  });
});

// ─── .resolve(name, agent) ────────────────────────────────────────────────────

describe(".resolve(name, agent)", () => {
  test("returns the workflow when (name, agent) pair exists", () => {
    const r = createRegistry().register(wfA).register(wfB);
    expect(r.resolve("alpha", "claude")).toBe(wfA);
    expect(r.resolve("beta", "opencode")).toBe(wfB);
  });

  test("returns undefined for unknown pair", () => {
    const r = createRegistry().register(wfA);
    expect(r.resolve("alpha", "opencode")).toBeUndefined();
    expect(r.resolve("missing", "claude")).toBeUndefined();
  });
});

// ─── Validator-on-register ────────────────────────────────────────────────────

describe("validator-on-register", () => {
  afterEach(() => {
    // Restore console.warn after each test
  });

  test("warnings from provider validator surface via console.warn with [registry] prefix", () => {
    // Build a copilot workflow whose run function contains the banned pattern
    const wfWithWarning = defineWorkflow({ name: "bad-copilot", source: import.meta.path })
      .for("copilot")
      .run(async (_ctx) => {
        // new CopilotClient() — matches the banned pattern
      })
      .compile();

    // Override toString so the validator sees the banned pattern
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The run function body must contain the trigger. We patch toString here
      // since Bun's compiled function body strips comments.
      const original = wfWithWarning.run.toString;
      wfWithWarning.run.toString = () => "async (_ctx) => { new CopilotClient(); }";

      createRegistry().register(wfWithWarning);

      // At least one warn call should have [registry] prefix
      const calls = spy.mock.calls;
      const hasRegistryPrefix = calls.some(
        (args) => typeof args[0] === "string" && args[0].startsWith("[registry]"),
      );
      expect(hasRegistryPrefix).toBe(true);

      wfWithWarning.run.toString = original;
    } finally {
      spy.mockRestore();
    }
  });

  test("validator is called synchronously during register() — second pattern also warns", () => {
    // Build a copilot workflow whose run source contains the manual-session pattern
    const wfSession = defineWorkflow({ name: "bad-session", source: import.meta.path })
      .for("copilot")
      .run(async (_ctx) => {})
      .compile();

    const spy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      wfSession.run.toString = () =>
        "async (_ctx) => { client.createSession(); }";

      createRegistry().register(wfSession);

      const calls = spy.mock.calls;
      const hasRegistryPrefix = calls.some(
        (args) => typeof args[0] === "string" && args[0].startsWith("[registry]"),
      );
      expect(hasRegistryPrefix).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Type-level tests ─────────────────────────────────────────────────────────

describe("type-level — accumulated generic", () => {
  test("get() on bogus key throws at runtime", () => {
    const r = createRegistry().register(wfA).register(wfB);

    // Accessing registered keys compiles fine and returns correct types
    const _a = r.get("claude/alpha");
    const _b = r.get("opencode/beta");
    expect(_a.agent).toBe("claude");
    expect(_b.agent).toBe("opencode");

    // Accessing an unregistered key throws at runtime.
    // (A full name-literal generic on WorkflowDefinition would make this a
    // compile-time error too — currently name: string widens the key.)
    expect(() => r.get("bogus/key")).toThrow('[atomic] Workflow "bogus/key" is not registered.');
  });
});
