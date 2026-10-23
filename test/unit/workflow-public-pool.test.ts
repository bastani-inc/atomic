import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import * as host from "../../packages/workflows/src/workers/admission-host.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const definition = workflow({
	name: "public-pool",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("work", {}, async () => true);
		return {};
	},
});

test("public worker opt-in refuses unsupported storage before registering a root (#3869)", async () => {
	const journal = await resolveRunJournal({ journal: { memory: true } });
	const backend = await JournalDurableBackend.open(journal);
	try {
		const options = { durableBackend: backend, store: createStore(), localWorkers: { count: 2, definitions: [] } };
		await assert.rejects(
			run(definition, {}, options),
			process.platform === "win32" ? /containment.*Windows/i : /local.*SQLite journal/i,
		);
		assert.equal((await journal.listRuns()).length, 0);
	} finally {
		await backend.close();
	}
});

test("public worker opt-in refuses Windows before any root or process launch (#3869)", async () => {
	const platform = process.platform;
	Object.defineProperty(process, "platform", { value: "win32" });
	const journal = await resolveRunJournal({ journal: { memory: true } });
	const backend = await JournalDurableBackend.open(journal);
	try {
		const options = { durableBackend: backend, store: createStore(), localWorkers: { count: 2, definitions: [] } };
		await assert.rejects(run(definition, {}, options), /containment.*Windows/i);
		assert.equal((await journal.listRuns()).length, 0);
	} finally {
		Object.defineProperty(process, "platform", { value: platform });
		await backend.close();
	}
});

test("omitting public resource options creates no pool or admission tables (#3869)", async () => {
	const directory = makeTempDirectory("default-no-pool-");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
	const backend = await JournalDurableBackend.open(journal);
	try {
		assert.equal((await run(definition, {}, { durableBackend: backend, store: createStore() })).status, "completed");
		const tables = await sqlPoolStorage(journal)!.transaction((tx) =>
			tx.all("SELECT name FROM sqlite_master WHERE type = 'table'"),
		);
		assert.ok(tables.every((table) => !/pool|resource|_work$/.test(String(table.name))));
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("public workers refuse hosts without process identity (#3869)", async () => {
	const identity = vi.spyOn(host, "admissionBootIdentity").mockResolvedValue(null);
	const journal = await resolveRunJournal({ journal: { memory: true } });
	const backend = await JournalDurableBackend.open(journal);
	try {
		await assert.rejects(
			run(
				definition,
				{},
				{ durableBackend: backend, store: createStore(), localWorkers: { count: 1, definitions: [] } },
			),
			/containment/,
		);
		assert.equal((await journal.listRuns()).length, 0);
	} finally {
		identity.mockRestore();
		await backend.close();
	}
});

test.skipIf(process.platform === "win32").each([
	{ localWorkers: { count: 0, definitions: [] }, error: /worker count/ },
	{ localWorkers: { count: 1, definitions: [] }, adapters: {}, error: /process-bound override: adapters/ },
	{
		admission: { userLimits: { session: 1 }, userDatabase: "/not-the-journal.sqlite" },
		error: /canonical journal database/,
	},
	{ admission: { limits: { process: 0 } }, error: /resource limit/ },
])("invalid public configuration is rejected before root admission ($error) (#3869)", async ({ error, ...options }) => {
	const directory = makeTempDirectory("invalid-pool-");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
	const backend = await JournalDurableBackend.open(journal);
	try {
		await assert.rejects(run(definition, {}, { ...options, durableBackend: backend, store: createStore() }), error);
		assert.equal((await journal.listRuns()).length, 0);
		assert.equal((await run(definition, {}, { durableBackend: backend, store: createStore() })).status, "completed");
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
});

test.skipIf(process.platform === "win32").each([false, true])(
	"one public pool does not capture another root, pooled=$0 (#3869)",
	async (pooled) => {
		const directory = makeTempDirectory("independent-pools-");
		const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
		const backend = await JournalDurableBackend.open(journal);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = workflow({
			name: "first-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				entered.resolve();
				await release.promise;
				await ctx.tool("work", {}, async () => true);
				return {};
			},
		});
		const localWorkers = { count: 1, definitions: [] };
		const running = run(first, {}, { runId: "first", durableBackend: backend, store: createStore(), localWorkers });
		try {
			await entered.promise;
			const result = await run(
				definition,
				{},
				{ runId: "second", durableBackend: backend, store: createStore(), ...(pooled ? { localWorkers } : {}) },
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
		} finally {
			release.resolve();
			await running;
			await backend.close();
			removeTempDirectory(directory);
		}
	},
);

test.skipIf(process.platform === "win32")("resume refuses to change an originally unpooled root (#3869)", async () => {
	const directory = makeTempDirectory("pool-resume-config-");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
	const backend = await JournalDurableBackend.open(journal);
	const options = { runId: "root", durableBackend: backend, store: createStore() };
	try {
		assert.equal((await run(definition, {}, options)).status, "completed");
		await assert.rejects(
			run(definition, {}, { ...options, localWorkers: { count: 1, definitions: [] } }),
			/immutable resource configuration/i,
		);
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
});

test.skipIf(process.platform === "win32")(
	"optional undefined resource fields survive journal round trips (#3869)",
	async () => {
		const directory = makeTempDirectory("pool-resume-undefined-");
		const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
		const backend = await JournalDurableBackend.open(journal);
		const options = {
			runId: "root",
			durableBackend: backend,
			store: createStore(),
			localWorkers: { count: 1, definitions: [] },
			admission: { limits: { session: 1, process: undefined }, host: undefined },
		};
		try {
			assert.equal((await run(definition, {}, options)).status, "completed");
			assert.equal((await run(definition, {}, options)).status, "completed");
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
);
