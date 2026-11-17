import assert from "node:assert/strict";
import { resetCapabilitiesCache, setCapabilities } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { sleep } from "../helpers/runtime.js";

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	resetCapabilitiesCache();
});

function makeHostilePromiseThrows(label: string): Record<string, () => unknown> {
	return {
		message_getter_rejects: () => {
			const error = new Error("x");
			Object.defineProperty(error, "message", {
				get: () => Promise.reject(new Error(`${label}:message`)),
			});
			return error;
		},
		tostring_rejects: () => ({
			toString: () => Promise.reject(new Error(`${label}:toString`)),
		}),
		toprimitive_rejects: () => ({
			[Symbol.toPrimitive]: () => Promise.reject(new Error(`${label}:toPrimitive`)),
		}),
		thrown_promise: () => Promise.reject(new Error(`${label}:thrown-promise`)),
	};
}

test("engine widget render, custom render, and widget factory contain rejecting promises from thrown values without unhandled rejections (#5239)", async () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const leaked: string[] = [];
	const onRejection = (reason: unknown) => {
		leaked.push(String((reason as Error)?.message ?? reason));
	};
	process.on("unhandledRejection", onRejection);
	const messages: InteractiveEngineMessage[] = [];
	const service = new EngineCustomUiService((line) => {
		const parsed = parseInteractiveEngineMessage(line);
		if (parsed) messages.push(parsed);
	}, new KeybindingsManager());
	const send = (command: InteractiveEngineCommand) => {
		assert.equal(service.handleLine(serializeInteractiveEngineFrame(command)), true);
	};
	const frames: Record<string, string | undefined> = {};
	const expectedFrames: Record<string, string> = {};
	try {
		let request = 1;
		for (const [mode, make] of Object.entries(makeHostilePromiseThrows("widget-render"))) {
			const key = `w-${mode}`;
			service.setWidget(key, () => ({
				render(): string[] {
					throw make();
				},
				invalidate() {},
			}));
			let componentId: string | undefined;
			for (let i = 0; i < 200 && componentId === undefined; i++) {
				componentId = messages.find(
					(m): m is Extract<InteractiveEngineMessage, { type: "engine_custom_open" }> =>
						m.type === "engine_custom_open" && m.widgetKey === key,
				)?.componentId;
				if (componentId === undefined) await sleep(5);
			}
			assert.ok(componentId);
			const requestId = ++request;
			send({ type: "engine_custom_render", componentId, requestId, width: 80, rows: 24 });
			let frame: string | undefined;
			for (let i = 0; i < 200 && frame === undefined; i++) {
				frame = messages.find(
					(m): m is Extract<InteractiveEngineMessage, { type: "engine_custom_frame" }> =>
						m.type === "engine_custom_frame" && m.componentId === componentId && m.requestId === requestId,
				)?.lines[0];
				if (frame === undefined) await sleep(5);
			}
			await sleep(20);
			frames[`widget:${mode}`] = frame;
			expectedFrames[`widget:${mode}`] = "Remote component render failed: Remote component render failed.";
		}
		for (const [mode, make] of Object.entries(makeHostilePromiseThrows("widget-factory"))) {
			const key = `f-${mode}`;
			service.setWidget(key, () => {
				throw make();
			});
			const prefix = `Widget ${key} failed: `;
			let frame: string | undefined;
			for (let i = 0; i < 200 && frame === undefined; i++) {
				frame = messages.find(
					(m): m is Extract<InteractiveEngineMessage, { type: "engine_custom_frame" }> =>
						m.type === "engine_custom_frame" && (m.lines[0]?.startsWith(prefix) ?? false),
				)?.lines[0];
				if (frame === undefined) await sleep(5);
			}
			await sleep(20);
			frames[`factory:${mode}`] = frame;
			expectedFrames[`factory:${mode}`] = `Widget ${key} failed: Remote component render failed.`;
		}
		for (const [mode, make] of Object.entries(makeHostilePromiseThrows("custom-render"))) {
			const openCountBefore = messages.filter(
				(m) => m.type === "engine_custom_open" && m.widgetKey === undefined,
			).length;
			void service.custom(() => ({
				render(): string[] {
					throw make();
				},
				invalidate() {},
			}));
			let componentId: string | undefined;
			for (let i = 0; i < 200 && componentId === undefined; i++) {
				const opens = messages.filter(
					(m): m is Extract<InteractiveEngineMessage, { type: "engine_custom_open" }> =>
						m.type === "engine_custom_open" && m.widgetKey === undefined,
				);
				componentId = opens[openCountBefore]?.componentId;
				if (componentId === undefined) await sleep(5);
			}
			assert.ok(componentId, `expected custom open for ${mode}`);
			const requestId = ++request;
			send({ type: "engine_custom_render", componentId, requestId, width: 80, rows: 24 });
			let frame: string | undefined;
			for (let i = 0; i < 200 && frame === undefined; i++) {
				frame = messages.find(
					(m): m is Extract<InteractiveEngineMessage, { type: "engine_custom_frame" }> =>
						m.type === "engine_custom_frame" && m.componentId === componentId && m.requestId === requestId,
				)?.lines[0];
				if (frame === undefined) await sleep(5);
			}
			await sleep(20);
			frames[`custom:${mode}`] = frame;
			expectedFrames[`custom:${mode}`] = "Remote component render failed: Remote component render failed.";
		}
	} finally {
		service.dispose();
		await sleep(50);
		process.off("unhandledRejection", onRejection);
	}
	assert.deepEqual({ leaked, frames }, { leaked: [], frames: expectedFrames });
});
