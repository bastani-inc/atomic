/**
 * The single chat screen on the isolated engine's host: the engine opens a view of its subagent, mounts the
 * transcript as a remote component with `placement: "transcript"`, and the host draws it where its main transcript is.
 * The engine side and the host side talk through the real engine protocol lines.
 */
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { bindOwnerTaskStore } from "../src/core/tasks/owner-store.js";
import { AgentViewSwitcher } from "../src/modes/interactive/agent-view/agent-view-switcher.ts";
import { openRemoteAgentViewPort, type RemoteAgentViewPort } from "../src/modes/interactive/agent-view/remote-port.ts";
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
			child.handleLine(serializeInteractiveEngineFrame(command));
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
			setWidget: () => {},
			custom: () => new Promise(() => {}),
			onWidgetRelease: () => () => {},
		} as unknown as ExtensionUIContext,
		{ isFullscreen: () => true, onRendererReplaced: () => () => {} },
	);
	const switcher = new AgentViewSwitcher(
		(taskId) => openRemoteAgentViewPort(runtime as never, taskId, { width: ui.terminal.columns, rows: 16 }),
		(message) => ui.notices.push(`switcher: ${message}`),
	);
	return {
		switcher,
		session,
		sent,
		requests,
		engineMessages,
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
});
