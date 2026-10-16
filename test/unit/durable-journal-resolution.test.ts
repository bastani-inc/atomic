import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, openNodeSqliteDatabase, StorageConfigError } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { RunOpts } from "../../packages/workflows/src/authoring.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	type RunJournalSettings,
	resolveRunJournal,
	selectRunJournal,
} from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlRunJournal, SqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { optionCases } from "../fixtures/storage-value-adapter.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
const opened: RunJournal[] = [];
const conflicting: RunJournalSettings = { workflows: { journal: { path: "settings.sqlite", memory: true } } };

beforeEach(() => {
	root = makeTempDirectory("journal-resolution-");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", "");
});
afterEach(async () => {
	for (const journal of opened.splice(0)) await journal.close();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

async function resolve(
	options: { journal?: RunOpts["journal"]; settings?: RunJournalSettings } = {},
): Promise<RunJournal> {
	const journal = await resolveRunJournal(options);
	opened.push(journal);
	return journal;
}

test("explicit journal path wins over environment and conflicting settings without normalization", async () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "environment.sqlite"));
	const path = `${root}/nested/../ explicit.sqlite `;
	const journal = await resolve({ journal: { path }, settings: conflicting });
	assert.ok(journal instanceof SqlRunJournal);
	assert.equal(journal.path, path);
});

test("explicit memory and journal instances are used instead of environment and settings", async () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "environment.sqlite"));
	assert.ok((await resolve({ journal: { memory: true }, settings: conflicting })) instanceof MemoryRunJournal);
	const instance = new MemoryRunJournal();
	assert.equal(await resolve({ journal: instance, settings: conflicting }), instance);
	const sqlite = await openSqlRunJournal(join(root, "instance.sqlite"));
	assert.equal(await resolve({ journal: sqlite, settings: conflicting }), sqlite);
});

test("explicit caller-owned connection wins and stays open", async () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "environment.sqlite"));
	const database = await openNodeSqliteDatabase(join(root, "caller.sqlite"));
	try {
		const journal = await resolve({ journal: { database }, settings: conflicting });
		assert.ok(journal instanceof SqlRunJournal);
		await journal.close();
		assert.equal((await database.get("SELECT schema_version FROM wf_meta"))?.schema_version, 1);
	} finally {
		await database.close();
	}
});

test("nonempty environment overrides settings including a conflicting block", async () => {
	const path = join(root, " environment.sqlite ");
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", path);
	const journal = await resolve({ settings: conflicting });
	assert.ok(journal instanceof SqlRunJournal);
	assert.equal(journal.path, path);
});

test("settings path resolves relative to Atomic home and overrides the default", async () => {
	const journal = await resolve({
		settings: { workflows: { journal: { path: "nested/settings.sqlite", memory: false } } },
	});
	assert.ok(journal instanceof SqlRunJournal);
	assert.equal(journal.path, join(dirname(getAgentDir()), "nested/settings.sqlite"));
});

test("absolute settings paths are preserved", async () => {
	const path = join(root, "absolute.sqlite");
	const journal = await resolve({ settings: { workflows: { journal: { path } } } });
	assert.ok(journal instanceof SqlRunJournal);
	assert.equal(journal.path, path);
});

test("settings memory true selects memory even when path is empty", async () => {
	for (const path of [undefined, ""]) {
		assert.ok(
			(await resolve({ settings: { workflows: { journal: { path, memory: true } } } })) instanceof MemoryRunJournal,
		);
	}
});

test("absent and empty settings and memory false use the persistent default", async () => {
	for (const settings of [
		undefined,
		{},
		{ workflows: [] },
		{ workflows: { journal: {} } },
		{ workflows: { journal: { path: "", memory: false } } },
	]) {
		const journal = await resolve({ settings });
		assert.ok(journal instanceof SqlRunJournal);
		assert.equal(journal.path, join(dirname(getAgentDir()), "workflows", "journal.sqlite"));
	}
});

test("selected settings with nonempty path and memory true fail with exact typed fields", async () => {
	await assert.rejects(
		async () => await resolve({ settings: conflicting }),
		(error: Error) => {
			assert.ok(error instanceof StorageConfigError);
			assert.equal(error.source, "settings");
			assert.equal(error.field, "workflows.journal");
			assert.equal(error.reason, "path-and-memory");
			return true;
		},
	);
});

test("journal settings override shared storage outright and shared storage overrides the default", async () => {
	const shared = await resolve({ settings: { storage: { path: "shared.sqlite" } } });
	assert.ok(shared instanceof SqlRunJournal);
	assert.equal(shared.path, join(dirname(getAgentDir()), "shared.sqlite"));
	const sharedDefault = await resolve({ settings: { storage: {} } });
	assert.ok(sharedDefault instanceof SqlRunJournal);
	assert.equal(sharedDefault.path, join(dirname(getAgentDir()), "storage.sqlite"));
	const explicit = await resolve({ settings: { workflows: { journal: {} }, storage: { memory: true } } });
	assert.ok(explicit instanceof SqlRunJournal);
	assert.equal(explicit.path, join(dirname(getAgentDir()), "workflows", "journal.sqlite"));
	assert.ok(
		(await resolve({
			settings: { workflows: { journal: { memory: true } }, storage: { path: "shared.sqlite" } },
		})) instanceof MemoryRunJournal,
	);
});

test("invalid selected SDK and settings values raise typed fields without falling through", async () => {
	const invalid = [
		["null", "selection-object-required"],
		["[]", "selection-object-required"],
		['{"path":null}', "invalid-path"],
		['{"memory":"true"}', "invalid-memory"],
		['{"adapter":""}', "invalid-adapter"],
		['{"adapter":"x","memory":false}', "multiple-selection-forms"],
		['{"adapter":"x","options":[]}', "invalid-options"],
		['{"adapter":"x","options":{"nested":{}}}', "invalid-options"],
		['{"adapter":"x","secrets":{"token":{}}}', "invalid-secret-ref"],
		['{"adapter":"x","secrets":{"token":{"env":"A","file":"B"}}}', "invalid-secret-ref"],
		['{"dir":"sessions"}', "adapter-domain-unsupported"],
		['{"prefix":false}', "invalid-prefix"],
	] as const;
	for (const [json, reason] of invalid) {
		for (const source of ["sdk", "settings"] as const) {
			await assert.rejects(
				() =>
					source === "sdk"
						? resolve({
								journal: JSON.parse(json) as NonNullable<RunOpts["journal"]>,
								settings: { storage: { memory: true } },
							})
						: resolve({ settings: { workflows: { journal: JSON.parse(json) }, storage: { memory: true } } }),
				(error: Error) => {
					assert.ok(error instanceof StorageConfigError);
					assert.equal(error.source, source);
					assert.equal(error.field, source === "sdk" ? "journal" : "workflows.journal");
					assert.equal(error.reason, reason);
					return true;
				},
			);
		}
	}
});

test("factory-created journals persist safe descriptors without mutating caller headers or direct journals", async () => {
	const header = { runId: "descriptor", name: "test", cwd: root, createdAt: 1, status: "running" };
	const snapshot = { ...header };
	for (const journal of [await resolve(), await resolve({ journal: { memory: true } })]) {
		await journal.createRun(header);
		const stored = await journal.getRun(header.runId);
		assert.deepEqual(header, snapshot);
		assert.deepEqual(
			stored?.storage,
			journal instanceof SqlRunJournal ? journal.descriptor : { adapter: "memory", location: ":memory:" },
		);
		assert.equal("inputs" in stored!, false);
	}
	const direct = new MemoryRunJournal();
	const createRun = direct.createRun;
	assert.equal(await resolve({ journal: direct }), direct);
	assert.equal(direct.createRun, createRun);
	await direct.createRun(header);
	assert.deepEqual(await direct.getRun(header.runId), header);
});

test("SDK selections require a concrete form and preserve an explicitly empty path", async () => {
	assert.deepEqual(selectRunJournal({ journal: { path: "" } }), { kind: "sqlite", path: "" });
	const emptyPath = await resolve({ journal: { path: "" } });
	assert.ok(emptyPath instanceof SqlRunJournal);
	assert.equal(emptyPath.path, "");
	for (const [journal, reason] of [
		[{} as never, "selection-required"],
		[{ memory: false } as never, "invalid-memory"],
		[{ path: undefined } as never, "invalid-path"],
		[{ adapter: undefined } as never, "invalid-adapter"],
		[{ memory: true, path: "" } as never, "multiple-selection-forms"],
	] as const) {
		await assert.rejects(
			() => resolve({ journal }),
			(error: Error) => {
				assert.ok(error instanceof StorageConfigError);
				assert.equal(error.source, "sdk");
				assert.equal(error.field, "journal");
				assert.equal(error.reason, reason);
				return true;
			},
		);
	}
});

test("resolved adapter options preserve typed values and isolate each journal history", async () => {
	const adapter = join(moduleDir(import.meta.url), "../fixtures/storage-value-adapter.ts");
	const journals: RunJournal[] = [];
	for (const [name, value] of optionCases) {
		const journal = await resolve({ journal: { adapter, options: { root, value } } });
		assert.ok(journal instanceof SqlRunJournal);
		assert.equal(journal.path, join(root, `${name}.sqlite`));
		assert.deepEqual(await journal.listRuns(), []);
		for (const previous of journals) assert.equal(await previous.getRun(name), undefined);
		await journal.createRun({ runId: name, name, cwd: root, createdAt: 1, status: "running" });
		journals.push(journal);
		const repeatedValue = value instanceof Uint8Array ? value.slice() : value;
		const repeated = await resolve({ journal: { adapter, options: { value: repeatedValue, root } } });
		assert.equal((await repeated.getRun(name))?.name, name);
	}
	assert.deepEqual(
		(await readFile(join(root, "opens.txt"), "utf8")).trim().split("\n"),
		optionCases.map(([name]) => name),
	);
});

for (const source of ["sdk", "workflows.journal", "storage"] as const) {
	for (const failure of ["missing-secret", "unsupported-domain"] as const) {
		test(`resolved ${source} adapter ${failure} retains configuration provenance`, async () => {
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
					resolve(
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
