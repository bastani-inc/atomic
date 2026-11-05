import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isRetryableTaskError, isTaskCleanupError, SessionManager, type TaskCleanupError } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session-types.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { OperationId, ResourceFailure } from "../../packages/coding-agent/src/core/tasks/contracts.js";
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
