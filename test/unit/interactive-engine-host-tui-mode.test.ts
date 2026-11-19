import assert from "node:assert/strict";
import { WriteStream } from "node:tty";
import {
	type Component,
	ProcessTerminal,
	resetCapabilitiesCache,
	setCapabilities,
	type TUI,
} from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { refreshColorEnvironment } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineCommand,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";

const WIDTH = 60;

// On a Kitty-capable terminal an engine screen invalidates its component once more when the PNG transcoder
// finishes loading, at a time no test controls. That would hide a component the engine fails to invalidate
// itself, so these tests run without image support.
beforeEach(() => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
});

afterEach(() => {
	refreshColorEnvironment();
	resetCapabilitiesCache();
});

const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** A component that paints the mode of the TUI an extension was given. */
const modeProbe = (tui: TUI, label: string) => ({
	invalidate() {},
	render: () => [`${label} tui.mode=${tui.mode}`],
});

/**
 * An isolated host and its engine joined as the CLI joins them: the extension runs in the engine and opens its UI
 * through the engine's extension UI context, and the host proxies it with its own renderer.
 */
function connectHostAndEngine(host: { fullscreen: boolean; colorDepth?: number }) {
	const engineListeners = new Set<(message: InteractiveEngineMessage) => void>();
	const rendererReplaced = new Set<() => void>();
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) for (const listener of engineListeners) listener(message);
	}, new KeybindingsManager());
	const engineUi = createRpcExtensionUIContext({
		output: () => {},
		pendingExtensionRequests: new Map(),
		customUi: service,
	});
	const runtime: RemoteComponentRuntime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener) => {
			engineListeners.add(listener);
			return () => engineListeners.delete(listener);
		},
		sendEngineCommand: (command) => service.handleLine(serializeInteractiveEngineFrame(command)),
	};
	const proxies: Component[] = [];
	const hostTui = {
		terminal: { rows: 20, columns: WIDTH, colorDepth: host.colorDepth },
		requestRender: () => {},
	} as unknown as TUI;
	const hostUi = {
		custom: ((factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
			proxies.push(factory(hostTui, {} as never, new KeybindingsManager(), () => {}) as Component);
			return new Promise(() => {});
		}) as ExtensionUIContext["custom"],
		setWidget: ((_key: string, factory: ((tui: TUI) => Component) | undefined) => {
			if (factory) proxies.push(factory(hostTui));
		}) as ExtensionUIContext["setWidget"],
		requestRender: () => {},
	};
	const controller = new RemoteComponentController(runtime, hostUi, {
		isFullscreen: () => host.fullscreen,
		onRendererReplaced: (listener) => {
			rendererReplaced.add(listener);
			return () => rendererReplaced.delete(listener);
		},
	});
	/** The host renders the proxy, then again once the engine's frame has arrived. */
	const paint = async (proxy: Component | undefined) => {
		assert.ok(proxy, "the host mounted the engine component");
		proxy.render(WIDTH);
		await flush();
		return proxy.render(WIDTH)[0];
	};
	/** The host switches between its fullscreen renderer and the main-screen fallback. */
	const switchRenderer = (fullscreen: boolean) => {
		host.fullscreen = fullscreen;
		for (const listener of rendererReplaced) listener();
	};
	const dispose = () => {
		controller.dispose();
		service.dispose();
	};
	return { engineUi, proxies, paint, switchRenderer, dispose };
}

test("the terminal advertises the stage palette supported by its display (#5596)", () => {
	const saved = Object.getOwnPropertyDescriptor(process.stdout, "getColorDepth");
	try {
		Object.defineProperty(process.stdout, "getColorDepth", {
			value: WriteStream.prototype.getColorDepth,
			configurable: true,
		});
		vi.stubEnv("TMUX", "pane");
		vi.stubEnv("FORCE_COLOR", undefined);
		vi.stubEnv("NO_COLOR", undefined);
		vi.stubEnv("COLORTERM", undefined);
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		for (const [term, expected] of [
			["tmux-256color", 8],
			["linux", 4],
		] as const) {
			vi.stubEnv("TERM", term);
			assert.equal(new ProcessTerminal().colorDepth, expected, term);
		}
		vi.stubEnv("TMUX", undefined);
		vi.stubEnv("TERM", "xterm-direct");
		vi.stubEnv("TERM_PROGRAM", undefined);
		vi.stubEnv("CI", undefined);
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		assert.equal(new ProcessTerminal().colorDepth, 24, "direct colour without a separate colour hint");
	} finally {
		if (saved) Object.defineProperty(process.stdout, "getColorDepth", saved);
		else Reflect.deleteProperty(process.stdout, "getColorDepth");
		vi.unstubAllEnvs();
	}
});

for (const fullscreen of [true, false]) {
	const hostMode = fullscreen ? "fullscreen" : "regular";
	const flippedMode = fullscreen ? "regular" : "fullscreen";

	test(`an engine custom component sees the ${hostMode} host's TUI mode and follows a renderer switch`, async () => {
		const bridge = connectHostAndEngine({ fullscreen });
		try {
			void bridge.engineUi.custom<void>((tui) => modeProbe(tui, "custom"));
			await flush();
			assert.equal(await bridge.paint(bridge.proxies[0]), `custom tui.mode=${hostMode}`);
			bridge.switchRenderer(!fullscreen);
			assert.equal(await bridge.paint(bridge.proxies[0]), `custom tui.mode=${flippedMode}`);
			bridge.switchRenderer(fullscreen);
			assert.equal(await bridge.paint(bridge.proxies[0]), `custom tui.mode=${hostMode}`);
		} finally {
			bridge.dispose();
		}
	});

	test(`an engine widget sees the ${hostMode} host's TUI mode and follows a renderer switch`, async () => {
		const bridge = connectHostAndEngine({ fullscreen });
		try {
			bridge.engineUi.setWidget("mode-probe", (tui) => modeProbe(tui, "widget"));
			await flush();
			assert.equal(await bridge.paint(bridge.proxies[0]), `widget tui.mode=${hostMode}`);
			bridge.switchRenderer(!fullscreen);
			assert.equal(await bridge.paint(bridge.proxies[0]), `widget tui.mode=${flippedMode}`);
		} finally {
			bridge.dispose();
		}
	});
}

test("an engine component that caches its lines lays itself out again after a host renderer switch", async () => {
	const bridge = connectHostAndEngine({ fullscreen: true });
	try {
		void bridge.engineUi.custom<void>((tui) => {
			let cached: { width: number; lines: string[] } | undefined;
			return {
				invalidate() {
					cached = undefined;
				},
				render(width) {
					if (cached?.width !== width) cached = { width, lines: [`cached tui.mode=${tui.mode}`] };
					return cached.lines;
				},
			};
		});
		await flush();
		assert.equal(await bridge.paint(bridge.proxies[0]), "cached tui.mode=fullscreen");
		bridge.switchRenderer(false);
		assert.equal(await bridge.paint(bridge.proxies[0]), "cached tui.mode=regular");
	} finally {
		bridge.dispose();
	}
});

test("an engine component built after the host's first frame request sees the host's mode in its factory", async () => {
	const bridge = connectHostAndEngine({ fullscreen: true });
	try {
		void bridge.engineUi.custom<void>((tui) => modeProbe(tui, "first"));
		await flush();
		await bridge.paint(bridge.proxies[0]);
		void bridge.engineUi.custom<void>((tui) => {
			const builtFor = tui.mode;
			return { invalidate() {}, render: () => [`built for tui.mode=${builtFor}`] };
		});
		await flush();
		assert.equal(await bridge.paint(bridge.proxies[1]), "built for tui.mode=fullscreen");
	} finally {
		bridge.dispose();
	}
});

test("an engine keeps reporting the regular mode to a host that sends no mode", async () => {
	const frames: InteractiveEngineMessage[] = [];
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) frames.push(message);
	}, new KeybindingsManager());
	try {
		void service.custom<void>((tui) => modeProbe(tui, "older host"));
		await flush();
		const opened = frames.find((message) => message.type === "engine_custom_open");
		assert.ok(opened?.type === "engine_custom_open");
		const request = {
			type: "engine_custom_render",
			componentId: opened.componentId,
			requestId: 1,
			width: WIDTH,
			rows: 20,
		};
		service.handleLine(JSON.stringify(request));
		await flush();
		const frame = frames.find((message) => message.type === "engine_custom_frame");
		assert.ok(frame?.type === "engine_custom_frame");
		assert.deepEqual(frame.lines, ["older host tui.mode=regular"]);
	} finally {
		service.dispose();
	}
});

test("render requests carry only a well-formed host mode", () => {
	const request = (hostMode: unknown) =>
		parseInteractiveEngineCommand(
			JSON.stringify({
				type: "engine_custom_render",
				componentId: "c",
				requestId: 1,
				width: 80,
				rows: 24,
				hostMode,
			}),
		);
	for (const hostMode of ["fullscreen", "regular"] as const) {
		assert.deepEqual(request(hostMode), {
			type: "engine_custom_render",
			componentId: "c",
			requestId: 1,
			width: 80,
			rows: 24,
			hostMode,
		});
	}
	for (const invalid of [undefined, null, "alt-screen", "FULLSCREEN", true, 1, {}]) {
		const parsed = request(invalid);
		assert.ok(parsed?.type === "engine_custom_render", "a malformed mode does not drop the frame request");
		assert.equal("hostMode" in parsed, false, JSON.stringify(invalid));
	}
});
