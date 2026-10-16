import assert from "node:assert/strict";
import { readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqliteDatabase, StorageConfigError } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { getDurableBackendProcessOwner } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { initializeDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	JournalBackendClosedError,
	JournalDurableBackend,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSqlRunJournal, SqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { type RunJournal, StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
import { currentWorkflowSessionRunState } from "../../packages/workflows/src/extension/adopt-session-run-state.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { optionCases } from "../fixtures/storage-value-adapter.js";
import {
	fileExists,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

async function resetBackends(): Promise<void> {
	for (const selected of getDurableBackendProcessOwner().selectedBackends?.values() ?? []) {
		await selected.ready;
		await selected.close?.();
	}
	setDurableBackend(undefined);
}

const directories: string[] = [];
afterEach(async () => {
	await resetBackends();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	if (process.platform === "linux") {
		const handles = readdirSync("/proc/self/fd").flatMap((fd) => {
			try {
				const path = readlinkSync(`/proc/self/fd/${fd}`);
				return directories.some((directory) => path.startsWith(`${directory}/`)) &&
					/runs\.sqlite(?:-wal|-shm)?$/.test(path)
					? [path]
					: [];
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				return [];
			}
		});
		assert.deepEqual(handles, [], "journal cleanup must release every SQLite file descriptor (#3682)");
	}
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

function journalPath(): string {
	const directory = makeTempDirectory("journal-wiring-");
	directories.push(directory);
	return join(directory, "runs.sqlite");
}

function definition(onTool: () => void) {
	return workflow({
		name: "configured-journal",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("effect", {}, async () => {
				onTool();
				return "saved";
			});
			await ctx.stage("finish").prompt("finish");
			return {};
		},
	});
}

for (const storage of ["memory", "sqlite"] as const) {
	test(`SDK executes and replays tool and stage checkpoints in the selected ${storage} journal`, async () => {
		const journal = storage === "memory" ? new MemoryRunJournal() : await openSqlRunJournal(journalPath());
		let tools = 0;
		let stages = 0;
		const def = definition(() => {
			tools++;
		});
		const options = {
			journal,
			runId: `selected-${storage}`,
			store: createStore(),
			adapters: {
				prompt: {
					prompt: async () => {
						stages++;
						return "finished";
					},
				},
			},
		};
		try {
			assert.equal((await run(def, {}, options)).status, "completed");
			const backend = await JournalDurableBackend.open(journal);
			try {
				assert.equal(backend.journal, journal);
				assert.equal(backend.getWorkflow(options.runId)?.status, "completed");
				assert.ok(backend.listCheckpoints(options.runId).some((entry) => entry.kind === "tool"));
				assert.ok(backend.listCheckpoints(options.runId).some((entry) => entry.kind === "stage"));
				assert.equal((await run(def, {}, { ...options, store: createStore() })).status, "completed");
				assert.equal(tools, 1);
				assert.equal(stages, 1);
			} finally {
				await backend.close();
			}
		} finally {
			await journal.close();
		}
	});
}

test("async-only custom journal delays workflow completion until its checkpoint commits", async () => {
	const memory = new MemoryRunJournal();
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let gated = false;
	const journal: RunJournal = {
		createRun: (header) => memory.createRun(header),
		getRun: (runId) => memory.getRun(runId),
		leaseState: (runId) => memory.leaseState(runId),
		takeoverExpired: (runId, holderId, staleAfterMs) => memory.takeoverExpired(runId, holderId, staleAfterMs),
		listRuns: (filter) => memory.listRuns(filter),
		acquire: (runId, holderId) => memory.acquire(runId, holderId),
		takeover: (runId, holderId, expectedHolder) => memory.takeover(runId, holderId, expectedHolder),
		renew: (lease) => memory.renew(lease),
		release: (lease) => memory.release(lease),
		async append(lease, event, options) {
			if (!gated && event.type === "CheckpointRecorded") {
				gated = true;
				reached.resolve();
				await release.promise;
			}
			return memory.append(lease, event, options);
		},
		read: (runId, fromSeq) => memory.read(runId, fromSeq),
		readKey: (runId, key) => memory.readKey(runId, key),
		deleteOwnedRun: (lease) => memory.deleteOwnedRun(lease),
		deleteRun: (runId) => memory.deleteRun(runId),
		close: () => memory.close(),
	};
	let completed = false;
	const running = run(
		definition(() => {}),
		{},
		{
			journal,
			runId: "async-only",
			store: createStore(),
			adapters: { prompt: { prompt: async () => "finished" } },
		},
	).then((result) => {
		completed = true;
		return result;
	});
	await reached.promise;
	assert.equal(completed, false);
	assert.equal((await memory.listRuns())[0]?.runId, "async-only");
	release.resolve();
	assert.equal((await running).status, "completed");
	const backend = await JournalDurableBackend.open(journal);
	try {
		assert.equal(backend.journal, journal);
		assert.equal(backend.getWorkflow("async-only")?.status, "completed");
	} finally {
		await backend.close();
	}
});

test("explicit journal selection reuses each identity without replacing other journals", async () => {
	const firstChoice = { memory: true } as const;
	const secondChoice = { memory: true } as const;
	const first = await initializeDurableBackend({ journal: firstChoice });
	const second = await initializeDurableBackend({ journal: secondChoice });
	assert.equal(await initializeDurableBackend({ journal: firstChoice }), first);
	assert.notEqual(second, first);
	await first.commitWorkflowRegistration({
		workflowId: "same",
		name: "first",
		inputs: {},
		createdAt: 1,
		status: "paused",
	});
	await second.commitWorkflowRegistration({
		workflowId: "same",
		name: "second",
		inputs: {},
		createdAt: 1,
		status: "paused",
	});
	assert.equal(first.getWorkflow("same")?.name, "first");
	assert.equal(second.getWorkflow("same")?.name, "second");
	assert.ok(first instanceof JournalDurableBackend);
	assert.deepEqual((await first.journal.getRun("same"))?.storage, { adapter: "memory", location: ":memory:" });
	const path = journalPath();
	const file = await initializeDurableBackend({ journal: { path } });
	assert.equal(await initializeDurableBackend({ journal: { path } }), file);
	const supplied = await openSqlRunJournal(path);
	try {
		const explicit = await initializeDurableBackend({ journal: supplied });
		assert.notEqual(explicit, file);
		assert.ok(explicit instanceof JournalDurableBackend);
		assert.equal(explicit.journal, supplied);
		assert.equal(await initializeDurableBackend({ journal: supplied }), explicit);
	} finally {
		await supplied.close();
	}
});

test("SDK uses a configured path and leaves a caller-owned connection open after reset", async () => {
	const path = journalPath();
	const database = await openNodeSqliteDatabase(path);
	try {
		const def = definition(() => {});
		const adapters = { prompt: { prompt: async () => "finished" } };
		assert.equal(
			(await run(def, {}, { journal: { database }, runId: "connection", store: createStore(), adapters })).status,
			"completed",
		);
		const backend = await initializeDurableBackend({ journal: { database } });
		assert.equal(backend.getWorkflow("connection")?.status, "completed");
		await resetBackends();
		await database.exec("CREATE TABLE caller_still_open (value TEXT)");
		assert.equal(
			(await run(def, {}, { journal: { path }, runId: "path", store: createStore(), adapters })).status,
			"completed",
		);
		assert.equal((await initializeDurableBackend({ journal: { path } })).getWorkflow("path")?.status, "completed");
	} finally {
		await resetBackends();
		await database.close();
	}
});

test("failed custom-journal initialization stops its timer without closing the supplied journal", async () => {
	class UnreadableJournal extends MemoryRunJournal {
		override async listRuns(): Promise<never> {
			throw new JournalBackendClosedError();
		}
	}
	const journal = new UnreadableJournal();
	vi.useFakeTimers();
	const timers = vi.getTimerCount();
	await assert.rejects(initializeDurableBackend({ journal }), JournalBackendClosedError);
	assert.equal(vi.getTimerCount(), timers);
	assert.equal(await journal.getRun("missing"), undefined);
	await journal.close();
});

test("custom journal open failures retain the adapter error as a typed storage cause", async () => {
	const cause = new Error("adapter unavailable");
	class UnavailableJournal extends MemoryRunJournal {
		override async listRuns(): Promise<never> {
			throw cause;
		}
	}
	const journal = new UnavailableJournal();
	await assert.rejects(initializeDurableBackend({ journal }), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.location, "custom journal");
		assert.equal(error.cause, cause);
		return true;
	});
	await journal.close();
});

test("custom journal catalog and close failures retain typed storage causes", async () => {
	const cause = new Error("adapter unavailable");
	class UnavailableJournal extends MemoryRunJournal {
		fail = false;
		override async listRuns() {
			if (this.fail) throw cause;
			return await super.listRuns();
		}
		override async close(): Promise<void> {
			await super.close();
			throw cause;
		}
	}
	const journal = new UnavailableJournal();
	const backend = await JournalDurableBackend.open(journal);
	journal.fail = true;
	const isStorageError = (error: Error): boolean => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.location, "custom journal");
		assert.equal(error.cause, cause);
		return true;
	};
	await assert.rejects(backend.prepareWorkflowCatalog(), isStorageError);
	await assert.rejects(backend.close(), isStorageError);
});

test("default journal selection follows each context's settings and environment", async () => {
	setDurableBackend(undefined);
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", "");
	const firstPath = journalPath();
	const secondPath = journalPath();
	const firstSettings = { workflows: { journal: { path: firstPath } } };
	const secondSettings = { workflows: { journal: { path: secondPath } } };
	const first = await initializeDurableBackend({ settings: firstSettings });
	const second = await initializeDurableBackend({ settings: secondSettings });
	assert.notEqual(second, first);
	assert.equal(await initializeDurableBackend({ settings: firstSettings }), first);
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", secondPath);
	assert.equal(await initializeDurableBackend({ settings: firstSettings }), second);
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", "");
	const memorySettings = { workflows: { journal: { memory: true } } };
	const memory = await initializeDurableBackend({ settings: memorySettings });
	assert.equal(memory.persistent, false);
	assert.equal(await initializeDurableBackend({ settings: memorySettings }), memory);
});

test("background entry point records the run in its explicit journal", async () => {
	const journal = new MemoryRunJournal();
	const store = createStore();
	const settled = Promise.withResolvers<{ ok: boolean; result: RunResult | undefined }>();
	const accepted = runDetached(
		definition(() => {}),
		{},
		{
			journal,
			store,
			jobs: createJobTracker(),
			adapters: { prompt: { prompt: async () => "finished" } },
			onRawSettled: (ok, result) => {
				settled.resolve({ ok, result });
			},
		},
	);
	const outcome = await settled.promise;
	assert.equal(outcome.ok, true);
	assert.equal(outcome.result?.status, "completed");
	assert.equal((await journal.listRuns())[0]?.runId, accepted.runId);
	await journal.close();
});

test("extension entry point resolves the invocation project's journal settings", async () => {
	setDurableBackend(undefined);
	const previousPath = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	delete process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	const path = journalPath();
	const cwd = makeTempDirectory("journal-project-");
	directories.push(cwd);
	try {
		await writeFileEnsuringDir(
			join(cwd, ".atomic", "settings.json"),
			JSON.stringify({ workflows: { journal: { path } } }),
		);
		const jobs = createJobTracker();
		const store = createStore();
		const runtime = createExtensionRuntime({
			definitions: [definition(() => {})],
			cwd,
			jobs,
			store,
			adapters: { prompt: { prompt: async () => "finished" } },
		});
		const accepted = await runtime.dispatch({ action: "run", workflow: "configured-journal" });
		assert.equal(accepted.action, "run");
		assert.ok("runId" in accepted && accepted.runId);
		await jobs.get(accepted.runId)?.promise;
		const reader = await openSqlRunJournal(path);
		try {
			assert.equal((await reader.listRuns())[0]?.runId, accepted.runId);
			assert.equal(store.runs().find((entry) => entry.id === accepted.runId)?.status, "completed");
		} finally {
			await reader.close();
		}
	} finally {
		if (previousPath === undefined) delete process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
		else process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = previousPath;
	}
});

test("runtime resumes its own SQLite checkpoint after another runtime initializes and lists (#3674)", async () => {
	setDurableBackend(undefined);
	const firstPath = journalPath();
	const secondPath = journalPath();
	let tools = 0;
	let attempts = 0;
	const def = definition(() => {
		tools++;
	});
	const jobs = createJobTracker();
	const firstStore = createStore();
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", firstPath);
	const first = createExtensionRuntime({
		definitions: [def],
		store: firstStore,
		jobs,
		adapters: {
			prompt: {
				prompt: async () => {
					if (++attempts === 1) throw new Error("retry stage");
					return "finished";
				},
			},
		},
	});
	const launched = await first.dispatch({ action: "run", workflow: def.name });
	assert.ok("runId" in launched && launched.runId);
	await jobs.get(launched.runId)?.promise;
	assert.equal(firstStore.runs().find((run) => run.id === launched.runId)?.status, "failed");
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", secondPath);
	const second = createExtensionRuntime({ store: createStore() });
	assert.deepEqual(await second.prepareDurableResumable(), []);
	assert.deepEqual(
		first.listDurableResumable().map((entry) => entry.workflowId),
		[launched.runId],
	);
	assert.equal((await first.inspectDurableWorkflow(launched.runId)).kind, "found");
	const resumed = await first.resumeFailedRun(launched.runId);
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	await jobs.get(launched.runId)?.promise;
	assert.equal(firstStore.runs().find((run) => run.id === launched.runId)?.status, "completed");
	assert.equal(tools, 1, "the first journal's saved tool is replayed");
	assert.equal(attempts, 2);
	assert.deepEqual(second.listDurableResumable(), []);
});

test("stores retain their construction-time test backend after a later injection (#3674)", async () => {
	const firstBackend = await JournalDurableBackend.open(new MemoryRunJournal());
	const secondBackend = await JournalDurableBackend.open(new MemoryRunJournal());
	try {
		setDurableBackend(firstBackend);
		const firstStore = createStore();
		setDurableBackend(secondBackend);
		const secondStore = createStore();
		const first = createExtensionRuntime({ store: firstStore });
		const second = createExtensionRuntime({ store: secondStore });
		await first.dispatch({ action: "list" });
		await second.dispatch({ action: "list" });
		assert.equal(first.durableBackend(), firstBackend);
		assert.equal(second.durableBackend(), secondBackend);
		assert.deepEqual(first.listDurableResumable(), []);
		assert.deepEqual(second.listDurableResumable(), []);
	} finally {
		await firstBackend.close();
		await secondBackend.close();
	}
});

test("SDK adapter journals persist checkpoints across reopen and cache the full resolved selection", async () => {
	const path = journalPath();
	const adapter = join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts");
	const journal = { adapter, options: { path }, prefix: "first_" };
	let tools = 0;
	let stages = 0;
	const def = definition(() => {
		tools++;
	});
	const options = {
		journal,
		runId: "adapter-replay",
		store: createStore(),
		adapters: {
			prompt: {
				prompt: async () => {
					stages++;
					return "finished";
				},
			},
		},
	};
	assert.equal((await run(def, {}, options)).status, "completed");
	const first = await initializeDurableBackend({ journal });
	assert.equal(await initializeDurableBackend({ journal: { ...journal, options: { path } } }), first);
	const second = await initializeDurableBackend({ journal: { ...journal, prefix: "second_" } });
	assert.notEqual(first, second);
	assert.equal(second.getWorkflow(options.runId), undefined);
	await resetBackends();
	assert.equal((await run(def, {}, { ...options, store: createStore() })).status, "completed");
	assert.equal(tools, 1);
	assert.equal(stages, 1);
	const database = await openNodeSqliteDatabase(path);
	try {
		assert.ok((await database.all("SELECT seq FROM first_wf_events")).length > 0);
		assert.deepEqual(await database.all("SELECT run_id FROM second_wf_runs"), []);
	} finally {
		await database.close();
	}
});

test("untrusted project adapters are not loaded through extension contexts and trusted contexts can select them", async () => {
	setDurableBackend(undefined);
	const root = makeTempDirectory("journal-trust-");
	directories.push(root);
	const cwd = join(root, "project");
	const path = join(root, "runs.sqlite");
	const lifecycle = join(root, "adapter-lifecycle.txt");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", "");
	await writeFileEnsuringDir(
		join(cwd, ".atomic", "settings.json"),
		JSON.stringify({
			workflows: {
				journal: {
					adapter: join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
					options: { path, lifecycle },
				},
			},
		}),
	);
	const state = createWorkflowExtensionRuntimeState(
		{},
		{},
		{
			resolveHostCwd: () => cwd,
			runState: { ...currentWorkflowSessionRunState(), store: createStore() },
		},
	);
	try {
		const untrustedRuntime = state.runtimeForContext({ isProjectTrusted: () => false });
		await untrustedRuntime.dispatch({ action: "list" });
		const untrusted = untrustedRuntime.durableBackend();
		assert.ok(untrusted instanceof JournalDurableBackend);
		assert.equal(await fileExists(lifecycle), false);
		const trustedRuntime = state.runtimeForContext({ isProjectTrusted: () => true });
		await trustedRuntime.dispatch({ action: "list" });
		const trusted = trustedRuntime.durableBackend();
		assert.notEqual(trusted, untrusted);
		assert.equal(await fileExists(lifecycle), true);
		assert.ok(trusted instanceof JournalDurableBackend);
		assert.ok(trusted.journal instanceof SqlRunJournal);
		assert.equal(trusted.journal.path, path);
	} finally {
		state.setNotificationsActive(false);
	}
});

test("temporary SQLite paths do not alias filesystem paths in the resolved-selection cache", async () => {
	const backend = await initializeDurableBackend({ journal: { path: "" } });
	assert.ok(backend instanceof JournalDurableBackend);
	assert.ok(backend.journal instanceof SqlRunJournal);
	assert.equal(backend.journal.path, "");
	await assert.rejects(
		() => initializeDurableBackend({ journal: { path: process.cwd() } }),
		(error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.location, process.cwd());
			return true;
		},
	);
});

test("factory adapter selections isolate typed options and reuse equal values", async () => {
	const root = makeTempDirectory("journal-option-values-");
	directories.push(root);
	const adapter = join(moduleDir(import.meta.url), "../fixtures/storage-value-adapter.ts");
	const backends: JournalDurableBackend[] = [];
	for (const [name, value] of optionCases) {
		const backend = await initializeDurableBackend({ journal: { adapter, options: { root, value } } });
		assert.ok(backend instanceof JournalDurableBackend);
		assert.ok(backend.journal instanceof SqlRunJournal);
		assert.equal(backend.journal.path, join(root, `${name}.sqlite`));
		assert.deepEqual(await backend.journal.listRuns(), []);
		for (const previous of backends) {
			assert.notEqual(backend, previous);
			assert.equal(previous.getWorkflow(name), undefined);
		}
		await backend.registerWorkflow({ workflowId: name, name, inputs: {}, createdAt: 1, status: "paused" });
		backends.push(backend);
		const repeatedValue = value instanceof Uint8Array ? value.slice() : value;
		assert.equal(
			await initializeDurableBackend({ journal: { adapter, options: { value: repeatedValue, root } } }),
			backend,
		);
	}
});

for (const source of ["sdk", "workflows.journal", "storage"] as const) {
	for (const failure of ["missing-secret", "unsupported-domain"] as const) {
		test(`factory ${source} adapter ${failure} retains configuration provenance`, async () => {
			vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", "");
			vi.stubEnv("ATOMIC_TEST_STORAGE_ABSENT_TOKEN", undefined);
			const selection =
				failure === "missing-secret"
					? {
							adapter: join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
							secrets: { token: { env: "ATOMIC_TEST_STORAGE_ABSENT_TOKEN" } },
						}
					: { adapter: join(moduleDir(import.meta.url), "../fixtures/storage-unsupported-adapter.ts") };
			await assert.rejects(
				() =>
					initializeDurableBackend(
						source === "sdk"
							? { journal: selection }
							: {
									settings:
										source === "storage" ? { storage: selection } : { workflows: { journal: selection } },
								},
					),
				(error: Error) => {
					assert.ok(error instanceof StorageConfigError);
					assert.equal(error.source, source === "sdk" ? "sdk" : "settings");
					assert.equal(error.field, failure === "missing-secret" ? "secrets.token" : "adapter");
					assert.equal(
						error.reason,
						failure === "missing-secret" ? "secret-env-missing" : "adapter-domain-unsupported",
					);
					return true;
				},
			);
		});
	}
}

test("concurrent factory callers retain their own configuration error source", async () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", "");
	const selection = { adapter: join(moduleDir(import.meta.url), "../fixtures/storage-unsupported-adapter.ts") };
	for (const sources of [
		["sdk", "settings"],
		["settings", "sdk"],
	] as const) {
		await Promise.all(
			sources.map(async (source) => {
				await assert.rejects(
					() =>
						initializeDurableBackend(
							source === "sdk" ? { journal: selection } : { settings: { storage: selection } },
						),
					(error: Error) => {
						assert.ok(error instanceof StorageConfigError);
						assert.equal(error.source, source);
						assert.equal(error.field, "adapter");
						assert.equal(error.reason, "adapter-domain-unsupported");
						return true;
					},
				);
			}),
		);
	}
});
