import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { isGitProvisionTimeoutError, isGitUnavailableError } from "../../packages/coding-agent/src/utils/git-errors.js";
import {
	resetGitProvisionStateForTest,
	resolveGit,
	resolveGitSync,
	withGitProvisionSettingsForTest,
} from "../../packages/coding-agent/src/utils/tools-manager.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { run as runWorkflow } from "../../packages/workflows/src/runs/foreground/executor.js";
import { inputsSelectGitWorktree } from "../../packages/workflows/src/runs/foreground/executor-direct-helpers.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import {
	prepareRunGit,
	prepareTaskGit,
	runGit,
	withGitRunnerForTest,
} from "../../packages/workflows/src/runs/shared/worktree-git-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures-classifier.js";
import {
	isWorkflowGitRequiredError,
	WorkflowGitRequiredError,
} from "../../packages/workflows/src/shared/workflow-git-required-error.js";
import { JournalTestBackend as InMemoryDurableBackend } from "../helpers/journal-backend.js";

/** Counts the git resolution calls workflow code makes through the host entry, without changing what they do. */
const gitResolution = vi.hoisted(() => ({ resolveGit: 0, resolveGitSync: 0 }));
vi.mock("@bastani/atomic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bastani/atomic")>();
	return {
		...actual,
		resolveGit: (...args: Parameters<typeof actual.resolveGit>) => {
			gitResolution.resolveGit++;
			return actual.resolveGit(...args);
		},
		resolveGitSync: () => {
			gitResolution.resolveGitSync++;
			return actual.resolveGitSync();
		},
	};
});

const hostPath = process.env.PATH;

const isolatedAgentDir = await vi.hoisted(async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atomic-workflow-git-agent-")), "agent");
	process.env.ATOMIC_CODING_AGENT_DIR = dir;
	return dir;
});

const REQUEST = {
	workflow: "needs-git",
	runId: "run-1",
	source: "input",
	field: "git_worktree_dir",
	gitWorktreeDir: "../wt",
} as const;

describe("workflow runs without git (#4322)", () => {
	let backend: InMemoryDurableBackend;
	let store: ReturnType<typeof createStore>;
	let cancellation: ReturnType<typeof createCancellationRegistry>;
	let jobs: ReturnType<typeof createJobTracker>;
	let root: string;

	beforeEach(async () => {
		resetGitProvisionStateForTest();
		backend = await InMemoryDurableBackend.create();
		setDurableBackend(backend);
		store = createStore();
		cancellation = createCancellationRegistry();
		jobs = createJobTracker();
		root = mkdtempSync(join(tmpdir(), "atomic-workflow-git-"));
		mkdirSync(join(root, "empty-path"));
		vi.stubEnv("PATH", join(root, "empty-path"));
		vi.stubEnv("ATOMIC_OFFLINE", "1");
	});

	afterEach(() => {
		setDurableBackend(undefined);
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	function runOptions() {
		return {
			store,
			cancellation,
			jobs,
			cwd: root,
			durableBackend: backend,
			adapters: { complete: { complete: async (text: string) => text } },
		};
	}

	function worktreeWorkflow(onBody: () => void, withStage = false): WorkflowDefinition {
		return workflow({
			name: "git-required-worktree",
			description: "",
			inputs: { git_worktree_dir: Type.String() },
			outputs: { ok: Type.Optional(Type.Boolean()) },
			worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
			run: async (ctx) => {
				onBody();
				if (withStage) await ctx.stage("work").complete("ok");
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;
	}

	function gitFreeWorkflow(onBody: () => void): WorkflowDefinition {
		return workflow({
			name: "git-free",
			description: "",
			inputs: {},
			outputs: { ok: Type.Optional(Type.Boolean()) },
			run: async (ctx) => {
				onBody();
				await ctx.stage("work").complete("ok");
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;
	}

	async function finish(def: WorkflowDefinition, inputs: Record<string, string>) {
		const accepted = runDetached(def, inputs, runOptions());
		await jobs.get(accepted.runId)?.promise;
		const run = store.runs().find((snapshot) => snapshot.id === accepted.runId);
		assert.ok(run);
		return { accepted, run };
	}

	function failingFetch() {
		return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("busy", { status: 503 }));
	}

	test("a run whose inputs select a worktree fails before its body naming the input and the install fix", async () => {
		let bodyRuns = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const { run } = await finish(
			worktreeWorkflow(() => bodyRuns++),
			{ git_worktree_dir: "../wt" },
		);

		assert.equal(run.status, "failed");
		assert.equal(bodyRuns, 0);
		assert.equal(run.stages.length, 0);
		assert.match(
			run.error ?? "",
			/^Workflow needs git: "git-required-worktree" creates a worktree at input git_worktree_dir \(\.\.\/wt\), but git is unavailable \(offline\)\. Unset ATOMIC_OFFLINE so Atomic can download a portable git, or install git 2\.30\.0 or newer with .* \(git-required\)$/,
		);
		assert.equal(fetchMock.mock.calls.length, 0);
		assert.equal(backend.getWorkflow(run.id)?.gitWorktreeRoot, undefined);
	});

	test("an online run that cannot download git makes one download cycle, then fails typed with no stages", async () => {
		vi.stubEnv("ATOMIC_OFFLINE", "");
		let bodyRuns = 0;
		const fetchMock = failingFetch();
		const { run } = await finish(
			worktreeWorkflow(() => bodyRuns++),
			{ git_worktree_dir: "../wt" },
		);

		assert.equal(run.status, "failed");
		assert.equal(bodyRuns, 0);
		assert.equal(run.stages.length, 0);
		assert.equal(fetchMock.mock.calls.length, 3);
		assert.match(run.error ?? "", /but git is unavailable \(download-failed\)/);
	});

	test.each([
		["offline", ""],
		["online with git undownloadable", "1"],
	])(
		"a worktree-bound workflow with a blank worktree input starts no download and runs (%s)",
		async (_label, offline) => {
			vi.stubEnv("ATOMIC_OFFLINE", offline === "1" ? "" : "1");
			let bodyRuns = 0;
			const fetchMock = failingFetch();
			const { run } = await finish(
				worktreeWorkflow(() => bodyRuns++, true),
				{ git_worktree_dir: "" },
			);
			assert.equal(run.error, undefined);
			assert.equal(run.status, "completed");
			assert.equal(bodyRuns, 1);
			assert.equal(fetchMock.mock.calls.length, 0);
		},
	);

	test("runs that never use a worktree start no download and still run, even when git cannot be downloaded", async () => {
		vi.stubEnv("ATOMIC_OFFLINE", "");
		let bodyRuns = 0;
		const fetchMock = failingFetch();
		for (const _ of [1, 2]) {
			const { run } = await finish(
				gitFreeWorkflow(() => bodyRuns++),
				{},
			);
			assert.equal(run.error, undefined);
			assert.equal(run.status, "completed");
		}
		assert.equal(bodyRuns, 2);
		assert.equal(fetchMock.mock.calls.length, 0);
	});

	test("a task that creates its own worktree gets one download attempt before its stage, then fails typed", async () => {
		vi.stubEnv("ATOMIC_OFFLINE", "");
		const fetchMock = failingFetch();
		let thrown: unknown;
		const def = workflow({
			name: "task-worktree",
			description: "",
			inputs: {},
			outputs: { ok: Type.Optional(Type.Boolean()) },
			run: async (ctx) => {
				try {
					await ctx.task("edit", { prompt: "x", worktree: true });
				} catch (error) {
					thrown = error;
					throw error;
				}
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;
		const { run } = await finish(def, {});

		assert.equal(run.status, "failed");
		assert.equal(fetchMock.mock.calls.length, 3);
		assert.ok(thrown instanceof WorkflowGitRequiredError);
		assert.equal(thrown.code, "git-required");
		assert.deepEqual(thrown.fields, {
			workflow: "task-worktree",
			runId: run.id,
			source: "task-option",
			field: "edit",
		});
		assert.equal(thrown.cause.code, "download-failed");
		assert.equal(thrown.retryable, true);
		assert.equal(thrown.hint, thrown.cause.hint);
	});

	test("a task that asks for no worktree never starts a download, and one that names a gitWorktreeDir does", async () => {
		vi.stubEnv("ATOMIC_OFFLINE", "");
		const fetchMock = failingFetch();
		const plain = workflow({
			name: "task-plain",
			description: "",
			inputs: {},
			outputs: { ok: Type.Optional(Type.Boolean()) },
			run: async (ctx) => {
				await ctx.task("edit", { prompt: "x" });
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;
		await finish(plain, {});
		assert.equal(fetchMock.mock.calls.length, 0);

		const named = workflow({
			name: "task-named-dir",
			description: "",
			inputs: {},
			outputs: { ok: Type.Optional(Type.Boolean()) },
			run: async (ctx) => {
				await ctx.task("edit", { prompt: "x", gitWorktreeDir: "../named" });
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;
		const { run } = await finish(named, {});
		assert.equal(run.status, "failed");
		assert.equal(fetchMock.mock.calls.length, 3);
	});

	function gitRepo(): string {
		const repo = join(root, "repo");
		mkdirSync(repo);
		vi.stubEnv("PATH", hostPath);
		runGitChecked(repo, ["init", "-b", "main"]);
		runGitChecked(repo, ["config", "user.name", "Atomic Test"]);
		runGitChecked(repo, ["config", "user.email", "atomic@example.com"]);
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		runGitChecked(repo, ["add", "."]);
		runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
		return repo;
	}

	/** Run on a node with git, failing the prompt that contains `failOn`, and return the failed run to resume. */
	async function failedSourceRun(def: WorkflowDefinition, repo: string, failOn: string): Promise<RunSnapshot> {
		const sourceStore = createStore();
		const first = await runWorkflow(
			def,
			{},
			{
				store: sourceStore,
				cwd: repo,
				adapters: {
					prompt: {
						prompt: async (text: string) => {
							if (text.includes(failOn)) throw new Error(`${failOn} failed`);
							return "done";
						},
					},
				},
			},
		);
		assert.equal(first.status, "failed");
		const source = sourceStore.runs().find((snapshot) => snapshot.id === first.runId);
		assert.ok(source?.failedStageId);
		return source;
	}

	/** Move to a node with no git, where a download already failed in a retryable way and fails again. */
	async function withoutGitAfterRetryableFailure() {
		resetGitProvisionStateForTest();
		vi.stubEnv("PATH", join(root, "empty-path"));
		vi.stubEnv("ATOMIC_OFFLINE", "");
		const fetchMock = failingFetch();
		const earlier = await resolveGit().catch((error: Error) => error);
		assert.ok(isGitUnavailableError(earlier) && earlier.code === "download-failed" && earlier.retryable);
		fetchMock.mockClear();
		gitResolution.resolveGit = 0;
		gitResolution.resolveGitSync = 0;
		return fetchMock;
	}

	function resumeRun(def: WorkflowDefinition, repo: string, source: RunSnapshot, onPrompt: (text: string) => void) {
		return runWorkflow(
			def,
			{},
			{
				store: createStore(),
				cwd: repo,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: {
					prompt: {
						prompt: async (text: string) => {
							onPrompt(text);
							return "done";
						},
					},
				},
			},
		);
	}

	function assertTaskNeedsGit(error: unknown, workflowName: string, runId: string, task: string) {
		assert.ok(isWorkflowGitRequiredError(error));
		assert.equal(error.code, "git-required");
		assert.deepEqual(error.fields, { workflow: workflowName, runId, source: "task-option", field: task });
		assert.equal(error.cause.code, "download-failed");
		assert.equal(error.retryable, true);
	}

	test("a resumed run replays saved worktree tasks without resolving git, then provisions for the task it runs (#4322)", async () => {
		const repo = gitRepo();
		let shipError: unknown;
		const def = workflow({
			name: "saved-worktree-tasks",
			description: "",
			inputs: {},
			outputs: { ok: Type.Optional(Type.Boolean()) },
			run: async (ctx) => {
				await ctx.task("edit", { prompt: "TASK_EDIT", worktree: true });
				await ctx.task("review", { prompt: "TASK_REVIEW", worktree: true });
				await ctx.stage("gate").prompt("GATE");
				try {
					await ctx.task("ship", { prompt: "TASK_SHIP", worktree: true });
				} catch (error) {
					shipError = error;
					throw error;
				}
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;
		const source = await failedSourceRun(def, repo, "GATE");
		assert.deepEqual(
			source.stages.filter((stage) => stage.status === "completed").map((stage) => stage.name),
			["edit", "review"],
		);

		const fetchMock = await withoutGitAfterRetryableFailure();
		const livePrompts: string[] = [];
		let beforeLiveWork: { fetches: number; resolveGit: number; resolveGitSync: number } | undefined;
		const resumed = await resumeRun(def, repo, source, (text) => {
			livePrompts.push(text);
			beforeLiveWork ??= { fetches: fetchMock.mock.calls.length, ...gitResolution };
		});

		assert.equal(resumed.status, "failed");
		assert.deepEqual(
			resumed.stages.filter((stage) => stage.replayed).map((stage) => stage.name),
			["edit", "review"],
		);
		assert.equal(livePrompts.length, 1);
		assert.match(livePrompts[0] ?? "", /GATE/);
		assert.deepEqual(beforeLiveWork, { fetches: 0, resolveGit: 0, resolveGitSync: 0 });
		assert.equal(gitResolution.resolveGit, 1);
		assert.equal(fetchMock.mock.calls.length, 3);
		assertTaskNeedsGit(shipError, "saved-worktree-tasks", resumed.runId, "ship");
	});

	test("a resumed run provisions git for a worktree task whose saved attempt failed (#4322)", async () => {
		const repo = gitRepo();
		let editError: unknown;
		const def = workflow({
			name: "failed-worktree-task",
			description: "",
			inputs: {},
			outputs: { ok: Type.Optional(Type.Boolean()) },
			run: async (ctx) => {
				try {
					await ctx.task("edit", { prompt: "TASK_EDIT", worktree: true });
				} catch (error) {
					editError = error;
					throw error;
				}
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;
		const source = await failedSourceRun(def, repo, "TASK_EDIT");
		assert.deepEqual(
			source.stages.map((stage) => [stage.name, stage.status]),
			[["edit", "failed"]],
		);

		const fetchMock = await withoutGitAfterRetryableFailure();
		const livePrompts: string[] = [];
		const resumed = await resumeRun(def, repo, source, (text) => livePrompts.push(text));

		assert.equal(resumed.status, "failed");
		assert.deepEqual(livePrompts, []);
		assert.equal(gitResolution.resolveGit, 1);
		assert.equal(fetchMock.mock.calls.length, 3);
		assertTaskNeedsGit(editError, "failed-worktree-task", resumed.runId, "edit");
	});

	test("prepareTaskGit attempts a download when git is missing and downloadable, and again after a retryable failure", async () => {
		const fetchMock = failingFetch();
		const controller = new AbortController();
		await prepareTaskGit(controller.signal);
		assert.equal(fetchMock.mock.calls.length, 0);
		vi.stubEnv("ATOMIC_OFFLINE", "");
		await prepareTaskGit(controller.signal);
		assert.equal(fetchMock.mock.calls.length, 3);
		await prepareTaskGit(controller.signal);
		assert.equal(fetchMock.mock.calls.length, 6);
	});

	test("prepareTaskGit retries after a retryable timeout, not only after a download failure", async () => {
		vi.stubEnv("ATOMIC_OFFLINE", "");
		let stalled = true;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise((resolve, reject) => {
					if (!stalled) return resolve(new Response("gone", { status: 404 }));
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const timedOut = await withGitProvisionSettingsForTest({ downloadTimeoutMs: 30 }, () => resolveGit()).catch(
			(error: Error) => error,
		);
		assert.ok(isGitProvisionTimeoutError(timedOut));
		assert.throws(
			() => resolveGitSync(),
			(error: Error) => error === timedOut,
		);
		const requestsAfterTimeout = fetchMock.mock.calls.length;
		stalled = false;
		await prepareTaskGit(new AbortController().signal);
		assert.equal(fetchMock.mock.calls.length, requestsAfterTimeout + 1);
	});

	test("prepareTaskGit does not retry a failure that retrying cannot fix", async () => {
		vi.stubEnv("ATOMIC_OFFLINE", "");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("gone", { status: 404 }));
		const controller = new AbortController();
		await prepareTaskGit(controller.signal);
		assert.equal(fetchMock.mock.calls.length, 1);
		await prepareTaskGit(controller.signal);
		assert.equal(fetchMock.mock.calls.length, 1);
	});

	test.each([
		[
			"worktree: true",
			{ prompt: "x", worktree: true },
			/creates a worktree, but git is unavailable \(offline\)/,
			{ workflow: "taskneedsworktree", source: "task-option", field: "edit" },
		],
		[
			"a gitWorktreeDir option",
			{ prompt: "x", gitWorktreeDir: "../named" },
			/creates a worktree \(\.\.\/named\), but git is unavailable \(offline\)/,
			{ workflow: "taskneedsworktree", source: "task-option", field: "edit", gitWorktreeDir: "../named" },
		],
	])(
		"a task with %s fails with a git-required error naming the task",
		async (_label, taskOptions, creates, fields) => {
			const fetchMock = vi.spyOn(globalThis, "fetch");
			let thrown: unknown;
			const def = workflow({
				name: "taskneedsworktree",
				description: "",
				inputs: {},
				outputs: { ok: Type.Optional(Type.Boolean()) },
				run: async (ctx) => {
					try {
						await ctx.task("edit", taskOptions);
					} catch (error) {
						thrown = error;
						throw error;
					}
					return { ok: true };
				},
			}) as unknown as WorkflowDefinition;
			const { run } = await finish(def, {});
			assert.equal(run.status, "failed");
			assert.match(run.error ?? "", /Workflow needs git: task "edit" of "taskneedsworktree"/);
			assert.match(run.error ?? "", creates);
			assert.match(run.error ?? "", /\(git-required\)$/);
			assert.equal(fetchMock.mock.calls.length, 0);
			assert.ok(isWorkflowGitRequiredError(thrown));
			assert.deepEqual({ ...thrown.fields, runId: undefined }, { ...fields, runId: undefined });
			assert.equal(thrown.fields.runId, run.id);
			assert.equal(thrown.cause.code, "offline");
		},
	);

	test("worktree git commands fail with the typed reason instead of a spawn error", () => {
		assert.throws(
			() => runGit(root, ["rev-parse", "--show-toplevel"]),
			(error: Error) => isGitUnavailableError(error) && error.code === "offline",
		);
	});

	test("provisioning propagates a cancellation reason unchanged", async () => {
		const controller = new AbortController();
		const reason = new Error("run cancelled");
		controller.abort(reason);
		await assert.rejects(prepareRunGit(controller.signal, REQUEST), (error) => error === reason);
		vi.stubEnv("ATOMIC_OFFLINE", "");
		await assert.rejects(prepareTaskGit(controller.signal), (error) => error === reason);
		assert.equal(await prepareRunGit(controller.signal, undefined), undefined);
	});

	test("only a non-blank gitWorktreeDir input makes a run require git", () => {
		assert.equal(inputsSelectGitWorktree({ gitWorktreeDir: "../wt" }), true);
		assert.equal(inputsSelectGitWorktree({ gitWorktreeDir: "   " }), false);
		assert.equal(inputsSelectGitWorktree({ gitWorktreeDir: "" }), false);
		assert.equal(inputsSelectGitWorktree({}), false);
	});

	test("a fake git runner skips provisioning", async () => {
		vi.stubEnv("ATOMIC_OFFLINE", "");
		const fetchMock = failingFetch();
		const runner = () => ({ stdout: "", stderr: "", status: 0, signal: null });
		const controller = new AbortController();
		assert.equal(await withGitRunnerForTest(runner, () => prepareRunGit(controller.signal, REQUEST)), undefined);
		assert.equal(await withGitRunnerForTest(runner, () => prepareTaskGit(controller.signal)), undefined);
		assert.equal(fetchMock.mock.calls.length, 0);
		await assert.rejects(prepareRunGit(controller.signal, REQUEST), (error: Error) =>
			isWorkflowGitRequiredError(error),
		);
	});

	test("the wrapper keeps the git error as its cause, its hint, and its retryability through classification", async () => {
		const offline = await prepareRunGit(new AbortController().signal, REQUEST).catch((error: Error) => error);
		assert.ok(offline instanceof WorkflowGitRequiredError);
		assert.equal(offline.code, "git-required");
		assert.deepEqual(offline.fields, REQUEST);
		assert.equal(offline.retryable, false);
		assert.equal(offline.hint, offline.cause?.hint);
		assert.equal(offline.cause?.code, "offline");
		assert.equal(classifyWorkflowFailure(offline).retryable, false);

		vi.stubEnv("ATOMIC_OFFLINE", "");
		failingFetch();
		const busy = await prepareRunGit(new AbortController().signal, REQUEST).catch((error: Error) => error);
		assert.ok(busy instanceof WorkflowGitRequiredError);
		assert.equal(busy.cause?.code, "download-failed");
		assert.equal(busy.retryable, true);
		assert.equal(classifyWorkflowFailure(busy).retryable, true);
	});

	test("isolates the provisioned git location for this suite", () => {
		assert.equal(process.env.ATOMIC_CODING_AGENT_DIR, isolatedAgentDir);
	});
});
