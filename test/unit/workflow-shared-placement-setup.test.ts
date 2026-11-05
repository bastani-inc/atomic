import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { SHARED_STORAGE_JOIN_HINT } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { openWorkerJournals } from "../../packages/workflows/src/workers/local-worker.js";
import {
	isSharedPoolSetupError,
	isWorkerPlacementConfigError,
	type SharedPoolSetupError,
	type WorkerPlacementConfigError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import {
	coordinationPath,
	openCoordinationJournal,
	POOL_DURABLE_JOURNAL_ENV,
	poolDurableJournal,
	poolHostId,
	poolJournalOf,
	poolStateDirectory,
	registerPoolJournal,
} from "../../packages/workflows/src/workers/pool-journal.js";
import { openPoolSessions, poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import { DEFAULT_PLACEMENT_CLAIM_WINDOW_MS } from "../../packages/workflows/src/workers/public-options.js";
import {
	activatePublicPool,
	processContainmentAvailable,
	restoreWorkerOptions,
	sharedPoolPlacement,
} from "../../packages/workflows/src/workers/public-pool.js";
import { probeGit, startWorkflowWorkerHost } from "../../packages/workflows/src/workers/worker-host.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));
const countingAdapter = fileURLToPath(new URL("../fixtures/counting-storage-adapter.mjs", import.meta.url));
const countingGit = fileURLToPath(new URL("../fixtures/counting-git.sh", import.meta.url));
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const localWorkers = { count: 1, definitions: [{ path: childPath, exportName: "child" }] };
const binding = { remotes: ["https://example.invalid/r.git"], head: "h", tree: "t", envHash: "e" };
/**
 * Probes the counting git stand-in records. It is a shell script, which Windows cannot execute: there the probe still
 * runs and finds no git, but nothing records it.
 */
const RECORDED_PROBE = process.platform === "win32" ? 0 : 1;

function lines(path: string): number {
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

async function refused<T extends Error>(promise: Promise<unknown>): Promise<T> {
	const outcome = await promise.then(
		() => undefined,
		(error: T) => error,
	);
	assert.ok(outcome instanceof Error, "the call is refused");
	return outcome;
}

test("shared placement options are checked before anything starts, naming the field (#4310)", async () => {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	try {
		const cases: readonly [Partial<RunOpts>, string, string][] = [
			[{ localWorkers, workers: { placement: "local" as "shared" } }, "workers.placement", "invalid-option"],
			[
				{ localWorkers, workers: { placement: "shared", workspace: { tree: 1 } as never } },
				"workers.workspace",
				"invalid-option",
			],
			[
				{ localWorkers, workers: { placement: "shared", claimWindowMs: 0 } },
				"workers.claimWindowMs",
				"invalid-option",
			],
			[{ workers: { placement: "shared", workspace: binding } }, "localWorkers", "requires-local-workers"],
			[
				{ localWorkers, workers: { placement: "shared" }, admission: { userLimits: { session: 1 } } },
				"admission.userLimits",
				"unsupported-option",
			],
		];
		for (const [options, field, code] of cases) {
			const error = await refused<WorkerPlacementConfigError>(
				activatePublicPool(backend, { runId: "root", cwd: process.cwd(), ...options }),
			);
			assert.ok(isWorkerPlacementConfigError(error), `${field}: ${error.message}`);
			assert.deepEqual([error.field, error.code, error.source], [field, code, "sdk"]);
			assert.ok(error.hint !== undefined && error.message.endsWith(error.hint));
		}
	} finally {
		await backend.close();
	}
});

test("shared placement on a journal other hosts cannot open fails at once, touching no storage (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	let statements = 0;
	const counted = new Proxy(database, {
		get(target, key) {
			const value = Reflect.get(target, key);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (["exec", "run", "get", "all", "transaction"].includes(String(key))) statements++;
				return value.apply(target, args);
			};
		},
	});
	const journal = await resolveRunJournal({ agentDir: join(directory, "agent"), journal: { database: counted } });
	const backend = await JournalDurableBackend.open(journal);
	try {
		const before = statements;
		const error = await refused<SharedPoolSetupError>(
			activatePublicPool(backend, {
				runId: "root",
				cwd: directory,
				localWorkers,
				workers: { placement: "shared" },
			}),
		);
		assert.equal(statements - before, 0, "no statement ran before the refusal");
		assert.ok(isSharedPoolSetupError(error));
		assert.deepEqual([error.code, error.operation], ["shared-journal-required", "shared-placement"]);
		assert.deepEqual(error.problems[0]?.fields, { selection: "a database journal" });
		assert.ok(error.hint?.includes(SHARED_STORAGE_JOIN_HINT));
		assert.equal(existsSync(join(directory, "workflows", "pool")), false, "no pool state was created");

		const memory = await JournalDurableBackend.open(new MemoryRunJournal());
		const objectJournal = await refused<SharedPoolSetupError>(
			activatePublicPool(memory, { runId: "root", cwd: directory, localWorkers, workers: { placement: "shared" } }),
		);
		assert.deepEqual(objectJournal.problems[0]?.fields, { selection: "a journal object" });
		await memory.close();

		// On a host that cannot contain its workers' processes, the same pass reports that too, still touching nothing.
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			const beforeWindows = statements;
			const both = await refused<SharedPoolSetupError>(
				activatePublicPool(backend, {
					runId: "root",
					cwd: directory,
					localWorkers,
					workers: { placement: "shared" },
				}),
			);
			assert.equal(statements - beforeWindows, 0, "no statement ran before the refusal");
			assert.deepEqual(
				both.problems.map((problem) => [problem.code, problem.fields]),
				[
					["shared-journal-required", { selection: "a database journal" }],
					["process-containment-unavailable", { platform: "win32" }],
				],
			);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	} finally {
		await backend.close();
		await database.close();
		await removeLibsqlDirectory(directory);
	}
});

test("a worker host reports every missing piece of its setup at once, before it opens anything (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const opens = join(directory, "opens.log");
	const probes = join(directory, "git-probes.log");
	try {
		const invalid = await refused<WorkerPlacementConfigError>(
			startWorkflowWorkerHost({
				journal: { adapter: countingAdapter, options: { log: opens } },
				maxWorkers: 0,
				git: { path: countingGit, env: { COUNTING_GIT_LOG: probes } },
			}),
		);
		assert.deepEqual([invalid.code, invalid.field], ["invalid-option", "maxWorkers"]);
		assert.deepEqual([lines(opens), lines(probes)], [0, 0], "an invalid option is refused before any probe");

		const path = join(directory, "local.sqlite");
		const local = await refused<SharedPoolSetupError>(
			startWorkflowWorkerHost({ journal: { path } as never, agentDir: join(directory, "agent"), maxWorkers: 1 }),
		);
		assert.ok(isSharedPoolSetupError(local));
		assert.deepEqual([local.code, local.operation], ["shared-journal-required", "worker-host"]);
		assert.deepEqual(local.problems[0]?.fields, { selection: "a sqlite journal", location: path });
		assert.equal(existsSync(path), false, "the local journal was never opened");

		const missing = await refused<SharedPoolSetupError>(
			startWorkflowWorkerHost({
				journal: {
					adapter: countingAdapter,
					options: { log: opens },
					secrets: {
						authToken: { env: "ATOMIC_TEST_SHARED_POOL_TOKEN_NOT_SET" },
						certificate: { file: join(directory, "missing.pem") },
					},
				},
				agentDir: join(directory, "agent"),
				maxWorkers: 1,
				restore: async () => directory,
				git: { path: countingGit, env: { COUNTING_GIT_LOG: probes } },
			}),
		);
		// A host that cannot contain its workers' processes, such as on Windows, is told so with the rest.
		const containment = (await processContainmentAvailable())
			? []
			: [["process-containment-unavailable", { platform: process.platform }]];
		assert.deepEqual(
			missing.problems.map((problem) => [problem.code, problem.fields]),
			[
				["journal-secret-unavailable", { secret: "authToken", env: "ATOMIC_TEST_SHARED_POOL_TOKEN_NOT_SET" }],
				["journal-secret-unavailable", { secret: "certificate", file: join(directory, "missing.pem") }],
				["git-unavailable", { path: countingGit, platform: process.platform }],
				...containment,
			],
		);
		assert.deepEqual([lines(opens), lines(probes)], [0, RECORDED_PROBE], "nothing was opened; git was probed once");

		const unloadable = await refused<SharedPoolSetupError>(
			startWorkflowWorkerHost({
				journal: { adapter: join(directory, "no-such-adapter.mjs") },
				agentDir: join(directory, "agent"),
				maxWorkers: 1,
			}),
		);
		assert.deepEqual(
			unloadable.problems.map((problem) => problem.code),
			["storage-adapter-unavailable", ...containment.map(([code]) => code)],
		);
		assert.ok(unloadable.hint?.includes("atomic install npm:@bastani/atomic-storage-libsql"));
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test("a worker host on Windows is refused before it opens the journal: its workers cannot contain their processes (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const opens = join(directory, "opens.log");
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "win32" });
	try {
		const refusal = await refused<SharedPoolSetupError>(
			startWorkflowWorkerHost({
				journal: { adapter: countingAdapter, options: { log: opens } },
				agentDir: join(directory, "agent"),
				maxWorkers: 1,
			}),
		);
		assert.ok(isSharedPoolSetupError(refusal));
		assert.deepEqual(
			refusal.problems.map((problem) => [problem.code, problem.fields]),
			[["process-containment-unavailable", { platform: "win32" }]],
		);
		assert.equal(
			refusal.message,
			"Shared worker pool setup incomplete for startWorkflowWorkerHost: missing process containment for pooled workers (this host runs win32), which their tool processes need (process-containment-unavailable). Run worker hosts on Linux or macOS.",
		);
		assert.equal(lines(opens), 0, "the journal was never opened");
	} finally {
		Object.defineProperty(process, "platform", platform);
		await removeLibsqlDirectory(directory);
	}
});

test.skipIf(process.platform === "win32")(
	"a worker host without git or restore starts, and says so in its stats (#4310)",
	async () => {
		const directory = makeLibsqlDirectory();
		const probes = join(directory, "git-probes.log");
		try {
			const host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(directory, "shared.db")).href },
					prefix: "acme_",
				},
				agentDir: join(directory, "agent"),
				maxWorkers: 2,
				hostId: "host-c",
				labels: { zone: "test" },
				git: { path: countingGit, env: { COUNTING_GIT_LOG: probes } },
			});
			try {
				const stats = await host.stats();
				assert.deepEqual(
					{ ...stats },
					{
						hostId: "host-c",
						labels: { zone: "test" },
						git: "unavailable",
						restore: false,
						maxWorkers: 2,
						workers: 0,
						busy: 0,
						roots: [],
					},
				);
				assert.equal(host.hostId, "host-c");
			} finally {
				await host.stop();
			}
			assert.equal(lines(probes), RECORDED_PROBE);
		} finally {
			await removeLibsqlDirectory(directory);
		}
	},
);

test("each shared placement option names what is wrong with it (#4310)", async () => {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	try {
		const detail = async (options: Partial<RunOpts>) =>
			(
				await refused<WorkerPlacementConfigError>(
					activatePublicPool(backend, { runId: "root", cwd: process.cwd(), ...options }),
				)
			).detail;
		assert.equal(
			await detail({ localWorkers, workers: { placement: "other" as "shared" } }),
			'the only placement is "shared"',
		);
		assert.equal(
			await detail({ localWorkers, workers: { placement: "shared", workspace: [] as never } }),
			"a binding has string remotes, head, tree and envHash",
		);
		for (const claimWindowMs of [0, -5, 1.5, Number.NaN])
			assert.equal(
				await detail({ localWorkers, workers: { placement: "shared", claimWindowMs } }),
				"must be a positive integer of milliseconds",
				String(claimWindowMs),
			);
		assert.equal(
			await detail({ localWorkers, workers: { placement: "shared" }, admission: { userLimits: { process: 2 } } }),
			"user limits count only on one machine's journal file",
		);
		// A window of one millisecond is valid: the journal is what refuses the pool here.
		const journal = await refused<SharedPoolSetupError>(
			activatePublicPool(backend, {
				runId: "root",
				cwd: process.cwd(),
				localWorkers,
				workers: { placement: "shared", claimWindowMs: 1, workspace: binding },
			}),
		);
		assert.ok(isSharedPoolSetupError(journal));
		const notJournal = await refused<SharedPoolSetupError>(
			activatePublicPool({} as never, { runId: "root", localWorkers, workers: { placement: "shared" } }),
		);
		assert.deepEqual(notJournal.problems[0]?.fields, { selection: "a durable backend without a journal" });
	} finally {
		await backend.close();
	}
});

test("shared placement names the journal it cannot share: a file, or an adapter that is not SQL (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const delegating = fileURLToPath(new URL("../fixtures/delegating-run-journal-adapter.mjs", import.meta.url));
	try {
		const path = join(directory, "local.sqlite");
		for (const [selection, fields] of [
			[{ path }, { selection: "a sqlite journal", location: path }],
			[
				{ adapter: delegating, options: { path: join(directory, "d.sqlite") } },
				{ selection: "an adapter journal that is not SQL", location: delegating },
			],
		] as const) {
			const journal = await resolveRunJournal({ agentDir: join(directory, "agent"), journal: selection });
			const backend = await JournalDurableBackend.open(journal);
			try {
				const error = await refused<SharedPoolSetupError>(
					activatePublicPool(backend, {
						runId: "root",
						cwd: directory,
						localWorkers,
						workers: { placement: "shared" },
					}),
				);
				assert.deepEqual(error.problems[0]?.fields, fields);
			} finally {
				await backend.close();
			}
		}
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test("a shared pool on this host keeps its state beside the agent directory, with the root's window and binding (#4310)", () => {
	const shared = { selection: "{}", agentDir: join(makeTempDirectory("shared-placement-host-"), "agent") };
	try {
		assert.deepEqual(sharedPoolPlacement(shared, { placement: "shared" }), {
			shared: {
				stateDirectory: poolStateDirectory(shared.agentDir),
				host: poolHostId(shared.agentDir),
				claimWindowMs: DEFAULT_PLACEMENT_CLAIM_WINDOW_MS,
			},
		});
		assert.equal(DEFAULT_PLACEMENT_CLAIM_WINDOW_MS, 60_000);
		assert.deepEqual(sharedPoolPlacement(shared, { placement: "shared", claimWindowMs: 5, workspace: binding }), {
			shared: {
				stateDirectory: poolStateDirectory(shared.agentDir),
				host: poolHostId(shared.agentDir),
				claimWindowMs: 5,
			},
			workspace: binding,
		});
	} finally {
		removeTempDirectory(join(shared.agentDir, ".."));
	}
});

/**
 * Structural: the test opens a libSQL journal through its storage adapter, activates a root's shared pool with its
 * worker definitions, resumes it, and checks two refused resumes.
 */
const SHARED_POOL_ACTIVATION_TIMEOUT_MS = 60_000;

test.skipIf(process.platform === "win32")(
	"a root with shared placement keeps its pool in its own journal, saves the placement, and resumes only with it (#4310)",
	async () => {
		const directory = makeLibsqlDirectory();
		const agentDir = join(directory, "agent");
		const journal = await resolveRunJournal({
			agentDir,
			journal: {
				adapter: libsql,
				options: { url: pathToFileURL(join(directory, "shared.db")).href },
				prefix: "acme_",
			},
		});
		const backend = await JournalDurableBackend.open(journal);
		try {
			const options: RunOpts = {
				runId: "root",
				cwd: directory,
				localWorkers,
				workers: { placement: "shared", claimWindowMs: 1_000 },
			};
			const pool = await activatePublicPool(backend, options);
			assert.ok(pool);
			await pool.close();
			assert.deepEqual(options.effectiveResources?.workers, { placement: "shared", claimWindowMs: 1_000 });
			assert.equal(options.effectiveResources?.coordinator, undefined, "no machine holds this root's pool");
			assert.equal(await poolJournalOf(journal), journal, "the pool's tables are in the root's own journal");
			assert.equal(
				existsSync(poolStateDirectory(agentDir)) &&
					readdirSync(poolStateDirectory(agentDir)).some((name) => name.endsWith(".sqlite")),
				false,
			);
			const saved = options.effectiveResources!;
			// The claim window may change on resume; turning shared placement off, or binding the children, may not.
			const resumed = await activatePublicPool(backend, {
				runId: "root",
				cwd: directory,
				localWorkers,
				workers: { placement: "shared", claimWindowMs: 2_000 },
				effectiveResources: saved,
			});
			await resumed?.close();
			for (const [workers, field, change] of [
				[undefined, "workers.placement", 'workers.placement changed from "shared" to unset'],
				[
					{ placement: "shared", workspace: binding },
					"workers.workspace.remotes",
					`workers.workspace.remotes changed from unset to ${JSON.stringify(binding.remotes)}`,
				],
			] as const) {
				const error = await refused<WorkerPlacementConfigError>(
					activatePublicPool(backend, {
						runId: "root",
						cwd: directory,
						localWorkers,
						...(workers === undefined ? {} : { workers }),
						effectiveResources: saved,
					}),
				);
				assert.ok(isWorkerPlacementConfigError(error), String(error));
				assert.deepEqual([error.code, error.source, error.field], ["changed-on-resume", "sdk", field]);
				assert.ok(error.detail?.split("; ").includes(change), error.detail);
			}
			const restored = await restoreWorkerOptions(backend, { runId: "root" });
			assert.equal(restored.workers, undefined, "a root that saved nothing restores nothing");
		} finally {
			await backend.close();
			await removeLibsqlDirectory(directory);
		}
	},
	SHARED_POOL_ACTIVATION_TIMEOUT_MS,
);

test("a shared root's finished stage sessions are read from its journal even where a local pool ran (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const journal = await resolveRunJournal({
		agentDir: join(directory, "agent"),
		journal: { adapter: libsql, options: { url: pathToFileURL(join(directory, "shared.db")).href }, prefix: "acme_" },
	});
	const backend = await JournalDurableBackend.open(journal);
	// A root without shared placement ran a pool on this machine: its stage sessions are in the coordination database.
	const coordination = await openCoordinationJournal(coordinationPath(poolDurableJournal(journal)));
	registerPoolJournal(journal, coordination);
	try {
		const header = (id: string): SessionRecordHeader => ({
			id,
			version: SESSION_FORMAT_VERSION,
			createdAt: new Date(0).toISOString(),
			cwd: directory,
		});
		for (const [pool, sessionId] of [
			[coordination, "local-stage"],
			[journal, "shared-stage"],
		] as const) {
			await openSqlPoolQueue(pool);
			const sessions = await openPoolSessions(sqlPoolStorage(pool)!);
			await sessions.create(header(sessionId), []);
			await sessions.close();
		}
		for (const [runId, started] of [
			["shared-root", { resources: { localWorkers, workers: { placement: "shared" as const } } }],
			["local-root", { resources: { localWorkers } }],
			["plain-root", {}],
		] as const) {
			await journal.createRun({ runId, name: runId, cwd: "", createdAt: 0, status: "completed" });
			const acquired = await journal.acquire(runId, "owner");
			if (acquired.status !== "acquired") assert.fail("no lease");
			await journal.append(acquired.lease, {
				type: RUN_EVENT_TYPES.runStarted,
				payload: { workflowId: runId, name: runId, inputs: {}, createdAt: 0, status: "running", ...started },
			});
			// A shared root's pool runs in the journal itself.
			if (runId === "shared-root") await (await openSqlPoolQueue(journal)).initialize(acquired.lease, 60_000);
		}
		const found = async (rootRunId: string) => {
			const sessions = await poolSessionStore(backend, rootRunId);
			try {
				return [(await sessions?.readHeader("shared-stage"))?.id, (await sessions?.readHeader("local-stage"))?.id];
			} finally {
				await sessions?.close();
			}
		};
		assert.deepEqual(await found("shared-root"), ["shared-stage", undefined]);
		assert.deepEqual(await found("local-root"), [undefined, "local-stage"]);
		assert.deepEqual(
			await found("plain-root"),
			[undefined, "local-stage"],
			"a root without resources reads the machine's",
		);
		assert.deepEqual(await found("no-such-run"), [undefined, "local-stage"], "an unknown run reads the machine's");
		assert.equal(
			await poolSessionStore({} as never, "shared-root"),
			undefined,
			"a backend without a journal has none",
		);
	} finally {
		await backend.close();
		await coordination.close();
		await removeLibsqlDirectory(directory);
	}
});

test("a root that started without resources cannot gain shared placement on resume (#4310)", async () => {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	try {
		await backend.journal.createRun({ runId: "plain", name: "plain", cwd: "", createdAt: 0, status: "running" });
		const acquired = await backend.journal.acquire("plain", "owner");
		if (acquired.status !== "acquired") assert.fail("no lease");
		await backend.journal.append(acquired.lease, {
			type: RUN_EVENT_TYPES.runStarted,
			payload: { workflowId: "plain", name: "plain", inputs: {}, createdAt: 0, status: "running" },
		});
		for (const [options, named] of [
			[{ workers: { placement: "shared" } }, "workers"],
			[{ admission: {}, workers: { placement: "shared" } }, "admission and workers"],
		] as const) {
			const error = await refused<WorkerPlacementConfigError>(
				restoreWorkerOptions(backend, { runId: "plain", ...options } as RunOpts),
			);
			assert.ok(isWorkerPlacementConfigError(error), String(error));
			assert.deepEqual(
				[error.code, error.source, error.field, error.detail],
				[
					"changed-on-resume",
					"sdk",
					"workers",
					`root plain started without local workers or resource admission, and this resume sets ${named}`,
				],
			);
		}
		const plain = await restoreWorkerOptions(backend, { runId: "plain" });
		assert.equal(plain.workers, undefined, "a resume that sets nothing is not refused");
		await backend.journal.createRun({ runId: "saved", name: "saved", cwd: "", createdAt: 0, status: "running" });
		const savedLease = await backend.journal.acquire("saved", "owner");
		if (savedLease.status !== "acquired") assert.fail("no lease");
		const resources = { localWorkers, workers: { placement: "shared" as const, claimWindowMs: 7 } };
		await backend.journal.append(savedLease.lease, {
			type: RUN_EVENT_TYPES.runStarted,
			payload: { workflowId: "saved", name: "saved", inputs: {}, createdAt: 0, status: "running", resources },
		});
		const restored = await restoreWorkerOptions(backend, { runId: "saved" });
		assert.deepEqual(restored.workers, resources.workers, "a resume runs with the placement the root saved");
		const given = { placement: "shared" as const, claimWindowMs: 9 };
		assert.deepEqual((await restoreWorkerOptions(backend, { runId: "saved", workers: given })).workers, given);
	} finally {
		await backend.close();
	}
});

test("each worker host option names what is wrong with it, before any journal or git is touched (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const opens = join(directory, "opens.log");
	const probes = join(directory, "git-probes.log");
	const base = {
		journal: { adapter: countingAdapter, options: { log: opens } },
		agentDir: join(directory, "agent"),
		maxWorkers: 1,
		git: { path: countingGit, env: { COUNTING_GIT_LOG: probes } },
	};
	try {
		const cases: [Record<string, unknown>, string, string][] = [
			[{ maxWorkers: 1.5 }, "maxWorkers", "must be a positive integer"],
			[{ maxWorkers: -1 }, "maxWorkers", "must be a positive integer"],
			[{ labels: { zone: "east", rack: 7 } }, "labels.rack", "labels are strings"],
			[{ hostId: "" }, "hostId", "a non-empty id without '/'"],
			[{ hostId: "east/1" }, "hostId", "a non-empty id without '/'"],
			[{ restore: "/srv/tree" }, "restore", "a function"],
			[{ placement: { prefer: "/srv/tree" } }, "placement.prefer", "a function"],
			[{ git: { path: "", env: {} } }, "git.path", "a non-empty path"],
			[{ git: { path: 7, env: {} } }, "git.path", "a non-empty path"],
		];
		for (const [options, field, detail] of cases) {
			const error = await refused<WorkerPlacementConfigError>(
				startWorkflowWorkerHost({ ...base, ...options } as unknown as Parameters<
					typeof startWorkflowWorkerHost
				>[0]),
			);
			assert.ok(isWorkerPlacementConfigError(error), String(error));
			assert.deepEqual(
				[error.code, error.source, error.field, error.detail],
				["invalid-option", "sdk", field, detail],
			);
		}
		const selection = await refused<WorkerPlacementConfigError>(
			startWorkflowWorkerHost({ ...base, journal: { createRun: () => {} } as never }),
		);
		assert.deepEqual(
			[
				selection.code,
				selection.source,
				selection.field,
				selection.detail,
				(selection.cause as { reason?: string }).reason,
			],
			["invalid-option", "sdk", "journal", "invalid-journal", "invalid-journal"],
		);
		const object = await refused<SharedPoolSetupError>(
			startWorkflowWorkerHost({ ...base, journal: new MemoryRunJournal() as never }),
		);
		assert.deepEqual(
			object.problems.map((problem) => [problem.code, problem.fields]),
			[
				["shared-journal-required", { selection: "a journal object" }],
				// A host that cannot contain its workers' processes, such as on Windows, is told so with the rest.
				...((await processContainmentAvailable())
					? []
					: [["process-containment-unavailable", { platform: process.platform }]]),
			],
		);
		assert.deepEqual(
			[lines(opens), lines(probes)],
			[0, RECORDED_PROBE],
			"only the setup check probed git; nothing was opened",
		);
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test.skipIf(process.platform === "win32")(
	"a worker host whose secrets are present and whose git runs starts, restoring bound work, named for its agent directory (#4310)",
	async () => {
		const directory = makeLibsqlDirectory();
		const token = join(directory, "token");
		writeFileSync(token, "unused");
		process.env.ATOMIC_TEST_SHARED_POOL_SECRET = "unused";
		try {
			const host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(directory, "shared.db")).href },
					prefix: "acme_",
					secrets: { encryptionKey: { file: token }, authToken: { env: "ATOMIC_TEST_SHARED_POOL_SECRET" } },
				},
				agentDir: join(directory, "agent"),
				maxWorkers: 1,
				restore: async () => directory,
			});
			try {
				const stats = await host.stats();
				assert.deepEqual(
					[stats.git, stats.restore, stats.hostId],
					["system", true, poolHostId(join(directory, "agent"))],
				);
			} finally {
				await host.stop();
			}
		} finally {
			delete process.env.ATOMIC_TEST_SHARED_POOL_SECRET;
			await removeLibsqlDirectory(directory);
		}
	},
);

test("a local worker pool refuses to start without the database its tables are in (#4310)", async () => {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	try {
		const shared = { stateDirectory: "/unused", host: "h", claimWindowMs: 1 };
		for (const [options, field] of [
			[{}, "journalPath"],
			[{ shared }, "durable"],
		] as const) {
			let error: WorkerPlacementConfigError | undefined;
			try {
				new LocalWorkerPool(backend, { ...options, workers: 1, definitions: [] });
			} catch (caught) {
				error = caught as WorkerPlacementConfigError;
			}
			assert.ok(isWorkerPlacementConfigError(error), String(error));
			assert.deepEqual(
				[error.code, error.source, error.field, error.detail],
				["invalid-option", "sdk", field, "a local worker pool needs the database its tables are in"],
			);
		}
	} finally {
		await backend.close();
	}
});

test("a local worker pool refuses a pool database other than its root's own SQLite journal (#4310)", async () => {
	const directory = makeTempDirectory("local-pool-database-");
	const backend = await JournalDurableBackend.open(
		await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
	);
	try {
		const pool = new LocalWorkerPool(backend, {
			journalPath: join(directory, "elsewhere.sqlite"),
			workers: 1,
			definitions: [],
		});
		await assert.rejects(pool.prepare("root"), {
			message: "Local workers require the same default-prefix SQLite journal",
		});
		await pool.close();
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("a worker opens the journals its pool names: a shared pool's by the durable selection, a local one's by path (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	try {
		const shared = await resolveRunJournal({
			agentDir: join(directory, "agent"),
			journal: {
				adapter: libsql,
				options: { url: pathToFileURL(join(directory, "shared.db")).href },
				prefix: "acme_",
			},
		});
		const selection = JSON.stringify(poolDurableJournal(shared));
		await shared.close();
		const opened = await openWorkerJournals({}, selection);
		try {
			assert.equal(opened.journal, opened.poolJournal, "a shared pool's tables are in the durable journal");
			const storage = sqlPoolStorage(opened.poolJournal)!;
			assert.equal(storage.tables.runs, "acme_wf_runs");
			const sessions = await storage.read((executor) =>
				executor.all(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'acme_wf_runs_pool_session%'",
				),
			);
			assert.ok(sessions.length > 0, "the pooled-stage sessions live in the shared journal");
		} finally {
			await opened.sessions.close();
			await opened.journal.close();
		}
		const path = join(directory, "local.sqlite");
		const local = await openWorkerJournals({ journalPath: path }, undefined);
		try {
			assert.equal(local.journal, local.poolJournal);
			assert.ok(local.poolJournal instanceof SqlRunJournal);
			assert.equal(local.poolJournal.path, path);
		} finally {
			await local.sessions.close();
			await local.journal.close();
		}
		const missing = await refused<WorkerPlacementConfigError>(openWorkerJournals({}, undefined));
		assert.deepEqual(
			[missing.code, missing.source, missing.field, missing.detail],
			["invalid-option", "env", POOL_DURABLE_JOURNAL_ENV, "a shared pool's worker needs it"],
		);
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test("git a host cannot even spawn counts as unavailable, never as a thrown spawn error (#4310)", async () => {
	assert.equal(await probeGit({ path: "git\u0000unspawnable", env: {} }), "unavailable");
	const directory = makeLibsqlDirectory();
	try {
		assert.equal(await probeGit({ path: join(directory, "git"), env: {} }), "unavailable");
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test("shared placement is checked whichever door a root comes through: run() and a backend without a journal (#4310)", async () => {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	try {
		const child = workflow({ name: "unpooled", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
		const error = await refused<WorkerPlacementConfigError>(
			run(
				child,
				{},
				{ cwd: process.cwd(), store: createStore(), durableBackend: backend, workers: { placement: "shared" } },
			),
		);
		assert.ok(isWorkerPlacementConfigError(error), String(error));
		assert.equal(error.code, "requires-local-workers");
	} finally {
		await backend.close();
	}
	const journalless = await refused<SharedPoolSetupError>(
		activatePublicPool({} as never, {
			runId: "root",
			cwd: process.cwd(),
			localWorkers,
			workers: { placement: "shared" },
		}),
	);
	assert.deepEqual(
		journalless.problems.map((problem) => [problem.code, problem.fields]),
		[
			["shared-journal-required", { selection: "a durable backend without a journal" }],
			// A host that cannot contain its workers' processes, such as on Windows, is told so in the same pass.
			...((await processContainmentAvailable())
				? []
				: [["process-containment-unavailable", { platform: process.platform }]]),
		],
	);
});
