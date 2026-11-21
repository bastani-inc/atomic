/**
 * The single chat screen on the isolated engine's host: the engine opens a view of its subagent, mounts the
 * transcript as a remote component with `placement: "transcript"`, and the host draws it where its main transcript is.
 * The engine side and the host side talk through the real engine protocol lines.
 */
import assert from "node:assert/strict";
import {
	type Component,
	getKeybindings,
	hyperlink,
	setKeybindings,
	type Text,
	type TuiMouseEvent,
} from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { bindOwnerTaskStore } from "../src/core/tasks/owner-store.js";
import { AgentViewSwitcher } from "../src/modes/interactive/agent-view/agent-view-switcher.ts";
import {
	FIRST_FRAME_TIMEOUT_MS,
	openRemoteAgentViewPort,
	PANEL_FIRST_FRAME_TIMEOUT_MS,
	type RemoteAgentViewPort,
} from "../src/modes/interactive/agent-view/remote-port.ts";
import { holdTranscriptDock } from "../src/modes/interactive/agent-view/transcript-slot.ts";
import { dismissedTasks } from "../src/modes/interactive/components/task-dismissal.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../src/modes/interactive-engine/remote-component.ts";
import { AGENT_PANEL_WIDGET_KEY } from "../src/modes/rpc/agent-panel-bridge.ts";
import { bindEngineAgentView, handleAgentViewCommand } from "../src/modes/rpc/agent-view-rpc.ts";
import type { AgentViewRpcCommandBody } from "../src/modes/rpc/agent-view-rpc-types.ts";
import { engineAgentViews } from "../src/modes/rpc/agent-view-rpc-view.ts";
import { assistant, flush, has, liveSubagent, mainScreen, PAGE_UP } from "./helpers/agent-view-screen.ts";

const FRAME_WAIT = { timeout: 10_000, interval: 20 };

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

/** The engine (its custom UI and agent views over `sub`'s task store) wired to the host screen `ui`. */
function enginePair(ui: ReturnType<typeof mainScreen>, sub: Awaited<ReturnType<typeof liveSubagent>>) {
	const hostListeners = new Set<(message: InteractiveEngineMessage) => void>();
	const generationListeners = new Set<() => void>();
	const sent: InteractiveEngineCommand[] = [];
	const engineMessages: InteractiveEngineMessage[] = [];
	let generation = 1;
	// The engine writes protocol lines; the host reads them in order.
	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		engineMessages.push(message);
		for (const listener of [...hostListeners]) listener(message);
	}, new KeybindingsManager());
	const session = {} as AgentSession;
	bindOwnerTaskStore(session, sub.fixture.store);
	const engineUi = {
		getChatRenderSettings: () => ({}),
		getFooterDataProvider: () => undefined,
		notify: () => {},
	} as unknown as ExtensionUIContext;
	const unbind = bindEngineAgentView({
		session,
		send: (message) => {
			engineMessages.push(message);
			for (const listener of [...hostListeners]) listener(message);
		},
		customUi: child,
		ui: engineUi,
	});
	const requests: AgentViewRpcCommandBody[] = [];
	// While held, the host's commands wait to reach the engine, as they do while the engine is busy.
	let held: InteractiveEngineCommand[] | undefined;
	/** The engine's widgets as the host mounted them, by key. */
	const widgets = new Map<string, Component>();
	const deliver = (command: InteractiveEngineCommand) => child.handleLine(serializeInteractiveEngineFrame(command));
	const runtime = {
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			hostListeners.add(listener);
			return () => hostListeners.delete(listener);
		},
		onGenerationEnded: (listener: () => void) => {
			generationListeners.add(listener);
			return () => generationListeners.delete(listener);
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			sent.push(command);
			if (held) held.push(command);
			else deliver(command);
		},
		getGeneration: () => generation,
		async requestAgentView<T>(command: AgentViewRpcCommandBody): Promise<T> {
			requests.push(command);
			const response = await handleAgentViewCommand(command, session);
			if (!response.success) throw new Error(response.error);
			return (response as { data?: unknown }).data as T;
		},
	};
	new RemoteComponentController(
		runtime as never,
		{
			requestRender: () => ui.tui.requestRender(),
			setWidget: (key: string, factory: ((tui: unknown) => Component) | undefined) => {
				if (factory === undefined) widgets.delete(key);
				else widgets.set(key, factory(ui.tui));
			},
			custom: () => new Promise(() => {}),
			onWidgetRelease: () => () => {},
		} as unknown as ExtensionUIContext,
		{ isFullscreen: () => true, onRendererReplaced: () => () => {} },
	);
	const switcher = new AgentViewSwitcher(
		// As openAgentViewPort does on the isolated host.
		(taskId, options) =>
			openRemoteAgentViewPort(
				runtime as never,
				taskId,
				{ width: ui.terminal.columns, rows: 16 },
				{ panel: options?.keepScreen === true && options.panel === true },
			),
		(message) => ui.notices.push(`switcher: ${message}`),
		// As installAgentView wires it: /tasks keeps the dock as painted while the subagent is on its way.
		() => holdTranscriptDock(ui.mode, FIRST_FRAME_TIMEOUT_MS),
	);
	return {
		switcher,
		session,
		sent,
		requests,
		engineMessages,
		holdCommands: () => {
			held ??= [];
		},
		/** Deliver the held commands `which` picks, or all of them, which ends holding. */
		releaseCommands: (which?: (command: InteractiveEngineCommand) => boolean) => {
			const waiting = held ?? [];
			if (which === undefined) held = undefined;
			else held = waiting.filter((command) => !which(command));
			for (const command of waiting) if (which === undefined || which(command)) deliver(command);
		},
		/** The engine opens the agent panel's widget, drawing `rows`. */
		openPanel: (rows: string[]) => {
			child.setWidget(AGENT_PANEL_WIDGET_KEY, () => ({ render: () => rows, invalidate: () => {} }), "belowEditor");
		},
		/** The engine closes the agent panel's widget. */
		closePanel: () => child.setWidget(AGENT_PANEL_WIDGET_KEY, undefined),
		/** Messages the host reads from the engine in one read, one after the other. */
		toHost: (...messages: InteractiveEngineMessage[]) => {
			for (const message of messages) {
				engineMessages.push(message);
				for (const listener of [...hostListeners]) listener(message);
			}
		},
		/** The host's agent panel, drawn as a paint of the dock draws it; undefined while none is mounted. */
		panelRows: () => widgets.get(AGENT_PANEL_WIDGET_KEY)?.render(ui.terminal.columns),
		/** The id of the panel widget the host mounted last. */
		panelId: () => {
			const opened = engineMessages.filter(
				(message) => message.type === "engine_custom_open" && message.widgetKey === AGENT_PANEL_WIDGET_KEY,
			);
			const last = opened.at(-1);
			return last?.type === "engine_custom_open" ? last.componentId : undefined;
		},
		/** The subagent's transcript has its first frame from the engine. */
		transcriptFramed: () => {
			const open = engineMessages.find(
				(message) => message.type === "engine_custom_open" && message.placement === "transcript",
			);
			return (
				open?.type === "engine_custom_open" &&
				engineMessages.some(
					(message) => message.type === "engine_custom_frame" && message.componentId === open.componentId,
				)
			);
		},
		loseEngine: () => {
			generation++;
			for (const listener of [...generationListeners]) listener();
			switcher.reset("generation-lost");
		},
		dispose: () => {
			unbind();
			child.dispose();
		},
	};
}

describe("the isolated engine's subagent in the host's transcript area", () => {
	test("is drawn from the engine's frames above the host's own prompt, scrolls there, and closes when main is back", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(30);
		const engine = enginePair(ui, sub);
		const uninstall = ui.bind(engine.switcher);
		try {
			ui.screen();
			const mainTop = ui.scroll.scrollTop;
			assert.equal(await engine.switcher.view(sub.taskId), true);
			const opened = engine.engineMessages.find((message) => message.type === "engine_custom_open");
			assert.equal(opened?.type === "engine_custom_open" && opened.placement, "transcript");
			// The first frame was in before the screen switched: no blank and no stale main rows.
			const first = ui.screen();
			assert.ok(has(first, /sub line 30$/), first.join("\n"));
			assert.ok(!has(first, /main line/), first.join("\n"));
			assert.deepEqual(first.slice(-2), ["❯ prompt", "footer"]);

			// PgUp travels to the engine's transcript; main's place does not move.
			ui.terminal.input(PAGE_UP);
			await vi.waitFor(() => assert.ok(!has(ui.screen(), /sub line 30$/), ui.screen().join("\n")), FRAME_WAIT);
			assert.ok(engine.sent.some((command) => command.type === "engine_custom_input" && command.data === PAGE_UP));
			assert.equal(ui.scroll.scrollTop, mainTop);

			// The subagent streams in the engine; the host's frame follows once the reader is back at the end.
			ui.terminal.input("\x1b[F");
			for (let turn = 0; turn < 30; turn++) ui.terminal.input(`\x1b[<65;5;3M`);
			sub.emit({ type: "message_start", message: assistant("") } as never);
			sub.emit({
				type: "message_update",
				message: assistant("engine streamed this"),
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "engine streamed this" },
			} as never);
			await vi.waitFor(
				() => assert.ok(has(ui.screen(), /engine streamed this/), ui.screen().join("\n")),
				FRAME_WAIT,
			);

			const port = (engine.switcher.viewed as { port?: RemoteAgentViewPort }).port!;
			const viewId = port.viewId;
			assert.ok(engineAgentViews(engine.session).port(viewId), "the engine keeps the view while it is shown");
			assert.equal(await engine.switcher.view(undefined), true);
			await flush();
			assert.equal(Reflect.get(ui.tui, "layoutRoot"), ui.root);
			assert.ok(has(ui.screen(), /main line 40$/));
			assert.ok(engine.requests.some((request) => request.type === "agent_view_close"));
			assert.equal(engineAgentViews(engine.session).port(viewId), undefined, "the engine closed the view");
		} finally {
			uninstall();
			engine.dispose();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("reports the subagent's state as it changes, and a dismissed subagent or a lost engine gives main back", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(5);
		const engine = enginePair(ui, sub);
		const uninstall = ui.bind(engine.switcher);
		try {
			await engine.switcher.view(sub.taskId);
			const port = (engine.switcher.viewed as { port?: RemoteAgentViewPort }).port!;
			assert.equal(port.status().state, "running");
			sub.stop();
			await sub.fixture.settle();
			await vi.waitFor(() => assert.equal(port.status().state, "done"), FRAME_WAIT);
			assert.ok(
				engine.engineMessages.some(
					(message) => message.type === "engine_agent_view_status" && message.status.state === "done",
				),
			);
			assert.ok(has(ui.screen(), /sub line 5$/), "a finished subagent stays shown");

			dismissedTasks(sub.source).add(sub.taskId);
			sub.fixture.store.drain();
			await vi.waitFor(() => assert.equal(engine.switcher.viewed.kind, "main"), FRAME_WAIT);

			// Shown again, then the engine is lost: main is shown, and nothing of the lost view remains.
			dismissedTasks(sub.source).delete(sub.taskId);
			await engine.switcher.view(sub.taskId);
			assert.equal(engine.switcher.viewed.kind, "agent");
			engine.loseEngine();
			assert.equal(engine.switcher.viewed.kind, "main");
			assert.ok(has(ui.screen(), /main line 40$/), ui.screen().join("\n"));
		} finally {
			uninstall();
			engine.dispose();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	/**
	 * Every row painted while the engine's frame for the new height is on its way is blank or already the row that
	 * frame puts there: nothing painted moves when it arrives.
	 */
	function assertNothingMoves(waiting: readonly string[], arrived: readonly string[]): void {
		assert.equal(waiting.length, arrived.length);
		const moved = waiting.flatMap((line, row) => (line === "" || line === arrived[row] ? [] : [row]));
		assert.deepEqual(
			moved,
			[],
			`rows ${moved.join(", ")} moved\n--- while waiting ---\n${waiting.join("\n")}\n--- arrived ---\n${arrived.join("\n")}`,
		);
	}

	async function viewedWithPrompt(lines: number, promptRows: number) {
		const ui = mainScreen();
		const editor = ui.mode.editor as unknown as Text;
		editor.setText(Array.from({ length: promptRows }, (_, row) => `❯ prompt ${row + 1}`).join("\n"));
		const sub = await liveSubagent(lines);
		const engine = enginePair(ui, sub);
		const uninstall = ui.bind(engine.switcher);
		assert.equal(await engine.switcher.view(sub.taskId), true);
		ui.screen();
		return {
			ui,
			sub,
			engine,
			/** The prompt takes `rows` rows: what is painted before the engine answers, and once it has. */
			async resizePrompt(rows: number) {
				engine.holdCommands();
				editor.setText(Array.from({ length: rows }, (_, row) => `❯ prompt ${row + 1}`).join("\n"));
				const waiting = ui.screen();
				engine.releaseCommands();
				await flush();
				return { waiting, arrived: ui.screen() };
			},
			async dispose() {
				uninstall();
				engine.dispose();
				ui.tui.stop();
				await sub.fixture.dispose();
			},
		};
	}

	test("keeps the latest rows in place while the frame for a taller transcript area is on its way", async () => {
		const view = await viewedWithPrompt(30, 3);
		try {
			const before = view.ui.screen();
			assert.ok(has(before, /sub line 30$/), before.join("\n"));
			const { waiting, arrived } = await view.resizePrompt(1);
			assertNothingMoves(waiting, arrived);
			// The rows above the latest open when the frame arrives; the latest stay at the bottom of the area.
			const latest = (lines: readonly string[]) => lines.findIndex((line) => /sub line 30$/.test(line));
			assert.equal(latest(waiting), latest(arrived));
			assert.equal(latest(arrived), latest(before) + 2);
		} finally {
			await view.dispose();
		}
	});

	test("keeps a short transcript at the top while the frame for a smaller transcript area is on its way", async () => {
		const view = await viewedWithPrompt(2, 1);
		try {
			const before = view.ui.screen();
			const first = (lines: readonly string[]) => lines.findIndex((line) => /sub line 1$/.test(line));
			assert.ok(first(before) >= 0, before.join("\n"));
			const { waiting, arrived } = await view.resizePrompt(3);
			assertNothingMoves(waiting, arrived);
			assert.equal(first(waiting), first(before));
		} finally {
			await view.dispose();
		}
	});

	test("keeps a reader scrolled up on the rows they read while the frame for a taller area is on its way", async () => {
		const view = await viewedWithPrompt(30, 3);
		try {
			view.ui.terminal.input(PAGE_UP);
			await vi.waitFor(() => assert.ok(!has(view.ui.screen(), /sub line 30$/)), FRAME_WAIT);
			const { waiting, arrived } = await view.resizePrompt(1);
			assertNothingMoves(waiting, arrived);
		} finally {
			await view.dispose();
		}
	});

	/** The dock while `/tasks` is open over the prompt: its list of subagents in the prompt's place. */
	const TASKS = "Tasks · 1 working\n❯ worker  investigate\n↑↓ select · enter open";

	async function tasksOpen(lines = 30, beforeBind?: (ui: ReturnType<typeof mainScreen>) => void) {
		const ui = mainScreen();
		beforeBind?.(ui);
		const editor = ui.mode.editor as unknown as Text;
		editor.setText(TASKS);
		const sub = await liveSubagent(lines);
		const engine = enginePair(ui, sub);
		const uninstall = ui.bind(engine.switcher);
		return {
			ui,
			sub,
			engine,
			/** `/tasks` closes: the prompt is back in the dock. */
			closeTasks: () => editor.setText("❯ prompt"),
			async dispose() {
				uninstall();
				engine.dispose();
				ui.tui.stop();
				await sub.fixture.dispose();
			},
		};
	}

	test("keeps /tasks painted until the subagent Enter opened there is shown, then shows it with the prompt", async () => {
		const view = await tasksOpen();
		try {
			const tasks = view.ui.screen();
			assert.ok(has(tasks, /main line 40$/) && has(tasks, /enter open/), tasks.join("\n"));
			// The engine's first frame of the subagent waits; meanwhile /tasks closes.
			view.engine.holdCommands();
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true });
			view.closeTasks();
			assert.deepEqual(view.ui.screen(), tasks, "the main prompt is not painted while the subagent is on its way");
			await flush();
			assert.deepEqual(view.ui.screen(), tasks);
			view.engine.releaseCommands();
			await vi.waitFor(() => assert.equal(view.engine.switcher.viewed.kind, "agent"), FRAME_WAIT);
			const shown = view.ui.screen();
			assert.ok(has(shown, /sub line 30$/), shown.join("\n"));
			assert.ok(!has(shown, /main line|enter open/), shown.join("\n"));
			assert.deepEqual(shown.slice(-2), ["❯ prompt", "footer"]);
		} finally {
			await view.dispose();
		}
	});

	test("a key while the subagent is on its way shows the screen live before it runs; a key release does not", async () => {
		const view = await tasksOpen();
		try {
			const tasks = view.ui.screen();
			view.engine.holdCommands();
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true });
			view.closeTasks();
			view.ui.terminal.input("\x1b[97;1:3u");
			view.ui.terminal.input("\x1b[<35;5;3M");
			view.ui.terminal.input("\x1b[<0;5;3m");
			assert.deepEqual(view.ui.screen(), tasks);
			view.ui.terminal.input("a");
			const live = view.ui.screen();
			assert.ok(has(live, /main line 40$/) && !has(live, /enter open/), live.join("\n"));
			assert.deepEqual(live.slice(-2), ["❯ prompt", "footer"]);
			view.engine.releaseCommands();
			await vi.waitFor(() => assert.equal(view.engine.switcher.viewed.kind, "agent"), FRAME_WAIT);
		} finally {
			await view.dispose();
		}
	});

	test("a subagent that cannot be shown, or a request without keepScreen, leaves the screen live", async () => {
		const view = await tasksOpen();
		try {
			const tasks = view.ui.screen();
			view.engine.switcher.requestView("no-such-task" as never, { keepScreen: true });
			view.closeTasks();
			await vi.waitFor(
				() => assert.ok(view.ui.notices.some((notice) => notice.startsWith("switcher:"))),
				FRAME_WAIT,
			);
			const failed = view.ui.screen();
			assert.notDeepEqual(failed, tasks);
			assert.deepEqual(failed.slice(-2), ["❯ prompt", "footer"]);

			(view.ui.mode.editor as unknown as Text).setText(TASKS);
			view.ui.screen();
			view.engine.holdCommands();
			view.engine.switcher.requestView(view.sub.taskId);
			view.closeTasks();
			assert.deepEqual(
				view.ui.screen().slice(-2),
				["❯ prompt", "footer"],
				"the panel's Enter keeps the screen live",
			);
			view.engine.releaseCommands();
			await vi.waitFor(() => assert.equal(view.engine.switcher.viewed.kind, "agent"), FRAME_WAIT);
		} finally {
			await view.dispose();
		}
	});

	test("a press on the held /tasks rows shows the screen live and acts on nothing; the held rows keep no links", async () => {
		const view = await tasksOpen();
		try {
			const editor = view.ui.mode.editor as unknown as Text & { handleMouse?(event: TuiMouseEvent): object };
			editor.setText(`${hyperlink("Tasks · 1 working", "https://example.invalid/tasks")}\n❯ worker\nenter open`);
			const tasks = view.ui.screen();
			const opensLink = (line: string) => /\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]/.test(line);
			assert.ok(view.ui.tui.getScreenLines().some(opensLink), "/tasks drew its link");
			const pressed: string[] = [];
			editor.handleMouse = (event) => {
				pressed.push(event.type);
				return { handled: true };
			};
			view.engine.holdCommands();
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true });
			view.closeTasks();
			assert.deepEqual(view.ui.screen(), tasks);
			assert.ok(!view.ui.tui.getScreenLines().some(opensLink), "the held rows keep no links");
			const row = tasks.findIndex((line) => line.includes("Tasks · 1 working")) + 1;
			view.ui.terminal.input(`\x1b[<0;3;${row}M`);
			view.ui.terminal.input(`\x1b[<0;3;${row}m`);
			await flush();
			const live = view.ui.screen();
			assert.ok(!has(live, /enter open/), live.join("\n"));
			assert.deepEqual(pressed, [], "the live prompt under the pointer saw no press");
			view.engine.releaseCommands();
			await vi.waitFor(() => assert.equal(view.engine.switcher.viewed.kind, "agent"), FRAME_WAIT);
		} finally {
			await view.dispose();
		}
	});

	test("a resize while the subagent is on its way shows the dock live in its first frame at the new size", async () => {
		const view = await tasksOpen();
		try {
			const tasks = view.ui.screen();
			view.engine.holdCommands();
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true });
			view.closeTasks();
			assert.deepEqual(view.ui.screen(), tasks);
			view.ui.terminal.resize(60, 20);
			const resized = view.ui.screen();
			assert.ok(!has(resized, /enter open/), resized.join("\n"));
			assert.deepEqual(resized.slice(-2), ["❯ prompt", "footer"]);
			await flush();
			assert.deepEqual(view.ui.screen().slice(-2), ["❯ prompt", "footer"]);
			view.engine.releaseCommands();
			await vi.waitFor(() => assert.equal(view.engine.switcher.viewed.kind, "agent"), FRAME_WAIT);
		} finally {
			await view.dispose();
		}
	});

	test("what the dock draws from the engine is asked for while it is held, so the subagent is shown with it", async () => {
		const view = await tasksOpen();
		try {
			// Like the panel the engine draws: once /tasks is closed, its rows come one frame after it is first drawn.
			const editor = view.ui.mode.editor as unknown as Text;
			const render = editor.render.bind(editor);
			let closed = false;
			let asked = false;
			let ready = false;
			editor.render = (width: number) => {
				if (closed && !asked) {
					asked = true;
					queueMicrotask(() => {
						ready = true;
						view.ui.tui.requestRender();
					});
				}
				return [...render(width), ...(ready ? ["panel row"] : [])];
			};
			view.ui.screen();
			view.engine.holdCommands();
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true });
			view.closeTasks();
			closed = true;
			view.ui.screen();
			await flush();
			// The first frame painted once the subagent is shown.
			let shown: string[] | undefined;
			view.engine.switcher.onPending((_pending, settled) => {
				if (settled?.outcome === "shown")
					queueMicrotask(() => {
						shown ??= view.ui.screen();
					});
			});
			view.engine.releaseCommands();
			await vi.waitFor(() => assert.ok(shown !== undefined), FRAME_WAIT);
			assert.ok(has(shown ?? [], /sub line 30$/), shown?.join("\n"));
			assert.deepEqual(shown?.slice(-3), ["❯ prompt", "panel row", "footer"]);
		} finally {
			await view.dispose();
		}
	});

	test("a key another handler takes first (Ctrl+C clearing the prompt) still shows the held dock live", async () => {
		const taken: string[] = [];
		// The main screen's own key handlers are set up before the single chat screen, and take some keys outright.
		const view = await tasksOpen(30, (ui) =>
			ui.tui.addInputListener((data) => {
				if (data !== "\x03") return undefined;
				taken.push(data);
				return { consume: true };
			}),
		);
		try {
			const tasks = view.ui.screen();
			view.engine.holdCommands();
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true });
			view.closeTasks();
			assert.deepEqual(view.ui.screen(), tasks);
			view.ui.terminal.input("\x03");
			assert.deepEqual(taken, ["\x03"]);
			const live = view.ui.screen();
			assert.ok(!has(live, /enter open/), live.join("\n"));
			assert.deepEqual(live.slice(-2), ["❯ prompt", "footer"]);
			view.engine.releaseCommands();
			await vi.waitFor(() => assert.equal(view.engine.switcher.viewed.kind, "agent"), FRAME_WAIT);
		} finally {
			await view.dispose();
		}
	});
	test("a subagent opened from /tasks is shown once the panel /tasks hid has drawn again, never without its rows (#6123)", async () => {
		const view = await tasksOpen();
		try {
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true, panel: true });
			view.closeTasks();
			// /tasks closed in the engine: the panel opens again, and has rows to draw once the host asks for them.
			view.engine.openPanel(["◯ main", "● worker"]);
			await vi.waitFor(() => assert.ok(view.engine.transcriptFramed()), FRAME_WAIT);
			await flush();
			assert.equal(view.engine.switcher.viewed.kind, "main", "the subagent waits for the panel's first frame");
			assert.deepEqual(view.engine.panelRows(), [], "the panel has not drawn yet; this paint asks for its frame");
			await vi.waitFor(() => assert.equal(view.engine.switcher.viewed.kind, "agent"), FRAME_WAIT);
			assert.deepEqual(view.engine.panelRows(), ["◯ main", "● worker"]);
		} finally {
			await view.dispose();
		}
	});

	test("a panel the engine opens again in its place while the subagent is on its way is waited for in turn (#6123)", async () => {
		const view = await tasksOpen();
		try {
			view.engine.holdCommands();
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true, panel: true });
			view.closeTasks();
			view.engine.openPanel(["◯ main", "◯ worker"]);
			await vi.waitFor(() => assert.ok(view.engine.panelId() !== undefined), FRAME_WAIT);
			const first = view.engine.panelId();
			view.engine.panelRows();
			view.engine.releaseCommands(
				(command) => command.type === "engine_custom_render" && command.componentId === first,
			);
			await vi.waitFor(() => assert.deepEqual(view.engine.panelRows(), ["◯ main", "◯ worker"]), FRAME_WAIT);
			// It opens again before the subagent's transcript has drawn: the new one has nothing to draw yet.
			view.engine.openPanel(["◯ main", "● worker"]);
			await vi.waitFor(() => assert.notEqual(view.engine.panelId(), first), FRAME_WAIT);
			view.engine.releaseCommands(
				(command) => command.type !== "engine_custom_render" || command.componentId !== first,
			);
			await vi.waitFor(() => assert.ok(view.engine.transcriptFramed()), FRAME_WAIT);
			await flush();
			assert.equal(view.engine.switcher.viewed.kind, "main", "the new panel's first frame is waited for");
			view.engine.releaseCommands();
			view.engine.panelRows();
			await vi.waitFor(() => assert.equal(view.engine.switcher.viewed.kind, "agent"), FRAME_WAIT);
			assert.deepEqual(view.engine.panelRows(), ["◯ main", "● worker"]);
		} finally {
			await view.dispose();
		}
	});

	test("a panel that closes again before it drew, or a request that does not bring the panel back, waits for no panel (#6123)", async () => {
		const closed = await tasksOpen();
		try {
			closed.engine.switcher.requestView(closed.sub.taskId, { keepScreen: true, panel: true });
			closed.closeTasks();
			closed.engine.openPanel(["◯ main"]);
			await vi.waitFor(() => assert.ok(closed.engine.panelId() !== undefined), FRAME_WAIT);
			closed.engine.closePanel();
			await vi.waitFor(() => assert.ok(closed.engine.transcriptFramed()), FRAME_WAIT);
			await flush();
			assert.equal(closed.engine.switcher.viewed.kind, "agent", "no panel is left to wait for");
			assert.equal(closed.engine.panelRows(), undefined);
		} finally {
			await closed.dispose();
		}
		const plain = await tasksOpen();
		try {
			// Without the engine saying the panel comes back (an older engine), the subagent is shown with its transcript.
			plain.engine.switcher.requestView(plain.sub.taskId, { keepScreen: true });
			plain.closeTasks();
			plain.engine.openPanel(["◯ main"]);
			await vi.waitFor(() => assert.ok(plain.engine.transcriptFramed()), FRAME_WAIT);
			await flush();
			assert.equal(plain.engine.switcher.viewed.kind, "agent", "shown with its transcript, as before");
			assert.deepEqual(plain.engine.panelRows(), [], "the panel had not drawn");
		} finally {
			await plain.dispose();
		}
	});

	test("a panel that never opens again holds the subagent back for its bound at most (#6123)", async () => {
		const view = await tasksOpen();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true, panel: true });
			view.closeTasks();
			for (let turn = 0; turn < 20 && !view.engine.transcriptFramed(); turn++) await flush();
			assert.ok(view.engine.transcriptFramed());
			await flush();
			assert.equal(view.engine.switcher.viewed.kind, "main");
			vi.advanceTimersByTime(PANEL_FIRST_FRAME_TIMEOUT_MS - 1);
			await flush();
			assert.equal(view.engine.switcher.viewed.kind, "main");
			vi.advanceTimersByTime(1);
			await flush();
			assert.equal(view.engine.switcher.viewed.kind, "agent", "shown without the panel once its bound passed");
		} finally {
			vi.useRealTimers();
			await view.dispose();
		}
	});
	test("a panel closed and opened again in one read while the subagent waits for it is waited for in turn (#6123)", async () => {
		const view = await tasksOpen();
		try {
			view.engine.holdCommands();
			view.engine.switcher.requestView(view.sub.taskId, { keepScreen: true, panel: true });
			view.closeTasks();
			view.engine.openPanel(["◯ main", "◯ worker"]);
			await vi.waitFor(() => assert.ok(view.engine.panelId() !== undefined), FRAME_WAIT);
			const first = view.engine.panelId();
			// The transcript draws; the panel has not drawn yet.
			view.engine.releaseCommands(
				(command) => command.type !== "engine_custom_render" || command.componentId !== first,
			);
			await vi.waitFor(() => assert.ok(view.engine.transcriptFramed()), FRAME_WAIT);
			await flush();
			assert.equal(view.engine.switcher.viewed.kind, "main");
			// The engine closes that panel and opens another, read by the host together.
			view.engine.toHost(
				{ type: "engine_custom_close", componentId: first ?? "" },
				{
					type: "engine_custom_open",
					componentId: "remote_widget_again",
					overlay: false,
					widgetKey: AGENT_PANEL_WIDGET_KEY,
					widgetPlacement: "belowEditor",
				},
			);
			await flush();
			assert.equal(view.engine.switcher.viewed.kind, "main", "the panel opened again is waited for");
			view.engine.toHost({
				type: "engine_custom_frame",
				componentId: "remote_widget_again",
				requestId: 1,
				lines: ["◯ main", "● worker"],
			});
			await vi.waitFor(() => assert.equal(view.engine.switcher.viewed.kind, "agent"), FRAME_WAIT);
			view.engine.releaseCommands();
		} finally {
			await view.dispose();
		}
	});
});
