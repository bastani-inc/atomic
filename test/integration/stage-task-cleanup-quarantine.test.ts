import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	isRetryableTaskError,
	isTaskCleanupAdmissionTimeoutError,
	isTaskCleanupError,
	SessionManager,
	type TaskCleanupError,
} from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session-types.js";
import { withResourceAdmission } from "../../packages/coding-agent/src/core/resource-admission-scope.js";
import type { ResourceAdmission, ResourcePermit } from "../../packages/coding-agent/src/core/sdk-types.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { OperationId, ResourceFailure, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { QUARANTINED_ADMISSION_WAIT_MS } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
	isRetryableWorkflowError,
	ProcessCleanupUnconfirmedError,
	WorkflowInfrastructureError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import {
	fileExistsSync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	sleep,
	writeTextSync,
} from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

/** The native drain window (a 250 ms TERM grace plus a 2 s drain grace) and a real stage session cost this much. */
const DRAIN_WINDOW_TEST_TIMEOUT_MS = 60_000;
/** The drain window plus the native 15 s quarantine bound that must expire before cleanup fails for good. */
const QUARANTINE_BOUND_TEST_TIMEOUT_MS = 90_000;
/** Longer than the native 15 s bound a closing owner gives quarantined cleanup. */
const PAST_CLOSE_BOUND_MS = 16_000;
const PROCESS_EXIT_WAIT_MS = 10_000;
const QUARANTINE_OBSERVATION_MS = 250;

type Quarantine = Extract<AgentSessionEvent, { type: "task_cleanup_quarantined" }>;

interface Fixture {
	readonly dir: string;
	readonly result: Awaited<ReturnType<typeof run>>;
	readonly toolText: string;
	readonly toolIsError: boolean;
	readonly quarantines: readonly Quarantine[];
	readonly stageError: unknown;
	readonly sessionId: string;
	readonly backend: Awaited<ReturnType<typeof createMemoryTestBackend>>;
	readonly group: number;
	readonly holder: number | undefined;
}

/**
 * A bash command that leaves a holder in its own session, outside the command's process group, holding the output
 * pipe until `release` exists. The command prints a marker and exits with status 7 once the holder runs.
 */
function escapedHolderCommand(dir: string): string {
	return [
		`echo $$ > '${dir}/group'`,
		`setsid /bin/sh -c 'echo $$ > "$1"; while [ ! -e "$2" ]; do sleep 0.01; done' sh '${dir}/holder' '${dir}/release' &`,
		`while [ ! -s '${dir}/holder' ]; do sleep 0.01; done`,
		"echo LATE-CLEANUP-OUTPUT",
		"exit 7",
	].join("\n");
}

/** A bash command whose own group member stops itself while it holds the output pipe, then the shell exits. */
function stoppedMemberCommand(dir: string): string {
	return [
		`echo $$ > '${dir}/group'`,
		`/bin/sh -c 'echo $$ > "$1"; kill -STOP $$; sleep 30' sh '${dir}/member' &`,
		`while [ ! -s '${dir}/member' ]; do sleep 0.01; done`,
		"echo STOPPED-MEMBER-OUTPUT",
	].join("\n");
}

function pidFile(dir: string, name: string): number | undefined {
	const path = `${dir}/${name}`;
	return fileExistsSync(path) ? Number(readTextSync(path, "utf8").trim()) : undefined;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
		return false;
	}
}

async function waitForPidFile(dir: string, name: string): Promise<number> {
	const deadline = Date.now() + PROCESS_EXIT_WAIT_MS;
	for (;;) {
		const pid = pidFile(dir, name);
		if (pid !== undefined && pid > 0) return pid;
		assert.ok(Date.now() < deadline, `the command never recorded ${name}`);
		await sleep(10);
	}
}

async function waitUntilGone(pid: number): Promise<void> {
	const deadline = Date.now() + PROCESS_EXIT_WAIT_MS;
	while (processExists(pid)) {
		assert.ok(Date.now() < deadline, `process ${pid} outlived the test`);
		await sleep(10);
	}
}

/** Runs one workflow stage whose model makes one bash call with `command`, on a real session and task supervisor. */
async function runStage(
	command: (dir: string) => string,
	onQuarantine: (event: Quarantine, dir: string) => void = () => {},
	nextCommand?: (dir: string) => string,
): Promise<Fixture> {
	const dir = makeTempDirectory("atomic-stage-cleanup-");
	const store = createStore();
	const backend = await createMemoryTestBackend();
	const sessionManager = SessionManager.inMemory();
	const quarantines: Quarantine[] = [];
	let stage: Harness | undefined;
	let stageError: unknown;
	const definition = workflow({
		name: "stage-task-cleanup",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			try {
				await ctx.stage("work").prompt("Run the command.");
			} catch (error) {
				stageError = error;
				throw error;
			}
			return {};
		},
	});
	try {
		const result = await run(
			definition,
			{},
			{
				durableBackend: backend,
				store,
				adapters: {
					agentSession: {
						async create(options) {
							const harness = await createHarness({
								sessionManager,
								orchestrationContext: options.orchestrationContext,
								settings: { retry: { enabled: false } },
							});
							harness.setResponses([
								fauxAssistantMessage(fauxToolCall("bash", { command: command(dir) }), {
									stopReason: "toolUse",
								}),
								...(nextCommand === undefined
									? []
									: [
											fauxAssistantMessage(fauxToolCall("bash", { command: nextCommand(dir) }), {
												stopReason: "toolUse",
											}),
										]),
								fauxAssistantMessage("Done."),
							]);
							harness.session.subscribe((event) => {
								if (event.type !== "task_cleanup_quarantined") return;
								quarantines.push(event);
								onQuarantine(event, dir);
							});
							stage = harness;
							return harness.session as StageSessionRuntime;
						},
					},
				},
			},
		);
		assert.ok(stage);
		const toolResult = stage.session.messages.find((message) => message.role === "toolResult");
		assert.ok(toolResult && toolResult.role === "toolResult", "the stage made its bash call");
		const group = pidFile(dir, "group");
		assert.ok(group !== undefined, "the command recorded its process group");
		return {
			dir,
			result,
			toolText: toolResult.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
			toolIsError: toolResult.isError,
			quarantines,
			stageError,
			sessionId: sessionManager.getSessionId(),
			backend,
			group,
			holder: pidFile(dir, "holder"),
		};
	} catch (error) {
		// A stage that failed before returning its fixture must not leave the holder it started running.
		releaseHolder({ dir, holder: pidFile(dir, "holder") });
		throw error;
	} finally {
		await stage?.cleanup();
	}
}

/** No process is left in the command's group, and the holder this test created has exited. */
async function assertNoLeakedProcesses(fixture: Fixture): Promise<void> {
	assert.equal(processExists(-fixture.group), false, `process group ${fixture.group} survived the stage`);
	if (fixture.holder !== undefined) await waitUntilGone(fixture.holder);
}

function releaseHolder(fixture: Pick<Fixture, "dir" | "holder">): void {
	if (fixture.holder !== undefined && processExists(fixture.holder)) process.kill(fixture.holder, "SIGKILL");
	removeTempDirectory(fixture.dir);
}

test.runIf(process.platform === "linux")(
	"a bash call whose output a detached process keeps open past the drain window completes the stage with a cleanup warning (#4338)",
	async () => {
		const fixture = await runStage(escapedHolderCommand, (_event, dir) => writeTextSync(`${dir}/release`, ""));
		try {
			assert.match(fixture.toolText, /LATE-CLEANUP-OUTPUT/);
			assert.match(fixture.toolText, /Command exited with code 7/);
			assert.doesNotMatch(fixture.toolText, /CleanupFailed/);
			assert.equal(fixture.toolIsError, true, "a non-zero exit is reported as the command's own failure");
			assert.equal(fixture.result.status, "completed", fixture.result.error);
			const [stage] = fixture.result.stages;
			assert.equal(stage?.status, "completed");
			assert.deepEqual(
				fixture.quarantines.map((event) => event.resources),
				[
					[
						{
							resource: `process-group:${fixture.group}`,
							code: "CleanupUnconfirmed",
							message: "Output reader drain was not confirmed",
						},
					],
				],
			);
			const notices = (stage?.notices ?? []).filter((notice) => notice.kind === "cleanup");
			assert.deepEqual(
				notices.map(({ kind, to, meta }) => ({ kind, to, meta })),
				[
					{
						kind: "cleanup",
						to: "quarantined",
						meta: `${fixture.quarantines[0]!.taskId} process-group:${fixture.group}: Output reader drain was not confirmed`,
					},
				],
			);
			await assertNoLeakedProcesses(fixture);
		} finally {
			releaseHolder(fixture);
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"cleanup a stopped holder keeps unconfirmed fails the stage with a retryable process_cleanup_unconfirmed and keeps its turn (#4338)",
	async () => {
		const fixture = await runStage(escapedHolderCommand, (_event, dir) => {
			const holder = pidFile(dir, "holder");
			assert.ok(holder !== undefined);
			process.kill(holder, "SIGSTOP");
		});
		try {
			assert.match(fixture.toolText, /LATE-CLEANUP-OUTPUT/);
			assert.match(fixture.toolText, /Command exited with code 7/);
			assert.equal(fixture.quarantines.length, 1);
			assert.equal(fixture.result.status, "failed");
			const [stage] = fixture.result.stages;
			assert.equal(stage?.status, "failed");
			assert.equal(stage?.failureCode, "process_cleanup_unconfirmed");
			assert.deepEqual(
				{
					code: fixture.result.failure?.code,
					retryable: fixture.result.failure?.retryable,
					resumable: fixture.result.failure?.resumable,
					recoverability: fixture.result.failure?.recoverability,
				},
				{ code: "process_cleanup_unconfirmed", retryable: true, resumable: true, recoverability: "recoverable" },
			);
			const error = fixture.stageError;
			assert.ok(error instanceof ProcessCleanupUnconfirmedError, String(error));
			assert.ok(error instanceof WorkflowInfrastructureError);
			assert.equal(error.code, "process_cleanup_unconfirmed");
			assert.equal(isRetryableWorkflowError(error), true);
			assert.equal(isRetryableTaskError(error), true);
			assert.equal(error.phase, "stage-close");
			assert.equal(error.hint, error.cause.hint);
			assert.deepEqual(
				error.resources.map(({ resource, code }) => ({ resource, code })),
				[{ resource: `process-group:${fixture.group}`, code: "CleanupFailed" }],
			);
			assert.ok(isTaskCleanupError(error.cause));
			const cleanup: TaskCleanupError = error.cause;
			assert.equal(cleanup.phase, "stage-close");
			assert.deepEqual(
				cleanup.failures.map((failure) => failure.resources),
				[
					[
						{
							resource: `process-group:${fixture.group}`,
							code: "CleanupFailed",
							message: "Output reader drain was not confirmed",
						},
					],
				],
			);
			// The stage's saved session survives the failure, so a resume continues it after the bash call.
			assert.equal(
				fixture.backend.getStageSession(fixture.result.runId, "stage:work:1")?.sessionId,
				fixture.sessionId,
			);
			assert.equal(processExists(-fixture.group), false, `process group ${fixture.group} survived the stage`);
		} finally {
			releaseHolder(fixture);
		}
		if (fixture.holder !== undefined) await waitUntilGone(fixture.holder);
	},
	QUARANTINE_BOUND_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a stopped member of the command's own group is killed and the stage completes (#4338)",
	async () => {
		const fixture = await runStage(stoppedMemberCommand);
		try {
			assert.match(fixture.toolText, /STOPPED-MEMBER-OUTPUT/);
			assert.equal(fixture.toolIsError, false, fixture.toolText);
			assert.equal(fixture.result.status, "completed", fixture.result.error);
			assert.equal(fixture.result.stages[0]?.status, "completed");
			const member = pidFile(fixture.dir, "member");
			assert.ok(member !== undefined);
			await waitUntilGone(member);
			await assertNoLeakedProcesses(fixture);
		} finally {
			removeTempDirectory(fixture.dir);
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"a stage pause waits for quarantined command cleanup to be confirmed before it completes (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-pause-cleanup-");
		const quarantined: ResourceFailure[][] = [];
		let paused = false;
		let pausedAtQuarantine: boolean | undefined;
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: randomUUID() },
			authorizeLaunch() {},
			onTaskCleanupQuarantined(_ref, resources) {
				quarantined.push([...resources]);
				// Give a pause that ignored the quarantine time to finish before the holder lets cleanup confirm.
				setTimeout(() => {
					pausedAtQuarantine = paused;
					writeTextSync(`${dir}/release`, "");
				}, QUARANTINE_OBSERVATION_MS);
			},
		});
		const { supervisor, owner } = host.ownerBinding;
		try {
			const started = await supervisor.startCommandTask(
				owner,
				{
					kind: "command",
					command: escapedHolderCommand(dir).replace("exit 7", "exec sleep 30"),
					terminal: { kind: "pipe" },
				},
				randomUUID() as OperationId,
			);
			assert.ok(started.ok);
			const group = await waitForPidFile(dir, "group");
			await waitForPidFile(dir, "holder");
			await host.pauseTasks().then(() => {
				paused = true;
			});
			assert.equal(pausedAtQuarantine, false, "the pause completed while cleanup was still quarantined");
			assert.deepEqual(quarantined, [
				[
					{
						resource: `process-group:${group}`,
						code: "CleanupUnconfirmed",
						message: "Output reader drain was not confirmed",
					},
				],
			]);
			assert.equal(processExists(-group), false, `process group ${group} survived the pause`);
			const holder = pidFile(dir, "holder");
			assert.ok(holder !== undefined);
			await waitUntilGone(holder);
		} finally {
			const holder = pidFile(dir, "holder");
			if (holder !== undefined && processExists(holder)) process.kill(holder, "SIGKILL");
			const closed = await host.close("session-close");
			removeTempDirectory(dir);
			assert.ok(closed.ok, closed.ok ? "" : closed.error.message);
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"cleanup confirmed after the close bound would have expired, while the stage still runs, completes the stage (#4338)",
	async () => {
		let release: ReturnType<typeof setTimeout> | undefined;
		const fixture = await runStage(
			escapedHolderCommand,
			(_event, dir) => {
				release = setTimeout(() => {
					writeTextSync(`${dir}/release`, "");
					writeTextSync(`${dir}/released`, "");
				}, PAST_CLOSE_BOUND_MS);
			},
			(dir) => `while [ ! -e '${dir}/released' ]; do sleep 0.1; done; echo RELEASED`,
		);
		try {
			assert.match(fixture.toolText, /LATE-CLEANUP-OUTPUT/);
			assert.equal(fixture.quarantines.length, 1);
			assert.equal(fixture.result.status, "completed", fixture.result.error);
			assert.equal(fixture.result.stages[0]?.status, "completed");
			assert.deepEqual(
				(fixture.result.stages[0]?.notices ?? []).filter((notice) => notice.kind === "cleanup").map((n) => n.to),
				["quarantined"],
			);
			await assertNoLeakedProcesses(fixture);
		} finally {
			clearTimeout(release);
			releaseHolder(fixture);
		}
	},
	QUARANTINE_BOUND_TEST_TIMEOUT_MS,
);

const ADMISSION_SETTLE_HEADROOM_MS = 10_000;
const BLOCKED_LAUNCH_LIMIT_MS = QUARANTINED_ADMISSION_WAIT_MS + ADMISSION_SETTLE_HEADROOM_MS;
const QUARANTINE_EVENT_LIMIT_MS = DRAIN_WINDOW_TEST_TIMEOUT_MS / 4;
const TIMER_JITTER_MS = 50;
const PENDING_PROBE_MS = QUARANTINED_ADMISSION_WAIT_MS + 1_000;

class PermitAdmission implements ResourceAdmission {
	held = 0;
	acquired = 0;
	releaseCalls = 0;
	failure: Error | undefined;
	abortCleanup: (() => Promise<void>) | undefined;
	readonly signals: AbortSignal[] = [];
	private readonly waiters: Array<() => void> = [];
	constructor(private readonly limit: number) {}
	acquire(kind: "session" | "process", signal?: AbortSignal): Promise<ResourcePermit> {
		assert.equal(kind, "process");
		if (signal) this.signals.push(signal);
		if (signal?.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			if (this.failure) {
				const failure = this.failure;
				const timer = setTimeout(() => reject(failure), QUARANTINE_OBSERVATION_MS);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(signal.reason);
					},
					{ once: true },
				);
				return;
			}
			const grant = () => {
				this.held++;
				this.acquired++;
				let released = false;
				resolve(async () => {
					this.releaseCalls++;
					if (released) return;
					released = true;
					this.held--;
					this.waiters.shift()?.();
				});
			};
			if (this.held < this.limit) return grant();
			this.waiters.push(grant);
			signal?.addEventListener(
				"abort",
				() => {
					const index = this.waiters.indexOf(grant);
					if (index < 0) return;
					this.waiters.splice(index, 1);
					const cleanup = this.abortCleanup?.();
					if (cleanup) cleanup.then(() => reject(signal.reason), reject);
					else reject(signal.reason);
				},
				{ once: true },
			);
		});
	}
}

function within<T>(promise: Promise<T>, limitMs: number, failure: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(failure)), limitMs);
	});
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function blockedLaunchSignal(...others: AbortSignal[]): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(BLOCKED_LAUNCH_LIMIT_MS), ...others]);
}

function settle(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
}

function holderHost(dir: string, admission?: ResourceAdmission, onQuarantine?: (taskId: TaskId) => void) {
	let reportQuarantine!: (taskId: TaskId) => void;
	const quarantined = within(
		new Promise<TaskId>((resolve) => {
			reportQuarantine = resolve;
		}),
		QUARANTINE_EVENT_LIMIT_MS,
		"the first command's cleanup was never quarantined",
	);
	quarantined.catch(() => undefined);
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: randomUUID() },
		authorizeLaunch() {},
		resourceAdmission: admission,
		onTaskCleanupQuarantined: (ref) => {
			reportQuarantine(ref.taskId);
			onQuarantine?.(ref.taskId);
		},
	});
	const { supervisor, owner } = host.ownerBinding;
	const launch = (command: string, signal?: AbortSignal) => {
		const guard = new AbortController();
		const timeout = setTimeout(
			() => guard.abort(new Error("the command admission exceeded its test guard")),
			BLOCKED_LAUNCH_LIMIT_MS,
		);
		return supervisor
			.startCommandTask(
				owner,
				{ kind: "command", command, terminal: { kind: "pipe" } },
				randomUUID() as OperationId,
				signal ? AbortSignal.any([signal, guard.signal]) : guard.signal,
			)
			.finally(() => clearTimeout(timeout));
	};
	const ready = launch(escapedHolderCommand(dir)).then(async (first) => {
		assert.ok(first.ok, "the first command was admitted");
		await waitForPidFile(dir, "holder");
	});
	const cleanup = async () => {
		await settle(ready);
		const holder = pidFile(dir, "holder");
		if (holder !== undefined && processExists(holder)) process.kill(holder, "SIGKILL");
		const closed = await host.close("session-close");
		removeTempDirectory(dir);
		assert.ok(closed.ok, closed.ok ? "" : closed.error.message);
	};
	return { host, ready, quarantined, launch, cleanup };
}

function assertTimedOutBehind(
	error: unknown,
	taskId: TaskId,
	options: { maximumElapsedMs?: number; cause?: Error } = {},
): void {
	assert.ok(isTaskCleanupAdmissionTimeoutError(error), String(error));
	assert.equal(error.phase, "command-admission");
	assert.equal(error.timeoutMs, QUARANTINED_ADMISSION_WAIT_MS);
	assert.ok(error.elapsedMs >= QUARANTINED_ADMISSION_WAIT_MS - TIMER_JITTER_MS, String(error.elapsedMs));
	assert.equal(error.cause, options.cause);
	if (options.maximumElapsedMs !== undefined)
		assert.ok(error.elapsedMs <= options.maximumElapsedMs + TIMER_JITTER_MS, String(error.elapsedMs));
	assert.equal(isRetryableTaskError(error), true);
	assert.deepEqual(
		error.failures.map((failure) => failure.taskId),
		[taskId],
	);
}

test.runIf(process.platform === "linux")(
	"a command whose admission only quarantined cleanup blocks times out with a TaskCleanupAdmissionTimeoutError and the held permit stays (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-quarantine-");
		const admission = new PermitAdmission(1);
		const { ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		try {
			await ready;
			const firstTaskId = await quarantined;
			assert.equal(admission.held, 1);
			const beganAt = performance.now();
			const error = await settle(launch("echo SECOND"));
			assertTimedOutBehind(error, firstTaskId, { maximumElapsedMs: performance.now() - beganAt });
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 0);
			assert.equal(admission.acquired, 1);

			writeTextSync(`${dir}/release`, "");
			const deadline = Date.now() + PROCESS_EXIT_WAIT_MS;
			while (admission.held > 0) {
				assert.ok(Date.now() < deadline, "the confirmed cleanup never released its permit");
				await sleep(10);
			}
			const third = await launch("echo THIRD");
			assert.ok(third.ok);
		} finally {
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"a command admission already waiting when the cleanup it waits behind is quarantined times out from the quarantine (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-prequarantine-");
		const admission = new PermitAdmission(1);
		const { ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		try {
			await ready;
			const waiting = settle(launch("echo SECOND"));
			assertTimedOutBehind(await waiting, await quarantined);
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 0);
		} finally {
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"a command can use free process capacity while an earlier command is quarantined (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-headroom-");
		const admission = new PermitAdmission(2);
		const { ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		try {
			await ready;
			await quarantined;
			const second = await launch(`while [ ! -e '${dir}/second-release' ]; do sleep 0.05; done; echo SECOND`);
			assert.ok(second.ok);
			assert.equal(admission.held, 2);
			assert.equal(admission.releaseCalls, 0);
		} finally {
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"an admission's own rejection while it waits behind quarantined cleanup reaches the caller unchanged (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-rejection-");
		const admission = new PermitAdmission(1);
		const { ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		try {
			await ready;
			await quarantined;
			admission.failure = new Error("admission pool unavailable");
			assert.equal(await settle(launch("echo SECOND")), admission.failure);
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 0);
		} finally {
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"a command waiting behind quarantined cleanup fails with the caller's cancellation, not the timeout (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-cancel-");
		const admission = new PermitAdmission(1);
		const { ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		try {
			await ready;
			await quarantined;
			const cancellation = new Error("caller cancelled the launch");
			const controller = new AbortController();
			const waiting = settle(launch("echo SECOND", blockedLaunchSignal(controller.signal)));
			await sleep(QUARANTINE_OBSERVATION_MS);
			controller.abort(cancellation);
			assert.equal(await waiting, cancellation);
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 0);
		} finally {
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"a command whose quarantined cleanup was reaped waits for live work however long without timing out (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-reaped-");
		const admission = new PermitAdmission(1);
		const { ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		try {
			await ready;
			await quarantined;
			writeTextSync(`${dir}/release`, "");
			const deadline = Date.now() + PROCESS_EXIT_WAIT_MS;
			while (admission.held > 0) {
				assert.ok(Date.now() < deadline, "the confirmed cleanup never released its permit");
				await sleep(10);
			}
			const live = launch(`while [ ! -e '${dir}/finish' ]; do sleep 0.05; done; echo LIVE`);
			const next = settle(launch("echo NEXT"));
			assert.ok((await live).ok, "the live command was admitted once the quarantined permit returned");
			const probe = await Promise.race([next, sleep(PENDING_PROBE_MS).then(() => "still waiting")]);
			assert.equal(probe, "still waiting", "live work holding the permit is waited for without a timeout");
			writeTextSync(`${dir}/finish`, "");
			assert.equal(await next, undefined, "the waiting command was admitted when the live one finished");
		} finally {
			writeTextSync(`${dir}/finish`, "");
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"a stage pause is not held up by a command admission waiting behind quarantined cleanup (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-pause-");
		const admission = new PermitAdmission(1);
		const { host, ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		try {
			await ready;
			const firstTaskId = await quarantined;
			const waiting = settle(launch("echo SECOND"));
			await within(
				host.pauseTasks(),
				BLOCKED_LAUNCH_LIMIT_MS,
				"the pause waited on an admission that could never be granted",
			);
			assertTimedOutBehind(await waiting, firstTaskId);
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 0);
		} finally {
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"caller cancellation during admission refusal cleanup preserves the caller's reason (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-refusal-cancel-");
		const admission = new PermitAdmission(1);
		const { ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		let reportRefusal!: () => void;
		const refused = new Promise<void>((resolve) => {
			reportRefusal = resolve;
		});
		let finishCleanup!: () => void;
		const cleanupFinished = new Promise<void>((resolve) => {
			finishCleanup = resolve;
		});
		const timers = vi.spyOn(globalThis, "setTimeout");
		try {
			await ready;
			await quarantined;
			admission.abortCleanup = async () => {
				reportRefusal();
				await cleanupFinished;
			};
			const controller = new AbortController();
			const waiting = settle(launch("echo SECOND", blockedLaunchSignal(controller.signal)));
			await within(refused, BLOCKED_LAUNCH_LIMIT_MS, "the admission was never refused");
			await sleep(QUARANTINE_OBSERVATION_MS);
			assert.equal(timers.mock.calls.filter(([, delay]) => delay === QUARANTINED_ADMISSION_WAIT_MS).length, 1);
			const cancellation = new Error("caller cancelled while admission cleanup was pending");
			controller.abort(cancellation);
			finishCleanup();
			assert.equal((await waiting) === cancellation, true, "the admission abort replaced the caller's cancellation");
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 0);
		} finally {
			timers.mockRestore();
			finishCleanup();
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"a pending admission gets a fresh bound when one quarantine reaps and another starts (#4338)",
	async () => {
		const firstDir = makeTempDirectory("atomic-admission-first-quarantine-");
		const nextDir = makeTempDirectory("atomic-admission-next-quarantine-");
		const admission = new PermitAdmission(1);
		let reportNext!: (event: { taskId: TaskId; at: number }) => void;
		const nextQuarantine = new Promise<{ taskId: TaskId; at: number }>((resolve) => {
			reportNext = resolve;
		});
		let reports = 0;
		const { ready, quarantined, launch, cleanup } = holderHost(firstDir, admission, (taskId) => {
			if (++reports === 2) reportNext({ taskId, at: performance.now() });
		});
		try {
			await ready;
			await quarantined;
			const next = launch(escapedHolderCommand(nextDir));
			const waiting = settle(launch("echo THIRD"));
			writeTextSync(`${firstDir}/release`, "");
			assert.ok((await next).ok);
			const event = await within(nextQuarantine, QUARANTINE_EVENT_LIMIT_MS, "the next cleanup never quarantined");
			const error = await waiting;
			const elapsedMs = performance.now() - event.at;
			assertTimedOutBehind(error, event.taskId);
			assert.ok(elapsedMs >= QUARANTINED_ADMISSION_WAIT_MS - TIMER_JITTER_MS, String(elapsedMs));
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 1);
		} finally {
			writeTextSync(`${nextDir}/release`, "");
			await cleanup();
			const holder = pidFile(nextDir, "holder");
			if (holder !== undefined) await waitUntilGone(holder);
			removeTempDirectory(nextDir);
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"a timeout keeps the admission's distinct cleanup rejection as its cause (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-refusal-cause-");
		const admission = new PermitAdmission(1);
		const { ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		try {
			await ready;
			const firstTaskId = await quarantined;
			const failure = new Error("admission cleanup rejected");
			admission.abortCleanup = async () => {
				throw failure;
			};
			assertTimedOutBehind(await settle(launch("echo SECOND")), firstTaskId, { cause: failure });
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 0);
		} finally {
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"completed admissions never abort their granted signals when another task's cleanup quarantines (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-disposed-watch-");
		const admission = new PermitAdmission(2);
		const { ready, quarantined, launch, cleanup } = holderHost(dir, admission);
		try {
			await ready;
			await quarantined;
			assert.ok((await launch(`while [ ! -e '${dir}/finish' ]; do sleep 0.05; done`)).ok);
			await sleep(PENDING_PROBE_MS);
			assert.equal(admission.signals.length, 2);
			assert.ok(admission.signals.every((signal) => !signal.aborted));
			assert.equal(admission.held, 2);
		} finally {
			writeTextSync(`${dir}/finish`, "");
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);

test.runIf(process.platform === "linux")(
	"quarantined work that holds no permit does not bound an admission waiting on live capacity (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-admission-unreserved-quarantine-");
		const admission = new PermitAdmission(1);
		let release: ResourcePermit | undefined = await admission.acquire("process");
		const { ready, quarantined, launch, cleanup } = holderHost(dir);
		try {
			await ready;
			await quarantined;
			const waiting = withResourceAdmission(admission, () => launch("echo SECOND"));
			const probe = await Promise.race([settle(waiting), sleep(PENDING_PROBE_MS).then(() => "still waiting")]);
			assert.equal(probe, "still waiting");
			await release();
			release = undefined;
			assert.ok((await waiting).ok);
		} finally {
			await release?.();
			await cleanup();
		}
	},
	DRAIN_WINDOW_TEST_TIMEOUT_MS,
);
