import { test } from "bun:test";
import assert from "node:assert/strict";
import { routeGlobalClearInput } from "../../packages/coding-agent/src/modes/interactive/interactive-global-clear.ts";

const CTRL_C = "\x03";

interface RouteCalls {
	cleared: number;
	terminated: number;
	renders: number;
}

function route(
	overrides: {
		hasOverlay?: boolean;
		blockingInline?: boolean;
		editorOwnsInput?: boolean;
		engineNeedsExplicitTermination?: boolean;
		withEngineRoute?: boolean;
	},
	data = CTRL_C,
): { result: { consume: true } | undefined; calls: RouteCalls } {
	const calls: RouteCalls = { cleared: 0, terminated: 0, renders: 0 };
	const engineRoute = overrides.withEngineRoute !== false;
	const result = routeGlobalClearInput(data, {
		matchesClear: (candidate) => candidate === CTRL_C,
		hasOverlay: () => overrides.hasOverlay === true,
		blockingInlineCustomUiActive: () => overrides.blockingInline === true,
		editorOwnsInput: () => overrides.editorOwnsInput !== false,
		...(engineRoute
			? {
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
	assert.deepEqual(calls, { cleared: 0, terminated: 0, renders: 0 });
});

test("Ctrl+C reaches the host when the editor owns input", () => {
	const { result, calls } = route({});
	assert.deepEqual(result, { consume: true });
	assert.equal(calls.cleared, 1);
	assert.equal(calls.terminated, 0);
});

test("a healthy engine keeps Ctrl+C-as-cancel for overlays, inline custom UI, and host selectors", () => {
	for (const modal of [
		{ hasOverlay: true },
		{ blockingInline: true },
		{ editorOwnsInput: false },
	]) {
		const { result, calls } = route(modal);
		assert.equal(result, undefined, `route consumed Ctrl+C for ${JSON.stringify(modal)}`);
		assert.deepEqual(calls, { cleared: 0, terminated: 0, renders: 0 });
	}
});

test("an unresponsive engine escalates Ctrl+C to explicit termination instead of dropping it", () => {
	// This is the wedged-remote-UI case from the report: the focused component is
	// an engine-owned proxy that cannot answer, so deferring loses the keypress.
	for (const modal of [
		{ hasOverlay: true },
		{ blockingInline: true },
		{ editorOwnsInput: false },
	]) {
		const { result, calls } = route({ ...modal, engineNeedsExplicitTermination: true });
		assert.deepEqual(result, { consume: true }, `Ctrl+C was dropped for ${JSON.stringify(modal)}`);
		assert.equal(calls.terminated, 1);
		assert.equal(calls.cleared, 0, "termination must not double as an editor clear");
		assert.equal(calls.renders, 1);
	}
});

test("without an engine termination route the modal guards are unchanged", () => {
	const { result, calls } = route({ blockingInline: true, withEngineRoute: false });
	assert.equal(result, undefined);
	assert.deepEqual(calls, { cleared: 0, terminated: 0, renders: 0 });
});

test("an unresponsive engine does not change the ordinary editor-owned route", () => {
	const { result, calls } = route({ engineNeedsExplicitTermination: true });
	assert.deepEqual(result, { consume: true });
	assert.equal(calls.cleared, 1, "handleCtrlC owns the escalation when the editor has input");
	assert.equal(calls.terminated, 0);
});
