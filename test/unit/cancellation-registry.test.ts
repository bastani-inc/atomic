/**
 * Unit tests for runs/background/cancellation-registry.ts
 * cross-ref: spec §8.1 Phase D
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";

// ---------------------------------------------------------------------------
// register / isAborted
// ---------------------------------------------------------------------------

describe("register", () => {
	test("registers a controller for a runId", () => {
		const reg = createCancellationRegistry();
		const ctrl = new AbortController();
		reg.register("r1", ctrl);
		assert.equal(reg.isAborted("r1"), false);
	});

	test("re-registering same runId replaces primary controller", () => {
		const reg = createCancellationRegistry();
		const ctrl1 = new AbortController();
		const ctrl2 = new AbortController();
		reg.register("r1", ctrl1);
		reg.register("r1", ctrl2);
		// abort via registry should signal ctrl2
		reg.abort("r1");
		assert.equal(ctrl2.signal.aborted, true);
		// ctrl1 was replaced — not aborted by registry
		assert.equal(ctrl1.signal.aborted, false);
	});
});

// ---------------------------------------------------------------------------
// isAborted
// ---------------------------------------------------------------------------

describe("isAborted", () => {
	test("returns false for unknown runId", () => {
		const reg = createCancellationRegistry();
		assert.equal(reg.isAborted("unknown"), false);
	});

	test("returns false before abort", () => {
		const reg = createCancellationRegistry();
		reg.register("r1", new AbortController());
		assert.equal(reg.isAborted("r1"), false);
	});

	test("returns true after abort", () => {
		const reg = createCancellationRegistry();
		reg.register("r1", new AbortController());
		reg.abort("r1");
		assert.equal(reg.isAborted("r1"), true);
	});
});

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

describe("abort", () => {
	test("returns false for unknown runId", () => {
		const reg = createCancellationRegistry();
		assert.equal(reg.abort("nonexistent"), false);
	});

	test("returns true and aborts primary controller", () => {
		const reg = createCancellationRegistry();
		const ctrl = new AbortController();
		reg.register("r1", ctrl);
		const result = reg.abort("r1");
		assert.equal(result, true);
		assert.equal(ctrl.signal.aborted, true);
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
		assert.equal(child1.signal.aborted, true);
		assert.equal(child2.signal.aborted, true);
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
		assert.deepEqual(order, ["child", "primary"]);
	});

	test("passes reason to primary controller", () => {
		const reg = createCancellationRegistry();
		const ctrl = new AbortController();
		reg.register("r1", ctrl);
		reg.abort("r1", "user-requested");
		assert.equal(ctrl.signal.reason, "user-requested");
	});

	test("does not re-abort already-aborted primary", () => {
		const reg = createCancellationRegistry();
		const ctrl = new AbortController();
		ctrl.abort("first");
		reg.register("r1", ctrl);
		// Should not throw; second abort is a no-op on the controller
		assert.doesNotThrow(() => reg.abort("r1", "second"));
		assert.equal(ctrl.signal.reason, "first"); // reason unchanged
	});

	test("isolates aborts between runs", () => {
		const reg = createCancellationRegistry();
		const ctrl1 = new AbortController();
		const ctrl2 = new AbortController();
		reg.register("r1", ctrl1);
		reg.register("r2", ctrl2);
		reg.abort("r1");
		assert.equal(ctrl1.signal.aborted, true);
		assert.equal(ctrl2.signal.aborted, false);
	});
});

// ---------------------------------------------------------------------------
// abortAll
// ---------------------------------------------------------------------------

describe("abortAll", () => {
	test("returns 0 when no runs registered", () => {
		const reg = createCancellationRegistry();
		assert.equal(reg.abortAll(), 0);
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
		assert.equal(count, 3);
		assert.equal(ctrl1.signal.aborted, true);
		assert.equal(ctrl2.signal.aborted, true);
		assert.equal(ctrl3.signal.aborted, true);
	});

	test("passes reason to all controllers", () => {
		const reg = createCancellationRegistry();
		const ctrl1 = new AbortController();
		const ctrl2 = new AbortController();
		reg.register("r1", ctrl1);
		reg.register("r2", ctrl2);
		reg.abortAll("global-kill");
		assert.equal(ctrl1.signal.reason, "global-kill");
		assert.equal(ctrl2.signal.reason, "global-kill");
	});

	test("abortAll includes children", () => {
		const reg = createCancellationRegistry();
		const primary = new AbortController();
		const child = new AbortController();
		reg.register("r1", primary);
		reg.registerChild("r1", child);
		reg.abortAll();
		assert.equal(child.signal.aborted, true);
		assert.equal(primary.signal.aborted, true);
	});
});

// ---------------------------------------------------------------------------
// registerChild
// ---------------------------------------------------------------------------

describe("registerChild", () => {
	test("throws when runId not registered", () => {
		const reg = createCancellationRegistry();
		assert.throws(() => reg.registerChild("unknown", new AbortController()), {
			message: 'CancellationRegistry: cannot registerChild for unknown runId "unknown". Call register() first.',
		});
	});

	test("multiple children all aborted on abort()", () => {
		const reg = createCancellationRegistry();
		reg.register("r1", new AbortController());
		const children = [new AbortController(), new AbortController(), new AbortController()];
		for (const c of children) reg.registerChild("r1", c);
		reg.abort("r1");
		assert.equal(
			children.every((c) => c.signal.aborted),
			true,
		);
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
		assert.equal(child.signal.aborted, true);
	});
});

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

describe("unregister", () => {
	test("removing unknown runId is a no-op", () => {
		const reg = createCancellationRegistry();
		assert.doesNotThrow(() => reg.unregister("nonexistent"));
	});

	test("isAborted returns false after unregister", () => {
		const reg = createCancellationRegistry();
		const ctrl = new AbortController();
		reg.register("r1", ctrl);
		reg.abort("r1");
		assert.equal(reg.isAborted("r1"), true);
		reg.unregister("r1");
		assert.equal(reg.isAborted("r1"), false);
	});

	test("abort returns false after unregister", () => {
		const reg = createCancellationRegistry();
		reg.register("r1", new AbortController());
		reg.unregister("r1");
		assert.equal(reg.abort("r1"), false);
	});

	test("unregister does not affect other runs", () => {
		const reg = createCancellationRegistry();
		const ctrl1 = new AbortController();
		const ctrl2 = new AbortController();
		reg.register("r1", ctrl1);
		reg.register("r2", ctrl2);
		reg.unregister("r1");
		reg.abort("r2");
		assert.equal(ctrl2.signal.aborted, true);
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
		assert.equal(ctrl.signal.aborted, false);
	});
});
