import assert from "node:assert/strict";
import { type Component, resetCapabilitiesCache, setCapabilities, type Terminal } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	BackgroundRenderLane,
	BackgroundRenderTui,
} from "../../packages/coding-agent/src/modes/interactive-engine/background-render-lane.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { sleep } from "../helpers/runtime.js";

const PNG_TRANSCODER_READY_TIMEOUT_MS = 15_000;

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	resetCapabilitiesCache();
});

class StubTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

function createHarness(): {
	service: EngineCustomUiService;
	messages: InteractiveEngineMessage[];
	send(command: InteractiveEngineCommand): void;
	waitForFrame(
		componentId: string,
		requestId?: number,
		timeoutMs?: number,
	): Promise<Extract<InteractiveEngineMessage, { type: "engine_custom_frame" }>>;
	waitForOpen(
		match: (msg: Extract<InteractiveEngineMessage, { type: "engine_custom_open" }>) => boolean,
	): Promise<string>;
} {
	const messages: InteractiveEngineMessage[] = [];
	const service = new EngineCustomUiService((line) => {
		const parsed = parseInteractiveEngineMessage(line);
		if (parsed) messages.push(parsed);
	}, new KeybindingsManager());
	return {
		service,
		messages,
		send(command) {
			assert.equal(service.handleLine(serializeInteractiveEngineFrame(command)), true);
		},
		async waitForOpen(match) {
			for (let i = 0; i < 200; i++) {
				const found = messages.find(
					(m): m is Extract<InteractiveEngineMessage, { type: "engine_custom_open" }> =>
						m.type === "engine_custom_open" && match(m),
				);
				if (found) return found.componentId;
				await sleep(5);
			}
			throw new Error("timed out waiting for engine_custom_open");
		},
		async waitForFrame(componentId, requestId, timeoutMs = 1_000) {
			const attempts = Math.max(1, Math.ceil(timeoutMs / 5));
			for (let i = 0; i < attempts; i++) {
				const found = messages.find(
					(m): m is Extract<InteractiveEngineMessage, { type: "engine_custom_frame" }> =>
						m.type === "engine_custom_frame" &&
						m.componentId === componentId &&
						(requestId === undefined || m.requestId === requestId),
				);
				if (found) return found;
				await sleep(5);
			}
			throw new Error(`timed out waiting for engine_custom_frame on ${componentId}`);
		},
	};
}

function makeHostileThrows(): Array<{ label: string; value: unknown; expectedSubstring: string }> {
	const brokenError = new Error("initial");
	Object.defineProperty(brokenError, "message", {
		get() {
			throw Object.create(null);
		},
	});
	return [
		{ label: "null", value: null, expectedSubstring: "Remote component render failed: null" },
		{ label: "null-proto", value: Object.create(null), expectedSubstring: "Remote component render failed:" },
		{ label: "symbol", value: Symbol("bad"), expectedSubstring: "Remote component render failed: Symbol(bad)" },
		{
			label: "throwing-toString",
			value: {
				toString() {
					throw Object.create(null);
				},
			},
			expectedSubstring: "Remote component render failed:",
		},
		{ label: "throwing-error-message", value: brokenError, expectedSubstring: "Remote component render failed:" },
	];
}

test("transcoder check render on a Kitty terminal catches throws on the background lane and sends failure frames (#5239)", async () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const harness = createHarness();
	try {
		harness.service.setWidget("kitty-widget", () => ({
			render(): string[] {
				throw Object.create(null);
			},
			invalidate() {},
		}));
		void harness.service.custom(() => ({
			render(): string[] {
				throw null;
			},
			invalidate() {},
		}));
		const widgetId = await harness.waitForOpen((m) => m.widgetKey === "kitty-widget");
		const customId = await harness.waitForOpen((m) => m.widgetKey === undefined);

		const widgetFailure = await harness.waitForFrame(widgetId, 0, PNG_TRANSCODER_READY_TIMEOUT_MS);
		assert.deepEqual(widgetFailure.lines, ["Remote component render failed: Remote component render failed."]);

		const customFailure = await harness.waitForFrame(customId, 0, PNG_TRANSCODER_READY_TIMEOUT_MS);
		assert.deepEqual(customFailure.lines, ["Remote component render failed: null"]);
	} finally {
		harness.service.dispose();
	}
});

test("background check render failure carries the latest requestId so the host replaces a prior frame (#5239)", async () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const harness = createHarness();
	try {
		let shouldThrow = false;
		let widgetScreen: { requestRender(): void } | undefined;
		let customScreen: { requestRender(): void } | undefined;
		harness.service.setWidget("dynamic-widget", (tui) => {
			widgetScreen = tui;
			return {
				render(): string[] {
					if (shouldThrow) throw Symbol("late-widget-throw");
					return ["ok widget"];
				},
				invalidate() {},
			} satisfies Component;
		});
		void harness.service.custom((tui) => {
			customScreen = tui;
			return {
				render(): string[] {
					if (shouldThrow) throw Symbol("late-custom-throw");
					return ["ok custom"];
				},
				invalidate() {},
			} satisfies Component;
		});
		const widgetId = await harness.waitForOpen((m) => m.widgetKey === "dynamic-widget");
		const customId = await harness.waitForOpen((m) => m.widgetKey === undefined);

		harness.send({ type: "engine_custom_render", componentId: widgetId, requestId: 3, width: 80, rows: 24 });
		harness.send({ type: "engine_custom_render", componentId: customId, requestId: 5, width: 80, rows: 24 });
		assert.deepEqual((await harness.waitForFrame(widgetId, 3)).lines, ["ok widget"]);
		assert.deepEqual((await harness.waitForFrame(customId, 5)).lines, ["ok custom"]);

		harness.messages.length = 0;
		shouldThrow = true;
		widgetScreen?.requestRender();
		customScreen?.requestRender();

		const widgetFailure = await harness.waitForFrame(widgetId, 3);
		assert.deepEqual(widgetFailure.lines, ["Remote component render failed: Symbol(late-widget-throw)"]);

		const customFailure = await harness.waitForFrame(customId, 5);
		assert.deepEqual(customFailure.lines, ["Remote component render failed: Symbol(late-custom-throw)"]);
	} finally {
		harness.service.dispose();
	}
});

test("engine custom and widget renders contain non-Error and uncoercible thrown values (#5239)", async () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const harness = createHarness();
	try {
		for (const [index, entry] of makeHostileThrows().entries()) {
			const widgetKey = `w-${entry.label}`;
			harness.service.setWidget(widgetKey, () => ({
				render(): string[] {
					throw entry.value;
				},
				invalidate() {},
			}));
			const widgetId = await harness.waitForOpen((m) => m.widgetKey === widgetKey);
			const widgetReqId = index + 1;
			harness.send({
				type: "engine_custom_render",
				componentId: widgetId,
				requestId: widgetReqId,
				width: 80,
				rows: 24,
			});
			const widgetFrame = await harness.waitForFrame(widgetId, widgetReqId);
			assert.equal(widgetFrame.lines.length, 1);
			assert.ok(
				widgetFrame.lines[0]?.includes(entry.expectedSubstring),
				`widget ${entry.label}: expected ${entry.expectedSubstring}, got ${widgetFrame.lines[0]}`,
			);

			void harness.service.custom(() => ({
				render(): string[] {
					throw entry.value;
				},
				invalidate() {},
			}));
			const customId = await harness.waitForOpen(
				(m) => m.widgetKey === undefined && m.componentId.endsWith(`_${(index + 1) * 2}`),
			);
			const customReqId = index + 100;
			harness.send({
				type: "engine_custom_render",
				componentId: customId,
				requestId: customReqId,
				width: 80,
				rows: 24,
			});
			const customFrame = await harness.waitForFrame(customId, customReqId);
			assert.equal(customFrame.lines.length, 1);
			assert.ok(
				customFrame.lines[0]?.includes(entry.expectedSubstring),
				`custom ${entry.label}: expected ${entry.expectedSubstring}, got ${customFrame.lines[0]}`,
			);
		}
	} finally {
		harness.service.dispose();
	}
});

test("setWidget factory contains non-Error and uncoercible thrown values (#5239)", async () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const harness = createHarness();
	try {
		for (const entry of makeHostileThrows()) {
			const key = `factory-${entry.label}`;
			harness.service.setWidget(key, () => {
				throw entry.value;
			});
			const prefix = `Widget ${key} failed:`;
			let frame: Extract<InteractiveEngineMessage, { type: "engine_custom_frame" }> | undefined;
			for (let i = 0; i < 200; i++) {
				frame = harness.messages.find(
					(m): m is Extract<InteractiveEngineMessage, { type: "engine_custom_frame" }> =>
						m.type === "engine_custom_frame" && (m.lines[0]?.startsWith(prefix) ?? false),
				);
				if (frame) break;
				await sleep(5);
			}
			assert.ok(frame, `expected failure frame for ${key}`);
			assert.equal(frame.requestId, 0);
		}
	} finally {
		harness.service.dispose();
	}
});

test("BackgroundRenderTui forwards doRender failures to onRenderError without aborting subsequent lane jobs (#5239)", async () => {
	const turns: Array<() => void> = [];
	const lane = new BackgroundRenderLane(() => new Promise<void>((resolve) => turns.push(resolve)));
	const caught: unknown[] = [];
	const tui = new BackgroundRenderTui(new StubTerminal(), lane, "check:w1", (error) => caught.push(error));
	const sentinel = Object.create(null);
	tui.addChild({
		render(): string[] {
			throw sentinel;
		},
		invalidate() {},
	});
	const ran: string[] = [];
	tui.renderNow();
	lane.schedule("raw-throw", () => {
		throw Object.create(null);
	});
	lane.schedule("after", () => ran.push("after"));

	while (turns.length > 0) {
		turns.shift()?.();
		for (let i = 0; i < 4; i++) await Promise.resolve();
	}

	assert.equal(caught.length, 1);
	assert.equal(caught[0], sentinel);
	assert.deepEqual(ran, ["after"]);
	tui.stop();
});
