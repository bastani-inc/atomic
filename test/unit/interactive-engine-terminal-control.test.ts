/**
 * Source-path regression coverage for the isolated workflow-overlay autowrap
 * bridge.
 *
 * In isolated interactive mode the workflow extension runs inside the engine
 * child, whose stdout is the JSONL transport rather than a TTY. A remote custom
 * component therefore sends a typed, allowlisted `engine_custom_terminal`
 * control; the host `RemoteComponentController` applies it to the real host TTY
 * associated with the mounted overlay.
 *
 * These tests wire the real child `EngineCustomUiService` to the real host
 * `RemoteComponentController` through an in-process message pump and assert
 * buffering, fullscreen suppression, reset, generation safety, and nested
 * mount teardown for the remaining autowrap control.
 */

import assert from "node:assert/strict";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { InteractiveEngineGenerationEnded } from "../../packages/coding-agent/src/modes/interactive-engine/engine-generation.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	INTERACTIVE_ENGINE_PROTOCOL_VERSION,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import {
	HOST_TERMINAL_AUTOWRAP_OFF,
	HOST_TERMINAL_AUTOWRAP_ON,
	TerminalModeController,
} from "../../packages/coding-agent/src/modes/interactive-engine/terminal-mode-controller.ts";
import { sleep } from "../helpers/runtime.js";

const isRegularTui = (): boolean => false;
const WHEEL_UP = "\x1b[<64;10;10M";

/** The child's RemoteTerminal augments pi-tui's Terminal with this setter. */
interface RemoteTerm {
	setAutowrap?: (enabled: boolean) => void;
}
function remoteTerm(tui: TUI): RemoteTerm {
	return tui.terminal as unknown as RemoteTerm;
}

interface HostMount {
	readonly componentId: string;
	readonly component: Component;
	readonly overlay: boolean;
	focused: boolean;
	done: (result: unknown) => void;
}

interface Bridge {
	readonly child: EngineCustomUiService;
	readonly controller: RemoteComponentController;
	readonly hostWrites: string[];
	readonly hostMessages: InteractiveEngineMessage[];
	readonly childCommands: InteractiveEngineCommand[];
	/** componentIds in the order their host close callback ran. */
	readonly closeOrder: string[];
	readonly mounts: HostMount[];
	focus: "editor" | "inline" | "overlay";
	replaceTuiMode(fullscreen: boolean): void;
	emitEngineReady(pid: number): void;
	/** Publish the host-local generation-death event. */
	emitGenerationEnded(generation: number): void;
}

function makeBridge(options: { fullscreen?: boolean } = {}): Bridge {
	const engineListeners: Array<(m: InteractiveEngineMessage) => void> = [];
	const hostWrites: string[] = [];
	const hostMessages: InteractiveEngineMessage[] = [];
	const mounts: HostMount[] = [];
	const childCommands: InteractiveEngineCommand[] = [];
	const closeOrder: string[] = [];
	const generationEndedListeners: Array<(event: InteractiveEngineGenerationEnded) => void> = [];
	const bridge = { focus: "editor" } as Bridge;
	let fullscreen = options.fullscreen === true;
	const tuiRendererListeners = new Set<() => void>();

	const hostTerminal = { rows: 40, columns: 100, write: (data: string) => hostWrites.push(data) };

	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		hostMessages.push(message);
		for (const listener of [...engineListeners]) listener(message);
	}, new KeybindingsManager());

	const runtime = {
		onGenerationEnded: (listener: (event: InteractiveEngineGenerationEnded) => void) => {
			generationEndedListeners.push(listener);
			return () => {};
		},
		onEngineMessage: (listener: (m: InteractiveEngineMessage) => void) => {
			engineListeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: unknown) => {
			childCommands.push(command as InteractiveEngineCommand);
			child.handleLine(serializeInteractiveEngineFrame(command as never));
		},
	} as unknown as IsolatedInteractiveRuntime;

	// The most recently opened engine_custom_open carries the componentId; capture
	// it so the fake host mount can be correlated for controller teardown.
	let pendingComponentId: string | undefined;
	engineListeners.push((message) => {
		if (message.type === "engine_custom_open") pendingComponentId = message.componentId;
	});

	const ui = {
		requestRender: () => {},
		setWidget: () => {},
		custom: (
			factory: (tui: unknown, theme: unknown, keys: unknown, done: (r: unknown) => void) => Component,
			options: { overlay?: boolean; onHandle?: (handle: unknown) => void },
		) =>
			new Promise((resolve) => {
				const componentId = pendingComponentId!;
				const mount: HostMount = {
					componentId,
					overlay: options.overlay === true,
					focused: false,
					done: (result: unknown) => {
						closeOrder.push(componentId);
						// Real host: overlay done hides + restores previous focus; inline
						// done restores the editor. Model both as → editor.
						if (mount.overlay ? bridge.focus === "overlay" : bridge.focus === "inline") {
							bridge.focus = "editor";
						}
						resolve(result);
					},
					component: undefined as unknown as Component,
				};
				const handle = {
					hide: () => {
						mount.focused = false;
					},
					setHidden: (_hidden: boolean) => {},
					isHidden: () => false,
					focus: () => {
						mount.focused = true;
						bridge.focus = "overlay";
					},
					unfocus: () => {
						mount.focused = false;
					},
					isFocused: () => mount.focused,
				};
				const tui = { terminal: hostTerminal, requestRender: () => {}, setFocus: () => {} };
				const component = factory(tui, {}, {}, mount.done);
				(mount as { component: Component }).component = component;
				mounts.push(mount);
				if (mount.overlay) {
					// pi-tui showOverlay captures focus on mount.
					mount.focused = true;
					bridge.focus = "overlay";
					options.onHandle?.(handle);
				} else {
					bridge.focus = "inline";
				}
			}),
	} as unknown as ExtensionUIContext;

	const controller = new RemoteComponentController(runtime, ui, {
		isFullscreen: () => fullscreen,
		onRendererReplaced: (listener) => {
			tuiRendererListeners.add(listener);
			return () => tuiRendererListeners.delete(listener);
		},
	});
	bridge.emitEngineReady = (pid: number) => {
		for (const listener of [...engineListeners]) {
			listener({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid });
		}
	};
	bridge.emitGenerationEnded = (generation: number) => {
		for (const listener of [...generationEndedListeners]) {
			listener({
				generation,
				error: new Error("Agent process exited (code=null signal=SIGKILL). Stderr: "),
				kind: "exit",
				expected: false,
			});
		}
	};
	bridge.replaceTuiMode = (nextFullscreen: boolean) => {
		fullscreen = nextFullscreen;
		for (const listener of tuiRendererListeners) listener();
	};
	return Object.assign(bridge, { child, controller, hostWrites, hostMessages, mounts, childCommands, closeOrder });
}

function autowrapFactory(enabled: boolean, onDisposeEnabled?: boolean) {
	return (tui: TUI, _t: unknown, _k: unknown, _done: (r: unknown) => void) => {
		remoteTerm(tui).setAutowrap?.(enabled);
		return {
			render: () => ["component"],
			handleInput: () => {},
			invalidate: () => {},
			dispose: onDisposeEnabled === undefined ? undefined : () => remoteTerm(tui).setAutowrap?.(onDisposeEnabled),
		};
	};
}

describe("engine_custom_terminal protocol", () => {
	test("round-trips the allowlisted autowrap control", () => {
		for (const control of [
			{ kind: "autowrap", enabled: true },
			{ kind: "autowrap", enabled: false },
		] as const) {
			const line = serializeInteractiveEngineFrame({ type: "engine_custom_terminal", componentId: "c1", control });
			const parsed = parseInteractiveEngineMessage(line);
			assert.deepEqual(parsed, { type: "engine_custom_terminal", componentId: "c1", control });
		}
	});

	test("rejects unknown kinds, non-boolean enabled, and missing control", () => {
		const reject = (control: unknown) =>
			parseInteractiveEngineMessage(JSON.stringify({ type: "engine_custom_terminal", componentId: "c1", control }));
		assert.equal(reject({ kind: "mouse", enabled: true }), undefined);
		assert.equal(reject({ kind: "autowrap", enabled: "yes" }), undefined);
		assert.equal(reject({ kind: "autowrap" }), undefined);
		assert.equal(reject("escape sequence"), undefined);
		assert.equal(reject(undefined), undefined);
		assert.equal(
			parseInteractiveEngineMessage(
				JSON.stringify({ type: "engine_custom_terminal", control: { kind: "autowrap", enabled: true } }),
			),
			undefined,
		);
	});
});

test("resume-style selection preserves picker focus handoff and wire ordering before overlay input", async () => {
	const bridge = makeBridge();
	let pickerDone!: (result: unknown) => void;
	void bridge.child.custom(
		(_tui, _theme, _keys, done) => {
			pickerDone = done as (result: unknown) => void;
			return { render: () => ["picker"], handleInput: () => {}, invalidate: () => {} };
		},
		{ overlay: false },
	);
	await sleep(0);
	assert.equal(bridge.focus, "inline", "the resume picker must take inline focus");

	pickerDone("resume");
	await sleep(0);
	assert.equal(bridge.focus, "editor", "picker completion must restore editor focus");
	assert.deepEqual(bridge.hostWrites, [], "the inline picker must not change host terminal modes");

	const graphInputs: string[] = [];
	void bridge.child.custom(
		() => ({
			render: () => ["overlay"],
			handleInput: (data: string) => graphInputs.push(data),
			invalidate: () => {},
		}),
		{ overlay: true },
	);
	await sleep(0);

	const overlayOpen = bridge.hostMessages.find(
		(message) => message.type === "engine_custom_open" && message.overlay === true,
	);
	assert.ok(overlayOpen, "the resumed workflow must open an overlay");
	const doneIndex = bridge.hostMessages.findIndex((message) => message.type === "engine_custom_done");
	const openIndex = bridge.hostMessages.indexOf(overlayOpen);
	assert.ok(doneIndex !== -1 && doneIndex < openIndex, "picker done must precede overlay open");
	assert.equal(bridge.focus, "overlay", "the workflow overlay must take focus");
	const overlayMount = bridge.mounts.find((mount) => mount.overlay);
	assert.ok(overlayMount?.focused, "the workflow overlay must be focused");

	overlayMount?.component.handleInput?.(WHEEL_UP);
	await sleep(0);
	assert.deepEqual(graphInputs, [WHEEL_UP], "overlay input must still reach the resumed component");
	bridge.controller.dispose();
});

describe("TerminalModeController", () => {
	test("buffers autowrap controls received before mount and flushes on mount", () => {
		const controller = new TerminalModeController(isRegularTui);
		const writes: string[] = [];
		controller.applyControl("c1", { kind: "autowrap", enabled: false });
		assert.equal(writes.length, 0);
		controller.onMount("c1", { write: (data: string) => writes.push(data) });
		assert.deepEqual(writes, [HOST_TERMINAL_AUTOWRAP_OFF]);
	});

	test("resets autowrap when a component unmounts", () => {
		const controller = new TerminalModeController(isRegularTui);
		const writes: string[] = [];
		controller.onMount("c1", { write: (data: string) => writes.push(data) });
		controller.applyControl("c1", { kind: "autowrap", enabled: false });
		controller.onUnmount("c1");
		assert.deepEqual(writes, [HOST_TERMINAL_AUTOWRAP_OFF, HOST_TERMINAL_AUTOWRAP_ON]);
	});

	test("holds autowrap while fullscreen owns terminal modes, then reapplies it in regular mode", () => {
		let fullscreen = true;
		const controller = new TerminalModeController(() => fullscreen);
		const writes: string[] = [];
		controller.onMount("c1", { write: (data: string) => writes.push(data) });
		controller.applyControl("c1", { kind: "autowrap", enabled: false });
		assert.deepEqual(writes, []);

		fullscreen = false;
		controller.rebindTui();
		controller.onUnmount("c1");
		assert.deepEqual(writes, [HOST_TERMINAL_AUTOWRAP_OFF, HOST_TERMINAL_AUTOWRAP_ON]);
	});

	test("writes shared autowrap only when the aggregate changes", () => {
		const controller = new TerminalModeController(isRegularTui);
		const writes: string[] = [];
		const terminal = { write: (data: string) => writes.push(data) };
		controller.onMount("first", terminal);
		controller.onMount("second", terminal);
		controller.applyControl("first", { kind: "autowrap", enabled: false });
		controller.applyControl("second", { kind: "autowrap", enabled: false });
		controller.onUnmount("first");
		controller.onUnmount("second");
		assert.deepEqual(writes, [HOST_TERMINAL_AUTOWRAP_OFF, HOST_TERMINAL_AUTOWRAP_ON]);
	});

	test("ignores the default-restoring control from an unmounted component", () => {
		const controller = new TerminalModeController(isRegularTui);
		const writes: string[] = [];
		controller.applyControl("stale", { kind: "autowrap", enabled: true });
		controller.onMount("stale", { write: (data: string) => writes.push(data) });
		assert.deepEqual(writes, []);
	});

	test("resetAll restores active autowrap and clears state", () => {
		const controller = new TerminalModeController(isRegularTui);
		const writes: string[] = [];
		controller.onMount("c1", { write: (data: string) => writes.push(data) });
		controller.applyControl("c1", { kind: "autowrap", enabled: false });
		writes.length = 0;
		controller.resetAll();
		assert.deepEqual(writes, [HOST_TERMINAL_AUTOWRAP_ON]);
		controller.resetAll();
		assert.deepEqual(writes, [HOST_TERMINAL_AUTOWRAP_ON]);
	});
});

describe("isolated overlay autowrap bridge (source-path)", () => {
	test("keeps remote autowrap quiet in fullscreen and reapplies it after a renderer switch", async () => {
		const bridge = makeBridge({ fullscreen: true });
		let done!: (result: unknown) => void;
		void bridge.child.custom(
			(tui, _t, _k, complete) => {
				done = complete as (result: unknown) => void;
				remoteTerm(tui).setAutowrap?.(false);
				return { render: () => ["component"], handleInput: () => {}, invalidate: () => {} };
			},
			{ overlay: true },
		);
		await sleep(0);
		assert.deepEqual(bridge.hostWrites, []);

		bridge.replaceTuiMode(false);
		assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF]);

		done(undefined);
		await sleep(0);
		assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF, HOST_TERMINAL_AUTOWRAP_ON]);
		bridge.controller.dispose();
	});

	test("resets autowrap when the overlay completes", async () => {
		const bridge = makeBridge();
		let done!: (result: unknown) => void;
		void bridge.child.custom(
			(tui, _t, _k, complete) => {
				done = complete as (result: unknown) => void;
				remoteTerm(tui).setAutowrap?.(false);
				return { render: () => ["component"], handleInput: () => {}, invalidate: () => {} };
			},
			{ overlay: true },
		);
		await sleep(0);
		assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF]);

		done(undefined);
		await sleep(0);
		assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF, HOST_TERMINAL_AUTOWRAP_ON]);
		bridge.controller.dispose();
	});

	test("engine restart resets stranded autowrap", async () => {
		const bridge = makeBridge();
		void bridge.child.custom(autowrapFactory(false), { overlay: true });
		await sleep(0);
		assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF]);

		bridge.emitEngineReady(4242);
		assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF, HOST_TERMINAL_AUTOWRAP_ON]);
		bridge.controller.dispose();
	});

	test("generation death resets autowrap locally without notifying the replacement engine", async () => {
		const bridge = makeBridge();
		void bridge.child.custom(autowrapFactory(false), { overlay: true });
		await sleep(0);
		assert.equal(bridge.focus, "overlay");
		assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF]);
		const commandsBeforeDeath = bridge.childCommands.length;

		bridge.emitGenerationEnded(1);
		await sleep(0);
		assert.equal(bridge.focus, "editor");
		assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF, HOST_TERMINAL_AUTOWRAP_ON]);
		assert.deepEqual(
			bridge.childCommands.slice(commandsBeforeDeath).map((command) => command.type),
			[],
			"death teardown sent a command to the replacement generation",
		);
		// A later engine_ready from the replacement child is an idempotent no-op.
		bridge.emitEngineReady(4242);
		assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF, HOST_TERMINAL_AUTOWRAP_ON]);
		bridge.controller.dispose();
	});

	test("generation death releases a remote widget key without notifying the new engine", async () => {
		const bridge = makeBridge();
		bridge.child.setWidget("remote-widget", () => ({
			render: () => ["widget"],
			handleInput: () => {},
			invalidate: () => {},
		}));
		await sleep(0);
		const commandsBeforeDeath = bridge.childCommands.length;
		bridge.emitGenerationEnded(1);
		await sleep(0);
		assert.deepEqual(
			bridge.childCommands.slice(commandsBeforeDeath).map((command) => command.type),
			[],
		);
		bridge.controller.dispose();
	});
});

test("generation death closes nested remote mounts newest-first", async () => {
	const bridge = makeBridge();
	void bridge.child.custom(() => ({ render: () => ["inline"], handleInput: () => {}, invalidate: () => {} }), {
		overlay: false,
	});
	await sleep(0);
	void bridge.child.custom(() => ({ render: () => ["overlay"], handleInput: () => {}, invalidate: () => {} }), {
		overlay: true,
	});
	await sleep(0);
	assert.equal(bridge.mounts.length, 2, "both layers must be mounted");
	const [inlineMount, overlayMount] = bridge.mounts;
	assert.equal(inlineMount!.overlay, false);
	assert.equal(overlayMount!.overlay, true);

	bridge.emitGenerationEnded(1);
	await sleep(0);
	assert.deepEqual(
		bridge.closeOrder,
		[overlayMount!.componentId, inlineMount!.componentId],
		"the overlay must close before the inline layer it was stacked on",
	);
	assert.equal(bridge.focus, "editor", "focus must end on the editor");
	bridge.controller.dispose();
});
