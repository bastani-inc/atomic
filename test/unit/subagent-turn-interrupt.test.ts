import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { nextTurnSettled } from "../../packages/subagents/src/runs/inprocess/runner.js";
import type { TaskExecutionHooks, TestSessionQueue } from "../../packages/subagents/src/shared/types.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

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

const CONDITION_WAIT_MS = 20_000;

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + CONDITION_WAIT_MS;
	while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), "condition never held");
}

function launch(root: string, signal: AbortSignal) {
	const gate = Promise.withResolvers<void>();
	let source: TaskTranscriptSource | undefined;
	let queue: TestSessionQueue | undefined;
	const hooks: TaskExecutionHooks = {
		signal,
		reportActivity() {},
		bindTranscript(bound) {
			source = bound;
		},
		onExecution() {},
		yieldTaskWait() {},
		isParentObserving: () => false,
	};
	let settled = false;
	const result = runSingleInProcess(root, agent(), "fix the picker", {
		cwd: root,
		runId: `interrupt-${Math.random().toString(36).slice(2)}`,
		sessionDir: root,
		taskExecution: hooks,
		signal,
		testSession: {
			output: "picker fixed",
			promptGate: gate.promise,
			abortResolvesPrompt: true,
			abortEndsTurnOnly: true,
			onSession(stub) {
				queue = stub;
			},
		},
	}).finally(() => {
		settled = true;
	});
	return {
		gate,
		result,
		settled: () => settled,
		source: () => source,
		queue: () => queue,
	};
}

test("Esc interrupts a subagent's turn and it waits for the next message in the same session (#5224)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-turn-interrupt-"));
	clearSubagentControls();
	try {
		const child = launch(root, new AbortController().signal);
		await until(() => child.source()?.isRunning?.() === true);
		const source = child.source()!;
		const sessionId = source.getSessionId();
		assert.equal(typeof source.interruptTurn, "function", "a running subagent's chat can interrupt its turn");

		await source.interruptTurn!();
		await until(() => source.isRunning?.() === false);
		assert.equal(child.settled(), false, "the child did not end: it waits for the next message");

		// The next message the reader sends starts a turn on the same session, which then finishes the task.
		child.gate.resolve();
		await child.queue()!.prompt("carry on with the picker");
		const result = await child.result;
		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, "picker fixed");
		assert.equal(source.getSessionId(), sessionId, "the child kept its session");
		const history = (await source.loadHistory?.())?.entries ?? source.getEntries();
		const userTexts = history.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [String(entry.message.content)] : [],
		);
		assert.deepEqual(userTexts, ["fix the picker", "carry on with the picker"]);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an interrupted subagent that is never messaged again still stops when asked (#5224)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-turn-interrupt-stop-"));
	clearSubagentControls();
	const stop = new AbortController();
	try {
		const child = launch(root, stop.signal);
		await until(() => child.source()?.isRunning?.() === true);
		await child.source()!.interruptTurn!();
		await until(() => child.source()?.isRunning?.() === false);
		assert.equal(child.settled(), false);
		stop.abort("user");
		const result = await child.result;
		assert.notEqual(result.status, "ok", "a stop ends the waiting child");
		assert.equal(child.settled(), true);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("interrupting the next subagent turn also waits for another message before settling (#5224)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-turn-interrupt-twice-"));
	const stop = new AbortController();
	const child = launch(root, stop.signal);
	try {
		await until(() => child.source()?.isRunning?.() === true);
		const source = child.source()!;
		await source.interruptTurn!();
		await until(() => source.isRunning?.() === false);
		const firstWake = child.queue()!.prompt("continue once");
		await until(() => source.isRunning?.() === true);
		await source.interruptTurn!();
		await firstWake;
		assert.equal(child.settled(), false, "the second interrupted turn still waits");
		child.gate.resolve();
		await child.queue()!.prompt("finish now");
		const result = await child.result;
		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, "picker fixed");
	} finally {
		stop.abort("user");
		await child.result;
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

/** A live child loads its real resources; that load is the structural cost of this test. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

test(
	"a live subagent interrupted from its chat stays open to a message that starts its next turn (#5224)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("resumed after the interrupt"),
		]);
		let source: TaskTranscriptSource | undefined;
		const hooks: TaskExecutionHooks = {
			signal: new AbortController().signal,
			reportActivity() {},
			bindTranscript(bound) {
				source = bound;
			},
			onExecution() {},
			yieldTaskWait() {},
			isParentObserving: () => false,
		};
		let settled = false;
		const run = runSingleInProcess(env.root, agent(), "run until stopped", {
			...env.options("interrupt-live", { taskExecution: hooks }),
		}).finally(() => {
			settled = true;
		});
		await until(() => env.blockStarted());
		const sessionId = source!.getSessionId();
		await source!.interruptTurn!();
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, "the interrupted child waits instead of ending");
		assert.equal(source!.isRunning?.(), false);
		// An Intercom message reaches an idle child as a custom message that starts a turn.
		const session = source!.chatSession as unknown as AgentSession;
		await session.sendCustomMessage(
			{ customType: "intercom", content: "carry on", display: true },
			{ triggerTurn: true },
		);
		const result = await run;
		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, "resumed after the interrupt");
		assert.equal(source!.getSessionId(), sessionId, "the same session continued");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test.each(["background work", "a queued message"] as const)(
	"an interrupted subagent settles when %s wakes it before the interrupted prompt returns (#5224)",
	async (wakeSource) => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-early-wake" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("the early wake finished"),
		]);
		let source: TaskTranscriptSource | undefined;
		const stop = new AbortController();
		let settled = false;
		const run = runSingleInProcess(env.root, agent(), "run until interrupted", {
			...env.options("interrupt-early-wake", {
				signal: stop.signal,
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(bound) {
						source = bound;
					},
					onExecution() {},
					yieldTaskWait() {},
					isParentObserving: () => false,
				},
			}),
		}).finally(() => {
			settled = true;
		});
		let unsubscribe: (() => void) | undefined;
		try {
			await until(() => env.blockStarted());
			const session = source!.chatSession as AgentSession;
			const wake = Promise.withResolvers<void>();
			if (wakeSource === "background work") {
				unsubscribe = session.subscribe((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribe?.();
					void session
						.sendCustomMessage(
							{ customType: "background-task", content: "the shell finished", display: true },
							{ triggerTurn: true },
						)
						.then(wake.resolve, wake.reject);
				});
			} else {
				await session.steer("finish the queued request");
				wake.resolve();
			}
			await source!.interruptTurn!();
			await wake.promise;
			await until(() => settled);
			const result = await run;
			assert.equal(result.status, "ok");
			assert.equal(result.finalOutput, "the early wake finished");
		} finally {
			unsubscribe?.();
			stop.abort("user");
			await run;
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"an interrupted subagent keeps a turn started by its settlement message drain running (#5224)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-before-drain" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("the first wake finished"),
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "drain" }, { id: "block-during-drain" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("the drained message was answered"),
		]);
		let source: TaskTranscriptSource | undefined;
		const stop = new AbortController();
		let settled = false;
		const run = runSingleInProcess(env.root, agent(), "run until interrupted", {
			...env.options("interrupt-message-drain", {
				signal: stop.signal,
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(bound) {
						source = bound;
					},
					onExecution() {},
					yieldTaskWait() {},
					isParentObserving: () => false,
				},
			}),
		}).finally(() => {
			settled = true;
		});
		let waking: Promise<void> | undefined;
		let unsubscribe: (() => void) | undefined;
		try {
			await until(() => env.blockStarted());
			const session = source!.chatSession as AgentSession;
			let ends = 0;
			let drainStarted = false;
			unsubscribe = session.subscribe((event) => {
				if (event.type === "agent_settled" && ++ends === 2)
					session.agent.steer({ role: "user", content: "answer the remaining message", timestamp: Date.now() });
				if (event.type === "tool_execution_start" && event.toolCallId === "block-during-drain") drainStarted = true;
			});
			await source!.interruptTurn!();
			await until(() => ends === 1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			waking = session.sendCustomMessage(
				{ customType: "background-task", content: "the shell finished", display: true },
				{ triggerTurn: true },
			);
			await until(() => drainStarted || settled);
			assert.equal(settled, false, "settlement does not stop the admitted continuation");
			assert.equal(drainStarted, true);
			assert.equal(source!.isRunning?.(), true);
			env.answers[0]({ content: [{ type: "text", text: "CI passed" }], details: undefined });
			await waking;
			const result = await run;
			assert.equal(result.status, "ok");
			assert.equal(result.finalOutput, "the drained message was answered");
		} finally {
			unsubscribe?.();
			stop.abort("user");
			for (const answer of env.answers) answer({ content: [{ type: "text", text: "stopped" }], details: undefined });
			await Promise.allSettled([run, waking]);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test("an interrupted subagent woken by its own work settles once that turn ends, even if agent_end comes before idle (#5224)", async () => {
	const listeners = new Set<(event: { type: string }) => void>();
	let streaming = false;
	const session = {
		get isStreaming() {
			return streaming;
		},
		subscribe(listener: (event: { type: string }) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const emit = (type: string) => {
		for (const listener of [...listeners]) listener({ type });
	};
	let done = false;
	const waiting = nextTurnSettled(session as never, [new AbortController().signal]).then(() => {
		done = true;
	});
	streaming = true;
	emit("agent_start");
	emit("agent_end");
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.equal(done, false, "the run is still closing");
	streaming = false;
	emit("agent_settled");
	await waiting;
	assert.equal(done, true, "the woken turn's end settles the child");
});
