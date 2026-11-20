/**
 * A queued message the subagent takes, on the isolated engine's host: the engine sends the view's status (its queued
 * rows) and its transcript frames as separate messages, and the host may paint after any one of them. Each message
 * the host takes leaves the taken message on screen, queued or in the transcript.
 */
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { taskFixture } from "../../../test/helpers/task-projection.js";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { bindOwnerTaskStore } from "../src/core/tasks/owner-store.js";
import type { ExtensionFactory } from "../src/index.js";
import { AgentViewSwitcher } from "../src/modes/interactive/agent-view/agent-view-switcher.ts";
import { openRemoteAgentViewPort, type RemoteAgentViewPort } from "../src/modes/interactive/agent-view/remote-port.ts";
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
import { flush, mainScreen } from "./helpers/agent-view-screen.ts";
import { createGate, type Gate, holdTool, releaseOpenGates, waitFor } from "./helpers/busy-submission-rig.js";
import { busyTurnResponses, childTranscript } from "./helpers/steering-chats.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

const WIDTH = 80;

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	releaseOpenGates();
	setKeybindings(previousKeys);
});

/** An extension whose `message_start` hook waits on `gate` for the user message `text`. */
function holdMessageStart(text: string, gate: Gate): ExtensionFactory {
	return (pi) => {
		pi.on("message_start", async (event) => {
			if (event.message.role !== "user" || getMessageText(event.message) !== text) return;
			gate.entered.resolve();
			await gate.release.promise;
		});
	};
}

/** What the host holds after it took one engine message: the queued rows it draws and the transcript it draws. */
interface HostState {
	readonly after: InteractiveEngineMessage["type"];
	readonly queued: readonly string[];
	readonly transcript: readonly string[];
}

/**
 * The engine (its custom UI and agent views over the task store the child is bound to) wired to a host screen. Every
 * engine message reaches the host at once, and `states` records the host after each one.
 */
async function isolatedSubagent(child: Harness) {
	const fixture = taskFixture();
	await fixture.start("Steered subagent");
	fixture.runners[0]!.context.bindTranscript(childTranscript(child));
	const taskId = fixture.store.tasks[0]!.ref.taskId;
	const ui = mainScreen();
	const hostListeners = new Set<(message: InteractiveEngineMessage) => void>();
	const states: HostState[] = [];
	let port: RemoteAgentViewPort | undefined;
	const deliver = (message: InteractiveEngineMessage) => {
		for (const listener of [...hostListeners]) listener(message);
		if (port === undefined) return;
		// The rows the host draws above its prompt: the messages being delivered, then the queue.
		const { queued, delivering } = port.status();
		states.push({
			after: message.type,
			queued: [
				...(delivering?.steering ?? []),
				...queued.steering,
				...(delivering?.followUp ?? []),
				...queued.followUp,
			],
			transcript: port.transcript.render(WIDTH).map((line) => stripVTControlCharacters(line).trim()),
		});
	};
	const customUi = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) deliver(message);
	}, new KeybindingsManager());
	const session = {} as AgentSession;
	bindOwnerTaskStore(session, fixture.store);
	const unbind = bindEngineAgentView({
		session,
		send: deliver,
		customUi,
		ui: {
			getChatRenderSettings: () => ({}),
			getFooterDataProvider: () => undefined,
			notify: () => {},
		} as unknown as ExtensionUIContext,
	});
	const runtime = {
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			hostListeners.add(listener);
			return () => hostListeners.delete(listener);
		},
		onGenerationEnded: () => () => {},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			customUi.handleLine(serializeInteractiveEngineFrame(command));
		},
		getGeneration: () => 1,
		async requestAgentView<T>(command: AgentViewRpcCommandBody): Promise<T> {
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
		(id) => openRemoteAgentViewPort(runtime as never, id, { width: WIDTH, rows: 16 }),
		() => {},
	);
	const uninstall = ui.bind(switcher);
	assert.equal(await switcher.view(taskId), true);
	const viewed = switcher.viewed;
	assert.equal(viewed.kind, "agent");
	port = viewed.kind === "agent" ? (viewed.port as RemoteAgentViewPort) : undefined;
	ui.screen();
	return {
		ui,
		states,
		dispose: async () => {
			uninstall();
			unbind();
			customUi.dispose();
			await fixture.dispose();
		},
	};
}

describe("a queued message the isolated engine's subagent takes", () => {
	for (const lane of ["steer", "followUp"] as const) {
		test(`is on the host's screen after every engine message, queued or in the transcript (${lane}, S9)`, async () => {
			const hook = createGate();
			const toolHold = createGate();
			const child = await createHarness({
				tools: [holdTool(toolHold)],
				extensionFactories: [holdMessageStart("later one", hook)],
			});
			child.setResponses(busyTurnResponses());
			const view = await isolatedSubagent(child);
			try {
				const turn = child.session.prompt("first").catch(() => {});
				await toolHold.entered.promise;
				await child.session.prompt("later one", { streamingBehavior: lane });
				await waitFor(
					"the queued row on the host",
					() => view.states.at(-1)?.queued.includes("later one") === true,
				);
				const from = view.states.length - 1;

				toolHold.release.resolve();
				await hook.entered.promise;
				await flush();
				hook.release.resolve();
				await waitFor(
					"the message in the host's transcript",
					() => view.states.at(-1)?.transcript.includes("later one") === true,
				);
				await waitFor("the queued row to leave", () => view.states.at(-1)?.queued.includes("later one") === false);
				await turn;

				const gaps = view.states
					.slice(from)
					.filter((state) => !state.queued.includes("later one") && !state.transcript.includes("later one"));
				assert.deepEqual(
					gaps.map((state) => state.after),
					[],
					"after these engine messages the host showed the message neither queued nor in the transcript",
				);
			} finally {
				hook.release.resolve();
				toolHold.release.resolve();
				await view.dispose();
				await child.cleanup();
			}
		});
	}
});
