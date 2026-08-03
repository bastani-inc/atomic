/**
 * Host escape from a remote `ctx.ui.custom()` component that owns input.
 *
 * A component that never resolves would otherwise swallow every key, including
 * Ctrl+C, because a remote proxy forwards input to the engine child. The host
 * therefore closes exactly the focused proxy — not the engine, and not the other
 * components that generation has mounted. A component that declares it binds
 * Ctrl+C itself keeps receiving the key instead.
 */

import assert from "node:assert/strict";
import type { Component } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { sleep } from "../helpers/runtime.js";

interface HostMount {
	readonly componentId: string;
	readonly component: Component;
	readonly overlay: boolean;
	settled: boolean;
}

interface Bridge {
	child: EngineCustomUiService;
	controller: RemoteComponentController;
	mounts: HostMount[];
	childCommands: InteractiveEngineCommand[];
	/** Live inline mounts, in mount order — the host's editorContainer stand-in. */
	inline(): HostMount[];
	widgets: string[];
}

function makeBridge(): Bridge {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const mounts: HostMount[] = [];
	const childCommands: InteractiveEngineCommand[] = [];
	const widgets: string[] = [];

	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		for (const listener of [...engineListeners]) listener(message);
	}, new KeybindingsManager());

	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			engineListeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: unknown) => {
			childCommands.push(command as InteractiveEngineCommand);
			child.handleLine(serializeInteractiveEngineFrame(command as never));
		},
	} as unknown as IsolatedInteractiveRuntime;

	let pendingComponentId: string | undefined;
	engineListeners.push((message) => {
		if (message.type === "engine_custom_open") pendingComponentId = message.componentId;
	});

	const ui = {
		requestRender: () => {},
		setWidget: (key: string, factory: unknown) => {
			if (factory === undefined) widgets.splice(widgets.indexOf(key), 1);
			else widgets.push(key);
		},
		custom: (
			factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => Component,
			options: { overlay?: boolean; onHandle?: (handle: unknown) => void },
		) =>
			new Promise((resolve) => {
				const componentId = pendingComponentId!;
				const mount: HostMount = {
					componentId,
					overlay: options.overlay === true,
					settled: false,
					component: undefined as unknown as Component,
				};
				const done = (result: unknown): void => {
					mount.settled = true;
					resolve(result);
				};
				const tui = {
					terminal: { rows: 40, columns: 100, write: () => {} },
					requestRender: () => {},
					setFocus: () => {},
				};
				(mount as { component: Component }).component = factory(tui, {}, {}, done);
				mounts.push(mount);
				options.onHandle?.({
					hide: () => {},
					setHidden: () => {},
					isHidden: () => false,
					focus: () => {},
					unfocus: () => {},
					isFocused: () => true,
				});
			}),
	} as unknown as ExtensionUIContext;

	return {
		child,
		controller: new RemoteComponentController(runtime, ui),
		mounts,
		childCommands,
		widgets,
		inline: () => mounts.filter((mount) => !mount.overlay && !mount.settled),
	};
}

function panel(): (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => Component {
	// Deliberately never calls done: the trapped component this escape exists for.
	return () => ({ render: () => ["panel"], handleInput: () => {}, invalidate: () => {} });
}

test("the host closes exactly the focused undeclared proxy and the child promise settles", async () => {
	const bridge = makeBridge();
	let childResult: unknown = "unsettled";
	void bridge.child.custom(panel(), { overlay: false }).then((result) => {
		childResult = result;
	});
	await sleep(0);
	const mount = bridge.mounts[0]!;
	assert.equal(bridge.controller.remoteProxyHandlesCtrlC(mount.component), false);

	assert.equal(bridge.controller.dismissRemoteProxy(mount.component), true);
	await sleep(0);

	assert.equal(mount.settled, true, "the host ui.custom() promise must settle");
	assert.equal(childResult, undefined, "the extension's own promise must resolve like a cancel");
	assert.ok(
		bridge.childCommands.some((command) => command.type === "engine_custom_dispose"),
		"a healthy child must be told the component closed",
	);
	assert.deepEqual(bridge.inline(), [], "the editor slot must be free again");
	bridge.controller.dispose();
});

test("a component that declared handlesCtrlC keeps the key", async () => {
	const bridge = makeBridge();
	void bridge.child.custom(panel(), { overlay: false, handlesCtrlC: true });
	await sleep(0);
	assert.equal(bridge.controller.remoteProxyHandlesCtrlC(bridge.mounts[0]!.component), true);
	// Still closable: the route only forwards the first press to it.
	assert.equal(bridge.controller.dismissRemoteProxy(bridge.mounts[0]!.component), true);
	bridge.controller.dispose();
});

test("closing the focused overlay leaves the component nested below it alive", async () => {
	const bridge = makeBridge();
	void bridge.child.custom(panel(), { overlay: false });
	await sleep(0);
	void bridge.child.custom(panel(), { overlay: true });
	await sleep(0);
	const [inline, overlay] = bridge.mounts as [HostMount, HostMount];

	assert.equal(bridge.controller.dismissRemoteProxy(overlay.component), true);
	await sleep(0);

	assert.equal(overlay.settled, true);
	assert.equal(inline.settled, false, "an unrelated nested component must survive the escape");
	assert.deepEqual(bridge.inline(), [inline]);
	bridge.controller.dispose();
});

test("widget proxies are never dismissible and unknown components are ignored", async () => {
	const bridge = makeBridge();
	bridge.child.setWidget("remote-widget", () => ({
		render: () => ["w"],
		handleInput: () => {},
		invalidate: () => {},
	}));
	await sleep(0);
	assert.deepEqual(bridge.widgets, ["remote-widget"]);
	// Widgets never own keyboard input, so they are not an escape target.
	assert.equal(bridge.controller.dismissRemoteProxy({}), false);
	assert.equal(bridge.controller.remoteProxyHandlesCtrlC({}), false);
	assert.deepEqual(bridge.widgets, ["remote-widget"]);
	bridge.controller.dispose();
});
