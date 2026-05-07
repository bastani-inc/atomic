import { test, expect, describe, mock } from "bun:test";
import { createRegistry } from "./registry.ts";
import { defineWorkflow } from "./define-workflow.ts";

// Helper: compile a minimal workflow definition
function makeWf(name: string, agent: "claude" | "copilot" | "opencode" = "claude") {
  return defineWorkflow({ name, source: import.meta.path })
    .for(agent)
    .run(async () => {})
    .compile();
}

describe("Registry.register()", () => {
  test("registers a workflow and makes it resolvable", () => {
    const r = createRegistry().register(makeWf("hello"));
    const wf = r.resolve("hello", "claude");
    expect(wf?.name).toBe("hello");
  });

  test("throws on duplicate (agent, name)", () => {
    const r = createRegistry().register(makeWf("hello"));
    expect(() => r.register(makeWf("hello"))).toThrow(/Duplicate workflow registration/);
  });

  test("allows same name for different agents", () => {
    const r = createRegistry()
      .register(makeWf("hello", "claude"))
      .register(makeWf("hello", "copilot"));
    expect(r.resolve("hello", "claude")?.agent).toBe("claude");
    expect(r.resolve("hello", "copilot")?.agent).toBe("copilot");
  });
});

describe("Registry.upsert()", () => {
  test("inserts when no prior entry exists — behaves like register()", () => {
    const r = createRegistry().upsert(makeWf("new"));
    expect(r.resolve("new", "claude")?.name).toBe("new");
  });

  test("replaces existing (agent, name) entry without throwing", () => {
    const original = makeWf("hello");
    const replacement = makeWf("hello");

    const r = createRegistry()
      .register(original)
      .upsert(replacement);

    // Still resolves, and the resolved entry is the replacement
    const resolved = r.resolve("hello", "claude");
    expect(resolved).toBe(replacement);
  });

  test("does NOT affect other entries when replacing one", () => {
    const r = createRegistry()
      .register(makeWf("alpha", "claude"))
      .register(makeWf("beta", "claude"))
      .upsert(makeWf("alpha", "claude"));

    expect(r.resolve("beta", "claude")?.name).toBe("beta");
    expect(r.list()).toHaveLength(2);
  });

  test("returns a new immutable registry (original unchanged)", () => {
    const original = makeWf("hello");
    const r1 = createRegistry().register(original);
    const replacement = makeWf("hello");
    const r2 = r1.upsert(replacement);

    // r1 still holds the original
    expect(r1.resolve("hello", "claude")).toBe(original);
    // r2 holds the replacement
    expect(r2.resolve("hello", "claude")).toBe(replacement);
  });

  test("invokes onOverride callback with the prior entry when replacing", () => {
    const prior = makeWf("hello");
    const r1 = createRegistry().register(prior);

    const overrideCb = mock((_entry: unknown) => {});
    r1.upsert(makeWf("hello"), overrideCb);

    expect(overrideCb).toHaveBeenCalledTimes(1);
    const [firstCall] = overrideCb.mock.calls;
    expect(firstCall?.[0]).toBe(prior);
  });

  test("does NOT invoke onOverride callback when no prior entry exists", () => {
    const overrideCb = mock((_entry: unknown) => {});
    createRegistry().upsert(makeWf("new"), overrideCb);
    expect(overrideCb).not.toHaveBeenCalled();
  });

  test("upsert across different agents are independent", () => {
    const r = createRegistry()
      .register(makeWf("shared", "claude"))
      .register(makeWf("shared", "copilot"))
      .upsert(makeWf("shared", "claude"));

    // copilot entry untouched
    expect(r.resolve("shared", "copilot")?.agent).toBe("copilot");
    expect(r.list()).toHaveLength(2);
  });

  test("register() after upsert still throws on duplicate", () => {
    const r = createRegistry().upsert(makeWf("hello"));
    expect(() => r.register(makeWf("hello"))).toThrow(/Duplicate workflow registration/);
  });
});
