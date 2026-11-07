import assert from "node:assert/strict";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineCommand,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * A host and an engine joined as the isolated CLI joins them: the engine's overlay renders from the engine's
 * extension UI context, and the host proxies it through a remote component.
 */
async function mountEngineOverlay(
	host: { hideThinkingBlock: boolean; toolOutputExpanded: boolean; wheel: number | "auto" } | undefined,
) {
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const commands: InteractiveEngineCommand[] = [];
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) for (const listener of listeners) listener(message);
	}, new KeybindingsManager());
	const engineUi = createRpcExtensionUIContext({
		output: () => {},
		pendingExtensionRequests: new Map(),
		customUi: service,
	});
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			commands.push(command);
			service.handleLine(serializeInteractiveEngineFrame(command));
		},
	} as unknown as IsolatedInteractiveRuntime;
	let proxy: Component | undefined;
	const tui = { terminal: { rows: 20, columns: 60 }, requestRender: () => {} } as unknown as TUI;
	const hostUi: Pick<ExtensionUIContext, "custom" | "requestRender" | "setWidget"> = {
		custom: ((factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
			proxy = factory(tui, {} as never, new KeybindingsManager(), () => {}) as Component;
			return new Promise(() => {});
		}) as ExtensionUIContext["custom"],
		requestRender: () => {},
		setWidget: () => {},
	};
	const controller = new RemoteComponentController(runtime, hostUi, {
		isFullscreen: () => true,
		onRendererReplaced: () => () => {},
		...(host === undefined
			? {}
			: {
					chatRenderSettings: () => ({
						hideThinkingBlock: host.hideThinkingBlock,
						toolOutputExpanded: host.toolOutputExpanded,
						fullscreenScrollbar: "always" as const,
						fullscreenWheelScrollLines: host.wheel,
					}),
				}),
	});
	void engineUi.custom<void>(() => ({
		invalidate() {},
		render: () => {
			const settings = engineUi.getChatRenderSettings();
			return [
				`hide=${settings.hideThinkingBlock} bar=${settings.fullscreenScrollbar} wheel=${settings.fullscreenWheelScrollLines}`,
			];
		},
	}));
	await flush();
	assert.ok(proxy, "the host mounted the engine overlay");
	const paint = async () => {
		proxy?.render(60);
		await flush();
		return proxy?.render(60)[0];
	};
	return { paint, commands, controller, service, engineUi };
}

const renderRequests = (commands: readonly InteractiveEngineCommand[]) =>
	commands.filter((command) => command.type === "engine_custom_render");

/** The host settings the engine received with its latest frame request. */
const latestSettings = (commands: readonly InteractiveEngineCommand[]) => {
	const latest = renderRequests(commands).at(-1);
	return latest?.type === "engine_custom_render" ? latest.renderSettings : undefined;
};

test("an engine overlay follows the host's thinking display, tool output and scroll settings (#4521)", async () => {
	const host = { hideThinkingBlock: false, toolOutputExpanded: false, wheel: 7 as number | "auto" };
	const engine = await mountEngineOverlay(host);
	const expected = () => ({
		hideThinkingBlock: host.hideThinkingBlock,
		toolOutputExpanded: host.toolOutputExpanded,
		fullscreenScrollbar: "always",
		fullscreenWheelScrollLines: host.wheel,
	});
	try {
		assert.equal(await engine.paint(), "hide=false bar=always wheel=7");
		assert.deepEqual(latestSettings(engine.commands), expected());
		host.hideThinkingBlock = true;
		assert.equal(await engine.paint(), "hide=true bar=always wheel=7", "Ctrl+T in the host reaches the engine");
		assert.deepEqual(latestSettings(engine.commands), expected());
		host.wheel = "auto";
		assert.equal(await engine.paint(), "hide=true bar=always wheel=auto");
		assert.deepEqual(latestSettings(engine.commands), expected());
		host.toolOutputExpanded = true;
		await engine.paint();
		assert.deepEqual(latestSettings(engine.commands), expected(), "Ctrl+O in the host reaches the engine");
		assert.deepEqual(engine.service.getHostRenderSettings(), expected());
	} finally {
		engine.controller.dispose();
		engine.service.dispose();
	}
});

test("without host settings an engine keeps its own defaults (#4521)", async () => {
	const engine = await mountEngineOverlay(undefined);
	try {
		assert.equal(await engine.paint(), "hide=false bar=undefined wheel=undefined");
		assert.equal(engine.service.getHostRenderSettings(), undefined);
		assert.ok(renderRequests(engine.commands).every((command) => !("renderSettings" in command)));
	} finally {
		engine.controller.dispose();
		engine.service.dispose();
	}
});

test("render requests accept only well-formed host settings (#4521)", () => {
	const request = (renderSettings: unknown) =>
		parseInteractiveEngineCommand(
			JSON.stringify({
				type: "engine_custom_render",
				componentId: "c",
				requestId: 1,
				width: 80,
				rows: 24,
				renderSettings,
			}),
		);
	const valid = {
		hideThinkingBlock: true,
		toolOutputExpanded: false,
		fullscreenScrollbar: "hidden",
		fullscreenWheelScrollLines: 3,
	};
	assert.deepEqual(request(valid), {
		type: "engine_custom_render",
		componentId: "c",
		requestId: 1,
		width: 80,
		rows: 24,
		renderSettings: valid,
	});
	assert.deepEqual(request({ ...valid, fullscreenScrollbar: "auto", fullscreenWheelScrollLines: "auto" }), {
		type: "engine_custom_render",
		componentId: "c",
		requestId: 1,
		width: 80,
		rows: 24,
		renderSettings: {
			hideThinkingBlock: true,
			toolOutputExpanded: false,
			fullscreenScrollbar: "auto",
			fullscreenWheelScrollLines: "auto",
		},
	});
	for (const invalid of [
		null,
		[],
		"settings",
		{ ...valid, hideThinkingBlock: "yes" },
		{ ...valid, toolOutputExpanded: "yes" },
		{ ...valid, toolOutputExpanded: undefined },
		{ ...valid, fullscreenScrollbar: "sometimes" },
		{ ...valid, fullscreenWheelScrollLines: 0 },
		{ ...valid, fullscreenWheelScrollLines: Number.POSITIVE_INFINITY },
		{ ...valid, fullscreenWheelScrollLines: "fast" },
	]) {
		const parsed = request(invalid);
		assert.ok(parsed?.type === "engine_custom_render");
		assert.equal("renderSettings" in parsed, false, JSON.stringify(invalid));
	}
});
