/**
 * Terminal-resize width clamp for remote (isolated-engine) frames.
 *
 * Remote components render out-of-process: `render(width)` sends an async
 * frame request to the engine child and keeps returning the last applied
 * frame until the fresh one arrives. Across a terminal resize this replayed
 * frame is wrapped for the OLD width, and pi-tui's differential renderer
 * crashes the whole TUI on any rendered line wider than the terminal
 * ("Rendered line N exceeds terminal width"). Regression: fuzz-resizing an
 * active session (e.g. 112 -> 83 cols) crashed with the entire transcript's
 * tool cards stale at the previous width.
 *
 * These tests pin the invariant: whatever frames have (or have not) arrived,
 * a remote component's render(width) never returns a line wider than width.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import type {
	InteractiveEngineCommand,
	InteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { RemoteFrameWidthClamp } from "../../packages/coding-agent/src/modes/interactive-engine/remote-frame-clamp.ts";
import {
	RemoteCustomMessageComponent,
	RemoteToolExecutionComponent,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-renderer.ts";
import type { CustomMessage } from "../../packages/coding-agent/src/core/messages.ts";

const WIDE = 112;
const NARROW = 83;

interface FakeRuntime {
	runtime: IsolatedInteractiveRuntime;
	commands: InteractiveEngineCommand[];
	/** Deliver an engine message to every registered host listener. */
	emit(message: InteractiveEngineMessage): void;
}

function makeFakeRuntime(): FakeRuntime {
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const commands: InteractiveEngineCommand[] = [];
	const runtime = {
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			commands.push(command);
		},
	} as unknown as IsolatedInteractiveRuntime;
	return {
		runtime,
		commands,
		emit: (message) => {
			for (const listener of [...listeners]) listener(message);
		},
	};
}

function componentIdOf(command: InteractiveEngineCommand): string {
	assert.ok("componentId" in command, "engine command has no componentId");
	return (command as { componentId: string }).componentId;
}

/** Frame lines as the engine child would render them: padded to `width`. */
function frameLines(width: number, count = 6): string[] {
	const lines: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const content = `line ${index} `.padEnd(width, "=");
		lines.push(`\x1b[48;2;30;30;46m${content}\x1b[49m`);
	}
	return lines;
}

function assertMaxWidth(lines: string[], width: number, label: string): void {
	for (const [index, line] of lines.entries()) {
		assert.ok(
			visibleWidth(line) <= width,
			`${label}: line ${index} visible width ${visibleWidth(line)} exceeds ${width}`,
		);
	}
}

test("stale tool-card frame is clamped when re-rendered at a smaller width", () => {
	const fake = makeFakeRuntime();
	const component = new RemoteToolExecutionComponent("bash", "call_1", { command: "seq 1 40" }, {}, fake.runtime, () => {});

	// Initial render at the wide terminal requests + applies a wide frame.
	component.render(WIDE);
	const componentId = componentIdOf(fake.commands[0]!);
	fake.emit({ type: "engine_custom_frame", componentId, requestId: 1, lines: frameLines(WIDE) });
	assertMaxWidth(component.render(WIDE), WIDE, "wide render");
	assert.equal(visibleWidth(component.render(WIDE)[0]!), WIDE, "expected full-width frame lines at the wide width");

	// Terminal shrinks. The engine re-render is asynchronous — no fresh frame
	// has arrived yet — so the component replays the wide frame. Every
	// returned line must still fit the new width (pi-tui crashes otherwise).
	const narrowRender = component.render(NARROW);
	assertMaxWidth(narrowRender, NARROW, "stale frame after shrink");

	// The resize still requests a re-render from the engine at the new width.
	const last = fake.commands.at(-1);
	assert.ok(last?.type === "engine_tool_render" && last.width === NARROW, "no engine re-render requested at the new width");

	// Once the properly wrapped frame arrives, it is returned unmodified.
	fake.emit({ type: "engine_custom_frame", componentId, requestId: 2, lines: frameLines(NARROW) });
	const freshRender = component.render(NARROW);
	assertMaxWidth(freshRender, NARROW, "fresh frame after shrink");
	assert.equal(visibleWidth(freshRender[0]!), NARROW);
});

test("late frame rendered at an older width never overflows the current width (root cause)", () => {
	// The crash interleave: resize flapping (112 -> 83 -> 112 -> 83) pipelines
	// frame requests at alternating widths; a frame rendered at 112 applies
	// AFTER the terminal already settled at 83. pi-tui then diff-renders the
	// changed (stale-width) lines and threw "Rendered line N exceeds terminal
	// width (112 > 83)".
	const fake = makeFakeRuntime();
	const component = new RemoteToolExecutionComponent("bash", "call_2", { command: "ls" }, {}, fake.runtime, () => {});

	component.render(NARROW); // request 1 @ 83
	component.render(WIDE); // request 2 @ 112
	component.render(NARROW); // request 3 @ 83
	const componentId = componentIdOf(fake.commands[0]!);

	// Frames arrive in order; the terminal is at 83 the whole time.
	fake.emit({ type: "engine_custom_frame", componentId, requestId: 1, lines: frameLines(NARROW) });
	assertMaxWidth(component.render(NARROW), NARROW, "after frame @83");
	fake.emit({ type: "engine_custom_frame", componentId, requestId: 2, lines: frameLines(WIDE) });
	assertMaxWidth(component.render(NARROW), NARROW, "after late frame @112");
	fake.emit({ type: "engine_custom_frame", componentId, requestId: 3, lines: frameLines(NARROW) });
	assertMaxWidth(component.render(NARROW), NARROW, "after settling frame @83");
});

test("transcript stack with remote components re-renders within the smaller width", () => {
	const fake = makeFakeRuntime();
	const chat = new Container();
	const tool = new RemoteToolExecutionComponent("search", "call_3", { pattern: "foo" }, {}, fake.runtime, () => {});
	const custom = new RemoteCustomMessageComponent(
		{ role: "custom", customType: "intercom", content: "ping", display: true } as unknown as CustomMessage<unknown>,
		fake.runtime,
		() => {},
	);
	chat.addChild(tool);
	chat.addChild(custom);

	// Render the transcript at width A and deliver wide frames for both cards.
	chat.render(WIDE);
	const toolId = componentIdOf(fake.commands[0]!);
	const customId = componentIdOf(fake.commands[1]!);
	fake.emit({ type: "engine_custom_frame", componentId: toolId, requestId: 1, lines: frameLines(WIDE) });
	fake.emit({ type: "engine_custom_frame", componentId: customId, requestId: 1, lines: frameLines(WIDE, 3) });
	assertMaxWidth(chat.render(WIDE), WIDE, "transcript at wide width");

	// Re-render the whole stack at the smaller width B before any fresh
	// frames arrive: every line must satisfy visibleWidth <= B.
	assertMaxWidth(chat.render(NARROW), NARROW, "transcript re-rendered at narrow width");
});

test("remote custom-UI widget frames are clamped after a shrink", () => {
	const fake = makeFakeRuntime();
	let widgetFactory: ((tui: { terminal: { rows: number } }) => { render(width: number): string[] }) | undefined;
	const ui = {
		requestRender: () => {},
		setWidget: (_key: string, factory: typeof widgetFactory) => {
			widgetFactory = factory;
		},
		custom: () => new Promise(() => {}),
	} as unknown as ExtensionUIContext;
	new RemoteComponentController(fake.runtime, ui);

	fake.emit({
		type: "engine_custom_open",
		componentId: "widget_1",
		overlay: false,
		widgetKey: "intercom.status",
	} as InteractiveEngineMessage);
	assert.ok(widgetFactory, "widget was not mounted on the host");
	const widget = widgetFactory({ terminal: { rows: 30 } });

	widget.render(WIDE);
	fake.emit({ type: "engine_custom_frame", componentId: "widget_1", requestId: 1, lines: frameLines(WIDE) });
	assertMaxWidth(widget.render(WIDE), WIDE, "widget at wide width");
	assertMaxWidth(widget.render(NARROW), NARROW, "widget stale frame after shrink");
});

test("RemoteFrameWidthClamp memoizes and passes through fitting frames untouched", () => {
	const clamp = new RemoteFrameWidthClamp();
	const fitting = ["short", "also short"];
	// Fitting frames come back identity-equal (no per-frame allocation).
	assert.equal(clamp.clamp(fitting, 80), fitting);
	assert.equal(clamp.clamp(fitting, 80), fitting);

	const wide = frameLines(WIDE);
	const clamped = clamp.clamp(wide, NARROW);
	assertMaxWidth(clamped, NARROW, "clamped wide frame");
	// Memoized: same inputs return the same projection instance.
	assert.equal(clamp.clamp(wide, NARROW), clamped);
	// Width change re-projects.
	assertMaxWidth(clamp.clamp(wide, 40), 40, "re-clamped at 40");
	// Zero/unknown width (pre-start) leaves the frame alone rather than
	// truncating everything to nothing.
	assert.equal(clamp.clamp(wide, 0), wide);
});
