/**
 * Background render lane in the interactive engine (#4333).
 *
 * Widget repaints and streamed transcript rows used to render in pi-tui's render timer and in one callback per
 * host request, all queued ahead of the next keystroke. They now wait on a lane that runs one render per event-loop
 * turn and keeps only the newest request per component, so input and the frames of open dialogs run first.
 * These tests count renders and frames; none of them measure time.
 */
import assert from "node:assert/strict";
import { type Component, resetCapabilitiesCache, setCapabilities, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { setCallbackActivityReporter } from "../../packages/coding-agent/src/core/callback-activity.ts";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/ui-types.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { presentQuestionnaire } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { TabBar } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/tab-bar.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	BackgroundRenderLane,
	BackgroundRenderTui,
} from "../../packages/coding-agent/src/modes/interactive-engine/background-render-lane.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { EngineRenderService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-render-service.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { benchmarkQuestionnaire, KEY_CYCLE } from "../../scripts/perf/ask-user-question-load/fixture.ts";
import { sleep } from "../helpers/runtime.js";

/** Comfortably past pi-tui's 16 ms render throttle, so a component's own repaint request has fired. */
const REPAINT_SETTLE_MS = 60;
const WIDTH = 120;

beforeAll(() => {
	initTheme("dark");
});

// On a Kitty-capable terminal a screen repaints once more when the PNG transcoder finishes loading, at a
// time no test controls. Under load that repaint lands inside a count (#4711: "10 !== 5"), so these tests,
// which count the renders they request, run without image support.
beforeEach(() => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
});

afterEach(() => {
	resetCapabilitiesCache();
	setCallbackActivityReporter(undefined);
	vi.restoreAllMocks();
});

/** Event-loop turns the test releases one at a time. */
class ManualTurns {
	private readonly waiting: Array<() => void> = [];
	readonly yieldTurn = (): Promise<void> => new Promise<void>((resolve) => this.waiting.push(resolve));

	get waitingTurns(): number {
		return this.waiting.length;
	}

	async run(): Promise<void> {
		this.waiting.shift()?.();
		for (let i = 0; i < 4; i++) await Promise.resolve();
	}
}

class CountingTerminal implements Terminal {
	columns = 40;
	rows = 10;
	kittyProtocolActive = false;
	writes = 0;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {
		this.writes++;
	}
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

test("the lane runs one queued render per event-loop turn, and nothing before the first (#4333)", async () => {
	const turns = new ManualTurns();
	const lane = new BackgroundRenderLane(turns.yieldTurn);
	const ran: string[] = [];
	for (const key of ["a", "b", "c"]) lane.schedule(key, () => ran.push(key));
	assert.equal(ran.length, 0);
	assert.equal(lane.size, 3);
	await turns.run();
	assert.deepEqual(ran, ["a"]);
	await turns.run();
	assert.deepEqual(ran, ["a", "b"]);
	await turns.run();
	assert.deepEqual(ran, ["a", "b", "c"]);
	assert.equal(lane.size, 0);
	assert.equal(turns.waitingTurns, 0, "a drained lane stops yielding");
});

test("a newer render for a queued component replaces the queued one in its place (#4333)", async () => {
	const turns = new ManualTurns();
	const lane = new BackgroundRenderLane(turns.yieldTurn);
	const ran: string[] = [];
	lane.schedule("a", () => ran.push("a1"));
	lane.schedule("b", () => ran.push("b"));
	lane.schedule("a", () => ran.push("a2"));
	assert.equal(lane.size, 2);
	await turns.run();
	await turns.run();
	assert.deepEqual(ran, ["a2", "b"]);
	assert.equal(turns.waitingTurns, 0);
});

test("a cancelled render never runs, and a later one starts a new drain (#4333)", async () => {
	const turns = new ManualTurns();
	const lane = new BackgroundRenderLane(turns.yieldTurn);
	const ran: string[] = [];
	lane.schedule("a", () => ran.push("a"));
	lane.cancel("a");
	assert.equal(lane.size, 0);
	await turns.run();
	assert.equal(ran.length, 0);
	assert.equal(turns.waitingTurns, 0);
	lane.schedule("b", () => ran.push("b"));
	await turns.run();
	assert.deepEqual(ran, ["b"]);
});

test("a background screen checks its frame on the lane, not in pi-tui's render timer (#4333)", async () => {
	const turns = new ManualTurns();
	const lane = new BackgroundRenderLane(turns.yieldTurn);
	const terminal = new CountingTerminal();
	const tui = new BackgroundRenderTui(terminal, lane, "check:widget");
	let renders = 0;
	let text = "first";
	const widget: Component = {
		render: () => {
			renders++;
			return [text];
		},
		invalidate() {},
	};
	tui.addChild(widget);

	tui.renderNow();
	assert.equal(renders, 0, "the check waits for its turn");
	assert.equal(lane.size, 1);
	await turns.run();
	assert.equal(renders, 1);
	const writesAfterFirst = terminal.writes;
	assert.ok(writesAfterFirst > 0, "a changed frame reaches the terminal, which asks the host to repaint");

	tui.renderNow();
	await turns.run();
	assert.equal(renders, 2);
	assert.equal(terminal.writes, writesAfterFirst, "an unchanged frame does not ask for a repaint");

	text = "second";
	tui.renderNow();
	await turns.run();
	assert.ok(terminal.writes > writesAfterFirst);
	tui.stop();
});

test("stopping a background screen drops its queued check (#4333)", async () => {
	const turns = new ManualTurns();
	const lane = new BackgroundRenderLane(turns.yieldTurn);
	const tui = new BackgroundRenderTui(new CountingTerminal(), lane, "check:widget");
	let renders = 0;
	tui.addChild({ render: () => [`render ${++renders}`], invalidate() {} });
	tui.renderNow();
	tui.stop();
	assert.equal(lane.size, 0);
	await turns.run();
	assert.equal(renders, 0);
	tui.renderNow();
	await turns.run();
	assert.equal(renders, 0, "a stopped screen checks nothing");
});

interface EngineHarness {
	readonly service: EngineCustomUiService;
	readonly messages: InteractiveEngineMessage[];
	send(command: InteractiveEngineCommand): void;
	waitFor(match: (message: InteractiveEngineMessage) => boolean): Promise<InteractiveEngineMessage>;
	openWidget(key: string, component: Component): Promise<string>;
	openQuestionnaire(): Promise<string>;
}

function engineHarness(): EngineHarness {
	const messages: InteractiveEngineMessage[] = [];
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) messages.push(message);
	}, new KeybindingsManager());
	const waitFor = async (match: (message: InteractiveEngineMessage) => boolean) => {
		for (let attempt = 0; attempt < 400; attempt++) {
			const found = messages.find(match);
			if (found) return found;
			await sleep(5);
		}
		throw new Error("engine message did not arrive");
	};
	return {
		service,
		messages,
		send: (command) => assert.equal(service.handleLine(serializeInteractiveEngineFrame(command)), true),
		waitFor,
		openWidget: async (key, component) => {
			service.setWidget(key, () => component, "belowEditor");
			const open = await waitFor((message) => message.type === "engine_custom_open" && message.widgetKey === key);
			return open.type === "engine_custom_open" ? open.componentId : "";
		},
		openQuestionnaire: async () => {
			void presentQuestionnaire(
				{ custom: service.custom.bind(service) } as unknown as ExtensionUIContext,
				benchmarkQuestionnaire(),
			);
			const open = await waitFor((message) => message.type === "engine_custom_open" && message.overlay);
			return open.type === "engine_custom_open" ? open.componentId : "";
		},
	};
}

function frameIndex(messages: readonly InteractiveEngineMessage[], componentId: string, requestId: number): number {
	return messages.findIndex(
		(message) =>
			message.type === "engine_custom_frame" &&
			message.componentId === componentId &&
			message.requestId === requestId,
	);
}

test("a keystroke and the dialog frame it asks for overtake queued widget renders (#4333)", async () => {
	// The engine child reports callback activity in production, which makes every callback wait a turn.
	setCallbackActivityReporter({ started() {}, finished() {} });
	const engine = engineHarness();
	let widgetRenders = 0;
	let widgetRendersAtDialogFrame: number | undefined;
	const widgetIds: string[] = [];
	for (let index = 0; index < 5; index++) {
		widgetIds.push(
			await engine.openWidget(`w${index}`, {
				render: () => {
					widgetRenders++;
					return [`widget ${index}`];
				},
				invalidate() {},
			}),
		);
	}
	const dialogId = await engine.openQuestionnaire();
	let requestId = 0;
	engine.send({ type: "engine_custom_render", componentId: dialogId, requestId: ++requestId, width: WIDTH, rows: 40 });
	await engine.waitFor((message) => message.type === "engine_custom_frame" && message.componentId === dialogId);
	widgetRenders = 0;

	for (const componentId of widgetIds)
		engine.send({ type: "engine_custom_render", componentId, requestId: ++requestId, width: WIDTH, rows: 40 });
	engine.send({ type: "engine_custom_input", componentId: dialogId, requestId: ++requestId, data: "\x1b[B" });
	const keyFrame = ++requestId;
	engine.send({ type: "engine_custom_render", componentId: dialogId, requestId: keyFrame, width: WIDTH, rows: 40 });
	const watch = setInterval(() => {
		if (widgetRendersAtDialogFrame === undefined && frameIndex(engine.messages, dialogId, keyFrame) !== -1)
			widgetRendersAtDialogFrame = widgetRenders;
	}, 0);
	await engine.waitFor(
		(message) =>
			message.type === "engine_custom_frame" && message.componentId === dialogId && message.requestId === keyFrame,
	);
	widgetRendersAtDialogFrame ??= widgetRenders;
	clearInterval(watch);
	for (const componentId of widgetIds)
		await engine.waitFor((message) => message.type === "engine_custom_frame" && message.componentId === componentId);

	const dialogFrame = frameIndex(engine.messages, dialogId, keyFrame);
	const widgetFrames = widgetIds.map((componentId) =>
		engine.messages.findIndex(
			(message) => message.type === "engine_custom_frame" && message.componentId === componentId,
		),
	);
	assert.ok(
		widgetFrames.filter((index) => index < dialogFrame).length <= 1,
		`at most one queued widget frame may precede the key's frame, saw ${widgetFrames.filter((index) => index < dialogFrame).length}`,
	);
	assert.ok((widgetRendersAtDialogFrame ?? 0) <= 1);
	assert.equal(widgetRenders, widgetIds.length, "the queued widget renders still run");
	engine.service.dispose();
});

test("queued renders of one widget collapse into one render answering the newest request (#4333)", async () => {
	const engine = engineHarness();
	let renders = 0;
	const widgetId = await engine.openWidget("w", {
		render: (width) => {
			renders++;
			return [`width ${width}`];
		},
		invalidate() {},
	});
	for (let requestId = 1; requestId <= 5; requestId++)
		engine.send({ type: "engine_custom_render", componentId: widgetId, requestId, width: 30 + requestId, rows: 10 });
	const frame = await engine.waitFor(
		(message) => message.type === "engine_custom_frame" && message.componentId === widgetId,
	);
	await sleep(REPAINT_SETTLE_MS);
	assert.equal(renders, 1);
	const frames = engine.messages.filter(
		(message) => message.type === "engine_custom_frame" && message.componentId === widgetId,
	);
	assert.equal(frames.length, 1);
	assert.ok(frame.type === "engine_custom_frame");
	assert.equal(frame.requestId, 5);
	assert.deepEqual(frame.lines, ["width 35"], "the frame is rendered at the newest request's width");
	engine.service.dispose();
});

test("a widget closed while its render waited gets no frame (#4333)", async () => {
	const engine = engineHarness();
	let renders = 0;
	const widgetId = await engine.openWidget("w", {
		render: () => {
			renders++;
			return ["widget"];
		},
		invalidate() {},
	});
	engine.send({ type: "engine_custom_render", componentId: widgetId, requestId: 1, width: WIDTH, rows: 10 });
	engine.service.setWidget("w", undefined);
	await sleep(REPAINT_SETTLE_MS);
	assert.equal(renders, 0);
	assert.equal(
		engine.messages.some((message) => message.type === "engine_custom_frame" && message.componentId === widgetId),
		false,
	);
	engine.service.dispose();
});

test("a widget render that throws answers with a failure frame (#4333)", async () => {
	const engine = engineHarness();
	const widgetId = await engine.openWidget("w", {
		render: () => {
			throw new Error("boom");
		},
		invalidate() {},
	});
	engine.send({ type: "engine_custom_render", componentId: widgetId, requestId: 7, width: WIDTH, rows: 10 });
	const frame = await engine.waitFor(
		(message) => message.type === "engine_custom_frame" && message.componentId === widgetId,
	);
	assert.ok(frame.type === "engine_custom_frame");
	assert.equal(frame.requestId, 7);
	assert.deepEqual(frame.lines, ["Remote component render failed: boom"]);
	engine.service.dispose();
});

test("widget frames carry the widget's scroll request (#4333)", async () => {
	const engine = engineHarness();
	const widgetId = await engine.openWidget("w", {
		render: () => ["row"],
		getScrollRequest: () => ({ version: 3, scrollTop: 2 }),
		invalidate() {},
	} as Component);
	engine.send({ type: "engine_custom_render", componentId: widgetId, requestId: 1, width: WIDTH, rows: 10 });
	const frame = await engine.waitFor(
		(message) => message.type === "engine_custom_frame" && message.componentId === widgetId,
	);
	assert.ok(frame.type === "engine_custom_frame");
	assert.deepEqual(frame.scrollRequest, { version: 3, scrollTop: 2 });
	engine.service.dispose();
});

test("the engine builds one questionnaire frame per keystroke and none for unrelated repaints (#4333)", async () => {
	const engine = engineHarness();
	const frames = vi.spyOn(TabBar.prototype, "render");
	const dialogId = await engine.openQuestionnaire();
	let requestId = 0;
	const hostRender = async () => {
		const id = ++requestId;
		engine.send({ type: "engine_custom_render", componentId: dialogId, requestId: id, width: WIDTH, rows: 40 });
		return engine.waitFor(
			(message) =>
				message.type === "engine_custom_frame" && message.componentId === dialogId && message.requestId === id,
		);
	};
	const answerInvalidations = async () => {
		const pending = engine.messages.filter(
			(message) => message.type === "engine_custom_invalidate" && message.componentId === dialogId,
		).length;
		engine.messages.length = 0;
		for (let i = 0; i < pending; i++) await hostRender();
	};
	await hostRender();
	await sleep(REPAINT_SETTLE_MS);
	await answerInvalidations();

	const keys = KEY_CYCLE.slice(0, 12);
	frames.mockClear();
	for (const key of keys) {
		engine.send({ type: "engine_custom_input", componentId: dialogId, requestId: ++requestId, data: key });
		await hostRender();
		await sleep(REPAINT_SETTLE_MS);
		await answerInvalidations();
	}
	assert.equal(frames.mock.calls.length, keys.length, "one frame per keystroke, its repaint echo included");

	frames.mockClear();
	for (let broadcast = 0; broadcast < 10; broadcast++) {
		engine.service.requestRender();
		await answerInvalidations();
	}
	assert.equal(frames.mock.calls.length, 0, "unrelated repaints reuse the cached frame");
	engine.service.dispose();
});

function rowRenderHarness(bound: boolean): {
	service: EngineRenderService;
	messages: InteractiveEngineMessage[];
	render(requestId: number, text: string, componentId?: string): void;
	renderMessage(requestId: number, text: string, componentId: string): void;
} {
	const messages: InteractiveEngineMessage[] = [];
	const service = new EngineRenderService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) messages.push(message);
	});
	if (bound)
		service.bindSession({
			getToolDefinition: () => undefined,
			extensionRunner: {
				resolveToolRenderers: (_name: string, base: () => undefined) => base(),
				getMessageRenderer: () => undefined,
			},
			sessionManager: { getCwd: () => process.cwd() },
		} as unknown as AgentSession);
	return {
		service,
		messages,
		renderMessage: (requestId, text, componentId) =>
			assert.equal(
				service.handleLine(
					serializeInteractiveEngineFrame({
						type: "engine_message_render",
						componentId,
						requestId,
						width: 80,
						message: { role: "custom", customType: "lane_probe", content: text, display: true, timestamp: 0 },
						expanded: false,
						outputPad: 1,
					}),
				),
				true,
			),
		render: (requestId, text, componentId = "row") =>
			assert.equal(
				service.handleLine(
					serializeInteractiveEngineFrame({
						type: "engine_tool_render",
						componentId,
						requestId,
						width: 80,
						toolName: "lane_probe_tool",
						toolCallId: "call_lane_probe",
						args: { command: "probe" },
						result: { content: [{ type: "text", text }], isError: false },
						executionStarted: true,
						argsComplete: true,
						isPartial: true,
						expanded: false,
						showImages: false,
						imageWidthCells: 60,
					}),
				),
				true,
			),
	};
}

const rowFrames = (messages: readonly InteractiveEngineMessage[]) =>
	messages.filter((message) => message.type === "engine_custom_frame" && message.componentId === "row");

test("queued renders of one transcript row collapse into one render of its newest state (#4333)", async () => {
	const rows = rowRenderHarness(true);
	rows.render(1, "STREAMED_ONE");
	rows.render(2, "STREAMED_TWO");
	rows.render(3, "STREAMED_THREE");
	await sleep(REPAINT_SETTLE_MS);
	const frames = rowFrames(rows.messages);
	assert.equal(frames.length, 1);
	const [frame] = frames;
	assert.ok(frame?.type === "engine_custom_frame");
	assert.equal(frame.requestId, 3);
	assert.match(frame.lines.join("\n"), /STREAMED_THREE/);
	rows.service.dispose();
});

test("a transcript row disposed while its render waited is neither rendered nor rebuilt (#4333)", async () => {
	const rows = rowRenderHarness(true);
	rows.render(1, "STREAMED_ONE");
	assert.equal(
		rows.service.handleLine(serializeInteractiveEngineFrame({ type: "engine_render_dispose", componentId: "row" })),
		true,
	);
	await sleep(REPAINT_SETTLE_MS);
	assert.deepEqual(rowFrames(rows.messages), []);
	rows.service.dispose();
});

test("a transcript row that fails to render answers with a failure frame (#4333)", async () => {
	const rows = rowRenderHarness(false);
	rows.render(4, "never rendered");
	await sleep(REPAINT_SETTLE_MS);
	const [frame] = rowFrames(rows.messages);
	assert.ok(frame?.type === "engine_custom_frame");
	assert.equal(frame.requestId, 4);
	assert.deepEqual(frame.lines, ["Remote renderer failed: Renderer session is not bound"]);
});

test("every queued transcript row renders, and each one's repaint check runs (#4333)", async () => {
	const rows = rowRenderHarness(true);
	rows.render(1, "FIRST_ROW", "row-a");
	rows.render(2, "SECOND_ROW", "row-b");
	rows.renderMessage(3, "MESSAGE_ROW", "row-c");
	await sleep(REPAINT_SETTLE_MS);
	const frameOf = (componentId: string) =>
		rows.messages.find((message) => message.type === "engine_custom_frame" && message.componentId === componentId);
	const [a, b, c] = ["row-a", "row-b", "row-c"].map(frameOf);
	assert.ok(
		a?.type === "engine_custom_frame" && b?.type === "engine_custom_frame" && c?.type === "engine_custom_frame",
	);
	assert.match(a.lines.join("\n"), /FIRST_ROW/);
	assert.match(b.lines.join("\n"), /SECOND_ROW/);
	assert.match(c.lines.join("\n"), /MESSAGE_ROW/, "a message row renders as a custom message");
	const invalidated = new Set(
		rows.messages.flatMap((message) => (message.type === "engine_custom_invalidate" ? [message.componentId] : [])),
	);
	assert.ok(invalidated.has("row-a") && invalidated.has("row-b"), "each tool row's own repaint check ran");
	rows.service.dispose();
});

test("background renders report their callback activity like the renders they replace (#4333)", async () => {
	const started: Array<{ kind: string; name: string }> = [];
	setCallbackActivityReporter({
		started: (activity) => started.push({ kind: activity.kind, name: activity.name }),
		finished() {},
	});
	const engine = engineHarness();
	const widgetId = await engine.openWidget("w", { render: () => ["widget"], invalidate() {} });
	const dialogId = await engine.openQuestionnaire();
	engine.send({ type: "engine_custom_render", componentId: widgetId, requestId: 1, width: WIDTH, rows: 10 });
	engine.send({ type: "engine_custom_render", componentId: dialogId, requestId: 2, width: WIDTH, rows: 40 });
	await engine.waitFor((message) => message.type === "engine_custom_frame" && message.componentId === widgetId);
	await engine.waitFor((message) => message.type === "engine_custom_frame" && message.componentId === dialogId);
	const rows = rowRenderHarness(true);
	rows.render(3, "ROW");
	await sleep(REPAINT_SETTLE_MS);
	assert.ok(started.some((activity) => activity.kind === "renderer" && activity.name === widgetId));
	assert.ok(started.some((activity) => activity.kind === "renderer" && activity.name === dialogId));
	assert.ok(started.some((activity) => activity.kind === "renderer" && activity.name === "tool:lane_probe_tool"));
	engine.service.dispose();
	rows.service.dispose();
});

test("a custom UI whose render throws answers with a failure frame (#4333)", async () => {
	const engine = engineHarness();
	void engine.service.custom(() => ({
		render: () => {
			throw new Error("overlay boom");
		},
		invalidate() {},
	}));
	const open = await engine.waitFor((message) => message.type === "engine_custom_open");
	assert.ok(open.type === "engine_custom_open");
	engine.send({ type: "engine_custom_render", componentId: open.componentId, requestId: 9, width: WIDTH, rows: 10 });
	const frame = await engine.waitFor(
		(message) => message.type === "engine_custom_frame" && message.componentId === open.componentId,
	);
	assert.ok(frame.type === "engine_custom_frame");
	assert.equal(frame.requestId, 9);
	assert.deepEqual(frame.lines, ["Remote component render failed: overlay boom"]);
	engine.service.dispose();
});

test("each widget's repaint check runs when several widgets ask at once (#4333)", async () => {
	const engine = engineHarness();
	const screens: Array<{ requestRender(): void }> = [];
	const ids: string[] = [];
	for (const key of ["a", "b", "c"]) {
		engine.service.setWidget(
			key,
			(tui) => {
				screens.push(tui);
				return { render: () => [`widget ${key}`], invalidate() {} };
			},
			"belowEditor",
		);
		const open = await engine.waitFor(
			(message) => message.type === "engine_custom_open" && message.widgetKey === key,
		);
		if (open.type === "engine_custom_open") ids.push(open.componentId);
	}
	engine.messages.length = 0;
	for (const screen of screens) screen.requestRender();
	await sleep(REPAINT_SETTLE_MS);
	const invalidated = new Set(
		engine.messages.flatMap((message) => (message.type === "engine_custom_invalidate" ? [message.componentId] : [])),
	);
	assert.deepEqual([...invalidated].sort(), [...ids].sort());
	engine.service.dispose();
});
