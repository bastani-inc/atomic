import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
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

/** Declares `handlesCtrlC` (a workflows prompt card / stage chat). */
const DECLARED_A = { id: "declared-a" };
const DECLARED_B = { id: "declared-b" };
/** A third-party component that never declared Ctrl+C handling. */
const UNDECLARED = { id: "undeclared" };

interface RouteCalls {
	cleared: number;
	terminated: number;
	dismissed: unknown[];
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

function declaresCtrlC(owner: unknown): boolean {
	return owner === DECLARED_A || owner === DECLARED_B;
}

function makeRoute(overrides: RouteOverrides = {}): {
	press(data: string): { consume: true } | undefined;
	calls: RouteCalls;
	setRemoteOwner(owner: unknown): void;
} {
	const calls: RouteCalls = { cleared: 0, terminated: 0, dismissed: [], renders: 0 };
	const keybindings = new KeybindingsManager();
	if (overrides.clearBinding) keybindings.setUserBindings({ "app.clear": overrides.clearBinding as never });
	let remoteOwner = overrides.remoteOwner;
	const engineRoute = overrides.withEngineRoute !== false;
	return {
		calls,
		setRemoteOwner: (owner: unknown) => {
			remoteOwner = owner;
		},
		press: (data: string) =>
			routeGlobalClearInput(data, {
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
							remoteProxyHandlesCtrlC: declaresCtrlC,
							onRemoteProxyDismiss: (owner: unknown) => {
								calls.dismissed.push(owner);
							},
							engineNeedsExplicitTermination: () => overrides.engineNeedsExplicitTermination === true,
							onEngineTerminate: () => {
								calls.terminated += 1;
							},
						}
					: {}),
				onClear: () => {
					calls.cleared += 1;
				},
				requestRender: () => {
					calls.renders += 1;
				},
			}),
	};
}

const IDLE: RouteCalls = { cleared: 0, terminated: 0, dismissed: [], renders: 0 };

beforeEach(() => {
	resetGlobalClearRouteState();
});

test("a non-safety, non-clear key is never consumed", () => {
	const route = makeRoute();
	assert.equal(route.press("x"), undefined);
	assert.deepEqual(route.calls, IDLE);
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
test("physical Escape never clears, terminates, or dismisses, even when app.clear is bound to it", () => {
	for (const overrides of [
		{ clearBinding: "escape" },
		{ clearBinding: "escape", remoteOwner: UNDECLARED },
		{ clearBinding: "escape", remoteOwner: DECLARED_A },
		{ clearBinding: "escape", engineNeedsExplicitTermination: true, blockingInline: true },
	] satisfies RouteOverrides[]) {
		const route = makeRoute(overrides);
		assert.equal(route.press(ESCAPE), undefined, `Escape was consumed for ${JSON.stringify(overrides)}`);
		assert.deepEqual(route.calls, IDLE);
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
	const route = makeRoute({ remoteOwner: UNDECLARED });
	assert.equal(route.press(CTRL_C_RELEASE), undefined);
	assert.deepEqual(route.calls, IDLE);
});

test("terminal sequences and bracketed paste are not mistaken for Escape or Ctrl+C", () => {
	const route = makeRoute({ remoteOwner: UNDECLARED });
	for (const sequence of ["\x1b[A", "\x1b[200~pasted\x1b[201~", "\x1b]11;rgb:00/00/00\x07", "\x1b[1;5C"]) {
		assert.equal(route.press(sequence), undefined, `consumed ${JSON.stringify(sequence)}`);
	}
	assert.deepEqual(route.calls, IDLE);
});

/**
 * A component that never declared Ctrl+C handling cannot be assumed to answer
 * it, so the first press closes exactly that component. The engine keeps
 * running: nothing else it is doing is disturbed.
 */
test("the first Ctrl+C closes an undeclared remote proxy without touching the engine", () => {
	for (const modal of [{ blockingInline: true }, { hasOverlay: true }, { editorOwnsInput: false }]) {
		resetGlobalClearRouteState();
		const route = makeRoute({ ...modal, remoteOwner: UNDECLARED });
		assert.deepEqual(route.press(CTRL_C), { consume: true }, `Ctrl+C was dropped for ${JSON.stringify(modal)}`);
		assert.deepEqual(route.calls.dismissed, [UNDECLARED]);
		assert.equal(route.calls.terminated, 0, "a healthy engine must not be replaced");
		assert.equal(route.calls.cleared, 0, "closing must not double as an editor clear");
	}
});

/**
 * Bundled extension UIs declare that they own Ctrl+C — the workflows prompt
 * card's `ctrl+c Skip`, the stage chat's `ctrl+c Close` — so the first press is
 * theirs.
 */
test("a declared component receives the first Ctrl+C", () => {
	const route = makeRoute({ remoteOwner: DECLARED_A, blockingInline: true });
	assert.equal(route.press(CTRL_C), undefined, "the component must get its own Ctrl+C");
	assert.deepEqual(route.calls, IDLE);
});

test("a declared component still holding input on the next press is closed", () => {
	const route = makeRoute({ remoteOwner: DECLARED_A, blockingInline: true });
	assert.equal(route.press(CTRL_C), undefined);
	assert.deepEqual(route.press(CTRL_C), { consume: true }, "a declared component that ignores it must be escapable");
	assert.deepEqual(route.calls.dismissed, [DECLARED_A]);
	assert.equal(route.calls.terminated, 0);
});

test("a declared component that handled the first Ctrl+C disarms the escape", () => {
	const route = makeRoute({ remoteOwner: DECLARED_A, blockingInline: true });
	assert.equal(route.press(CTRL_C), undefined);
	// The card skipped and unmounted; a different card takes over.
	route.setRemoteOwner(DECLARED_B);
	assert.equal(route.press(CTRL_C), undefined, "a new component gets its own first press");
	assert.deepEqual(route.calls.dismissed, []);
	assert.deepEqual(route.press(CTRL_C), { consume: true });
	assert.deepEqual(route.calls.dismissed, [DECLARED_B]);
});

test("an unresponsive engine terminates on the first Ctrl+C, even behind a declared component", () => {
	for (const owner of [DECLARED_A, UNDECLARED]) {
		resetGlobalClearRouteState();
		const route = makeRoute({ remoteOwner: owner, blockingInline: true, engineNeedsExplicitTermination: true });
		assert.deepEqual(route.press(CTRL_C), { consume: true });
		assert.equal(route.calls.terminated, 1, "a wedged child cannot run the component's own handler");
		assert.deepEqual(route.calls.dismissed, [], "closing a proxy would not recover a dead engine");
	}
});

test("a healthy engine keeps Ctrl+C-as-cancel for native modals", () => {
	for (const modal of [{ hasOverlay: true }, { blockingInline: true }, { editorOwnsInput: false }]) {
		const route = makeRoute(modal);
		assert.equal(route.press(CTRL_C), undefined, `route consumed Ctrl+C for ${JSON.stringify(modal)}`);
		assert.deepEqual(route.calls, IDLE);
	}
});

test("an unresponsive engine escalates the first Ctrl+C behind a native modal", () => {
	for (const modal of [{ hasOverlay: true }, { blockingInline: true }, { editorOwnsInput: false }]) {
		const route = makeRoute({ ...modal, engineNeedsExplicitTermination: true });
		assert.deepEqual(route.press(CTRL_C), { consume: true }, `Ctrl+C was dropped for ${JSON.stringify(modal)}`);
		assert.equal(route.calls.terminated, 1);
		assert.deepEqual(route.calls.dismissed, []);
	}
});

test("without the engine routes the modal guards are unchanged", () => {
	const route = makeRoute({ blockingInline: true, withEngineRoute: false });
	assert.equal(route.press(CTRL_C), undefined);
	assert.deepEqual(route.calls, IDLE);
});

test("an editor-owned press keeps the ordinary clear/interrupt path", () => {
	const route = makeRoute({ engineNeedsExplicitTermination: true });
	assert.deepEqual(route.press(CTRL_C), { consume: true });
	assert.equal(route.calls.cleared, 1, "handleCtrlC owns the escalation when the editor has input");
	assert.equal(route.calls.terminated, 0);
});
