import assert from "node:assert/strict";
import {
	AgentRehydrateError,
	BackgroundCompactionPersistError,
	BlueprintStepFailedError,
	DebugLogUnwritableError,
	DecisionTimeoutError,
	EditMatchError,
	EventSourceError,
	GitHubCopilotRateLimitError,
	GitUnavailableError,
	IntercomBrokerSuccessorTimeoutError,
	isAgentRehydrateError,
	isBackgroundCompactionPersistError,
	isBlueprintStepFailedError,
	isDebugLogUnwritableError,
	isDecisionTimeoutError,
	isEditMatchError,
	isEventSourceError,
	isGitHubCopilotRateLimitError,
	isGitUnavailableError,
	isIntercomBrokerSuccessorTimeoutError,
	isLlamaServerUnreachableError,
	isResumePreconditionError,
	isSessionStartTimeoutError,
	isShellTimeoutError,
	isStartupBenchmarkConfigError,
	isTaskEvictedError,
	isTaskMessageTimeoutError,
	isTaskToolError,
	isToolDetachmentError,
	isWorkspaceBindingError,
	isWriteSelectorError,
	LlamaServerUnreachableError,
	ResumePreconditionError,
	SessionStartTimeoutError,
	ShellTimeoutError,
	StartupBenchmarkConfigError,
	serializeAgentRehydrateError,
	serializeBackgroundCompactionError,
	serializeBlueprintError,
	serializeDebugError,
	serializeDecisionError,
	serializeFileToolError,
	serializeGitHubCopilotError,
	serializeIntercomBrokerError,
	serializeResumeError,
	serializeSessionStartError,
	serializeSubscriptionError,
	serializeWorkspaceError,
	TaskEvictedError,
	TaskMessageTimeoutError,
	TaskToolError,
	ToolDetachmentError,
	WorkspaceBindingError,
	WriteSelectorError,
} from "@bastani/atomic";
import { isStorageWriteLockTimeoutError, StorageWriteLockTimeoutError } from "@bastani/atomic/storage";
import { serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import { isRunReplayError, RunReplayError } from "../../packages/workflows/src/shared/run-eviction-errors.js";
import {
	isStageRehydrationError,
	StageRehydrationError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import {
	isWorkflowStructuredOutputInferenceError,
	WorkflowStructuredOutputInferenceError,
} from "../../packages/workflows/src/shared/structured-output-errors.js";
import {
	isWorkflowGitRequiredError,
	WorkflowGitRequiredError,
} from "../../packages/workflows/src/shared/workflow-git-required-error.js";
import {
	isWorkerRetryLimitError,
	WorkerRetryLimitError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import {
	isWorkspaceRestoreUnavailableError,
	WorkspaceRestoreUnavailableError,
} from "../../packages/workflows/src/workers/placement-errors.js";

/** One error of a family that crosses the worker protocol typed, and how to tell it arrived as itself (#4378). */
export interface FamilyCase {
	/** The family its envelope names. */
	readonly family: string;
	readonly make: () => Error;
	readonly type: abstract new (...args: never[]) => Error;
	readonly guard: (value: Error) => boolean;
	/** The facts the error carries: its family's own JSON form, or its envelope's fields, without its causes. */
	readonly facts: (error: Error) => unknown;
}

/** The facts a family's own JSON form of an error holds, causes aside, as JSON. */
function ownFacts<E extends Error>(serialize: (error: E) => object): (error: Error) => unknown {
	return (error) => {
		const {
			cause: _cause,
			cleanupCause: _cleanupCause,
			...form
		} = serialize(error as E) as {
			readonly cause?: unknown;
			readonly cleanupCause?: unknown;
		};
		return JSON.parse(JSON.stringify(form));
	};
}

const toJSON = (error: Error & { toJSON(): object }): object => error.toJSON();

const envelopeFacts = (error: Error): unknown => serializeError(error).fields;

export function gitUnavailable(): GitUnavailableError {
	return new GitUnavailableError(
		{
			code: "offline",
			offlineVariable: "ATOMIC_OFFLINE",
			platform: "linux",
			arch: "x64",
			installCommand: "apt-get install git",
		},
		{ cause: new Error("no git on PATH") },
	);
}

const BINDING = {
	remotes: ["https://example.invalid/repo.git"],
	head: "1111111111111111111111111111111111111111",
	tree: "2222222222222222222222222222222222222222",
	envHash: "fixture-env",
};

/** An error of every family with its own JSON form, each with a cause where its class takes one. */
export const SERIALIZABLE_FAMILY_CASES: readonly FamilyCase[] = [
	{
		family: "stage-wait",
		make: () =>
			new StageRehydrationError(
				{ runId: "run-1", stageId: "stage-1", stageName: "review", sessionId: "session-1" },
				{ cause: new Error("session store unreachable") },
			),
		type: StageRehydrationError,
		guard: isStageRehydrationError,
		facts: ownFacts(toJSON),
	},
	{
		family: "structured-output",
		make: () =>
			new WorkflowStructuredOutputInferenceError(
				"auto-inference-failed",
				{
					runId: "run-1",
					stageId: "stage-1",
					stageName: "review",
					toolCallId: "workflow-auto-structured-output-1",
				},
				{ cause: new Error("decision provider unavailable") },
			),
		type: WorkflowStructuredOutputInferenceError,
		guard: isWorkflowStructuredOutputInferenceError,
		facts: ownFacts(toJSON),
	},
	{
		family: "tool-detachment",
		make: () => new ToolDetachmentError("session-busy", { sessionId: "session-1" }, { cause: new Error("running") }),
		type: ToolDetachmentError,
		guard: isToolDetachmentError,
		facts: ownFacts(toJSON),
	},
	{
		family: "run-eviction",
		make: () =>
			new RunReplayError(
				{ runId: "run-1", replayKeys: ["stage:a:1"], toolCallIds: ["call-a"] },
				{ cause: new Error("the body ended") },
			),
		type: RunReplayError,
		guard: isRunReplayError,
		facts: ownFacts(toJSON),
	},
	{
		family: "git-provision",
		make: gitUnavailable,
		type: GitUnavailableError,
		guard: isGitUnavailableError,
		facts: ownFacts(toJSON),
	},
	{
		family: "git-required",
		make: () =>
			new WorkflowGitRequiredError(
				{ workflow: "w", runId: "run-1", source: "input", field: "worktree", gitWorktreeDir: "/w" },
				gitUnavailable(),
			),
		type: WorkflowGitRequiredError,
		guard: isWorkflowGitRequiredError,
		facts: ownFacts(toJSON),
	},
	{
		family: "workspace",
		make: () =>
			new WorkspaceBindingError({
				code: "drift",
				reason: "history-rewritten",
				fields: { repo: "/repos/api", worktree: "/wt/api", expected: "abc123", actual: "def456" },
				cause: new Error("git merge-base failed"),
			}),
		type: WorkspaceBindingError,
		guard: isWorkspaceBindingError,
		facts: ownFacts(serializeWorkspaceError),
	},
	{
		family: "session-start",
		make: () =>
			new SessionStartTimeoutError(
				{
					subject: "stage review",
					phase: "setup",
					step: "creating-session",
					timeoutMs: 300_000,
					elapsedMs: 300_012,
					stepElapsedMs: 290_400,
					steps: [{ step: "creating-session", elapsedMs: 290_400 }],
					eventLoop: { turns: 1_190, meanTurnMs: 252, maxTurnMs: 260 },
				},
				{ cause: new Error("slow disk") },
			),
		type: SessionStartTimeoutError,
		guard: isSessionStartTimeoutError,
		facts: ownFacts(serializeSessionStartError),
	},
	{
		family: "decision",
		make: () =>
			new DecisionTimeoutError(
				{ timeoutMs: 5, elapsedMs: 6, phase: "resolve" },
				{ cause: new Error("socket hang up") },
			),
		type: DecisionTimeoutError,
		guard: isDecisionTimeoutError,
		facts: ownFacts(serializeDecisionError),
	},
	{
		family: "task-evicted",
		make: () => new TaskEvictedError({ taskId: "task-7", retainedFinishedTasks: 3 }, { cause: new Error("evicted") }),
		type: TaskEvictedError,
		guard: isTaskEvictedError,
		facts: ownFacts((error: TaskEvictedError) => ({ ...error, message: error.message })),
	},
	{
		family: "agent-rehydrate",
		make: () =>
			new AgentRehydrateError(
				"session-busy",
				{ sessionId: "session-1", activity: "streaming" },
				{ cause: new Error("still streaming") },
			),
		type: AgentRehydrateError,
		guard: isAgentRehydrateError,
		facts: ownFacts(serializeAgentRehydrateError),
	},
	{
		family: "background-compaction",
		make: () => new BackgroundCompactionPersistError({ upToEntryId: "u3" }, { cause: new Error("disk full") }),
		type: BackgroundCompactionPersistError,
		guard: isBackgroundCompactionPersistError,
		facts: ownFacts(serializeBackgroundCompactionError),
	},
	{
		family: "github-copilot",
		make: () =>
			new GitHubCopilotRateLimitError(
				{ modelId: "model-1", api: "openai-completions", status: 429, requestId: "req-1" },
				1_500,
				{ cause: new Error("too many requests") },
			),
		type: GitHubCopilotRateLimitError,
		guard: isGitHubCopilotRateLimitError,
		facts: ownFacts(serializeGitHubCopilotError),
	},
	{
		family: "debug",
		make: () => new DebugLogUnwritableError("/logs/atomic-debug.log", { cause: new TypeError("EACCES") }),
		type: DebugLogUnwritableError,
		guard: isDebugLogUnwritableError,
		facts: ownFacts(serializeDebugError),
	},
	{
		family: "edit-tool",
		make: () =>
			new EditMatchError(
				"text-not-unique",
				"duplicate",
				{ path: "a.txt", editIndex: 1, totalEdits: 2, occurrences: 4 },
				{ cause: new Error("matched twice") },
			),
		type: EditMatchError,
		guard: isEditMatchError,
		facts: ownFacts(serializeFileToolError),
	},
	{
		family: "write-selector",
		make: () =>
			new WriteSelectorError(
				"conflict-id-not-found",
				"Conflict id not found: 3",
				{ path: "conflict://3", conflictId: "3" },
				{ cause: new Error("no conflict 3") },
			),
		type: WriteSelectorError,
		guard: isWriteSelectorError,
		facts: ownFacts(serializeFileToolError),
	},
	{
		family: "shell-tool",
		make: () => new ShellTimeoutError({ timeoutSeconds: 2, elapsedMs: 2_001 }),
		type: ShellTimeoutError,
		guard: isShellTimeoutError,
		facts: ownFacts(toJSON),
	},
	{
		family: "llama-server",
		make: () =>
			new LlamaServerUnreachableError("http://127.0.0.1:8080", "connect ECONNREFUSED", {
				cause: new Error("ECONNREFUSED"),
			}),
		type: LlamaServerUnreachableError,
		guard: isLlamaServerUnreachableError,
		facts: ownFacts(toJSON),
	},
	{
		family: "startup-benchmark",
		make: () => new StartupBenchmarkConfigError({ appMode: "print" }),
		type: StartupBenchmarkConfigError,
		guard: isStartupBenchmarkConfigError,
		facts: ownFacts(toJSON),
	},
	{
		family: "subscription",
		make: () =>
			new EventSourceError("github-checks:acme/widgets#7", "poll", {
				cause: new Error("gh exited with code 1"),
				retryable: true,
				detail: "gh api returned 502",
			}),
		type: EventSourceError,
		guard: isEventSourceError,
		facts: ownFacts(serializeSubscriptionError),
	},
	{
		family: "task-tool",
		make: () => new TaskToolError({ code: "TaskEvicted", message: "task-1 was evicted" }, "task-1"),
		type: TaskToolError,
		guard: isTaskToolError,
		facts: ownFacts(toJSON),
	},
	{
		family: "task-message",
		make: () =>
			new TaskMessageTimeoutError(
				{ taskId: "task-1", target: "worker-1", timeoutMs: 10_000, elapsedMs: 10_004 },
				{ cause: new Error("Intercom did not acknowledge") },
			),
		type: TaskMessageTimeoutError,
		guard: isTaskMessageTimeoutError,
		facts: ownFacts(toJSON),
	},
	{
		family: "intercom-broker",
		make: () =>
			new IntercomBrokerSuccessorTimeoutError(
				{ timeoutMs: 10_000, elapsedMs: 10_500, attempts: 14 },
				{ cause: new Error("Intercom broker went away before it registered this session: read ECONNRESET") },
			),
		type: IntercomBrokerSuccessorTimeoutError,
		guard: isIntercomBrokerSuccessorTimeoutError,
		facts: ownFacts(serializeIntercomBrokerError),
	},
	{
		family: "resume",
		make: () =>
			new ResumePreconditionError(
				{
					entryPoint: "workflow-resume",
					problems: [
						{
							code: "git-unavailable",
							subject: "git (offline)",
							why: "workflow run r1 must restore /repo, which this node does not have",
							fix: "Install Git, then resume again.",
						},
					],
				},
				gitUnavailable(),
			),
		type: ResumePreconditionError,
		guard: isResumePreconditionError,
		facts: ownFacts(serializeResumeError),
	},
	{
		family: "blueprint",
		make: () =>
			new BlueprintStepFailedError(
				{
					blueprint: "/repo/.atomic/blueprint.yaml",
					scope: "repository",
					section: "initialize",
					index: 0,
					step: "Install toolchain",
					exitStatus: 7,
					signal: null,
					logPath: "/store/blueprint-logs/step.log",
				},
				new Error("spawn failed"),
			),
		type: BlueprintStepFailedError,
		guard: isBlueprintStepFailedError,
		facts: ownFacts(serializeBlueprintError),
	},
];

/** Errors of families the codec carried before #4378, which now also cross as a failed child's typed failure. */
export const CODEC_FAMILY_CASES: readonly FamilyCase[] = [
	{
		family: "worker-placement",
		make: () =>
			new WorkspaceRestoreUnavailableError("no-capable-host", BINDING, {
				childRunId: "child",
				claimWindowMs: 3_000,
			}),
		type: WorkspaceRestoreUnavailableError,
		guard: isWorkspaceRestoreUnavailableError,
		facts: envelopeFacts,
	},
	{
		family: "storage",
		make: () =>
			new StorageWriteLockTimeoutError(
				{ adapter: "sqlite", location: "/j.db" },
				{ timeoutMs: 5_000, elapsedMs: 5_012, phase: "queued" },
				new Error("SQLITE_BUSY"),
			),
		type: StorageWriteLockTimeoutError,
		guard: isStorageWriteLockTimeoutError,
		facts: envelopeFacts,
	},
	{
		family: "workflow-infrastructure",
		make: () =>
			new WorkerRetryLimitError(
				{ reason: "worker-lost", attempts: 3, limit: 3, childRunId: "grandchild", exportName: "grandchild" },
				{ cause: new Error("worker exited") },
			),
		type: WorkerRetryLimitError,
		guard: isWorkerRetryLimitError,
		facts: envelopeFacts,
	},
];

export const FAMILY_CASES: readonly FamilyCase[] = [...SERIALIZABLE_FAMILY_CASES, ...CODEC_FAMILY_CASES];

const member = (error: Error, key: string): unknown => (error as unknown as Record<string, unknown>)[key];

/** Asserts `rebuilt` arrived as `original`: its class, guard, identity, facts and cause. */
export function assertSameFamilyError(rebuilt: Error, original: Error, kase: FamilyCase): void {
	assert.ok(rebuilt instanceof kase.type, `${kase.family}: ${rebuilt.name} is not a ${original.name}`);
	assert.equal(rebuilt.constructor, original.constructor, kase.family);
	assert.equal(kase.guard(rebuilt), true, kase.family);
	for (const key of ["name", "code", "message", "hint", "retryable"])
		assert.deepEqual(member(rebuilt, key), member(original, key), `${kase.family}.${key}`);
	assert.deepEqual(kase.facts(rebuilt), kase.facts(original), `${kase.family} facts`);
	const cause = original.cause as Error | undefined;
	if (cause === undefined) return;
	assert.ok(rebuilt.cause instanceof Error, `${kase.family} lost its cause`);
	assert.equal(rebuilt.cause.name, cause.name);
	if (kase.family !== "storage") assert.equal(rebuilt.cause.message, cause.message);
}
