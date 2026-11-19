import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { AgentPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore, OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { type FakeRunnerContext, TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	type TaskBoardSource,
	TaskInspector,
} from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { agentPanelBoardSource } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const ESC = "\x1b";
const ENTER = "\r";
const SPACE = " ";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const WHEEL_DOWN = "\x1b[<65;10;5M";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeys);
});

function ok<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? "" : JSON.stringify((result as { error: unknown }).error));
	return (result as { ok: true; value: T }).value;
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function heldFixture() {
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const supervisor = new TaskSupervisor();
	const runners: { context: FakeRunnerContext; resolve: (result: C.TaskResult) => void }[] = [];
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {},
		createRunner(context) {
			let resolve!: (result: C.TaskResult) => void;
			const result = new Promise<C.TaskResult>((done) => {
				resolve = done;
			});
			runners.push({ context, resolve });
			return { result, cleanup: Promise.resolve({ kind: "reaped" as const }) };
		},
	});
	const owner = ok(supervisor.openTaskOwner(host, scope));
	const store = new OwnerTaskStore(supervisor, owner);
	ok(store.connect());
	const session = {};
	bindOwnerTaskStore(session, store);
	return {
		supervisor,
		owner,
		store,
		session,
		runners,
		async start(task: string) {
			const lease = ok(
				await supervisor.startAgentTask(
					owner,
					{ kind: "agent", agent: "worker", task },
					randomUUID() as C.OperationId,
				),
			);
			ok(await supervisor.initialObservation(lease, { kind: "background" }));
			store.drain();
			const record = store.tasks.find((candidate) => candidate.title === task);
			assert.ok(record);
			return { lease, id: record.ref.taskId, runner: runners.at(-1)! };
		},
		async dispose() {
			for (const runner of runners) runner.resolve({ kind: "cancelled", cause: "owner-close" });
			store.dispose();
			await supervisor.closeTaskOwner(owner, "session-close");
		},
	};
}

function waiting(id: string, choices: string[]): AgentPanelItem {
	return {
		id,
		kind: "agent",
		state: "input",
		name: id.slice(4),
		task: "stage plan",
		question: "Pick one",
		choices,
		elapsedMs: 1000,
	};
}

function runSource(
	items: () => readonly AgentPanelItem[],
	answer: (id: string, text: string) => Promise<{ ok: true } | { ok: false; reason: string }>,
) {
	const listeners = new Set<() => void>();
	const answered: [string, string][] = [];
	const source: TaskBoardSource = {
		items,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		answer: async (id, text) => {
			answered.push([id, text]);
			return answer(id, text);
		},
	};
	return {
		source,
		answered,
		emit: () => {
			for (const listener of listeners) listener();
		},
	};
}

test("arrows, wheel and ? while a reply is sending are ignored, and the sent reply never returns as a draft (#5224)", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const items = [waiting("run:ralph", ["Yes", "No"]), waiting("run:second", ["Alpha", "Beta"])];
	const { source, answered } = runSource(
		() => items,
		async () => {
			await gate;
			return { ok: true };
		},
	);
	const f = heldFixture();
	try {
		const inspector = new TaskInspector(
			f.store,
			() => {},
			() => {},
		);
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		inspector.renderViewport(100, 24);
		inspector.handleInput("1");
		inspector.handleInput(ENTER);
		inspector.handleInput(DOWN);
		inspector.handleInput(WHEEL_DOWN);
		inspector.handleInput("?");
		const sendingText = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(sendingText, /Sending…/);
		release();
		await flush();
		assert.deepEqual(answered, [["run:ralph", "Yes"]]);
		inspector.handleInput(SPACE);
		const reopened = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.doesNotMatch(reopened, /❯ Yes/);
		inspector.handleInput("2");
		const picked = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(picked, /│ ❯ No\b/);
		assert.doesNotMatch(picked, /Yes2/);
		inspector.dispose();
	} finally {
		await f.dispose();
	}
});

test("a source refresh during an in-flight reply cleans up the sent row's draft and preserves another row's draft (#5224)", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ralph = waiting("run:ralph", ["Yes", "No"]);
	const second = waiting("run:second", ["Alpha", "Beta"]);
	let currentItems: AgentPanelItem[] = [ralph, second];
	const { source, answered, emit } = runSource(
		() => currentItems,
		async () => {
			await gate;
			return { ok: true };
		},
	);
	const f = heldFixture();
	try {
		const inspector = new TaskInspector(
			f.store,
			() => {},
			() => {},
		);
		inspector.setBoardSource(source);
		inspector.handleInput(DOWN);
		inspector.handleInput(SPACE);
		inspector.renderViewport(100, 24);
		inspector.handleInput("2");
		inspector.handleInput(ESC);
		inspector.handleInput(UP);
		inspector.handleInput(SPACE);
		inspector.renderViewport(100, 24);
		inspector.handleInput("1");
		inspector.handleInput(ENTER);
		currentItems = [second];
		emit();
		inspector.renderViewport(100, 24);
		currentItems = [ralph, second];
		emit();
		inspector.renderViewport(100, 24);
		release();
		await flush();
		assert.deepEqual(answered, [["run:ralph", "Yes"]]);
		inspector.handleInput(SPACE);
		const secondOpenCard = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(secondOpenCard, /│ ❯ Beta\b/);
		inspector.handleInput(ESC);
		inspector.handleInput(UP);
		inspector.handleInput(SPACE);
		const ralphCard = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.doesNotMatch(ralphCard, /❯ Yes/);
		inspector.dispose();
	} finally {
		await f.dispose();
	}
});

test("a subagent waiting for input opens its detail and question route on Space instead of an extension reply card (#5224)", async () => {
	const f = heldFixture();
	try {
		const a = await f.start("Needs an answer");
		const route: C.PromptRoute = { sessionId: "s-1", promptId: "p-1" };
		ok(
			a.runner.context.reportActivity({
				reportId: "attn-1",
				change: {
					kind: "attention-set",
					attention: {
						kind: "input-needed",
						requestId: "q-1",
						prompt: "Which branch?",
						route,
					},
				},
			}),
		);
		f.store.drain();
		const routed: C.PromptRoute[] = [];
		const inspector = new TaskInspector(
			f.store,
			() => {},
			() => {},
			(target) => routed.push(target),
		);
		inspector.setBoardSource(agentPanelBoardSource(f.session as never));
		inspector.handleInput(SPACE);
		inspector.handleInput(ENTER);
		await flush();
		const detail = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.equal(inspector.navigation.focus.kind, "detail");
		assert.match(detail, /Which branch\?/);
		assert.match(detail, /› Inspect transcript/);
		assert.doesNotMatch(detail, /This item cannot be answered from here/);
		inspector.handleInput(DOWN);
		inspector.handleInput(DOWN);
		const questionSelected = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(questionSelected, /› Open question/);
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(routed, [route]);
		inspector.dispose();
	} finally {
		await f.dispose();
	}
});

test("inline /tasks picker pins the reply line, Sending… and bottom border with 5+ choices, active filter and notice (#5224)", async () => {
	let failNext = false;
	let holdSend = false;
	let releaseSend!: () => void;
	const items = [
		waiting("run:ralph", ["A", "B", "C", "D", "E"]),
		{ ...waiting("run:other", []), state: "running" as const, question: undefined, choices: undefined },
	];
	const { source, answered } = runSource(
		() => items,
		async () => {
			if (failNext) {
				failNext = false;
				return { ok: false, reason: "offline" };
			}
			if (holdSend) {
				await new Promise<void>((resolve) => {
					releaseSend = resolve;
				});
			}
			return { ok: true };
		},
	);
	const f = heldFixture();
	try {
		const inspector = new TaskInspector(
			f.store,
			() => {},
			() => {},
		);
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		inspector.renderPicker(100, 30);
		for (const ch of "typed") inspector.handleInput(ch);
		const picker = inspector.renderPicker(100, 40).map((line) => stripVTControlCharacters(line).trimEnd());
		assert.equal(picker.length, 12);
		assert.ok(picker.some((line) => /│ ❯ typed/.test(line)));
		assert.ok(picker.some((line) => /╰─+╯$/.test(line)));
		assert.doesNotMatch(picker.join("\n"), /1-4 choose/);
		assert.equal(picker.at(-1)?.trim(), "↑↓ select · enter send · esc close");
		assert.ok(!picker.some((line) => /5 E/.test(line)));

		for (let i = 0; i < 5; i++) inspector.handleInput("\x7f");
		inspector.handleInput("5");
		const afterClippedDigit = inspector.renderPicker(100, 40).map((line) => stripVTControlCharacters(line).trimEnd());
		assert.match(afterClippedDigit.join("\n"), /│ ❯ 5/);
		assert.doesNotMatch(afterClippedDigit.join("\n"), /│ ❯ E/);
		inspector.handleInput("\x7f");
		inspector.handleInput("4");
		const afterValidDigit = inspector.renderPicker(100, 40).map((line) => stripVTControlCharacters(line).trimEnd());
		assert.ok(afterValidDigit.some((line) => /│ ❯ D\b/.test(line)));

		inspector.handleInput(ESC);
		inspector.handleInput("/");
		for (const ch of "ralph") inspector.handleInput(ch);
		inspector.handleInput(ENTER);
		inspector.handleInput(SPACE);
		inspector.handleInput("\x7f");
		const filteredPicker = inspector.renderPicker(100, 40).map((line) => stripVTControlCharacters(line).trimEnd());
		assert.ok(filteredPicker.some((line) => /1-3 choose/.test(line)));
		inspector.handleInput("4");
		assert.match(inspector.renderPicker(100, 40).map(stripVTControlCharacters).join("\n"), /│ ❯ 4/);
		inspector.handleInput("\x7f");
		inspector.handleInput("2");
		failNext = true;
		inspector.handleInput(ENTER);
		await flush();
		const filteredWithNotice = inspector
			.renderPicker(100, 40)
			.map((line) => stripVTControlCharacters(line).trimEnd());
		assert.equal(filteredWithNotice.length, 12);
		assert.ok(filteredWithNotice.some((line) => /⌕ ralph/.test(line)));
		assert.ok(filteredWithNotice.some((line) => /Could not send the answer: offline/.test(line)));
		assert.ok(filteredWithNotice.some((line) => /│ ❯ B\b/.test(line)));
		assert.ok(filteredWithNotice.some((line) => /╰─+╯$/.test(line)));
		assert.doesNotMatch(filteredWithNotice.join("\n"), /1-2 choose/);
		assert.equal(filteredWithNotice.at(-1)?.trim(), "↑↓ select · enter send · esc close");

		const shortReply = inspector.renderViewport(100, 6).map((line) => stripVTControlCharacters(line).trimEnd());
		assert.ok(shortReply.some((line) => /│ ❯ B\b/.test(line)));
		assert.ok(shortReply.some((line) => /╰─+╯$/.test(line)));

		holdSend = true;
		inspector.handleInput(ENTER);
		const sendingPicker = inspector.renderPicker(100, 40).map((line) => stripVTControlCharacters(line).trimEnd());
		assert.ok(sendingPicker.some((line) => /│ Sending…/.test(line)));
		assert.ok(sendingPicker.some((line) => /╰─+╯$/.test(line)));
		const shortSending = inspector.renderViewport(100, 4).map((line) => stripVTControlCharacters(line).trimEnd());
		assert.ok(shortSending.some((line) => /│ Sending…/.test(line)));
		assert.ok(shortSending.some((line) => /╰─+╯$/.test(line)));
		releaseSend();
		await flush();
		assert.deepEqual(answered, [
			["run:ralph", "B"],
			["run:ralph", "B"],
		]);
		inspector.dispose();
	} finally {
		await f.dispose();
	}
});

test("a peek card with 10 choices draws all 9 digit choices in a tall viewport and accepts digits 8 and 9 (#5224)", async () => {
	const choices = Array.from({ length: 10 }, (_, index) => `choice-${index + 1}`);
	const { source, answered } = runSource(
		() => [waiting("run:nine", choices)],
		async () => ({ ok: true }),
	);
	const f = heldFixture();
	try {
		const inspector = new TaskInspector(
			f.store,
			() => {},
			() => {},
		);
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		const tall = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line).trimEnd())
			.join("\n");
		assert.match(tall, /│ 8 choice-8\b/);
		assert.match(tall, /│ 9 choice-9\b/);
		assert.doesNotMatch(tall, /10 choice-10/);
		assert.match(tall, /1-9 choose/);
		inspector.handleInput("9");
		const afterNine = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line).trimEnd())
			.join("\n");
		assert.match(afterNine, /│ ❯ choice-9\b/);
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(answered, [["run:nine", "choice-9"]]);
		inspector.dispose();
	} finally {
		await f.dispose();
	}
});

test("a rejected boardSource.answer shows a failure notice, preserves the typed reply, and allows retrying (#5224)", async () => {
	let attempts = 0;
	let rejectFirst!: (reason?: unknown) => void;
	const { source, answered } = runSource(
		() => [waiting("run:ralph", ["Yes", "No"])],
		async () => {
			attempts++;
			if (attempts === 1) {
				await new Promise<void>((_, reject) => {
					rejectFirst = reject;
				});
			}
			return { ok: true };
		},
	);
	const f = heldFixture();
	try {
		const inspector = new TaskInspector(
			f.store,
			() => {},
			() => {},
		);
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		inspector.renderViewport(100, 24);
		inspector.handleInput("1");
		inspector.handleInput(ENTER);
		rejectFirst(new Error("transport disconnected"));
		await flush();
		const afterFailure = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(afterFailure, /Could not send the answer: transport disconnected/);
		assert.match(afterFailure, /│ ❯ Yes/);
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(answered, [
			["run:ralph", "Yes"],
			["run:ralph", "Yes"],
		]);
		const afterRetry = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(afterRetry, /Sent to ralph/);
		inspector.dispose();
	} finally {
		await f.dispose();
	}
});

test("clearing a notice does not activate a choice that was not drawn in the last picker frame (#5224)", async () => {
	const items = [
		waiting("run:question", ["A", "B", "C", "D", "E"]),
		{ ...waiting("run:working", []), state: "running" as const },
	];
	const { source } = runSource(
		() => items,
		async () => ({ ok: true }),
	);
	let releaseStop!: () => void;
	source.stop = () =>
		new Promise((resolve) => {
			releaseStop = () => resolve({ ok: false, reason: "offline" });
		});
	const f = heldFixture();
	const inspector = new TaskInspector(
		f.store,
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource(source);
		inspector.handleInput(DOWN);
		inspector.handleInput("x");
		inspector.handleInput("x");
		inspector.handleInput(UP);
		inspector.handleInput(SPACE);
		releaseStop();
		await flush();
		const before = stripVTControlCharacters(inspector.renderPicker(100, 40).join("\n"));
		assert.match(before, /1-3 choose/);
		assert.doesNotMatch(before, /│ 4 D/);
		inspector.handleInput("4");
		const after = stripVTControlCharacters(inspector.renderPicker(100, 40).join("\n"));
		assert.doesNotMatch(after, /│ ❯ D\b/);
	} finally {
		inspector.dispose();
		await f.dispose();
	}
});
