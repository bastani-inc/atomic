import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { mapWorkflowWorktreePath } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { closeSnapshotJournals, openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
});
afterEach(async () => {
	await closeSnapshotJournals();
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

describe.skipIf(process.platform === "win32")("a working directory reached through a symbolic link (#4245)", () => {
	/** A repository, and a link to it: snapshot roots are the physical path, the run's cwd is the link. */
	async function linkedRepository() {
		const { clone } = await sandbox.remoteWithClone("repo", { "sub/a.txt": "a\n" });
		const link = sandbox.path("via-link");
		symlinkSync(clone, link);
		return { clone, link };
	}

	test("live work runs in the restored worktree, not in the drifted checkout the link points at", async () => {
		const { clone, link } = await linkedRepository();
		const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
		let attempt = 0;
		const seen = { cwd: undefined as string | undefined, content: undefined as string | undefined };
		const definition = workflow({
			name: "linked-cwd",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("write", {}, async () => {
					sandbox.write(join(ctx.cwd!, "result.txt"), "correct\n");
					return "done";
				});
				if (attempt++ === 0) throw new Error("interrupted");
				await ctx.tool("read", {}, async () => {
					seen.cwd = ctx.cwd;
					seen.content = readFileSync(join(ctx.cwd!, "result.txt"), "utf8");
					return "read";
				});
				return {};
			},
		});
		const first = await run(definition, {}, { cwd: link, durableBackend: fixture.backend, store: createStore() });
		assert.equal(first.status, "failed");
		sandbox.write(join(clone, "result.txt"), "drift\n");
		const second = await run(
			definition,
			{},
			{ runId: first.runId, cwd: link, durableBackend: fixture.backend, store: createStore() },
		);
		assert.equal(second.status, "completed", second.error);
		const mapping = fixture.backend.getWorkflow(first.runId)?.worktreeRootMappings?.at(-1);
		assert.ok(mapping);
		assert.equal(mapping.from, clone, "the recorded root is the physical path");
		assert.equal(seen.cwd, mapping.to);
		assert.equal(seen.content, "correct\n");
		assert.equal(readFileSync(join(clone, "result.txt"), "utf8"), "drift\n", "the user's checkout is untouched");
		await fixture.close();
	});

	test("a stage and a task cwd reached through the link are mapped into the restored worktree", async () => {
		const { clone, link } = await linkedRepository();
		const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
		let attempt = 0;
		const stageCwds = new Map<string, string | undefined>();
		const definition = workflow({
			name: "linked-stages",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("write", {}, async () => {
					sandbox.write(join(ctx.cwd!, "result.txt"), "correct\n");
					return "done";
				});
				if (attempt++ === 0) throw new Error("interrupted");
				await ctx.stage("linked", { cwd: join(link, "sub") }).prompt("p");
				await ctx.task("task", { prompt: "t", cwd: join(link, "sub") });
				return {};
			},
		});
		const adapters = {
			prompt: {
				prompt: async (_text: string, meta?: { stageName?: string; stageOptions?: { cwd?: string } }) => {
					stageCwds.set(meta!.stageName!, meta?.stageOptions?.cwd);
					return "done";
				},
			},
		};
		const first = await run(
			definition,
			{},
			{ cwd: link, durableBackend: fixture.backend, store: createStore(), adapters },
		);
		assert.equal(first.status, "failed");
		sandbox.write(join(clone, "result.txt"), "drift\n");
		const second = await run(
			definition,
			{},
			{ runId: first.runId, cwd: link, durableBackend: fixture.backend, store: createStore(), adapters },
		);
		assert.equal(second.status, "completed", second.error);
		const restored = fixture.backend.getWorkflow(first.runId)!.worktreeRootMappings!.at(-1)!.to;
		assert.deepEqual(Object.fromEntries(stageCwds), {
			linked: join(restored, "sub"),
			task: join(restored, "sub"),
		});
		await fixture.close();
	});

	test("a path through a link maps like the directory it points at, and a link outside every mapping is left alone", async () => {
		const real = sandbox.path("real");
		mkdirSync(join(real, "src"), { recursive: true });
		const link = sandbox.path("link");
		symlinkSync(real, link);
		const outside = sandbox.path("elsewhere");
		mkdirSync(outside);
		symlinkSync(outside, sandbox.path("outside-link"));
		const mappings = [
			{ from: real, to: sandbox.path("restored"), snapshotId: "s", tree: "t", restoredAt: "2026-01-01T00:00:00Z" },
		];
		assert.equal(mapWorkflowWorktreePath(link, mappings), sandbox.path("restored"));
		assert.equal(
			mapWorkflowWorktreePath(join(link, "src", "a.ts"), mappings),
			sandbox.path("restored", "src", "a.ts"),
		);
		assert.equal(
			mapWorkflowWorktreePath(join(link, "gone", "deep"), mappings),
			sandbox.path("restored", "gone", "deep"),
		);
		const through = sandbox.path("outside-link");
		assert.equal(mapWorkflowWorktreePath(through, mappings), through);
	});

	test("a link to the restored worktree maps to it, so a second restore of the same root chains through the link", () => {
		const real = sandbox.path("real");
		mkdirSync(real);
		const restored = sandbox.path("restored");
		mkdirSync(restored);
		const restoredLink = sandbox.path("restored-link");
		symlinkSync(restored, restoredLink);
		const mappings = [
			{ from: real, to: restoredLink, snapshotId: "s", tree: "t", restoredAt: "2026-01-01T00:00:00Z" },
			{
				from: restored,
				to: sandbox.path("second"),
				snapshotId: "s2",
				tree: "t",
				restoredAt: "2026-01-02T00:00:00Z",
			},
		];
		assert.equal(mapWorkflowWorktreePath(real, mappings), sandbox.path("second"));
	});
});
