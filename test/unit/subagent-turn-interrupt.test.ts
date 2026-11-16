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

async function until(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !predicate(); i++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
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
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		assert.equal(source.isRunning?.(), false, "the interrupted turn ended");
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
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
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

test("interruptTurn settles only once the interrupted turn has ended (#5224)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-turn-interrupt-settled-"));
	clearSubagentControls();
	try {
		const child = launch(root, new AbortController().signal);
		await until(() => child.source()?.isRunning?.() === true);
		const source = child.source()!;

		await source.interruptTurn!();
		assert.equal(source.isRunning?.(), false, "the interrupted turn ended before interruptTurn settled");
		assert.equal(child.settled(), false, "the child waits for the next message");

		child.gate.resolve();
		await child.queue()!.prompt("carry on with the picker");
		const result = await child.result;
		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, "picker fixed");
	} finally {
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
