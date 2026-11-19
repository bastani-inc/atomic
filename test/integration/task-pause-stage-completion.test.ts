import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskLease, TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

/** Only a stranded notice reaches this bound; a queued notice starts its turn immediately. */
const QUEUED_NOTICE_TURN_TIMEOUT_MS = 5_000;

function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitPid(path: string): Promise<number> {
	let pid = 0;
	await vi.waitFor(() => {
		try {
			pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		} catch {
			pid = 0;
		}
		assert.ok(Number.isInteger(pid) && pid > 0 && alive(pid));
	});
	return pid;
}

function listenForOwnerClose(context: { signal: AbortSignal }, result: PromiseWithResolvers<TaskResult>): void {
	const stop = () => result.resolve({ kind: "cancelled", cause: "owner-close" });
	if (context.signal.aborted) stop();
	else context.signal.addEventListener("abort", stop, { once: true });
}

async function startBackgroundShell(session: AgentSession, command: string, description: string) {
	const host = session.getAgentTaskHost();
	const { supervisor, owner } = host.ownerBinding;
	const started = await supervisor.startCommandTask(
		owner,
		{
			kind: "command",
			command,
			description,
			terminal: { kind: "pipe" },
			executionTimeoutMs: 15000,
		},
		randomUUID() as OperationId,
	);
	assert.ok(started.ok, started.ok ? undefined : JSON.stringify(started.error));
	const observation = await supervisor.initialObservation(started.value, { kind: "background" });
	assert.ok(observation.ok && observation.value.kind === "yielded", JSON.stringify(observation));
	return { host, supervisor, lease: started.value, taskId: observation.value.taskId };
}

async function completeShell(supervisor: TaskSupervisor, lease: TaskLease): Promise<TaskResult> {
	const stdin = supervisor.taskStdin(lease);
	assert.ok(stdin.ok);
	assert.ok(
		(
			await supervisor.writeTaskInput(stdin.value, randomUUID() as OperationId, {
				kind: "bytes",
				bytes: Buffer.from("go\n"),
			})
		).ok,
	);
	const settled = await supervisor.waitForTask(lease);
	assert.ok(settled.ok && settled.value.kind === "settled", JSON.stringify(settled));
	return settled.value.result;
}

function executionKind(host: AgentTaskHost, taskId: string) {
	const watched = host.watchOwnerTasks();
	assert.ok(watched.ok);
	try {
		return watched.value.snapshot.tasks.find((task) => task.ref.taskId === taskId)?.execution.kind;
	} finally {
		watched.value.dispose();
	}
}

test.runIf(process.platform !== "win32")(
	"main chat pause leaves a background shell and agent running with the same identities",
	async () => {
		const harness = await createHarness();
		const pidFile = join(harness.tempDir, "paused-shell.pid");
		const agentResult = Promise.withResolvers<TaskResult>();
		const host = harness.session.getAgentTaskHost();
		try {
			const shell = await startBackgroundShell(
				harness.session,
				`printf $$ > ${quote(pidFile)}; read value; printf 'MAIN PAUSE SURVIVED\\n'`,
				"Main pause shell",
			);
			const pid = await waitPid(pidFile);
			const agent = await host.startAgentTask(
				{ kind: "agent", agent: "worker", task: "Main pause agent" },
				randomUUID() as OperationId,
				(context) => {
					listenForOwnerClose(context, agentResult);
					return { result: agentResult.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) };
				},
			);
			assert.ok(agent.ok);
			assert.ok((await host.observeAgentLaunch(agent.value.taskId, { kind: "background" })).ok);
			harness.session.pauseQueuedMessages();
			await harness.session.abort();
			assert.equal(harness.session.queuedMessagesPaused, true);
			assert.equal(alive(pid), true, "paused main chat must not kill the background shell");
			assert.equal(executionKind(host, shell.taskId), "running");
			assert.equal(executionKind(host, agent.value.taskId), "running");
			const result = await completeShell(shell.supervisor, shell.lease);
			assert.equal(result.kind, "completed");
			assert.equal(alive(pid), false);
			const output = host.ownerBinding.supervisor.taskReference(shell.lease);
			agentResult.resolve({
				kind: "completed",
				output: {
					ownerId: output.ownerId,
					taskId: agent.value.taskId,
					artifactId: "result",
					byteCount: "0",
					omittedRanges: [],
				},
			});
			const agentWait = await host.waitForTask(agent.value.taskId);
			assert.ok(agentWait.ok && agentWait.value.kind === "settled");
			assert.equal(agentWait.value.taskId, agent.value.taskId);
			await harness.session.resumeQueuedMessages();
			await harness.session.agent.waitForIdle();
			assert.equal(host.resolveTask(shell.taskId).ok, true);
			assert.equal(host.resolveTask(agent.value.taskId).ok, true);
			assert.equal(executionKind(host, shell.taskId), "settled");
			assert.equal(executionKind(host, agent.value.taskId), "settled");
		} finally {
			agentResult.resolve({ kind: "cancelled", cause: "user" });
			await host.close("session-close");
			// Resume leaves an unconsumed protected model turn. That is teardown, not
			// generation close; dispose while still paused is covered separately.
			harness.faux.unregister();
			rmSync(harness.tempDir, { recursive: true, force: true });
		}
	},
);

test.runIf(process.platform !== "win32")(
	"main chat dispose while still paused after a background completion does not require resume",
	async () => {
		const harness = await createHarness();
		const pidFile = join(harness.tempDir, "paused-dispose.pid");
		const host = harness.session.getAgentTaskHost();
		try {
			const shell = await startBackgroundShell(
				harness.session,
				`printf $$ > ${quote(pidFile)}; read value; printf 'PAUSED COMPLETE\\n'`,
				"Paused main completion",
			);
			await waitPid(pidFile);
			harness.session.pauseQueuedMessages();
			await harness.session.abort();
			const result = await completeShell(shell.supervisor, shell.lease);
			assert.equal(result.kind, "completed");
			assert.equal(harness.session.queuedMessagesPaused, true);
			await host.close("session-close");
			harness.session.dispose();
		} finally {
			harness.faux.unregister();
			rmSync(harness.tempDir, { recursive: true, force: true });
		}
	},
);

test("a completion notice whose durable card is still being written when a paused session resumes starts its turn", async () => {
	const harness = await createHarness();
	const manager = harness.session.sessionManager;
	const append = manager.appendCustomMessageEntry.bind(manager);
	const appendStarted = Promise.withResolvers<void>();
	const finishAppend = Promise.withResolvers<void>();
	let turnStarted = false;
	try {
		harness.setResponses([
			() => {
				turnStarted = true;
				return fauxAssistantMessage("Saw the completion notice");
			},
		]);
		vi.spyOn(manager, "appendCustomMessageEntry").mockImplementationOnce(async (...args) => {
			appendStarted.resolve();
			await finishAppend.promise;
			return append(...args);
		});
		harness.session.pauseQueuedMessages();
		const delivery = harness.session.sendCustomMessage(
			{ customType: "task-completion", content: "Shell finished", display: true },
			{ triggerTurn: true, persistWhenStreaming: true, stageAdmissionKey: "notice-completion" },
		);
		await appendStarted.promise;
		assert.equal(await harness.session.resumeQueuedMessages(), false, "the notice is not queued yet");
		finishAppend.resolve();
		await delivery;
		await vi.waitFor(() => assert.equal(turnStarted, true), { timeout: QUEUED_NOTICE_TURN_TIMEOUT_MS });
		await harness.session.agent.waitForIdle();
	} finally {
		finishAppend.resolve();
		await harness.cleanup();
	}
});
