import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { isGitUnavailableError } from "../../packages/coding-agent/src/utils/git-errors.js";
import { resetGitProvisionStateForTest } from "../../packages/coding-agent/src/utils/tools-manager.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { inputsSelectGitWorktree } from "../../packages/workflows/src/runs/foreground/executor-direct-helpers.js";
import {
	prepareRunGit,
	prepareTaskGit,
	runGit,
	withGitRunnerForTest,
} from "../../packages/workflows/src/runs/shared/worktree-git-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures-classifier.js";
import {
	isWorkflowGitRequiredError,
	WorkflowGitRequiredError,
} from "../../packages/workflows/src/shared/workflow-git-required-error.js";
import { JournalTestBackend as InMemoryDurableBackend } from "../helpers/journal-backend.js";

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

	function worktreeWorkflow(onBody: () => void): WorkflowDefinition {
		return workflow({
			name: "git-required-worktree",
			description: "",
			inputs: { git_worktree_dir: Type.String() },
			outputs: { ok: Type.Optional(Type.Boolean()) },
			worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
			run: async () => {
				onBody();
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
		const def = workflow({
			name: "task-worktree",
			description: "",
			inputs: {},
			outputs: { ok: Type.Optional(Type.Boolean()) },
			run: async (ctx) => {
				await ctx.task("edit", { prompt: "x", worktree: true });
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;
		const { run } = await finish(def, {});

		assert.equal(run.status, "failed");
		assert.equal(fetchMock.mock.calls.length, 3);
		assert.match(run.error ?? "", /download-failed/);
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

	test("prepareTaskGit attempts a download only when git is missing and downloadable", async () => {
		const fetchMock = failingFetch();
		const controller = new AbortController();
		await prepareTaskGit(controller.signal);
		assert.equal(fetchMock.mock.calls.length, 0);
		vi.stubEnv("ATOMIC_OFFLINE", "");
		await prepareTaskGit(controller.signal);
		assert.equal(fetchMock.mock.calls.length, 3);
		await prepareTaskGit(controller.signal);
		assert.equal(fetchMock.mock.calls.length, 3);
	});

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
