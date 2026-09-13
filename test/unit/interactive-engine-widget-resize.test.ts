import assert from "node:assert/strict";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { Theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
	type RemoteComponentUI,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { WorkflowWidgetViewport } from "../../packages/workflows/src/tui/widget-viewport.ts";
import { sleep } from "../helpers/runtime.js";
import { nativeWorkflowViewport } from "../helpers/workflow-native-viewport.js";

// #2700: a mounted workflow widget must receive resize rows, not the mount-time snapshot.
test("remote workflow widget follows live terminal row budgets without remount", async () => {
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const commands: InteractiveEngineCommand[] = [];
	const terminal = { rows: 40 };
	let mounted: Pick<Component, "render"> | undefined;
	let mounts = 0;
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		assert.ok(message);
		for (const listener of listeners) listener(message);
	}, new KeybindingsManager());
	const runtime: RemoteComponentRuntime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		sendEngineCommand: (command) => {
			commands.push(command);
			service.handleLine(serializeInteractiveEngineFrame(command));
		},
	};
	const ui: RemoteComponentUI = {
		custom: <T>() => new Promise<T>(() => {}),
		requestRender() {},
		setWidget: (_key, content, options) => {
			if (!content) return;
			assert.equal(typeof content, "function");
			if (typeof content !== "function") throw new Error("expected widget factory");
			assert.deepEqual(options?.scroll, { maxHeight: 10, maxHeightFraction: 1 / 3 });
			mounted = nativeWorkflowViewport(content({ terminal } as TUI, {} as Theme), () =>
				Math.min(10, Math.floor(terminal.rows / 3)),
			);
			mounts++;
		},
	};
	const controller = new RemoteComponentController(runtime, ui, {
		isFullscreen: () => false,
		onRendererReplaced: () => () => {},
	});
	service.setWidget(
		"workflows",
		(tui) =>
			new WorkflowWidgetViewport(
				{ render: () => Array.from({ length: 20 }, (_, i) => `row ${i}`), invalidate() {} },
				() => tui.terminal.rows,
				() => {},
			),
		"belowEditor",
		{ maxHeight: 10, maxHeightFraction: 1 / 3 },
	);
	try {
		await sleep(0);
		assert.ok(mounted);
		for (const [rows, cap] of [
			[40, 10],
			[18, 6],
			[24, 8],
		] as const) {
			terminal.rows = rows;
			mounted.render(120);
			await sleep(0);
			const lines = mounted.render(120);
			assert.equal(commands.filter((command) => command.type === "engine_custom_render").at(-1)?.rows, rows);
			assert.equal(lines.length, cap);
			assert.deepEqual(
				lines,
				Array.from({ length: cap }, (_, i) => `row ${i}`),
			);
		}
		assert.equal(mounts, 1);
	} finally {
		controller.dispose();
		service.dispose();
	}
});
