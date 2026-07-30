import { test } from "bun:test";
import assert from "node:assert/strict";
import { routeGlobalClearInput } from "../../packages/coding-agent/src/modes/interactive/interactive-global-clear.ts";

const CTRL_C = "\x03";

interface RouteCalls {
	cleared: number;
	terminated: number;
	remoteRestarts: number;
	renders: number;
}

function route(
	overrides: {
		hasOverlay?: boolean;
		blockingInline?: boolean;
		editorOwnsInput?: boolean;
		remoteProxyOwnsInput?: boolean;
		engineNeedsExplicitTermination?: boolean;
		withEngineRoute?: boolean;
	},
	data = CTRL_C,
): { result: { consume: true } | undefined; calls: RouteCalls } {
	const calls: RouteCalls = { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 };
	const engineRoute = overrides.withEngineRoute !== false;
	const result = routeGlobalClearInput(data, {
		matchesClear: (candidate) => candidate === CTRL_C,
		hasOverlay: () => overrides.hasOverlay === true,
		blockingInlineCustomUiActive: () => overrides.blockingInline === true,
		editorOwnsInput: () => overrides.editorOwnsInput !== false,
		...(engineRoute
			? {
				remoteEngineProxyOwnsInput: () => overrides.remoteProxyOwnsInput === true,
				onRemoteEngineRestart: () => { calls.remoteRestarts += 1; },
				engineNeedsExplicitTermination: () => overrides.engineNeedsExplicitTermination === true,
				onEngineTerminate: () => { calls.terminated += 1; },
			}
			: {}),
		onClear: () => { calls.cleared += 1; },
		requestRender: () => { calls.renders += 1; },
	});
	return { result, calls };
}

test("a non-clear key is never consumed", () => {
	const { result, calls } = route({}, "x");
	assert.equal(result, undefined);
	assert.deepEqual(calls, { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 });
});

test("Ctrl+C reaches the host when the editor owns input", () => {
	const { result, calls } = route({});
	assert.deepEqual(result, { consume: true });
	assert.equal(calls.cleared, 1);
	assert.equal(calls.terminated, 0);
	assert.equal(calls.remoteRestarts, 0);
});

/**
 * The reported lockout: a healthy engine's `ctx.ui.custom()` proxy holds input
 * and forwards every key to the child, so deferring hands Ctrl+C to the very
 * component the user is trying to escape.
 */
test("a focused remote proxy always escalates, healthy engine or not", () => {
	for (const shape of [
		{ blockingInline: true },                        // inline remote mount
		{ hasOverlay: true, editorOwnsInput: false },    // remote overlay
	]) {
		const { result, calls } = route({ ...shape, remoteProxyOwnsInput: true });
		assert.deepEqual(result, { consume: true }, `Ctrl+C was dropped for ${JSON.stringify(shape)}`);
		assert.equal(calls.remoteRestarts, 1, "a remote proxy must be escaped by replacing the engine");
		assert.equal(calls.terminated, 0, "this is not the unresponsive-engine route");
		assert.equal(calls.cleared, 0, "it must not double as an editor clear");
		assert.equal(calls.renders, 1);
	}
});

test("a healthy engine keeps Ctrl+C-as-cancel for native modals", () => {
	// None of these is a remote proxy, so the focused component cancels itself.
	for (const modal of [
		{ hasOverlay: true },
		{ blockingInline: true },
		{ editorOwnsInput: false },
	]) {
		const { result, calls } = route(modal);
		assert.equal(result, undefined, `route consumed Ctrl+C for ${JSON.stringify(modal)}`);
		assert.deepEqual(calls, { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 });
	}
});

test("an unresponsive engine escalates Ctrl+C even behind a native modal", () => {
	for (const modal of [
		{ hasOverlay: true },
		{ blockingInline: true },
		{ editorOwnsInput: false },
	]) {
		const { result, calls } = route({ ...modal, engineNeedsExplicitTermination: true });
		assert.deepEqual(result, { consume: true }, `Ctrl+C was dropped for ${JSON.stringify(modal)}`);
		assert.equal(calls.terminated, 1);
		assert.equal(calls.remoteRestarts, 0);
		assert.equal(calls.cleared, 0, "termination must not double as an editor clear");
		assert.equal(calls.renders, 1);
	}
});

test("a remote proxy takes precedence over the unresponsive route", () => {
	const { result, calls } = route({
		blockingInline: true,
		remoteProxyOwnsInput: true,
		engineNeedsExplicitTermination: true,
	});
	assert.deepEqual(result, { consume: true });
	assert.equal(calls.remoteRestarts, 1);
	assert.equal(calls.terminated, 0, "one press must trigger exactly one replacement");
});

test("without the engine routes the modal guards are unchanged", () => {
	const { result, calls } = route({ blockingInline: true, withEngineRoute: false });
	assert.equal(result, undefined);
	assert.deepEqual(calls, { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 });
});

test("an editor-owned press keeps the ordinary clear/interrupt path", () => {
	const { result, calls } = route({ engineNeedsExplicitTermination: true });
	assert.deepEqual(result, { consume: true });
	assert.equal(calls.cleared, 1, "handleCtrlC owns the escalation when the editor has input");
	assert.equal(calls.terminated, 0);
	assert.equal(calls.remoteRestarts, 0);
});
