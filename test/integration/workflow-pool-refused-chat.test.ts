import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlSessionStore } from "@bastani/atomic";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	durableWorkflowRunSnapshots,
	listOpenableCompletedWorkflows,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createPostMortemHandleResolver } from "../../packages/workflows/src/extension/postmortem-deps.js";
import { resolveStageTarget } from "../../packages/workflows/src/extension/workflow-targets.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { NormalizedSessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { restoreTerminalRuns } from "../../packages/workflows/src/shared/persistence-restore-helpers.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { hostWorkerBindings } from "../../packages/workflows/src/workers/host-options.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const scenarios = [
	{
		title: "a refused retry does not offer a previous pooled stage's chat",
		registrations: [true, false],
		end: "return",
	},
	{
		title: "a call refused before the pool is invoked does not offer a stale chat",
		registrations: [true, true],
		end: "before pool",
	},
	{
		title: "a queue refusal does not expose the old worker's chat",
		registrations: [true, true],
		end: "queue refusal",
	},
	{ title: "an earlier refusal does not hide a stage that ran on retry", registrations: [false, true], end: "return" },
	{
		title: "a cached failed child after a refusal keeps its original chat",
		registrations: [true, false, true],
		end: "exit",
	},
	{
		title: "a failed parent records its refused retry without losing the child's own transcript",
		registrations: [true, false],
		end: "failed exit",
	},
];

test.each(scenarios)(
	"$title",
	async ({ registrations, end }) => {
		const directory = makeTempDirectory("pool-refused-chat-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const runId = testRunId(`refused-chat-${registrations.join("-")}-${end}`);
		const store = createStore();
		bindStoreDurableBackend(store, backend);
		const sessions = await JsonlSessionStore.open(join(directory, "sessions"), { exactDirectory: true });
		const source = fileURLToPath(new URL("../fixtures/pool-failed-chat-child.ts", import.meta.url));
		const digest = await definitionDigest(source);
		let exportName = "child";
		let child = await loadWorkerDefinition({ path: source, exportName, digest });
		let last = false;
		const parent = workflow({
			name: "retry-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				try {
					await ctx.workflow(child);
				} catch (error) {
					if (!last) throw error;
				}
				if (end.endsWith("exit")) ctx.exit({ status: end === "failed exit" ? "failed" : "completed" });
				return {};
			},
		});
		const entries: NormalizedSessionEntry[] = [];
		const cancellation = createCancellationRegistry();
		const register = cancellation.register.bind(cancellation);
		cancellation.register = (id, controller) => {
			if (last && end === "before pool" && id !== runId) throw new Error("host refused registration");
			register(id, controller);
		};
		const baseRunOpts = {
			[hostWorkerBindings]: true as const,
			cancellation,
			runId,
			cwd: directory,
			durableBackend: backend,
			store,
			persistence: {
				appendEntry(type: string, value: Record<string, unknown>) {
					const id = String(entries.length);
					entries.push({ type, id, payload: JSON.parse(JSON.stringify(value)) });
					return id;
				},
			},
		};
		const startPool = (registered: boolean) =>
			new LocalWorkerPool(backend, {
				journalPath: path,
				workers: 1,
				coordinator: "in-process",
				definitions: registered ? [{ definition: child, path: source, exportName }] : [],
			});
		const lookup = async (owner: Store, boundary: string) => {
			const stage = resolveStageTarget(runId, "agent", owner);
			const pane = await createPostMortemHandleResolver({
				store: owner,
				adapters: {
					sessionStore: sessions,
					agentSession: {
						async create() {
							throw new Error("must not start an agent");
						},
					},
				},
				resolveDefaultStageSessionDir: () => undefined,
				stageControlRegistry: createStageControlRegistry(),
			})(runId, boundary);
			return [stage.ok ? stage.stageId : stage.code, pane?.ok ? pane.handle.sessionId : undefined];
		};
		let pool = startPool(registrations[0]!);
		try {
			const first = await run(parent, {}, baseRunOpts);
			assert.match(first.error ?? "", registrations[0] ? /failed after the agent stage/ : /not importable/);
			const boundary = first.stages[0]!.id;
			let originalSession = store.runs().find((r) => r.parentRunId === runId)?.stages[0]?.sessionId;
			for (let index = 1; index < registrations.length; index++) {
				await pool.close();
				if (end === "queue refusal") {
					exportName = "alternateChild";
					child = await loadWorkerDefinition({ path: source, exportName, digest });
				}
				pool = startPool(registrations[index]!);
				last = index === registrations.length - 1;
				const jobs = createJobTracker();
				let settled: Promise<unknown> | undefined;
				const resumed = await resumeDurableWorkflow(runId, {
					registry: createRegistry().register(parent),
					baseRunOpts,
					durableBackend: backend,
					jobs,
					onRunAccepted(id) {
						settled = jobs.get(id)?.promise;
					},
				});
				assert.ok(resumed.ok, resumed.message);
				assert.ok(settled);
				await settled;
				const current = store.run(runId)!;
				assert.equal(current.stages[0]!.id, boundary);
				assert.match(
					current.stages[0]!.error ?? "",
					end === "before pool"
						? /host refused registration/
						: end === "queue refusal"
							? /Pool boundary identity conflict/
							: registrations[index]
								? /failed after the agent stage/
								: /not importable/,
				);
				originalSession ??= store.runs().find((r) => r.parentRunId === runId)?.stages[0]?.sessionId;
			}
			const worker = store.runs().find((r) => r.parentRunId === runId)!;
			const agent = worker.stages[0]!;
			assert.ok(agent.workerExecution && originalSession);
			assert.equal(agent.sessionId, originalSession);
			const visible = end !== "queue refusal" && end !== "before pool" && registrations.at(-1);
			const expected = visible ? [agent.id, originalSession] : ["stage_not_found", undefined];
			const live = await lookup(store, boundary);
			await pool.close();
			if (!registrations[0]) {
				// The retained-store opener replaces the parent but must still reach the child that actually ran.
				const opened = await openCompletedDurableWorkflow(runId, {
					store,
					durableBackend: backend,
					sessionStore: sessions,
					cwd: directory,
				});
				assert.ok(opened.ok, opened.message);
				assert.deepEqual(await lookup(store, boundary), expected);
			}
			if (end.endsWith("exit")) {
				const restored = createStore();
				bindStoreDurableBackend(restored, backend);
				restored.recordRunStart(worker);
				restoreTerminalRuns(entries, restored);
				assert.ok(restored.run(runId));
				assert.deepEqual(await lookup(restored, boundary), expected);
			}
			const cold = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
			try {
				const [entry] = (await listOpenableCompletedWorkflows(cold, sessions)).filter(
					(r) => r.workflowId === runId,
				);
				assert.ok(entry);
				const root = (await completedWorkflowRunSnapshots(cold, entry, sessions)).find((r) => r.id === runId);
				assert.ok(root);
				// Reload the saved parent beside the real retained worker, not a synthetic "old chat".
				store.recordRunStart(root);
				assert.deepEqual({ live, reopened: await lookup(store, boundary) }, { live: expected, reopened: expected });
				const retainedRoot = durableWorkflowRunSnapshots(cold, cold.getWorkflow(runId)!)[0];
				assert.ok(retainedRoot);
				store.recordRunStart(retainedRoot);
				assert.deepEqual(await lookup(store, boundary), expected, "the retained journal inspection");
				assert.deepEqual(resolveStageTarget(worker.id, "agent", store), {
					ok: true,
					runId: worker.id,
					stageId: agent.id,
				});
			} finally {
				await cold.close();
			}
		} finally {
			await pool.close();
			await sessions.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	120_000,
);
