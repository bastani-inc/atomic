import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
});
afterEach(() => {
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

test("two worktrees restored in one resume that raise the same warning each get their own notice (#4245)", async () => {
	const first = await sandbox.remoteWithClone("one");
	const second = await sandbox.remoteWithClone("two");
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	let attempt = 0;
	const definition = workflow({
		name: "two-roots",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(first.clone, "result.txt"), "first\n");
				sandbox.write(join(first.clone, ".env.local"), "secret\n");
				sandbox.write(join(second.clone, "result.txt"), "second\n");
				sandbox.write(join(second.clone, ".env.local"), "secret\n");
				return "done";
			});
			await ctx.stage("other", { cwd: second.clone }).prompt("p");
			if (attempt++ === 0) throw new Error("interrupted");
			return {};
		},
	});
	const adapters = { prompt: { prompt: async () => "done" } };
	const options = { durableBackend: fixture.backend, adapters };
	const initial = await run(definition, {}, { ...options, cwd: first.clone, store: createStore() });
	assert.equal(initial.status, "failed");
	sandbox.write(join(first.clone, "result.txt"), "drift\n");
	sandbox.write(join(second.clone, "result.txt"), "drift\n");
	const store = createStore();
	const resumed = await run(definition, {}, { ...options, runId: initial.runId, cwd: first.clone, store });
	assert.equal(resumed.status, "completed", resumed.error);
	const mappings = fixture.backend.getWorkflow(initial.runId)!.worktreeRootMappings!;
	assert.equal(mappings.length, 2);
	const warnings = store.notices().filter((notice) => notice.level === "warning");
	assert.equal(warnings.length, 2);
	assert.equal(new Set(warnings.map((notice) => notice.id)).size, 2);
	await fixture.close();
});
