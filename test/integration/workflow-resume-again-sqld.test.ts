import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, vi } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { resumeAgain } from "../fixtures/resume-again.js";
import { makeTempDirectory, removeTempDirectory, spawnProcess } from "../helpers/runtime.js";
import { storageBackends } from "../helpers/storage-backends.js";

const fixture = fileURLToPath(new URL("../fixtures/resume-again-process.mjs", import.meta.url));

describe.each(storageBackends)("$name resume claims", (storage) => {
	for (const outcome of ["blocked", "failed"] as const)
		test.skipIf(storage.skipReason !== undefined)(
			`a replacement that ${outcome} again is not resumed by a delayed request in another process (#5661)`,
			async () => {
				const scope = await storage.openScope();
				const directory = makeTempDirectory("workflow-resume-again-");
				try {
					const backend = await JournalDurableBackend.open(
						await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix }),
					);
					try {
						const log = join(directory, "attempts");
						const definition = resumeAgain(log, outcome);
						const store = createStore();
						const jobs = createJobTracker();
						const runtime = createExtensionRuntime({ store, jobs, definitions: [definition] });
						const { runId } = await run(definition, {}, { store, durableBackend: backend });
						assert.equal(backend.getWorkflow(runId)?.status, outcome);
						const reading = Promise.withResolvers<void>();
						const release = Promise.withResolvers<void>();
						const hydrate = backend.hydrateWorkflow.bind(backend);
						vi.spyOn(backend, "hydrateWorkflow").mockImplementationOnce(async (...args) => {
							reading.resolve();
							await release.promise;
							return hydrate(...args);
						});
						const late = runtime.resumeDurableWorkflow(runId, { definition, durableBackend: backend });
						try {
							await reading.promise;
							const child = spawnProcess([process.execPath, fixture, runId, log, outcome, scope.prefix], {
								env: {
									...process.env,
									TEST_RESUME_JOURNAL: JSON.stringify(scope.location),
									ATOMIC_CODING_AGENT_DIR: join(directory, "agent"),
								},
								timeout: 90_000,
							});
							assert.equal(await child.exited, 0);
							assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
								String(process.pid),
								String(child.pid),
							]);
						} finally {
							release.resolve();
							await late;
							await jobs.get(runId)?.promise;
						}
						const result = await late;
						assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2, result.message);
						assert.equal(result.ok, false);
						assert.match(result.message, /already resumed/);
					} finally {
						await backend.close();
					}
				} finally {
					await scope.close();
					removeTempDirectory(directory);
				}
			},
			120_000,
		);
});
