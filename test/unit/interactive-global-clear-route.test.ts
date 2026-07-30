import { beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import {
	resetGlobalClearRouteState,
	routeGlobalClearInput,
} from "../../packages/coding-agent/src/modes/interactive/interactive-global-clear.ts";
import {
	isPhysicalCtrlC,
	isPhysicalEscape,
	isSafetyKeyRelease,
} from "../../packages/coding-agent/src/modes/interactive/interactive-key-identity.ts";

const CTRL_C = "\x03";
const ESCAPE = "\x1b";
const CTRL_L = "\x0c";
/** Kitty release event for Ctrl+C. */
const CTRL_C_RELEASE = "\x1b[99;5:3u";

const REMOTE_A = { id: "remote-a" };
const REMOTE_B = { id: "remote-b" };

interface RouteCalls {
	cleared: number;
	terminated: number;
	remoteRestarts: number;
	renders: number;
}

interface RouteOverrides {
	hasOverlay?: boolean;
	blockingInline?: boolean;
	editorOwnsInput?: boolean;
	remoteOwner?: unknown;
	engineNeedsExplicitTermination?: boolean;
	withEngineRoute?: boolean;
	clearBinding?: string;
}

function makeRoute(overrides: RouteOverrides = {}): {
	press(data: string): { consume: true } | undefined;
	calls: RouteCalls;
	setRemoteOwner(owner: unknown): void;
} {
	const calls: RouteCalls = { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 };
	const keybindings = new KeybindingsManager();
	if (overrides.clearBinding) keybindings.setUserBindings({ "app.clear": overrides.clearBinding as never });
	let remoteOwner = overrides.remoteOwner;
	const engineRoute = overrides.withEngineRoute !== false;
	return {
		calls,
		setRemoteOwner: (owner: unknown) => { remoteOwner = owner; },
		press: (data: string) => routeGlobalClearInput(data, {
			matchesCtrlC: isPhysicalCtrlC,
			matchesEscape: isPhysicalEscape,
			isSafetyKeyRelease,
			matchesClear: (candidate) => keybindings.matches(candidate, "app.clear"),
			hasOverlay: () => overrides.hasOverlay === true,
			blockingInlineCustomUiActive: () => overrides.blockingInline === true,
			editorOwnsInput: () => overrides.editorOwnsInput !== false,
			...(engineRoute
				? {
					remoteEngineProxyOwner: () => remoteOwner,
					onRemoteEngineRestart: () => { calls.remoteRestarts += 1; },
					engineNeedsExplicitTermination: () => overrides.engineNeedsExplicitTermination === true,
					onEngineTerminate: () => { calls.terminated += 1; },
				}
				: {}),
			onClear: () => { calls.cleared += 1; },
			requestRender: () => { calls.renders += 1; },
		}),
	};
}

beforeEach(() => { resetGlobalClearRouteState(); });

test("a non-safety, non-clear key is never consumed", () => {
	const route = makeRoute();
	assert.equal(route.press("x"), undefined);
	assert.deepEqual(route.calls, { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 });
});

test("physical Ctrl+C reaches the host when the editor owns input", () => {
	const route = makeRoute();
	assert.deepEqual(route.press(CTRL_C), { consume: true });
	assert.equal(route.calls.cleared, 1);
});

/**
 * The reported remap defect: with `{"app.clear":"escape"}`, Escape used to reach
 * the engine stop/restart branch while Ctrl+C fell through to the remote proxy.
 * Both keys are now matched by physical identity.
 */
test("physical Escape never clears, terminates, or restarts, even when app.clear is bound to it", () => {
	for (const overrides of [
		{ clearBinding: "escape" },
		{ clearBinding: "escape", remoteOwner: REMOTE_A },
		{ clearBinding: "escape", engineNeedsExplicitTermination: true, blockingInline: true },
	] satisfies RouteOverrides[]) {
		const route = makeRoute(overrides);
		assert.equal(route.press(ESCAPE), undefined, `Escape was consumed for ${JSON.stringify(overrides)}`);
		assert.deepEqual(route.calls, { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 });
	}
});

test("physical Ctrl+C keeps the host safety route when app.clear is bound elsewhere", () => {
	const route = makeRoute({ clearBinding: "escape" });
	assert.deepEqual(route.press(CTRL_C), { consume: true }, "Ctrl+C must still reach the host");
	assert.equal(route.calls.cleared, 1);
});

test("a remapped app.clear key keeps ordinary editor clearing", () => {
	const route = makeRoute({ clearBinding: "ctrl+l" });
	assert.deepEqual(route.press(CTRL_L), { consume: true });
	assert.equal(route.calls.cleared, 1);
});

test("key-release events never act", () => {
	const route = makeRoute({ remoteOwner: REMOTE_A });
	assert.equal(route.press(CTRL_C_RELEASE), undefined);
	assert.deepEqual(route.calls, { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 });
});

test("terminal sequences and bracketed paste are not mistaken for Escape or Ctrl+C", () => {
	const route = makeRoute({ remoteOwner: REMOTE_A });
	for (const sequence of ["\x1b[A", "\x1b[200~pasted\x1b[201~", "\x1b]11;rgb:00/00/00\x07", "\x1b[1;5C"]) {
		assert.equal(route.press(sequence), undefined, `consumed ${JSON.stringify(sequence)}`);
	}
	assert.deepEqual(route.calls, { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 });
});

/**
 * Extension UIs bind Ctrl+C themselves — the workflows prompt card's
 * `ctrl+c Skip`, the stage chat's `ctrl+c Close` — so the first press belongs to
 * the component. A component that ignores it is still there for the second.
 */
test("the first Ctrl+C reaches a remote proxy and the second escapes to the host", () => {
	const route = makeRoute({ remoteOwner: REMOTE_A, blockingInline: true });
	assert.equal(route.press(CTRL_C), undefined, "the component must get its own Ctrl+C first");
	assert.equal(route.calls.remoteRestarts, 0);

	assert.deepEqual(route.press(CTRL_C), { consume: true }, "a still-trapped proxy must be escapable");
	assert.equal(route.calls.remoteRestarts, 1);
	assert.equal(route.calls.cleared, 0, "escaping must not double as an editor clear");
});

test("a component that handled the first Ctrl+C disarms the escape", () => {
	const route = makeRoute({ remoteOwner: REMOTE_A, blockingInline: true });
	assert.equal(route.press(CTRL_C), undefined);
	// The card skipped and unmounted; a different card takes over.
	route.setRemoteOwner(REMOTE_B);
	assert.equal(route.press(CTRL_C), undefined, "a new component gets its own first press");
	assert.equal(route.calls.remoteRestarts, 0);
	// Repeating on the new component escalates only that one.
	assert.deepEqual(route.press(CTRL_C), { consume: true });
	assert.equal(route.calls.remoteRestarts, 1);
});

test("a healthy engine keeps Ctrl+C-as-cancel for native modals", () => {
	for (const modal of [{ hasOverlay: true }, { blockingInline: true }, { editorOwnsInput: false }]) {
		const route = makeRoute(modal);
		assert.equal(route.press(CTRL_C), undefined, `route consumed Ctrl+C for ${JSON.stringify(modal)}`);
		assert.deepEqual(route.calls, { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 });
	}
});

test("an unresponsive engine escalates the first Ctrl+C behind a native modal", () => {
	for (const modal of [{ hasOverlay: true }, { blockingInline: true }, { editorOwnsInput: false }]) {
		const route = makeRoute({ ...modal, engineNeedsExplicitTermination: true });
		assert.deepEqual(route.press(CTRL_C), { consume: true }, `Ctrl+C was dropped for ${JSON.stringify(modal)}`);
		assert.equal(route.calls.terminated, 1);
		assert.equal(route.calls.remoteRestarts, 0);
	}
});

test("without the engine routes the modal guards are unchanged", () => {
	const route = makeRoute({ blockingInline: true, withEngineRoute: false });
	assert.equal(route.press(CTRL_C), undefined);
	assert.deepEqual(route.calls, { cleared: 0, terminated: 0, remoteRestarts: 0, renders: 0 });
});

test("an editor-owned press keeps the ordinary clear/interrupt path", () => {
	const route = makeRoute({ engineNeedsExplicitTermination: true });
	assert.deepEqual(route.press(CTRL_C), { consume: true });
	assert.equal(route.calls.cleared, 1, "handleCtrlC owns the escalation when the editor has input");
	assert.equal(route.calls.terminated, 0);
});
