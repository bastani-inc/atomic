import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ExtensionAPI, PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { createWorkflowBackgroundWarningReporter } from "../../packages/workflows/src/extension/workflow-background-warning.js";

const WARNING = "atomic-workflows: pending stage delivery sweep failed: missing durable owner";

afterEach(() => vi.restoreAllMocks());

function fixture() {
	const handlers = new Map<string, Parameters<NonNullable<ExtensionAPI["on"]>>[1]>();
	const report = createWorkflowBackgroundWarningReporter({ on: (event, handler) => handlers.set(event, handler) });
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	return { report, warn, error, log, start: (ctx: PiCommandContext) => handlers.get("session_start")?.({}, ctx) };
}

test("defers startup diagnostics until host context and deduplicates interactive UI warnings", () => {
	const f = fixture();
	const notifications: string[] = [];
	f.report(WARNING);
	f.report(WARNING);
	assert.equal(f.warn.mock.calls.length, 0);
	f.start({ hasUI: true, ui: { notify: (message) => notifications.push(message) } });
	f.report(WARNING);
	assert.deepEqual(notifications, [WARNING]);
	assert.equal(f.warn.mock.calls.length, 0);
	assert.equal(f.error.mock.calls.length, 0);
	assert.equal(f.log.mock.calls.length, 0);
});

test("headless mode retains one console diagnostic even with a notify stub", () => {
	const f = fixture();
	const notify = vi.fn();
	f.start({ hasUI: false, ui: { notify } });
	f.report(WARNING);
	f.report(WARNING);
	assert.deepEqual(f.warn.mock.calls, [[WARNING]]);
	assert.equal(notify.mock.calls.length, 0);
});

test("RPC/UI notification capability is used without relying on local TTY state", () => {
	const f = fixture();
	const notify = vi.fn();
	f.start({ ui: { notify } });
	f.report(WARNING);
	assert.deepEqual(notify.mock.calls, [[WARNING, "warning"]]);
	assert.equal(f.warn.mock.calls.length, 0);
});

test("a failing interactive notification sink never falls back to console", () => {
	const f = fixture();
	f.start({
		hasUI: true,
		ui: {
			notify: () => {
				throw new Error("UI disconnected");
			},
		},
	});
	assert.doesNotThrow(() => f.report(WARNING));
	assert.equal(f.warn.mock.calls.length, 0);
	assert.equal(f.error.mock.calls.length, 0);
	assert.equal(f.log.mock.calls.length, 0);
});
