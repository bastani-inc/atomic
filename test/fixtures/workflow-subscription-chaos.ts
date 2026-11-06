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
 *
 * Every event runs a tracked event child (`child.task`) whose scripted model answers `answer:<subscription>:<event id>`.
 * Beside the main `chaos` subscription, two more subscriptions run at the same time whose children shared names under
 * the old `<name>/<event id>` naming (`chaos2` with ids `x/eN` and `chaos2/x` with ids `eN`). A child that replays
 * another subscription's answer after a resume is appended to `wrong-tree.txt`.
 */
import assert from "node:assert/strict";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { findSubscriptionError } from "../../packages/coding-agent/src/core/event-subscriptions/errors.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { initializeDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { subscriptionEventProcessed } from "../../packages/workflows/src/durable/subscription-records.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";

const [mode, directory, runId, label, countText, delayText, concurrencyText] = process.argv.slice(2);
assert.ok(mode && directory && runId && label);
const eventCount = Number(countText ?? "60");
const handlerDelayMs = Number(delayText ?? "20");
const maxConcurrent = Number(concurrencyText ?? "4");
const SUBSCRIPTION_KEY = "chaos#1";
const SUBSCRIPTIONS = [
	{ name: "chaos", ids: (index: number) => `e${index}` },
	{ name: "chaos2", ids: (index: number) => `x/e${index}` },
	{ name: "chaos2/x", ids: (index: number) => `e${index}` },
] as const;
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
			await Promise.all(
				SUBSCRIPTIONS.map(
					(subscription) =>
						ctx.subscribe(
							{
								id: `${subscription.name}-source`,
								start: async (_signal, emit) => {
									for (let index = 0; index < eventCount; index++) {
										const id = subscription.ids(index);
										emit({ id, payload: { id } });
									}
								},
							},
							async (event, child) => {
								if (subscription.name === "chaos") {
									appendDurably(join(directory, "handled.txt"), `${label} ${event.id}`);
								}
								const answer = (await child.task({ prompt: "triage" })).text;
								const expected = `answer:${subscription.name}:${event.id}`;
								if (answer !== expected) {
									appendDurably(join(directory, "wrong-tree.txt"), `${label} ${expected} got ${answer}`);
								}
								await sleep(handlerDelayMs);
							},
							{ name: subscription.name, maxConcurrent },
						).done,
				),
			);
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

/** An event child's model: it reads its seeded event and answers `answer:<subscription>:<event id>`. */
function scriptedChildSession(): StageSessionRuntime {
	let answer = "";
	return {
		async prompt(text: string) {
			const subscription = /^Subscription: (.*)$/m.exec(text)?.[1];
			const eventId = /^Event id: (.*)$/m.exec(text)?.[1];
			answer = `answer:${subscription}:${eventId}`;
		},
		async steer() {},
		async followUp() {},
		subscribe() {
			return () => {};
		},
		sessionFile: undefined,
		sessionId: `chaos-child-${label}`,
		async setModel() {},
		setThinkingLevel() {},
		cycleModel: (async () => undefined) as StageSessionRuntime["cycleModel"],
		cycleThinkingLevel: (async () => undefined) as StageSessionRuntime["cycleThinkingLevel"],
		agent: undefined as unknown as AgentSession["agent"],
		model: undefined as AgentSession["model"],
		thinkingLevel: "medium" as AgentSession["thinkingLevel"],
		messages: [] as AgentSession["messages"],
		isStreaming: false,
		navigateTree: (async () => ({ cancelled: false })) as StageSessionRuntime["navigateTree"],
		compact: (async () => ({})) as unknown as StageSessionRuntime["compact"],
		abortCompaction() {},
		async abort() {},
		dispose() {},
		getLastAssistantText() {
			return answer;
		},
	};
}

const adapters = {
	complete: {
		complete: async (text: string) => {
			appendDurably(join(directory, "anchor.txt"), `${label} ${runId}`);
			return text;
		},
	},
	agentSession: { create: async () => scriptedChildSession() },
};
const store = createStore();
if (mode === "records") {
	await backend.hydrateWorkflow(runId);
	const processed = ids.filter((id) => subscriptionEventProcessed(backend, runId, SUBSCRIPTION_KEY, id));
	const eventRecords = backend
		.listCheckpoints(runId)
		.filter((checkpoint) => checkpoint.checkpointId.startsWith("workflow-subscription-event:")).length;
	const others = Object.fromEntries(
		SUBSCRIPTIONS.slice(1).map((subscription) => [
			subscription.name,
			ids.filter((_id, index) =>
				subscriptionEventProcessed(backend, runId, `${subscription.name}#1`, subscription.ids(index)),
			).length,
		]),
	);
	console.log(JSON.stringify({ processed, eventRecords, others }));
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
	const deadline = Date.now() + 900_000;
	while (store.runs().find((entry) => entry.id === runId)?.endedAt === undefined) {
		assert.ok(Date.now() < deadline, "resumed workflow did not settle");
		await sleep(20);
	}
	console.log(JSON.stringify({ status: store.runs().find((entry) => entry.id === runId)?.status }));
	await backend.close();
} else {
	const result = await run(definition, {}, { runId, cwd: directory, store, adapters, modelOwner: "subscription-chaos" });
	console.log(JSON.stringify({ status: result.status, ...(result.error === undefined ? {} : { error: result.error }) }));
	await backend.close().catch((error: Error) => console.error(`close failed: ${error.name}`));
	process.exitCode = result.status === "completed" ? 0 : 3;
}
