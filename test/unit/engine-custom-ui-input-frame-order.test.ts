import assert from "node:assert/strict";
import { type Component, resetCapabilitiesCache, setCapabilities, type TUI } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import {
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

test("a frame an input handler paints with renderNow() reaches the host after that input's result", async () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const messages: InteractiveEngineMessage[] = [];
	const service = new EngineCustomUiService((line) => {
		const parsed = parseInteractiveEngineMessage(line);
		if (parsed) messages.push(parsed);
	}, new KeybindingsManager());
	try {
		let text = "before";
		void service.custom((tui: TUI) => {
			return {
				render: () => [text],
				invalidate() {},
				handleInput(): boolean {
					text = "after";
					tui.renderNow();
					return true;
				},
			} as Component & { handleInput(data: string): boolean };
		});
		let componentId: string | undefined;
		for (let attempt = 0; attempt < 200 && componentId === undefined; attempt++) {
			componentId = messages.find((message) => message.type === "engine_custom_open")?.componentId;
			if (componentId === undefined) await sleep(5);
		}
		assert.ok(componentId, "the custom component opened");
		const send = (command: Parameters<typeof serializeInteractiveEngineFrame>[0]) =>
			assert.equal(service.handleLine(serializeInteractiveEngineFrame(command)), true);

		send({ type: "engine_custom_render", componentId, requestId: 1, width: 80, rows: 24 });
		assert.ok(
			messages.some((message) => message.type === "engine_custom_frame" && message.lines[0] === "before"),
			"the host's frame request is answered",
		);
		messages.length = 0;

		send({ type: "engine_custom_input", componentId, requestId: 1, data: "x" });

		const order = messages
			.filter((message) => message.type === "engine_custom_input_result" || message.type === "engine_custom_frame")
			.map((message) =>
				message.type === "engine_custom_frame" ? `frame:${message.lines.join("|")}` : `result:${message.handled}`,
			);
		assert.deepEqual(order, ["result:true", "frame:after"]);
	} finally {
		service.dispose();
	}
});
