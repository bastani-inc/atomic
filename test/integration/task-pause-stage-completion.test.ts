import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { Cleanup, OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskLease, TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { createStageSkillFixture } from "../fixtures/stage-chat-skill-session.js";

type StageGenerationSession = AgentSession & { closeWorkflowStageGeneration(): Promise<void> };

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

function bindStageAdmission(session: AgentSession, runId: string, stageId: string): WorkflowStageAdmissionBoundary {
	const boundary = new WorkflowStageAdmissionBoundary();
	const internal = session as AgentSession & { _workflowStageAdmission?: WorkflowStageAdmissionBoundary };
	internal._workflowStageAdmission = boundary;
	boundary.bindTaskIdentity(session.sessionManager.getSessionId(), runId, stageId);
	return boundary;
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
	"paused stage generation closes and disposes without resume after owned work is cancelled",
	async () => {
		const fixture = await createStageSkillFixture();
		const sibling = await createStageSkillFixture();
		bindStageAdmission(fixture.stage.session, fixture.runId, fixture.stageId);
		bindStageAdmission(sibling.stage.session, sibling.runId, sibling.stageId);
		const pidFile = join(fixture.directory, "paused-complete.pid");
		const siblingPidFile = join(sibling.directory, "paused-complete-sibling.pid");
		try {
			const shell = await startBackgroundShell(
				fixture.stage.session,
				`printf $$ > ${quote(pidFile)}; read value; printf 'SHOULD BE CANCELLED\\n'`,
				"Paused stage remaining shell",
			);
			const siblingShell = await startBackgroundShell(
				sibling.stage.session,
				`printf $$ > ${quote(siblingPidFile)}; read value; printf 'SIBLING STAYS\\n'`,
				"Sibling remaining shell",
			);
			const pid = await waitPid(pidFile);
			const siblingPid = await waitPid(siblingPidFile);
			await fixture.handle.pause();
			assert.equal(fixture.stage.session.queuedMessagesPaused, true);
			assert.equal(alive(pid), false);
			const waiting = shell.supervisor.waitForTask(shell.lease);
			await (fixture.stage.session as StageGenerationSession).closeWorkflowStageGeneration();
			const settled = await waiting;
			assert.ok(settled.ok && settled.value.kind === "settled", JSON.stringify(settled));
			assert.equal(settled.value.result.kind, "cancelled");
			assert.equal(settled.value.result.kind === "cancelled" && settled.value.result.cause, "user");
			await vi.waitFor(() => assert.equal(alive(pid), false));
			assert.equal(executionKind(siblingShell.host, siblingShell.taskId), "running");
			assert.equal(alive(siblingPid), true, "paused stage completion must not cancel a sibling");
			assert.equal(fixture.stage.session.queuedMessagesPaused, true, "generation close must not require resume");
			fixture.stage.session.dispose();
		} finally {
			await fixture.cleanup();
			await sibling.cleanup();
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

test.runIf(process.platform !== "win32")(
	"workflow-node pause cancels owned shells, preserves siblings, and permits fresh work on resume",
	async () => {
		const fixture = await createStageSkillFixture();
		const sibling = await createStageSkillFixture();
		const boundary = bindStageAdmission(fixture.stage.session, fixture.runId, fixture.stageId);
		bindStageAdmission(sibling.stage.session, sibling.runId, sibling.stageId);
		const pidFile = join(fixture.directory, "stage-paused-shell.pid");
		const siblingPidFile = join(sibling.directory, "sibling-shell.pid");
		const responseStarted = Promise.withResolvers<void>();
		const finishResponse = Promise.withResolvers<void>();
		try {
			const shell = await startBackgroundShell(
				fixture.stage.session,
				`printf $$ > ${quote(pidFile)}; read value; printf 'STAGE STOPPED\n'`,
				"Stage pause shell",
			);
			const siblingShell = await startBackgroundShell(
				sibling.stage.session,
				`printf $$ > ${quote(siblingPidFile)}; read value; printf 'SIBLING SURVIVED\\n'`,
				"Sibling stage shell",
			);
			const pid = await waitPid(pidFile);
			const siblingPid = await waitPid(siblingPidFile);
			await fixture.handle.pause();
			assert.equal(alive(pid), false, "completed stage pause must reap owned background shells");
			assert.equal(alive(siblingPid), true);
			assert.equal(executionKind(shell.host, shell.taskId), "settled");
			const result = await shell.supervisor.waitForTask(shell.lease);
			assert.ok(result.ok && result.value.kind === "settled");
			assert.equal(result.value.result.kind, "cancelled");
			assert.equal(shell.host.resolveTask(shell.taskId).ok, true);
			await assert.rejects(startBackgroundShell(fixture.stage.session, "printf REFUSED", "Paused launch"), /paused/);
			fixture.stage.setResponses([
				async () => {
					responseStarted.resolve();
					await finishResponse.promise;
					return fauxAssistantMessage("Resumed stage work complete");
				},
			]);
			await fixture.handle.resume();
			await responseStarted.promise;
			assert.equal(boundary.isOpen(), true);
			assert.equal(fixture.stage.session.queuedMessagesPaused, false);
			assert.equal(alive(siblingPid), true);
			const fresh = await startBackgroundShell(
				fixture.stage.session,
				"read value; printf FRESH",
				"Fresh after resume",
			);
			assert.notEqual(fresh.taskId, shell.taskId);
			assert.equal((await completeShell(fresh.supervisor, fresh.lease)).kind, "completed");
			assert.equal(executionKind(shell.host, shell.taskId), "settled", "resume never revives cancelled executions");
			finishResponse.resolve();
			await (fixture.stage.session as StageGenerationSession).closeWorkflowStageGeneration();
			assert.equal(executionKind(siblingShell.host, siblingShell.taskId), "running");
			assert.equal(alive(siblingPid), true, "completing one stage must not cancel a sibling stage owner");
			const siblingWait = siblingShell.supervisor.waitForTask(siblingShell.lease);
			await (sibling.stage.session as StageGenerationSession).closeWorkflowStageGeneration();
			const siblingResult = await siblingWait;
			assert.ok(siblingResult.ok && siblingResult.value.kind === "settled", JSON.stringify(siblingResult));
			assert.equal(siblingResult.value.result.kind, "cancelled");
			assert.equal(
				siblingResult.value.result.kind === "cancelled" && siblingResult.value.result.cause,
				"owner-close",
			);
			await vi.waitFor(() => assert.equal(alive(siblingPid), false));
		} finally {
			finishResponse.resolve();
			await fixture.cleanup();
			await sibling.cleanup();
		}
	},
);

test("closing one workflow-stage admission cancels only that owner's remaining tasks", async () => {
	const first = new WorkflowStageAdmissionBoundary();
	const second = new WorkflowStageAdmissionBoundary();
	first.bindTaskIdentity("session-a", "run-a", "stage-a");
	second.bindTaskIdentity("session-b", "run-b", "stage-b");
	const hostA = first.bindAgentTaskHost({ authorizeLaunch() {} });
	const hostB = second.bindAgentTaskHost({ authorizeLaunch() {} });
	const resultA = Promise.withResolvers<TaskResult>();
	const resultB = Promise.withResolvers<TaskResult>();
	try {
		const startedA = await hostA.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Stage A" },
			randomUUID() as OperationId,
			(context) => {
				listenForOwnerClose(context, resultA);
				return { result: resultA.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) };
			},
		);
		const startedB = await hostB.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Stage B" },
			randomUUID() as OperationId,
			(context) => {
				listenForOwnerClose(context, resultB);
				return { result: resultB.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) };
			},
		);
		assert.ok(startedA.ok && startedB.ok);
		assert.ok((await hostA.observeAgentLaunch(startedA.value.taskId, { kind: "background" })).ok);
		assert.ok((await hostB.observeAgentLaunch(startedB.value.taskId, { kind: "background" })).ok);
		const waitingA = hostA.waitForTask(startedA.value.taskId);
		await first.close();
		const closedA = await waitingA;
		assert.ok(closedA.ok && closedA.value.kind === "settled", JSON.stringify(closedA));
		assert.equal(closedA.value.result.kind, "cancelled");
		assert.equal(closedA.value.result.kind === "cancelled" && closedA.value.result.cause, "owner-close");
		assert.equal(executionKind(hostB, startedB.value.taskId), "running");
		resultB.resolve({
			kind: "completed",
			output: {
				ownerId: hostB.ownerBinding.supervisor.taskReference(startedB.value.lease).ownerId,
				taskId: startedB.value.taskId,
				artifactId: "result",
				byteCount: "0",
				omittedRanges: [],
			},
		});
		const finishedB = await hostB.waitForTask(startedB.value.taskId);
		assert.ok(finishedB.ok && finishedB.value.kind === "settled");
		assert.equal(finishedB.value.result.kind, "completed");
		assert.equal(finishedB.value.taskId, startedB.value.taskId);
	} finally {
		resultA.resolve({ kind: "cancelled", cause: "user" });
		resultB.resolve({ kind: "cancelled", cause: "user" });
		await second.close();
	}
});

test("stage pause cancels queued agents before active slots free, awaits cleanup, and preserves queued messages", async () => {
	const fixture = await createStageSkillFixture();
	const boundary = bindStageAdmission(fixture.stage.session, fixture.runId, fixture.stageId);
	const host = fixture.stage.session.getAgentTaskHost();
	const mainHost = fixture.main.session.getAgentTaskHost();
	const cleanup = Promise.withResolvers<Cleanup>();
	const never = Promise.withResolvers<TaskResult>();
	const queued: Array<() => Promise<void>> = [];
	const responseStarted = Promise.withResolvers<void>();
	const finishResponse = Promise.withResolvers<void>();
	let queuedStarts = 0;
	let activeSignal: AbortSignal | undefined;
	let mainSignal: AbortSignal | undefined;
	try {
		const active = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Active stage agent" },
			randomUUID() as OperationId,
			({ signal }) => {
				activeSignal = signal;
				// Releasing a slot immediately on abort must not start admitted queued agents.
				signal.addEventListener(
					"abort",
					() => {
						for (const dispatch of queued) void dispatch();
					},
					{ once: true },
				);
				return { result: never.promise, cleanup: cleanup.promise };
			},
		);
		assert.ok(active.ok);
		for (let index = 0; index < 2; index++) {
			const admitted = await host.startAgentTask(
				{ kind: "agent", agent: "worker", task: `Queued stage agent ${index}` },
				randomUUID() as OperationId,
				() => {
					queuedStarts++;
					return { result: never.promise, cleanup: cleanup.promise };
				},
				(dispatch) => queued.push(dispatch),
			);
			assert.ok(admitted.ok);
			assert.equal(executionKind(host, admitted.value.taskId), "queued");
		}
		const main = await mainHost.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Unrelated main agent" },
			randomUUID() as OperationId,
			({ signal }) => {
				mainSignal = signal;
				return { result: never.promise, cleanup: Promise.resolve({ kind: "reaped" }) };
			},
		);
		assert.ok(main.ok);
		await fixture.stage.session.followUp("user queued before pause");
		let paused = false;
		const pause = fixture.handle.pause().then(() => {
			paused = true;
		});
		assert.equal(activeSignal?.aborted, true);
		await fixture.stage.session.sendCustomMessage(
			{ customType: "intercom", content: "Intercom held during pause", display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		await fixture.stage.session.followUp("user queued during pause");
		assert.equal(paused, false, "abort is not cleanup evidence");
		assert.equal(queuedStarts, 0);
		assert.equal(mainSignal?.aborted, false);
		await assert.rejects(
			host.startAgentTask({ kind: "agent", agent: "worker", task: "Refused" }, randomUUID() as OperationId, () => {
				throw new Error("paused runner reached");
			}),
			/paused/,
		);
		cleanup.resolve({ kind: "reaped" });
		await pause;
		assert.equal(boundary.isOpen(), true, "pause must not seal the stage message generation");
		const watched = host.watchOwnerTasks();
		assert.ok(watched.ok);
		assert.equal(watched.value.snapshot.state, "open");
		assert.equal(watched.value.snapshot.tasks.length, 3);
		assert.ok(
			watched.value.snapshot.tasks.every(
				(task) =>
					task.execution.kind === "settled" &&
					task.execution.result.kind === "cancelled" &&
					task.cleanup.kind === "reaped",
			),
		);
		watched.value.dispose();
		assert.deepEqual(fixture.stage.session.getFollowUpMessages(), [
			"user queued before pause",
			"user queued during pause",
		]);
		fixture.stage.setResponses([
			async () => {
				responseStarted.resolve();
				await finishResponse.promise;
				return fauxAssistantMessage("Queued message handled");
			},
			...Array.from({ length: 5 }, () => fauxAssistantMessage("Queued message handled")),
		]);
		const resume = fixture.handle.resume();
		await responseStarted.promise;
		// Keep the resumed objective live until fresh launch authorization is exercised.
		const replay = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Fresh resumed agent" },
			randomUUID() as OperationId,
			() => ({ result: never.promise, cleanup: Promise.resolve({ kind: "reaped" }) }),
		);
		assert.ok(replay.ok);
		assert.equal(executionKind(host, replay.value.taskId), "running");
		finishResponse.resolve();
		await resume;
		await vi.waitFor(() => {
			assert.ok(fixture.userTexts().includes("user queued before pause"));
			assert.ok(fixture.userTexts().includes("user queued during pause"));
			assert.ok(
				fixture.stage.session.messages.some(
					(message) =>
						message.role === "custom" &&
						message.customType === "intercom" &&
						message.content === "Intercom held during pause",
				),
			);
		});
		assert.equal(queuedStarts, 0, "resume never resurrects queued executions");
		assert.equal(mainSignal?.aborted, false);
	} finally {
		finishResponse.resolve();
		cleanup.resolve({ kind: "reaped" });
		await mainHost.close("session-close");
		await fixture.cleanup();
	}
});
