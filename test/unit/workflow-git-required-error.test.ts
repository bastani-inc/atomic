import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	findGitProvisionError,
	GitUnavailableError,
	isRetryableGitProvisionError,
} from "../../packages/coding-agent/src/utils/git-errors.js";
import {
	isWorkflowGitRequiredError,
	rehydrateWorkflowGitRequiredError,
	WorkflowGitRequiredError,
	wrapGitRequired,
} from "../../packages/workflows/src/shared/workflow-git-required-error.js";

const OFFLINE = new GitUnavailableError({
	code: "offline",
	offlineVariable: "ATOMIC_OFFLINE",
	platform: "linux",
	arch: "x64",
	installCommand: "apt-get install git",
});
const BUSY = new GitUnavailableError({
	code: "download-failed",
	asset: "a.tar.gz",
	url: "https://example.test/a.tar.gz",
	httpStatus: 503,
	platform: "linux",
	arch: "x64",
});
const INPUT = {
	workflow: "goal",
	runId: "run-7",
	source: "input",
	field: "git_worktree_dir",
	gitWorktreeDir: "../wt",
} as const;
const TASK = {
	workflow: "ralph",
	runId: "run-8",
	source: "task-option",
	field: "implement",
	gitWorktreeDir: "../wt2",
} as const;

describe("WorkflowGitRequiredError (#4322)", () => {
	test("renders what the run asked for, why git is missing, and the fix, from its fields", () => {
		const error = new WorkflowGitRequiredError(INPUT, OFFLINE);
		assert.equal(
			error.message,
			'Workflow needs git: "goal" creates a worktree at input git_worktree_dir (../wt), but git is unavailable (offline). Unset ATOMIC_OFFLINE so Atomic can download a portable git, or install git 2.30.0 or newer with `apt-get install git`. (git-required)',
		);
		assert.equal(error.name, "WorkflowGitRequiredError");
		assert.equal(error.code, "git-required");
		assert.deepEqual(error.fields, INPUT);
		assert.equal(error.hint, OFFLINE.hint);
		assert.equal(error.retryable, false);
	});

	test("names the task for a task-level worktree", () => {
		const error = new WorkflowGitRequiredError(TASK, BUSY);
		assert.match(
			error.message,
			/^Workflow needs git: task "implement" of "ralph" creates a worktree \(\.\.\/wt2\), but git is unavailable \(download-failed\)\./,
		);
		assert.equal(error.retryable, true);
	});

	test("renders a task that asks for a temporary worktree without a path", () => {
		const { gitWorktreeDir: _dir, ...withoutDir } = TASK;
		const error = new WorkflowGitRequiredError(withoutDir, OFFLINE);
		assert.match(
			error.message,
			/^Workflow needs git: task "implement" of "ralph" creates a worktree, but git is unavailable \(offline\)\./,
		);
		assert.equal("gitWorktreeDir" in error.fields, false);
	});

	test("keeps the git error reachable and retryable through the cause chain", () => {
		const error = new WorkflowGitRequiredError(INPUT, BUSY);
		assert.equal(error.cause, BUSY);
		const outer = new Error("run failed", { cause: error });
		assert.equal(findGitProvisionError(outer), BUSY);
		assert.ok(isRetryableGitProvisionError(outer));
	});

	test("a guard given null or a primitive answers false instead of throwing", () => {
		for (const value of [null, undefined, 0, "git-required", true])
			assert.equal(isWorkflowGitRequiredError(value), false);
	});

	test("matches by class and by name and code from another realm", () => {
		assert.ok(isWorkflowGitRequiredError(new WorkflowGitRequiredError(INPUT, OFFLINE)));
		assert.ok(isWorkflowGitRequiredError({ name: "WorkflowGitRequiredError", code: "git-required" }));
		assert.ok(!isWorkflowGitRequiredError({ name: "WorkflowGitRequiredError", code: "other" }));
		assert.ok(!isWorkflowGitRequiredError({ name: "Error", code: "git-required" }));
		assert.ok(!isWorkflowGitRequiredError(null));
		assert.ok(!isWorkflowGitRequiredError("git-required"));
	});

	test("serializes and rehydrates as the same class with fields, hint and git cause", () => {
		const wire = JSON.parse(JSON.stringify(new WorkflowGitRequiredError(INPUT, OFFLINE)));
		assert.deepEqual(Object.keys(wire).sort(), ["cause", "code", "fields", "hint", "message", "name", "retryable"]);
		const restored = rehydrateWorkflowGitRequiredError(wire);
		assert.ok(restored instanceof WorkflowGitRequiredError);
		assert.equal(restored.message, wire.message);
		assert.equal(restored.hint, OFFLINE.hint);
		assert.deepEqual(restored.fields, INPUT);
		assert.ok(restored.cause instanceof GitUnavailableError);
		assert.equal(restored.cause.code, "offline");
		assert.equal(restored.cause.fields.installCommand, "apt-get install git");
	});

	test("refuses to rehydrate a payload without its git cause", () => {
		const { cause: _cause, ...withoutCause } = new WorkflowGitRequiredError(INPUT, OFFLINE).toJSON();
		assert.throws(
			() => rehydrateWorkflowGitRequiredError(withoutCause),
			(error: Error) =>
				error instanceof TypeError &&
				error.message === "A serialized WorkflowGitRequiredError must carry its git provisioning cause",
		);
	});

	test("wraps a git error or a chain that holds one, and passes anything else through", () => {
		assert.ok(wrapGitRequired(OFFLINE, INPUT) instanceof WorkflowGitRequiredError);
		const nested = wrapGitRequired(new Error("outer", { cause: BUSY }), INPUT);
		assert.ok(nested instanceof WorkflowGitRequiredError);
		assert.equal((nested as WorkflowGitRequiredError).cause, BUSY);
		const reason = new Error("cancelled");
		assert.equal(wrapGitRequired(reason, INPUT), reason);
		const wrapped = new WorkflowGitRequiredError(INPUT, OFFLINE);
		assert.equal(wrapGitRequired(wrapped, TASK), wrapped);
	});
});
