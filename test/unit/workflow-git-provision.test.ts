import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { isGitUnavailableError } from "../../packages/coding-agent/src/utils/git-errors.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { inputsSelectGitWorktree } from "../../packages/workflows/src/runs/foreground/executor-direct-helpers.js";
import {
	prepareRunGit,
	runGit,
	withGitRunnerForTest,
} from "../../packages/workflows/src/runs/shared/worktree-git-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { JournalTestBackend as InMemoryDurableBackend } from "../helpers/journal-backend.js";

const isolatedAgentDir = await vi.hoisted(async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atomic-workflow-git-agent-")), "agent");
	process.env.ATOMIC_CODING_AGENT_DIR = dir;
	return dir;
});

describe("workflow runs without git (#4322)", () => {
	let backend: InMemoryDurableBackend;
	let store: ReturnType<typeof createStore>;
	let cancellation: ReturnType<typeof createCancellationRegistry>;
	let jobs: ReturnType<typeof createJobTracker>;
	let root: string;

	beforeEach(async () => {
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

	test("a run whose inputs select a worktree fails before its body with the typed offline reason", async () => {
		let bodyRuns = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const def = workflow({
			name: "git-required-worktree",
			description: "",
			inputs: { git_worktree_dir: Type.String() },
			outputs: { ok: Type.Optional(Type.Boolean()) },
			worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
			run: async () => {
				bodyRuns += 1;
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;

		const accepted = runDetached(def, { git_worktree_dir: "../wt" }, runOptions());
		await jobs.get(accepted.runId)?.promise;

		const run = store.runs().find((snapshot) => snapshot.id === accepted.runId);
		assert.equal(run?.status, "failed");
		assert.equal(bodyRuns, 0);
		assert.equal(run?.stages.length, 0);
		assert.match(
			run?.error ?? "",
			/^Git is unavailable: ATOMIC_OFFLINE is set, so no portable git is downloaded.* \(offline\)\. Unset ATOMIC_OFFLINE so Atomic can download a portable git, or install git 2\.30\.0 or newer\.$/,
		);
		assert.equal(fetchMock.mock.calls.length, 0);
		assert.equal(backend.getWorkflow(accepted.runId)?.gitWorktreeRoot, undefined);
	});

	test("a run that never uses git still runs when git is unavailable", async () => {
		let bodyRuns = 0;
		const def = workflow({
			name: "git-free",
			description: "",
			inputs: {},
			outputs: { ok: Type.Optional(Type.Boolean()) },
			run: async (ctx) => {
				bodyRuns += 1;
				await ctx.stage("work").complete("ok");
				return { ok: true };
			},
		}) as unknown as WorkflowDefinition;

		const accepted = runDetached(def, {}, runOptions());
		await jobs.get(accepted.runId)?.promise;

		const finished = store.runs().find((snapshot) => snapshot.id === accepted.runId);
		assert.equal(finished?.error, undefined);
		assert.equal(finished?.status, "completed");
		assert.equal(bodyRuns, 1);
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
		for (const requiresGit of [true, false])
			await assert.rejects(prepareRunGit(controller.signal, requiresGit), (error) => error === reason);
	});

	test("only a non-blank gitWorktreeDir input makes a run require git", () => {
		assert.equal(inputsSelectGitWorktree({ gitWorktreeDir: "../wt" }), true);
		assert.equal(inputsSelectGitWorktree({ gitWorktreeDir: "   " }), false);
		assert.equal(inputsSelectGitWorktree({ gitWorktreeDir: "" }), false);
		assert.equal(inputsSelectGitWorktree({}), false);
	});

	test("a fake git runner skips provisioning", async () => {
		const runner = () => ({ stdout: "", stderr: "", status: 0, signal: null });
		const controller = new AbortController();
		assert.equal(await withGitRunnerForTest(runner, () => prepareRunGit(controller.signal, true)), undefined);
		await assert.rejects(prepareRunGit(controller.signal, true), (error: Error) => isGitUnavailableError(error));
	});

	test("isolates the provisioned git location for this suite", () => {
		assert.equal(process.env.ATOMIC_CODING_AGENT_DIR, isolatedAgentDir);
	});
});
