import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import { afterEach, test } from "vitest";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import {
	resumeRunWorktree,
	trackedRunWorktreeCount,
} from "../../packages/subagents/src/runs/foreground/run-worktrees.js";
import { SUBAGENT_CHILD_RECORD_TYPE } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import type { SubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { bunExecutable, moduleDir, readStreamText, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function git(cwd: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", ...args], { cwd, env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString("utf8").trim();
}

/** A repository on `main` with one commit, in a directory of its own. */
function makeRepo(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-named-worktree-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-q", "-m", "init");
	return repo;
}

const agent: AgentConfig = {
	name: "worker",
	description: "worker",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "Test agent",
	source: "project",
	filePath: "/tmp/worker.md",
};

interface Harness {
	readonly launches: Array<{ task: string; cwd: string | undefined; trackedWorktrees: number }>;
	readonly records: SubagentChildRecord[];
	execute(params: SubagentParamsLike): Promise<SubagentToolResult>;
}

function makeHarness(cwd: string): Harness {
	const launches: Harness["launches"] = [];
	const records: SubagentChildRecord[] = [];
	const executor = createSubagentExecutor({
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent",
			appendEntry: async (customType: string, data: SubagentChildRecord) => {
				if (customType === SUBAGENT_CHILD_RECORD_TYPE) records.push(data);
			},
		} as unknown as ExecutorDeps["pi"],
		state: {
			baseCwd: "",
			currentSessionId: null,
			subagentInProgress: false,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: { parallel: { concurrency: 4, maxTasks: 50 } },
		tempArtifactsDir: join(cwd, "..", "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "..", "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent] }),
		runtime: {
			runSync: async (_cwd, _agents, name, task, options): Promise<SingleResult> => {
				launches.push({ task, cwd: options.cwd, trackedWorktrees: trackedRunWorktreeCount() });
				return { agent: name, task, status: "ok", messages: [], usage, finalOutput: "done" };
			},
		},
	});
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => `parent-${Math.random()}`,
			getLeafId: () => null,
			getEntries: () => [],
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	return {
		launches,
		records,
		execute: (params) => executor.execute("call", params, new AbortController().signal, undefined, ctx),
	};
}

function text(result: SubagentToolResult): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

test("a single launch with a named worktree creates it, runs the child there, keeps it, and reuses it (#5202)", async () => {
	const repo = makeRepo();
	const harness = makeHarness(repo);
	const params = { agent: "worker", task: "build it", worktree: { branch: "feat/named" } };
	assert.equal(Value.Check(SubagentParams, params), true, "the schema accepts a named worktree");

	const first = await harness.execute(params);

	assert.equal(first.isError, undefined, text(first));
	const expected = join(repo, ".atomic", "worktrees", "feat+named");
	assert.equal(harness.launches[0]?.cwd, expected, "the child runs in the named worktree");
	assert.equal(git(expected, "rev-parse", "--abbrev-ref", "HEAD"), "feat/named");
	assert.equal(git(expected, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"), "from HEAD when no upstream");
	assert.ok(existsSync(expected), "a named worktree is never removed with the run");
	const recorded = harness.records.find((record) => record.worktree !== undefined)?.worktree;
	assert.equal(recorded?.path, expected, "the child's record names its worktree");
	assert.equal(recorded?.branch, "feat/named");
	assert.equal(recorded?.named, true);
	assert.equal(recorded?.baseCommit, git(repo, "rev-parse", "HEAD"));
	assert.deepEqual(recorded?.syntheticPaths, []);

	const second = await harness.execute({ ...params, task: "continue" });

	assert.equal(second.isError, undefined, text(second));
	assert.equal(harness.launches[1]?.cwd, expected, "the same branch at the same path is reused");
	assert.equal(git(repo, "rev-parse", "--verify", "refs/heads/feat/named").length > 0, true, "its branch is kept");
});

test("a named worktree starts from base and at the requested path (#5202)", async () => {
	const repo = makeRepo();
	const first = git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "later.txt"), "later\n");
	git(repo, "add", "later.txt");
	git(repo, "commit", "-q", "-m", "later");
	const harness = makeHarness(repo);
	const path = join(repo, "..", "elsewhere");

	const result = await harness.execute({
		agent: "worker",
		task: "t",
		worktree: { branch: "from-base", base: first, path },
	});

	assert.equal(result.isError, undefined, text(result));
	assert.equal(harness.launches[0]?.cwd, path);
	assert.equal(git(path, "rev-parse", "HEAD"), first);
	assert.equal(existsSync(join(repo, ".atomic")), false, "a worktree elsewhere leaves the repository untouched");
});

test("a named worktree whose branch is checked out elsewhere is refused before launch (#5202)", async () => {
	const repo = makeRepo();
	const harness = makeHarness(repo);

	const result = await harness.execute({ agent: "worker", task: "t", worktree: { branch: "main" } });

	assert.equal(result.isError, true);
	assert.deepEqual(result.details, { mode: "single", results: [] });
	assert.match(text(result), /branch "main" is already checked out at /);
	assert.equal(harness.launches.length, 0, "no child starts");
});

test("a named worktree path that holds something else is refused before launch (#5202)", async () => {
	const repo = makeRepo();
	const harness = makeHarness(repo);
	const path = join(repo, "..", "occupied");
	mkdirSync(path);
	writeFileSync(join(path, "file.txt"), "not a worktree\n");

	const result = await harness.execute({ agent: "worker", task: "t", worktree: { branch: "fresh", path } });

	assert.equal(result.isError, true);
	assert.match(text(result), /already exists and is not the worktree of branch "fresh"/);
	assert.equal(harness.launches.length, 0);
});

test("parallel tasks and sibling single calls each get their own named worktree (#5202)", async () => {
	const repo = makeRepo();
	const harness = makeHarness(repo);

	const parallel = await harness.execute({
		tasks: [
			{ agent: "worker", task: "a", worktree: { branch: "task-a" } },
			{ agent: "worker", task: "b", worktree: { branch: "task-b" } },
		],
	});
	assert.equal(parallel.isError, undefined, text(parallel));
	const siblings = await Promise.all([
		harness.execute({ agent: "worker", task: "c", worktree: { branch: "task-c" } }),
		harness.execute({ agent: "worker", task: "d", worktree: { branch: "task-d" } }),
	]);
	for (const sibling of siblings) assert.equal(sibling.isError, undefined, text(sibling));
	const parallelSiblings = await Promise.all([
		harness.execute({
			worktree: { branch: "task-e" },
			tasks: [
				{ agent: "worker", task: "e" },
				{ agent: "worker", task: "f", worktree: { branch: "task-f" } },
			],
		}),
		harness.execute({ worktree: { branch: "task-g" }, tasks: [{ agent: "worker", task: "g" }] }),
	]);
	for (const sibling of parallelSiblings) assert.equal(sibling.isError, undefined, text(sibling));

	const cwdOf = (task: string) => harness.launches.find((launch) => launch.task.endsWith(task))?.cwd;
	assert.deepEqual(
		[
			...new Set(
				harness.records
					.filter((record) => record.worktree)
					.map((record) => `${record.agent}:${record.task}:${record.worktree?.branch}`),
			),
		].sort(),
		["a", "b", "c", "d", "e", "f", "g"].map((name) => `worker:${name}:task-${name}`),
		"each child's record names its own worktree",
	);
	for (const name of ["a", "b", "c", "d", "e", "f", "g"])
		assert.equal(cwdOf(name), join(repo, ".atomic", "worktrees", `task-${name}`), `task ${name}`);
});

test("a missing cwd is refused before launch with the hint about a parallel tool call (#5202)", async () => {
	const repo = makeRepo();
	const harness = makeHarness(repo);
	const missing = join(repo, "..", "not-yet-created");

	const result = await harness.execute({ agent: "worker", task: "t", cwd: missing });

	assert.equal(result.isError, true);
	assert.match(text(result), /cwd does not exist: .*not-yet-created/);
	assert.match(text(result), /parallel tool call in this same turn/);
	assert.match(text(result), /worktree: \{ branch/);
	assert.equal(harness.launches.length, 0);
});

test("a parallel call's named worktree applies to each task without its own, and cannot mix with worktree: true (#5202)", async () => {
	const repo = makeRepo();
	const harness = makeHarness(repo);

	const shared = await harness.execute({
		worktree: { branch: "shared" },
		tasks: [
			{ agent: "worker", task: "one" },
			{ agent: "worker", task: "two", worktree: { branch: "own" } },
		],
	});

	assert.equal(shared.isError, undefined, text(shared));
	const cwdOf = (task: string) => harness.launches.find((launch) => launch.task.endsWith(task))?.cwd;
	assert.equal(cwdOf("one"), join(repo, ".atomic", "worktrees", "shared"));
	assert.equal(cwdOf("two"), join(repo, ".atomic", "worktrees", "own"));

	const mixed = await harness.execute({
		worktree: true,
		tasks: [
			{ agent: "worker", task: "three", worktree: { branch: "mixed" } },
			{ agent: "worker", task: "four" },
		],
	});
	assert.equal(mixed.isError, true);
	assert.match(text(mixed), /cannot be combined with a task's named worktree/);
	const isolatedWithCwd = await harness.execute({
		worktree: true,
		tasks: [{ agent: "worker", task: "five", cwd: ".." }],
	});
	assert.match(
		text(isolatedWithCwd),
		/Remove task-level cwd overrides or disable worktree/,
		"worktree: true is unchanged",
	);
	const unknown = await harness.execute({ agent: "nobody", task: "six", worktree: { branch: "unknown" } });
	assert.equal(unknown.isError, true);
	assert.match(text(unknown), /Unknown agent/);
	assert.equal(harness.launches.length, 2);
});

test("a named worktree checks out an existing branch as it is, follows the upstream, and keeps the cwd's subdirectory (#5202)", async () => {
	const repo = makeRepo();
	mkdirSync(join(repo, "pkg"));
	writeFileSync(join(repo, "pkg", "index.ts"), "export {};\n");
	git(repo, "add", "pkg");
	git(repo, "commit", "-q", "-m", "pkg");
	writeFileSync(join(repo, "later.txt"), "later\n");
	git(repo, "add", "later.txt");
	git(repo, "commit", "-q", "-m", "later");
	const tip = git(repo, "rev-parse", "HEAD");
	git(repo, "branch", "existing", "HEAD~1");
	git(repo, "branch", "upstream-base", "HEAD~1");
	git(repo, "branch", "--set-upstream-to=upstream-base");
	const harness = makeHarness(repo);

	const existing = await harness.execute({ agent: "worker", task: "e", worktree: { branch: "existing" } });
	const fresh = await harness.execute({ agent: "worker", task: "f", cwd: "pkg", worktree: { branch: "fresh" } });

	assert.equal(existing.isError, undefined, text(existing));
	assert.equal(fresh.isError, undefined, text(fresh));
	const existingPath = join(repo, ".atomic", "worktrees", "existing");
	assert.equal(
		git(existingPath, "rev-parse", "HEAD"),
		git(repo, "rev-parse", "existing"),
		"an existing branch as it is",
	);
	const freshPath = join(repo, ".atomic", "worktrees", "fresh");
	assert.equal(git(freshPath, "rev-parse", "HEAD"), git(repo, "rev-parse", "upstream-base"), "from HEAD's upstream");
	assert.notEqual(git(freshPath, "rev-parse", "HEAD"), tip);
	assert.equal(harness.launches[1]?.cwd, join(freshPath, "pkg"), "the child runs in the same subdirectory");
	const tracking = spawnSyncCollect(["git", "rev-parse", "--abbrev-ref", "fresh@{upstream}"], {
		cwd: repo,
		env: createGitEnvironment(),
	});
	assert.notEqual(tracking.exitCode, 0, "a new branch does not track its base");
	assert.ok(existsSync(join(repo, ".atomic", "worktrees", ".gitignore")), "the default worktree root is ignored");
});

test("a named worktree is refused for an invalid branch, a path on another branch, and a missing task cwd (#5202)", async () => {
	const repo = makeRepo();
	const harness = makeHarness(repo);
	const other = join(repo, "..", "other");
	git(repo, "worktree", "add", "-q", "-b", "other", other);
	git(repo, "worktree", "add", "-q", "--detach", join(repo, "..", "detached"));
	const empty = join(repo, "..", "empty");
	mkdirSync(empty);

	const invalid = await harness.execute({ agent: "worker", task: "t", worktree: { branch: "bad..name" } });
	const occupied = await harness.execute({ agent: "worker", task: "t", worktree: { branch: "mine", path: other } });
	const missingTask = await harness.execute({
		tasks: [{ agent: "worker", task: "t", cwd: "nowhere" }],
	});

	assert.match(text(invalid), /worktree.branch "bad..name" is not a valid branch name/);
	assert.match(text(occupied), /is not the worktree of branch "mine"/);
	assert.equal(missingTask.isError, true);
	assert.equal(missingTask.details?.mode, "parallel");
	assert.match(text(missingTask), /cwd does not exist: .*nowhere\. It may still be being created/);
	assert.equal(harness.launches.length, 0);

	const intoEmpty = await harness.execute({
		agent: "worker",
		task: "e",
		worktree: { branch: "into-empty", path: empty },
	});
	assert.equal(intoEmpty.isError, undefined, text(intoEmpty));
	assert.equal(harness.launches[0]?.cwd, empty, "an empty directory takes the worktree");
});

test("resuming a child in a removed named worktree checks its branch out there again and never tracks it for removal (#5202)", async () => {
	const repo = makeRepo();
	const before = trackedRunWorktreeCount();
	const harness = makeHarness(repo);
	const created = await harness.execute({ agent: "worker", task: "t", worktree: { branch: "resumed" } });
	assert.equal(created.isError, undefined, text(created));
	assert.equal(harness.launches[0]?.trackedWorktrees, before + 1, "the run keeps its named worktree while it runs");
	assert.equal(trackedRunWorktreeCount(), before, "the run forgets its named worktrees once it returns");
	const path = join(repo, ".atomic", "worktrees", "resumed");
	writeFileSync(join(path, "work.txt"), "work\n");
	git(path, "add", "work.txt");
	git(path, "commit", "-q", "-m", "work");
	const head = git(path, "rev-parse", "HEAD");
	git(repo, "worktree", "remove", path);

	const release = resumeRunWorktree({
		runId: "run",
		index: 0,
		cwd: path,
		agent: "worker",
		worktree: { repo, path, branch: "resumed", baseCommit: head, syntheticPaths: [], named: true },
	});

	assert.equal(git(path, "rev-parse", "HEAD"), head, "the branch, with its commits, is checked out again");
	assert.equal(trackedRunWorktreeCount(), before);
	release();
	assert.ok(existsSync(path), "releasing the resume removes nothing");
});

test("a branch name that git expands, such as @{-1}, is refused before launch (#5202)", async () => {
	const repo = makeRepo();
	git(repo, "checkout", "-q", "-b", "previous");
	git(repo, "checkout", "-q", "main");
	const harness = makeHarness(repo);

	for (const branch of ["@{-1}", "feat@{upstream}"]) {
		const result = await harness.execute({ agent: "worker", task: "t", worktree: { branch } });
		assert.equal(result.isError, true, branch);
		assert.match(
			text(result),
			new RegExp(`worktree.branch "${branch.replace(/[{}@-]/g, "\\$&")}" is not a valid branch name`),
		);
	}
	assert.equal(harness.launches.length, 0);
	assert.equal(
		git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
		1,
		"no worktree was created",
	);
});

/** Several processes, each checking out the same new branches at once; spawning a process is the structural cost. */
const CONCURRENT_LAUNCHES_TIMEOUT_MS = 120_000;
const RACE_ROUNDS = 8;
const RACE_ROUND_GAP_MS = 400;

test(
	"concurrent launches of one new branch reuse the winner's worktree or get a clear refusal, never a raw git error (#5202)",
	async () => {
		const repo = makeRepo();
		const modulePath = pathToFileURL(
			join(moduleDir(import.meta.url), "../../packages/subagents/src/runs/shared/named-worktree.ts"),
		).href;
		const script = join(repo, "..", "race.ts");
		writeFileSync(
			script,
			`const [modulePath, repo, rounds, startAt, gap] = process.argv.slice(2);
const { ensureNamedWorktree } = await import(modulePath);
const outcomes = [];
for (let round = 0; round < Number(rounds); round++) {
	const at = Number(startAt) + round * Number(gap);
	while (Date.now() < at) {}
	try {
		outcomes.push({ ok: true, path: ensureNamedWorktree(repo, { branch: "feat/race-" + round }).path });
	} catch (error) {
		outcomes.push({ ok: false, message: error instanceof Error ? error.message : String(error) });
	}
}
console.log(JSON.stringify(outcomes));
`,
		);
		const startAt = Date.now() + 5_000;
		const launches = [0, 1, 2].map(() =>
			spawnProcess(
				[
					bunExecutable(),
					script,
					modulePath,
					repo,
					String(RACE_ROUNDS),
					String(startAt),
					String(RACE_ROUND_GAP_MS),
				],
				{ cwd: repo, stdout: "pipe", stderr: "pipe", env: createGitEnvironment() },
			),
		);
		const outputs = await Promise.all(
			launches.map(async (launch) => {
				const [stdout, stderr, exitCode] = await Promise.all([
					readStreamText(launch.stdout),
					readStreamText(launch.stderr),
					launch.exited,
				]);
				assert.equal(exitCode, 0, stderr);
				return JSON.parse(stdout.trim().split("\n").at(-1)!) as Array<{
					ok: boolean;
					path?: string;
					message?: string;
				}>;
			}),
		);

		for (let round = 0; round < RACE_ROUNDS; round++) {
			const expected = join(repo, ".atomic", "worktrees", `feat+race-${round}`);
			const outcomes = outputs.map((output) => output[round]!);
			assert.ok(
				outcomes.some((outcome) => outcome.ok),
				`round ${round}: one launch gets the worktree`,
			);
			for (const outcome of outcomes) {
				if (outcome.ok) assert.equal(outcome.path, expected, `round ${round}`);
				else assert.match(outcome.message ?? "", /^worktree: /, `round ${round}: ${outcome.message}`);
			}
			assert.equal(git(expected, "rev-parse", "--abbrev-ref", "HEAD"), `feat/race-${round}`);
		}
	},
	CONCURRENT_LAUNCHES_TIMEOUT_MS,
);
