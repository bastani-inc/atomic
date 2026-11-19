import type { Component, OverlayOptions } from "@bastani/atomic-tui";
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
import type { ClickScreen } from "./fullscreen-clicks.js";
import { sleep } from "./runtime.js";

/** Mount a real engine component and have the host paint its asynchronous replies. */
export async function showFromEngine(
	ui: ClickScreen,
	factory: Parameters<EngineCustomUiService["custom"]>[0],
	overlay: boolean,
	overlayOptions?: OverlayOptions,
): Promise<{ dispose(): void }> {
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const engine = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		setTimeout(() => {
			for (const listener of [...listeners]) listener(message);
		}, 10);
	}, new KeybindingsManager());
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) =>
			engine.handleLine(serializeInteractiveEngineFrame(command)),
	} as unknown as IsolatedInteractiveRuntime;
	let mounted = false;
	const host = {
		requestRender: () => ui.tui.requestRender(),
		setWidget: () => {},
		custom: (
			create: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => Component,
			options?: { overlayOptions?: OverlayOptions },
		) =>
			new Promise(() => {
				const component = create(ui.tui, {}, {}, () => {});
				if (overlay && options?.overlayOptions) {
					ui.tui.showOverlay(component, options.overlayOptions);
					ui.tui.renderNow();
				} else if (overlay) ui.mount(component);
				else ui.dock(component);
				mounted = true;
			}),
	} as unknown as ExtensionUIContext;
	const controller = new RemoteComponentController(runtime, host, {
		isFullscreen: () => true,
		onRendererReplaced: () => () => {},
	});
	void engine.custom(factory, overlay ? { overlay: true, overlayOptions } : undefined);
	for (let attempt = 0; attempt < 200 && !mounted; attempt++) await sleep(5);
	await sleep(100);
	return {
		dispose: () => {
			controller.dispose();
			engine.dispose();
		},
	};
}

/** Mount the same component in either host, then return keyboard focus to the composer without hiding the pane. */
export async function leavePaneVisible(
	ui: ClickScreen,
	component: Component,
	host: "local" | "engine",
	overlay: boolean,
) {
	const remote = host === "engine" ? await showFromEngine(ui, () => component, overlay) : undefined;
	if (!remote) {
		if (overlay) ui.mount(component);
		else ui.dock(component);
	}
	const pane = ui.tui.getFocusedComponent();
	ui.focusComposer();
	return { pane, dispose: () => remote?.dispose() };
}
