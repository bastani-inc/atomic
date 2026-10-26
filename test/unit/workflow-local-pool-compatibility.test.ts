import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

test("root-local control registries are accepted for pooled resume (#3869)", async () => {
	const journal = await resolveRunJournal({ journal: { memory: true } });
	const backend = await JournalDurableBackend.open(journal);
	const pool = new LocalWorkerPool(backend, { journalPath: "/unused", workers: 1, definitions: [] });
	try {
		assert.doesNotThrow(() =>
			pool.validateOptions({
				cancellation: createCancellationRegistry(),
				toolControlRegistry: createToolControlRegistry(),
			}),
		);
	} finally {
		await pool.close();
		await backend.close();
	}
});

test("process-bound overrides fail before root registration or worker launch (#3869)", async () => {
	const journal = await resolveRunJournal({ journal: { memory: true } });
	const backend = await JournalDurableBackend.open(journal);
	const pool = new LocalWorkerPool(backend, { journalPath: "/unused", workers: 2, definitions: [] });
	try {
		const definition = workflow({
			name: "blocked",
			description: "",
			inputs: {},
			outputs: {},
			async run() {
				assert.fail("must not execute");
			},
		});
		await assert.rejects(
			run(definition, {}, { store: createStore(), durableBackend: backend, adapters: {} }),
			/process-bound override: adapters/,
		);
		assert.equal(pool.workerPids.length, 0);
		assert.equal((await journal.listRuns()).length, 0);
	} finally {
		await pool.close();
		await backend.close();
	}
});

test.each(["changed", "closure"])("%s definitions fail before launching workers (#3869)", async (kind) => {
	const directory = makeTempDirectory("pool-compatibility-");
	const path = join(directory, "child.ts");
	const source = `import { workflow } from "@bastani/atomic/workflows";
	export const child = workflow({ name: "child", description: "", inputs: {}, outputs: {}, async run(ctx) { await ctx.tool("work", {}, async () => 1); return {}; } });`;
	await writeFileEnsuringDir(path, source);
	const loaded = await loadWorkerDefinition({ path, exportName: "child", digest: await definitionDigest(path) });
	const child =
		kind === "changed"
			? loaded
			: workflow({
					name: "child",
					description: "",
					inputs: {},
					outputs: {},
					async run() {
						assert.ok(loaded);
						return {};
					},
				});
	if (kind === "changed") await writeFileEnsuringDir(path, `${source}\n`);
	const backend = await JournalDurableBackend.open(
		await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
	);
	const pool = new LocalWorkerPool(backend, {
		journalPath: join(directory, "journal.sqlite"),
		workers: 2,
		definitions: [{ path, definition: child, exportName: "child" }],
	});
	try {
		const parent = workflow({
			name: "parent",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child);
				return {};
			},
		});
		const result = await run(parent, {}, { cwd: directory, store: createStore(), durableBackend: backend });
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /definition.*(importable|compatibility)/);
		assert.equal(pool.workerPids.length, 0);
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("child budget overrides fail before launching workers (#3869)", async () => {
	const directory = makeTempDirectory("pool-child-budget-");
	const path = join(directory, "child.ts");
	await writeFileEnsuringDir(
		path,
		`import { workflow } from "@bastani/atomic/workflows";
	export const child = workflow({ name: "child", description: "", inputs: {}, outputs: {}, async run(ctx) { await ctx.tool("work", {}, async () => 1); return {}; } });`,
	);
	const child = await loadWorkerDefinition({ path, exportName: "child", digest: await definitionDigest(path) });
	const journalPath = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path: journalPath } }));
	const pool = new LocalWorkerPool(backend, {
		journalPath,
		workers: 1,
		definitions: [{ path, definition: child, exportName: "child" }],
	});
	try {
		const parent = workflow({
			name: "parent",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child, { budget: { maxDurationMs: 50 } });
				return {};
			},
		});
		const result = await run(parent, {}, { cwd: directory, store: createStore(), durableBackend: backend });
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /process-bound override: budget/);
		assert.equal(pool.workerPids.length, 0);
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("local workers accept a caller stage-control registry and still refuse every other process-bound option (#3996)", async () => {
	const journal = await resolveRunJournal({ journal: { memory: true } });
	const backend = await JournalDurableBackend.open(journal);
	const pool = new LocalWorkerPool(backend, { journalPath: "/unused", workers: 1, definitions: [] });
	try {
		assert.doesNotThrow(() => pool.validateOptions({ stageControlRegistry: createStageControlRegistry() }));
		const refused = [
			"adapters",
			"ui",
			"persistence",
			"mcp",
			"overlay",
			"models",
			"registry",
			"stageUiBroker",
			"toolAdmissionBoundary",
			"onStageStart",
			"onStageEnd",
			"onStageSession",
			"onStageSessionEvent",
			"confirmStageReadiness",
			"rootBudget",
		] as const;
		for (const key of refused)
			assert.throws(
				() => pool.validateOptions({ [key]: {} } as RunOpts),
				new RegExp(`process-bound override: ${key}$`),
				key,
			);
	} finally {
		await pool.close();
		await backend.close();
	}
});
