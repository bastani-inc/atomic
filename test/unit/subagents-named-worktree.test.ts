import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, test } from "vitest";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { SUBAGENT_CHILD_RECORD_TYPE } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import type { SubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

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
	readonly launches: Array<{ task: string; cwd: string | undefined }>;
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
				launches.push({ task, cwd: options.cwd });
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
});

test("a named worktree whose branch is checked out elsewhere is refused before launch (#5202)", async () => {
	const repo = makeRepo();
	const harness = makeHarness(repo);

	const result = await harness.execute({ agent: "worker", task: "t", worktree: { branch: "main" } });

	assert.equal(result.isError, true);
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

	const cwdOf = (task: string) => harness.launches.find((launch) => launch.task.endsWith(task))?.cwd;
	for (const name of ["a", "b", "c", "d"])
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
