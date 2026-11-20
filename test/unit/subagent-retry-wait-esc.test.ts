import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { isTaskTurnInterrupted } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { engineTaskInspectorUi, showTaskInspector } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";
import {
	LIVE_CHILD_START_WAIT_MS,
	type LiveChildOptions,
	liveChildEnvironment,
} from "../helpers/live-child-environment.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";

/** A live child loads its real resources; that load is the structural cost of these tests. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
/** Longer than any test here runs: a retry that is not cancelled never sends its next attempt during the test. */
const RETRY_WAIT_MS = 10 * 60_000;
const CONDITION_WAIT_MS = 20_000;
const ESC = "\x1b";
const APPLICATION_COMMAND = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const plain = (lines: readonly string[]): string =>
	lines.map((line) => stripVTControlCharacters(line.replace(APPLICATION_COMMAND, "")).trimEnd()).join("\n");

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function until(predicate: () => boolean, what: string, timeoutMs = CONDITION_WAIT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), `${what} never happened`);
}

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "worker agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/worker.md",
	};
}

const cleanups: Array<() => void> = [];
let previousKeybindings: ReturnType<typeof getKeybindings>;
let keybindings: KeybindingsManager;
beforeEach(() => {
	initTheme("dark");
	previousKeybindings = getKeybindings();
	keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
});
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
	setKeybindings(previousKeybindings);
});

/**
 * A real subagent, run in this process as a background task, whose first request fails as overloaded: it waits to
 * retry with a backoff longer than the test. Its next request answers.
 */
async function subagentWaitingToRetry(liveOptions: LiveChildOptions = {}) {
	const env = await liveChildEnvironment(cleanups, liveOptions);
	env.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" }),
		fauxAssistantMessage("answered after the interrupt"),
	]);
	const fixture = taskFixture();
	await fixture.start("fix the picker");
	const taskId = fixture.store.tasks[0]!.ref.taskId;
	let source: TaskTranscriptSource | undefined;
	const events: AgentSessionEvent[] = [];
	const stop = new AbortController();
	const hooks: TaskExecutionHooks = {
		signal: stop.signal,
		reportActivity() {},
		bindTranscript(bound) {
			source = bound;
			fixture.runners[0]!.context.bindTranscript(bound);
			bound.subscribe?.((event) => events.push(event));
		},
		onExecution() {},
	};
	const options = env.options("retry-wait-esc", { signal: stop.signal, taskExecution: hooks });
	const childSessionOptions = options.getChildSessionOptions!;
	let settled = false;
	const run = runSingleInProcess(env.root, agent(), "fix the picker", {
		...options,
		getChildSessionOptions: (childOptions) => ({
			...childSessionOptions(childOptions),
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: true, maxRetries: 3, baseDelayMs: RETRY_WAIT_MS },
				compaction: { enabled: false },
			}),
		}),
	}).finally(() => {
		settled = true;
	});
	cleanups.push(() => stop.abort("user"));
	await until(
		() => events.some((event) => event.type === "auto_retry_start"),
		"the retry wait",
		LIVE_CHILD_START_WAIT_MS,
	);
	const session = source!.chatSession as AgentSession;
	// A session with a fallback chain keeps its run open through the wait, so it reads as streaming then.
	if (liveOptions.fallbackModels === undefined)
		assert.equal(session.isStreaming, false, "nothing streams between two attempts of a retry");
	return {
		env,
		fixture,
		taskId,
		session,
		source: source!,
		events,
		run,
		settled: () => settled,
		retryCancelled: () =>
			events.some((event) => event.type === "auto_retry_end" && event.finalError === "Retry cancelled"),
		async dispose() {
			stop.abort("user");
			await run;
			await fixture.dispose();
		},
	};
}

type RetryingSubagent = Awaited<ReturnType<typeof subagentWaitingToRetry>>;

/** After Esc: the retry is cancelled, the turn ended paused, and the child waits; the reader's next message answers. */
async function assertInterruptedAndResumable(child: RetryingSubagent): Promise<void> {
	await until(child.retryCancelled, "the retry's cancellation");
	await until(() => isTaskTurnInterrupted(child.fixture.store.tasks[0]!), "the task's paused state");
	assert.equal(child.session.isRetrying, false, "the retry wait ended");
	assert.equal(child.env.faux.state.callCount, 1, "the failed request was not sent again");
	assert.equal(child.settled(), false, "the subagent did not end: it waits for the next message");
	assert.equal(child.fixture.store.tasks[0]!.execution.kind, "running", "its task keeps running");

	const sessionId = child.source.getSessionId();
	await child.session.prompt("carry on", { streamingBehavior: "steer" });
	const result = await child.run;
	assert.equal(result.status, "ok");
	assert.equal(result.finalOutput, "answered after the interrupt");
	assert.equal(child.source.getSessionId(), sessionId, "the same session continued");
}

test(
	"Esc in a subagent's chat cancels its retry wait, and the hint offers esc to interrupt during the wait (#5507)",
	async () => {
		const child = await subagentWaitingToRetry();
		const environment = taskTranscriptEnvironment({ tui: makeTestTui(24), keybindings: getKeybindings() });
		const inspector = new TaskInspector(
			ownerTaskViewSource(child.fixture.store),
			() => {},
			() => {},
			undefined,
			() => environment,
		);
		try {
			inspector.openChat(child.taskId, "main chat");
			await flush();
			assert.match(plain(inspector.renderViewport(100, 24)), /← main chat · esc to interrupt/);

			assert.equal(inspector.handleInput(ESC), true);
			await assertInterruptedAndResumable(child);
			assert.doesNotMatch(plain(inspector.renderViewport(100, 24)), /esc to interrupt/, "a finished turn has none");
		} finally {
			inspector.dispose();
			await child.dispose();
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a subagent's chat opened while a subagent with a fallback model waits to retry shows the wait (#5523)",
	async () => {
		const child = await subagentWaitingToRetry({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackModels: ["faux/faux-2"],
		});
		const environment = taskTranscriptEnvironment({ tui: makeTestTui(24), keybindings: getKeybindings() });
		const inspector = new TaskInspector(
			ownerTaskViewSource(child.fixture.store),
			() => {},
			() => {},
			undefined,
			() => environment,
		);
		try {
			inspector.openChat(child.taskId, "main chat");
			await flush();
			const opened = plain(inspector.renderViewport(100, 24));
			// The chat reads the wait from the subagent's session: its reason, attempt and countdown, and Esc cancels it.
			assert.match(opened, /∀ Retrying · overloaded · attempt 1\/3 in (?:\d+m )?\d+s {3}esc cancel/);
			assert.match(opened, /← main chat · esc to interrupt/);

			assert.equal(inspector.handleInput(ESC), true);
			await assertInterruptedAndResumable(child);
		} finally {
			inspector.dispose();
			await child.dispose();
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"Esc in a subagent's chat opened from the isolated engine's agent panel cancels its retry wait (#5507)",
	async () => {
		const child = await subagentWaitingToRetry();
		const messages: InteractiveEngineMessage[] = [];
		const service = new EngineCustomUiService((line) => {
			const message = parseInteractiveEngineMessage(line);
			if (message) messages.push(message);
		}, keybindings);
		const engineUi = {
			getChatRenderSettings: () => ({}) as ReturnType<ExtensionUIContext["getChatRenderSettings"]>,
			getToolsExpanded: () => false,
			notify: () => {},
			getFooterDataProvider: () => undefined as unknown as ReturnType<ExtensionUIContext["getFooterDataProvider"]>,
		};
		let requestId = 0;
		const send = async (
			frame:
				| { type: "engine_custom_render"; width: number; rows: number }
				| { type: "engine_custom_input"; data: string },
		) => {
			const open = messages.findLast((message) => message.type === "engine_custom_open");
			assert.ok(open && open.type === "engine_custom_open", "the engine opened the subagent's chat");
			service.handleLine(
				serializeInteractiveEngineFrame({ ...frame, componentId: open.componentId, requestId: ++requestId }),
			);
			await flush();
		};
		const frame = async (): Promise<string> => {
			await send({ type: "engine_custom_render", width: 100, rows: 24 });
			const painted = messages.findLast((message) => message.type === "engine_custom_frame");
			assert.ok(painted && painted.type === "engine_custom_frame");
			return plain(painted.lines);
		};
		const shown = showTaskInspector(
			engineTaskInspectorUi(engineUi as Parameters<typeof engineTaskInspectorUi>[0], {
				custom: service.custom.bind(service),
			}),
			child.fixture.store,
			child.taskId,
			{ chat: true, backLabel: "main chat" },
		);
		try {
			await flush();
			assert.match(await frame(), /← main chat · esc to interrupt/);

			await send({ type: "engine_custom_input", data: ESC });
			const handled = messages.findLast((message) => message.type === "engine_custom_input_result");
			assert.ok(handled && handled.type === "engine_custom_input_result" && handled.handled);
			await assertInterruptedAndResumable(child);
			assert.doesNotMatch(await frame(), /esc to interrupt/, "a finished turn has none");
		} finally {
			service.dispose();
			await shown;
			await child.dispose();
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
