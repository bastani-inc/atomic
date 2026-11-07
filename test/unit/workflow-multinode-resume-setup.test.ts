import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type GitUnavailableError,
	isResumePreconditionError,
	isResumeSetupHookError,
	ProjectTrustStore,
	restoreRunWorktree,
	runRestorePreconditionError,
	setUpRestoredRunWorktrees,
	setWorktreeSnapshotGit,
} from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import { clearWorktreeRootMappings } from "../../packages/coding-agent/src/core/resume/path-mapping.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { resolveToCwd } from "../../packages/coding-agent/src/core/tools/path-utils.ts";
import {
	appendLineCommand,
	nodeCommand,
	SUCCEEDING_COMMAND,
} from "../../packages/coding-agent/test/helpers/hook-commands.ts";
import { missingGit } from "../../packages/coding-agent/test/helpers/missing-git.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalOwnershipError } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { restorePreconditionsChecked } from "../../packages/workflows/src/durable/run-restore-preconditions.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

useTemporaryAgentDir();

/** Longer than the test's own budget, so a hook the cancel does not stop fails the test. */
const CANCELLED_HOOK_SLEEP_MS = 120_000;

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
	clearWorktreeRootMappings();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	clearWorktreeRootMappings();
	sandbox.dispose();
});

function writeSettings(settings: object): void {
	mkdirSync(sandbox.path("agent"), { recursive: true });
	writeFileSync(sandbox.path("agent", "settings.json"), JSON.stringify(settings));
}

const restoredWorktrees = () =>
	existsSync(sandbox.path("agent", "worktree-snapshots", "worktrees"))
		? readdirSync(sandbox.path("agent", "worktree-snapshots", "worktrees"))
		: [];

/** A run on "node A" that recorded snapshots of a checkout with a lockfile, failed, and whose checkout is then gone. */
async function runRecordedElsewhere(
	observe: (cwd: string) => void = () => {},
	removeCheckout = true,
	recordOpts: Partial<Pick<RunOpts, "snapshots">> = {},
) {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "package-lock.json": "{}\n" });
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	cleanups.push(() => fixture.close());
	const store = createStore();
	let attempt = 0;
	const definition = workflow({
		name: "recorded-elsewhere",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "state.txt"), "written on node A\n");
				return "written";
			});
			if (attempt++ === 0) throw new Error("node A stopped");
			observe(ctx.cwd!);
			return { ok: true };
		},
	});
	const first = await run(definition, {}, { ...recordOpts, cwd: clone, durableBackend: fixture.backend, store });
	assert.equal(first.status, "failed");
	if (removeCheckout) rmSync(clone, { recursive: true, force: true });
	const resume = async (signal?: AbortSignal, jobs = createJobTracker()) => {
		const result = await resumeDurableWorkflow(first.runId, {
			registry: createRegistry().register(definition),
			durableBackend: fixture.backend,
			baseRunOpts: { cwd: sandbox.root, store, durableBackend: fixture.backend },
			jobs,
			signal,
		});
		return { result, finished: jobs.get(first.runId)?.promise };
	};
	const rerun = (extra: Partial<RunOpts> = {}) =>
		run(definition, {}, { runId: first.runId, cwd: sandbox.root, durableBackend: fixture.backend, store, ...extra });
	return { clone, runId: first.runId, backend: fixture.backend, resume, rerun };
}

test("a run restored on another node runs its setup hook once before live work, and its tools resolve node A's paths (#4329)", async () => {
	const marker = sandbox.path("setup-runs");
	writeSettings({ resume: { setupCommand: appendLineCommand(marker, "ran") } });
	const seen: { cwd: string; hookRuns: number; resolved: string }[] = [];
	const recorded = await runRecordedElsewhere((cwd) => {
		seen.push({
			cwd,
			hookRuns: readFileSync(marker, "utf8").trim().split("\n").length,
			resolved: resolveToCwd(join(recorded.clone, "state.txt"), cwd),
		});
	});

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(seen.length, 1);
	const [live] = seen;
	assert.ok(live!.cwd.startsWith(sandbox.path("agent", "worktree-snapshots", "worktrees")), live!.cwd);
	assert.equal(live!.hookRuns, 1);
	assert.equal(live!.resolved, join(live!.cwd, "state.txt"));
	assert.equal(readFileSync(live!.resolved, "utf8"), "written on node A\n");
	assert.deepEqual(
		recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings?.map((mapping) => mapping.to),
		[live!.cwd],
	);
});

test("a run bound to an input worktree resumes on another node in the worktree restored for it (#4329)", async () => {
	const marker = sandbox.path("setup-runs");
	writeSettings({ resume: { setupCommand: appendLineCommand(marker, "ran") } });
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "package-lock.json": "{}\n" });
	const inputWorktree = sandbox.path("node-a-worktree");
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	cleanups.push(() => fixture.close());
	const store = createStore();
	let attempt = 0;
	let toolRuns = 0;
	const liveCwds: string[] = [];
	const definition = workflow({
		name: "input-worktree-elsewhere",
		description: "",
		inputs: { git_worktree_dir: Type.String() },
		outputs: { ok: Type.Boolean() },
		worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				toolRuns++;
				sandbox.write(join(ctx.cwd!, "state.txt"), "written on node A\n");
				return "written";
			});
			if (attempt++ === 0) throw new Error("node A stopped");
			liveCwds.push(ctx.cwd!);
			return { ok: true };
		},
	});
	const first = await run(
		definition,
		{ git_worktree_dir: inputWorktree },
		{ cwd: clone, durableBackend: fixture.backend, store },
	);
	assert.equal(first.status, "failed");
	await sandbox.git(clone, "worktree", "remove", "--force", inputWorktree);
	rmSync(clone, { recursive: true, force: true });

	const jobs = createJobTracker();
	const result = await resumeDurableWorkflow(first.runId, {
		registry: createRegistry().register(definition),
		durableBackend: fixture.backend,
		baseRunOpts: { cwd: sandbox.root, store, durableBackend: fixture.backend },
		jobs,
	});
	assert.equal(result.ok, true, result.message);
	await jobs.get(first.runId)?.promise;

	const mappings = fixture.backend.getWorkflow(first.runId)?.worktreeRootMappings ?? [];
	assert.deepEqual(
		mappings.map((mapping) => resolve(mapping.from)),
		[resolve(inputWorktree)],
	);
	assert.deepEqual(
		liveCwds.map((cwd) => resolve(cwd)),
		[resolve(mappings[0]!.to)],
	);
	assert.equal(readFileSync(join(liveCwds[0]!, "state.txt"), "utf8"), "written on node A\n");
	assert.equal(toolRuns, 1);
	assert.equal(readFileSync(marker, "utf8"), "ran\n");
	assert.equal(existsSync(inputWorktree), false);
});

test("a run whose restore needs a setup hook that cannot run fails typed before it is claimed (#4329)", async () => {
	writeSettings({});
	const recorded = await runRecordedElsewhere();
	const statusBefore = recorded.backend.getWorkflow(recorded.runId)?.status;

	const { result } = await recorded.resume();

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, "startup_failed");
	assert.ok(isResumePreconditionError(result.error));
	assert.equal(result.error.entryPoint, "workflow-resume");
	assert.deepEqual(
		result.error.problems.map((problem) => problem.code),
		["setup-hook-missing"],
	);
	assert.equal(result.message, result.error.message);
	assert.deepEqual(restoredWorktrees(), []);
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings, undefined);
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.status, statusBefore);
});

test("a direct run() of a run recorded elsewhere checks its restore preconditions before restoring anything (#4329)", async () => {
	writeSettings({});
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(() => {
		liveRuns++;
	});

	await assert.rejects(recorded.rerun(), (error: unknown) => {
		assert.ok(isResumePreconditionError(error));
		assert.equal(error.entryPoint, "workflow-resume");
		assert.deepEqual(
			error.problems.map((problem) => problem.code),
			["setup-hook-missing"],
		);
		return true;
	});
	assert.equal(liveRuns, 0);
	assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings, undefined);
});

test("a direct run() of a run another node still holds is refused before anything is restored or set up (#4329)", async () => {
	const marker = sandbox.path("setup-runs");
	writeSettings({ resume: { setupCommand: appendLineCommand(marker, "ran") } });
	const recorded = await runRecordedElsewhere();
	const held = await recorded.backend.snapshotJournal.acquire(recorded.runId, "node-a-still-running");
	assert.equal(held.status, "acquired");

	await assert.rejects(
		recorded.rerun(),
		(error: unknown) =>
			error instanceof JournalOwnershipError &&
			error.runId === recorded.runId &&
			error.holderId === "node-a-still-running",
	);

	assert.deepEqual(restoredWorktrees(), []);
	assert.equal(existsSync(marker), false);
});

test("a direct run() judges its own checkout under the snapshot settings the run recorded with (#4329)", async () => {
	writeSettings({});
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(
		() => {
			liveRuns++;
		},
		false,
		{ snapshots: { includeUntracked: false } },
	);
	sandbox.write(join(recorded.clone, "untracked.txt"), "left out of this run's snapshots\n");

	const result = await recorded.rerun({ cwd: recorded.clone });

	assert.equal(result.status, "completed", result.error);
	assert.equal(liveRuns, 1);
	assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
});

test.skipIf(process.platform === "win32")(
	"a run's resume checks its restore preconditions once: run() trusts the check made before the claim (#4329)",
	async () => {
		writeSettings({ resume: { setupCommand: "true" } });
		const recorded = await runRecordedElsewhere();
		const calls = sandbox.path("git-calls.log");
		const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
		const shim = sandbox.path("counting-git");
		writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nexec "${realGit}" "$@"\n`);
		chmodSync(shim, 0o755);
		setWorktreeSnapshotGit(async () => ({ path: shim, env: {} }));

		const { result, finished } = await recorded.resume();
		assert.equal(result.ok, true, result.message);
		await finished;

		const probes = readFileSync(calls, "utf8")
			.split("\n")
			.filter((line) => line.endsWith("--version"));
		assert.equal(probes.length, 1);
	},
);

test("run() does not check the restore preconditions again when the resume that launched it already did (#4329)", async () => {
	writeSettings({});
	const recorded = await runRecordedElsewhere();

	await assert.rejects(recorded.rerun({ [restorePreconditionsChecked]: true }), (error: unknown) => {
		assert.ok(isResumePreconditionError(error));
		return true;
	});
	assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots", "worktrees")), true);
	assert.deepEqual(restoredWorktrees(), []);
});

test("a trusted restore whose repository has no .atomic/setup is removed again and records no mapping (#4329)", async () => {
	writeSettings({ defaultProjectTrust: "always" });
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(() => {
		liveRuns++;
	});

	const { result } = await recorded.resume();

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, "startup_failed");
	assert.ok(isResumePreconditionError(result.error));
	assert.deepEqual(
		result.error.problems.map((problem) => [problem.code, problem.subject]),
		[["setup-hook-missing", "setup hook"]],
	);
	assert.ok(result.message.endsWith(result.error.message), result.message);
	assert.equal(result.error.entryPoint, "workflow-resume");
	assert.equal((result.error as Error & { cleanupCause?: unknown }).cleanupCause, undefined);
	assert.equal(liveRuns, 0);
	assert.deepEqual(restoredWorktrees(), []);
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings, undefined);
});

test("a setup hook that fails after a run's restore ends the resume typed with its exit status and removes the worktree (#4329)", async () => {
	writeSettings({ resume: { setupCommand: nodeCommand("process.exit(3)") } });
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(() => {
		liveRuns++;
	});

	const { result } = await recorded.resume();

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.ok(isResumeSetupHookError(result.error));
	assert.deepEqual([result.error.code, result.error.exitStatus], ["setup-hook-failed", 3]);
	assert.equal(
		result.error.hint,
		`Fix the hook (its output is in ${result.error.logPath}), then resume again; the hook runs again.`,
	);
	assert.equal(liveRuns, 0);
	assert.deepEqual(restoredWorktrees(), []);
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings, undefined);
});

test("a run whose recorded edits were committed here resumes in place with no setup check (#4329)", async () => {
	writeSettings({});
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(() => {
		liveRuns++;
	}, false);
	await sandbox.commitAll(recorded.clone, "commit the recorded edits");

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(liveRuns, 1);
	assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings, undefined);
});

test("a run whose checkout is here but changed gets the pre-claim check before anything is restored (#4329)", async () => {
	writeSettings({});
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(() => {
		liveRuns++;
	}, false);
	sandbox.write(join(recorded.clone, "state.txt"), "changed after the snapshot\n");

	const { result } = await recorded.resume();

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.ok(isResumePreconditionError(result.error));
	assert.equal(result.error.problems[0]?.code, "setup-hook-missing");
	assert.ok(result.error.problems[0]?.why.startsWith("the snapshot has dependency inputs"), result.error.message);
	assert.equal(liveRuns, 0);
	assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings, undefined);
});

test("a run's own snapshot settings decide whether its checkout changed before the claim (#4329)", async () => {
	writeSettings({});
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(
		() => {
			liveRuns++;
		},
		false,
		{ snapshots: { includeUntracked: false } },
	);
	sandbox.write(join(recorded.clone, "untracked.txt"), "left out of this run's snapshots\n");

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(liveRuns, 1);
	assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
});

test("cancelling a run's resume stops the setup hook of the checkout it restored and removes the worktree (#4329)", async () => {
	const started = sandbox.path("hook-started").replaceAll("\\", "/");
	writeSettings({
		resume: {
			setupCommand: nodeCommand(
				`require('fs').writeFileSync('${started}', 'started'); setTimeout(() => {}, ${CANCELLED_HOOK_SLEEP_MS})`,
			),
		},
	});
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(() => {
		liveRuns++;
	});
	const jobs = createJobTracker();
	const controller = new AbortController();
	const stop = new Error("stop the resume");
	const poll = setInterval(() => {
		if (existsSync(started)) controller.abort(stop);
	}, 20);
	try {
		await assert.rejects(recorded.resume(controller.signal, jobs), (error: unknown) => error === stop);
	} finally {
		clearInterval(poll);
	}
	await jobs.get(recorded.runId)?.promise.catch(() => undefined);
	assert.equal(existsSync(started), true);
	assert.equal(liveRuns, 0);
	assert.deepEqual(restoredWorktrees(), []);
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings, undefined);
});

test("a run whose checkout is still here resumes in place without a setup hook (#4329)", async () => {
	writeSettings({});
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(() => {
		liveRuns++;
	}, false);

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(liveRuns, 1);
	assert.deepEqual(restoredWorktrees(), []);
});

test("a run on a backend without a snapshot journal resumes with no restore check (#4329)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	cleanups.push(() => fixture.close());
	const store = createStore();
	let attempts = 0;
	const definition = workflow({
		name: "without-snapshot-journal",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => "written");
			if (attempts++ === 0) throw new Error("stopped");
			return { ok: true };
		},
	});
	const first = await run(definition, {}, { cwd: clone, durableBackend: fixture.backend, store });
	assert.equal(first.status, "failed");
	const withoutJournal = new Proxy(fixture.backend, {
		get(target, key) {
			if (key === "snapshotJournal") return undefined;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const jobs = createJobTracker();

	const result = await resumeDurableWorkflow(first.runId, {
		registry: createRegistry().register(definition),
		durableBackend: withoutJournal,
		baseRunOpts: { cwd: clone, store: createStore(), durableBackend: withoutJournal },
		jobs,
	});
	assert.equal(result.ok, true, result.message);
	await jobs.get(first.runId)?.promise;

	assert.equal(attempts, 2);
});

test("the hook's settings are read where the run runs, so another project's setup command does not count (#4329)", async () => {
	writeSettings({});
	mkdirSync(sandbox.path(".atomic"), { recursive: true });
	writeFileSync(
		sandbox.path(".atomic", "settings.json"),
		JSON.stringify({ resume: { setupCommand: SUCCEEDING_COMMAND } }),
	);
	const recorded = await runRecordedElsewhere();

	const { result } = await recorded.resume();

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.ok(isResumePreconditionError(result.error));
	assert.equal(result.error.problems[0]?.code, "setup-hook-missing");
	assert.ok(result.error.problems[0]?.why.startsWith("the snapshot has dependency inputs"), result.error.message);
	assert.deepEqual(restoredWorktrees(), []);
});

test("a startup failure that is not a resume failure keeps its own message and carries no typed error (#4329)", async () => {
	writeSettings({});
	const { clone } = await sandbox.remoteWithClone();
	writeFileSync(sandbox.path("partial-wt"), "not a directory\n");
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	cleanups.push(() => fixture.close());
	const definition = workflow({
		name: "worktree-setup-fails",
		description: "",
		inputs: { git_worktree_dir: Type.String() },
		outputs: {},
		worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
		run: async (ctx) => {
			await ctx.tool("unreached", {}, async () => "done");
			return {};
		},
	}) as unknown as WorkflowDefinition;
	await fixture.backend.commitWorkflowRegistration({
		workflowId: testRunId("setup-fails"),
		name: "worktree-setup-fails",
		inputs: { git_worktree_dir: "../partial-wt" },
		createdAt: 1,
		status: "failed",
		completedCheckpoints: 1,
		invocationCwd: clone,
		resumable: true,
	});

	const result = await resumeDurableWorkflow(testRunId("setup-fails"), {
		registry: createRegistry().register(definition),
		durableBackend: fixture.backend,
		baseRunOpts: { cwd: clone, store: createStore(), durableBackend: fixture.backend },
		jobs: createJobTracker(),
	});

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, "startup_failed");
	assert.match(result.message, /already exists but is not a directory/);
	assert.equal("error" in result, false);
});

class CountingGit {
	probes = 0;
	constructor(private readonly gitError?: GitUnavailableError) {}
	async loadAdapter(): Promise<void> {}
	async readText(): Promise<string> {
		return "";
	}
	env(): string | undefined {
		return undefined;
	}
	async probeGit(): Promise<GitUnavailableError | undefined> {
		this.probes++;
		return this.gitError;
	}
}

test("the pre-claim check reports missing Git and a missing hook together, and checks nothing when no checkout is missing (#4329)", async () => {
	writeSettings({});
	const gitless = new CountingGit(missingGit());
	assert.equal(await runRestorePreconditionError("run-1", [], { io: gitless }), undefined);
	assert.equal(gitless.probes, 0);

	const error = await runRestorePreconditionError(
		"run-1",
		[
			{ root: "/node-a/one", envHash: "e".repeat(64) },
			{ root: "/node-a/two", envHash: "f".repeat(64) },
		],
		{ io: gitless },
	);

	assert.ok(isResumePreconditionError(error));
	assert.equal(error.entryPoint, "workflow-resume");
	assert.deepEqual(
		error.problems.map((problem) => problem.code),
		["git-unavailable", "setup-hook-missing"],
	);
	assert.equal(
		error.problems[0]?.why,
		"workflow run run-1 must restore /node-a/one, /node-a/two, which this node does not have",
	);
	assert.equal(gitless.probes, 1);
});

test("a saved trust decision for restored worktrees lets the repository's hook stand in for a setup command (#4329)", async () => {
	writeSettings({});
	new ProjectTrustStore(sandbox.path("agent")).set(sandbox.path("agent", "worktree-snapshots", "worktrees"), true);
	const error = await runRestorePreconditionError("run-1", [{ root: "/node-a/one", envHash: "e".repeat(64) }], {
		io: new CountingGit(),
	});
	assert.equal(error, undefined);
});

test("a rollback that cannot remove restored worktrees keeps the setup failure and attaches every cleanup failure (#4329)", async () => {
	writeSettings({});
	const worktree = (name: string) => {
		const root = sandbox.path("agent", "worktree-snapshots", "worktrees", name);
		sandbox.write(join(root, "package-lock.json"), "{}\n");
		return { root, envHash: "e".repeat(64) };
	};
	const single = await setUpRestoredRunWorktrees([worktree("one")]).then(
		() => assert.fail("no hook can run"),
		(failure: Error) => failure,
	);
	assert.ok(isResumePreconditionError(single));
	const cleanup = (single as Error & { cleanupCause?: unknown }).cleanupCause;
	assert.ok(cleanup instanceof Error && !(cleanup instanceof AggregateError));
	assert.equal(Object.keys(single).includes("cleanupCause"), false);

	const both = await setUpRestoredRunWorktrees([worktree("two"), worktree("three")]).then(
		() => assert.fail("no hook can run"),
		(failure: Error) => failure,
	);
	assert.ok(isResumePreconditionError(both));
	const causes = (both as Error & { cleanupCause?: unknown }).cleanupCause;
	assert.ok(causes instanceof AggregateError);
	assert.equal(causes.errors.length, 2);
	assert.equal(causes.message, "worktree cleanup failed");
});

test("a project's own resume.setupCommand never runs: only the global setting counts (#4329)", async () => {
	const project = sandbox.path("untrusted-project");
	mkdirSync(join(project, ".atomic"), { recursive: true });
	writeFileSync(
		join(project, ".atomic", "settings.json"),
		JSON.stringify({ resume: { setupCommand: "project-command" } }),
	);
	writeSettings({});
	assert.equal(SettingsManager.create(project, sandbox.path("agent")).getResumeSetupCommand(), undefined);
	const predicted = await runRestorePreconditionError("run-1", [{ root: "/node-a/one", envHash: "e".repeat(64) }], {
		io: new CountingGit(),
	});
	assert.equal(predicted?.problems[0]?.code, "setup-hook-missing");

	writeSettings({ resume: { setupCommand: "global-command" } });
	assert.equal(SettingsManager.create(project, sandbox.path("agent")).getResumeSetupCommand(), "global-command");
	assert.equal(
		await runRestorePreconditionError("run-1", [{ root: "/node-a/one", envHash: "e".repeat(64) }], {
			io: new CountingGit(),
		}),
		undefined,
	);
});

test("a worker host's restore that needs a setup hook none can run is refused before anything is restored (#4329)", async () => {
	const hostAgentDir = sandbox.path("host-agent");
	mkdirSync(hostAgentDir, { recursive: true });
	writeFileSync(join(hostAgentDir, "settings.json"), "{}");
	let restores = 0;

	await assert.rejects(
		restoreRunWorktree(
			"e".repeat(64),
			async () => {
				restores++;
				return sandbox.path("never");
			},
			{ agentDir: hostAgentDir },
		),
		(error: unknown) =>
			isResumePreconditionError(error) &&
			error.entryPoint === "workflow-resume" &&
			error.problems.map((problem) => problem.code).join() === "setup-hook-missing",
	);
	assert.equal(restores, 0);
});

test("a worker host runs the setup hook of its own agent directory once in the worktree it restored (#4329)", async () => {
	const hostAgentDir = sandbox.path("host-agent");
	const marker = sandbox.path("host-hook-runs");
	mkdirSync(hostAgentDir, { recursive: true });
	writeFileSync(
		join(hostAgentDir, "settings.json"),
		JSON.stringify({ resume: { setupCommand: appendLineCommand(marker, "ran") } }),
	);
	writeSettings({});
	const worktree = join(hostAgentDir, "worktree-snapshots", "worktrees", "restored");
	const restore = async () => {
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, "package-lock.json"), "{}\n");
		return worktree;
	};

	const restored = await restoreRunWorktree("e".repeat(64), restore, { agentDir: hostAgentDir });
	await restoreRunWorktree("e".repeat(64), async () => worktree, { agentDir: hostAgentDir });

	assert.equal(restored, worktree);
	assert.equal(readFileSync(marker, "utf8"), "ran\n");
	assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
});
