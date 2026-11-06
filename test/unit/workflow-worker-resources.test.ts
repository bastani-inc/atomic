import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { isWorkflowAdmissionConfigError } from "../../packages/workflows/src/workers/admission-errors.js";
import {
	closeCoordinationJournals,
	coordinationPath,
	poolDurableJournal,
} from "../../packages/workflows/src/workers/pool-journal.js";
import type { WorkflowExecutionResources } from "../../packages/workflows/src/workers/public-options.js";
import {
	activatePublicPool,
	refusedResourceChanges,
	workerResources,
} from "../../packages/workflows/src/workers/public-pool.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

afterEach(closeCoordinationJournals);

const root = resolve("/roots/review");
const definition = (name: string) => ({ path: join(root, `${name}.js`), exportName: "default" });
const recorded = (name: string, digest = "a".repeat(64)) => ({ ...definition(name), digest });
const savedWorkers: WorkflowExecutionResources = {
	localWorkers: { count: 2, definitions: [definition("review")] },
	definitions: [recorded("review")],
};

test("workerResources records the settings a root saves, resolved against its directory (#4321)", () => {
	const requested: string[] = [];
	const resources = workerResources(
		{
			cwd: root,
			localWorkers: {
				count: 3,
				definitions: [{ path: "review.js", exportName: "default" }],
				startupTimeoutMs: 1_000,
				leaseMs: 4_000,
				heartbeatMs: 1_000,
				maxLoadPerCpu: 2,
				maxWorkerRssBytes: 1_024,
			},
			admission: { userDatabase: "users.sqlite", userLimits: { session: 2 } },
		},
		{
			userDatabase: () => {
				requested.push("userDatabase");
				return resolve("/pool/unused.sqlite");
			},
			digestOf: (path) => `digest of ${path}`,
			coordinator: { host: "machine", database: "pool" },
		},
	);
	assert.deepEqual(resources, {
		localWorkers: { count: 3, definitions: [definition("review")] },
		definitions: [{ ...definition("review"), digest: `digest of ${join(root, "review.js")}` }],
		admission: { userDatabase: join(root, "users.sqlite"), userLimits: { session: 2 } },
		coordinator: { host: "machine", database: "pool" },
	});
	assert.deepEqual(requested, [], "an explicit userDatabase is kept");
});

test("workerResources counts user limits that name no database in the pool's, and records no coordinator without local workers (#4321)", () => {
	const pool = resolve("/pool/coordination.sqlite");
	const context = {
		userDatabase: () => pool,
		digestOf: () => assert.fail("no definitions to digest"),
		coordinator: { host: "machine", database: "pool" },
	};
	assert.deepEqual(workerResources({ cwd: root, admission: { userLimits: { session: 2 } } }, context), {
		admission: { userLimits: { session: 2 }, userDatabase: pool },
	});
	assert.deepEqual(
		workerResources({ cwd: root, admission: { limits: { session: 2 } } }, context),
		{ admission: { limits: { session: 2 } } },
		"limits of the root's own are not user limits",
	);
});

test("refusedResourceChanges names the option behind each change a resume cannot apply (#4321)", () => {
	const changes = (saved: WorkflowExecutionResources, current: WorkflowExecutionResources, accept?: boolean) =>
		refusedResourceChanges(saved, current, accept).map(({ option, resumable, entry }) => ({
			option,
			resumable,
			...(entry ? { entry } : {}),
		}));
	const replaced = {
		localWorkers: { count: 2, definitions: [definition("summary")] },
		definitions: [recorded("summary")],
	};
	const listed = refusedResourceChanges(savedWorkers, replaced, undefined).map((change) => change.description);
	assert.equal(listed.length, 2);
	assert.ok(listed[0]?.includes(`${definition("review").path}#default`), listed[0]);
	assert.ok(listed[1]?.includes(`${definition("summary").path}#default`), listed[1]);
	assert.deepEqual(changes(savedWorkers, replaced), [
		{ option: "localWorkers", resumable: false },
		{ option: "localWorkers", resumable: false },
	]);
	assert.deepEqual(
		changes({}, savedWorkers),
		[
			{ option: "localWorkers", resumable: false },
			{ option: "localWorkers", resumable: false },
		],
		"workers turned on, with a definition added",
	);
	assert.deepEqual(
		changes({ ...savedWorkers, coordinator: { host: "machine", database: "pool" } }, savedWorkers),
		[
			{ option: "localWorkers", resumable: false },
			{ option: "localWorkers", resumable: false },
		],
		"a coordinator is recorded for local workers",
	);
	assert.deepEqual(
		changes({ admission: { userLimits: { session: 2 } } }, { admission: { userLimits: { session: 3 } } }),
		[{ option: "admission", resumable: false }],
	);
	assert.deepEqual(
		changes(
			{ ...savedWorkers, admission: { limits: { session: 2 }, host: { maxLoadPerCpu: 1 } } },
			{
				...savedWorkers,
				localWorkers: { count: 5, definitions: [definition("review")] },
				admission: { limits: { session: 4, process: 2 }, host: { maxLoadPerCpu: 3 } },
			},
		),
		[],
		"the pool size and the root's own limits can change",
	);
});

test("refusedResourceChanges applies an edited entry module only when acceptEntryChanges is true (#4321)", () => {
	const edited = { ...savedWorkers, definitions: [recorded("review", "b".repeat(64))] };
	const entryEdit = [{ option: "localWorkers", resumable: false, entry: true }];
	const refused = (current: WorkflowExecutionResources, accept: boolean | undefined) =>
		refusedResourceChanges(savedWorkers, current, accept).map(({ option, resumable, entry }) => ({
			option,
			resumable,
			...(entry ? { entry } : {}),
		}));
	assert.deepEqual(refused(edited, undefined), entryEdit);
	assert.deepEqual(refused(edited, false), entryEdit);
	assert.deepEqual(refused(edited, true), []);
	const removed = { localWorkers: { count: 2, definitions: [] }, definitions: [] };
	assert.deepEqual(
		refused(removed, true),
		[{ option: "localWorkers", resumable: false }],
		"accepting entry changes accepts nothing else",
	);
});

async function withLocalBackend(body: (directory: string, backend: JournalDurableBackend) => Promise<void>) {
	const directory = makeTempDirectory("worker-resources-");
	const journal = await resolveRunJournal({
		agentDir: join(directory, "home", "agent"),
		journal: { path: join(directory, "journal.sqlite") },
	});
	const backend = await JournalDurableBackend.open(journal);
	try {
		await body(directory, backend);
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
}

test.skipIf(process.platform === "win32")(
	"user limits on a local SQLite journal count in the journal's own file, which userDatabase must name (#4321)",
	async () => {
		await withLocalBackend(async (directory, backend) => {
			const named: RunOpts = {
				runId: "named",
				cwd: directory,
				admission: { userLimits: { session: 2 }, userDatabase: "journal.sqlite" },
			};
			assert.equal(await activatePublicPool(backend, named), undefined, "no local workers, so no pool");
			assert.deepEqual(named.effectiveResources, {
				admission: { userLimits: { session: 2 }, userDatabase: join(directory, "journal.sqlite") },
			});
			for (const userDatabase of [undefined, "elsewhere.sqlite"])
				await assert.rejects(
					activatePublicPool(backend, {
						runId: `user-database-${userDatabase}`,
						cwd: directory,
						admission: { userLimits: { session: 2 }, ...(userDatabase ? { userDatabase } : {}) },
					}),
					(error: Error) => {
						// Main's typed admission error for a userDatabase that is not the journal file (#4325).
						assert.ok(isWorkflowAdmissionConfigError(error), String(error));
						assert.equal(error.code, "user-database-mismatch");
						return true;
					},
				);
		});
	},
);

test.skipIf(process.platform === "win32")(
	"a root on a local SQLite journal refuses a worker definition whose export is not a workflow (#4321)",
	async () => {
		await withLocalBackend(async (directory, backend) => {
			writeFileSync(join(directory, "not-a-workflow.ts"), "export const child = 1;\n");
			await assert.rejects(
				activatePublicPool(backend, {
					runId: "root",
					cwd: directory,
					localWorkers: { count: 1, definitions: [{ path: "not-a-workflow.ts", exportName: "child" }] },
				}),
				/Worker definition is not importable: child/,
			);
		});
	},
);

test.skipIf(process.platform === "win32")(
	"a root on a journal in another database accepts user limits naming this machine's pool database (#4321)",
	async () => {
		const directory = makeTempDirectory("worker-resources-remote-");
		const adapter = fileURLToPath(new URL("../fixtures/delegating-run-journal-adapter.mjs", import.meta.url));
		const journal = await resolveRunJournal({
			agentDir: join(directory, "home", "agent"),
			journal: { adapter, options: { path: join(directory, "r.sqlite") } },
		});
		const backend = await JournalDurableBackend.open(journal);
		try {
			const pool = resolve(coordinationPath(poolDurableJournal(backend.journal)));
			const options: RunOpts = {
				runId: "root",
				cwd: directory,
				admission: { userLimits: { session: 2 }, userDatabase: pool },
			};
			await activatePublicPool(backend, options);
			assert.deepEqual(options.effectiveResources, {
				admission: { userLimits: { session: 2 }, userDatabase: pool },
			});
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
);

test("refusedResourceChanges names a workers setting as the workers option and an admission one as admission (#4310)", () => {
	const placed = (tree: string): WorkflowExecutionResources["workers"] => ({
		placement: "shared",
		workspace: { remotes: [], head: "h", tree, envHash: "e" },
	});
	const saved = { ...savedWorkers, admission: { userLimits: { session: 1 } }, workers: placed("t1") };
	const current = { ...savedWorkers, admission: { userLimits: { session: 2 } }, workers: placed("t2") };
	assert.deepEqual(
		refusedResourceChanges(saved, current, undefined).map(({ path, option }) => [path, option]),
		[
			["admission.userLimits.session", "admission"],
			["workers.workspace.tree", "workers"],
		],
	);
});
