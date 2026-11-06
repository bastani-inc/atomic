import v8 from "node:v8";
import vm from "node:vm";
import { describe } from "vitest";
import { residentStageEntries } from "../../packages/workflows/src/runs/foreground/run-residency.js";
import type { StageContext, WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { assert, createStageControlRegistry, test, workflow } from "./executor-shared.js";
import { entriesOf, start, until } from "./run-eviction-helpers.js";

useTemporaryAgentDir();

const RUNS = 3;
const STAGES_PER_RUN = 1_000;
const STAGES = RUNS * STAGES_PER_RUN;
/** Thousands of stages through the real runtime, gathered three times by the garbage collector: structural cost. */
const THOUSANDS_OF_STAGES_TIMEOUT_MS = 180_000;
/** Collections, each followed by a macrotask: a WeakRef target survives the job that created or read it. */
const COLLECTION_ROUNDS = 6;
const ENTRY_KEYS = [
	"reason",
	"replayKey",
	"runId",
	"session",
	"settledCallIds",
	"since",
	"stageId",
	"toolCallIds",
	"wakeKey",
	"watchId",
];
const SESSION_KEYS = ["cwd", "sessionFile", "sessionId"];

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

async function collectGarbage(): Promise<void> {
	const collect = resolveCollect();
	for (let round = 0; round < COLLECTION_ROUNDS; round++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Agents that each finish a prompt and up to two more turns, then wait on the long tool; every stage context counted. */
function agents(contexts: FinalizationRegistry<number>): WorkflowDefinition {
	return workflow({
		name: "evict-thousands",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await Promise.all(
				Array.from({ length: STAGES_PER_RUN }, async (_, index) => {
					const stage: StageContext = ctx.stage(`agent-${index}`);
					contexts.register(stage, index);
					await stage.prompt(`plan ${index}`);
					for (let turn = 0; turn < index % 3; turn++) await stage.sendUserMessage(`turn ${turn}`);
					await stage.sendUserMessage(`watch ci ${index}`);
				}),
			);
			return {};
		},
	});
}

const watching = (text: string): boolean => text.startsWith("watch");

/** An entry's serialized size, with the two numbers whose encoding depends on their value held equal. */
function serializedSize(entry: ReturnType<typeof entriesOf>[number]): number {
	return v8.serialize({ ...entry, since: 0, watchId: 0 }).byteLength;
}

describe("thousands of waiting stages hold only their index entries (#4373)", () => {
	test(
		"the counters see what a waiting stage keeps: without eviction every stage context and its run stay reachable (#4373)",
		async () => {
			let contextsCollected = 0;
			const contexts = new FinalizationRegistry<number>(() => {
				contextsCollected += 1;
			});
			const started = start(agents(contexts), { detachWhen: watching, evictWhenWaiting: false });
			await until(
				() => started.service.dispatches === STAGES_PER_RUN && started.seen.created === started.seen.disposed,
				60_000,
			);
			const signal = new WeakRef(started.seen.runSignal!);
			started.seen.runSignal = undefined;
			await collectGarbage();

			assert.deepEqual(entriesOf(started.runId), []);
			assert.equal(contextsCollected, 0, "the run keeps every waiting stage's context");
			assert.notEqual(signal.deref(), undefined, "the run's execution stays reachable");
			started.service.finishAll();
			assert.equal((await started.result).status, "completed");
			assert.equal(started.starts(), 1);
		},
		THOUSANDS_OF_STAGES_TIMEOUT_MS,
	);

	test(
		"3,000 stages waiting on detached calls leave one constant-shape plain-data entry each, and nothing of their runs' executions (#4373)",
		async () => {
			let contextsCollected = 0;
			const contexts = new FinalizationRegistry<number>(() => {
				contextsCollected += 1;
			});
			const stageControlRegistry = createStageControlRegistry();
			const releaseIdle = stageControlRegistry.releaseIdle.bind(stageControlRegistry);
			let stageReleases = 0;
			stageControlRegistry.releaseIdle = (runId, only) => {
				if (only !== undefined) stageReleases += 1;
				return releaseIdle(runId, only);
			};
			const runs = Array.from({ length: RUNS }, () =>
				start(agents(contexts), { detachWhen: watching, stageControlRegistry }),
			);
			await until(() => runs.every((started) => entriesOf(started.runId).length === STAGES_PER_RUN), 60_000);
			const firstSignals = runs.map((started) => new WeakRef(started.seen.runSignal!));
			for (const started of runs) started.seen.runSignal = undefined;
			const releasesBeforeCollection = stageReleases;
			await collectGarbage();

			const entries = runs.flatMap((started) => entriesOf(started.runId));
			assert.equal(entries.length, STAGES);
			for (const entry of entries) {
				assert.deepEqual(Object.keys(entry).sort(), ENTRY_KEYS);
				assert.ok(Object.keys(entry.session).every((key) => SESSION_KEYS.includes(key)));
				assert.equal(typeof entry.session.sessionId, "string");
				assert.equal(entry.toolCallIds.length, 1);
				assert.deepEqual(entry.settledCallIds, []);
				assert.deepEqual(structuredClone(entry), entry);
				assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
			}
			const sizesByNameLength = new Map<number, Set<number>>();
			for (const entry of entries) {
				const sizes = sizesByNameLength.get(entry.replayKey.length) ?? new Set<number>();
				sizes.add(serializedSize(entry));
				sizesByNameLength.set(entry.replayKey.length, sizes);
			}
			assert.ok(sizesByNameLength.size >= 3, "stage names of several lengths were measured");
			assert.deepEqual(
				[...sizesByNameLength.values()].map((sizes) => sizes.size),
				[...sizesByNameLength.values()].map(() => 1),
				"stages that differ only in how many turns they ran hold entries of one size",
			);
			assert.equal(
				residentStageEntries().filter((entry) => runs.some((started) => started.runId === entry.runId)).length,
				STAGES,
			);
			assert.equal(
				runs.reduce((live, started) => live + started.seen.created - started.seen.disposed, 0),
				0,
				"no stage keeps a session",
			);
			assert.equal(contextsCollected, STAGES, "every stage context of the evicted executions was collected");
			assert.equal(
				stageReleases,
				releasesBeforeCollection,
				"a collected stage context of an evicted execution releases nothing the rebuilt run will own",
			);
			assert.deepEqual(
				firstSignals.map((signal) => signal.deref()),
				runs.map(() => undefined),
				"nothing keeps an evicted execution's controllers, dispatcher or runtime reachable",
			);

			for (const started of runs) started.service.finishAll();
			const results = await Promise.all(runs.map((started) => started.result));
			for (const [index, result] of results.entries()) {
				const started = runs[index]!;
				assert.equal(result.status, "completed", result.error);
				assert.equal(started.starts(), 2, "one rebuild per run");
				assert.equal(started.service.dispatches, STAGES_PER_RUN, "no call ran again");
				assert.equal(
					[...started.seen.continued.values()].reduce((total, count) => total + count, 0),
					STAGES_PER_RUN,
				);
				assert.equal(
					[...started.seen.userPrompts.values()].reduce((total, count) => total + count, 0),
					Array.from({ length: STAGES_PER_RUN }, (_, index) => 2 + (index % 3)).reduce(
						(total, calls) => total + calls,
					),
					"no call of any stage was sent again",
				);
			}
		},
		THOUSANDS_OF_STAGES_TIMEOUT_MS,
	);
});
