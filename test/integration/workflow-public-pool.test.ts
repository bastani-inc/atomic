import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createStore, loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const PUBLIC_WORKER_PROCESS_TIMEOUT_MS = 120_000;

test.skipIf(process.platform === "win32").each(["sdk", "cli"] as const)(
	"public $0 launch runs two workers under one root and recovers a dead worker (#3869)",
	async (launch) => {
		const directory = makeTempDirectory("public-pool-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));
		const child = await loadWorkerWorkflow(childPath, "child");
		const store = createStore();
		const parent = workflow({
			name: "public-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const children = await Promise.all(
					[true, false].map((crash) =>
						ctx.workflow(child, { inputs: { crash, during: false, journalPath: path } }),
					),
				);
				assert.ok(children.every((result) => result.status === "completed"));
				assert.equal(new Set(children.map((result) => result.outputs.firstPid)).size, 2);
				assert.notEqual(children[0]!.outputs.firstInstance, children[0]!.outputs.finalInstance);
				return {};
			},
		});
		try {
			const resources = {
				localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "child" }] },
				admission: { limits: { session: 2, process: 2 } },
			};
			let result: { runId?: string; status?: string };
			if (launch === "sdk") {
				result = await run(
					parent,
					{},
					{ runId: "public-root", store, cwd: directory, durableBackend: backend, ...resources },
				);
			} else {
				const jobs = createJobTracker();
				const runtime = createExtensionRuntime({
					definitions: [parent],
					journal,
					store,
					jobs,
					cwd: directory,
					adapters: {},
					resolveJournalSettings: () => ({ workflows: resources }),
				});
				const started = await runtime.dispatch({ action: "run", workflow: parent.name });
				assert.equal(started.action, "run");
				if (started.action !== "run" || !started.runId) assert.fail(JSON.stringify(started));
				await jobs.get(started.runId)?.outcome;
				result = { runId: started.runId, status: store.runs().find((entry) => entry.id === started.runId)?.status };
			}
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.equal((await journal.listRuns()).length, 1);
			assert.ok(store.runs().filter((snapshot) => snapshot.parentRunId === result.runId).length === 2);
			assert.ok(result.runId);
			await backend.hydrateWorkflow(result.runId);
			assert.equal(backend.getWorkflow(result.runId)?.resources?.localWorkers?.count, 2);
			assert.equal(backend.getWorkflow(result.runId)?.resources?.admission?.limits?.process, 2);
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_WORKER_PROCESS_TIMEOUT_MS,
);
