/**
 * Child process for the subscription chaos tests: one workflow whose run body subscribes to a finite event stream on
 * a shared run journal. Each handled event appends `<label> <event id>` to `handled.txt` with an fsync, so the parent
 * can kill or stop this process at any point and compare side effects with the journal's processed records.
 *
 * The journal is the SQLite file `<directory>/journal.sqlite`, unless `ATOMIC_CHAOS_SHARED_JOURNAL=1` asks for the
 * journal that the settings in `ATOMIC_CODING_AGENT_DIR` select (for example a shared libSQL server in a distributed
 * run). Shared mode refuses to start without an explicit agent directory, so it can never fall back to a default journal. `resume` expires
 * the crashed owner's SQLite lease; `takeover` instead waits, with no manual step, until the journal's own clock
 * reports the owner's lease stale. `steal` makes one resume attempt against a live owner and exits 0 when it is refused.
 */
import assert from "node:assert/strict";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findSubscriptionError } from "../../packages/coding-agent/src/core/event-subscriptions/errors.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { initializeDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { subscriptionEventProcessed } from "../../packages/workflows/src/durable/subscription-records.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";

const [mode, directory, runId, label, countText, delayText, concurrencyText] = process.argv.slice(2);
assert.ok(mode && directory && runId && label);
const eventCount = Number(countText ?? "60");
const handlerDelayMs = Number(delayText ?? "20");
const maxConcurrent = Number(concurrencyText ?? "4");
const SUBSCRIPTION_KEY = "chaos#1";
const sharedJournal = process.env.ATOMIC_CHAOS_SHARED_JOURNAL === "1";
assert.ok(!sharedJournal || process.env.ATOMIC_CODING_AGENT_DIR, "shared mode needs ATOMIC_CODING_AGENT_DIR");
if (!sharedJournal) process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = join(directory, "journal.sqlite");
if (mode === "resume") expireWorkflowLease(join(directory, "journal.sqlite"), runId);
const backend = await initializeDurableBackend();
assert.ok(backend instanceof JournalDurableBackend);
const ids = Array.from({ length: eventCount }, (_, index) => `e${index}`);

function appendDurably(path: string, line: string): void {
	const fd = openSync(path, "a");
	try {
		writeSync(fd, `${line}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

const definition = workflow({
	name: "subscription-chaos",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.stage("anchor").complete("anchored");
		try {
			await ctx.subscribe(
				{
					id: "chaos-source",
					start: async (_signal, emit) => {
						for (const id of ids) emit({ id, payload: { id } });
					},
				},
				async (event) => {
					appendDurably(join(directory, "handled.txt"), `${label} ${event.id}`);
					await sleep(handlerDelayMs);
				},
				{ name: "chaos", maxConcurrent },
			).done;
		} catch (error) {
			const typed = findSubscriptionError(error);
			let cause: unknown = error;
			const chain: string[] = [];
			for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
				chain.push(cause.name);
				cause = cause.cause;
			}
			await writeFile(
				join(directory, `failure-${label}.json`),
				JSON.stringify({ code: typed?.code ?? null, chain }),
			);
			throw error;
		}
		return {};
	},
}) as WorkflowDefinition;

const adapters = {
	complete: {
		complete: async (text: string) => {
			appendDurably(join(directory, "anchor.txt"), `${label} ${runId}`);
			return text;
		},
	},
};
const store = createStore();
if (mode === "records") {
	await backend.hydrateWorkflow(runId);
	const processed = ids.filter((id) => subscriptionEventProcessed(backend, runId, SUBSCRIPTION_KEY, id));
	const eventRecords = backend
		.listCheckpoints(runId)
		.filter((checkpoint) => checkpoint.checkpointId.startsWith("workflow-subscription-event:")).length;
	console.log(JSON.stringify({ processed, eventRecords }));
	await backend.close();
} else if (mode === "steal") {
	const runtime = createExtensionRuntime({ definitions: [definition], cwd: directory, store, adapters });
	const resumed = await runtime.resumeDurableWorkflow(runId);
	console.log(JSON.stringify({ acquired: resumed.ok, ...(resumed.ok ? {} : { reason: resumed.reason }) }));
	process.exit(resumed.ok ? 4 : 0);
} else if (mode === "resume" || mode === "takeover") {
	const runtime = createExtensionRuntime({ definitions: [definition], cwd: directory, store, adapters });
	const takeoverDeadline = Date.now() + 600_000;
	let resumed = await runtime.resumeDurableWorkflow(runId);
	while (mode === "takeover" && !resumed.ok && Date.now() < takeoverDeadline) {
		await sleep(5_000);
		await backend.hydrateWorkflow(runId);
		resumed = await runtime.resumeDurableWorkflow(runId);
	}
	assert.ok(resumed.ok, JSON.stringify(resumed));
	const deadline = Date.now() + 120_000;
	while (store.runs().find((entry) => entry.id === runId)?.endedAt === undefined) {
		assert.ok(Date.now() < deadline, "resumed workflow did not settle");
		await sleep(20);
	}
	console.log(JSON.stringify({ status: store.runs().find((entry) => entry.id === runId)?.status }));
	await backend.close();
} else {
	const result = await run(definition, {}, { runId, cwd: directory, store, adapters, modelOwner: "subscription-chaos" });
	console.log(JSON.stringify({ status: result.status }));
	await backend.close().catch((error: Error) => console.error(`close failed: ${error.name}`));
	process.exitCode = result.status === "completed" ? 0 : 3;
}
