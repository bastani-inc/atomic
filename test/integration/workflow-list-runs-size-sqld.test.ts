import { describe, expect, it } from "vitest";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import {
	exportWorkflowRuns,
	planWorkflowRunImport,
	readWorkflowRunExports,
} from "../../packages/coding-agent/src/core/storage/journal-transfer.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`run catalog size: ${backend.name}`, () => {
		it("scopes many matching directory spellings without an oversized parameter list (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const store = await SqlSessionStore.open(database, {
					prefix: scope.prefix,
					cwdMatcher: () => (cwd) => cwd?.startsWith("/project/") ?? false,
				});
				try {
					await store.create(
						{ id: "seed", version: SESSION_FORMAT_VERSION, cwd: "/unrelated", createdAt: "2026-11-18T00:00:00Z" },
						[],
					);
					const table = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions;
					await database.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 33000)
						INSERT INTO ${table}(id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision)
						SELECT 's-' || i, '/project/' || i, created_at,
						'{"id":"s-' || i || '","version":${SESSION_FORMAT_VERSION},"cwd":"/project/' || i || '","createdAt":"2026-11-18T00:00:00Z"}',
						internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision
						FROM n CROSS JOIN ${table} AS seed WHERE seed.id = 'seed'`);
					for (const withoutSearchText of [false, true]) {
						const ids: string[] = [];
						for await (const summary of store.list({ cwd: "/project", withoutSearchText })) ids.push(summary.id);
						expect(ids).toEqual(Array.from({ length: 33_000 }, (_, i) => `s-${i + 1}`));
					}
				} finally {
					await store.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("bounds version-catalog responses by run-id size, not only row count (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					const suffix = "x".repeat(4_000);
					await database.run(
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
						INSERT INTO ${runJournalTables(scope.prefix).runs}(run_id, name, cwd, created_at, status, header_json)
						SELECT 'run-' || i || ?, 'run', '/project', 1, 'running',
						'{"runId":"run-' || i || ? || '","name":"run","cwd":"/project","createdAt":1,"status":"running"}' FROM n`,
						suffix,
						suffix,
					);
					const versions = await journal.runVersions();
					expect([...versions.keys()].sort()).toEqual(
						Array.from({ length: 3_000 }, (_, i) => `run-${i + 1}${suffix}`).sort(),
					);
					expect([...versions.values()].every((version) => version.seq === 0 && version.at === 0)).toBe(true);
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("exports and compares one run whose event history exceeds a response limit (#5537)", async () => {
			const scope = await backend.openScope();
			const directory = makeTempDirectory("atomic-large-run-export-");
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					await journal.createRun({
						runId: "run",
						name: "run",
						cwd: "/project",
						createdAt: 1,
						status: "completed",
					});
					const text = "x".repeat(800_000);
					await database.run(
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 16)
						INSERT INTO ${runJournalTables(scope.prefix).events}(run_id, seq, epoch, key, type, payload, at, chunks)
						SELECT 'run', i, 1, NULL, 'RunStarted', ?, i, 0 FROM n`,
						JSON.stringify({ inputs: { text } }),
					);
					const storage = {
						kind: "database",
						open: scope.connect,
						prefix: scope.prefix,
						location: "run",
					} as const;
					expect(await exportWorkflowRuns(storage, directory)).toEqual({
						written: ["run"],
						unchanged: [],
						skipped: [],
					});
					const exported = await readWorkflowRunExports(directory);
					expect(exported[0]!.events.map((event) => event.seq)).toEqual(
						Array.from({ length: 16 }, (_, i) => i + 1),
					);
					expect(
						exported[0]!.events.every(
							(event) => JSON.stringify(event.payload) === JSON.stringify({ inputs: { text } }),
						),
					).toBe(true);
					expect((await planWorkflowRunImport(storage, exported)).runs.map((run) => run.action)).toEqual([
						"unchanged",
					]);
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
				removeTempDirectory(directory);
			}
		});

		it("scopes session listings without returning all stored cwd text in one response (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				try {
					for (let index = 0; index < 16; index++) {
						await store.create(
							{
								id: `session-${index}`,
								version: SESSION_FORMAT_VERSION,
								cwd: `/${index}/${"x".repeat(800_000)}`,
								createdAt: "2026-11-18T00:00:00Z",
							},
							[],
						);
					}
					for (const withoutSearchText of [false, true]) {
						const listed = [];
						for await (const summary of store.list({ cwd: "/missing", withoutSearchText })) listed.push(summary);
						expect(listed).toEqual([]);
					}
				} finally {
					await store.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("aborts a catalog listing between pages without returning a partial catalog (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const journal = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
				try {
					await journal.createRun({ runId: "run", name: "run", cwd: "/project", createdAt: 1, status: "running" });
					const controller = new AbortController();
					const reason = new Error("catalog cancelled");
					const timer = setImmediate(() => controller.abort(reason));
					try {
						await expect(journal.listRuns(undefined, { signal: controller.signal })).rejects.toBe(reason);
					} finally {
						clearImmediate(timer);
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("lists large escaped inputs in size-bounded pages and preserves the cwd filter (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const journal = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
				try {
					const inputs = { text: '"'.repeat(1_000_000) };
					const headers = Array.from({ length: 6 }, (_, index) => ({
						runId: `large-${index}`,
						name: "large",
						cwd: "/project",
						createdAt: 1,
						status: "running",
						inputs,
					}));
					for (const header of headers) await journal.createRun(header);
					expect(await journal.listRuns({ cwd: "/project" })).toEqual(headers);
					expect(await journal.listRuns({ cwd: "/other" })).toEqual([]);
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("lists 150,000 runs once in run-id order and can export from that catalog (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					await database.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150000)
						INSERT INTO ${runJournalTables(scope.prefix).runs}(run_id, name, cwd, created_at, status, header_json)
						SELECT 'run-' || i, 'run', '/project', 1, 'running',
						'{"runId":"run-' || i || '","name":"run","cwd":"/project","createdAt":1,"status":"running"}' FROM n`);
					const runs = await journal.listRuns();
					expect(runs.map((run) => run.runId)).toEqual(
						Array.from({ length: 150_000 }, (_, i) => `run-${i + 1}`).sort(),
					);
					const directory = makeTempDirectory("atomic-large-catalog-export-");
					try {
						expect(
							await exportWorkflowRuns(
								{
									kind: "database",
									open: scope.connect,
									prefix: scope.prefix,
									location: "catalog",
								},
								directory,
								{ runs: ["run-1"] },
							),
						).toEqual({ written: ["run-1"], unchanged: [], skipped: [] });
					} finally {
						removeTempDirectory(directory);
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});
	});
}
