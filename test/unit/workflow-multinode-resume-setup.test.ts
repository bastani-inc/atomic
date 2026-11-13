import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	captureWorktreeSnapshot,
	currentWorktreeRootMappings,
	DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
	type GitUnavailableError,
	hostPlatform,
	isResumePreconditionError,
	restoreRunWorktree,
	restoreWorktree,
	runRestorePreconditionError,
	SessionManager,
	setUpRestoredRunWorktrees,
	setWorktreeSnapshotGit,
	type WorktreeRootMapping,
	withWorktreeRootMappings,
} from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { resolveToCwd } from "../../packages/coding-agent/src/core/tools/path-utils.ts";
import { appendLineCommand, nodeCommand } from "../../packages/coding-agent/test/helpers/hook-commands.ts";
import { missingGit } from "../../packages/coding-agent/test/helpers/missing-git.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalOwnershipError } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import {
	StageWakeDispatcher,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { hostRestorePort } from "../../packages/workflows/src/workers/worker-host.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { openSqlSnapshotJournal, openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";
import { createStageContext, type InternalStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

useTemporaryAgentDir();

/** Longer than the test's own budget, so a build step the cancel does not stop fails the test. */
const CANCELLED_STEP_SLEEP_MS = 120_000;

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
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

const blueprintNotices = (store: Store) =>
	store.notices().filter((notice) => notice.id.startsWith("workflow-blueprint:"));

/** A run on "node A" that recorded snapshots of a checkout with a lockfile, failed, and whose checkout is then gone. */
async function runRecordedElsewhere(
	observe: (cwd: string) => void = () => {},
	removeCheckout = true,
	recordOpts: Partial<Pick<RunOpts, "snapshots">> = {},
	files: Record<string, string> = {},
	failedAttempts = 1,
) {
	const { clone } = await sandbox.remoteWithClone("repo", {
		"README.md": "hello\n",
		"package-lock.json": "{}\n",
		...files,
	});
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
			if (attempt++ < failedAttempts) throw new Error("node A stopped");
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
	return { clone, runId: first.runId, backend: fixture.backend, store, resume, rerun };
}

test("a run restored on another node runs its setup command once before live work, and its tools resolve node A's paths (#4329)", async () => {
	const marker = sandbox.path("setup-runs");
	writeSettings({ defaultProjectTrust: "always", resume: { setupCommand: appendLineCommand(marker, "ran") } });
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
	assert.equal(resolveToCwd(join(recorded.clone, "state.txt"), live!.cwd), join(recorded.clone, "state.txt"));
	assert.deepEqual(
		recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings?.map((mapping) => mapping.to),
		[live!.cwd],
	);
});

test("a run that restored nothing resolves every path its work names as given (#4329)", async () => {
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	cleanups.push(() => fixture.close());
	const elsewhere = join(sandbox.root, "elsewhere", "state.txt");
	const resolved: string[] = [];
	const definition = workflow({
		name: "restored-nothing",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			await ctx.tool("resolve", {}, async () => {
				resolved.push(resolveToCwd(elsewhere, ctx.cwd!));
				return "resolved";
			});
			return { ok: true };
		},
	});

	const result = await run(
		definition,
		{},
		{ cwd: sandbox.root, durableBackend: fixture.backend, store: createStore() },
	);

	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(resolved, [elsewhere]);
});

test("a run bound to an input worktree resumes on another node in the worktree restored for it (#4329)", async () => {
	const marker = sandbox.path("setup-runs");
	writeSettings({ defaultProjectTrust: "always", resume: { setupCommand: appendLineCommand(marker, "ran") } });
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

test("a run whose restore has no blueprint and no setup command resumes in the worktree restored for it (#4588)", async () => {
	writeSettings({});
	const live: string[] = [];
	const recorded = await runRecordedElsewhere((cwd) => {
		live.push(cwd);
	});

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(restoredWorktrees().length, 1);
	assert.equal(live.length, 1);
	assert.ok(live[0]!.startsWith(sandbox.path("agent", "worktree-snapshots", "worktrees")), live[0]);
	assert.deepEqual(
		recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings?.map((mapping) => mapping.to),
		[live[0]],
	);
	assert.deepEqual(blueprintNotices(recorded.store), []);
});

test("a direct run() of a run recorded elsewhere on a node without Git continues where it was started, restoring nothing (#4738)", async () => {
	writeSettings({});
	const cwds: string[] = [];
	const recorded = await runRecordedElsewhere((cwd) => cwds.push(cwd));
	setWorktreeSnapshotGit(async () => {
		throw missingGit();
	});

	const result = await recorded.rerun();

	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(cwds, [sandbox.root]);
	assert.deepEqual(restoredWorktrees(), []);
	const handle = recorded.backend.getWorkflow(recorded.runId);
	assert.equal(handle?.worktreeRootMappings, undefined);
	assert.equal(handle?.invocationCwd, recorded.clone);
	assert.deepEqual(
		handle?.worktreeRestoreOutcomes?.map((outcome) => [outcome.root, outcome.unrestored?.place]),
		[[recorded.clone, "launch"]],
	);
});

test("a direct run() of a run another node still holds is refused before anything is restored or set up (#4329)", async () => {
	const marker = sandbox.path("setup-runs");
	writeSettings({ defaultProjectTrust: "always", resume: { setupCommand: appendLineCommand(marker, "ran") } });
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

test("a trusted restore builds its repository's own blueprint in the restored worktree and keeps it (#4588)", async () => {
	writeSettings({ defaultProjectTrust: "always" });
	const marker = sandbox.path("blueprint-runs");
	const live: string[] = [];
	const recorded = await runRecordedElsewhere(
		(cwd) => {
			live.push(cwd);
		},
		true,
		{},
		{
			".atomic/blueprint.yaml": `runs-on: ${hostPlatform()}\nmaintenance: ${JSON.stringify(appendLineCommand(marker, "ran"))}\n`,
		},
	);

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(readFileSync(marker, "utf8"), "ran\n");
	assert.equal(live.length, 1);
	assert.equal(restoredWorktrees().length, 1);
	assert.deepEqual(
		recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings?.map((mapping) => mapping.to),
		[live[0]],
	);
	assert.deepEqual(blueprintNotices(recorded.store), []);
});

test("a run resumed again after its earlier build failed rebuilds that worktree once the environment is fixed (#4588)", async () => {
	writeSettings({ defaultProjectTrust: "always" });
	const marker = sandbox.path("blueprint-runs").replaceAll("\\", "/");
	const tool = sandbox.path("tool-installed").replaceAll("\\", "/");
	const recorded = await runRecordedElsewhere(
		() => {},
		true,
		{},
		{
			".atomic/blueprint.yaml": `runs-on: ${hostPlatform()}\ninitialize: test -f ${tool} && echo initialize >> ${marker}\nmaintenance: echo maintenance >> ${marker}\n`,
		},
		2,
	);

	const first = await recorded.resume();
	assert.equal(first.result.ok, true, first.result.message);
	await first.finished;
	assert.equal(existsSync(marker), false);
	assert.equal(blueprintNotices(recorded.store).length, 1);

	writeFileSync(tool, "installed\n");
	const second = await recorded.resume();
	assert.equal(second.result.ok, true, second.result.message);
	await second.finished;

	assert.equal(readFileSync(marker, "utf8"), "initialize\nmaintenance\n");
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings?.length, 1);
	assert.equal(restoredWorktrees().length, 1);
	const notices = blueprintNotices(recorded.store);
	assert.equal(notices.length, 1);
	assert.equal(new Set(notices.map((notice) => notice.id)).size, notices.length);
});

test("a run resumed again whose earlier build succeeded builds nothing and says nothing more (#4588)", async () => {
	writeSettings({ defaultProjectTrust: "always" });
	const marker = sandbox.path("blueprint-runs").replaceAll("\\", "/");
	const recorded = await runRecordedElsewhere(
		() => {},
		true,
		{},
		{ ".atomic/blueprint.yaml": `runs-on: ${hostPlatform()}\nmaintenance: echo maintenance >> ${marker}\n` },
		2,
	);
	const first = await recorded.resume();
	await first.finished;
	assert.equal(readFileSync(marker, "utf8"), "maintenance\n");
	const second = await recorded.resume();
	await second.finished;
	assert.equal(readFileSync(marker, "utf8"), "maintenance\n");
	assert.deepEqual(blueprintNotices(recorded.store), []);
});

test("the blueprint notices of two resumes of a run carry distinct ids, numbered from zero within a resume (#4588)", async () => {
	writeSettings({ defaultProjectTrust: "always", resume: { setupCommand: nodeCommand("process.exit(3)") } });
	const recorded = await runRecordedElsewhere(() => {}, true, {}, {}, 2);
	await (await recorded.resume()).finished;
	const firstIds = blueprintNotices(recorded.store).map((notice) => notice.id);
	assert.equal(firstIds.length, 2);
	await (await recorded.resume()).finished;
	const ids = blueprintNotices(recorded.store).map((notice) => notice.id);
	assert.ok(ids.length >= 4, ids.join(","));
	assert.equal(new Set(ids).size, ids.length);
	const pattern = new RegExp(`^workflow-blueprint:${recorded.runId}:[0-9a-f-]{36}:(\\d+)$`);
	assert.deepEqual(
		firstIds.map((id) => pattern.exec(id)?.[1]),
		["0", "1"],
	);
});

test("a restore whose project is not trusted runs no setup command and still resumes (#4588)", async () => {
	const marker = sandbox.path("setup-runs");
	writeSettings({ resume: { setupCommand: appendLineCommand(marker, "ran") } });
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(() => {
		liveRuns++;
	});

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(existsSync(marker), false);
	assert.equal(liveRuns, 1);
	assert.equal(restoredWorktrees().length, 1);
	assert.deepEqual(blueprintNotices(recorded.store), []);
});

test("a setup command that fails after a run's restore only warns: the run resumes and keeps the worktree (#4588)", async () => {
	writeSettings({ defaultProjectTrust: "always", resume: { setupCommand: nodeCommand("process.exit(3)") } });
	let liveRuns = 0;
	const recorded = await runRecordedElsewhere(() => {
		liveRuns++;
	});

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(liveRuns, 1);
	assert.equal(restoredWorktrees().length, 1);
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings?.length, 1);
	const notices = blueprintNotices(recorded.store);
	assert.ok(notices.length > 0);
	assert.ok(notices.every((notice) => notice.level === "warning" && notice.runId === recorded.runId));
});

test("a run whose recorded edits were committed here resumes in place with no restore (#4329)", async () => {
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

test("a run whose checkout is here but changed resumes in a worktree restored beside it (#4588)", async () => {
	writeSettings({});
	const live: string[] = [];
	const recorded = await runRecordedElsewhere((cwd) => {
		live.push(cwd);
	}, false);
	sandbox.write(join(recorded.clone, "state.txt"), "changed after the snapshot\n");

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(live.length, 1);
	assert.ok(live[0]!.startsWith(sandbox.path("agent", "worktree-snapshots", "worktrees")), live[0]);
	assert.equal(readFileSync(join(live[0]!, "state.txt"), "utf8"), "written on node A\n");
	assert.equal(readFileSync(join(recorded.clone, "state.txt"), "utf8"), "changed after the snapshot\n");
	assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings?.length, 1);
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

test("cancelling a run's resume stops the setup command of the checkout it restored and removes the worktree (#4329)", async () => {
	const started = sandbox.path("setup-started").replaceAll("\\", "/");
	writeSettings({
		defaultProjectTrust: "always",
		resume: {
			setupCommand: nodeCommand(
				`require('fs').writeFileSync('${started}', 'started'); setTimeout(() => {}, ${CANCELLED_STEP_SLEEP_MS})`,
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

test("a run whose checkout is still here resumes in place without a restore (#4329)", async () => {
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

test("the setup command's settings are read where the run runs, so another project's setup command does not run (#4329)", async () => {
	const marker = sandbox.path("setup-runs");
	writeSettings({ defaultProjectTrust: "always" });
	mkdirSync(sandbox.path(".atomic"), { recursive: true });
	writeFileSync(
		sandbox.path(".atomic", "settings.json"),
		JSON.stringify({ resume: { setupCommand: appendLineCommand(marker, "ran") } }),
	);
	const recorded = await runRecordedElsewhere();

	const { result, finished } = await recorded.resume();
	assert.equal(result.ok, true, result.message);
	await finished;

	assert.equal(existsSync(marker), false);
	assert.equal(restoredWorktrees().length, 1);
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

test("the pre-claim check reports missing Git for every checkout it must restore, and checks nothing when none is missing (#4329)", async () => {
	writeSettings({});
	const gitless = new CountingGit(missingGit());
	assert.equal(await runRestorePreconditionError("run-1", [], { io: gitless }), undefined);
	assert.equal(gitless.probes, 0);

	const error = await runRestorePreconditionError(
		"run-1",
		[
			{ root: "/node-a/one", remotes: [] },
			{ root: "/node-a/two", remotes: ["https://example.test/repo.git"] },
		],
		{ io: gitless },
	);

	assert.ok(isResumePreconditionError(error));
	assert.equal(error.entryPoint, "workflow-resume");
	assert.deepEqual(
		error.problems.map((problem) => problem.code),
		["git-unavailable"],
	);
	assert.equal(
		error.problems[0]?.why,
		"workflow run run-1 must restore /node-a/one, /node-a/two, which this node does not have",
	);
	assert.equal(gitless.probes, 1);
});

test("a restore with working Git has no unmet precondition, whatever blueprint or setup command this node has (#4588)", async () => {
	writeSettings({});
	const git = new CountingGit();
	const error = await runRestorePreconditionError("run-1", [{ root: "/node-a/one", remotes: [] }], { io: git });
	assert.equal(error, undefined);
	assert.equal(git.probes, 1);
});

test("a failing setup command never fails the build of restored worktrees nor removes them, and its warnings are reported (#4588)", async () => {
	writeSettings({ defaultProjectTrust: "always", resume: { setupCommand: nodeCommand("process.exit(3)") } });
	const worktree = (name: string) => {
		const root = sandbox.path("agent", "worktree-snapshots", "worktrees", name);
		sandbox.write(join(root, "package-lock.json"), "{}\n");
		return { root, remotes: [] };
	};
	const targets = [worktree("one"), worktree("two")];
	const reported: string[] = [];

	const blueprints = await setUpRestoredRunWorktrees(targets, {
		onNotices: (notices) => reported.push(...notices.map((notice) => notice.type)),
	});

	assert.equal(blueprints.outcome?.status, "failed");
	assert.ok(reported.length > 0);
	assert.ok(reported.every((type) => type === "warning"));
	assert.ok(blueprints.notices.length > 0);
	for (const target of targets) assert.equal(existsSync(target.root), true);
});

test("setting up restored worktrees stops with the signal's reason when the resume is cancelled (#4588)", async () => {
	writeSettings({ defaultProjectTrust: "always", resume: { setupCommand: nodeCommand("process.exit(0)") } });
	const root = sandbox.path("agent", "worktree-snapshots", "worktrees", "one");
	sandbox.write(join(root, "package-lock.json"), "{}\n");
	const stop = new Error("stop the resume");

	await assert.rejects(
		setUpRestoredRunWorktrees([{ root, remotes: [] }], { signal: AbortSignal.abort(stop) }),
		(error: unknown) => error === stop,
	);
	assert.equal(existsSync(root), true);
});

test("a worker host's restore without a blueprint or a setup command restores the worktree and resolves its root (#4588)", async () => {
	const hostAgentDir = sandbox.path("host-agent");
	mkdirSync(hostAgentDir, { recursive: true });
	writeFileSync(join(hostAgentDir, "settings.json"), "{}");
	let restores = 0;

	const restored = await restoreRunWorktree(
		["https://example.test/repo.git"],
		async () => {
			restores++;
			return sandbox.path("restored-elsewhere");
		},
		{ agentDir: hostAgentDir },
	);

	assert.deepEqual([restored, restores], [sandbox.path("restored-elsewhere"), 1]);
});

test("a worker host runs the setup command of its own agent directory in the worktree it restored (#4329)", async () => {
	const hostAgentDir = sandbox.path("host-agent");
	const marker = sandbox.path("host-setup-runs");
	mkdirSync(hostAgentDir, { recursive: true });
	writeFileSync(
		join(hostAgentDir, "settings.json"),
		JSON.stringify({
			defaultProjectTrust: "always",
			resume: {
				setupCommand: nodeCommand(
					`require('fs').appendFileSync('${marker.replaceAll("\\", "/")}', process.cwd() + '\\n')`,
				),
			},
		}),
	);
	writeSettings({});
	const worktree = join(hostAgentDir, "worktree-snapshots", "worktrees", "restored");
	const restore = async () => {
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, "package-lock.json"), "{}\n");
		return worktree;
	};

	const restored = await restoreRunWorktree(undefined, restore, { agentDir: hostAgentDir });

	assert.equal(restored, worktree);
	assert.equal(readFileSync(marker, "utf8"), `${realpathSync(worktree)}\n`);
	assert.equal(existsSync(sandbox.path("agent", "worktree-snapshots")), false);
});

test("a worker host whose setup command fails keeps the worktree it restored from its own store and reports the warning (#4588)", async () => {
	const hostAgentDir = sandbox.path("host-agent");
	mkdirSync(hostAgentDir, { recursive: true });
	writeFileSync(
		join(hostAgentDir, "settings.json"),
		JSON.stringify({ defaultProjectTrust: "always", resume: { setupCommand: nodeCommand("process.exit(3)") } }),
	);
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "package-lock.json": "{}\n" });
	sandbox.write(join(clone, "README.md"), "edited\n");
	const fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
	cleanups.push(() => fixture.close());
	const capture = await captureWorktreeSnapshot(clone, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		blobs: fixture.journal.snapshotBlobs,
	});
	if (capture.status !== "captured") throw new Error(capture.status);
	const warnings: string[] = [];

	const restored = await restoreRunWorktree(
		capture.snapshot.remotes,
		async () =>
			(
				await restoreWorktree(capture.snapshot, {
					blobs: fixture.journal.snapshotBlobs,
					storeDir: join(hostAgentDir, "worktree-snapshots"),
				})
			).path,
		{ agentDir: hostAgentDir, onNotices: (notices) => warnings.push(...notices.map((notice) => notice.type)) },
	);

	assert.ok(restored.startsWith(join(hostAgentDir, "worktree-snapshots")), restored);
	assert.equal(existsSync(restored), true);
	assert.equal(readFileSync(join(restored, "README.md"), "utf8"), "edited\n");
	assert.ok(warnings.length > 0);
	assert.ok(warnings.every((type) => type === "warning"));
});

describe("the restore port of a worker host (#4329)", () => {
	const git = { path: "git", env: {} };
	const shared = { recordedSnapshots: async () => [] } as unknown as Parameters<typeof hostRestorePort>[2];
	const journal = { snapshotBlobs: undefined } as unknown as Parameters<typeof hostRestorePort>[3];
	const binding = { remotes: [], head: "h", tree: "t" };

	test("a host given its own restore function runs it as it is, without the blueprint build", () => {
		const custom = async () => sandbox.path("custom");
		const options = { restore: custom } as unknown as Parameters<typeof hostRestorePort>[0];
		assert.equal(hostRestorePort(options, git, shared, journal, sandbox.path("host-agent")), custom);
	});

	test("the default port builds the blueprint of the host's own agent directory in the restored worktree and warns when it fails (#4588)", async () => {
		const hostAgentDir = sandbox.path("host-agent");
		mkdirSync(hostAgentDir, { recursive: true });
		writeFileSync(
			join(hostAgentDir, "settings.json"),
			JSON.stringify({ defaultProjectTrust: "always", resume: { setupCommand: nodeCommand("process.exit(3)") } }),
		);
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "package-lock.json": "{}\n" });
		const fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
		cleanups.push(() => fixture.close());
		const capture = await captureWorktreeSnapshot(clone, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: fixture.journal.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		const hostJournal = { snapshotBlobs: fixture.journal.snapshotBlobs } as unknown as Parameters<
			typeof hostRestorePort
		>[3];
		const hostGit = {
			path: sandbox.executable.path,
			env: { GIT_CONFIG_GLOBAL: sandbox.globalConfig, GIT_CONFIG_NOSYSTEM: "1", HOME: sandbox.root },
		};
		const port = hostRestorePort(
			{} as Parameters<typeof hostRestorePort>[0],
			hostGit,
			shared,
			hostJournal,
			hostAgentDir,
		)!;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const path = await port(binding as unknown as Parameters<typeof port>[0], {
				signal: new AbortController().signal,
				snapshot: capture.snapshot,
			});
			assert.equal(typeof path, "string", "an exact restore resolves the worktree's path alone");
			if (typeof path !== "string") return;

			assert.ok(path.startsWith(join(hostAgentDir, "worktree-snapshots")), path);
			assert.equal(existsSync(path), true);
			assert.ok(warn.mock.calls.length > 0);
			assert.ok(warn.mock.calls.every(([message]) => String(message).startsWith("atomic-workflows: ")));
		} finally {
			warn.mockRestore();
		}
	});
});

describe("a stage of a restored run, reopened from outside the run (#4329)", () => {
	const restore = {
		from: "/node-a/repo",
		to: "/node-b/worktree",
		snapshotId: "s".repeat(64),
		tree: "t".repeat(40),
		restoredAt: "2026-11-07T00:00:00.000Z",
	};

	test("opens every session it holds in the run's restores, also after it was released (#4329)", async () => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		await manager.appendMessage({ role: "user", content: "plan", timestamp: 1 });
		const dispatcher = new StageWakeDispatcher("run-restored", undefined);
		const wakeKey = stageWakeKey("run-restored", "stage-restored");
		dispatcher.open({ runId: "run-restored", stageId: "stage-restored", wakeKey });
		const scopes: (readonly WorktreeRootMapping[])[] = [];
		const ctx = withWorktreeRootMappings([restore], () =>
			createStageContext(
				makeOpts({
					runId: "run-restored",
					stageId: "stage-restored",
					stageName: "implement",
					waiting: {
						policy: { afterMs: 0 },
						dispatcher,
						wakeKey,
						async enter() {},
						async recordResults() {},
						resultsInTranscript() {},
						async leave() {},
						async reopenFailed() {},
						async rehydrated() {},
						resident() {},
					},
					adapters: {
						sessionStore: store,
						agentSession: {
							async create(options) {
								scopes.push(currentWorktreeRootMappings());
								const opened = options.sessionManager as SessionManager | undefined;
								return makeMockSession({ sessionId: opened?.getSessionId() ?? "session" }).session;
							},
						},
					},
					stageOptions: { sessionStore: store },
				}),
			),
		) as InternalStageContext;

		ctx.__startReleased?.({ kind: "release", since: 1, promptsCompleted: 1 }, manager.getSessionId());
		await ctx.rehydrate();
		await ctx.release();
		await ctx.rehydrate();

		assert.deepEqual(scopes, [[restore], [restore]]);
		assert.deepEqual(currentWorktreeRootMappings(), []);
	});
});
