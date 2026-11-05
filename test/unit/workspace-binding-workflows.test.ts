import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.ts";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	type BoundWorkspace,
	findWorkspaceError,
	isWorkspaceBindingError,
	type Workspace,
	WorkspaceBindingError,
	workspace,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import { AuthStorage, ModelRuntime, SettingsManager } from "../../packages/coding-agent/src/index.ts";
import goal from "../../packages/workflows/builtin/goal.js";
import ralph from "../../packages/workflows/builtin/ralph.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createAgentSessionAdapter } from "../../packages/workflows/src/extension/wiring.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowModelCatalogPort } from "../../packages/workflows/src/shared/types.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifacts.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import {
	commitFile,
	countGitCommands,
	createRepository,
	git,
	type WorkspaceSandboxDirs,
	workspaceSandbox,
} from "../helpers/workspace-repos.ts";
import {
	appendProseTurn,
	type CreateAgentSessionOptions,
	mockSession,
	type StageSessionRuntime,
	structuredOutputMockSession,
} from "./executor-shared.js";

let dirs: WorkspaceSandboxDirs;

beforeEach(() => {
	dirs = workspaceSandbox("atomic-workspace-workflows-");
});

afterEach(() => {
	setDurableBackend(undefined);
	dirs.cleanup();
});

interface RecordedSession {
	readonly stage: string;
	readonly cwd: string | undefined;
	readonly workspace: CreateAgentSessionOptions["workspace"];
}

/** A stage adapter that records where each session runs and commits `<stage>.txt` when asked to write. */
function recordingAdapter(options: { readonly commitIn?: (stage: string) => boolean } = {}) {
	const sessions: RecordedSession[] = [];
	return {
		sessions,
		adapters: {
			sessionStore: new MemorySessionStore(),
			agentSession: {
				async create(created: CreateAgentSessionOptions): Promise<StageSessionRuntime> {
					const stage =
						created.orchestrationContext?.kind === "workflow-stage"
							? created.orchestrationContext.workflowStageName
							: "";
					sessions.push({ stage, cwd: created.cwd, workspace: created.workspace });
					const session = mockSession(created.sessionManager);
					return {
						...session,
						async prompt() {
							if (created.cwd !== undefined && options.commitIn?.(stage) === true)
								commitFile(created.cwd, `${stage}.txt`, `${stage}\n`);
							appendProseTurn(session.messages);
						},
						getLastAssistantText: () => "done",
					};
				},
			},
		},
	};
}

function boundaryStarts(checkpoints: readonly { kind: string }[]): DurableStageCheckpoint[] {
	return (checkpoints as DurableStageCheckpoint[]).filter(
		(checkpoint) => checkpoint.kind === "stage" && checkpoint.topology?.boundary?.event === "start",
	);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}

const implement = workflow({
	name: "implement",
	description: "",
	inputs: { git_worktree_dir: Type.String({ default: "" }) },
	outputs: { cwd: Type.String() },
	run: async (ctx) => {
		await ctx.task("change", { prompt: "change something" });
		return { cwd: ctx.cwd ?? "" };
	},
});

describe("ctx.workflow(child, { workspace }) (#3109)", () => {
	test("binds the child's ctx.cwd and stages to the worktree and records the binding at the boundary (#3109)", async () => {
		const backend = await createMemoryTestBackend();
		const repo = createRepository(dirs.root, "child-repo");
		const base = git(repo, "rev-parse", "HEAD");
		const api = workspace({ repo, branch: "feat/child", label: "ci" });
		const { sessions, adapters } = recordingAdapter({ commitIn: () => true });
		const parent = workflow({
			name: "parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const result = await ctx.workflow(implement, { workspace: api });
				assert.equal(result.status, "completed");
				return {};
			},
		});
		const store = createStore();
		const result = await run(parent, {}, { store, durableBackend: backend, adapters });
		assert.equal(result.status, "completed", result.error);

		const [start] = boundaryStarts(backend.listCheckpoints(result.runId));
		const binding = start?.topology?.boundary?.workspace as BoundWorkspace;
		assert.ok(binding);
		assert.equal(binding.branch, "feat/child");
		assert.equal(binding.label, "ci");
		assert.equal(binding.repo, repo);
		assert.equal(binding.baseCommit, base);
		for (const key of ["remotes", "head", "tree", "envHash", "repo", "branch", "worktree"])
			assert.ok(key in binding, key);

		const child = store.runs().find((candidate) => candidate.parentRunId === result.runId);
		assert.equal(child?.result?.cwd, binding.worktree);
		assert.deepEqual(
			sessions.map((session) => [session.stage, session.cwd]),
			[["change", binding.worktree]],
		);
		assert.deepEqual(sessions[0]?.workspace, binding, "child stages inherit the resolved binding");

		const boundary = result.stages.find((stage) => stage.workflowChild !== undefined);
		const changeSet = boundary?.workflowChild?.changeSet;
		assert.deepEqual(changeSet, {
			repo,
			baseCommit: base,
			branch: "feat/child",
			headCommit: git(binding.worktree, "rev-parse", "HEAD"),
			diffStat: { files: 1, insertions: 1, deletions: 0 },
		});
	});

	test("rejects a git_worktree_dir input with conflicting-worktree-input before any boundary (#3109)", async () => {
		const backend = await createMemoryTestBackend();
		const repo = createRepository(dirs.root, "conflict");
		const declared = workflow({
			name: "declared",
			description: "",
			inputs: { tree: Type.String({ default: "" }) },
			outputs: {},
			worktreeFromInputs: { gitWorktreeDir: "tree" },
			run: async () => ({}),
		});
		const cases: readonly (readonly [unknown, Readonly<Record<string, string>>, string])[] = [
			[implement, { git_worktree_dir: join(dirs.root, "elsewhere") }, "git_worktree_dir"],
			[declared, { tree: "../tree" }, "tree"],
		];
		for (const [child, inputs, input] of cases) {
			let caught: unknown;
			const parent = workflow({
				name: "conflicting-parent",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					caught = await rejection(
						ctx.workflow(child as typeof implement, { workspace: workspace({ repo }), inputs }),
					);
					await ctx.tool("tracked", {}, async () => "ok");
					return {};
				},
			});
			const { result, commands } = await countGitCommands(() =>
				run(parent, {}, { store: createStore(), durableBackend: backend }),
			);
			assert.equal(result.status, "completed", result.error);
			assert.ok(caught instanceof WorkspaceBindingError);
			assert.equal(caught.code, "conflicting-worktree-input");
			assert.equal(caught.fields.input, input);
			assert.equal(commands.length, 0, "rejected before any git work");
			assert.equal(boundaryStarts(backend.listCheckpoints(result.runId)).length, 0);
		}
	});

	test("rejects a value that is not a workspace before any boundary (#3109)", async () => {
		let caught: unknown;
		const parent = workflow({
			name: "malformed-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				caught = await rejection(ctx.workflow(implement, { workspace: { repo: "/x" } as unknown as Workspace }));
				await ctx.tool("tracked", {}, async () => "ok");
				return {};
			},
		});
		const result = await run(parent, {}, { store: createStore(), durableBackend: await createMemoryTestBackend() });
		assert.equal(result.status, "completed", result.error);
		assert.equal((caught as { name?: string }).name, "WorkspaceConfigError");
	});

	test("lets one writer child hold a worktree and refuses a concurrent second writer (#3109)", async () => {
		const repo = createRepository(dirs.root, "writers");
		const api = workspace({ repo, branch: "shared" });
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = workflow({
			name: "slow-writer",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("hold", {}, async () => {
					await held;
					return "held";
				});
				return {};
			},
		});
		let readersStarted = 0;
		let openGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const gated = workflow({
			name: "gated-reader",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("read", {}, async () => {
					readersStarted += 1;
					if (readersStarted === 2) openGate();
					await gate;
					return "read";
				});
				return {};
			},
		});
		let second: unknown;
		const parent = workflow({
			name: "two-writers",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const first = ctx.workflow(slow, { workspace: api, stageName: "first" });
				second = await rejection(ctx.workflow(slow, { workspace: api, stageName: "second" }));
				release();
				await first;
				const readers = await Promise.all([
					ctx.workflow(gated, { workspace: api.readOnly(), stageName: "reader-1" }),
					ctx.workflow(gated, { workspace: api.readOnly(), stageName: "reader-2" }),
				]);
				assert.deepEqual(
					readers.map((reader) => reader.status),
					["completed", "completed"],
				);
				await ctx.workflow(slow, { workspace: api, stageName: "after-release" });
				return {};
			},
		});
		const result = await run(parent, {}, { store: createStore(), durableBackend: await createMemoryTestBackend() });
		assert.equal(result.status, "completed", result.error);
		assert.ok(isWorkspaceBindingError(second));
		assert.equal(second.code, "writer-conflict");
		assert.match(String(second.fields.holder), /\/first$/);
	});

	test("a child without a workspace keeps its current cwd and fingerprint (#3109)", async () => {
		const backend = await createMemoryTestBackend();
		const { adapters } = recordingAdapter();
		const parent = workflow({
			name: "unbound-parent",
			description: "",
			inputs: {},
			outputs: { cwd: Type.String() },
			run: async (ctx) => {
				const child = await ctx.workflow(implement);
				return { cwd: child.status === "completed" ? String(child.outputs.cwd) : "" };
			},
		});
		const result = await run(parent, {}, { store: createStore(), durableBackend: backend, adapters, cwd: dirs.root });
		assert.equal(result.status, "completed", result.error);
		assert.equal(result.result?.cwd, dirs.root);
		const [start] = boundaryStarts(backend.listCheckpoints(result.runId));
		assert.equal(start?.topology?.boundary?.workspace, undefined);
		assert.equal(result.stages.find((stage) => stage.workflowChild)?.workflowChild?.changeSet, undefined);
	});
});

describe("ctx.task(name, { workspace }) (#3109)", () => {
	test("runs the stage in the worktree and returns its changeSet (#3109)", async () => {
		const repo = createRepository(dirs.root, "task-repo");
		const base = git(repo, "rev-parse", "HEAD");
		const api = workspace({ repo, branch: "task-branch" });
		const { sessions, adapters } = recordingAdapter({ commitIn: (stage) => stage === "implement" });
		let reviewed: { changeSet?: unknown } | undefined;
		const parent = workflow({
			name: "task-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const implemented = await ctx.task("implement", { workspace: api, prompt: "implement", cwd: "." });
				assert.equal(implemented.changeSet?.diffStat.files, 1);
				assert.equal(implemented.changeSet?.baseCommit, base);
				reviewed = await ctx.task("review", { workspace: api.readOnly(), prompt: "review" });
				const [chained] = await ctx.chain([{ name: "chained", prompt: "x" }], { workspace: api.readOnly() });
				const [parallel] = await ctx.parallel([{ name: "parallel", prompt: "x" }], { workspace: api.readOnly() });
				assert.equal(chained?.changeSet?.branch, "task-branch");
				assert.equal(parallel?.changeSet?.branch, "task-branch");
				return {};
			},
		});
		const result = await run(
			parent,
			{},
			{ store: createStore(), durableBackend: await createMemoryTestBackend(), adapters },
		);
		assert.equal(result.status, "completed", result.error);
		const worktree = (sessions[0]!.workspace as BoundWorkspace).worktree;
		assert.ok(worktree.startsWith(join(dirs.home, "worktrees")));
		assert.deepEqual(
			sessions.map((session) => [session.stage, session.cwd, (session.workspace as BoundWorkspace).sandbox]),
			[
				["implement", worktree, "workspace-write"],
				["review", worktree, "read-only"],
				["chained", worktree, "read-only"],
				["parallel", worktree, "read-only"],
			],
		);
		assert.deepEqual(reviewed?.changeSet, {
			repo,
			baseCommit: base,
			branch: "task-branch",
			headCommit: git(worktree, "rev-parse", "HEAD"),
			diffStat: { files: 1, insertions: 1, deletions: 0 },
		});
	});

	test("ctx.stage sessions resolve the workspace when they start (#3109)", async () => {
		const repo = createRepository(dirs.root, "stage-repo");
		const { sessions, adapters } = recordingAdapter();
		const parent = workflow({
			name: "stage-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("bound", { workspace: workspace({ repo }).readOnly() }).prompt("look");
				return {};
			},
		});
		const result = await run(
			parent,
			{},
			{ store: createStore(), durableBackend: await createMemoryTestBackend(), adapters },
		);
		assert.equal(result.status, "completed", result.error);
		assert.equal(sessions[0]?.cwd, git(repo, "rev-parse", "--show-toplevel"));
		assert.equal((sessions[0]!.workspace as BoundWorkspace).sandbox, "read-only");
	});

	test("rejects gitWorktreeDir or worktree: true beside a workspace before the stage starts (#3109)", async () => {
		const repo = createRepository(dirs.root, "task-conflict");
		const { sessions, adapters } = recordingAdapter();
		const errors: unknown[] = [];
		const parent = workflow({
			name: "task-conflict-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				errors.push(
					await rejection(
						ctx.task("a", { workspace: workspace({ repo }), gitWorktreeDir: join(dirs.root, "wt"), prompt: "x" }),
					),
				);
				errors.push(
					await rejection(ctx.task("b", { workspace: workspace({ repo }), worktree: true, prompt: "x" })),
				);
				errors.push(
					await rejection(
						Promise.resolve().then(() =>
							ctx
								.stage("c", { workspace: workspace({ repo }), gitWorktreeDir: join(dirs.root, "wt") })
								.prompt("x"),
						),
					),
				);
				await ctx.tool("tracked", {}, async () => "ok");
				return {};
			},
		});
		const result = await run(
			parent,
			{},
			{ store: createStore(), durableBackend: await createMemoryTestBackend(), adapters },
		);
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			errors.map((error) => [
				isWorkspaceBindingError(error) && error.code,
				(error as WorkspaceBindingError).fields?.input,
			]),
			[
				["conflicting-worktree-input", "gitWorktreeDir"],
				["conflicting-worktree-input", "worktree"],
				["conflicting-worktree-input", "gitWorktreeDir"],
			],
		);
		assert.equal(sessions.length, 0);
		assert.equal(existsSync(join(dirs.root, "wt")), false);
	});
});

describe("workspace bindings across resume (#3109)", () => {
	test("a fresh process restores both recorded bindings, re-adds a deleted worktree and keeps the label (#3109)", async () => {
		const journalPath = join(dirs.root, "journal.sqlite");
		const repoA = createRepository(dirs.root, "resume-a");
		const repoB = createRepository(dirs.root, "resume-b");
		const apiA = workspace({ repo: repoA, branch: "feat/a", label: "nightly" });
		const apiB = workspace({ repo: repoB, branch: "feat/b", label: "nightly" });
		let failFirst = true;
		const flaky = workflow({
			name: "flaky",
			description: "",
			inputs: {},
			outputs: { cwd: Type.String() },
			run: async (ctx) => {
				await ctx.task("work", { prompt: "work" });
				if (failFirst) throw new Error("interrupted before finishing");
				return { cwd: ctx.cwd ?? "" };
			},
		});
		const parent = workflow({
			name: "resume-parent",
			description: "",
			inputs: {},
			outputs: { a: Type.String(), b: Type.String() },
			run: async (ctx) => {
				const [a, b] = await Promise.all([
					ctx.workflow(flaky, { workspace: apiA, stageName: "a" }),
					ctx.workflow(flaky, { workspace: apiB, stageName: "b" }),
				]);
				return {
					a: a.status === "completed" ? String(a.outputs.cwd) : "",
					b: b.status === "completed" ? String(b.outputs.cwd) : "",
				};
			},
		});
		const firstBackend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
		const first = recordingAdapter({ commitIn: () => true });
		const failed = await run(
			parent,
			{},
			{ store: createStore(), durableBackend: firstBackend, adapters: first.adapters },
		);
		assert.equal(failed.status, "failed");
		const recorded = boundaryStarts(firstBackend.listCheckpoints(failed.runId)).map(
			(start) => start.topology?.boundary?.workspace as BoundWorkspace,
		);
		assert.deepEqual(recorded.map((binding) => binding.branch).sort(), ["feat/a", "feat/b"]);
		await firstBackend.close();

		const bindingA = recorded.find((binding) => binding.branch === "feat/a")!;
		const bindingB = recorded.find((binding) => binding.branch === "feat/b")!;
		rmSync(bindingA.worktree, { recursive: true, force: true });
		commitFile(bindingB.worktree, "between-runs.txt", "expected work, not drift\n");

		failFirst = false;
		const resumedBackend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
		const second = recordingAdapter();
		const resumed = await run(
			parent,
			{},
			{ runId: failed.runId, store: createStore(), durableBackend: resumedBackend, adapters: second.adapters },
		);
		assert.equal(resumed.status, "completed", resumed.error);
		assert.equal(resumed.result?.a, bindingA.worktree);
		assert.equal(resumed.result?.b, bindingB.worktree);
		assert.equal(
			existsSync(join(bindingA.worktree, "work.txt")),
			true,
			"the re-added worktree has the branch's commits",
		);
		const afterResume = boundaryStarts(resumedBackend.listCheckpoints(failed.runId)).map(
			(start) => start.topology?.boundary?.workspace,
		);
		assert.deepEqual(afterResume, recorded, "resume restores the recorded bindings instead of recording new ones");
		for (const session of second.sessions) {
			const binding = session.workspace as BoundWorkspace;
			assert.equal(binding.label, "nightly", "the label persists through resume");
			assert.equal(binding.baseCommit, (binding.branch === "feat/a" ? bindingA : bindingB).baseCommit);
			assert.equal(session.cwd, binding.worktree);
		}
		await resumedBackend.close();
	});

	test("resume fails closed when a recorded worktree moved to another branch (#3109)", async () => {
		const journalPath = join(dirs.root, "journal.sqlite");
		const repo = createRepository(dirs.root, "drifted");
		let failFirst = true;
		const child = workflow({
			name: "drift-child",
			description: "",
			inputs: {},
			outputs: {},
			run: async () => {
				if (failFirst) throw new Error("interrupted");
				return {};
			},
		});
		const parent = workflow({
			name: "drift-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.workflow(child, { workspace: workspace({ repo, branch: "feat/drift" }) });
				return {};
			},
		});
		const firstBackend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
		const failed = await run(parent, {}, { store: createStore(), durableBackend: firstBackend });
		const [start] = boundaryStarts(firstBackend.listCheckpoints(failed.runId));
		const binding = start?.topology?.boundary?.workspace as BoundWorkspace;
		await firstBackend.close();
		git(binding.worktree, "checkout", "-q", "-b", "somebody-else");

		failFirst = false;
		const resumedBackend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
		const resumed = await run(
			parent,
			{},
			{ runId: failed.runId, store: createStore(), durableBackend: resumedBackend },
		);
		assert.equal(resumed.status, "failed");
		assert.equal(resumed.workspaceError?.name, "WorkspaceBindingError");
		assert.equal(resumed.workspaceError?.code, "wrong-branch");
		assert.equal(resumed.workspaceError?.fields.actual, "somebody-else");
		await resumedBackend.close();
	});
});

const approvingReview = {
	findings: [],
	overall_correctness: "patch is correct",
	overall_explanation: "focused checks pass",
	overall_confidence_score: 0.99,
	goal_oracle_satisfied: true,
	requirements_traceability: [{ requirement: "implement", status: "proven", evidence: "focused test" }],
	receipt_assessment: "receipt verified",
	verification_remaining: "none",
	stop_review_loop: true,
	reviewer_error: null,
};

/** Routes every `model: "auto"` stage to one test model, so builtin Goal runs without a router. */
const testModel = {
	provider: "test",
	id: "model",
	name: "model",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
} as const;
const routedModels: WorkflowModelCatalogPort = {
	listModels: async () => [{ provider: "test", id: "model", fullId: "test/model", model: testModel }],
	routeModel: async () => ({
		routerSelection: { model: "test/model", effort: null },
		modelOverride: "test/model",
		assertCurrent() {},
		allowsModel: () => true,
	}),
} as unknown as WorkflowModelCatalogPort;

describe("nested builtin Goals bound to unrelated repositories (#3109)", () => {
	test("a parent runs two builtin Goals in parallel, each in its own repository's worktree (#3109)", async () => {
		const previousArtifacts = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		process.env[ENV_WORKFLOW_ARTIFACT_DIR] = join(dirs.root, "artifacts");
		try {
			const repoA = createRepository(dirs.root, "app-core-bff");
			const repoB = createRepository(dirs.root, "product-service");
			const sessions: RecordedSession[] = [];
			const adapters = {
				sessionStore: new MemorySessionStore(),
				agentSession: {
					async create(options: CreateAgentSessionOptions): Promise<StageSessionRuntime> {
						const stage =
							options.orchestrationContext?.kind === "workflow-stage"
								? options.orchestrationContext.workflowStageName
								: "";
						sessions.push({ stage, cwd: options.cwd, workspace: options.workspace });
						const model = testModel as unknown as StageSessionRuntime["model"];
						if (options.customTools?.some((tool) => tool.name === "structured_output"))
							return Object.assign(structuredOutputMockSession(options, approvingReview), { model });
						const session = mockSession(options.sessionManager);
						return {
							...session,
							model,
							async prompt() {
								if (stage.startsWith("orchestrator") && options.cwd !== undefined)
									commitFile(options.cwd, "implemented.txt", `${stage}\n`);
								appendProseTurn(session.messages);
							},
							getLastAssistantText: () => "receipt",
						};
					},
				},
			};
			const parent = workflow({
				name: "cross-repository-change",
				description: "",
				inputs: {},
				outputs: { a: Type.String(), b: Type.String() },
				run: async (ctx) => {
					const goals = await Promise.all(
						[
							["implement-app-core-bff", repoA, "feat/ticket-123"],
							["implement-product-service", repoB, "feat/ticket-123"],
						].map(([stageName, repo, branch]) =>
							ctx.workflow(goal, {
								stageName,
								workspace: workspace({ repo: repo!, branch: branch!, label: "ticket-123" }),
								inputs: { objective: `implement in ${stageName}`, max_turns: 1, create_pr: false },
							}),
						),
					);
					return {
						a: goals[0]!.status === "completed" ? String(goals[0]!.outputs.status) : "",
						b: goals[1]!.status === "completed" ? String(goals[1]!.outputs.status) : "",
					};
				},
			});
			const backend = await createMemoryTestBackend();
			const store = createStore();
			const result = await run(parent, {}, { store, durableBackend: backend, adapters, models: routedModels });
			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(result.result, { a: "complete", b: "complete" });

			const starts = boundaryStarts(backend.listCheckpoints(result.runId));
			const byStage = new Map(
				starts.map((start) => [start.name, start.topology?.boundary?.workspace as BoundWorkspace]),
			);
			const bindingA = byStage.get("implement-app-core-bff")!;
			const bindingB = byStage.get("implement-product-service")!;
			assert.equal(bindingA.repo, repoA);
			assert.equal(bindingB.repo, repoB);
			assert.notEqual(bindingA.worktree, bindingB.worktree);
			const childRuns = store.runs().filter((candidate) => candidate.parentRunId === result.runId);
			assert.equal(childRuns.length, 2);
			for (const child of childRuns) {
				const binding =
					child.parentStageId ===
					starts.find((start) => start.name === "implement-app-core-bff")?.topology?.stageId
						? bindingA
						: bindingB;
				const childSessions = sessions.filter(
					(session) => (session.workspace as BoundWorkspace)?.worktree === binding.worktree,
				);
				assert.ok(childSessions.length >= 4, "orchestrator and three reviewers ran in the child's worktree");
				for (const session of childSessions) assert.equal(session.cwd, binding.worktree);
			}
			assert.equal(
				sessions.every((session) => session.cwd === bindingA.worktree || session.cwd === bindingB.worktree),
				true,
				"no Goal stage ran outside its bound worktree",
			);
			for (const [repo, binding] of [
				[repoA, bindingA],
				[repoB, bindingB],
			] as const) {
				const worktrees = git(repo, "worktree", "list", "--porcelain")
					.split("\n")
					.filter((line) => line.startsWith("worktree "));
				assert.equal(worktrees.length, 2, "Goal created no worktree of its own");
				const boundary = result.stages.find((stage) => stage.workflowChild?.changeSet?.repo === repo);
				assert.deepEqual(boundary?.workflowChild?.changeSet, {
					repo,
					baseCommit: git(repo, "rev-parse", "main"),
					branch: "feat/ticket-123",
					headCommit: git(binding.worktree, "rev-parse", "HEAD"),
					diffStat: { files: 1, insertions: 1, deletions: 0 },
				});
				assert.equal(binding.label, "ticket-123");
			}
		} finally {
			if (previousArtifacts === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
			else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousArtifacts;
		}
	});
});

describe("builtin Ralph bound to a workspace (#3109)", () => {
	test("runs its stages in the bound worktree instead of creating its own (#3109)", async () => {
		const previousArtifacts = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		process.env[ENV_WORKFLOW_ARTIFACT_DIR] = join(dirs.root, "artifacts");
		try {
			const repo = createRepository(dirs.root, "ralph-repo");
			const sessions: RecordedSession[] = [];
			const adapters = {
				sessionStore: new MemorySessionStore(),
				agentSession: {
					async create(options: CreateAgentSessionOptions): Promise<StageSessionRuntime> {
						sessions.push({ stage: "", cwd: options.cwd, workspace: options.workspace });
						throw new Error("stop after the first stage session");
					},
				},
			};
			let childError: unknown;
			const parent = workflow({
				name: "ralph-parent",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					childError = await rejection(
						ctx.workflow(ralph, {
							workspace: workspace({ repo, branch: "feat/ralph" }),
							inputs: { prompt: "do the thing", max_loops: 1 },
						}),
					);
					await ctx.tool("tracked", {}, async () => "ok");
					return {};
				},
			});
			const backend = await createMemoryTestBackend();
			const result = await run(
				parent,
				{},
				{ store: createStore(), durableBackend: backend, adapters, models: routedModels },
			);
			assert.equal(result.status, "completed", result.error);
			assert.match(String((childError as Error).message), /stop after the first stage session/);
			const [start] = boundaryStarts(backend.listCheckpoints(result.runId));
			const binding = start?.topology?.boundary?.workspace as BoundWorkspace;
			assert.ok(sessions.length >= 1);
			for (const session of sessions) assert.equal(session.cwd, binding.worktree);
			const worktrees = git(repo, "worktree", "list", "--porcelain")
				.split("\n")
				.filter((line) => line.startsWith("worktree "));
			assert.equal(worktrees.length, 2, "Ralph created no worktree of its own");
		} finally {
			if (previousArtifacts === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
			else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousArtifacts;
		}
	});
});

describe("read-only reviewers in a workflow (#3109)", () => {
	test("a read-only ctx.task reviewer backed by a real SDK session cannot write (#3109)", async () => {
		const repo = createRepository(dirs.root, "reviewed");
		const target = join(repo, "reviewer-wrote.txt");
		const faux = registerFauxProvider();
		try {
			const model = faux.getModel();
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: target, content: "nope" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("reviewed without writing"),
			]);
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: null,
				modelsStore: new InMemoryCodingAgentModelsStore(),
			});
			modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((registered) => ({
					id: registered.id,
					name: registered.name,
					api: registered.api,
					reasoning: registered.reasoning,
					input: registered.input,
					contextWindow: registered.contextWindow,
					maxTokens: registered.maxTokens,
					cost: registered.cost,
				})),
			});
			const agentDir = join(dirs.home, "agent");
			mkdirSync(agentDir, { recursive: true });
			const agentSession = createAgentSessionAdapter({
				cwd: dirs.root,
				agentDir,
				model,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
				builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
			});
			let text = "";
			const parent = workflow({
				name: "read-only-review",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					text = (await ctx.task("review", { workspace: workspace({ repo }).readOnly(), prompt: "review" })).text;
					return {};
				},
			});
			const result = await run(
				parent,
				{},
				{
					store: createStore(),
					durableBackend: await createMemoryTestBackend(),
					adapters: { sessionStore: new MemorySessionStore(), agentSession },
				},
			);
			assert.equal(result.status, "completed", result.error);
			assert.equal(text, "reviewed without writing");
			assert.equal(existsSync(target), false, "the reviewer's write never landed");
			assert.equal(faux.state.callCount, 2);
			assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "reviewed\n");
		} finally {
			faux.unregister();
		}
	});

	test("a workspace error inside a child reaches the parent typed (#3109)", async () => {
		const plain = join(dirs.root, "not-a-repo");
		mkdirSync(plain);
		const child = workflow({
			name: "bad-binding-child",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("work", { workspace: workspace({ repo: plain }), prompt: "x" });
				return {};
			},
		});
		let caught: unknown;
		const parent = workflow({
			name: "bad-binding-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				caught = await rejection(ctx.workflow(child));
				await ctx.tool("tracked", {}, async () => "ok");
				return {};
			},
		});
		const { adapters } = recordingAdapter();
		const result = await run(
			parent,
			{},
			{ store: createStore(), durableBackend: await createMemoryTestBackend(), adapters },
		);
		assert.equal(result.status, "completed", result.error);
		const typed = findWorkspaceError(caught, isWorkspaceBindingError);
		assert.ok(typed instanceof WorkspaceBindingError, "rehydrated into the same class");
		assert.equal(typed.code, "invalid-repository");
		assert.equal(typed.fields.repo, plain);
	});
});

describe("workspace plumbing in the engine (#3109)", () => {
	test("the child fingerprint changes with every workspace identity field and not without one (#3109)", async () => {
		const { durableChildInvocationFingerprint } = await import(
			"../../packages/workflows/src/durable/child-invocation.js"
		);
		const { durableHash } = await import("../../packages/workflows/src/durable/durable-hash.js");
		const child = { name: "child", normalizedName: "child" };
		const plain = durableChildInvocationFingerprint(child, { a: 1 });
		assert.equal(
			plain,
			durableHash({ definition: child, inputs: { a: 1 } }),
			"unbound children keep their fingerprint",
		);
		const base = workspace({ repo: "/r", base: "main", branch: "b", worktree: "/w" });
		const variants = [
			base,
			workspace({ repo: "/other", base: "main", branch: "b", worktree: "/w" }),
			workspace({ repo: "/r", base: "dev", branch: "b", worktree: "/w" }),
			workspace({ repo: "/r", base: "main", branch: "c", worktree: "/w" }),
			workspace({ repo: "/r", base: "main", branch: "b", worktree: "/v" }),
			base.readOnly(),
			workspace({ repo: "/r" }),
		];
		const fingerprints = variants.map((variant) => durableChildInvocationFingerprint(child, { a: 1 }, variant));
		assert.equal(new Set([plain, ...fingerprints]).size, variants.length + 1);
		assert.equal(
			durableChildInvocationFingerprint(
				child,
				{ a: 1 },
				workspace({ repo: "/r", base: "main", branch: "b", worktree: "/w", label: "x" }),
			),
			fingerprints[0],
			"the label is not part of the identity",
		);
	});

	test("a stage's own workspace replaces input worktree defaults, and conflicts are explicit (#3109)", async () => {
		const { assertWorkspaceCompatible, stageOptionsWithInputDefaults } = await import(
			"../../packages/workflows/src/runs/foreground/executor-direct-helpers.js"
		);
		const api = workspace({ repo: "/r" });
		const defaults = { gitWorktreeDir: "/wt", baseBranch: "main", model: "m" };
		assert.deepEqual(stageOptionsWithInputDefaults({ workspace: api }, defaults), { model: "m", workspace: api });
		assert.deepEqual(stageOptionsWithInputDefaults({ cwd: "x" }, defaults), { ...defaults, cwd: "x" });
		assertWorkspaceCompatible(undefined);
		assertWorkspaceCompatible({ gitWorktreeDir: "/wt" });
		assertWorkspaceCompatible({ workspace: api, gitWorktreeDir: "   " });
		assertWorkspaceCompatible({ workspace: api, worktree: false });
		for (const [options, input] of [
			[{ workspace: api, gitWorktreeDir: "/wt" }, "gitWorktreeDir"],
			[{ workspace: api, worktree: true }, "worktree"],
		] as const) {
			const error = (() => {
				try {
					assertWorkspaceCompatible(options);
				} catch (caught) {
					return caught;
				}
				return undefined;
			})();
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "conflicting-worktree-input");
			assert.deepEqual(error.fields, { input });
		}
	});

	test("a bound stage keeps no default cwd so its worktree decides (#3109)", async () => {
		const { buildStageSessionOptions } = await import(
			"../../packages/workflows/src/runs/foreground/stage-runner-session-options.js"
		);
		const base = {
			candidate: undefined,
			ownsFallbackChain: false,
			reattachSessionId: undefined,
			sharedModelRuntime: undefined,
		};
		const api = workspace({ repo: "/r" });
		assert.equal(
			(await buildStageSessionOptions({ ...base, effectiveStageOptions: { workspace: api }, defaultCwd: "/d" }))
				?.cwd,
			undefined,
		);
		assert.equal(
			(await buildStageSessionOptions({ ...base, effectiveStageOptions: {}, defaultCwd: "/d" }))?.cwd,
			"/d",
		);
		assert.equal(
			(await buildStageSessionOptions({ ...base, effectiveStageOptions: { cwd: "/c" }, defaultCwd: "/d" }))?.cwd,
			"/c",
		);
		assert.equal(await buildStageSessionOptions({ ...base, effectiveStageOptions: {} }), undefined);
	});

	test("rejects a malformed workspace naming the field, and ignores a blank git_worktree_dir (#3109)", async () => {
		const repo = createRepository(dirs.root, "blank-input");
		const { adapters } = recordingAdapter();
		let malformed: unknown;
		let blank: { status: string } | undefined;
		const parent = workflow({
			name: "blank-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				malformed = await rejection(
					ctx.workflow(implement, { workspace: { kind: "workspace" } as unknown as Workspace }),
				);
				blank = await ctx.workflow(implement, {
					workspace: workspace({ repo }),
					inputs: { git_worktree_dir: "   " },
				});
				return {};
			},
		});
		const result = await run(
			parent,
			{},
			{ store: createStore(), durableBackend: await createMemoryTestBackend(), adapters },
		);
		assert.equal(result.status, "completed", result.error);
		assert.equal((malformed as { field?: string }).field, "workspace");
		assert.equal(blank?.status, "completed");
	});

	test("an exited bound child still reports its changeSet (#3109)", async () => {
		const repo = createRepository(dirs.root, "exiting");
		const exiting = workflow({
			name: "exiting",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("change", {}, async () => commitFile(ctx.cwd ?? "", "exit.txt", "exit\n"));
				return ctx.exit({ status: "blocked", reason: "needs a human" });
			},
		});
		let child: { exited?: boolean; changeSet?: { diffStat: { files: number } } } | undefined;
		const parent = workflow({
			name: "exit-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				child = await ctx.workflow(exiting, { workspace: workspace({ repo, branch: "exits" }) });
				return {};
			},
		});
		const result = await run(parent, {}, { store: createStore(), durableBackend: await createMemoryTestBackend() });
		assert.equal(result.status, "completed", result.error);
		assert.equal(child?.exited, true);
		assert.equal(child?.changeSet?.diffStat.files, 1);
	});

	test("an unbound boundary records no workspace key (#3109)", async () => {
		const backend = await createMemoryTestBackend();
		const { adapters } = recordingAdapter();
		const parent = workflow({
			name: "unbound-key",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.workflow(implement);
				return {};
			},
		});
		const result = await run(parent, {}, { store: createStore(), durableBackend: backend, adapters, cwd: dirs.root });
		const [start] = boundaryStarts(backend.listCheckpoints(result.runId));
		assert.equal("workspace" in (start?.topology?.boundary ?? {}), false);
	});

	test("continuation replay of a bound child runs no git and keeps its changeSet (#3109)", async () => {
		const repo = createRepository(dirs.root, "replayed");
		let failOnce = true;
		const parent = workflow({
			name: "replay-parent",
			description: "",
			inputs: {},
			outputs: { files: Type.Number() },
			run: async (ctx) => {
				const child = await ctx.workflow(implement, { workspace: workspace({ repo, branch: "replayed" }) });
				await ctx.task("after", { prompt: "after" });
				return { files: child.changeSet?.diffStat.files ?? -1 };
			},
		});
		const store = createStore();
		const backend = await createMemoryTestBackend();
		const recording = recordingAdapter({ commitIn: (stage) => stage === "change" });
		const adapters = {
			...recording.adapters,
			agentSession: {
				async create(options: CreateAgentSessionOptions): Promise<StageSessionRuntime> {
					const session = await recording.adapters.agentSession.create(options);
					const stage =
						options.orchestrationContext?.kind === "workflow-stage"
							? options.orchestrationContext.workflowStageName
							: "";
					if (stage !== "after") return session;
					return {
						...session,
						async prompt() {
							if (failOnce) {
								failOnce = false;
								throw new Error("fail once after the child");
							}
							appendProseTurn(session.messages);
						},
					};
				},
			},
		};
		const first = await run(parent, {}, { store, durableBackend: backend, adapters });
		assert.equal(first.status, "failed");
		const source = store.runs().find((candidate) => candidate.id === first.runId)!;
		const { result, commands } = await countGitCommands(() =>
			run(
				parent,
				{},
				{
					store: createStore(),
					durableBackend: backend,
					adapters,
					continuation: { source, resumeFromStageId: source.failedStageId },
				},
			),
		);
		assert.equal(result.status, "completed", result.error);
		assert.equal(result.result?.files, 1);
		assert.equal(commands.length, 0, "a replayed boundary never touches git");
	});

	test("resume keeps the recorded label even when the code now passes another (#3109)", async () => {
		const journalPath = join(dirs.root, "label-journal.sqlite");
		const repo = createRepository(dirs.root, "relabel");
		let label = "first";
		let failFirst = true;
		const child = workflow({
			name: "relabel-child",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("gate", {}, async () => {
					if (failFirst) throw new Error("interrupted");
					return "open";
				});
				await ctx.task("work", { prompt: "work" });
				return {};
			},
		});
		const done = workflow({
			name: "relabel-done",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("done", { prompt: "done" });
				return {};
			},
		});
		const parent = workflow({
			name: "relabel-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const cachedBranch = workspace({ repo, branch: "cached", label });
				await ctx.workflow(done, { workspace: cachedBranch, stageName: "cached" });
				await ctx.workflow(child, {
					workspace: workspace({ repo, branch: "relabel", label }),
					stageName: "relabel",
				});
				return {};
			},
		});
		const firstBackend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
		const failed = await run(
			parent,
			{},
			{
				store: createStore(),
				durableBackend: firstBackend,
				adapters: recordingAdapter({ commitIn: () => true }).adapters,
			},
		);
		assert.equal(failed.status, "failed");
		await firstBackend.close();
		label = "second";
		failFirst = false;
		const resumedBackend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
		const second = recordingAdapter();
		const resumed = await run(
			parent,
			{},
			{ runId: failed.runId, store: createStore(), durableBackend: resumedBackend, adapters: second.adapters },
		);
		assert.equal(resumed.status, "completed", resumed.error);
		assert.deepEqual(
			second.sessions.map((session) => [session.stage, (session.workspace as BoundWorkspace).label]),
			[["work", "first"]],
		);
		const cached = resumed.stages.find((stage) => stage.name === "cached");
		assert.equal(cached?.workflowChild?.changeSet?.diffStat.files, 1, "a cached child keeps its changeSet");
		await resumedBackend.close();
	});
});
