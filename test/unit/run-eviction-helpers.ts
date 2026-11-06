import { residentStageEntries } from "../../packages/workflows/src/runs/foreground/run-residency.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { assert, createStore, run, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

export async function until(predicate: () => boolean, rounds = 4_000): Promise<void> {
	for (let round = 0; round < rounds && !predicate(); round++) await new Promise((resolve) => setTimeout(resolve, 1));
	assert.ok(predicate(), "condition never held");
}

/** Enough rounds of timers for a run that could be evicted with `afterMs: 0` to have been evicted. */
export async function quietRounds(): Promise<void> {
	for (let round = 0; round < 20; round++) await new Promise((resolve) => setTimeout(resolve, 1));
}

export function entriesOf(runId: string) {
	return residentStageEntries().filter((entry) => entry.runId === runId);
}

export function stagesWaiting(names: readonly string[]): WorkflowDefinition {
	return workflow({
		name: "evict-waiting",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await Promise.all(names.map((name) => ctx.stage(name).prompt(`ship ${name}`)));
			return {};
		},
	});
}

/** Where a held stage waits for its gate: before each prompt, before its sessions are created, or before each disposal. */
export type HeldPhase = "prompt" | "create" | "dispose";

/** `adapters` whose stage `stageName` holds `phase` until `gate` settles. */
function holdingStage(
	adapters: StageAdapters,
	stageName: string,
	gate: Promise<void>,
	phase: HeldPhase,
): StageAdapters {
	return {
		...adapters,
		agentSession: {
			async create(options, meta) {
				if (meta?.stageName === stageName && phase === "create") await gate;
				const created = await adapters.agentSession!.create(options, meta);
				if (meta?.stageName !== stageName || "session" in created) return created;
				if (phase === "dispose") {
					const dispose = created.dispose.bind(created);
					return Object.assign(created, {
						dispose: async () => {
							await gate;
							return dispose();
						},
					});
				}
				const prompt = created.prompt.bind(created);
				return Object.assign(created, {
					prompt: async (text: string) => {
						if (phase === "prompt") await gate;
						return prompt(text);
					},
				});
			},
		},
	};
}

/** `adapters` whose sessions report `sessionFile` as the file their conversation is stored in. */
function reportingSessionFile(adapters: StageAdapters, sessionFile: string): StageAdapters {
	return {
		...adapters,
		agentSession: {
			async create(options, meta) {
				const created = await adapters.agentSession!.create(options, meta);
				return "session" in created ? created : Object.assign(created, { sessionFile });
			},
		},
	};
}

export interface Started {
	readonly runId: string;
	readonly service: FakeCiService;
	readonly seen: ReturnType<typeof counters>;
	readonly store: ReturnType<typeof createStore>;
	/** How many times the run executed: once, and again by replay each time an evicted run was rebuilt. */
	readonly starts: () => number;
	/** How many times the host was told the run started. */
	readonly hostStarts: () => number;
	readonly result: ReturnType<typeof run>;
}

export function start(
	definition: WorkflowDefinition,
	options: Partial<NonNullable<Parameters<typeof run>[2]>> & {
		readonly detachWhen?: (text: string) => boolean;
		readonly callsPerTurn?: number;
		readonly sessionFile?: string;
		readonly holdStage?: { readonly name: string; readonly gate: Promise<void>; readonly phase?: HeldPhase };
	} = {},
): Started {
	const runId = options.runId ?? crypto.randomUUID();
	const service = new FakeCiService();
	const seen = counters();
	const store = createStore();
	let executions = 0;
	let hostStarts = 0;
	const recordRunStart = store.recordRunStart.bind(store);
	Object.assign(store, {
		recordRunStart: (snapshot: Parameters<typeof recordRunStart>[0]) => {
			if (snapshot.id === runId) executions += 1;
			recordRunStart(snapshot);
		},
	});
	const { detachWhen, callsPerTurn, sessionFile, holdStage, ...rest } = options;
	const detaching = detachingAdapters(service, seen, {
		resumable: true,
		...(detachWhen === undefined ? {} : { detachWhen }),
		...(callsPerTurn === undefined ? {} : { callsPerTurn }),
	});
	const adapters = sessionFile === undefined ? detaching : reportingSessionFile(detaching, sessionFile);
	const result = run(
		definition,
		{},
		{
			runId,
			store,
			adapters:
				holdStage === undefined
					? adapters
					: holdingStage(adapters, holdStage.name, holdStage.gate, holdStage.phase ?? "prompt"),
			releaseWhenWaiting: { afterMs: 0 },
			evictWhenWaiting: { afterMs: 0 },
			onRunStart: () => {
				hostStarts += 1;
			},
			...rest,
		},
	);
	return { runId, service, seen, store, starts: () => executions, hostStarts: () => hostStarts, result };
}
