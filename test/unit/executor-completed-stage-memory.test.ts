import v8 from "node:v8";
import vm from "node:vm";
import type { AgentSession } from "@bastani/atomic";
import { describe } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import {
	assert,
	createStageControlRegistry,
	createStore,
	mockSession,
	run,
	test,
	workflow,
} from "./executor-shared.js";

const STAGES = 24;
const PAYLOAD_ELEMENTS = 131_072;
/** One payload is a 1 MiB numeric array: 131,072 elements of 8 bytes. */
const PAYLOAD_BYTES = PAYLOAD_ELEMENTS * 8;
const TOTAL_PAYLOAD_BYTES = STAGES * PAYLOAD_BYTES;

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		const exposed = vm.runInNewContext("gc") as () => void;
		assert.equal(typeof exposed, "function", "expected --expose-gc to expose gc()");
		return exposed;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const collect = resolveCollect();

function heapUsedAfterCollection(): number {
	collect();
	collect();
	return process.memoryUsage().heapUsed;
}

/** Heap in use once collections, the finalizers they schedule and the releases those start have all settled. */
async function settledHeapUsed(): Promise<number> {
	for (let round = 0; round < 4; round++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return heapUsedAfterCollection();
}

/** Fills with distinct values so no engine can share the backing store between two payloads. */
function archiveProxy(seed: number): number[] {
	return Array.from({ length: PAYLOAD_ELEMENTS }, (_, index) => seed + index);
}

interface Measurement {
	readonly retainedBytes: number;
	readonly disposals: number;
	/** Sessions disposed by the time of a measurement taken inside the run. */
	readonly disposalsWhileRunning?: number;
	readonly retainedHandles: number;
}

/**
 * Where the measurement is taken: after the run returns, or inside the run once every stage has completed, while
 * the run goes on, with the stages run through `ctx.stage(...).prompt` or `ctx.task`.
 */
type MeasurementPoint = "after-run" | "stages-while-running" | "tasks-while-running";

/**
 * Each session closure owns one archive proxy, standing in for the SDK session
 * archive a live session keeps. Nothing but the session itself references it.
 */
async function measureCompletedStages(persisted: boolean, when: MeasurementPoint = "after-run"): Promise<Measurement> {
	const registry = createStageControlRegistry();
	const store = createStore();
	let disposals = 0;
	let created = 0;
	const adapters: StageAdapters = {
		...(persisted ? { sessionStore: new MemorySessionStore() } : {}),
		agentSession: {
			async create(options) {
				const archive = archiveProxy(created++);
				const manager = options.sessionManager;
				return {
					...mockSession(manager),
					archive,
					messages: [] as AgentSession["messages"],
					async prompt(text: string) {
						await manager?.appendMessage({ role: "user", content: text, timestamp: Date.now() });
					},
					async dispose() {
						disposals += 1;
					},
				};
			},
		},
	};
	let whileRunning: { readonly retainedBytes: number; readonly disposals: number } | undefined;
	const baseline = heapUsedAfterCollection();
	const def = workflow({
		name: "completed-stage-memory",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			for (let i = 0; i < STAGES; i++) {
				if (when === "tasks-while-running") await ctx.task(`stage-${i}`, { prompt: "synthetic" });
				else await ctx.stage(`stage-${i}`).prompt("synthetic");
			}
			if (when !== "after-run") whileRunning = { retainedBytes: (await settledHeapUsed()) - baseline, disposals };
			return {};
		},
	});
	await run(def, {}, { store, stageControlRegistry: registry, adapters });
	const retainedBytes = whileRunning?.retainedBytes ?? heapUsedAfterCollection() - baseline;
	const runId = store.runs()[0]!.id;
	const measurement = {
		retainedBytes,
		disposals,
		...(whileRunning === undefined ? {} : { disposalsWhileRunning: whileRunning.disposals }),
		retainedHandles: registry.forRun(runId).length,
	};
	await registry.clear();
	return measurement;
}

describe("completed stage memory", () => {
	test("completed stages whose sessions are saved give their memory back after the run (#3622)", async () => {
		const measurement = await measureCompletedStages(true);

		assert.equal(measurement.disposals, STAGES);
		assert.equal(measurement.retainedHandles, 0);
		assert.ok(
			measurement.retainedBytes < TOTAL_PAYLOAD_BYTES / 4,
			`${(measurement.retainedBytes / 2 ** 20).toFixed(1)} MiB stayed reachable after ${STAGES} saved stages; their archives total ${(TOTAL_PAYLOAD_BYTES / 2 ** 20).toFixed(0)} MiB`,
		);
	});

	for (const [primitive, point] of [
		["ctx.stage", "stages-while-running"],
		["ctx.task", "tasks-while-running"],
	] as const) {
		test(`completed ${primitive} stages whose sessions are saved give their memory back while their run goes on`, async () => {
			const measurement = await measureCompletedStages(true, point);

			assert.equal(measurement.disposalsWhileRunning, STAGES);
			assert.ok(
				measurement.retainedBytes < TOTAL_PAYLOAD_BYTES / 4,
				`${(measurement.retainedBytes / 2 ** 20).toFixed(1)} MiB stayed reachable while the run went on after ${STAGES} saved stages; their archives total ${(TOTAL_PAYLOAD_BYTES / 2 ** 20).toFixed(0)} MiB`,
			);
		});
	}

	test("the probe sees the memory a retained session holds (#3622)", async () => {
		const measurement = await measureCompletedStages(false);

		assert.equal(measurement.disposals, 0);
		assert.equal(measurement.retainedHandles, STAGES);
		assert.ok(
			measurement.retainedBytes > (TOTAL_PAYLOAD_BYTES * 3) / 4,
			`${(measurement.retainedBytes / 2 ** 20).toFixed(1)} MiB of ${(TOTAL_PAYLOAD_BYTES / 2 ** 20).toFixed(0)} MiB reached after ${STAGES} unsaved stages`,
		);
	});
});
