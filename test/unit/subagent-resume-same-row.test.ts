import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { bindTaskResumer } from "../../packages/coding-agent/src/core/tasks/task-resumer.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { showAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";
import { WORKING_LINE } from "../helpers/working-line.ts";
import { makeTestTui } from "../support/fake-tui.js";

const ENTER = "\r";
const LEFT = "\x1b[D";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeys);
});

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Turns of the event loop until `done` holds: a resume launches its attempt over several asynchronous steps. */
async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !done(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

type Listener = (event: AgentSessionEvent) => void;

/**
 * A subagent's session as its task binds it: the conversation it keeps across attempts, live while an attempt runs.
 * A resumed attempt binds the same conversation again; what reaches it is recorded.
 */
function childSession(conversation: SessionManager, running: boolean) {
	const listeners = new Set<Listener>();
	const received: string[] = [];
	const take = async (text: string) => {
		const finish = session.finishBeforeMessage;
		if (finish !== undefined) {
			session.finishBeforeMessage = undefined;
			await finish();
			return { delivered: false as const, reason: "refused" as const, detail: "the subagent has ended" };
		}
		received.push(text);
		return { delivered: true as const };
	};
	const session: TaskTranscriptSource & {
		listeners: Set<Listener>;
		received: string[];
		running: boolean;
		finishBeforeMessage: (() => Promise<void>) | undefined;
	} = Object.assign(Object.create(conversation) as SessionManager, {
		listeners,
		received,
		running,
		subscribe: (listener: Listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		isRunning: () => session.running,
		completionSource: { runId: "run-1", intercomTarget: "subagent-worker-run-1-0" },
		/** Set to make the attempt finish just as a message reaches it, which it then does not take. */
		finishBeforeMessage: undefined as (() => Promise<void>) | undefined,
		// The message reaches the running attempt: through its own queue where the session has one, else Intercom.
		queueMessage: (text: string) => take(text),
		sendMessage: (text: string) => take(text),
	});
	return session;
}

/**
 * /tasks over a real task store, with a subagent extension's resumer: a message to a settled subagent resumes it as a
 * new attempt (a new task whose launch operation is the first one's with `:resume:<id>`), in the same conversation.
 */
async function harness() {
	const fixture = taskFixture();
	const source = ownerTaskViewSource(fixture.store);
	const conversations = new Map<string, SessionManager>();
	const sessions: ReturnType<typeof childSession>[] = [];
	const resumes: { taskId: string; message: string }[] = [];
	let attempts = 0;
	const launch = async (
		task: string,
		operation: string,
		conversation: SessionManager,
		running = true,
		bound = true,
	) => {
		const runner = fixture.runners.length;
		const known = new Set(fixture.store.ownerTasks.map((record) => record.ref.taskId));
		const lease = taskValue(
			await fixture.supervisor.startAgentTask(
				fixture.owner,
				{ kind: "agent", agent: "worker", task },
				operation as OperationId,
			),
		);
		taskValue(await fixture.supervisor.initialObservation(lease, { kind: "background" }));
		// The attempt's runner starts on the supervisor's own turn; its session binds to that runner, as a child's does.
		await until(() => fixture.runners.length > runner);
		const session = childSession(conversation, running);
		sessions.push(session);
		if (bound) fixture.runners[runner]!.context.bindTranscript(session);
		conversations.set(operation.split(":resume:")[0]!, conversation);
		let launched: TaskId | undefined;
		await until(() => {
			fixture.store.drain();
			launched = fixture.store.tasks.find((record) => !known.has(record.ref.taskId))?.ref.taskId;
			return launched !== undefined;
		});
		return launched!;
	};
	/** When set, the next resume loses to a wake that started the subagent again just before it. */
	const race = { wakeFirst: false };
	const unbind = bindTaskResumer(fixture.supervisor, {
		readOnlyReason: () => undefined,
		async resume(taskId, message) {
			resumes.push({ taskId, message });
			const task = fixture.store.tasks.find((candidate) => candidate.ref.taskId === taskId)!;
			const child = task.launchOperationId.split(":resume:")[0]!;
			if (race.wakeFirst) {
				race.wakeFirst = false;
				const woken = await launch(
					"You were resumed by a message",
					`${child}:resume:${++attempts}`,
					conversations.get(child)!,
				);
				return { ok: false, reason: `worker is already running as task ${woken}; pause or quit it first.` };
			}
			await launch(message, `${child}:resume:${++attempts}`, conversations.get(child)!);
			return { ok: true };
		},
	});
	const environment = taskTranscriptEnvironment({ tui: makeTestTui(30), keybindings: getKeybindings() });
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
		undefined,
		() => environment,
	);
	const text = (width = 110, rows = 30) =>
		inspector
			.renderViewport(width, rows)
			.map((line) => stripVTControlCharacters(line).trimEnd())
			.join("\n");
	const type = async (value: string) => {
		for (const ch of value) inspector.handleInput(ch);
		await flush();
	};
	const settle = async (index: number) => {
		const record = fixture.store.tasks[index]!;
		const session = sessions[index]!;
		session.running = false;
		for (const listener of session.listeners) listener({ type: "agent_end", messages: [] } as AgentSessionEvent);
		fixture.runners[index]!.result.resolve({ kind: "completed", output: record.output });
		await until(() => {
			fixture.store.drain();
			return fixture.store.tasks[index]?.execution.kind === "settled";
		});
		await flush();
	};
	const started = async (title: string, operation: string, running = true) => {
		const conversation = SessionManager.inMemory();
		await conversation.appendMessage({ role: "user", content: title, timestamp: 0 });
		return launch(title, operation, conversation, running);
	};
	return {
		fixture,
		source,
		inspector,
		sessions,
		resumes,
		race,
		/** A resume of the subagent `taskId` whose attempt's session is not bound yet; `bind` binds it. */
		async resumeUnbound(taskId: string, message: string) {
			const task = fixture.store.tasks.find((candidate) => candidate.ref.taskId === taskId)!;
			const child = task.launchOperationId.split(":resume:")[0]!;
			const runner = fixture.runners.length;
			await launch(message, `${child}:resume:${++attempts}`, conversations.get(child)!, true, false);
			return {
				bind() {
					fixture.runners[runner]!.context.bindTranscript(sessions[runner]!);
					// The running attempt reports what it does, as a child does once its session runs.
					taskValue(
						fixture.runners[runner]!.context.reportActivity({
							reportId: `bound-${runner}`,
							change: { kind: "action", tool: "read", text: "README.md" },
						}),
					);
					fixture.store.drain();
				},
			};
		},
		text,
		type,
		settle,
		started,
		async dispose() {
			unbind();
			inspector.dispose();
			await fixture.dispose();
		},
	};
}

/** The /tasks rows of the worker subagents: their titles and what each row says of its state. */
function workerRows(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => /^ [❯ ] [✓∀✗◼◌] worker\b/u.test(line))
		.map((line) => line.replace(/\s+/g, " ").trim());
}

test("/tasks lists a resumed subagent as one row, in its live state, and keeps it selected", async () => {
	const h = await harness();
	try {
		await h.started("Slow rounds", "run-1:0");
		await h.started("Other work", "run-1:1");
		await h.settle(0);
		h.inspector.open(h.fixture.store.tasks[0]!.ref.taskId);
		assert.equal(workerRows(h.text()).length, 2);
		assert.match(workerRows(h.text()).find((row) => row.startsWith("❯"))!, /Slow rounds .*done/);

		await h.source.sendTaskMessage!(h.fixture.store.tasks[0]!.ref.taskId, "continue please");
		await flush();
		const resumed = workerRows(h.text());
		assert.equal(resumed.length, 2, `one row per subagent while it runs again:\n${h.text()}`);
		assert.doesNotMatch(resumed.join("\n"), /done/, "neither row says done: the resumed subagent runs");
		assert.match(resumed.find((row) => row.startsWith("❯")) ?? "", /^❯ ∀ worker/, "the selection stays on it");

		await h.settle(2);
		const finished = workerRows(h.text());
		assert.equal(finished.length, 2, `one row once it finished again:\n${h.text()}`);
		assert.match(finished.find((row) => row.startsWith("❯")) ?? "", /^❯ ✓ worker .*done/);

		h.inspector.handleInput("x");
		await flush();
		assert.deepEqual(
			workerRows(h.text()).map((row) => row.replace(/^[❯ ] /, "")),
			["∀ worker Other work 0s"],
			"x dismisses the subagent's row, and the attempt it continued does not come back",
		);
	} finally {
		await h.dispose();
	}
});

/** The open chat's composer label: `<agent> · <title> · <state>`, the chat's header. */
function chatLabel(text: string): string {
	return (
		text
			.split("\n")
			.find((line) => /^─+ worker · .+ ─$/.test(line))
			?.replace(/^─+ /, "")
			.replace(/ ─$/, "") ?? ""
	);
}

test("a finished subagent's chat follows its resumed attempt: header and working line show it running, and the next message steers it (#5224)", async () => {
	const h = await harness();
	try {
		await h.started("Slow rounds", "run-1:0");
		await h.settle(0);
		h.inspector.handleInput(ENTER);
		await flush();
		assert.match(chatLabel(h.text()), /^worker · Slow rounds · done$/);
		assert.ok(!WORKING_LINE.test(h.text()), "no working line while it is done");

		await h.type("continue please");
		h.inspector.handleInput(ENTER);
		await until(() => !/· done$/.test(chatLabel(h.text())));
		assert.deepEqual(
			h.resumes.map((resume) => resume.message),
			["continue please"],
			"the message resumes the subagent",
		);
		assert.doesNotMatch(chatLabel(h.text()), /· done$/, `the header no longer says done:\n${h.text()}`);
		assert.doesNotMatch(h.text(), /Completed/, "nor does the page's summary");
		assert.ok(WORKING_LINE.test(h.text()), `the working line shows while the resumed turn runs:\n${h.text()}`);

		await h.type("and one more thing");
		h.inspector.handleInput(ENTER);
		await until(() => h.sessions.at(-1)!.received.length > 0);
		assert.equal(h.resumes.length, 1, "a message while it runs is not a second resume");
		assert.deepEqual(h.sessions.at(-1)!.received, ["and one more thing"], "it reaches the running attempt");
		assert.doesNotMatch(h.text(), /already running|could not|refused/i);

		h.inspector.handleInput(LEFT);
		assert.equal(workerRows(h.text()).length, 1, `still one row:\n${h.text()}`);
		assert.match(workerRows(h.text())[0]!, /^❯ ∀ worker/);
	} finally {
		await h.dispose();
	}
});

test("an earlier attempt's id opens its subagent's one row and its live chat, as from a completion notice", async () => {
	const h = await harness();
	try {
		const first = await h.started("Slow rounds", "run-1:0");
		await h.started("Other work", "run-1:1");
		await h.settle(0);
		await h.source.sendTaskMessage!(first, "continue please");
		await flush();

		h.inspector.open(h.fixture.store.tasks[1]!.ref.taskId);
		assert.match(workerRows(h.text()).find((row) => row.startsWith("❯")) ?? "", /Other work/);
		h.inspector.open(first);
		assert.match(
			workerRows(h.text()).find((row) => row.startsWith("❯")) ?? "",
			/^❯ ∀ worker continue please/,
			`/tasks <earlier attempt> selects the subagent's row:\n${h.text()}`,
		);

		h.inspector.openChat(first, "main chat");
		await until(() => WORKING_LINE.test(h.text()));
		assert.match(chatLabel(h.text()), /^worker · continue please · /, `the chat opens:\n${h.text()}`);
		assert.doesNotMatch(chatLabel(h.text()), /done$/);
		assert.match(h.text(), /› from main\n ❯ Slow rounds/, "its header echoes the subagent's task from main");
		assert.ok(WORKING_LINE.test(h.text()), "and its working line");
	} finally {
		await h.dispose();
	}
});

test("a resumed attempt whose session is not there yet leaves the chat on what it shows until it is", async () => {
	const h = await harness();
	try {
		const first = await h.started("Slow rounds", "run-1:0");
		await h.settle(0);
		h.inspector.handleInput(ENTER);
		await flush();
		const resumed = await h.resumeUnbound(first, "continue please");
		await flush();
		assert.match(chatLabel(h.text()), /^worker · continue please · running$/, h.text());
		assert.doesNotMatch(h.text(), /Transcript unavailable/, `no read of a session that is not there:\n${h.text()}`);
		assert.match(h.text(), /Slow rounds/, "the conversation stays shown");

		resumed.bind();
		await until(() => WORKING_LINE.test(h.text()));
		assert.ok(WORKING_LINE.test(h.text()), `once its session is there, the chat follows it:\n${h.text()}`);
	} finally {
		await h.dispose();
	}
});

test("a message whose resume loses to a wake that started the subagent first reaches the running attempt, not the editor", async () => {
	const h = await harness();
	try {
		await h.started("Slow rounds", "run-1:0");
		await h.settle(0);
		h.inspector.handleInput(ENTER);
		await flush();
		h.race.wakeFirst = true;
		await h.type("continue please");
		h.inspector.handleInput(ENTER);
		await until(() => h.sessions.at(-1)!.received.length > 0);
		assert.equal(h.resumes.length, 1);
		assert.deepEqual(h.sessions.at(-1)!.received, ["continue please"], "the woken attempt gets the message");
		assert.doesNotMatch(h.text(), /already running|did not deliver/i, h.text());
		assert.match(h.text(), /Message worker…/, "the editor is empty: nothing came back to it");
	} finally {
		await h.dispose();
	}
});

test("a message to a running subagent that finishes before taking it resumes the subagent with it, not the editor", async () => {
	const h = await harness();
	try {
		await h.started("Slow rounds", "run-1:0");
		h.inspector.handleInput(ENTER);
		await flush();
		h.sessions[0]!.finishBeforeMessage = () => h.settle(0);
		await h.type("one more step");
		h.inspector.handleInput(ENTER);
		await until(() => h.resumes.length > 0 && !/· done$/.test(chatLabel(h.text())));
		assert.deepEqual(h.resumes, [{ taskId: h.fixture.store.tasks[0]!.ref.taskId, message: "one more step" }]);
		assert.doesNotMatch(h.text(), /did not deliver|has ended/i, h.text());
		assert.match(h.text(), /Message worker…/, "the editor is empty: nothing came back to it");
		assert.doesNotMatch(chatLabel(h.text()), /· done$/, "the chat follows the attempt it resumed");
	} finally {
		await h.dispose();
	}
});

test("a finished subagent's detail page in /tasks follows it when it is resumed", async () => {
	const h = await harness();
	try {
		const first = await h.started("Slow rounds", "run-1:0");
		await h.settle(0);
		h.inspector.open(first);
		h.inspector.handleInput(" ");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.match(h.text(), /› Inspect transcript/, h.text());
		assert.match(h.text(), /Completed/, h.text());
		await h.source.sendTaskMessage!(first, "continue please");
		await until(() => !/Completed/.test(h.text()));
		assert.doesNotMatch(h.text(), /Completed/, `the page shows the attempt that runs now:\n${h.text()}`);
		assert.match(h.text(), /continue please/);
		assert.doesNotMatch(h.text(), /Resume id/, "a running subagent names no resume id (#5968)");

		await h.settle(1);
		await until(() => /Completed/.test(h.text()));
		assert.equal(
			h.text().match(/Resume id run-1:0\b/g)?.length,
			1,
			`once finished again it names its resume id once (#5968):\n${h.text()}`,
		);
	} finally {
		await h.dispose();
	}
});

test("leaving a subagent's chat opened from the agent panel selects its row again after it was resumed there", async () => {
	const h = await harness();
	const owner = {};
	bindOwnerTaskStore(owner, h.fixture.store);
	const slow = await h.started("Slow rounds", "run-1:0");
	await h.started("Other work", "run-1:1");
	const screens: string[][] = [];
	const render = (component: { render(width: number): string[] }) =>
		component.render(110).map((line) => stripVTControlCharacters(line).trimEnd());
	const selected = (screen: readonly string[]) => screen.find((line) => /❯ /.test(line)) ?? "";
	try {
		await showAgentPanel(owner, {
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			async custom<T>(factory: Parameters<Parameters<typeof showAgentPanel>[1]["custom"]>[0]): Promise<T> {
				let finished = false;
				const component = await factory(makeTestTui(30), theme, new KeybindingsManager(), (() => {
					finished = true;
				}) as never);
				await flush();
				const step = screens.length;
				screens.push(render(component));
				if (step === 0) {
					// Select the subagent "Slow rounds" and open its chat.
					for (let row = 0; row < 3 && !/Slow rounds/.test(selected(render(component))); row++)
						component.handleInput?.("\x1b[B");
					screens[0] = render(component);
					component.handleInput?.(ENTER);
				} else if (step === 1) {
					// It finishes while its chat is open, and a message there resumes it.
					await h.settle(0);
					for (const ch of "continue please") component.handleInput?.(ch);
					component.handleInput?.(ENTER);
					await until(() => h.fixture.store.tasks.length === 3);
					// Another subagent starts meanwhile: it is the panel's first row.
					await h.started("Later work", "run-1:2");
					screens[1] = render(component);
					component.handleInput?.(LEFT);
				} else component.handleInput?.("\x1b");
				if (!finished) component.dispose?.();
				return undefined as T;
			},
		});
		const shown = screens.map((screen) => screen.join("\n")).join("\n=====\n");
		assert.equal(screens.length, 3, shown);
		assert.match(selected(screens[0]!), /Slow rounds/, shown);
		assert.deepEqual(
			h.resumes.map((resume) => resume.taskId),
			[slow],
			shown,
		);
		assert.match(selected(screens[2]!), /continue please/, `its row is selected again:\n${shown}`);
	} finally {
		await h.dispose();
	}
});
