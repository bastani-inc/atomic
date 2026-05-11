/**
 * Unit tests for runs/detach/cancellation-registry.ts
 * cross-ref: spec §8.1 Phase D
 */

import { test, expect, describe } from "bun:test";
import { createCancellationRegistry } from "../../src/runs/detach/cancellation-registry.js";

// ---------------------------------------------------------------------------
// register / isAborted
// ---------------------------------------------------------------------------

describe("register", () => {
  test("registers a controller for a runId", () => {
    const reg = createCancellationRegistry();
    const ctrl = new AbortController();
    reg.register("r1", ctrl);
    expect(reg.isAborted("r1")).toBe(false);
  });

  test("re-registering same runId replaces primary controller", () => {
    const reg = createCancellationRegistry();
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    reg.register("r1", ctrl1);
    reg.register("r1", ctrl2);
    // abort via registry should signal ctrl2
    reg.abort("r1");
    expect(ctrl2.signal.aborted).toBe(true);
    // ctrl1 was replaced — not aborted by registry
    expect(ctrl1.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAborted
// ---------------------------------------------------------------------------

describe("isAborted", () => {
  test("returns false for unknown runId", () => {
    const reg = createCancellationRegistry();
    expect(reg.isAborted("unknown")).toBe(false);
  });

  test("returns false before abort", () => {
    const reg = createCancellationRegistry();
    reg.register("r1", new AbortController());
    expect(reg.isAborted("r1")).toBe(false);
  });

  test("returns true after abort", () => {
    const reg = createCancellationRegistry();
    reg.register("r1", new AbortController());
    reg.abort("r1");
    expect(reg.isAborted("r1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

describe("abort", () => {
  test("returns false for unknown runId", () => {
    const reg = createCancellationRegistry();
    expect(reg.abort("nonexistent")).toBe(false);
  });

  test("returns true and aborts primary controller", () => {
    const reg = createCancellationRegistry();
    const ctrl = new AbortController();
    reg.register("r1", ctrl);
    const result = reg.abort("r1");
    expect(result).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("aborts child controllers", () => {
    const reg = createCancellationRegistry();
    const primary = new AbortController();
    const child1 = new AbortController();
    const child2 = new AbortController();
    reg.register("r1", primary);
    reg.registerChild("r1", child1);
    reg.registerChild("r1", child2);
    reg.abort("r1");
    expect(child1.signal.aborted).toBe(true);
    expect(child2.signal.aborted).toBe(true);
  });

  test("aborts children before primary (children signaled first)", () => {
    const reg = createCancellationRegistry();
    const order: string[] = [];
    const primary = new AbortController();
    const child = new AbortController();
    child.signal.addEventListener("abort", () => order.push("child"));
    primary.signal.addEventListener("abort", () => order.push("primary"));
    reg.register("r1", primary);
    reg.registerChild("r1", child);
    reg.abort("r1");
    expect(order).toEqual(["child", "primary"]);
  });

  test("passes reason to primary controller", () => {
    const reg = createCancellationRegistry();
    const ctrl = new AbortController();
    reg.register("r1", ctrl);
    reg.abort("r1", "user-requested");
    expect(ctrl.signal.reason).toBe("user-requested");
  });

  test("does not re-abort already-aborted primary", () => {
    const reg = createCancellationRegistry();
    const ctrl = new AbortController();
    ctrl.abort("first");
    reg.register("r1", ctrl);
    // Should not throw; second abort is a no-op on the controller
    expect(() => reg.abort("r1", "second")).not.toThrow();
    expect(ctrl.signal.reason).toBe("first"); // reason unchanged
  });

  test("isolates aborts between runs", () => {
    const reg = createCancellationRegistry();
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    reg.register("r1", ctrl1);
    reg.register("r2", ctrl2);
    reg.abort("r1");
    expect(ctrl1.signal.aborted).toBe(true);
    expect(ctrl2.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// abortAll
// ---------------------------------------------------------------------------

describe("abortAll", () => {
  test("returns 0 when no runs registered", () => {
    const reg = createCancellationRegistry();
    expect(reg.abortAll()).toBe(0);
  });

  test("aborts all registered runs and returns count", () => {
    const reg = createCancellationRegistry();
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const ctrl3 = new AbortController();
    reg.register("r1", ctrl1);
    reg.register("r2", ctrl2);
    reg.register("r3", ctrl3);
    const count = reg.abortAll("shutdown");
    expect(count).toBe(3);
    expect(ctrl1.signal.aborted).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
    expect(ctrl3.signal.aborted).toBe(true);
  });

  test("passes reason to all controllers", () => {
    const reg = createCancellationRegistry();
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    reg.register("r1", ctrl1);
    reg.register("r2", ctrl2);
    reg.abortAll("global-kill");
    expect(ctrl1.signal.reason).toBe("global-kill");
    expect(ctrl2.signal.reason).toBe("global-kill");
  });

  test("abortAll includes children", () => {
    const reg = createCancellationRegistry();
    const primary = new AbortController();
    const child = new AbortController();
    reg.register("r1", primary);
    reg.registerChild("r1", child);
    reg.abortAll();
    expect(child.signal.aborted).toBe(true);
    expect(primary.signal.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerChild
// ---------------------------------------------------------------------------

describe("registerChild", () => {
  test("throws when runId not registered", () => {
    const reg = createCancellationRegistry();
    expect(() => reg.registerChild("unknown", new AbortController())).toThrow(
      'CancellationRegistry: cannot registerChild for unknown runId "unknown". Call register() first.',
    );
  });

  test("multiple children all aborted on abort()", () => {
    const reg = createCancellationRegistry();
    reg.register("r1", new AbortController());
    const children = [new AbortController(), new AbortController(), new AbortController()];
    for (const c of children) reg.registerChild("r1", c);
    reg.abort("r1");
    expect(children.every((c) => c.signal.aborted)).toBe(true);
  });

  test("children preserved when primary re-registered", () => {
    const reg = createCancellationRegistry();
    const ctrl1 = new AbortController();
    const child = new AbortController();
    reg.register("r1", ctrl1);
    reg.registerChild("r1", child);
    // Re-register primary
    const ctrl2 = new AbortController();
    reg.register("r1", ctrl2);
    reg.abort("r1");
    // Child should still be aborted
    expect(child.signal.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

describe("unregister", () => {
  test("removing unknown runId is a no-op", () => {
    const reg = createCancellationRegistry();
    expect(() => reg.unregister("nonexistent")).not.toThrow();
  });

  test("isAborted returns false after unregister", () => {
    const reg = createCancellationRegistry();
    const ctrl = new AbortController();
    reg.register("r1", ctrl);
    reg.abort("r1");
    expect(reg.isAborted("r1")).toBe(true);
    reg.unregister("r1");
    expect(reg.isAborted("r1")).toBe(false);
  });

  test("abort returns false after unregister", () => {
    const reg = createCancellationRegistry();
    reg.register("r1", new AbortController());
    reg.unregister("r1");
    expect(reg.abort("r1")).toBe(false);
  });

  test("unregister does not affect other runs", () => {
    const reg = createCancellationRegistry();
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    reg.register("r1", ctrl1);
    reg.register("r2", ctrl2);
    reg.unregister("r1");
    reg.abort("r2");
    expect(ctrl2.signal.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createCancellationRegistry isolation
// ---------------------------------------------------------------------------

describe("createCancellationRegistry isolation", () => {
  test("two registries are independent", () => {
    const reg1 = createCancellationRegistry();
    const reg2 = createCancellationRegistry();
    const ctrl = new AbortController();
    reg1.register("r1", ctrl);
    reg2.abortAll();
    expect(ctrl.signal.aborted).toBe(false);
  });
});
