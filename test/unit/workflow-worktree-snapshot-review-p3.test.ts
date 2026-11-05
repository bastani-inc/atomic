import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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

test("each warning of a restore and each later restore of the same snapshot is its own notice (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone("one");
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	let attempt = 0;
	const definition = workflow({
		name: "repeated-restores",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(clone, "result.txt"), "recorded\n");
				return "done";
			});
			if (attempt++ < 2) throw new Error("interrupted");
			return {};
		},
	});
	const options = { durableBackend: fixture.backend, cwd: clone };
	const initial = await run(definition, {}, { ...options, store: createStore() });
	assert.equal(initial.status, "failed");
	const records = join(sandbox.path("agent"), "worktree-snapshots", "restores");
	mkdirSync(records, { recursive: true });
	for (let index = 0; index < 2; index++) writeFileSync(join(records, `${randomUUID()}.json`), "{");
	const store = createStore();
	sandbox.write(join(clone, "result.txt"), "drift\n");
	assert.equal((await run(definition, {}, { ...options, runId: initial.runId, store })).status, "failed");
	const firstRestore = fixture.backend.getWorkflow(initial.runId)!.worktreeRootMappings!.at(-1)!;
	sandbox.write(join(firstRestore.to, "result.txt"), "drift again\n");
	assert.equal((await run(definition, {}, { ...options, runId: initial.runId, store })).status, "completed");
	const mappings = fixture.backend.getWorkflow(initial.runId)!.worktreeRootMappings!;
	assert.equal(mappings.length, 2);
	assert.equal(mappings[0]!.snapshotId, mappings[1]!.snapshotId);
	const notices = store.notices().filter((notice) => notice.runId === initial.runId);
	const restores = notices.filter((notice) => notice.level === "info");
	const leftovers = notices.filter((notice) => notice.level === "warning");
	assert.equal(restores.length, 2);
	assert.deepEqual(
		leftovers.map((notice) => notice.id.split(":").at(-1)),
		["0", "1", "0", "1"],
		"warnings are numbered in the order each resume reported them",
	);
	for (const notice of notices) assert.equal(store.ackNotice(notice.id), true, notice.id);
	await fixture.close();
});
